import { formationMarks } from "./formation-marks.js";
import { sql, type Selectable } from "kysely";
import { countFrom, countOf, inScope } from "../db/count.js";
import type { DecisionsTable, RunsTable, TicketsTable } from "../db/tables.js";
import { MODELS, ROLE_LABEL, type Role } from "../domain/roles.js";
import { violationTotals } from "./dev-rules.js";
import type { Project } from "./project.js";
import { LEAD_TARGET } from "./questions.js";

type RunRow = Selectable<RunsTable>;
type TicketRow = Selectable<TicketsTable>;
type DecisionRow = Selectable<DecisionsTable>;

/**
 * 開発生産性の指標(docs/design.md 8 章)。集計のための表は作らず、記録(runs・events・decisions など)から毎回数える。
 * - トークン・金額は起動ごとの記録から(企画スタジオの担当の分も含む)
 * - PR・手戻り・助けを求めた数は、出来事の記録と判断カード・企画の未決から
 */

export type DayRow = { day: string; tokens: number; costUsd: number; prs: number; merged: number; rework: number; help: number; completed: number };

const tok = (r: { input_tokens: number | null; output_tokens: number | null; cache_read_tokens: number | null }) => (r.input_tokens ?? 0) + (r.output_tokens ?? 0) + (r.cache_read_tokens ?? 0);
const sum = (xs: (number | null)[]) => xs.reduce<number>((s, x) => s + (x ?? 0), 0);
const dayOf = (iso: string) => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
/** ticket_id ごとの、いちばん早い時刻(ms)。 */
const earliest = (rows: { ticket_id: number | null; at: string }[]) => {
  const m = new Map<number, number>();
  for (const r of rows) {
    if (r.ticket_id === null) continue;
    const t = Date.parse(r.at);
    const cur = m.get(r.ticket_id);
    if (cur === undefined || t < cur) m.set(r.ticket_id, t);
  }
  return m;
};

