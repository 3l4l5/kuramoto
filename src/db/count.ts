import { sql, type Selectable, type SelectQueryBuilder } from "kysely";
import type { ProjectDb } from "./conn.js";
import type { ProjectDatabase } from "./tables.js";

/** 表の行のうち、このプロジェクトのもの(project_id = 自分の id)を選ぶ(全部の列)。ProjectDb.from の読む用。 */
export function inScope<T extends keyof ProjectDatabase & string>(db: ProjectDb, table: T): SelectQueryBuilder<ProjectDatabase, T, Selectable<ProjectDatabase[T]>> {
  return (db.k as any).selectFrom(table).selectAll().where(`${table}.project_id`, "=", db.projectId) as never;
}

/** プロジェクトの表の行を数える 1 文。`.where(...)` を足してから countOf() で数を取る。 */
export function countFrom(db: ProjectDb, table: keyof ProjectDatabase & string) {
  return (db.k as any).selectFrom(table).select(sql<number>`COUNT(*)`.as("n")).where(`${table}.project_id`, "=", db.projectId);
}

/** 数えた結果を number にする。 */
export async function countOf(q: { executeTakeFirst(): Promise<unknown> }): Promise<number> {
  return Number(((await q.executeTakeFirst()) as { n: number } | undefined)?.n ?? 0);
}
