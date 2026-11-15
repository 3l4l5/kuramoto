import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Confinement } from "../src/harness/types.js";
import { SandboxRunner, type CommandRunner } from "../src/project/team-ci.js";
import { lanIps } from "./lan-ips.js";
import { isMainModule } from "./run-tests.js";

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
 * LAN の IP(この機械の内部でない IPv4。#123): macOS の seatbelt は、この機械の LAN の IP を localhost と同じ扱いで通す(#118)ので、localhost の断りが LAN の IP:断るポートにも効くかを見る。
 *   待ち受けのサーバーは 0.0.0.0 で立て(Kuramoto 本体・Docker の MySQL と同じ)、LAN の IP からも届く作りにする。
 *   - LAN の IP:断るポート: BLOCKED
 *   - 対照: LAN の IP:ほかのポート: REACHED(LAN の IP が通らない環境では、断りが効いているのか見分けられないので、✗ にする)
 *   - 対照: 断るポートを空にした設定の、LAN の IP:同じポート: REACHED
 *   LAN の IP が無ければ「見ていない」と出して数えない。--denied-port のポートは、手元では 127.0.0.1 だけで待ち受けていることがあり、LAN の IP の対照が取れないので、LAN の IP では見ない
 * --denied-port: Kuramoto 自身が使っているポート(ADR-0060: 手元の MySQL の 127.0.0.1:3306 など)も断るポートに足して、そこが BLOCKED になることを見る。そのポートが立っていなければ、見ない
 * 3307 は mysql-test が立っているときだけ見る(`docker compose up -d mysql-test`)。立っていなければ「立っていない」と出して、その行は数えない。
 * 終了コード: 0 = 想定どおり / 1 = 想定と違う / 2 = 閉じ込めを使えなかった(どの行も読めなかった。または引数が正しくない)
 */

export type Verdict = "REACHED" | "BLOCKED";

/** `--denied-port <番号>` を集める。番号でない・範囲外(1〜65535 以外)・番号が無い指定は、黙って捨てずに問題として返す。 */
export function parseDeniedPorts(argv: string[]): { ports: number[]; problems: string[] } {
  const ports: number[] = [];
  const problems: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a !== "--denied-port") {
      problems.push(`知らない引数: ${a}`);
      continue;
    }
    const raw = argv[i + 1];
    i++;
    const n = raw === undefined ? NaN : Number(raw);
    if (!Number.isInteger(n) || n < 1 || n > 65535) problems.push(`--denied-port の番号が正しくない: ${raw ?? "(無い)"}`);
    else if (!ports.includes(n)) ports.push(n);
  }
  return { ports, problems };
}

/** nc を流した出力から REACHED / BLOCKED を読む。どちらでもなければ null(想定どおりとは数えない)。両方出ていれば、届いたほうを取る(断りが漏れた)。 */
export function readVerdict(output: string): Verdict | null {
  if (output.includes("REACHED")) return "REACHED";
  if (output.includes("BLOCKED")) return "BLOCKED";
  return null;
}

export type Deps = {
  runner: Pick<CommandRunner, "run"> & { close?: () => Promise<void> };
  /** ローカルに待ち受けのサーバーを立てる。 */
  listen: () => Promise<{ port: number; close: () => void }>;
  /** その 127.0.0.1 のポートで、何かが待ち受けているか。 */
  inUse: (port: number) => Promise<boolean>;
  log: (line: string) => void;
  /** この機械の LAN の IP(内部でない IPv4)。省くと LAN の IP は見ない。 */
  lanIps?: () => string[];
  /** 流す作業ディレクトリ。 */
  cwd: string;
};