export async function productivity(p: Project) {
  // 読むものは表ごとに 1 文でまとめて取り、数えるのは JS でやる(記録から毎回計算する)
  const [runsAll, ticketsAll, prsAll, conflictsAll, decisionsAll, violationsAll, planItems, messagesAll, policiesAll, questionsAll, formationNow] = await Promise.all([
    inScope(p.pdb, "runs").execute(),
    inScope(p.pdb, "tickets").orderBy("number", "desc").execute(),
    inScope(p.pdb, "pull_requests").execute(),
    inScope(p.pdb, "conflicts").execute(),
    inScope(p.pdb, "decisions").where("escalated", "=", 1).execute(),
    inScope(p.pdb, "rule_violations").execute(),
    inScope(p.pdb, "plan_open_items").execute(),
    // 件数がいちばん増える表。使うのは kind と、企画の段階を持つ plan の payload だけ
    p.pdb.k
      .selectFrom("messages")
      .select(["id", "kind", sql<string>`CASE WHEN kind = 'plan' THEN payload ELSE '' END`.as("payload")])
      .where("project_id", "=", p.pdb.projectId)
      .execute(),
    inScope(p.pdb, "policies").execute(),
    inScope(p.pdb, "ticket_questions").execute(),
    p.currentFormationOrNull(),
  ]);
  const doneRuns = runsAll.filter((r) => r.ended_at !== null);
  const asks = planItems.filter((o) => o.decided_by === "owner" || (o.answer === null && o.withdrawn === null));

  // ---- 合計 ----
  const completed = ticketsAll.filter((t) => t.done_at !== null).length;
  const [changes, merged] = await Promise.all([countOf(countFrom(p.pdb, "reviews").where("verdict", "=", "changes")), countOf(countFrom(p.pdb, "merges").where("result", "=", "merged"))]);
  const conflicts = conflictsAll.length;
  const retries = runsAll.filter((r) => r.outcome === "error").length;
  const decisions = decisionsAll.length;
  const planAsks = asks.length;
  const totalCost = sum(doneRuns.map((r) => r.cost_usd));
  const totalTokens = sum(doneRuns.map(tok));
  const totals = {
    tokens: totalTokens,
    inputTokens: sum(doneRuns.map((r) => r.input_tokens)),
    outputTokens: sum(doneRuns.map((r) => r.output_tokens)),
    cacheReadTokens: sum(doneRuns.map((r) => r.cache_read_tokens)),
    costUsd: totalCost,
    planningCostUsd: sum(runsAll.filter((r) => r.ticket_id === null).map((r) => r.cost_usd)),
    runs: doneRuns.length,
    prs: prsAll.length,
    merged,
    completed,
    costPerCompletedUsd: completed ? totalCost / completed : null,
    tokensPerCompleted: completed ? totalTokens / completed : null,
    rework: { total: changes + conflicts + retries, changes, conflicts, retries },
    help: { total: decisions + planAsks, decisions, planAsks },
    // 開発ルールに反した件数と、うち持ち主が自動で直した件数(R15)
    ruleViolations: await violationTotals(p),
    // 島への質問(R16)。島どうしで答えをもらった数と、経路が無くリーダーに回った数(リーダーへ直接聞いたものは、どちらにも数えない)
    questions: { islands: questionsAll.filter((q) => q.routed_to_lead === 0).length, noRoute: questionsAll.filter((q) => q.routed_to_lead === 1 && q.to_target !== LEAD_TARGET).length },
    // チケット 1 件あたりの判断の回数(判断カード ÷ チケットの数)
    decisionsPerTicket: ticketsAll.length ? decisions / ticketsAll.length : null,
    // いまの編成の版(画面の上の指標に出す)
    formationVersion: formationNow?.version ?? null,
  };

  // ---- 日ごと(サーバーの時刻の日付で区切る) ----
  const days = new Map<string, DayRow>();
  const day = (iso: string) => {
    const key = dayOf(iso);
    let row = days.get(key);
    if (!row) days.set(key, (row = { day: key, tokens: 0, costUsd: 0, prs: 0, merged: 0, rework: 0, help: 0, completed: 0 }));
    return row;
  };
  for (const r of doneRuns) {
    const row = day(r.started_at);
    row.tokens += tok(r);
    row.costUsd += r.cost_usd ?? 0;
    if (r.outcome === "error") row.rework += 1;
  }
  const evs = await inScope(p.pdb, "events").where("type", "in", ["changes_requested", "conflict", "escalated", "merged", "ready_to_merge", "pr_submitted"]).execute();
  for (const e of evs) {
    if (e.type === "pr_submitted") continue;
    const row = day(e.at);
    if (e.type === "merged") row.merged += 1;
    else if (e.type === "changes_requested" || e.type === "conflict") row.rework += 1;
    else if (e.type === "escalated") row.help += 1;
    else if (e.type === "ready_to_merge") row.completed += 1;
  }
  // PR を最初に出した日(チケットごとに 1 回)
  const firstPr = new Map<number, string>();
  for (const e of evs) if (e.type === "pr_submitted" && e.ticket_id !== null && (firstPr.get(e.ticket_id) ?? "~") > e.at) firstPr.set(e.ticket_id, e.at);
  for (const at of firstPr.values()) day(at).prs += 1;
  for (const o of asks) if (o.created_at !== "") day(o.created_at).help += 1;
  const daily = [...days.values()].sort((a, b) => a.day.localeCompare(b.day));

  const byRoleMap = new Map<string, { role: Role; tokens: number; cost: number; runs: number }>();
  for (const r of doneRuns) {
    const g = byRoleMap.get(r.role) ?? { role: r.role as Role, tokens: 0, cost: 0, runs: 0 };
    g.tokens += tok(r);
    g.cost += r.cost_usd ?? 0;
    g.runs += 1;
    byRoleMap.set(r.role, g);
  }
  const byRole = [...byRoleMap.values()]
    .sort((a, b) => b.cost - a.cost || b.tokens - a.tokens || a.role.localeCompare(b.role))
    .map((r) => ({ role: r.role, label: ROLE_LABEL[r.role] ?? r.role, tokens: r.tokens, costUsd: r.cost, runs: r.runs }));

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
  const msgOf = new Map(messagesAll.map((m) => [m.id, m]));
  const polOf = new Map(policiesAll.map((x) => [x.id, x.model]));
  const stageOf = (payload: string) => (JSON.parse(payload || "{}") as { stage?: string }).stage;
  const byPurpose = group(
    doneRuns.flatMap((r) => {
      const m = msgOf.get(r.message_id);
      return m ? [{ key: m.kind === "plan" ? `plan:${stageOf(m.payload)}` : m.kind, tokens: tok(r), cost: r.cost_usd, runs: 1 }] : [];
    }),
    (k) => PURPOSE[k] ?? k,
  );
  const byModel = group(
    doneRuns.flatMap((r) => {
      const model = r.model ?? polOf.get(r.policy_id);
      return model ? [{ key: model, tokens: tok(r), cost: r.cost_usd, runs: 1 }] : [];
    }),
    (k) => MODELS[k as keyof typeof MODELS]?.label ?? k,
  );

  const by = <T extends { ticket_id: number | null }>(rows: T[]) => {
    const m = new Map<number, T[]>();
    for (const r of rows) if (r.ticket_id !== null) m.set(r.ticket_id, [...(m.get(r.ticket_id) ?? []), r]);
    return m;
  };
  const runsBy = by(runsAll);
  const aboutBy = new Map<number, RunRow[]>();
  for (const r of runsAll) {
    const id = r.ticket_id ?? r.about_ticket_id;
    if (id !== null) aboutBy.set(id, [...(aboutBy.get(id) ?? []), r]);
  }
  const prsBy = by(prsAll);
  const prTicket = new Map(prsAll.map((x) => [x.id, x.ticket_id]));
  const conflictsBy = new Map<number, number>();
  for (const c of conflictsAll) {
    const t = prTicket.get(c.pr_id);
    if (t != null) conflictsBy.set(t, (conflictsBy.get(t) ?? 0) + 1);
  }
  const decisionsBy = by(decisionsAll);
  const violationsBy = by(violationsAll);
  const tickets = ticketsAll.map((t) => {
    const about = aboutBy.get(t.id) ?? [];
    const mine = runsBy.get(t.id) ?? [];
    const vs = violationsBy.get(t.id) ?? [];
    const cost = about.length ? sum(about.map((r) => r.cost_usd)) : null;
    return {
      id: t.id,
      number: t.number,
      title: t.title,
      kind: t.kind,
      stage: t.stage,
      rounds: t.rounds,
      tokens: sum(about.map(tok)),
      cost,
      runs: mine.filter((r) => r.ended_at !== null).length,
      prs: (prsBy.get(t.id) ?? []).length,
      conflicts: conflictsBy.get(t.id) ?? 0,
      help: (decisionsBy.get(t.id) ?? []).length,
      retries: mine.filter((r) => r.outcome === "error").length,
      violations: vs.length,
      autofixed: vs.filter((v) => v.handled === "autofixed").length,
      reviewed: vs.filter((v) => v.handled === "review").length,
      blocked: vs.filter((v) => v.handled === "blocked").length,
      costUsd: cost ?? 0,
      activeMs: t.active_ms,
      // 「直すまで止める」ルールに反したまま(直った印が無い)で、まだ片付いていない: 画面の状態に「止まっている」と出す
      stopped: t.stage !== "done" && t.stage !== "dropped" && vs.some((v) => v.handled === "blocked" && v.resolved_at === null),
    };
  });

  return { totals, daily, byRole, byPurpose, byModel, tickets, flow: await flow(p, { runsAll, ticketsAll, decisionsAll }), members: await members(p, runsAll) };
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
async function flow(p: Project, d: { runsAll: RunRow[]; ticketsAll: TicketRow[]; decisionsAll: DecisionRow[] }) {
  const now = p.clock.now().getTime();
  const tickets = [...d.ticketsAll].sort((a, b) => a.id - b.id);
  const evs = await inScope(p.pdb, "events")
    .where("type", "in", ["merged", "already_done", "ticket_dropped", "duplicate_dropped", "ready_to_merge", "changes_requested", "conflict", "sent_back", "merge_blocked", "escalated"])
    .execute();
  const firstAt = (...types: string[]) => earliest(evs.filter((e) => types.includes(e.type)));
  const merged = firstAt("merged");
  const alreadyDone = firstAt("already_done");
  const dropEvent = firstAt("ticket_dropped", "duplicate_dropped");
  const firstDev = earliest(d.runsAll.filter((r) => r.role === "dev").map((r) => ({ ticket_id: r.ticket_id, at: r.started_at })));
  const firstReady = firstAt("ready_to_merge");
  const idsOf = (...types: string[]) => new Set(evs.filter((e) => e.ticket_id !== null && types.includes(e.type)).map((e) => e.ticket_id as number));
  const changed = idsOf("changes_requested", "conflict");
  const sentBack = idsOf("sent_back", "merge_blocked");

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
  for (const r of d.runsAll.filter((x) => x.started_at >= new Date(start).toISOString()).map((x) => ({ started_at: x.started_at, cost: x.cost_usd }))) {
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
    d.runsAll
      .filter((r) => (r.ended_at ?? r.started_at) >= new Date(dayAgo).toISOString())
      .flatMap((r) => {
        const from = Math.max(dayAgo, Date.parse(r.started_at));
        const to = r.ended_at ? Date.parse(r.ended_at) : now;
        const hs: number[] = [];
        for (let h = Math.floor(from / HOUR); h <= Math.floor(to / HOUR); h++) hs.push(h);
        return hs;
      }),
  ).size;

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
  const escalated = evs.filter((e) => e.type === "escalated" && e.ticket_id !== null);
  const waits = d.decisionsAll
    .map((dc) => ({
      raised: escalated.filter((e) => e.ticket_id === dc.ticket_id && (JSON.parse(e.data || "{}") as { decision_id?: number }).decision_id === dc.id).map((e) => e.at).sort()[0] ?? null,
      decided_at: dc.decided_at,
    }))
    .filter((w) => w.raised);
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
    /** フロー効率の日ごとの推移(その日に merge したチケットの、手を動かしていた割合)。formationMarks の縦線と並べて見る */
    efficiencyDaily: efficiencyDaily(done.map((t) => ({ at: merged.get(t.id)!, active: t.active_ms, lead: merged.get(t.id)! - Date.parse(t.created_at) }))),
    firstPassYield: done.length ? firstPass / done.length : null,
    mergedTotal: done.length,
    open: open.length,
    wip,
    aging,
    sources,
    hourly,
    /** 編成の版が上がった印(効率のグラフの縦線)。何を変えたか(連絡経路 / 流れ / 島)つき */
    formationMarks: await formationMarks(p),
    ownerWait: { count: waits.length, pending: waits.filter((w) => !w.decided_at).length, totalMs: waitMs.reduce((s, x) => s + x, 0), ...spread(waitMs) },
  };
}

