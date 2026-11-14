import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import type { DisposableDb } from "../src/db/mysql-test-support.js";
import { findMysqlTestFiles, isMainModule, main, splitArgs, type Deps } from "./run-tests.js";

/** vitest と mysql-test の代わり。呼ばれた回と、使い捨ての database を作った・消した順を残す。 */
function fake(over: { sqlite?: number; mysql?: number; e2e?: number; createFails?: boolean; interruptAfterFirst?: boolean } = {}) {
  const calls: { args: string[]; env: NodeJS.ProcessEnv }[] = [];
  const events: string[] = [];
  const lines: string[] = [];
  let e2eRuns = 0;
  let stop = false;
  const deps: Deps = {
    vitest: async (args, env) => {
      calls.push({ args, env });
      if (over.interruptAfterFirst) stop = true;
      return env.KURAMOTO_TEST_DB === "mysql" ? (over.mysql ?? 0) : (over.sqlite ?? 0);
    },
    e2e: async () => {
      e2eRuns++;
      return over.e2e ?? 0;
    },
    createDb: async () => {
      if (over.createFails) throw new Error("mysql-test(127.0.0.1:3307)に繋がりません。`docker compose up -d mysql-test` が要ります");
      events.push("create");
      const db: DisposableDb = { name: "kuramoto_test_x", url: "mysql://u:p@127.0.0.1:3307/kuramoto_test_x", drop: async () => void events.push("drop") };
      return db;
    },
    mysqlFiles: () => ["src/db/a.test.ts"],
    log: (l) => lines.push(l),
    interrupted: () => stop,
  };
  return { deps, calls, events, lines, e2eRuns: () => e2eRuns };
}

