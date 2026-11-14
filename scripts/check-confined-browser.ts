import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, networkInterfaces } from "node:os";
import { join, resolve } from "node:path";
import { Project } from "../src/project/project.js";
import { confinementFor } from "../src/project/confine.js";
import { SandboxRunner } from "../src/project/team-ci.js";
import { kuramotoHome } from "../src/hq.js";
import { describeE2eCount, judgeE2eCount, parseListTotal } from "./e2e-count.js";

/**
 * チームの CI のブラウザサーバー(ブラウザ専用の狭い閉じ込め)の確かめ(#93)。Kuramoto のサーバー(Chrome が動く場所)で流す。
 *
 *   npx tsx scripts/check-confined-browser.ts [リポジトリのパス]            # (i) と (iii)
 *   npx tsx scripts/check-confined-browser.ts [リポジトリのパス] --break    # (ii) わざと入口を壊して、落ちることを確かめる
 *   npx tsx scripts/check-confined-browser.ts [リポジトリのパス] --no-browser-server  # 設定なし(KURAMOTO_E2E_CONFINED_BROWSER を付けない既定)の回。同じ SandboxRunner で npm test を流して、出力を残す
 *
 * (i)   チームの CI と同じ閉じ込めの中で npm test を流し、狭い閉じ込めの中のブラウザに繋いで E2E が通る
 * (ii)  --break: PhoneBar の「チームの方針」の入口を壊して同じ実行をし、落ちる(終わったら元に戻す)
 * (iii) 接続した側から、次がどれも失敗する(外のブラウザサーバーの閉じ込めが効いている)
 *       - file:// で ~/.kuramoto の中のファイル(access-token など)と ~/.ssh の中のファイルを開く
 *       - 読める場所(リポジトリの node_modules)の中に置いた、~/.kuramoto・~/.ssh へのシンボリックリンク(ファイル・ディレクトリ)経由で、同じファイルを開く(許した場所がリンクで広がらない)
 *       - newContext({ proxy }) を使った外への通信 / newRequest(ローカルの playwright と、ブラウザ側の context.request)で外の URL を取る
 *       対照として、リポジトリの package.json と localhost の確かめ用サーバーには繋がる(ブラウザそのものが壊れて「失敗」しているのではないことを見るため)
 * 終了コード: 0 = 通った / 1 = 落ちた(閉じ込めの穴・E2E の失敗) / 2 = 確かめられなかった(ブラウザが起動できなかったなど)
 */

const repo = resolve(process.argv.slice(2).find((a) => !a.startsWith("--")) ?? ".");
const BREAK = process.argv.includes("--break");
const NO_BROWSER_SERVER = process.argv.includes("--no-browser-server");

// 既定は、ブラウザサーバーを狭い閉じ込めの中で立てる経路を明示して動かす(チームの CI の既定は動かない設定)。--no-browser-server のときは付けず、設定なしの回にする
if (NO_BROWSER_SERVER) delete process.env.KURAMOTO_E2E_CONFINED_BROWSER;
else process.env.KURAMOTO_E2E_CONFINED_BROWSER = "1";

type Probe = { name: string; ok: boolean; detail: string };

