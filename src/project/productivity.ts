import { all, get } from "../db/sqlite.js";
import { MODELS, ROLE_LABEL, type Role } from "../domain/roles.js";
import type { Project } from "./project.js";

/**
 * 開発生産性の指標(docs/design.md 8 章)。集計のための表は作らず、記録(runs・events・decisions など)から毎回数える。
 * - トークン・金額は起動ごとの記録から(企画スタジオの担当の分も含む)
 * - PR・手戻り・助けを求めた数は、出来事の記録と判断カード・企画の未決から
 */

export type DayRow = { day: string; tokens: number; costUsd: number; prs: number; merged: number; rework: number; help: number; completed: number };

export function productivity(p: Project) {
  const one = (sql: string, params: unknown[] = []) => get<{ n: number | null }>(p.db, sql, params as never)?.n ?? 0;

  // ---- 合計 ----
  const usage = get<{ tokens: number | null; input: number | null; output: number | null; cache: number | null; cost: number | null; runs: number }>(
    p.db,
    `SELECT SUM(COALESCE(input_tokens,0) + COALESCE(output_tokens,0) + COALESCE(cache_read_tokens,0)) AS tokens,
            SUM(input_tokens) AS input, SUM(output_tokens) AS output, SUM(cache_read_tokens) AS cache,
            SUM(cost_usd) AS cost, COUNT(*) AS runs FROM runs WHERE ended_at IS NOT NULL`,
  );
  const planningCost = one("SELECT SUM(cost_usd) AS n FROM runs WHERE ticket_id IS NULL");
  const completed = one("SELECT COUNT(*) AS n FROM tickets WHERE done_at IS NOT NULL");
  const changes = one("SELECT COUNT(*) AS n FROM reviews WHERE verdict = 'changes'");
  const conflicts = one("SELECT COUNT(*) AS n FROM conflicts");
  const retries = one("SELECT COUNT(*) AS n FROM runs WHERE outcome = 'error'");
  const decisions = one("SELECT COUNT(*) AS n FROM decisions WHERE escalated = 1");
  const planAsks = one("SELECT COUNT(*) AS n FROM plan_open_items WHERE decided_by = 'owner' OR (answer IS NULL AND withdrawn IS NULL)");
  const totals = {
    tokens: usage?.tokens ?? 0,
    inputTokens: usage?.input ?? 0,
    outputTokens: usage?.output ?? 0,
    cacheReadTokens: usage?.cache ?? 0,
    costUsd: usage?.cost ?? 0,
    planningCostUsd: planningCost,
    runs: usage?.runs ?? 0,
    prs: one("SELECT COUNT(*) AS n FROM pull_requests"),
    merged: one("SELECT COUNT(*) AS n FROM merges WHERE result = 'merged'"),
    completed,
    costPerCompletedUsd: completed ? (usage?.cost ?? 0) / completed : null,
    tokensPerCompleted: completed ? (usage?.tokens ?? 0) / completed : null,
    rework: { total: changes + conflicts + retries, changes, conflicts, retries },
    help: { total: decisions + planAsks, decisions, planAsks },
  };

  // ---- 日ごと(サーバーの時刻の日付で区切る) ----
  const days = new Map<string, DayRow>();
  const day = (iso: string) => {
    const d = new Date(iso);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    let row = days.get(key);
    if (!row) days.set(key, (row = { day: key, tokens: 0, costUsd: 0, prs: 0, merged: 0, rework: 0, help: 0, completed: 0 }));
    return row;
  };
  for (const r of all<{ started_at: string; tokens: number; cost: number | null; outcome: string | null }>(
    p.db,
    "SELECT started_at, COALESCE(input_tokens,0) + COALESCE(output_tokens,0) + COALESCE(cache_read_tokens,0) AS tokens, cost_usd AS cost, outcome FROM runs WHERE ended_at IS NOT NULL",
  )) {
    const row = day(r.started_at);
    row.tokens += r.tokens;
    row.costUsd += r.cost ?? 0;
    if (r.outcome === "error") row.rework += 1;
  }
  // PR は最初に出したときだけ数える(直して出し直した分は手戻りの方で数える)
  for (const e of all<{ at: string; type: string }>(
    p.db,
    `SELECT at, type FROM events WHERE type IN ('changes_requested','conflict','escalated','merged','ready_to_merge')
     UNION ALL SELECT MIN(at) AS at, 'pr_first' AS type FROM events WHERE type = 'pr_submitted' AND ticket_id IS NOT NULL GROUP BY ticket_id`,
  )) {
    const row = day(e.at);
    if (e.type === "pr_first") row.prs += 1;
    else if (e.type === "merged") row.merged += 1;
    else if (e.type === "changes_requested" || e.type === "conflict") row.rework += 1;
    else if (e.type === "escalated") row.help += 1;
    else if (e.type === "ready_to_merge") row.completed += 1;
  }
  for (const o of all<{ created_at: string }>(p.db, "SELECT created_at FROM plan_open_items WHERE created_at <> '' AND (decided_by = 'owner' OR (answer IS NULL AND withdrawn IS NULL))")) {
    day(o.created_at).help += 1;
  }
  const daily = [...days.values()].sort((a, b) => a.day.localeCompare(b.day));

  // ---- 役割ごと ----
  const byRole = all<{ role: Role; tokens: number; cost: number | null; runs: number }>(
    p.db,
    `SELECT role, SUM(COALESCE(input_tokens,0) + COALESCE(output_tokens,0) + COALESCE(cache_read_tokens,0)) AS tokens, SUM(cost_usd) AS cost, COUNT(*) AS runs
     FROM runs WHERE ended_at IS NOT NULL GROUP BY role ORDER BY cost DESC, tokens DESC, role`,
  ).map((r) => ({ role: r.role, label: ROLE_LABEL[r.role] ?? r.role, tokens: r.tokens, costUsd: r.cost ?? 0, runs: r.runs }));

  // ---- 金額の内訳: 何の仕事に・どのモデルに ----
  const PURPOSE: Record<string, string> = {
    implement: "実装",
    fix: "直し(差し戻し・衝突)",
    answer: "判断を受けて続き",
    review: "レビュー",
    sec: "セキュリティの確認",
    qa: "QA",
    decide: "判断(リーダー)",
    "plan:req": "企画: 要件",
    "plan:flow": "企画: ユーザーフロー",
    "plan:screen": "企画: 画面デザイン",
    "plan:infra": "企画: インフラ",
    "plan:model": "企画: アーキテクチャとデータ",
    "plan:handoff": "企画: チームに渡す",
  };
  const group = (rows: { key: string; tokens: number; cost: number | null; runs: number }[], label: (k: string) => string) => {
    const m = new Map<string, { key: string; label: string; tokens: number; costUsd: number; runs: number }>();
    for (const r of rows) {
      const g = m.get(r.key) ?? { key: r.key, label: label(r.key), tokens: 0, costUsd: 0, runs: 0 };
      g.tokens += r.tokens;
      g.costUsd += r.cost ?? 0;
      g.runs += r.runs;
      m.set(r.key, g);
    }
    return [...m.values()].sort((a, b) => b.costUsd - a.costUsd || b.tokens - a.tokens || a.key.localeCompare(b.key));
  };
  const TOKENS = "COALESCE(r.input_tokens,0) + COALESCE(r.output_tokens,0) + COALESCE(r.cache_read_tokens,0)";
  const byPurpose = group(
    all<{ key: string; tokens: number; cost: number | null; runs: number }>(
      p.db,
      `SELECT CASE WHEN m.kind = 'plan' THEN 'plan:' || json_extract(m.payload, '$.stage') ELSE m.kind END AS key,
         SUM(${TOKENS}) AS tokens, SUM(r.cost_usd) AS cost, COUNT(*) AS runs
       FROM runs r JOIN messages m ON m.id = r.message_id WHERE r.ended_at IS NOT NULL GROUP BY key`,
    ),
    (k) => PURPOSE[k] ?? k,
  );
  const byModel = group(
    all<{ key: string; tokens: number; cost: number | null; runs: number }>(
      p.db,
      `SELECT COALESCE(r.model, pol.model) AS key, SUM(${TOKENS}) AS tokens, SUM(r.cost_usd) AS cost, COUNT(*) AS runs
       FROM runs r JOIN policies pol ON pol.id = r.policy_id WHERE r.ended_at IS NOT NULL GROUP BY key`,
    ),
    (k) => MODELS[k as keyof typeof MODELS]?.label ?? k,
  );

  // ---- チケットごと ----
  const tickets = all<{ id: number; number: number; title: string; stage: string; rounds: number; tokens: number | null; cost: number | null; runs: number; prs: number; conflicts: number; help: number; retries: number }>(
    p.db,
    `SELECT t.id, t.number, t.title, t.stage, t.rounds,
       (SELECT SUM(COALESCE(input_tokens,0) + COALESCE(output_tokens,0) + COALESCE(cache_read_tokens,0)) FROM runs r WHERE r.ticket_id = t.id) AS tokens,
       (SELECT SUM(cost_usd) FROM runs r WHERE r.ticket_id = t.id) AS cost,
       (SELECT COUNT(*) FROM runs r WHERE r.ticket_id = t.id AND r.ended_at IS NOT NULL) AS runs,
       (SELECT COUNT(*) FROM pull_requests pr WHERE pr.ticket_id = t.id) AS prs,
       (SELECT COUNT(*) FROM conflicts c JOIN pull_requests pr ON pr.id = c.pr_id WHERE pr.ticket_id = t.id) AS conflicts,
       (SELECT COUNT(*) FROM decisions d WHERE d.ticket_id = t.id AND d.escalated = 1) AS help,
       (SELECT COUNT(*) FROM runs r WHERE r.ticket_id = t.id AND r.outcome = 'error') AS retries
     FROM tickets t ORDER BY t.number DESC`,
  ).map((t) => ({ ...t, tokens: t.tokens ?? 0, costUsd: t.cost ?? 0 }));

  return { totals, daily, byRole, byPurpose, byModel, tickets };
}

export type Productivity = ReturnType<typeof productivity>;