/** 確かめを流して、終了コードを返す。0 = 想定どおり / 1 = 想定と違う / 2 = 閉じ込めを使えなかった。 */
export async function checkDeniedPorts(extraDenied: number[], d: Deps): Promise<number> {
  const mysqlUp = await d.inUse(3307);
  const api = await d.listen();
  const other = await d.listen();
  let bad = 0;
  let total = 0;
  let unreadable = 0;
  let firstUnreadable = "";
  let code = 0;
  try {
    const conf: Confinement = { readable: [], writable: [], hidden: [], allowedDomains: ["registry.npmjs.org"], hiddenEnv: [], allowLocalSockets: true, deniedLocalPorts: [api.port, ...extraDenied], env: {} };
    const probe = async (label: string, port: number, c: Confinement, want: Verdict, host = "127.0.0.1") => {
      const out = (await d.runner.run(`/usr/bin/nc -z -w 3 ${host} ${port} && echo REACHED || echo BLOCKED`, d.cwd, c, 60_000)).output;
      const v = readVerdict(out);
      total++;
      if (v === null) {
        unreadable++;
        firstUnreadable ||= out.trim().slice(0, 120);
      }
      const got = v ?? `?(${out.trim().slice(0, 120)})`;
      const ok = got === want;
      if (!ok) bad++;
      d.log(`${ok ? "○" : "✗"} ${label}(${host}:${port}): ${got}(想定 ${want})`);
    };
    d.log(`断るポート: ${api.port}(Kuramoto 本体の API の代わり)`);
    await probe("断るポート", api.port, conf, "BLOCKED");
    await probe("ほかのポート(テストが立てるサーバーの代わり)", other.port, conf, "REACHED");
    if (mysqlUp) await probe("mysql-test", 3307, conf, "REACHED");
    else d.log("- mysql-test(127.0.0.1:3307)は立っていないので、見ていない(`docker compose up -d mysql-test`)");
    for (const p of extraDenied) {
      if (await d.inUse(p)) await probe("断るポート(--denied-port。Kuramoto 自身が使っているもの)", p, conf, "BLOCKED");
      else d.log(`- ポート ${p} では何も待ち受けていないので、見ていない`);
    }
    const ips = d.lanIps?.() ?? [];
    if (!ips.length) d.log("- この機械に LAN の IP が無いので、LAN の IP 経由では見ていない");
    for (const ip of ips) {
      await probe("対照: LAN の IP の、ほかのポート", other.port, conf, "REACHED", ip);
      await probe("LAN の IP 経由の、断るポート", api.port, conf, "BLOCKED", ip);
    }
    if (ips.length) await probe("対照: 断るポートを空にした設定の、LAN の IP の同じポート", api.port, { ...conf, deniedLocalPorts: [] }, "REACHED", ips[0]);
    await probe("対照: 断るポートを空にした設定の、同じポート", api.port, { ...conf, deniedLocalPorts: [] }, "REACHED");
  } catch (e) {
    d.log(`? 閉じ込めを使えなかった: ${e instanceof Error ? e.message : String(e)}`);
    code = 2;
  } finally {
    await d.runner.close?.();
    api.close();
    other.close();
  }
  // どの行も REACHED / BLOCKED が読めなかったときは、断りの有無ではなく、閉じ込めそのものが使えていない(入れ子の閉じ込めの中など)
  if (code !== 2 && total > 0 && unreadable === total) {
    d.log(`? 閉じ込めを使えなかった: ${firstUnreadable}`);
    code = 2;
  }
  if (code !== 2) code = bad ? 1 : 0;
  d.log(code === 0 ? "○ 断るポートだけが BLOCKED になった" : code === 2 ? "? 確かめられなかった(閉じ込めを使えた環境でやり直す)" : "✗ 想定と違う");
  return code;
}

const listen = async () => {
  const s = createServer((c) => c.end());
  await new Promise<void>((ok) => s.listen(0, "0.0.0.0", ok)); // Kuramoto 本体・Docker の MySQL と同じく、LAN の IP からも届く
  return { port: (s.address() as AddressInfo).port, close: () => void s.close() };
};

/** その 127.0.0.1 のポートで、何かが待ち受けているか(使われていれば bind に失敗する)。 */
const inUse = (port: number) =>
  new Promise<boolean>((done) => {
    const s = createServer();
    s.once("error", () => done(true));
    s.listen(port, "127.0.0.1", () => s.close(() => done(false)));
  });

export async function main(argv: string[]): Promise<number> {
  const { ports, problems } = parseDeniedPorts(argv);
  if (problems.length) {
    for (const p of problems) console.log(`? ${p}`);
    console.log("使い方: npx tsx scripts/check-denied-ports.ts [--denied-port <番号>]...");
    return 2;
  }
  const dir = mkdtempSync(join(tmpdir(), "kuramoto-ports-"));
  try {
    return await checkDeniedPorts(ports, { runner: new SandboxRunner(), listen, inUse, lanIps, log: (l) => console.log(l), cwd: dir });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (isMainModule(import.meta.url, process.argv[1]))
  void main(process.argv.slice(2)).then((code) => {
    process.exitCode = code; // process.exit にしない(tee に流す出力を切らない)
  });
