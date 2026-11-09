import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type Db = DatabaseSync;
export type Params = Record<string, SQLInputValue> | SQLInputValue[];

/** マイグレーション 1 件。配列の位置 + 1 が版(PRAGMA user_version)になる。 */
export type Migration = string;

export function openDb(path: string, migrations: Migration[]): Db {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  migrate(db, migrations);
  return db;
}

function migrate(db: Db, migrations: Migration[]): void {
  const current = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  for (let v = current; v < migrations.length; v++) {
    tx(db, () => {
      db.exec(migrations[v]!);
      db.exec(`PRAGMA user_version = ${v + 1}`);
    });
  }
}

/** 書き込みのトランザクション。入れ子にしたときは外側にまとめる。 */
export function tx<T>(db: Db, fn: () => T): T {
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

function bind(params?: Params): unknown[] {
  if (params === undefined) return [];
  return Array.isArray(params) ? params : [params];
}

export function all<T>(db: Db, sql: string, params?: Params): T[] {
  const stmt = db.prepare(sql);
  return stmt.all(...(bind(params) as [])) as T[];
}

export function get<T>(db: Db, sql: string, params?: Params): T | undefined {
  const stmt = db.prepare(sql);
  return stmt.get(...(bind(params) as [])) as T | undefined;
}

export function run(db: Db, sql: string, params?: Params): { changes: number; lastId: number } {
  const stmt = db.prepare(sql);
  const r = stmt.run(...(bind(params) as []));
  return { changes: Number(r.changes), lastId: Number(r.lastInsertRowid) };
}

export function isUniqueViolation(e: unknown): boolean {
  return e instanceof Error && /UNIQUE constraint failed/.test(e.message);
}