/** メンバーごと: 起動・動いていた時間・稼働率(直近 24 時間、チームが動いていた時間に対して)・金額・merge まで持っていったチケット。 */
async function members(p: Project, runs: RunRow[]) {
  const now = p.clock.now().getTime();
  const dayAgo = now - 24 * HOUR;
  const [memberRows, unitRows, ownedTickets, mergedEvents] = await Promise.all([
    inScope(p.pdb, "members").orderBy("id").execute(),
    inScope(p.pdb, "units").execute(),
    inScope(p.pdb, "tickets").where("owner_member_id", "is not", null).execute(),
    inScope(p.pdb, "events").where("type", "=", "merged").execute(),
  ]);
  const unitName = new Map(unitRows.map((u) => [u.id, u.name]));
  const rows = memberRows.map((m) => ({ id: m.id, name: m.name, unit: m.unit_id === null ? null : (unitName.get(m.unit_id) ?? null), left_at: m.left_at }));
  const mergedTickets = new Set(mergedEvents.map((e) => e.ticket_id));
  const mergedBy = new Map<number, number>();
  for (const t of ownedTickets) if (mergedTickets.has(t.id)) mergedBy.set(t.owner_member_id!, (mergedBy.get(t.owner_member_id!) ?? 0) + 1);
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
        costUsd: mine.reduce((s, r) => s + (r.cost_usd ?? 0), 0),
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

export type Productivity = Awaited<ReturnType<typeof productivity>>;

/** 日(ローカルの日付)ごとのフロー効率。merge した日に集める。 */
export function efficiencyDaily(rows: { at: number; active: number; lead: number }[]): { day: string; value: number }[] {
  const byDay = new Map<string, { active: number; lead: number }>();
  for (const r of rows) {
    const d = new Date(r.at);
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const cur = byDay.get(day) ?? { active: 0, lead: 0 };
    byDay.set(day, { active: cur.active + r.active, lead: cur.lead + Math.max(0, r.lead) });
  }
  return [...byDay].filter(([, v]) => v.lead > 0).map(([day, v]) => ({ day, value: v.active / v.lead })).sort((a, b) => a.day.localeCompare(b.day));
}
