import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { Confinement } from "../harness/types.js";
import { denyLocalPorts, needsLocalPortDeny } from "./local-ports.js";
import { allowChromiumMachRegister, needsMachRegister } from "./mach-register.js";

/**
 * チームの CI の、画面(ブラウザ)の E2E のためのブラウザサーバー(#93)。
 *
 * Chrome は、チームの CI の閉じ込め(confine.ts)の中では起動できない(プロファイル・ソケット・Crashpad の置き場所が書けない)。
 * かといって閉じ込めの外で素のまま立てると、中の PR のコードが、そのブラウザを通して隠しているファイルを読んだり、許可リストの外へ送ったりできてしまう。
 * そこで、ブラウザサーバーは「ブラウザ専用の狭い閉じ込め」の中で立てて、npm test の閉じ込め(confine.ts)は広げずに、その宛先(wsEndpoint)だけを渡す。
 *   書ける: Chrome のプロファイル用の一時ディレクトリだけ
 *   読める: ホームの下は、node のツールチェーン・リポジトリの node_modules・Playwright のブラウザの置き場所だけ(~/.kuramoto・~/.ssh などは読めない)
 *   つながる: localhost だけ(プロキシの環境変数も外して、外への経路を作らない)
 * 狭い閉じ込めの中でブラウザが立たなかったときは、閉じ込めの無いブラウザには切り替えない。宛先を渡さずに進め、E2E は「確かめていない」で通る(手元の閉じ込めの中と同じ扱い)。
 */

/** 閉じ込めの中の E2E に渡す、ブラウザサーバーの wsEndpoint の環境変数。渡されたら、E2E はブラウザに繋がらないことも失敗にする。 */
export const E2E_WS_ENDPOINT_ENV = "KURAMOTO_E2E_WS_ENDPOINT";

/**
 * ブラウザサーバーを立てる経路を動かす明示の設定(1 のときだけ)。既定は動かさない。
 * 狭い閉じ込めの中で Chrome が実際に起動するかは、Kuramoto のサーバーで scripts/check-confined-browser.ts を流して確かめてから、チームの CI で有効にする(別チケット)。
 * 無いときは、宛先を渡さず、E2E は「起動できなければ知らせて通す」(手元の閉じ込めの中と同じ)。
 */
export const CONFINED_BROWSER_ENV = "KURAMOTO_E2E_CONFINED_BROWSER";

export const confinedBrowserEnabled = (env: NodeJS.ProcessEnv = process.env) => env[CONFINED_BROWSER_ENV] === "1";

export interface BrowserServer {
  endpoint: string;
  close(): Promise<void>;
}
/** ブラウザ専用の狭い閉じ込めの中で、ブラウザサーバーを立てる。立てられなければ投げる。 */
export type StartBrowser = (cwd: string, conf: Confinement) => Promise<BrowserServer>;

/** パスが base の中(または同じ)か。 */
function inside(path: string, base: string): boolean {
  const r = relative(base, path);
  return r === "" || (!r.startsWith("..") && !isAbsolute(r));
}

const real = (p: string) => (existsSync(p) ? realpathSync(p) : p);

/** このコマンドが、ブラウザの E2E を流すか(playwright の設定があるリポジトリの、テストのコマンド)。 */
export function wantsBrowser(command: string, cwd: string): boolean {
  if (!/\b(test|e2e|test:e2e|playwright)\b/.test(command)) return false;
  return ["ts", "js", "mjs", "cjs"].some((x) => existsSync(join(cwd, `playwright.config.${x}`)));
}

/** ブラウザ専用の、狭い閉じ込めの設定(sandbox-runtime の filesystem と network)。 */
export function browserSandboxConfig(cwd: string, conf: Confinement, profileDir: string, nodePath: string = process.execPath, home: string = homedir()) {
  // node の置き場所(ホームの下のツールチェーンのときだけ要る)と、Playwright のブラウザの置き場所
  const nodeRoot = dirname(dirname(real(nodePath)));
  const allowRead = [
    ...(inside(nodeRoot, home) ? [nodeRoot] : []),
    join(cwd, "node_modules"),
    join(cwd, "package.json"),
    join(home, "Library/Caches/ms-playwright"),
    join(home, ".cache/ms-playwright"),
  ];
  return {
    network: { allowedDomains: [] as string[], deniedDomains: [] as string[], strictAllowlist: true },
    filesystem: {
      denyRead: [home, ...conf.hidden],
      allowRead,
      allowWrite: [profileDir],
      denyWrite: [] as string[],
    },
  };
}

const shq = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

/**
 * 狭い閉じ込めの中で流す、ブラウザサーバーの起動のスクリプト(リポジトリの @playwright/test を使う。版が必ずそろう)。stdin が閉じたら終わる。
 * `node -e` の require は、カレントディレクトリから探す。閉じ込めの中では、ホームの下のカレントディレクトリを getcwd できないことがあり、
 * そのとき node は node 本体のディレクトリから探して「Cannot find module '@playwright/test'」になる(macOS ランナーで起きた)。
 * カレントディレクトリに頼らず、リポジトリの node_modules の絶対パスで読む。
 */
