import { formationMarks } from "./formation-marks.js";
import { all, get } from "../db/sqlite.js";
import { MODELS, ROLE_LABEL, type Role } from "../domain/roles.js";
import { violationTotals } from "./dev-rules.js";
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
    // 開発ルールに反した件数と、うち持ち主が自動で直した件数(R15)
    ruleViolations: violationTotals(p),
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
       (SELECT SUM(COALESCE(input_tokens,0) + COALESCE(output_tokens,0) + COALESCE(cache_read_tokens,0)) FROM runs r WHERE COALESCE(r.ticket_id, r.about_ticket_id) = t.id) AS tokens,
       (SELECT SUM(cost_usd) FROM runs r WHERE COALESCE(r.ticket_id, r.about_ticket_id) = t.id) AS cost,
       (SELECT COUNT(*) FROM runs r WHERE r.ticket_id = t.id AND r.ended_at IS NOT NULL) AS runs,
       (SELECT COUNT(*) FROM pull_requests pr WHERE pr.ticket_id = t.id) AS prs,
       (SELECT COUNT(*) FROM conflicts c JOIN pull_requests pr ON pr.id = c.pr_id WHERE pr.ticket_id = t.id) AS conflicts,
       (SELECT COUNT(*) FROM decisions d WHERE d.ticket_id = t.id AND d.escalated = 1) AS help,
       (SELECT COUNT(*) FROM runs r WHERE r.ticket_id = t.id AND r.outcome = 'error') AS retries
     FROM tickets t ORDER BY t.number DESC`,
  ).map((t) => ({ ...t, tokens: t.tokens ?? 0, costUsd: t.cost ?? 0 }));

  return { totals, daily, byRole, byPurpose, byModel, tickets, flow: flow(p), members: members(p) };
}

const HOUR = 3_600_000;

/** 中央値と 90 パーセンタイル(ミリ秒)。 */
function spread(xs: number[]): { median: number | null; p90: number | null; n: number } {
  const v = xs.filter((x) => Number.isFinite(x) && x >= 0).sort((a, b) => a - b);
  const at = (q: number) => (v.length ? v[Math.min(v.length - 1, Math.floor(q * (v.length - 1) + 0.5))]! : null);
  return { median: at(0.5), p90: at(0.9), n: v.length };
}

/** チケットがどこから入ったか。 */
const SOURCE: Record<string, string> = {
  plan: "企画から",
  followup: "確認で見つかった範囲外のこと",
  split: "大きすぎて切り出した",
  baseCi: "main の CI を直す",
  manual: "手で足した(あなた・チャット)",
};

/**
 * 流れの指標(ADR-0029)。速さ(時間あたりの merge・リードタイム)・入ってくる数と片付く数・仕掛かり・待ち。
 * 時間ごとの推移は、直近 48 時間を 1 時間ずつ区切る。
 */
function flow(p: Project) {
  const now = p.clock.now().getTime();
  const tickets = all<{ id: number; number: number; title: string; stage: string; created_at: string; requirement_item_id: number | null; plan_refs: string; active_ms: number; dropped_at: string | null }>(
    p.db,
    "SELECT id, number, title, stage, created_at, requirement_item_id, plan_refs, active_ms, dropped_at FROM tickets",
  );
  const firstAt = (type: string) =>
    new Map(all<{ ticket_id: number; at: string }>(p.db, "SELECT ticket_id, MIN(at) AS at FROM events WHERE type = ? AND ticket_id IS NOT NULL GROUP BY ticket_id", [type]).map((r) => [r.ticket_id, Date.parse(r.at)]));
  const merged = firstAt("merged");
  const alreadyDone = firstAt("already_done");
  const dropEvent = new Map(
    all<{ ticket_id: number; at: string }>(p.db, "SELECT ticket_id, MIN(at) AS at FROM events WHERE type IN ('ticket_dropped','duplicate_dropped') AND ticket_id IS NOT NULL GROUP BY ticket_id").map((r) => [r.ticket_id, Date.parse(r.at)]),
  );
  const firstDev = new Map(all<{ ticket_id: number; at: string }>(p.db, "SELECT ticket_id, MIN(started_at) AS at FROM runs WHERE role = 'dev' AND ticket_id IS NOT NULL GROUP BY ticket_id").map((r) => [r.ticket_id, Date.parse(r.at)]));
  const firstReady = firstAt("ready_to_merge");
  const changed = new Set(all<{ ticket_id: number }>(p.db, "SELECT DISTINCT ticket_id FROM events WHERE type IN ('changes_requested','conflict') AND ticket_id IS NOT NULL").map((r) => r.ticket_id));
  const sentBack = new Set(all<{ ticket_id: number }>(p.db, "SELECT DISTINCT ticket_id FROM events WHERE type IN ('sent_back','merge_blocked') AND ticket_id IS NOT NULL").map((r) => r.ticket_id));

  const sourceOf = (t: (typeof tickets)[number]): keyof typeof SOURCE => {
    const refs = JSON.parse(t.plan_refs || "{}") as { followupOf?: number; splitFrom?: number; baseCi?: string };
    if (refs.baseCi) return "baseCi";
    if (refs.followupOf) return "followup";
    if (refs.splitFrom) return "split";
    if (t.requirement_item_id !== null) return "plan";
    return "manual";
  };
  /** 片付いた時刻(merge・すでに入っていた・取りやめ)。開いていれば null。 */
  const closedAt = (t: (typeof tickets)[number]): number | null => {
    if (t.stage !== "done" && t.stage !== "dropped") return null;
    const at = merged.get(t.id) ?? alreadyDone.get(t.id) ?? dropEvent.get(t.id) ?? (t.dropped_at ? Date.parse(t.dropped_at) : null);
    return at ?? Date.parse(t.created_at); // 時刻の記録が無い古い取りやめは、入った時に片付いたとみなす
  };

  // ---- 直近 48 時間を 1 時間ずつ ----
  const end = Math.floor(now / HOUR) * HOUR + HOUR;
  const start = end - 48 * HOUR;
  const label = (ms: number) => {
    const d = new Date(ms);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}時`;
  };
  const hourly = Array.from({ length: 48 }, (_, i) => ({ hour: label(start + i * HOUR), created: 0, closed: 0, merged: 0, runs: 0, costUsd: 0, open: 0 }));
  const slot = (ms: number) => (ms >= start && ms < end ? Math.floor((ms - start) / HOUR) : -1);
  for (const t of tickets) {
    const c = slot(Date.parse(t.created_at));
    if (c >= 0) hourly[c]!.created++;
    const cl = closedAt(t);
    if (cl !== null) {
      const i = slot(cl);
      if (i >= 0) hourly[i]!.closed++;
    }
    const m = merged.get(t.id);
    if (m !== undefined && slot(m) >= 0) hourly[slot(m)]!.merged++;
    // その時間の終わりに開いていたか(未完了の数の推移)
    for (let i = 0; i < 48; i++) {
      const at = start + (i + 1) * HOUR;
      if (Date.parse(t.created_at) < at && (cl === null || cl >= at)) hourly[i]!.open++;
    }
  }
  for (const r of all<{ started_at: string; cost: number | null }>(p.db, "SELECT started_at, cost_usd AS cost FROM runs WHERE started_at >= ?", [new Date(start).toISOString()])) {
    const i = slot(Date.parse(r.started_at));
    if (i < 0) continue;
    hourly[i]!.runs++;
    hourly[i]!.costUsd += r.cost ?? 0;
  }

  // ---- 速さ(直近 24 時間) ----
  const dayAgo = now - 24 * HOUR;
  const last24 = (m: Map<number, number>) => [...m.values()].filter((at) => at >= dayAgo).length;
  const mergedLast24h = last24(merged);
  const createdLast24h = tickets.filter((t) => Date.parse(t.created_at) >= dayAgo).length;
  const closedLast24h = tickets.filter((t) => {
    const c = closedAt(t);
    return c !== null && c >= dayAgo;
  }).length;
  // チームが動いていた時間(起動があった 1 時間の枠の数)。止めていた時間を割り算に入れない
  const activeHours = new Set(
    all<{ started_at: string; ended_at: string | null }>(p.db, "SELECT started_at, ended_at FROM runs WHERE COALESCE(ended_at, started_at) >= ?", [new Date(dayAgo).toISOString()]).flatMap((r) => {
      const from = Math.max(dayAgo, Date.parse(r.started_at));
      const to = r.ended_at ? Date.parse(r.ended_at) : now;
      const hs: number[] = [];
      for (let h = Math.floor(from / HOUR); h <= Math.floor(to / HOUR); h++) hs.push(h);
      return hs;
    }),
  ).size;

  // ---- かかった時間(merge したチケット) ----
  const done = tickets.filter((t) => merged.has(t.id));
  const lead = done.map((t) => merged.get(t.id)! - Date.parse(t.created_at));
  const cycle = done.filter((t) => firstDev.has(t.id)).map((t) => merged.get(t.id)! - firstDev.get(t.id)!);
  const mergeWait = done.filter((t) => firstReady.has(t.id)).map((t) => merged.get(t.id)! - firstReady.get(t.id)!);
  const activeSum = done.reduce((s, t) => s + t.active_ms, 0);
  const leadSum = lead.reduce((s, x) => s + Math.max(0, x), 0);
  const firstPass = done.filter((t) => !changed.has(t.id) && !sentBack.has(t.id)).length;

  // ---- 仕掛かり ----
  const open = tickets.filter((t) => t.stage !== "done" && t.stage !== "dropped");
  const STAGES: [string, string][] = [
    ["todo", "未着手"],
    ["dev", "開発中"],
    ["review", "レビュー"],
    ["sec", "セキュリティ"],
    ["qa", "QA"],
    ["decision", "判断待ち"],
    ["merge", "merge 待ち"],
  ];
  const stageOf = (t: (typeof tickets)[number]) => (t.stage === "dev" && !firstDev.has(t.id) ? "todo" : t.stage);
  const wip = STAGES.map(([key, label]) => ({ key, label, n: open.filter((t) => stageOf(t) === key).length })).filter((x) => x.n > 0);
  const aging = [...open]
    .sort((a, b) => a.created_at.localeCompare(b.created_at))
    .slice(0, 8)
    .map((t) => ({ id: t.id, number: t.number, title: t.title, stage: stageOf(t), ageMs: now - Date.parse(t.created_at) }));

  // ---- どこから入ったか ----
  const sources = Object.entries(SOURCE)
    .map(([key, label]) => {
      const ts = tickets.filter((t) => sourceOf(t) === key);
      return { key, label, total: ts.length, last24h: ts.filter((t) => Date.parse(t.created_at) >= dayAgo).length, open: ts.filter((t) => t.stage !== "done" && t.stage !== "dropped").length };
    })
    .filter((x) => x.total > 0)
    .sort((a, b) => b.total - a.total);

  // ---- 責任者を待った時間 ----
  const waits = all<{ raised: string | null; decided_at: string | null }>(
    p.db,
    `SELECT (SELECT MIN(e.at) FROM events e WHERE e.ticket_id = d.ticket_id AND e.type = 'escalated' AND json_extract(e.data, '$.decision_id') = d.id) AS raised, d.decided_at
     FROM decisions d WHERE d.escalated = 1`,
  ).filter((w) => w.raised);
  const waitMs = waits.map((w) => (w.decided_at ? Date.parse(w.decided_at) : now) - Date.parse(w.raised!));

  return {
    throughput: {
      mergedLast24h,
      mergedPerHour: mergedLast24h / 24,
      activeHours,
      mergedPerActiveHour: activeHours ? mergedLast24h / activeHours : null,
      createdLast24h,
      closedLast24h,
      /** 入ってくる数 − 片付く数(直近 24 時間)。正なら溜まっている */
      netLast24h: createdLast24h - closedLast24h,
    },
    times: { leadMs: spread(lead), cycleMs: spread(cycle), mergeWaitMs: spread(mergeWait) },
    flowEfficiency: leadSum > 0 ? activeSum / leadSum : null,
    firstPassYield: done.length ? firstPass / done.length : null,
    mergedTotal: done.length,
    open: open.length,
    wip,
    aging,
    sources,
    hourly,
    /** 編成の版が上がった印(効率のグラフの縦線)。何を変えたか(連絡経路 / 流れ / 島)つき */
    formationMarks: formationMarks(p),
    ownerWait: { count: waits.length, pending: waits.filter((w) => !w.decided_at).length, totalMs: waitMs.reduce((s, x) => s + x, 0), ...spread(waitMs) },
  };
}

