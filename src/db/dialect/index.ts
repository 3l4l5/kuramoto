import { mysqlDialect } from "./mysql.js";
import { sqliteDialect } from "./sqlite.js";

export type { DialectHelpers } from "./types.js";
export { mysqlDialect, sqliteDialect };

/** 接続に方言を決められない書き方(まだ Conn を通らない SQLite 専用のコード)が使う既定の方言。Conn を通るコードは conn.dialect を使う。 */
export const dialect = sqliteDialect;
