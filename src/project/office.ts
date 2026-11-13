import { all, get } from "../db/sqlite.js";
import { MODELS, ROLE_LABEL, WORK_ROLES, type Role, type WorkRole } from "../domain/roles.js";
import { flowFor, KIND_LABEL as TICKET_KIND_LABEL, TICKET_KINDS } from "../domain/flow.js";
import { routesAmong } from "../domain/route.js";
import { ticketRepo } from "./dispatcher.js";
import { autoMergeEnabled, suggestedMergeOrder } from "./merge.js";
import { areaWait, blockers, mergeBlockers, mergeUnblocks } from "./triage.js";
import { sql } from "kysely";
import { unitExhausted, unitSpentUsd } from "./budget.js";
import { runWorks } from "./progress.js";
import type { MemberRow, Project, TicketRow } from "./project.js";

/**
 * バーチャルオフィス(docs/design.md 6.3)に描く中身。島・席・メンバーの今の仕事・待ちの書類・merge 待ちの棚を、記録から組み立てる。
 */

export const KIND_LABEL: Record<string, string> = { implement: "実装", fix: "直し", answer: "続き", review: "レビュー", sec: "セキュリティ確認", qa: "QA", decide: "判断", plan: "企画", chat: "チャットの返事", triage: "交通整理", unstick: "詰まりの調査", member_chat: "メンバーとの会話", ask: "質問への答え" };

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

/** メンバーごとの、いまの仕事(終わっていない起動)。起動と途中経過は、メンバー全員ぶんをまとめて 2〜3 回で引く。 */
export async function workOfMany(p: Project, members: MemberRow[]): Promise<Map<number, Work | null>> {
  const out = new Map<number, Work | null>(members.map((m) => [m.id, null]));
  if (!members.length) return out;
  const rows = await p.pdb.k
    .selectFrom("runs as r")
    .innerJoin("messages as m", "m.id", "r.message_id")
    .select(["r.id", "r.member_id", sql<number | null>`COALESCE(r.ticket_id, r.about_ticket_id)`.as("ticket_id"), "r.role", "r.model", "m.kind"])
    .where("r.project_id", "=", p.pdb.projectId)
    .where("r.member_id", "in", members.map((m) => m.id))
    .where("r.ended_at", "is", null)
    .orderBy("r.id", "desc")
    .execute();
  const latest = new Map<number, (typeof rows)[number]>(); // メンバー → いちばん新しい起動
  for (const r of rows) if (!latest.has(r.member_id)) latest.set(r.member_id, r);
  const works = await runWorks(p, [...latest.values()].map((r) => r.id), 1);
  for (const [memberId, r] of latest) {
    const w = works.get(r.id);
    const t = r.ticket_id ? p.ticket(r.ticket_id) : null;
    const model = r.model ?? p.policy(r.role as Role).model;
    out.set(memberId, {
      ticket: t?.number ?? null,
      title: t?.title ?? null,
      kind: KIND_LABEL[r.kind] ?? r.kind,
      role: ROLE_LABEL[r.role as Role] ?? r.role,
      model: MODELS[model as keyof typeof MODELS]?.label ?? model,
      live: w?.live ?? null,
      lastStep: w?.steps.at(-1)?.text ?? null,
      startedAt: w?.startedAt ?? new Date().toISOString(),
      lastActivityAt: w?.lastActivityAt ?? new Date().toISOString(),
    });
  }
  return out;
}

export async function workOf(p: Project, member: MemberRow): Promise<Work | null> {
  return (await workOfMany(p, [member])).get(member.id) ?? null;
}