/** メンバーごと: 起動・動いていた時間・稼働率(直近 24 時間、チームが動いていた時間に対して)・金額・merge まで持っていったチケット。 */
function members(p: Project) {
  const now = p.clock.now().getTime();
  const dayAgo = now - 24 * HOUR;
  const rows = all<{ id: number; name: string; unit: string | null; left_at: string | null }>(p.db, "SELECT m.id, m.name, u.name AS unit, m.left_at FROM members m LEFT JOIN units u ON u.id = m.unit_id ORDER BY m.id");
  const runs = all<{ member_id: number; role: string; started_at: string; ended_at: string | null; cost: number | null; outcome: string | null }>(
    p.db,
    "SELECT member_id, role, started_at, ended_at, cost_usd AS cost, outcome FROM runs",
  );
  const span = (r: (typeof runs)[number], from = 0) => Math.max(0, (r.ended_at ? Date.parse(r.ended_at) : now) - Math.max(from, Date.parse(r.started_at)));
  const activeMs =
    new Set(
      runs
        .filter((r) => (r.ended_at ? Date.parse(r.ended_at) : now) >= dayAgo)
        .flatMap((r) => {
          const hs: number[] = [];
          for (let h = Math.floor(Math.max(dayAgo, Date.parse(r.started_at)) / HOUR); h <= Math.floor((r.ended_at ? Date.parse(r.ended_at) : now) / HOUR); h++) hs.push(h);
          return hs;
        }),
    ).size * HOUR;
  const mergedBy = new Map(
    all<{ owner: number; n: number }>(p.db, "SELECT t.owner_member_id AS owner, COUNT(*) AS n FROM tickets t WHERE t.owner_member_id IS NOT NULL AND EXISTS (SELECT 1 FROM events e WHERE e.ticket_id = t.id AND e.type = 'merged') GROUP BY t.owner_member_id").map((r) => [r.owner, r.n]),
  );
  const list = rows
    .map((m) => {
      const mine = runs.filter((r) => r.member_id === m.id);
      const recent = mine.filter((r) => (r.ended_at ? Date.parse(r.ended_at) : now) >= dayAgo);
      const busy24 = recent.reduce((s, r) => s + span(r, dayAgo), 0);
      return {
        id: m.id,
        name: m.name,
        unit: m.unit ?? "",
        // 島に属さない担当(リーダー・アーキテクトなど)は役割を出す
        role: ROLE_LABEL[(mine[0]?.role ?? "") as Role] ?? "",
        left: !!m.left_at,
        runs: mine.length,
        busyMs: mine.reduce((s, r) => s + span(r), 0),
        utilization: activeMs ? Math.min(1, busy24 / activeMs) : null,
        costUsd: mine.reduce((s, r) => s + (r.cost ?? 0), 0),
        errors: mine.filter((r) => r.outcome === "error").length,
        merged: mergedBy.get(m.id) ?? 0,
      };
    })
    .filter((m) => m.runs > 0)
    // 席にいる人を先に、よく動いている順
    .sort((a, b) => Number(a.left) - Number(b.left) || (b.utilization ?? 0) - (a.utilization ?? 0) || b.runs - a.runs);
  // 役割ごとの起動の長さと、エラーの割合
  const roles = [...new Set(runs.map((r) => r.role))].map((role) => {
    const rs = runs.filter((r) => r.role === role && r.ended_at);
    return { role, label: ROLE_LABEL[role as Role] ?? role, runs: rs.length, ...spread(rs.map((r) => span(r))), errorRate: rs.length ? rs.filter((r) => r.outcome === "error").length / rs.length : null };
  });
  return { list, roles: roles.sort((a, b) => b.runs - a.runs) };
}

export type Productivity = ReturnType<typeof productivity>;
