import { randomBytes } from "node:crypto";
import { createConnection, type Connection } from "mysql2/promise";

/**
 * 空の MySQL(compose.yaml の mysql-test。127.0.0.1:3307)を使う試験の共通の部品。
 *
 * npm test(scripts/run-tests.ts)は、SQLite の回と MySQL の回を 1 回ずつ流す。どちらの回かは KURAMOTO_TEST_DB で試験に伝える。
 * - `sqlite`: SQLite の回。mysql-test を使う試験は飛ばす
 * - `mysql`: MySQL の回。mysql-test に繋がらなければ、飛ばさずに落とす
 * - 未設定(vitest を直に動かしたとき): 繋がれば流し、繋がらなければ飛ばす
 * 接続先は KURAMOTO_MYSQL_TEST_URL で変えられる。MySQL の回では、npm test が回ごとの使い捨ての database を作ってここに入れる。
 */
export const MYSQL_TEST_URL = process.env.KURAMOTO_MYSQL_TEST_URL ?? "mysql://kuramoto_test:kuramoto-test@127.0.0.1:3307/kuramoto_test";

/** どちらの回か。試験の側へ環境変数で伝える。 */
export const TEST_DB_ENV = "KURAMOTO_TEST_DB";
/** 立てて持っていることを明示して、MySQL の回を飛ばすスイッチ(1 のとき飛ばす)。 */
export const SKIP_MYSQL_ENV = "KURAMOTO_SKIP_MYSQL_TESTS";
/** database を作って消せる管理用の接続先(既定は mysql-test の root。テスト専用のパスワード)。 */
export const ADMIN_URL_ENV = "KURAMOTO_MYSQL_TEST_ADMIN_URL";

export type TestDbMode = "sqlite" | "mysql" | "auto";

export function testDbMode(env: NodeJS.ProcessEnv = process.env): TestDbMode {
  const v = env[TEST_DB_ENV];
  return v === "sqlite" || v === "mysql" ? v : "auto";
}

/** mysql-test に繋がらなかったときの案内。黙って飛ばさずに、これを出して落とす。 */
export const MYSQL_TEST_MISSING =
  "mysql-test(127.0.0.1:3307)に繋がりません。`docker compose up -d mysql-test` が要ります" +
  `(閉じ込めの中なら、プロジェクトの設定 sandbox_strict_sockets が 1 だと 127.0.0.1 にも届きません)。` +
  `MySQL の回を飛ばすと決めているときだけ、${SKIP_MYSQL_ENV}=1 を付けてください。`;

/**
 * 繋がれば接続を返す。繋がらないとき、MySQL の回なら投げて落とし、SQLite の回と未設定なら undefined(試験は飛ばす)。
 * 試験のファイルは並列に動き、どれも database の中を作り直すので、この接続が生きている間は名前つきのロックを持ち、
 * ほかのファイルを待たせる(接続を閉じると外れる)。ロックの名前は database ごと(回ごとの database は互いに待たない)。
 */
export async function connectTest(): Promise<Connection | undefined> {
  const mode = testDbMode();
  if (mode === "sqlite") return undefined;
  let conn: Connection;
  try {
    conn = await createConnection({ uri: MYSQL_TEST_URL, connectTimeout: 2000 });
  } catch (e) {
    if (mode === "mysql") throw new Error(`${MYSQL_TEST_MISSING}(${e instanceof Error ? e.message : String(e)})`);
    return undefined;
  }
  await conn.query("SELECT GET_LOCK(?, 600)", [`kuramoto_mysql_test:${new URL(MYSQL_TEST_URL).pathname}`]);
  return conn;
}

/** database の中を空にする(外部キーを外してから全部の表を消す) */
export async function resetDatabase(c: Connection): Promise<void> {
  const [rows] = await c.query<any[]>("SELECT table_name AS n FROM information_schema.tables WHERE table_schema = DATABASE()");
  await c.query("SET FOREIGN_KEY_CHECKS = 0");
  for (const r of rows) await c.query(`DROP TABLE IF EXISTS \`${r.n}\``);
  await c.query("SET FOREIGN_KEY_CHECKS = 1");
}

/** 回ごとの使い捨ての database の名前。複数の worktree・複数の回が同時に動いても重ならない。 */
export function disposableDbName(): string {
  return `kuramoto_test_${Date.now().toString(36)}_${randomBytes(4).toString("hex")}`;
}

/** 管理用の接続先。KURAMOTO_MYSQL_TEST_ADMIN_URL が無ければ、試験の接続先と同じ host:port の root(テスト専用のパスワード)。 */
export function adminUrl(testUrl: string, env: NodeJS.ProcessEnv = process.env): string {
  if (env[ADMIN_URL_ENV]) return env[ADMIN_URL_ENV]!;
  const u = new URL(testUrl);
  return `mysql://root:kuramoto-test-root@${u.host}`;
}

/** 試験の接続先の database 名だけを差し替えた URL。 */
export function withDatabase(testUrl: string, name: string): string {
  const u = new URL(testUrl);
  u.pathname = `/${name}`;
  return u.toString();
}

export type DisposableDb = { name: string; url: string; drop(): Promise<void> };

/**
 * 使い捨ての database を作り、試験のユーザーに全権限を渡す(そのユーザーはほかの database には触れない)。
 * 繋がらなければ投げる(MYSQL_TEST_MISSING つき)。drop() で消す(何度呼んでもよい)。
 */
export async function createDisposableDb(testUrl: string = MYSQL_TEST_URL, env: NodeJS.ProcessEnv = process.env): Promise<DisposableDb> {
  const name = disposableDbName();
  let admin: Connection;
  try {
    admin = await createConnection({ uri: adminUrl(testUrl, env), connectTimeout: 3000 });
  } catch (e) {
    throw new Error(`${MYSQL_TEST_MISSING}(${e instanceof Error ? e.message : String(e)})`);
  }
  const user = decodeURIComponent(new URL(testUrl).username);
  try {
    await admin.query(`CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`);
    await admin.query(`GRANT ALL PRIVILEGES ON \`${name}\`.* TO ?@'%'`, [user]);
  } catch (e) {
    await admin.query(`DROP DATABASE IF EXISTS \`${name}\``).catch(() => undefined);
    await admin.end().catch(() => undefined);
    throw e;
  }
  let dropped = false;
  return {
    name,
    url: withDatabase(testUrl, name),
    async drop() {
      if (dropped) return;
      dropped = true;
      try {
        await admin.query(`DROP DATABASE IF EXISTS \`${name}\``);
      } finally {
        await admin.end().catch(() => undefined);
      }
    },
  };
}
