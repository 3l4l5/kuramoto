import { createConnection, type Connection } from "mysql2/promise";

/**
 * 空の MySQL(compose.yaml の mysql-test。127.0.0.1:3307)を使う試験の共通の部品。
 * 接続先は KURAMOTO_MYSQL_TEST_URL で変えられる。繋がらないときは、試験は飛ばす(docker compose up -d mysql-test で立てる)。
 */
export const MYSQL_TEST_URL = process.env.KURAMOTO_MYSQL_TEST_URL ?? "mysql://kuramoto_test:kuramoto-test@127.0.0.1:3307/kuramoto_test";

const LOCK = "kuramoto_mysql_test";

/**
 * 繋がれば接続を返す(繋がらなければ undefined)。試験のファイルは並列に動き、どれも database の中を作り直すので、
 * この接続が生きている間は名前つきのロックを持ち、ほかのファイルを待たせる(接続を閉じると外れる)。
 */
export async function connectTest(): Promise<Connection | undefined> {
  let conn: Connection;
  try {
    conn = await createConnection({ uri: MYSQL_TEST_URL, connectTimeout: 2000 });
  } catch {
    return undefined;
  }
  await conn.query("SELECT GET_LOCK(?, 600)", [LOCK]);
  return conn;
}

/** database の中を空にする(外部キーを外してから全部の表を消す) */
export async function resetDatabase(c: Connection): Promise<void> {
  const [rows] = await c.query<any[]>("SELECT table_name AS n FROM information_schema.tables WHERE table_schema = DATABASE()");
  await c.query("SET FOREIGN_KEY_CHECKS = 0");
  for (const r of rows) await c.query(`DROP TABLE IF EXISTS \`${r.n}\``);
  await c.query("SET FOREIGN_KEY_CHECKS = 1");
}
