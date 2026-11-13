import { spawn, type ChildProcess } from "node:child_process";
import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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

/** 中断(Ctrl-C・SIGTERM)を受けたか。受けたら、残りの回は流さず、使い捨ての database を消して終わる。 */
let interrupted = false;
let current: ChildProcess | undefined;

/** 中断の受け取りを付ける。親は、子(vitest)を止めるだけで、自分は後片付けのあとに終わる。 */
function trapSignals(): void {
  for (const sig of ["SIGINT", "SIGTERM"] as const)
    process.on(sig, () => {
      interrupted = true;
      current?.kill(sig);
    });
}

/** vitest を 1 回流す。終了コードを返す。 */
function vitest(args: string[], env: NodeJS.ProcessEnv): Promise<number> {
  return new Promise((done) => {
    const child = spawn(process.execPath, [join(root, "node_modules/vitest/vitest.mjs"), "run", ...args], { cwd: root, env, stdio: "inherit" });
    current = child;
    child.on("close", (code, sig) => {
      current = undefined;
      done(code ?? (sig ? 1 : 0));
    });
    child.on("error", () => done(1));
  });
}

/**
 * 引数を、試験のファイルの絞り込み(「/」を含む・.ts/.js で終わる)とそれ以外(--reporter=verbose や -t など)に分ける。
 * MySQL の回は、フラグはそのまま渡し、ファイルの絞り込みが無ければ mysql-test を使う試験だけにする。
 */
export function splitArgs(args: string[]): { files: string[]; flags: string[] } {
  const isFile = (a: string) => !a.startsWith("-") && (a.includes("/") || /\.[cm]?[jt]sx?$/.test(a));
  return { files: args.filter(isFile), flags: args.filter((a) => !isFile(a)) };
}

/** このファイルが直接起動されたか。パスの空白・非 ASCII(import.meta.url はパーセントエンコードされる)や、シンボリックリンクを通した起動でも一致するよう、実体のパスで比べる。 */
export function isMainModule(metaUrl: string, argv1: string | undefined): boolean {
  if (!argv1) return false;
  const real = (p: string) => {
    try {
      return realpathSync(p);
    } catch {
      return resolve(p);
    }
  };
  return real(fileURLToPath(metaUrl)) === real(argv1);
}

export type Deps = {
  vitest: (args: string[], env: NodeJS.ProcessEnv) => Promise<number>;
  createDb: () => Promise<DisposableDb>;
  mysqlFiles: () => string[];
  log: (line: string) => void;
  interrupted: () => boolean;
};

const real: Deps = { vitest, createDb: () => createDisposableDb(), mysqlFiles: () => findMysqlTestFiles(), log: (l) => console.log(l), interrupted: () => interrupted };

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
    if (d.interrupted()) {
      d.log("\n中断しました。MySQL の回は流さず、使い捨ての database を消して終わります");
      return 130;
    } else if (skip) {
      d.log(`\n=== MySQL の回: 飛ばしました(${SKIP_MYSQL_ENV}=1) ===`);
    } else {
      d.log(`\n=== MySQL の回(mysql-test の使い捨ての database ${db!.name}) ===`);
      const { files, flags } = splitArgs(args);
      mysql = await d.vitest(["--passWithNoTests", ...flags, ...(files.length ? files : d.mysqlFiles())], { ...env, [TEST_DB_ENV]: "mysql", KURAMOTO_MYSQL_TEST_URL: db!.url });
      if (d.interrupted()) return 130;
    }
    if (sqlite !== 0 || mysql !== 0) d.log(`\n✗ 落ちた回: ${[sqlite !== 0 && "SQLite", mysql !== 0 && "MySQL"].filter(Boolean).join("・")}`);
    return sqlite !== 0 || mysql !== 0 ? 1 : 0;
  } finally {
    await db?.drop().catch((e: unknown) => d.log(`使い捨ての database ${db!.name} を消せませんでした: ${e instanceof Error ? e.message : String(e)}`));
  }
}

if (isMainModule(import.meta.url, process.argv[1])) {
  trapSignals();
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
