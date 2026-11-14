import { spawn, type ChildProcess } from "node:child_process";
import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { createServer } from "node:net";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BROWSER_CHANNEL, E2E_WS_ENDPOINT_ENV } from "../e2e/browser.js";
import { createDisposableDb, SKIP_MYSQL_ENV, TEST_DB_ENV, type DisposableDb } from "../src/db/mysql-test-support.js";

/**
 * npm test。SQLite の回と MySQL の回を、この順に 1 回ずつ流す(ADR-0042)。
 * - SQLite の回: 全部の試験。mysql-test を使う試験の中身は飛ばす(KURAMOTO_TEST_DB=sqlite)
 * - MySQL の回: mysql-test(127.0.0.1:3307)に、この回だけの使い捨ての database を作り、mysql-test を使う試験だけを流して、終わったら消す
 *   (KURAMOTO_TEST_DB=mysql)。回ごとに別の database なので、複数の worktree から同時に流しても混ざらない
 * - E2E の回: 画面のブラウザ E2E(e2e/。npm run test:e2e と同じ)。MySQL の database を消したあとに、画面を作り直して、フェイクの担当のサーバーを空いているポートで立て、Chrome で主な操作を通す(#93)。
 *   先にブラウザに繋がるか(KURAMOTO_E2E_WS_ENDPOINT が無ければ Chrome を 1 回起動できるか)を確かめ、できないとき(手元の閉じ込めの中など)は、画面の壊れとは別の「確かめていない」知らせを出して通す
 *   (KURAMOTO_E2E_REQUIRE_BROWSER=1 か、チームの CI が KURAMOTO_E2E_WS_ENDPOINT を渡したときは失敗にする)。
 *   試験のファイルを指定したとき(絞り込みの実行)は流さない。飛ばすと決めているときだけ、KURAMOTO_SKIP_E2E_TESTS=1 で明示する
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

/** node で JS を 1 回流す(vitest・vite・playwright)。終了コードを返す。 */
function runNode(script: string, args: string[], env: NodeJS.ProcessEnv): Promise<number> {
  return new Promise((done) => {
    const child = spawn(process.execPath, [join(root, script), ...args], { cwd: root, env, stdio: "inherit" });
    current = child;
    child.on("close", (code, sig) => {
      current = undefined;
      done(code ?? (sig ? 1 : 0));
    });
    child.on("error", () => done(1));
  });
}

/** vitest を 1 回流す。終了コードを返す。 */
const vitest = (args: string[], env: NodeJS.ProcessEnv) => runNode("node_modules/vitest/vitest.mjs", ["run", ...args], env);

/** 空いているポートを 1 つ選ぶ(ほかの作業場所の E2E や開発のサーバーと取り合わないため)。 */
function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const srv = createServer();
    srv.on("error", fail);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => done(port));
    });
  });
}

/**
 * ブラウザに繋がるかを確かめる。できなければ理由(1 行目)を返す。
 * 起動できない環境と、画面が壊れて E2E が落ちたのとを見分けるため、E2E の本体の前に流す。
 * KURAMOTO_E2E_WS_ENDPOINT(チームの CI がブラウザ専用の狭い閉じ込めの中で立てたブラウザサーバー)があれば、そこへ connect できるかを確かめる。無ければ Chrome を 1 回起動して閉じる。
 */
async function browserCheck(env: NodeJS.ProcessEnv): Promise<string | null> {
  try {
    const { chromium } = await import("@playwright/test");
    const endpoint = env[E2E_WS_ENDPOINT_ENV];
    const browser = endpoint ? await chromium.connect(endpoint, { timeout: 60_000 }) : await chromium.launch({ channel: BROWSER_CHANNEL, headless: true, timeout: 60_000 });
    await browser.close();
    return null;
  } catch (e) {
    return (e instanceof Error ? e.message : String(e)).split("\n")[0] ?? "原因不明";
  }
}

