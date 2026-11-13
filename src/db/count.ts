import { sql, type Selectable, type SelectQueryBuilder } from "kysely";
import type { ProjectDb } from "./conn.js";
import type { ProjectDatabase } from "./tables.js";

/**
 * 読むときの project_id の範囲。自分のプロジェクトの id と、0。
 * まだ同期の書き方(project_id を書かない INSERT。Project 本体・workflow など)で入った行は、次に開くときに埋まるまで 0 のまま(ADR-0040)。
 * 開いている間に画面が見る行は、その 0 を含めないと欠ける。同期の書き込みが無くなったら(#45)、= の 1 つに戻す。
 */
export const scopeIds = (db: ProjectDb): number[] => (db.projectId === 0 ? [0] : [db.projectId, 0]);

/** 表の行のうち、このプロジェクトのもの(まだ 0 のままの行を含む)を選ぶ(全部の列)。ProjectDb.from の読む用。 */
export function inScope<T extends keyof ProjectDatabase & string>(db: ProjectDb, table: T): SelectQueryBuilder<ProjectDatabase, T, Selectable<ProjectDatabase[T]>> {
  return (db.k as any).selectFrom(table).selectAll().where(`${table}.project_id`, "in", scopeIds(db)) as never;
}

/** プロジェクトの表の行を数える 1 文。`.where(...)` を足してから countOf() で数を取る。 */
export function countFrom(db: ProjectDb, table: keyof ProjectDatabase & string) {
  return (db.k as any).selectFrom(table).select(sql<number>`COUNT(*)`.as("n")).where(`${table}.project_id`, "in", scopeIds(db));
}

/** 数えた結果を number にする。 */
export async function countOf(q: { executeTakeFirst(): Promise<unknown> }): Promise<number> {
  return Number(((await q.executeTakeFirst()) as { n: number } | undefined)?.n ?? 0);
}
