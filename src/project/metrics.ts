import { sql } from "kysely";
import { countFrom, countOf } from "../db/count.js";
import type { Project } from "./project.js";

export type Metrics = {
  completed: number;
  tokensPerCompleted: number | null;
  costPerCompletedUsd: number | null;
  decisionsPerCompleted: number | null;
  /** 完成したチケットの作業時間の合計 ÷ リードタイムの合計 */
  flowEfficiency: number | null;
  avgLeadTimeMs: number | null;
  avgReviewRounds: number | null;
  recurred: number;
  conflicts: number;
  /** 待ちがいちばん多い工程(3 件以上のとき) */
  bottleneck: { stage: string; waiting: number } | null;
};

/**
 * 8 章の指標。集計のための表は作らず、記録から毎回計算する(docs/design.md 9.2)。
 * formationId を渡すと、その編成の版で動いた起動だけで集計する。
 */
export async function metrics(p: Project, filter: { formationId?: number } = {}): Promise<Metrics> {
  const k = p.pdb.k;
  const fid = filter.formationId;
  let doneQ = p.pdb.from("tickets").select(["id", "created_at", "done_at", "active_ms", "rounds"]).where("done_at", "is not", null);
  if (fid) doneQ = doneQ.where((eb) => eb.exists(eb.selectFrom("runs as r").select("r.id").whereRef("r.ticket_id", "=", "tickets.id").where("r.project_id", "=", p.projectId).where("r.formation_id", "=", fid)));
  const completed = (await doneQ.execute()) as { id: number; created_at: string; done_at: string; active_ms: number; rounds: number }[];
  const n = completed.length;
  let usageQ = k
    .selectFrom("runs as r")
    .select([sql<number | null>`SUM(COALESCE(input_tokens,0) + COALESCE(output_tokens,0) + COALESCE(cache_read_tokens,0))`.as("tokens"), sql<number | null>`SUM(cost_usd)`.as("cost")])
    .where("r.project_id", "=", p.projectId);
  if (fid) usageQ = usageQ.where("r.formation_id", "=", fid);
  const [usage, decisions, waitingRows, recurred, conflictCount] = await Promise.all([
    usageQ.executeTakeFirst(),
    countOf(countFrom(p.pdb, "decisions").where("escalated", "=", 1)),
    k
      .selectFrom("messages")
      .select(["to_role as stage", sql<number>`COUNT(*)`.as("n")])
      .where("project_id", "=", p.projectId)
      .where("status", "=", "pending")
      .groupBy("to_role")
      .orderBy("n", "desc")
      .limit(1)
      .execute(),
    countOf(countFrom(p.pdb, "findings").where("status", "=", "recurred")),
    countOf(countFrom(p.pdb, "conflicts")),
  ]);
  const lead = completed.reduce((s, t) => s + (Date.parse(t.done_at) - Date.parse(t.created_at)), 0);
  const active = completed.reduce((s, t) => s + t.active_ms, 0);
  const waiting = waitingRows[0] ? { stage: waitingRows[0].stage as string, n: Number(waitingRows[0].n) } : undefined;

  return {
    completed: n,
    tokensPerCompleted: n ? (usage?.tokens ?? 0) / n : null,
    costPerCompletedUsd: n ? (usage?.cost ?? 0) / n : null,
    decisionsPerCompleted: n ? decisions / n : null,
    flowEfficiency: lead > 0 ? active / lead : null,
    avgLeadTimeMs: n ? lead / n : null,
    avgReviewRounds: n ? completed.reduce((s, t) => s + t.rounds, 0) / n : null,
    recurred: recurred,
    conflicts: conflictCount,
    bottleneck: waiting && waiting.n >= 3 ? { stage: waiting.stage, waiting: waiting.n } : null,
  };
}