/** 中(npm test と同じ閉じ込め)で流す、接続した側の確かめ。ブラウザには KURAMOTO_E2E_WS_ENDPOINT で繋ぐ。 */
const PROBE = `
const { chromium, request } = require("@playwright/test");
const t = JSON.parse(process.env.PROBE_TARGETS);
const out = (name, ok, detail) => console.log("PROBE " + JSON.stringify({ name, ok, detail: String(detail).slice(0, 200) }));
const net = require("net");
const info = (s) => console.log("INFO " + String(s).replace(/\\s+/g, " ").slice(0, 190));
const body = async (page, url) => {
  const r = await page.goto(url, { timeout: 15000 }).catch((e) => ({ error: String(e.message).split("\\n")[0] }));
  if (r && r.error) return { error: r.error, text: "" };
  return { error: null, text: await page.evaluate(() => document.body ? document.body.innerText : "").catch(() => "") };
};
const tcp = (host, port) => new Promise((res) => { const s = net.connect({ host, port, timeout: 5000 }); s.on("connect", () => { s.destroy(); res("繋がった"); }); s.on("timeout", () => { s.destroy(); res("時間切れ"); }); s.on("error", (e) => res("失敗 " + (e.code || e.message))); });
(async () => {
  if (!process.env.KURAMOTO_E2E_WS_ENDPOINT) return; // ブラウザサーバーが渡されなかった(起動できなかった)。確かめない
  const browser = await chromium.connect(process.env.KURAMOTO_E2E_WS_ENDPOINT, { timeout: 60000 });
  // 確かめごとに新しいページで開く(前の確かめで出たエラーのページに引きずられない)
  const fresh = async (url) => { const p = await browser.newPage(); try { return await body(p, url); } finally { await p.close().catch(() => {}); } };
  // 対照: 繋がる
  let r = await fresh("file://" + t.cwd + "/package.json");
  out("対照: リポジトリの package.json を開ける", r.text.includes('"name"'), r.error || "開けた");
  r = await fresh("http://127.0.0.1:" + t.port + "/");
  out("対照: localhost の確かめ用サーバーに繋がる", r.text.includes("CANARY-NET"), r.error || "繋がった");
  // (iii) ファイル
  for (const f of t.files) {
    r = await fresh("file://" + f.path);
    out("file:// で " + f.label + " を開けない", !r.text.includes(f.marker), r.error || (r.text.includes(f.marker) ? "中身が読めた" : "開いたが中身は無い"));
  }
  // (iii) シンボリックリンク(読める node_modules の中に置いたリンク)経由
  r = await fresh("file://" + t.linkControl.path);
  out("対照: node_modules の中のリンクが、許した場所(package.json)を指すなら開ける", r.text.includes('"name"'), r.error || "開けた");
  for (const f of t.links) {
    r = await fresh("file://" + f.path);
    out("node_modules 内のシンボリックリンク経由で " + f.label + " を開けない", !r.text.includes(f.marker), r.error || (r.text.includes(f.marker) ? "中身が読めた(リンクで読める場所が広がっている)" : "開いたが中身は無い"));
  }
  // (iii) 外への通信
  if (!t.lanIp) out("外への通信を確かめる LAN の IP", false, "非 loopback の IPv4 が無いので確かめられない");
  else {
    const url = "http://" + t.lanIp + ":" + t.port + "/";
    r = await fresh(url);
    out("LAN の IP(localhost の外)へ goto できない", !r.text.includes("CANARY-NET"), r.error || "繋がった");
    const ctx = await browser.newContext({ proxy: { server: url } });
    const p2 = await ctx.newPage();
    r = await body(p2, "http://example.invalid/");
    out("newContext({proxy}) で外のプロキシ経由の通信ができない", !r.text.includes("CANARY-NET"), r.error || "繋がった");
    await ctx.close();
    const viaCtx = await browser.newContext();
    const a = await viaCtx.request.get(url, { timeout: 15000 }).then((x) => x.text(), (e) => "ERR " + String(e.message).split("\\n")[0]);
    out("context.request(ブラウザ側)で外の URL を取れない", !a.includes("CANARY-NET"), a);
    await viaCtx.close();
    const local = await request.newContext();
    const b = await local.get(url, { timeout: 15000 }).then((x) => x.text(), (e) => "ERR " + String(e.message).split("\\n")[0]);
    out("request.newContext(ローカルの playwright)で外の URL を取れない", !b.includes("CANARY-NET"), b);
    await local.dispose();
  }
  // 参考(判定には入れない): 失敗の原因を読むための記録
  const attempt = async (label, fn) => { try { info(label + ": " + (await fn())); } catch (e) { info(label + ": 例外 " + String(e.message).split("\\n")[0]); } };
  const open = async (url, needle) => { const r = await fresh(url); return r.error ? "失敗 " + r.error.slice(0, 110) : r.text.includes(needle) ? "開けた" : "開いたが中身が違う"; };
  await attempt("プロキシの環境変数", async () => "http_proxy=" + (process.env.HTTP_PROXY || process.env.http_proxy || "なし") + " no_proxy=" + String(process.env.NO_PROXY || process.env.no_proxy || "なし").slice(0, 70));
  if (t.linkDiag) {
    await attempt("リンクの診断 実ファイル", () => open("file://" + t.linkDiag.real, '"name"'));
    await attempt("リンクの診断 同じ dir の中へのリンク", () => open("file://" + t.linkDiag.inner, '"name"'));
    await attempt("リンクの診断 相対リンク→package.json", () => open("file://" + t.linkDiag.rel, '"name"'));
    await attempt("リンクの診断 絶対リンク→package.json", () => open("file://" + t.linkControl.path, '"name"'));
  }
  await attempt("tcp(playwright 側の node から)", async () => "127.0.0.1=" + (await tcp("127.0.0.1", t.port)) + " LAN=" + (t.lanIp ? await tcp(t.lanIp, t.port) : "IP なし") + " 1.1.1.1:80=" + (await tcp("1.1.1.1", 80)));
  if (t.lanIp) await attempt("新しいページで LAN の IP へ goto", () => open("http://" + t.lanIp + ":" + t.port + "/", "CANARY-NET"));
  await attempt("新しいページで example.com へ goto", () => open("http://example.com/", "Example Domain"));
  await attempt("context.request で example.com", async () => { const c = await browser.newContext(); const x = await c.request.get("http://example.com/", { timeout: 15000 }).then((y) => y.status() + " " + String(y.url()), (e) => "失敗 " + String(e.message).split("\\n")[0].slice(0, 100)); await c.close(); return x; });
  await attempt("request.newContext(ローカル)で example.com", async () => { const c = await request.newContext(); const x = await c.get("http://example.com/", { timeout: 15000 }).then((y) => y.status() + " " + String(y.url()), (e) => "失敗 " + String(e.message).split("\\n")[0].slice(0, 100)); await c.dispose(); return x; });
  await browser.close();
})().catch((e) => { out("接続した側の確かめが最後まで動いた", false, e.message); process.exit(0); });
`;