/** 画面を作り直して、ブラウザの E2E(Playwright)を流す。終了コードを返す。 */
async function e2e(env: NodeJS.ProcessEnv): Promise<number> {
  const built = await runNode("node_modules/vite/bin/vite.js", ["build"], env);
  if (built !== 0 || interrupted) return built || 130;
  return runNode("node_modules/@playwright/test/cli.js", ["test"], { ...env, E2E_PORT: String(await freePort()) });
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

/** ブラウザの E2E の回を飛ばすスイッチ(1 のとき飛ばす)。 */
export const SKIP_E2E_ENV = "KURAMOTO_SKIP_E2E_TESTS";
/**
 * ブラウザを起動できないとき、既定は「画面の確かめはしていない」と大きく知らせて通す。1 にすると、起動できないことも失敗にする。
 * KURAMOTO_E2E_WS_ENDPOINT が渡されているとき(チームの CI)は、1 と同じ扱い: ブラウザに繋がらないことも失敗にする。
 */
export const REQUIRE_BROWSER_ENV = "KURAMOTO_E2E_REQUIRE_BROWSER";

export type Deps = {
  vitest: (args: string[], env: NodeJS.ProcessEnv) => Promise<number>;
  e2e: (env: NodeJS.ProcessEnv) => Promise<number>;
  /** ブラウザを起動できるか。できなければ理由、できれば null */
  browserCheck: (env: NodeJS.ProcessEnv) => Promise<string | null>;
  createDb: () => Promise<DisposableDb>;
  mysqlFiles: () => string[];
  log: (line: string) => void;
  interrupted: () => boolean;
};

const real: Deps = { vitest, e2e, browserCheck, createDb: () => createDisposableDb(), mysqlFiles: () => findMysqlTestFiles(), log: (l) => console.log(l), interrupted: () => interrupted };

/** SQLite の回と MySQL の回(使い捨ての database は、この関数の中で作って消す)。中断されたら null。 */
async function dbRounds(args: string[], env: NodeJS.ProcessEnv, d: Deps): Promise<{ sqlite: number; mysql: number } | "interrupted" | "no-db"> {
  const skip = env[SKIP_MYSQL_ENV] === "1";
  let db: DisposableDb | undefined;
  if (!skip) {
    // 先に確かめる(繋がらないのに SQLite の回だけ長く流さない)
    try {
      db = await d.createDb();
    } catch (e) {
      d.log(`\n✗ ${e instanceof Error ? e.message : String(e)}\n`);
      return "no-db";
    }
  }
  try {
    d.log("\n=== SQLite の回 ===");
    const sqlite = await d.vitest(args, { ...env, [TEST_DB_ENV]: "sqlite" });
    let mysql = 0;
    if (d.interrupted()) {
      d.log("\n中断しました。MySQL の回は流さず、使い捨ての database を消して終わります");
      return "interrupted";
    } else if (skip) {
      d.log(`\n=== MySQL の回: 飛ばしました(${SKIP_MYSQL_ENV}=1) ===`);
    } else {
      d.log(`\n=== MySQL の回(mysql-test の使い捨ての database ${db!.name}) ===`);
      const { files, flags } = splitArgs(args);
      mysql = await d.vitest(["--passWithNoTests", ...flags, ...(files.length ? files : d.mysqlFiles())], { ...env, [TEST_DB_ENV]: "mysql", KURAMOTO_MYSQL_TEST_URL: db!.url });
      if (d.interrupted()) return "interrupted";
    }
    return { sqlite, mysql };
  } finally {
    await db?.drop().catch((e: unknown) => d.log(`使い捨ての database ${db!.name} を消せませんでした: ${e instanceof Error ? e.message : String(e)}`));
  }
}

/**
 * E2E の回。長く(十数分)かかることがあるので、MySQL の使い捨ての database を消したあとに流す。
 * 返すのは落ちたか。ブラウザを起動できないときは、画面が壊れたのではないので、既定では失敗にしない(大きく知らせて通す)。
 */
async function e2eRound(args: string[], env: NodeJS.ProcessEnv, d: Deps): Promise<"ok" | "failed" | "interrupted"> {
  if (env[SKIP_E2E_ENV] === "1") {
    d.log(`\n=== E2E の回: 飛ばしました(${SKIP_E2E_ENV}=1) ===`);
    return "ok";
  }
  if (splitArgs(args).files.length > 0) {
    d.log("\n=== E2E の回: 飛ばしました(試験のファイルを絞って流しているため) ===");
    return "ok";
  }
  d.log("\n=== E2E の回(ブラウザで主な操作を通す。Google Chrome が要ります) ===");
  const why = await d.browserCheck(env);
  if (d.interrupted()) return "interrupted";
  if (why) {
    if (env[REQUIRE_BROWSER_ENV] === "1" || env[E2E_WS_ENDPOINT_ENV]) {
      d.log(`\n✗ ブラウザに繋がりません(画面が壊れたのではありません): ${why}\n  ${env[E2E_WS_ENDPOINT_ENV] ? `${E2E_WS_ENDPOINT_ENV} が渡されている(チームの CI)` : `${REQUIRE_BROWSER_ENV}=1`}ので、失敗にします。`);
      return "failed";
    }
    d.log(
      `\n⚠ E2E の回: ブラウザを起動できなかったので、画面の確かめは流していません(画面が壊れたのではありません)。\n  理由: ${why}\n` +
        `  閉じ込めの中など、Chrome が動かない環境です。画面の確かめは、Chrome が動く場所で npm run test:e2e を流してください(docs/e2e.md)。\n  起動できないことも失敗にするには ${REQUIRE_BROWSER_ENV}=1。`,
    );
    return "ok";
  }
  const code = await d.e2e(env);
  if (d.interrupted()) return "interrupted";
  if (code !== 0) d.log("E2E の回が落ちました。ブラウザは起動できたので、画面の壊れです。test-results/ に落ちた画面と手順が残ります(docs/e2e.md)");
  return code === 0 ? "ok" : "failed";
}

export async function main(args: string[], env: NodeJS.ProcessEnv = process.env, d: Deps = real): Promise<number> {
  const rounds = await dbRounds(args, env, d);
  if (rounds === "no-db") return 1;
  if (rounds === "interrupted") return 130;
  const e2e = await e2eRound(args, env, d);
  if (e2e === "interrupted") return 130;
  const failed = [rounds.sqlite !== 0 && "SQLite", rounds.mysql !== 0 && "MySQL", e2e === "failed" && "E2E"].filter(Boolean);
  if (failed.length > 0) d.log(`\n✗ 落ちた回: ${failed.join("・")}`);
  return failed.length > 0 ? 1 : 0;
}

if (isMainModule(import.meta.url, process.argv[1])) {
  trapSignals();
  void main(process.argv.slice(2)).then((code) => process.exit(code));
}