export const serverScript = (cwd: string) => `
const { chromium } = require(${JSON.stringify(join(resolve(cwd), "node_modules/@playwright/test"))});
(async () => {
  // GPU プロセスは起動しない(ソフトウェア描画)。閉じ込めの中では GPU(IOKit・Metal)に届かず、GPU プロセスが落ち続けて描画のフレームが出なくなり、
  // 要素が「安定」するのを待つ click(requestAnimationFrame を待つ)が時間切れになる(#118)。許可は足さず、ブラウザの起動オプションで避ける
  const opts = { headless: true, timeout: 60000, args: ["--disable-gpu"] };
  // 確かめの CI(KURAMOTO_E2E_BROWSER_DEBUG=1)では、ブラウザの標準エラー(Chrome の落ちた理由)を、DEBUG の環境変数に頼らず、標準エラーに出す
  if (process.env.KURAMOTO_E2E_BROWSER_DEBUG === "1") {
    opts.logger = { isEnabled: (name) => name === "browser", log: (name, severity, message) => { if (name === "browser") process.stderr.write("[pw:browser] " + String(message).slice(0, 300) + "\\n"); } };
  }
  const server = await chromium.launchServer({ channel: "chrome", ...opts }).catch((e) => { process.stderr.write("[pw:browser] channel chrome の起動に失敗: " + String((e && e.message) || e).split("\\n")[0].slice(0, 300) + "\\n"); return chromium.launchServer(opts); });
  server.on("close", () => process.stderr.write("[pw:browser] ブラウザサーバーが閉じた(ブラウザが終わった)\\n"));
  process.stdout.write("KURAMOTO_WS " + server.wsEndpoint() + "\\n");
  // 確かめの CI では、描画のフレームが出るか(click の時間切れの原因の候補)を、ページを 1 枚開いて見て、結果を標準エラーに出す。ブラウザサーバーの動きには影響しない
  if (process.env.KURAMOTO_E2E_BROWSER_DEBUG === "1") {
    const note = (m) => process.stderr.write("[pw:probe] " + m + "\\n");
    (async () => {
      const browser = await chromium.connect(server.wsEndpoint(), { timeout: 15000 });
      try {
        note("ブラウザ: " + browser.version());
        const page = await browser.newPage();
        const raf = await Promise.race([page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r("ok")))), new Promise((r) => setTimeout(() => r("5 秒たっても返らない"), 5000))]);
        note("requestAnimationFrame: " + raf);
        const gpu = await page.evaluate(() => { const c = document.createElement("canvas"); return c.getContext("webgl") ? "webgl あり" : "webgl なし"; }).catch((e) => String(e.message).split("\\n")[0]);
        note("canvas: " + gpu);
      } finally { await browser.close().catch(() => {}); }
    })().catch((e) => note("プローブが失敗: " + String((e && e.message) || e).split("\\n")[0].slice(0, 300)));
  }
  const stop = () => server.close().catch(() => {}).then(() => process.exit(0));
  process.stdin.on("end", stop);
  process.stdin.on("close", stop);
  process.on("SIGTERM", stop);
  process.stdin.resume();
})().catch((e) => { console.error(String((e && e.message) || e)); process.exit(1); });
`;

const START_TIMEOUT_MS = 90_000;

/**
 * ブラウザ専用の狭い閉じ込めの中で、Playwright のブラウザサーバー(Google Chrome。無ければ同梱の Chromium)を立てる。
 * SandboxManager は、呼ぶ前に初期化してあること(SandboxRunner が npm test の設定を入れたあとに呼ぶ)。
 */