function lanIp(): string | undefined {
  for (const list of Object.values(networkInterfaces()))
    for (const a of list ?? []) if (a.family === "IPv4" && !a.internal) return a.address;
  return undefined;
}

/** 読めてはいけないファイル(~/.kuramoto の access-token・~/.ssh の中の鍵)と、その中身の目印。 */
function secretFiles(canary: string): { label: string; path: string; marker: string }[] {
  const list: { label: string; path: string; marker: string }[] = [{ label: "~/.kuramoto の確かめ用ファイル", path: canary, marker: readFileSync(canary, "utf8").trim() }];
  const token = join(kuramotoHome(), "access-token");
  if (existsSync(token)) list.push({ label: "~/.kuramoto/access-token", path: token, marker: readFileSync(token, "utf8").trim().slice(0, 24) });
  const ssh = join(homedir(), ".ssh");
  if (existsSync(ssh)) {
    for (const n of readdirSync(ssh)) {
      const p = join(ssh, n);
      if (statSync(p).isFile() && statSync(p).size >= 24) list.push({ label: `~/.ssh/${n}`, path: p, marker: readFileSync(p, "utf8").trim().slice(0, 24) });
      if (list.length >= 4) break;
    }
  }
  return list.filter((f) => f.marker.length >= 8);
}

/**
 * 読める場所(リポジトリの node_modules)の中に、読めてはいけないファイル・ディレクトリへのシンボリックリンクを置く。
 * 置いたリンクのパスと、消すためのパスを返す。ディレクトリへのリンクは、その中の確かめ用ファイル(canary)を開く。
 */
