import { spawnSync } from "node:child_process";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Confinement } from "../src/harness/types.js";
import { checkDeniedPorts, main, parseDeniedPorts, readVerdict, type Deps } from "./check-denied-ports.js";

/** 閉じ込めの代わり。決めた台本で、ポートごとに REACHED / BLOCKED を返す(断るポートに入っていれば BLOCKED)。 */
function fake(opts: { leak?: boolean; unreadable?: boolean; throws?: boolean; busy?: number[] } = {}) {
  const lines: string[] = [];
  const asked: { port: number; denied: number[] }[] = [];
  let next = 40_000;
  let closed = 0;
  let runnerClosed = false;
  const deps: Deps = {
    cwd: "/tmp/x",
    log: (l) => lines.push(l),
    listen: async () => ({ port: next++, close: () => void closed++ }),
    inUse: async (p) => (opts.busy ?? []).includes(p),
    runner: {
      run: async (cmd: string, _cwd: string, conf: Confinement) => {
        if (opts.throws) throw new Error("sandbox-exec が使えない");
        const port = Number(/127\.0\.0\.1 (\d+)/.exec(cmd)![1]);
        asked.push({ port, denied: conf.deniedLocalPorts ?? [] });
        if (opts.unreadable) return { code: 0, output: "nc: ???" };
        const blocked = (conf.deniedLocalPorts ?? []).includes(port) && !opts.leak;
        return { code: 0, output: blocked ? "BLOCKED\n" : "REACHED\n" };
      },
      close: async () => void (runnerClosed = true),
    },
  };
  return { deps, lines, asked, closed: () => closed, runnerClosed: () => runnerClosed };
}

describe("check-denied-ports: 引数", () => {
  it("--denied-port の番号を集める。重複は 1 つにする", () => {
    expect(parseDeniedPorts([])).toEqual({ ports: [], problems: [] });
    expect(parseDeniedPorts(["--denied-port", "3306", "--denied-port", "5432", "--denied-port", "3306"])).toEqual({ ports: [3306, 5432], problems: [] });
  });

  it("番号でない・範囲外・番号が無い・知らない引数は、黙って捨てずに問題として返す", () => {
    expect(parseDeniedPorts(["--denied-port", "abc"]).problems).toEqual(["--denied-port の番号が正しくない: abc"]);
    expect(parseDeniedPorts(["--denied-port", "0"]).problems).toHaveLength(1);
    expect(parseDeniedPorts(["--denied-port", "65536"]).problems).toHaveLength(1);
    expect(parseDeniedPorts(["--denied-port", "3.5"]).problems).toHaveLength(1);
    expect(parseDeniedPorts(["--denied-port"]).problems).toEqual(["--denied-port の番号が正しくない: (無い)"]);
    expect(parseDeniedPorts(["--denied-prot", "3306"]).problems[0]).toContain("知らない引数");
  });

  it("main: 引数が正しくなければ、閉じ込めを使わずに終了コード 2 を返す", async () => {
    expect(await main(["--denied-port", "abc"])).toBe(2);
  });
});

describe("check-denied-ports: nc の出力の読み方", () => {
  it("REACHED / BLOCKED を読む。どちらでもなければ null。両方あれば届いたほうを取る", () => {
    expect(readVerdict("REACHED\n")).toBe("REACHED");
    expect(readVerdict("BLOCKED\n")).toBe("BLOCKED");
    expect(readVerdict("nc: connect failed")).toBeNull();
    expect(readVerdict("BLOCKED\nREACHED")).toBe("REACHED");
  });
});