describe("npm test(SQLite の回と MySQL の回)", () => {
  it("SQLite の回のあとに MySQL の回を流す。MySQL の回は使い捨ての database の URL を渡し、終わったら消す", async () => {
    const f = fake();
    expect(await main([], {}, f.deps)).toBe(0);
    expect(f.calls.map((c) => c.env.KURAMOTO_TEST_DB)).toEqual(["sqlite", "mysql"]);
    expect(f.calls[0]!.args).toEqual([]);
    expect(f.calls[1]!.args).toEqual(["--passWithNoTests", "src/db/a.test.ts"]);
    expect(f.calls[1]!.env.KURAMOTO_MYSQL_TEST_URL).toBe("mysql://u:p@127.0.0.1:3307/kuramoto_test_x");
    expect(f.events).toEqual(["create", "drop"]);
  });

  it("MySQL の回だけで落ちても、終了コードは 0 にならない(SQLite の回だけ落ちても同じ)。database は消す", async () => {
    const m = fake({ mysql: 1 });
    expect(await main([], {}, m.deps)).toBe(1);
    expect(m.lines.join("\n")).toContain("落ちた回: MySQL");
    expect(m.events).toEqual(["create", "drop"]);
    const s = fake({ sqlite: 1 });
    expect(await main([], {}, s.deps)).toBe(1);
    expect(s.lines.join("\n")).toContain("落ちた回: SQLite");
    expect(s.calls.length).toBe(2); // SQLite が落ちても MySQL の回は流す(両方の結果を見せる)
  });

  it("mysql-test に繋がらなければ、黙って飛ばさず、案内を出して落とす。どちらの回も流さない", async () => {
    const f = fake({ createFails: true });
    expect(await main([], {}, f.deps)).toBe(1);
    expect(f.lines.join("\n")).toContain("docker compose up -d mysql-test");
    expect(f.calls).toEqual([]);
  });

  it("KURAMOTO_SKIP_MYSQL_TESTS=1 のときだけ、MySQL の回を飛ばす(飛ばしたと出す。database は作らない)", async () => {
    const f = fake({ createFails: true });
    expect(await main([], { KURAMOTO_SKIP_MYSQL_TESTS: "1" }, f.deps)).toBe(0);
    expect(f.calls.map((c) => c.env.KURAMOTO_TEST_DB)).toEqual(["sqlite"]);
    expect(f.lines.join("\n")).toContain("飛ばしました");
    // 1 以外では飛ばさない
    expect(await main([], { KURAMOTO_SKIP_MYSQL_TESTS: "0" }, f.deps)).toBe(1);
  });

  it("引数(ファイルの絞り込み)は両方の回にそのまま渡す", async () => {
    const f = fake();
    await main(["src/foo.test.ts"], {}, f.deps);
    expect(f.calls.map((c) => c.args)).toEqual([["src/foo.test.ts"], ["--passWithNoTests", "src/foo.test.ts"]]);
  });

  it("フラグだけを渡したときは、SQLite の回にはそのまま、MySQL の回にはフラグと mysql-test の試験だけを渡す(全部の試験を 2 度流さない)", async () => {
    const f = fake();
    await main(["--reporter=verbose", "-t", "名前"], {}, f.deps);
    expect(f.calls[0]!.args).toEqual(["--reporter=verbose", "-t", "名前"]);
    expect(f.calls[1]!.args).toEqual(["--passWithNoTests", "--reporter=verbose", "-t", "名前", "src/db/a.test.ts"]);
    expect(splitArgs(["--reporter=verbose", "src/x.test.ts", "foo.test.ts"])).toEqual({ files: ["src/x.test.ts", "foo.test.ts"], flags: ["--reporter=verbose"] });
  });

  it("SQLite の回の途中で中断されたら、MySQL の回は流さず、database を消して終わる", async () => {
    const f = fake({ interruptAfterFirst: true });
    expect(await main([], {}, f.deps)).toBe(130);
    expect(f.calls.map((c) => c.env.KURAMOTO_TEST_DB)).toEqual(["sqlite"]);
    expect(f.events).toEqual(["create", "drop"]);
  });

  it("SQLite・MySQL の回のあとに E2E の回を流し、E2E の回だけ落ちても終了コードは 0 にならない", async () => {
    const ok = fake();
    expect(await main([], {}, ok.deps)).toBe(0);
    expect(ok.e2eRuns()).toBe(1);
    expect(ok.lines.join("\n")).toContain("=== E2E の回");
    const ng = fake({ e2e: 1 });
    expect(await main([], {}, ng.deps)).toBe(1);
    expect(ng.lines.join("\n")).toContain("落ちた回: E2E");
    expect(ng.calls.length).toBe(2); // E2E の回が落ちても、ほかの回の結果は出す
    expect(ng.events).toEqual(["create", "drop"]);
  });

  it("E2E の回は、KURAMOTO_SKIP_E2E_TESTS=1 のときと、試験のファイルを絞ったときだけ飛ばす(飛ばしたと出す)", async () => {
    const env = fake();
    expect(await main([], { KURAMOTO_SKIP_E2E_TESTS: "1" }, env.deps)).toBe(0);
    expect(env.e2eRuns()).toBe(0);
    expect(env.lines.join("\n")).toContain("E2E の回: 飛ばしました");
    // 1 以外では飛ばさない
    expect(await main([], { KURAMOTO_SKIP_E2E_TESTS: "0" }, env.deps)).toBe(0);
    expect(env.e2eRuns()).toBe(1);
    const files = fake();
    await main(["src/foo.test.ts"], {}, files.deps);
    expect(files.e2eRuns()).toBe(0);
    // フラグだけなら流す
    const flags = fake();
    await main(["--reporter=verbose"], {}, flags.deps);
    expect(flags.e2eRuns()).toBe(1);
  });

  it("MySQL の回を飛ばしても、E2E の回は流す。中断されたら E2E の回は流さない", async () => {
    const f = fake();
    expect(await main([], { KURAMOTO_SKIP_MYSQL_TESTS: "1" }, f.deps)).toBe(0);
    expect(f.e2eRuns()).toBe(1);
    const stopped = fake({ interruptAfterFirst: true });
    expect(await main([], {}, stopped.deps)).toBe(130);
    expect(stopped.e2eRuns()).toBe(0);
  });

  it("直接起動の判定は、空白・日本語を含むパスと、シンボリックリンクを通したパスでも一致する(一致しないと試験を 1 つも流さずに 0 で終わる)", () => {
    const dir = mkdtempSync(join(tmpdir(), "kuramoto run 試験-"));
    try {
      mkdirSync(join(dir, "real dir"));
      const file = join(dir, "real dir", "run tests.ts");
      writeFileSync(file, "");
      symlinkSync(join(dir, "real dir"), join(dir, "link"));
      const url = pathToFileURL(file).href;
      expect(url).toContain("%20"); // パーセントエンコードされている
      expect(isMainModule(url, file)).toBe(true);
      expect(isMainModule(url, join(dir, "link", "run tests.ts"))).toBe(true);
      expect(isMainModule(url, join(dir, "other.ts"))).toBe(false);
      expect(isMainModule(url, undefined)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("MySQL の回の試験は、mysql-test を使うファイルを自動で見つける", () => {
    const files = findMysqlTestFiles();
    expect(files).toContain("src/db/mysql-adapter.test.ts");
    expect(files).toContain("src/db/mysql-migrate.test.ts");
    expect(files).not.toContain("src/db/mysql.test.ts");
  });
});
