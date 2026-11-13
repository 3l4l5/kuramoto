import type { Selectable } from "kysely";
import { inScope } from "../db/count.js";
import type { RunsTable } from "../db/tables.js";
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

/** 起動の行に、メンバーの名前・チケット・メッセージの種類を足す。名前・チケット・種類は、それぞれ 1 文でまとめて取る(IN)。 */
async function runRows(p: Project, runs: Selectable<RunsTable>[]): Promise<RunRow[]> {
  if (!runs.length) return [];
  const ids = (xs: (number | null)[]) => [...new Set(xs.filter((x): x is number => x !== null))];
  const ticketIds = ids(runs.map((r) => r.ticket_id));
  const [members, messages, tickets] = await Promise.all([
    inScope(p.pdb, "members").where("id", "in", ids(runs.map((r) => r.member_id))).execute(),
    inScope(p.pdb, "messages").where("id", "in", ids(runs.map((r) => r.message_id))).execute(),
    ticketIds.length ? inScope(p.pdb, "tickets").where("id", "in", ticketIds).execute() : [],
  ]);
  const name = new Map(members.map((m) => [m.id, m.name]));
  const kind = new Map(messages.map((m) => [m.id, m.kind]));
  const ticket = new Map(tickets.map((t) => [t.id, t]));
  // 名前と種類が引けない起動は出さない(前は内側結合だった)
  return runs
    .filter((r) => name.has(r.member_id) && kind.has(r.message_id))
    .map((r) => ({
      id: r.id,
      member_id: r.member_id,
      name: name.get(r.member_id)!,
      ticket_id: r.ticket_id,
      number: ticket.get(r.ticket_id ?? -1)?.number ?? null,
      title: ticket.get(r.ticket_id ?? -1)?.title ?? null,
      role: r.role,
      kind: kind.get(r.message_id)!,
      started_at: r.started_at,
      ended_at: r.ended_at,
      outcome: r.outcome,
      error: r.error,
      summary: r.summary,
      cost_usd: r.cost_usd,
      model: r.model,
    }));
}

const tally = (runs: Selectable<RunsTable>[]) => ({ runs: runs.length, cost: runs.reduce((x, r) => x + (r.cost_usd ?? 0), 0), ok: runs.filter((r) => r.outcome === "ok").length });

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
  const [unit, work, mine, ownedRows, pending] = await Promise.all([
    m.unit_id === null ? null : inScope(p.pdb, "units").where("id", "=", m.unit_id).executeTakeFirst(),
    workOf(p, m),
    inScope(p.pdb, "runs").where("member_id", "=", m.id).orderBy("id", "desc").execute(),
    inScope(p.pdb, "tickets").where("owner_member_id", "=", m.id).execute(),
    inScope(p.pdb, "messages").where("to_member_id", "=", m.id).where("status", "=", "pending").where("ticket_id", "is not", null).orderBy("id").execute(),
  ]);
  const openRun = mine.find((r) => r.ended_at === null);
  const steps = openRun ? (await inScope(p.pdb, "run_steps").where("run_id", "=", openRun.id).orderBy("id", "desc").limit(30).execute()).reverse().map((x) => ({ at: x.at, kind: x.kind, text: x.text })) : [];
  const history = (await runRows(p, mine.slice(0, 40))).map(runItem);
  const totals = tally(mine);
  const final = (stage: string) => (stage === "done" || stage === "dropped" ? 1 : 0);
  const owned = ownedRows
    .sort((a, b) => final(a.stage) - final(b.stage) || b.number - a.number)
    .slice(0, 30)
    .map((t) => ({ id: t.id, number: t.number, title: t.title, stage: t.stage }));
  // 次に頼まれている仕事(名指しで待っているもの)
  const queuedTickets = pending.length ? await inScope(p.pdb, "tickets").where("id", "in", [...new Set(pending.map((x) => x.ticket_id as number))]).execute() : [];
  const ticketOf = new Map(queuedTickets.map((t) => [t.id, t]));
  const queued = pending.flatMap((q) => {
    const t = ticketOf.get(q.ticket_id as number);
    return t ? [{ number: t.number, title: t.title, kind: KIND_LABEL[q.kind] ?? q.kind }] : [];
  });
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
    totals: { runs: totals.runs, costUsd: totals.cost, ok: totals.ok },
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
  const day = new Date(p.clock.now().getTime() - 24 * 3600 * 1000).toISOString();
  const unitRuns = await inScope(p.pdb, "runs").where("unit_name", "=", u.name).orderBy("id", "desc").execute();
  const recent = (await runRows(p, unitRuns.slice(0, 30))).map(runItem);
  const today = tally(unitRuns.filter((r) => r.started_at >= day));
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
    last24h: { runs: today.runs, costUsd: today.cost, ok: today.ok },
    recent,
  };
}

export type MemberView = Awaited<ReturnType<typeof memberView>>;
export type UnitView = Awaited<ReturnType<typeof unitView>>;
