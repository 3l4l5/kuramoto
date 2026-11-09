import { all, get, type Params } from "../db/sqlite.js";
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
export function metrics(p: Project, filter: { formationId?: number } = {}): Metrics {
  const where = filter.formationId ? "AND r.formation_id = :f" : "";
  const params: Params = filter.formationId ? { f: filter.formationId } : {};
  const completed = all<{ id: number; created_at: string; done_at: string; active_ms: number; rounds: number }>(
    p.db,
    `SELECT t.id, t.created_at, t.done_at, t.active_ms, t.rounds FROM tickets t
     WHERE t.done_at IS NOT NULL ${filter.formationId ? "AND EXISTS (SELECT 1 FROM runs r WHERE r.ticket_id = t.id " + where + ")" : ""}`,
    params,
  );
  const n = completed.length;
  const usage = get<{ tokens: number | null; cost: number | null }>(
    p.db,
    `SELECT SUM(COALESCE(input_tokens,0) + COALESCE(output_tokens,0) + COALESCE(cache_read_tokens,0)) AS tokens, SUM(cost_usd) AS cost FROM runs r WHERE 1=1 ${where}`,
    params,
  );
  const decisions = get<{ n: number }>(p.db, "SELECT COUNT(*) AS n FROM decisions WHERE escalated = 1")?.n ?? 0;
  const lead = completed.reduce((s, t) => s + (Date.parse(t.done_at) - Date.parse(t.created_at)), 0);
  const active = completed.reduce((s, t) => s + t.active_ms, 0);
  const waiting = all<{ stage: string; n: number }>(
    p.db,
    "SELECT to_role AS stage, COUNT(*) AS n FROM messages WHERE status = 'pending' GROUP BY to_role ORDER BY n DESC LIMIT 1",
  )[0];

  return {
    completed: n,
    tokensPerCompleted: n ? (usage?.tokens ?? 0) / n : null,
    costPerCompletedUsd: n ? (usage?.cost ?? 0) / n : null,
    decisionsPerCompleted: n ? decisions / n : null,
    flowEfficiency: lead > 0 ? active / lead : null,
    avgLeadTimeMs: n ? lead / n : null,
    avgReviewRounds: n ? completed.reduce((s, t) => s + t.rounds, 0) / n : null,
    recurred: get<{ n: number }>(p.db, "SELECT COUNT(*) AS n FROM findings WHERE status = 'recurred'")?.n ?? 0,
    conflicts: get<{ n: number }>(p.db, "SELECT COUNT(*) AS n FROM conflicts")?.n ?? 0,
    bottleneck: waiting && waiting.n >= 3 ? { stage: waiting.stage, waiting: waiting.n } : null,
  };
}
