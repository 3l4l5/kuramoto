import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, networkInterfaces } from "node:os";
import { join, resolve } from "node:path";
import { Project } from "../src/project/project.js";
import { confinementFor } from "../src/project/confine.js";
import { SandboxRunner } from "../src/project/team-ci.js";
import { kuramotoHome } from "../src/hq.js";

/**
 * チームの CI のブラウザサーバー(ブラウザ専用の狭い閉じ込め)の確かめ(#93)。Kuramoto のサーバー(Chrome が動く場所)で流す。
 *
 *   npx tsx scripts/check-confined-browser.ts [リポジトリのパス]            # (i) と (iii)
 *   npx tsx scripts/check-confined-browser.ts [リポジトリのパス] --break    # (ii) わざと入口を壊して、落ちることを確かめる
 *
 * (i)   チームの CI と同じ閉じ込めの中で npm test を流し、狭い閉じ込めの中のブラウザに繋いで E2E が通る
 * (ii)  --break: PhoneBar の「チームの方針」の入口を壊して同じ実行をし、落ちる(終わったら元に戻す)
 * (iii) 接続した側から、次がどれも失敗する(外のブラウザサーバーの閉じ込めが効いている)
 *       - file:// で ~/.kuramoto の中のファイル(access-token など)と ~/.ssh の中のファイルを開く
 *       - newContext({ proxy }) を使った外への通信 / newRequest(ローカルの playwright と、ブラウザ側の context.request)で外の URL を取る
 *       対照として、リポジトリの package.json と localhost の確かめ用サーバーには繋がる(ブラウザそのものが壊れて「失敗」しているのではないことを見るため)
 * 終了コード: 0 = 通った / 1 = 落ちた(閉じ込めの穴・E2E の失敗) / 2 = 確かめられなかった(ブラウザが起動できなかったなど)
 */

const repo = resolve(process.argv.slice(2).find((a) => !a.startsWith("--")) ?? ".");
const BREAK = process.argv.includes("--break");

type Probe = { name: string; ok: boolean; detail: string };

/** 中(npm test と同じ閉じ込め)で流す、接続した側の確かめ。ブラウザには KURAMOTO_E2E_WS_ENDPOINT で繋ぐ。 */
const PROBE = `
const { chromium, request } = require("@playwright/test");
const t = JSON.parse(process.env.PROBE_TARGETS);
const out = (name, ok, detail) => console.log("PROBE " + JSON.stringify({ name, ok, detail: String(detail).slice(0, 200) }));
const body = async (page, url) => {
  const r = await page.goto(url, { timeout: 15000 }).catch((e) => ({ error: String(e.message).split("\\n")[0] }));
  if (r && r.error) return { error: r.error, text: "" };
  return { error: null, text: await page.evaluate(() => document.body ? document.body.innerText : "").catch(() => "") };
};
(async () => {
  if (!process.env.KURAMOTO_E2E_WS_ENDPOINT) return; // ブラウザサーバーが渡されなかった(起動できなかった)。確かめない
  const browser = await chromium.connect(process.env.KURAMOTO_E2E_WS_ENDPOINT, { timeout: 60000 });
  const page = await browser.newPage();
  // 対照: 繋がる
  let r = await body(page, "file://" + t.cwd + "/package.json");
  out("対照: リポジトリの package.json を開ける", r.text.includes('"name"'), r.error || "開けた");
  r = await body(page, "http://127.0.0.1:" + t.port + "/");
  out("対照: localhost の確かめ用サーバーに繋がる", r.text.includes("CANARY-NET"), r.error || "繋がった");
  // (iii) ファイル
  for (const f of t.files) {
    r = await body(page, "file://" + f.path);
    out("file:// で " + f.label + " を開けない", !r.text.includes(f.marker), r.error || (r.text.includes(f.marker) ? "中身が読めた" : "開いたが中身は無い"));
  }
  // (iii) 外への通信
  if (!t.lanIp) out("外への通信を確かめる LAN の IP", false, "非 loopback の IPv4 が無いので確かめられない");
  else {
    const url = "http://" + t.lanIp + ":" + t.port + "/";
    r = await body(page, url);
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
      console.log(r.output.split("\n").slice(-60).join("\n"));
      console.log(`--- npm test の終了コード: ${r.code}`);
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
      console.log(/\b15 passed\b/.test(r.output) ? "○ E2E 15 件が通った" : "△ npm test は通ったが「15 passed」が出力に見つからない(件数が変わったか、E2E が流れていない)");
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
    try {
      writeFileSync(probeFile, PROBE);
      const targets = { cwd: repo, port: (server.address() as AddressInfo).port, lanIp: lanIp(), files: secretFiles(canary) };
      const r = await runner.run("node node_modules/.kuramoto-probe.cjs", repo, { ...conf, env: { ...conf.env, PROBE_TARGETS: JSON.stringify(targets) } }, 5 * 60_000, true);
      const probes = r.output.split("\n").filter((l) => l.startsWith("PROBE ")).map((l) => JSON.parse(l.slice(6)) as Probe);
      if (!probes.length) {
        console.log(`--- 接続した側の確かめが動かなかった(終了コード ${r.code})\n${r.output.split("\n").slice(-30).join("\n")}`);
        return 2;
      }
      for (const x of probes) console.log(`${x.ok ? "○" : "✗"} ${x.name}: ${x.detail}`);
      code = probes.every((x) => x.ok) ? 0 : 1;
      console.log(code === 0 ? "○ 接続した側からの攻撃は、どれも失敗した" : "✗ 閉じ込めに穴がある");
    } finally {
      server.close();
      rmSync(canary, { force: true });
      rmSync(probeFile, { force: true });
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
