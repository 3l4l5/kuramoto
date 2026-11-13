import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { Kysely, SqliteDialect, type KyselyPlugin, type SqliteDatabase, type SqliteStatement } from "kysely";

/**
 * Kysely の SqliteDialect に node:sqlite(DatabaseSync)を渡すための薄いドライバ。
 * Kysely の SqliteDialect は better-sqlite3 の形を想定しているので、違うところだけここで合わせる。
 *  - 文が行を返すか(reader)は、node:sqlite では columns() が空かどうかで分かる。
 *  - 引数は配列で渡ってくる(node:sqlite は可変長引数)。
 *  - 真偽値と undefined は node:sqlite が受け付けないので、1 / 0 と null にする。
 *  - Kysely が張る "begin" は "begin immediate" にする(書き込みのロックを最初に取る。tx() と同じ)。
 *  - close() は何もしない。DatabaseSync を開いた側が閉じる(同じ接続を Kysely でない書き方と共有するため)。
 */
export function toSqliteParams(parameters: ReadonlyArray<unknown>): SQLInputValue[] {
  return parameters.map((v) => {
    if (typeof v === "boolean") return v ? 1 : 0;
    if (v === undefined) return null;
    return v as SQLInputValue;
  });
}

export function sqliteDatabase(db: DatabaseSync): SqliteDatabase {
  return {
    close() {},
    prepare(sql: string): SqliteStatement {
      const stmt = db.prepare(/^\s*begin\s*;?\s*$/i.test(sql) ? "BEGIN IMMEDIATE" : sql);
      return {
        reader: stmt.columns().length > 0,
        all: (parameters) => stmt.all(...toSqliteParams(parameters)),
        run: (parameters) => stmt.run(...toSqliteParams(parameters)),
        iterate: (parameters) => stmt.iterate(...toSqliteParams(parameters)),
      };
    },
  };
}

/** 開いてある DatabaseSync の上に Kysely を作る。接続は共有し、閉じるのは DatabaseSync の持ち主。 */
export function createKysely<DB>(db: DatabaseSync, plugins: KyselyPlugin[] = []): Kysely<DB> {
  return new Kysely<DB>({ dialect: new SqliteDialect({ database: sqliteDatabase(db) }), plugins });
}
