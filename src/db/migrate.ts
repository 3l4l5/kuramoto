import type { DatabaseSync } from "node:sqlite";
import type { Compilable, Kysely, RawBuilder } from "kysely";
import { createKysely, toSqliteParams } from "./kysely.js";
import { tx } from "./tx.js";

/**
 * マイグレーション 1 件。配列の位置 + 1 が版(PRAGMA user_version)になる。
 *  - 文字列: SQL をそのまま流す(複数の文を書いてよい)。これまでの版はすべてこの形。
 *  - 関数: Kysely のスキーマビルダ(または DML のビルダ)で書く。流す文を作って返す(実行は実行器がする)。
 *      (db) => [db.schema.createTable("x").addColumn("id", "integer", (c) => c.primaryKey()), db.schema.createIndex(...).on("x").column("id")]
 *    返したビルダを順に流す。同期のまま使えるよう、関数の中では execute() を呼ばず、ビルダを返すだけにする。
 */
export type Migration = string | MigrationFn;
/** 流す 1 文。スキーマビルダ・DML のビルダ・sql`...` のどれでもよい。 */
export type Statement = Compilable | RawBuilder<unknown>;
export type MigrationFn = (db: Kysely<any>) => Statement | Statement[];

/**
 * 版(PRAGMA user_version)より後のマイグレーションを順に流す。1 件ごとに 1 つのトランザクションで、版の更新まで含める。
 * Kysely の Migrator は使わない(版の置き場所を user_version のまま、同期で動かすため)。
 */
export function migrate(db: DatabaseSync, migrations: Migration[]): void {
  const current = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  const kysely = migrations.slice(current).some((m) => typeof m === "function") ? createKysely<any>(db) : undefined;
  for (let v = current; v < migrations.length; v++) {
    const m = migrations[v]!;
    tx(db, () => {
      if (typeof m === "string") db.exec(m);
      else for (const q of [m(kysely!)].flat()) runStatement(db, kysely!, q);
      db.exec(`PRAGMA user_version = ${v + 1}`);
    });
  }
}

function runStatement(db: DatabaseSync, kysely: Kysely<any>, q: Statement): void {
  // sql`...` は文を作るのに Kysely が要る。ビルダは引数を使わない。
  const { sql, parameters } = (q as RawBuilder<unknown>).compile(kysely);
  db.prepare(sql).run(...toSqliteParams(parameters));
}