export const startConfinedBrowser: StartBrowser = async (cwd, conf) => {
  const { SandboxManager } = await import("@anthropic-ai/sandbox-runtime");
  // ソケットのパスの長さの上限(104 文字)に収まるよう、短い場所に作る
  const profileDir = real(mkdtempSync("/tmp/kuramoto-pw-"));
  const cleanup = () => rmSync(profileDir, { recursive: true, force: true });
  try {
    const inner = [
      "unset HTTP_PROXY HTTPS_PROXY ALL_PROXY NO_PROXY http_proxy https_proxy all_proxy no_proxy",
      `export TMPDIR=${shq(profileDir)}`,
      `exec ${shq(process.execPath)} -e ${shq(serverScript(cwd))}`,
    ].join("; ");
    // ブラウザサーバーの閉じ込めも、全体の設定の localhost の許可を引き継ぐので、npm test と同じポートを断る(ADR-0059)
    const raw = await SandboxManager.wrapWithSandbox(inner, undefined, browserSandboxConfig(cwd, conf, profileDir));
    const denied = needsLocalPortDeny(conf.allowLocalSockets, conf.deniedLocalPorts) ? denyLocalPorts(raw, conf.deniedLocalPorts ?? []) : raw;
    // macOS の Chromium は、起動時に mach-register が要る。ブラウザ専用の閉じ込めにだけ、その 1 行を足す(mach-register.ts)
    const wrapped = needsMachRegister() ? allowChromiumMachRegister(denied) : denied;
    // 確かめの CI(KURAMOTO_E2E_BROWSER_DEBUG=1)では、ブラウザの落ちた理由(Chrome の FATAL など)を読めるよう、ブラウザサーバーの標準エラーを残す
    const debug = process.env.KURAMOTO_E2E_BROWSER_DEBUG === "1";
    const env: NodeJS.ProcessEnv = { ...process.env, ...conf.env, CI: "1", ...(debug ? { DEBUG: "pw:browser" } : {}) };
    for (const k of conf.hiddenEnv) delete env[k];
    // カレントディレクトリは、閉じ込めの中で読める・書ける profileDir にする。リポジトリ(ホームの下)のままだと、ホームを読めない閉じ込めの中で
    // process.cwd() が「EPERM: uv_cwd」で落ちる(macOS ランナーで起きた)。スクリプトはリポジトリを絶対パスで読むので、cwd は要らない
    const child = spawn("/bin/bash", ["-c", wrapped], { cwd: profileDir, env, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    const endpoint = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => fail(new Error(`${START_TIMEOUT_MS / 1000} 秒たってもブラウザサーバーが立ちませんでした`)), START_TIMEOUT_MS);
      const done = (f: () => void) => {
        clearTimeout(timer);
        f();
      };
      const fail = (e: Error) => done(() => reject(e));
      child.stdout.on("data", (b: Buffer) => {
        out += b.toString();
        const m = /KURAMOTO_WS (ws:\/\/\S+)/.exec(out);
        if (m?.[1]) done(() => resolve(m[1] as string));
      });
      child.stderr.on("data", (b: Buffer) => {
        out += b.toString();
        if (debug) for (const l of b.toString().split("\n")) if (l.trim()) process.stderr.write(`[browser-server] ${l.slice(0, 300)}\n`);
      });
      child.on("error", fail);
      child.on("close", (code) => fail(new Error(`ブラウザサーバーが終わりました(終了コード ${code ?? "なし"})`)));
    }).catch((e: unknown) => {
      child.kill("SIGKILL");
      const detail = SandboxManager.annotateStderrWithSandboxFailures(wrapped, out).trim().split("\n").slice(-20).join("\n");
      throw new Error(`${e instanceof Error ? e.message : String(e)}\n${detail}`);
    });
    return {
      endpoint,
      close: async () => {
        await new Promise<void>((resolve) => {
          if (child.exitCode !== null || child.signalCode !== null) return resolve();
          const kill = setTimeout(() => child.kill("SIGKILL"), 5_000);
          child.once("close", () => {
            clearTimeout(kill);
            resolve();
          });
          child.stdin.end(); // stdin を閉じると、ブラウザサーバーが自分で閉じて終わる
        });
        cleanup();
      },
    };
  } catch (e) {
    cleanup();
    throw e;
  }
};

/**
 * コマンドの前にブラウザサーバーを立て、渡す環境変数と、あとで必ず呼ぶ close を返す。立てる必要が無ければ何もしない。
 * KURAMOTO_E2E_CONFINED_BROWSER=1 でないときは何もしない。立てられなかったときは、閉じ込めの無いブラウザには切り替えず、宛先を渡さずに進める(notice に理由を入れる)。E2E は「確かめていない」で通る。
 * 閉じ込めの中から 127.0.0.1 に届かない設定(sandbox_strict_sockets)では、E2E そのものが動かないので立てない。
 */
export async function withBrowser(
  command: string,
  cwd: string,
  conf: Confinement,
  start: StartBrowser,
  force = false,
  enabled: boolean = confinedBrowserEnabled(),
): Promise<{ env: Record<string, string>; notice?: string; close: () => Promise<void> }> {
  const none = { env: {}, close: async () => {} };
  // 既定では動かさない(KURAMOTO_E2E_CONFINED_BROWSER=1 のときだけ)。立てないので、閉じ込めの無いブラウザも立たない
  if (!enabled || !conf.allowLocalSockets || !(force || wantsBrowser(command, cwd))) return none;
  try {
    const server = await start(cwd, conf);
    return { env: { [E2E_WS_ENDPOINT_ENV]: server.endpoint }, close: () => server.close().catch(() => undefined) };
  } catch (e) {
    return {
      ...none,
      notice: `⚠ チームの CI: ブラウザ専用の狭い閉じ込めの中でブラウザを起動できなかったので、ブラウザサーバーを渡さずに「${command}」を流しました。画面の E2E は流れていません(閉じ込めの無いブラウザには切り替えません):\n${e instanceof Error ? e.message : String(e)}`,
    };
  }
}
