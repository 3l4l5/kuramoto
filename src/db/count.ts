import { sql } from "kysely";
import type { ProjectDb } from "./conn.js";
import type { ProjectDatabase } from "./tables.js";

/** プロジェクトの表の行を数える 1 文。`.where(...)` を足してから executeTakeFirst() で { n } を取る(project_id は入っている)。 */
export function countFrom(db: ProjectDb, table: keyof ProjectDatabase & string) {
  const k = db.k as any;
  return k.selectFrom(table).select(sql<number>`COUNT(*)`.as("n")).where(`${table}.project_id`, "=", db.projectId);
}

/** 数えた結果を number にする。 */
export async function countOf(q: { executeTakeFirst(): Promise<unknown> }): Promise<number> {
  return Number(((await q.executeTakeFirst()) as { n: number } | undefined)?.n ?? 0);
}
