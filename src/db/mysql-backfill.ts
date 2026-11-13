import type { Connection } from "mysql2/promise";
import { DEV_DONE_STAGES } from "../domain/dev-done.js";

/**
 * SQLite・書き出しから MySQL へ移したあとに、既存のチケットの dev_done を埋める。
 * SQLite のプロジェクトの版 19 と同じ決まり(src/domain/dev-done.ts): 工程が review/sec/qa/decision/merge/done のどれか、
 * または開発(role = 'dev')の起動があれば 1 にする。0 にはしない(すでに 1 のものは触らない)。
 * 移す道具は、tickets と runs を入れ終えてから呼ぶ(runs が無いと、開発の起動が見えない)。何度呼んでも結果は同じ。
 * projectId を渡すと、そのプロジェクトのチケットだけを埋める。返すのは 0 から 1 にした件数。
 */
export async function backfillDevDone(conn: Connection, projectId?: number): Promise<number> {
  const stages = DEV_DONE_STAGES.map((s) => `'${s}'`).join(",");
  const [res] = await conn.query<any>(
    `UPDATE tickets SET dev_done = 1
       WHERE dev_done = 0
         AND (stage IN (${stages}) OR EXISTS (SELECT 1 FROM runs r WHERE r.ticket_id = tickets.id AND r.role = 'dev'))
         ${projectId === undefined ? "" : "AND project_id = ?"}`,
    projectId === undefined ? [] : [projectId],
  );
  return Number(res.affectedRows);
}
