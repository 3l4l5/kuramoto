import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { KuramotoConfig } from "../config.js";
import { kuramotoHome } from "../hq.js";
import { connectMysql, DatabaseConnectError, type MysqlHandle } from "./mysql.js";
import { DbHealth } from "./mysql-health.js";

/** 初めて MySQL に繋いだとき、SQLite にプロジェクトが残っていれば出す 1 行。 */
export const SQLITE_NOT_MIGRATED = "SQLite のプロジェクトは MySQL には移りません。企画は設計書(書き出し)で移せます";

/** 本部の SQLite(hq.sqlite)にプロジェクトが 1 つでも残っているか。開かず・変えず、読むだけ。 */
export function sqliteHasProjects(home: string = kuramotoHome()): boolean {
  const path = join(home, "hq.sqlite");
  if (!existsSync(path)) return false;
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    return db.prepare("SELECT 1 FROM projects LIMIT 1").get() !== undefined;
  } catch {
    return false;
  } finally {
    db?.close();
  }
}

export type StartedDatabase = { mysql?: MysqlHandle; health?: DbHealth; close(): Promise<void> };

/**
 * 起動時に DB を用意する。SQLite は何もしない(従来どおり Hq が開く)。
 * MySQL は繋いで版を最新にし、見張り(DbHealth)を付ける。届かなければ DatabaseConnectError(理由つき)を投げる。起動しない。
 */
export async function startDatabase(
  c: KuramotoConfig,
  log: (line: string) => void = console.log,
  home: string = kuramotoHome(),
): Promise<StartedDatabase> {
  if (c.database.type !== "mysql") return { async close() {} };
  const { handle, firstConnection, version } = await connectMysql({ url: c.database.url, ...(c.database.tls ? { tls: c.database.tls } : {}) });
  log(`MySQL に繋ぎました(スキーマの版 ${version})`);
  if (firstConnection && sqliteHasProjects(home)) log(SQLITE_NOT_MIGRATED);
  const health = new DbHealth(() => handle.ping());
  return {
    mysql: handle,
    health,
    async close() {
      health.stop();
      await handle.close();
    },
  };
}

/** 起動の入口が使う。DatabaseConnectError は理由を出して終わる(スタックは出さない)。 */
export async function startDatabaseOrExit(c: KuramotoConfig, log: (line: string) => void = console.error): Promise<StartedDatabase> {
  try {
    return await startDatabase(c, log);
  } catch (e) {
    if (!(e instanceof DatabaseConnectError)) throw e;
    console.error(`${e.message}\n起動しません(SQLite には黙って戻しません)。`);
    process.exit(1);
  }
}
