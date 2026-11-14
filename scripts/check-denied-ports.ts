import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Confinement } from "../src/harness/types.js";
import { SandboxRunner } from "../src/project/team-ci.js";

/**
 * チームの CI の閉じ込めの「断るポート」の確かめ(ADR-0059・#100)。Kuramoto のサーバーで、閉じ込めの外から流す。
 *
 *   npx tsx scripts/check-denied-ports.ts [--denied-port <番号>]...
 *
 * src/project/team-ci.test.ts の「断るポート」の試験(入れ子の閉じ込めの中ではスキップされる)と同じ作りで、
 * 閉じ込めの中から nc で各ポートに繋ぎ、REACHED / BLOCKED を 1 行ずつ出す。
 *   - 断るポート(Kuramoto 本体の API の代わりの、ローカルで立てたサーバー): BLOCKED
 *   - ほかのポート(ローカルで立てたサーバー・mysql-test の 3307): REACHED
 *   - 断るポートを空にした設定では、同じポートに REACHED(断りが効いているのは設定のおかげ、の対照)
 * --denied-port: Kuramoto 自身が使っているポート(ADR-0060: 手元の MySQL の 127.0.0.1:3306 など)も断るポートに足して、そこが BLOCKED になることを見る。そのポートが立っていなければ、見ない
 * 3307 は mysql-test が立っているときだけ見る(`docker compose up -d mysql-test`)。立っていなければ「立っていない」と出して、その行は数えない。
 * 終了コード: 0 = 想定どおり / 1 = 想定と違う / 2 = 閉じ込めを使えなかった
 */

const extraDenied = process.argv.flatMap((a, i, all) => (a === "--denied-port" ? [Number(all[i + 1])] : [])).filter((n) => Number.isInteger(n) && n > 0 && n < 65536);

const listen = async () => {
  const s = createServer((c) => c.end());
  await new Promise<void>((ok) => s.listen(0, "127.0.0.1", ok));
  return { s, port: (s.address() as AddressInfo).port };
};

/** その 127.0.0.1 のポートで、何かが待ち受けているか(使われていれば bind に失敗する)。 */
const inUse = (port: number) =>
  new Promise<boolean>((done) => {
    const s = createServer();
    s.once("error", () => done(true));
    s.listen(port, "127.0.0.1", () => s.close(() => done(false)));
  });
const mysqlUp = await inUse(3307);

const api = await listen();
const other = await listen();
const dir = mkdtempSync(join(tmpdir(), "kuramoto-ports-"));
const runner = new SandboxRunner();
let bad = 0;
try {
  const conf: Confinement = { readable: [], writable: [], hidden: [], allowedDomains: ["registry.npmjs.org"], hiddenEnv: [], allowLocalSockets: true, deniedLocalPorts: [api.port, ...extraDenied], env: {} };
  const probe = async (label: string, port: number, c: Confinement, want: "REACHED" | "BLOCKED") => {
    const out = (await runner.run(`/usr/bin/nc -z -w 3 127.0.0.1 ${port} && echo REACHED || echo BLOCKED`, dir, c, 60_000)).output;
    const got = out.includes("REACHED") ? "REACHED" : out.includes("BLOCKED") ? "BLOCKED" : `?(${out.trim().slice(0, 120)})`;
    const ok = got === want;
    if (!ok) bad++;
    console.log(`${ok ? "○" : "✗"} ${label}(127.0.0.1:${port}): ${got}(想定 ${want})`);
  };
  console.log(`断るポート: ${api.port}(Kuramoto 本体の API の代わり)`);
  await probe("断るポート", api.port, conf, "BLOCKED");
  await probe("ほかのポート(テストが立てるサーバーの代わり)", other.port, conf, "REACHED");
  if (mysqlUp) await probe("mysql-test", 3307, conf, "REACHED");
  else console.log("- mysql-test(127.0.0.1:3307)は立っていないので、見ていない(`docker compose up -d mysql-test`)");
  for (const p of extraDenied) {
    if (await inUse(p)) await probe("断るポート(--denied-port。Kuramoto 自身が使っているもの)", p, conf, "BLOCKED");
    else console.log(`- ポート ${p} では何も待ち受けていないので、見ていない`);
  }
  await probe("対照: 断るポートを空にした設定の、同じポート", api.port, { ...conf, deniedLocalPorts: [] }, "REACHED");
} catch (e) {
  console.log(`? 閉じ込めを使えなかった: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 2;
} finally {
  await runner.close();
  api.s.close();
  other.s.close();
  rmSync(dir, { recursive: true, force: true });
}
if (process.exitCode !== 2) process.exitCode = bad ? 1 : 0;
console.log(process.exitCode === 0 ? "○ 断るポートだけが BLOCKED になった" : "✗ 想定と違う");
