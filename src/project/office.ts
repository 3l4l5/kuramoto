import { all, get } from "../db/sqlite.js";
import { MODELS, ROLE_LABEL, WORK_ROLES, type Role, type WorkRole } from "../domain/roles.js";
import { ticketRepo } from "./dispatcher.js";
import { autoMergeEnabled, suggestedMergeOrder } from "./merge.js";
import { areaWait, blockers, mergeBlockers, mergeUnblocks } from "./triage.js";
import { unitExhausted, unitSpentUsd } from "./budget.js";
import { runWork } from "./progress.js";
import type { MemberRow, Project, TicketRow } from "./project.js";

/**
 * バーチャルオフィス(docs/design.md 6.3)に描く中身。島・席・メンバーの今の仕事・待ちの書類・merge 待ちの棚を、記録から組み立てる。
 */

export const KIND_LABEL: Record<string, string> = { implement: "実装", fix: "直し", answer: "続き", review: "レビュー", sec: "セキュリティ確認", qa: "QA", decide: "判断", plan: "企画", chat: "チャットの返事", triage: "交通整理", unstick: "詰まりの調査", member_chat: "メンバーとの会話" };

type Work = {
  ticket: number | null;
  title: string | null;
  kind: string;
  role: string;
  model: string;
  live: string | null;
  lastStep: string | null;
  startedAt: string;
  lastActivityAt: string;
};

export function workOf(p: Project, member: MemberRow): Work | null {
  const r = get<{ id: number; ticket_id: number | null; role: string; model: string | null; kind: string }>(
    p.db,
    "SELECT r.id, COALESCE(r.ticket_id, r.about_ticket_id) AS ticket_id, r.role, r.model, m.kind FROM runs r JOIN messages m ON m.id = r.message_id WHERE r.member_id = ? AND r.ended_at IS NULL ORDER BY r.id DESC LIMIT 1",
    [member.id],
  );
  if (!r) return null;
  const w = runWork(p, r.id, 1);
  const t = r.ticket_id ? p.ticket(r.ticket_id) : null;
  const model = r.model ?? p.policy(r.role as Role).model;
  return {
    ticket: t?.number ?? null,
    title: t?.title ?? null,
    kind: KIND_LABEL[r.kind] ?? r.kind,
    role: ROLE_LABEL[r.role as Role] ?? r.role,
    model: MODELS[model as keyof typeof MODELS]?.label ?? model,
    live: w?.live ?? null,
    lastStep: w?.steps.at(-1)?.text ?? null,
    startedAt: w?.startedAt ?? new Date().toISOString(),
    lastActivityAt: w?.lastActivityAt ?? new Date().toISOString(),
  };
}

export function officeView(p: Project) {
  const f = p.currentFormation();
  const tickets = new Map(p.tickets().map((t) => [t.id, t]));
  const isWork = (r: string): r is WorkRole => (WORK_ROLES as readonly string[]).includes(r);

  // 待ちの書類: 取り出されていないチケットの仕事を、受け持つ島に積む(持ち主宛ては持ち主の島に)。
  // 先に終わらせるチケットを待っているもの・交通整理がまだのものは、すぐには取れないので「順番待ち」に分ける
  const waiting = new Map<number, number[]>();
  const queued = new Map<number, { number: number; why: string }[]>();
  for (const m of all<{ ticket_id: number; to_role: string; to_member_id: number | null; kind: string }>(
    p.db,
    "SELECT ticket_id, to_role, to_member_id, kind FROM messages WHERE status = 'pending' AND ticket_id IS NOT NULL ORDER BY id",
  )) {
    if (!isWork(m.to_role)) continue;
    const t = tickets.get(m.ticket_id);
    if (!t || t.stage === "done" || t.stage === "dropped") continue;
    const repo = ticketRepo(p, t)?.full_name;
    const home = m.to_member_id ? p.member(m.to_member_id).unit_id : null;
    const unit = f.units.find((u) => u.id === home && u.roles.includes(m.to_role as WorkRole)) ?? p.unitsForRole(m.to_role as WorkRole, repo)[0];
    if (!unit) continue;
    const triaged = get<{ triaged: number }>(p.db, "SELECT triaged FROM tickets WHERE id = ?", [t.id])?.triaged ?? 1;
    const before = m.kind === "implement" ? blockers(p, t.id) : [];
    const same = m.kind === "implement" ? areaWait(p, t.id) : [];
    if (m.kind === "implement" && (!triaged || before.length || same.length)) {
      const merging = mergeBlockers(p, t.id);
      const why = !triaged
        ? "交通整理待ち"
        : merging.length
          ? `#${merging.join("・#")} の merge 待ち`
          : before.length
            ? `#${before.join("・#")} の完了待ち`
            : `同じ場所(${[...new Set(same.flatMap((s) => s.areas))].join("・")})を触る #${same.map((s) => s.number).join("・#")} の完了待ち`;
      queued.set(unit.id, [...(queued.get(unit.id) ?? []), { number: t.number, why }]);
      continue;
    }
    waiting.set(unit.id, [...(waiting.get(unit.id) ?? []), t.number]);
  }

  // 書類の居場所(島 / 判断待ち / merge 待ち / 完了)。画面はこれの変化を見て、書類を飛ばす
  const where: Record<number, string> = {};
  for (const [unitId, nums] of waiting) for (const n of nums) where[n] = `unit:${unitId}`;
  for (const [unitId, qs] of queued) for (const q of qs) where[q.number] = `unit:${unitId}`;

  const units = f.units.map((u) => ({
    id: u.id,
    name: u.name,
    roles: u.roles.map((r) => ROLE_LABEL[r]),
    roleKeys: u.roles,
    max: u.max_members,
    repos: u.repos,
    model: u.model ? (MODELS[u.model as keyof typeof MODELS]?.label ?? u.model) : null,
    budget: { budgetUsd: u.budget_usd, spentUsd: unitSpentUsd(p, u.name), exhausted: unitExhausted(p, u) },
    members: p.membersOfUnit(u.id).map((m) => {
      const work = workOf(p, m);
      if (work?.ticket) where[work.ticket] = `unit:${u.id}`;
      return { id: m.id, name: m.name, helper: !m.is_base, joinedAt: m.joined_at, work };
    }),
    waiting: waiting.get(u.id) ?? [],
    queued: queued.get(u.id) ?? [],
  }));

  const fixed = (role: Role) => {
    const m = p.fixedMember(role);
    return { id: m.id, name: m.name, work: workOf(p, m) };
  };
  const decisions = [...tickets.values()].filter((t) => t.stage === "decision");
  for (const t of decisions) where[t.number] ??= "lead";
  const mergeQueue = suggestedMergeOrder(p);
  const unblocks = mergeUnblocks(p);
  for (const t of mergeQueue) where[t.number] = "merge";
  const done = [...tickets.values()].filter((t) => t.stage === "done").sort((a, b) => String(b.done_at).localeCompare(String(a.done_at)));
  for (const t of done) where[t.number] = "done";

  return {
    units,
    lead: { ...fixed("lead"), decisions: decisions.map((t) => t.number) },
    architect: fixed("architect"),
    mergeQueue: mergeQueue.map((t: TicketRow) => ({ id: t.id, number: t.number, title: t.title, unblocks: unblocks.get(t.id) ?? null })),
    done: { count: done.length, recent: done.slice(0, 12).map((t) => t.number) },
    autoMerge: autoMergeEnabled(p),
    where,
  };
}

export type OfficeView = ReturnType<typeof officeView>;