function plantLinks(repo: string, canary: string, files: { label: string; path: string; marker: string }[]) {
  const dir = join(repo, "node_modules", ".kuramoto-probe-links");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const links: { label: string; path: string; marker: string }[] = [];
  const canaryMarker = readFileSync(canary, "utf8").trim();
  // ファイルへのリンク
  files.forEach((f, i) => {
    const l = join(dir, `file-${i}`);
    symlinkSync(f.path, l);
    links.push({ label: `${f.label}(ファイルへのリンク)`, path: l, marker: f.marker });
  });
  // ディレクトリへのリンク(~/.kuramoto と ~/.ssh)
  const dirLink = join(dir, "kuramoto-home");
  symlinkSync(kuramotoHome(), dirLink);
  links.push({ label: "~/.kuramoto の確かめ用ファイル(ディレクトリへのリンク)", path: join(dirLink, "e2e-probe-canary.txt"), marker: canaryMarker });
  const sshDir = join(homedir(), ".ssh");
  const sshFile = files.find((f) => f.path.startsWith(sshDir + "/"));
  if (sshFile) {
    const l = join(dir, "ssh-home");
    symlinkSync(sshDir, l);
    links.push({ label: `${sshFile.label}(ディレクトリへのリンク)`, path: join(l, sshFile.path.slice(sshDir.length + 1)), marker: sshFile.marker });
  }
  // 対照: 許した場所(package.json)を指すリンクは開ける(リンクそのものが壊れていないことを見る)
  const control = join(dir, "control");
  symlinkSync(join(repo, "package.json"), control);
  // 原因を読むための参考(判定には入れない): 実ファイル・同じディレクトリの中へのリンク・相対リンク
  const real = join(dir, "real.json");
  writeFileSync(real, readFileSync(join(repo, "package.json")));
  const inner = join(dir, "inner");
  symlinkSync("real.json", inner);
  const rel = join(dir, "rel");
  symlinkSync("../../package.json", rel);
  return { dir, links, control: { path: control }, diag: { real, inner, rel } };
}

/** E2E の試験の件数(`playwright test --list`。閉じ込めの外で数える)。数えられなければ null(理由は 1 行出す)。 */
function countE2eTests(cwd: string): number | null {
  try {
    const total = parseListTotal(execFileSync("npx", ["playwright", "test", "--list"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120_000 }));
    if (total === null) console.log("--- playwright test --list の出力に「Total: N tests」が無く、件数を数えられなかった");
    return total;
  } catch (e) {
    const err = e as { stderr?: Buffer | string; message?: string };
    const reason = String(err.stderr || err.message || e).trim().split("\n").find((l) => l.trim()) ?? "不明";
    console.log(`--- playwright test --list が失敗した(件数の突き合わせはしない): ${reason}`);
    return null;
  }
}

