import { sql, type Expression, type InsertQueryBuilder, type Kysely, type Transaction } from "kysely";
import type { DialectHelpers } from "./types.js";

/** 受信箱の取り出しで、1 回に読む候補の数(先頭から。ほかの取り出しがロックしている行を飛ばして進むため、1 より多く読む) */
const CANDIDATES_AT_ONCE = 16;

/**
 * MySQL の方言(docs/mysql.md・ADR-0041)。
 *  - 挿入した id は insertId(RETURNING が無い)。
 *  - 受信箱の取り出しは、トランザクション(専用の接続)の中で、候補を読む(ロックなし)→ 取ろうとする 1 行を SELECT ... FOR UPDATE SKIP LOCKED → UPDATE。
 *  - 部分索引は無い(生成列で書く。mysql-schema.ts の one_run_per_ticket)。
 */
export const mysqlDialect: DialectHelpers = {
  name: "mysql",

  jsonExtract<T>(column: Expression<unknown> | string, path: string) {
    const col = typeof column === "string" ? sql.ref(column) : column;
    const at = `$.${path}`;
    // JSON の true / false は SQLite の json_extract と同じく 1 / 0 に、文字列は引用符を外し、数値はそのまま返す
    return sql<T>`(CASE JSON_TYPE(JSON_EXTRACT(${col}, ${at})) WHEN 'BOOLEAN' THEN IF(JSON_EXTRACT(${col}, ${at}) = CAST('true' AS JSON), 1, 0) WHEN 'NULL' THEN NULL ELSE JSON_UNQUOTE(JSON_EXTRACT(${col}, ${at})) END)`;
  },

  upsert<DB, TB extends keyof DB, O>(query: InsertQueryBuilder<DB, TB, O>, _conflictColumns: string[], updateColumns: string[]) {
    // MySQL は衝突の列を指定せず、主キー・UNIQUE のどれに当たっても更新する
    return (query as any).onDuplicateKeyUpdate((eb: any) => Object.fromEntries(updateColumns.map((c) => [c, eb.fn("values", [eb.ref(c)])])));
  },

  async insertedId(query) {
    const r = await query.executeTakeFirstOrThrow();
    if (r.insertId === undefined) throw new Error("挿入した行の id(insertId)が返りませんでした");
    return Number(r.insertId);
  },

  async claimMessage(db, candidate, claimedAt) {
    const take = async (trx: Transaction<any>): Promise<Record<string, unknown> | undefined> => {
      // 候補の並びは、ロックを掛けずに読む。ORDER BY のある SELECT ... FOR UPDATE は、読んだ行を全部ロックしてから並べ替えるので、
      // 同時に取り出すと、先の 1 人が候補を全部ロックして、あとの人は SKIP LOCKED で 1 通も取れなくなる。
      // そこで、ロックは「取ろうとする 1 行」だけに掛け、ほかの取り出しがロックしている行は飛ばして次の候補へ進む。
      // candidate は呼び出し側の接続で作られているので、文だけを取り出して、このトランザクションの接続で流す
      // (project_id も選ぶ。ロックと UPDATE をそのプロジェクトの行に絞るため)
      const tried: number[] = [];
      for (;;) {
        let next = (candidate as any).select("m.project_id").clearLimit().limit(CANDIDATES_AT_ONCE);
        if (tried.length) next = next.where("m.id", "not in", tried);
        const found = (await trx.executeQuery<{ id: number; project_id: number }>(next.compile())).rows;
        if (found.length === 0) return undefined;
        for (const { id, project_id } of found) {
          tried.push(Number(id));
          // 条件に status = 'pending' も入れる(候補を読んでからロックするまでに、ほかに取られた行は飛ばす)
          const picked = (await trx.selectFrom("messages").select(["id", "project_id"]).where("id", "=", id).where("project_id", "=", project_id).where("status", "=", "pending").forUpdate().skipLocked().executeTakeFirst()) as
            | { id: number; project_id: number }
            | undefined;
          if (!picked) continue;
          const r = await trx
            .updateTable("messages")
            .set({ status: "claimed", claimed_at: claimedAt, attempts: sql`attempts + 1` })
            .where("id", "=", picked.id)
            .where("project_id", "=", picked.project_id)
            .where("status", "=", "pending")
            .executeTakeFirst();
          if (Number(r.numUpdatedRows) !== 1) return undefined;
          return (await trx.selectFrom("messages").selectAll().where("id", "=", picked.id).where("project_id", "=", picked.project_id).executeTakeFirst()) as Record<string, unknown> | undefined;
        }
        if (found.length < CANDIDATES_AT_ONCE) return undefined;
      }
    };
    // すでにトランザクションの中ならその上で(外側にまとめる)。そうでなければ専用の接続でトランザクションを張る
    return db.isTransaction ? take(db as unknown as Transaction<any>) : (db as Kysely<any>).transaction().execute(take);
  },

  idColumn: (column) => column.autoIncrement().primaryKey(),
  indexableText: "varchar(191)",

  createPartialIndex() {
    throw new Error("MySQL には部分索引がありません(生成列と UNIQUE で書いてください)");
  },
};
