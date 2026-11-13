import { all, get } from "../db/sqlite.js";
import { MODELS, ROLE_LABEL, type Role } from "../domain/roles.js";
import { unitExhausted, unitSpentUsd } from "./budget.js";
import { KIND_LABEL, workOf, workOfMany } from "./office.js";
import type { Project } from "./project.js";

/**
 * オフィスで、メンバーや島をクリックしたときに開く「様子」の中身。
 * 席の下には名前と短い状態だけを出し、今していることの経過・これまでの仕事・島の待ちや予算はここで見せる。
 */

type RunRow = {
  id: number;
  member_id: number;
  name: string;
  ticket_id: number | null;
  number: number | null;
  title: string | null;
  role: string;
  kind: string;
  started_at: string;
  ended_at: string | null;
  outcome: string | null;
  error: string | null;
  summary: string | null;
  cost_usd: number | null;
  model: string | null;
};

const RUN_SQL = `SELECT r.id, r.member_id, m.name, r.ticket_id, t.number, t.title, r.role, msg.kind, r.started_at, r.ended_at, r.outcome, r.error, r.summary, r.cost_usd, r.model
  FROM runs r JOIN members m ON m.id = r.member_id JOIN messages msg ON msg.id = r.message_id LEFT JOIN tickets t ON t.id = r.ticket_id`;

const OUTCOME_LABEL: Record<string, string> = { ok: "終わった", error: "エラー", budget: "予算で止まった", max_turns: "回数の上限", abandoned: "中断" };

function runItem(r: RunRow) {
  const sec = r.ended_at ? Math.max(0, Math.round((Date.parse(r.ended_at) - Date.parse(r.started_at)) / 1000)) : null;
  return {
    runId: r.id,
    member: r.name,
    ticket: r.number === null ? null : { id: r.ticket_id!, number: r.number, title: r.title ?? "" },
    role: ROLE_LABEL[r.role as Role] ?? r.role,
    kind: KIND_LABEL[r.kind] ?? r.kind,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    durationSec: sec,
    running: r.ended_at === null,
    outcome: r.ended_at === null ? "作業中" : (OUTCOME_LABEL[r.outcome ?? ""] ?? r.outcome ?? "?"),
    ok: r.outcome === "ok",
    error: r.error,
    summary: r.summary,
    costUsd: r.cost_usd ?? 0,
    model: r.model ? (MODELS[r.model as keyof typeof MODELS]?.label ?? r.model) : null,
  };
}

/** メンバー 1 人の様子: 今の仕事(途中経過つき)・受け持ちのチケット・これまでの仕事。 */
export async function memberView(p: Project, memberId: number) {
  const m = p.member(memberId);
  if (!m) throw new Error(`メンバー ${memberId} はいません`);
  const unit = m.unit_id === null ? null : get<{ name: string; roles: string }>(p.db, "SELECT name, roles FROM units WHERE id = ?", [m.unit_id]);
  const work = await workOf(p, m);
  const openRun = get<{ id: number }>(p.db, "SELECT id FROM runs WHERE member_id = ? AND ended_at IS NULL ORDER BY id DESC LIMIT 1", [m.id]);
  const steps = openRun ? all<{ at: string; kind: string; text: string }>(p.db, "SELECT at, kind, text FROM run_steps WHERE run_id = ? ORDER BY id DESC LIMIT 30", [openRun.id]).reverse() : [];
  const history = all<RunRow>(p.db, `${RUN_SQL} WHERE r.member_id = ? ORDER BY r.id DESC LIMIT 40`, [m.id]).map(runItem);
  const totals = get<{ runs: number; cost: number | null; ok: number | null }>(p.db, "SELECT COUNT(*) AS runs, SUM(cost_usd) AS cost, SUM(outcome = 'ok') AS ok FROM runs WHERE member_id = ?", [m.id]);
  const owned = all<{ id: number; number: number; title: string; stage: string }>(
    p.db,
    "SELECT id, number, title, stage FROM tickets WHERE owner_member_id = ? ORDER BY CASE WHEN stage IN ('done','dropped') THEN 1 ELSE 0 END, number DESC LIMIT 30",
    [m.id],
  );
  // 次に頼まれている仕事(名指しで待っているもの)
  const queued = all<{ number: number; title: string; kind: string }>(
    p.db,
    "SELECT t.number, t.title, msg.kind FROM messages msg JOIN tickets t ON t.id = msg.ticket_id WHERE msg.to_member_id = ? AND msg.status = 'pending' ORDER BY msg.id",
    [m.id],
  ).map((q) => ({ number: q.number, title: q.title, kind: KIND_LABEL[q.kind] ?? q.kind }));
  return {
    id: m.id,
    name: m.name,
    unit: unit?.name ?? null,
    helper: !m.is_base && m.unit_id !== null,
    joinedAt: m.joined_at,
    leftAt: m.left_at,
    work: work ? { ...work, steps } : null,
    queued,
    owned,
    history,
    totals: { runs: totals?.runs ?? 0, costUsd: totals?.cost ?? 0, ok: totals?.ok ?? 0 },
  };
}

/** 島 1 つの様子: メンバーの今・すぐ取れる仕事と順番待ち・予算・設定・最近の仕事。 */
export async function unitView(p: Project, unitId: number, office: { units: { id: number; waiting: number[]; queued: { number: number; why: string }[] }[] }) {
  const u = p.currentFormation().units.find((x) => x.id === unitId);
  if (!u) throw new Error(`島 ${unitId} は今の編成にありません`);
  const unitMembers = p.membersOfUnit(u.id);
  const works = await workOfMany(p, unitMembers);
  const members = unitMembers.map((m) => {
    const w = works.get(m.id) ?? null;
    return { id: m.id, name: m.name, helper: !m.is_base, work: w ? { ticket: w.ticket, title: w.title, kind: w.kind, startedAt: w.startedAt, lastStep: w.lastStep } : null };
  });
  const o = office.units.find((x) => x.id === u.id);
  const recent = all<RunRow>(p.db, `${RUN_SQL} WHERE r.unit_name = ? ORDER BY r.id DESC LIMIT 30`, [u.name]).map(runItem);
  const day = new Date(p.clock.now().getTime() - 24 * 3600 * 1000).toISOString();
  const today = get<{ runs: number; cost: number | null; ok: number | null }>(p.db, "SELECT COUNT(*) AS runs, SUM(cost_usd) AS cost, SUM(outcome = 'ok') AS ok FROM runs WHERE unit_name = ? AND started_at >= ?", [u.name, day]);
  return {
    id: u.id,
    name: u.name,
    roles: u.roles.map((r) => ROLE_LABEL[r]),
    max: u.max_members,
    summonAt: u.summon_at,
    idleSec: u.idle_sec,
    repos: u.repos,
    model: u.model ? (MODELS[u.model as keyof typeof MODELS]?.label ?? u.model) : null,
    effort: u.effort,
    focus: u.focus,
    members,
    waiting: o?.waiting ?? [],
    queued: o?.queued ?? [],
    budget: { budgetUsd: u.budget_usd, spentUsd: await unitSpentUsd(p, u.name), exhausted: await unitExhausted(p, u) },
    last24h: { runs: today?.runs ?? 0, costUsd: today?.cost ?? 0, ok: today?.ok ?? 0 },
    recent,
  };
}

export type MemberView = Awaited<ReturnType<typeof memberView>>;
export type UnitView = Awaited<ReturnType<typeof unitView>>;