async function main(): Promise<number> {
  const p = await Project.open(":memory:");
  let gitDir = join(repo, ".git");
  try {
    gitDir = resolve(repo, execFileSync("git", ["rev-parse", "--git-common-dir"], { cwd: repo, encoding: "utf8" }).trim());
  } catch {
    /* git の外でも流せるように、.git のままにする */
  }
  const conf = await confinementFor(p, { path: repo, base: "main", gitDir }, "qa");
  const runner = new SandboxRunner();
  const expectedE2e = countE2eTests(repo);
  console.log(`--- E2E の試験の件数(playwright test --list): ${expectedE2e ?? "数えられなかった"}`);
  let code = 0;
  try {
    // ---- (i) / (ii): npm test を、チームの CI と同じ実行(SandboxRunner)で流す ----
    const phoneBar = join(repo, "ui/src/PhoneBar.tsx");
    const original = BREAK ? readFileSync(phoneBar, "utf8") : "";
    if (BREAK) {
      if (!original.includes('drawerTo("policy")')) throw new Error('PhoneBar.tsx に drawerTo("policy") が無いので、壊せません');
      writeFileSync(phoneBar, original.replace('drawerTo("policy")', "drawerTo(null)"));
      console.log('--- わざと壊した: ui/src/PhoneBar.tsx の drawerTo("policy") → drawerTo(null)');
    }
    try {
      const r = await runner.run("npm test", repo, conf, 20 * 60_000);
      // 落ちた試験の理由が切れないよう、末尾 200 行を残す(CI のログで読めるように)
      console.log(r.output.split("\n").slice(-200).join("\n"));
      // ブラウザサーバーの標準エラー(Chrome の落ちた理由)は、E2E の最初に出るので、末尾 200 行には入らない。別に取り出して残す
      const browserLines = r.output.split("\n").filter((l) => /\[browser-server\]|FATAL|Check failed|SIGTRAP|crashed/.test(l));
      if (browserLines.length) console.log(`--- ブラウザサーバーの標準エラー・Chrome の落ちた理由(${browserLines.length} 行のうち先頭 60 行)\n${browserLines.slice(0, 60).map((l) => l.slice(0, 300)).join("\n")}`);
      console.log(`--- npm test の終了コード: ${r.code}`);
      if (NO_BROWSER_SERVER) {
        // 設定なしの回: ブラウザサーバーは立たず、E2E は「起動できなければ知らせて通す」。通ること・知らせが出たかを残す
        const skipped = r.output.includes("ブラウザを起動できなかったので、画面の確かめは流していません");
        // ○ は、npm test が通り、知らせが無く、E2E の通った件数が試験の件数と合っているときだけ。それ以外は E2E が流れたか分からない(E2E の回より前で落ちた・回ごと飛ばした、など)
        const count = judgeE2eCount(r.output, expectedE2e);
        const ran = r.code === 0 && !skipped && count.kind === "ok";
        console.log(
          skipped
            ? "△ 設定なし: Chrome が起動できず、画面の E2E は流れていない(知らせて通った)"
            : ran
              ? `○ 設定なし: 閉じ込めの中で Chrome が起動でき、E2E ${count.kind === "ok" ? count.passed : ""} 件が流れた`
              : "? 設定なし: E2E が流れたか分からない(npm test の終了コードか、出力の「N passed」が無い、または試験の件数と合わない。E2E の回より前で落ちた・回ごと飛ばした可能性。上の出力を見る)",
        );
        return r.code === 0 ? 0 : 1;
      }
      const browserNotice = r.output.includes("狭い閉じ込めの中でブラウザを起動できなかった");
      if (browserNotice) {
        console.log("--- 確かめられなかった: 狭い閉じ込めの中でブラウザを起動できなかった(上の出力の理由を見る)。閉じ込めの無いブラウザには切り替えていない");
        return 2;
      }
      if (BREAK) {
        console.log(r.code === 0 ? "✗ 入口を壊したのに通った" : "○ 入口を壊すと落ちた");
        return r.code === 0 ? 1 : 0;
      }
      if (r.code !== 0) return 1;
      console.log(describeE2eCount(judgeE2eCount(r.output, expectedE2e)));
    } finally {
      if (BREAK) writeFileSync(phoneBar, original);
    }
    if (BREAK) return 0;

    // ---- (iii): 接続した側からの確かめ ----
    const canary = join(kuramotoHome(), "e2e-probe-canary.txt");
    mkdirSync(kuramotoHome(), { recursive: true });
    writeFileSync(canary, `SECRET-${Math.random().toString(36).slice(2)}-${Date.now()}`);
    const server = createServer((_req, res) => res.end("CANARY-NET"));
    await new Promise<void>((ok) => server.listen(0, "0.0.0.0", ok));
    const probeFile = join(repo, "node_modules/.kuramoto-probe.cjs");
    const linkDir = join(repo, "node_modules", ".kuramoto-probe-links");
    try {
      writeFileSync(probeFile, PROBE);
      const files = secretFiles(canary);
      const planted = plantLinks(repo, canary, files);
      const targets = { cwd: repo, port: (server.address() as AddressInfo).port, lanIp: lanIp(), files, links: planted.links, linkControl: planted.control, linkDiag: planted.diag };
      const r = await runner.run("node node_modules/.kuramoto-probe.cjs", repo, { ...conf, env: { ...conf.env, PROBE_TARGETS: JSON.stringify(targets) } }, 5 * 60_000, true);
      const probes = r.output.split("\n").filter((l) => l.startsWith("PROBE ")).map((l) => JSON.parse(l.slice(6)) as Probe);
      if (!probes.length) {
        console.log(`--- 接続した側の確かめが動かなかった(終了コード ${r.code})\n${r.output.split("\n").slice(-30).join("\n")}`);
        return 2;
      }
      for (const x of probes) console.log(`${x.ok ? "○" : "✗"} ${x.name}: ${x.detail}`);
      for (const l of r.output.split("\n")) if (l.startsWith("INFO ")) console.log(`参考: ${l.slice(5)}`);
      code = probes.every((x) => x.ok) ? 0 : 1;
      console.log(code === 0 ? "○ 接続した側からの攻撃は、どれも失敗した" : "✗ 閉じ込めに穴がある");
    } finally {
      server.close();
      rmSync(canary, { force: true });
      rmSync(probeFile, { force: true });
      rmSync(linkDir, { recursive: true, force: true });
    }
  } finally {
    await runner.close();
  }
  return code;
}

main().then(
  (c) => process.exit(c),
  (e: unknown) => {
    console.error(e);
    process.exit(2);
  },
);