describe("check-denied-ports: 確かめの流れ(閉じ込めは台本)", () => {
  it("断るポートは BLOCKED、ほかのポートと mysql-test(3307)と、断りを空にした対照は REACHED のとき、終了コード 0", async () => {
    const f = fake({ busy: [3307] });
    expect(await checkDeniedPorts([], f.deps)).toBe(0);
    const out = f.lines.join("\n");
    expect(out).toContain("○ 断るポート(127.0.0.1:40000): BLOCKED(想定 BLOCKED)");
    expect(out).toContain("○ ほかのポート(テストが立てるサーバーの代わり)(127.0.0.1:40001): REACHED(想定 REACHED)");
    expect(out).toContain("○ mysql-test(127.0.0.1:3307): REACHED(想定 REACHED)");
    expect(out).toContain("○ 対照: 断るポートを空にした設定の、同じポート(127.0.0.1:40000): REACHED(想定 REACHED)");
    expect(out).toContain("○ 断るポートだけが BLOCKED になった");
    expect(f.asked.at(-1)).toEqual({ port: 40000, denied: [] }); // 対照は、断るポートを空にして流す
    expect(f.closed()).toBe(2);
    expect(f.runnerClosed()).toBe(true);
  });

  it("mysql-test が立っていなければ「見ていない」と出して数えない(終了コードは 0 のまま)", async () => {
    const f = fake();
    expect(await checkDeniedPorts([], f.deps)).toBe(0);
    expect(f.lines.join("\n")).toContain("mysql-test(127.0.0.1:3307)は立っていないので、見ていない");
    expect(f.asked.map((a) => a.port)).not.toContain(3307);
  });

  it("--denied-port のポート(Kuramoto 自身の MySQL など)が立っていれば、断るポートに足して BLOCKED を見る。mysql-test の 3307 は断らない", async () => {
    const f = fake({ busy: [3306, 3307] });
    expect(await checkDeniedPorts([3306], f.deps)).toBe(0);
    expect(f.lines.join("\n")).toContain("○ 断るポート(--denied-port。Kuramoto 自身が使っているもの)(127.0.0.1:3306): BLOCKED(想定 BLOCKED)");
    const mysql = f.asked.find((a) => a.port === 3307)!;
    expect(mysql.denied).toEqual([40000, 3306]);
    expect(mysql.denied).not.toContain(3307);
  });

  it("--denied-port のポートで何も待ち受けていなければ、見ていないと出して数えない", async () => {
    const f = fake();
    expect(await checkDeniedPorts([3306], f.deps)).toBe(0);
    expect(f.lines.join("\n")).toContain("ポート 3306 では何も待ち受けていないので、見ていない");
  });

  it("断るポートに届いてしまったら(断りが漏れた)、✗ と終了コード 1", async () => {
    const f = fake({ leak: true });
    expect(await checkDeniedPorts([], f.deps)).toBe(1);
    const out = f.lines.join("\n");
    expect(out).toContain("✗ 断るポート(127.0.0.1:40000): REACHED(想定 BLOCKED)");
    expect(out).toContain("✗ 想定と違う");
  });

  it("どの行も nc の出力が読めなければ、断りの有無ではなく閉じ込めが使えていないので、終了コード 2(入れ子の閉じ込めの中など)", async () => {
    const f = fake({ unreadable: true });
    expect(await checkDeniedPorts([], f.deps)).toBe(2);
    expect(f.lines.join("\n")).toContain("? 閉じ込めを使えなかった: nc: ???");
    expect(f.lines.join("\n")).not.toContain("○ 断るポートだけが BLOCKED");
  });

  it("一部の行だけ読めなければ、想定どおりとは数えない(終了コード 1)", async () => {
    const f = fake();
    const run = f.deps.runner.run;
    f.deps.runner.run = async (cmd, cwd, conf, t) => (cmd.includes("40001") ? { code: 1, output: "nc: ???" } : run(cmd, cwd, conf, t));
    expect(await checkDeniedPorts([], f.deps)).toBe(1);
    expect(f.lines.join("\n")).toContain("?(nc: ???)");
  });

  it("閉じ込めを使えなかったら、終了コード 2。待ち受けと閉じ込めは必ず閉じる", async () => {
    const f = fake({ throws: true });
    expect(await checkDeniedPorts([], f.deps)).toBe(2);
    expect(f.lines.join("\n")).toContain("? 閉じ込めを使えなかった: sandbox-exec が使えない");
    expect(f.closed()).toBe(2);
    expect(f.runnerClosed()).toBe(true);
  });
});

/** この環境で、sandbox-exec で閉じ込められるか。閉じ込めの中(担当・レビューの作業場所)からは重ねられない。 */
function canSandbox(): boolean {
  if (process.platform !== "darwin") return false;
  return spawnSync("/usr/bin/sandbox-exec", ["-p", "(version 1)(allow default)", "/usr/bin/true"]).status === 0;
}

describe("check-denied-ports: 実際の閉じ込め(入れ子の閉じ込めの中ではスキップ)", () => {
  it.skipIf(!canSandbox())("本物の SandboxRunner と nc で、断るポートは BLOCKED・ほかは REACHED になる", async () => {
    const { SandboxRunner } = await import("../src/project/team-ci.js");
    const lines: string[] = [];
    const dir = mkdtempSync(join(tmpdir(), "kuramoto-ports-test-"));
    const listen = async () => {
      const s = createServer((c) => c.end());
      await new Promise<void>((ok) => s.listen(0, "127.0.0.1", ok));
      return { port: (s.address() as AddressInfo).port, close: () => void s.close() };
    };
    try {
      const code = await checkDeniedPorts([], { runner: new SandboxRunner(), listen, inUse: async () => false, log: (l) => lines.push(l), cwd: dir });
      expect(lines.join("\n")).toContain("BLOCKED(想定 BLOCKED)");
      expect(code).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
