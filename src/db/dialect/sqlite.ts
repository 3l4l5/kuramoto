import { sql, type CreateIndexBuilder, type Expression, type InsertQueryBuilder } from "kysely";
import type { DialectHelpers } from "./types.js";

export const sqliteDialect: DialectHelpers = {
  name: "sqlite",

  jsonExtract<T>(column: Expression<unknown> | string, path: string) {
    const col = typeof column === "string" ? sql.ref(column) : column;
    return sql<T>`json_extract(${col}, ${`$.${path}`})`;
  },

  upsert<DB, TB extends keyof DB, O>(query: InsertQueryBuilder<DB, TB, O>, conflictColumns: string[], updateColumns: string[]) {
    return query.onConflict((oc: any) =>
      oc.columns(conflictColumns).doUpdateSet((eb: any) => Object.fromEntries(updateColumns.map((c) => [c, eb.ref(`excluded.${c}`)]))),
    );
  },

  async insertedId(query) {
    const row = (await query.returning("id").executeTakeFirstOrThrow()) as { id: number | bigint };
    return Number(row.id);
  },

  async claimMessage(db, candidate, claimedAt) {
    const d = db as any;
    const row = await d
      .updateTable("messages")
      .set({ status: "claimed", claimed_at: claimedAt, attempts: sql`attempts + 1` })
      .where("id", "=", candidate)
      .returningAll()
      .executeTakeFirst();
    return row as Record<string, unknown> | undefined;
  },

  idColumn: (column) => column.primaryKey(),
  indexableText: "text",

  createPartialIndex(db, { name, table, columns, where, unique, ifNotExists }) {
    let b = unique ? db.schema.createIndex(name).unique() : db.schema.createIndex(name);
    if (ifNotExists) b = b.ifNotExists();
    return b.on(table).columns(columns).where(where) as CreateIndexBuilder<string>;
  },
};
