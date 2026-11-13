import type { Connection } from "mysql2/promise";
import type { MysqlMigration } from "./mysql-schema.js";

const LOCK = "kuramoto_migrate";
const LOCK_WAIT_SEC = 30;

/**
 * MySQL のマイグレーションの実行器。版は schema_version 表に持つ(SQLite の PRAGMA user_version に当たる)。
 *  - schema_version にある最大の版より後の版だけを、番号の順に流す。流し終えた版は 1 行を足す。
 *  - 流している間は GET_LOCK で他の実行器を待たせる(同時に 2 つの Kuramoto が起動しても、同じ版を二重に流さない)。
 *  - MySQL の DDL は巻き戻せない。版の途中で失敗したら版の行は足さないので、次に流すと最初からやり直す(だから版の中は何度流しても同じになるように書く)。
 * 接続は呼び出し側が開き、閉じる。
 */
export async function migrateMysql(conn: Connection, migrations: MysqlMigration[]): Promise<void> {
  for (let i = 1; i < migrations.length; i++) {
    if (migrations[i]!.version <= migrations[i - 1]!.version) throw new Error("マイグレーションの版は、番号の昇順に並べてください");
  }
  const [rows] = await conn.query<any[]>("SELECT GET_LOCK(?, ?) AS got", [LOCK, LOCK_WAIT_SEC]);
  if (rows[0]?.got !== 1) throw new Error("マイグレーションのロックを取れませんでした(別のプロセスが流している)");
  try {
    await conn.query(
      "CREATE TABLE IF NOT EXISTS schema_version (version INT NOT NULL PRIMARY KEY, applied_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin",
    );
    const current = await mysqlVersion(conn);
    for (const m of migrations) {
      if (m.version <= current) continue;
      for (const statement of m.statements) await conn.query(statement);
      await conn.query("INSERT INTO schema_version (version) VALUES (?)", [m.version]);
    }
  } finally {
    await conn.query("SELECT RELEASE_LOCK(?)", [LOCK]);
  }
}

/** いまの版(schema_version にある最大の版。表が無い・空なら 0) */
export async function mysqlVersion(conn: Connection): Promise<number> {
  const [exists] = await conn.query<any[]>("SELECT 1 AS x FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'schema_version'");
  if (exists.length === 0) return 0;
  const [rows] = await conn.query<any[]>("SELECT COALESCE(MAX(version), 0) AS v FROM schema_version");
  return Number(rows[0]?.v ?? 0);
}
