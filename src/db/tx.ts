import type { DatabaseSync } from "node:sqlite";

/** 書き込みのトランザクション。入れ子にしたときは外側にまとめる。 */
export function tx<T>(db: DatabaseSync, fn: () => T): T {
  if (db.isTransaction) return fn();
  db.exec("BEGIN IMMEDIATE");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
