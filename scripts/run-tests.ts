import { spawn } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { createDisposableDb, SKIP_MYSQL_ENV, TEST_DB_ENV, type DisposableDb } from "../src/db/mysql-test-support.js";

/**
 * npm test。SQLite の回と MySQL の回を、この順に 1 回ずつ流す(ADR-0042)。
 * - SQLite の回: 全部の試験。mysql-test を使う試験の中身は飛ばす(KURAMOTO_TEST_DB=sqlite)
 * - MySQL の回: mysql-test(127.0.0.1:3307)に、この回だけの使い捨ての database を作り、mysql-test を使う試験だけを流して、終わったら消す
 *   (KURAMOTO_TEST_DB=mysql)。回ごとに別の database なので、複数の worktree から同時に流しても混ざらない
 * - mysql-test に繋がらなければ、黙って飛ばさず、`docker compose up -d mysql-test` が要ると出して落とす。
 *   飛ばしてよいときだけ、KURAMOTO_SKIP_MYSQL_TESTS=1 で明示する
 * どちらかの回が落ちれば、終了コードは 0 にならない。引数は vitest にそのまま渡す(ファイルの絞り込みなど)。
 */

const root = resolve(import.meta.dirname, "..");

/** mysql-test を使う試験のファイル(connectTest を使っているもの)。root からの相対パス。 */
export function findMysqlTestFiles(dir: string = root): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name.startsWith(".")) continue;
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".test.ts") && /\bconnectTest\b/.test(readFileSync(p, "utf8"))) out.push(relative(dir, p));
    }
  };
  for (const top of ["src", "scripts"]) walk(join(dir, top));
  return out.sort();
}

/** vitest を 1 回流す。終了コードを返す。 */
function vitest(args: string[], env: NodeJS.ProcessEnv): Promise<number> {
  return new Promise((done) => {
    const child = spawn(process.execPath, [join(root, "node_modules/vitest/vitest.mjs"), "run", ...args], { cwd: root, env, stdio: "inherit" });
    const forward = (sig: NodeJS.Signals) => child.kill(sig);
    process.on("SIGINT", forward);
    process.on("SIGTERM", forward);
    child.on("close", (code, sig) => {
      process.off("SIGINT", forward);
      process.off("SIGTERM", forward);
      done(code ?? (sig ? 1 : 0));
    });
    child.on("error", () => done(1));
  });
}

export type Deps = {
  vitest: (args: string[], env: NodeJS.ProcessEnv) => Promise<number>;
  createDb: () => Promise<DisposableDb>;
  mysqlFiles: () => string[];
  log: (line: string) => void;
};

const real: Deps = { vitest, createDb: () => createDisposableDb(), mysqlFiles: () => findMysqlTestFiles(), log: (l) => console.log(l) };

export async function main(args: string[], env: NodeJS.ProcessEnv = process.env, d: Deps = real): Promise<number> {
  const skip = env[SKIP_MYSQL_ENV] === "1";
  let db: DisposableDb | undefined;
  if (!skip) {
    // 先に確かめる(繋がらないのに SQLite の回だけ長く流さない)
    try {
      db = await d.createDb();
    } catch (e) {
      d.log(`\n✗ ${e instanceof Error ? e.message : String(e)}\n`);
      return 1;
    }
  }
  try {
    d.log("\n=== SQLite の回 ===");
    const sqlite = await d.vitest(args, { ...env, [TEST_DB_ENV]: "sqlite" });
    let mysql = 0;
    if (skip) {
      d.log(`\n=== MySQL の回: 飛ばしました(${SKIP_MYSQL_ENV}=1) ===`);
    } else {
      d.log(`\n=== MySQL の回(mysql-test の使い捨ての database ${db!.name}) ===`);
      const files = args.length ? args : d.mysqlFiles();
      mysql = await d.vitest(["--passWithNoTests", ...files], { ...env, [TEST_DB_ENV]: "mysql", KURAMOTO_MYSQL_TEST_URL: db!.url });
    }
    if (sqlite !== 0 || mysql !== 0) d.log(`\n✗ 落ちた回: ${[sqlite !== 0 && "SQLite", mysql !== 0 && "MySQL"].filter(Boolean).join("・")}`);
    return sqlite !== 0 || mysql !== 0 ? 1 : 0;
  } finally {
    await db?.drop().catch((e: unknown) => d.log(`使い捨ての database ${db!.name} を消せませんでした: ${e instanceof Error ? e.message : String(e)}`));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
