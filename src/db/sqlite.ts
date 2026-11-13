import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { migrate, type Migration, type MigrationContext } from "./migrate.js";

export type Db = DatabaseSync;
export type Params = Record<string, SQLInputValue> | SQLInputValue[];

export type { Migration, MigrationContext } from "./migrate.js";
export { tx } from "./tx.js";

export function openDb(path: string, migrations: Migration[], ctx: MigrationContext = {}): Db {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  migrate(db, migrations, ctx);
  return db;
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