export async function officeView(p: Project) {
  const f = p.currentFormation();
  const works = await workOfMany(p, [...f.units.flatMap((u) => p.membersOfUnit(u.id)), p.fixedMember("lead"), p.fixedMember("architect")]);
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
    const repo = (await ticketRepo(p, t))?.full_name;
    const home = m.to_member_id ? p.member(m.to_member_id).unit_id : null;
    const unit = f.units.find((u) => u.id === home && u.roles.includes(m.to_role as WorkRole)) ?? p.unitsForRole(m.to_role as WorkRole, repo)[0];
    if (!unit) continue;
    const triaged = get<{ triaged: number }>(p.db, "SELECT triaged FROM tickets WHERE id = ?", [t.id])?.triaged ?? 1;
    const before = m.kind === "implement" ? await blockers(p, t.id) : [];
    const same = m.kind === "implement" ? await areaWait(p, t.id) : [];
    if (m.kind === "implement" && (!triaged || before.length || same.length)) {
      const merging = await mergeBlockers(p, t.id);
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
      const work = works.get(m.id) ?? null;
      if (work?.ticket) where[work.ticket] = `unit:${u.id}`;
      return { id: m.id, name: m.name, helper: !m.is_base, joinedAt: m.joined_at, work };
    }),
    waiting: waiting.get(u.id) ?? [],
    queued: queued.get(u.id) ?? [],
  }));

  const fixed = (role: Role) => {
    const m = p.fixedMember(role);
    return { id: m.id, name: m.name, work: works.get(m.id) ?? null };
  };
  const decisions = [...tickets.values()].filter((t) => t.stage === "decision");
  for (const t of decisions) where[t.number] ??= "lead";
  const mergeQueue = suggestedMergeOrder(p);
  const unblocks = await mergeUnblocks(p);
  for (const t of mergeQueue) where[t.number] = "merge";
  const done = [...tickets.values()].filter((t) => t.stage === "done").sort((a, b) => String(b.done_at).localeCompare(String(a.done_at)));
  for (const t of done) where[t.number] = "done";

  // 路線図(R16・R17): 流れ(停車の並び)が同じ種類は 1 本の路線にまとめ、島(駅)を通す。開発より前の工程は「申し送りだけ」の停車(pre)。
  // 既定の流れと同じ路線は「既定線」。既定の流れから飛ばした工程(島のあるもの)は skipped に入れ、「(QA を省略)」と添える
  const defaultFlow = flowFor(f.flows, null);
  const groups = new Map<string, { flow: WorkRole[]; kinds: { kind: string; label: string }[] }>();
  for (const kind of TICKET_KINDS) {
    const flow = flowFor(f.flows, kind);
    const g = groups.get(flow.join(">")) ?? { flow, kinds: [] };
    g.kinds.push({ kind, label: TICKET_KIND_LABEL[kind] });
    groups.set(flow.join(">"), g);
  }
  const lines = [...groups.values()].map(({ flow, kinds }) => {
    const devAt = flow.indexOf("dev");
    const stops = flow.flatMap((role, i) => {
      const u = f.units.find((x) => x.roles.includes(role));
      return u ? [{ unitId: u.id, role: ROLE_LABEL[role], pre: i < devAt }] : [];
    });
    const isDefault = flow.join(">") === defaultFlow.join(">");
    const skipped = isDefault ? [] : defaultFlow.filter((r) => !flow.includes(r) && f.units.some((u) => u.roles.includes(r))).map((r) => ROLE_LABEL[r]);
    return { kinds, isDefault, skipped, stops };
  });
  // 許されている連絡経路(端は駅の名前: unit:ID / lead / arch)。質問の封筒は、答えを待っている質問の経路を行き来する
  const ends = new Map<string, string>([["lead", "lead"], ["architect", "arch"], ...f.units.map((u): [string, string] => [u.name, `unit:${u.id}`])]);
  const routes = routesAmong(f.routes, [...ends.keys()])
    .filter((r) => r.mode === "ask")
    .map((r) => ({ a: ends.get(r.from)!, b: ends.get(r.to)! }));
  const asks = all<{ unit_id: number | null; to_target: string }>(
    p.db,
    "SELECT m.unit_id, q.to_target FROM ticket_questions q JOIN members m ON m.id = q.from_member_id WHERE q.answered_at IS NULL AND q.routed_to_lead = 0 AND m.unit_id IS NOT NULL",
  ).flatMap((q) => (ends.has(q.to_target) ? [{ a: `unit:${q.unit_id}`, b: ends.get(q.to_target)! }] : []));

  // 路線の上に置く札: 開いているチケットの種類(where の居場所と合わせて、その種類の路線の、いまの駅に置く)
  const ticketKinds: Record<number, string> = {};
  for (const t of tickets.values()) if (where[t.number] && where[t.number] !== "done") ticketKinds[t.number] = t.kind;

  return {
    lines,
    routes,
    ticketKinds,
    asks,
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
