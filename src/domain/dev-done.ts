/**
 * 既存のチケットの dev_done(開発を一度でも通ったか)を埋める決まり。
 * SQLite のプロジェクトの版 19 の `UPDATE tickets SET dev_done = 1 WHERE stage IN (...) OR 開発の起動がある` と同じ。
 * 版 19 は過去の版なので書き換えない。SQLite・書き出しから MySQL へ移すとき(src/db/mysql-backfill.ts・src/project/transfer.ts)が、ここを使う。
 */
export const DEV_DONE_STAGES = ["review", "sec", "qa", "decision", "merge", "done"] as const;

/** 開発より後の工程にいるか、開発の起動があれば、開発を通ったものとする。取りやめ(dropped)は工程だけでは決めない。 */
export function inferDevDone(stage: string, hasDevRun: boolean): boolean {
  return hasDevRun || (DEV_DONE_STAGES as readonly string[]).includes(stage);
}
