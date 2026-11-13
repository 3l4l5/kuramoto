import { ROLE_LABEL, type Role } from "../domain/roles.js";
import type { Project } from "./project.js";

/**
 * レビューのスレッド(docs/design.md 5.2)。実際の PR レビューに寄せて、指摘 1 件ごとにやりとりを残す。
 * - 指摘は「必須(blocking)」と「提案(nit)」に分ける。差し戻しになるのは必須が残っているときだけ。
 * - 開発は必須の指摘 1 件ずつに「直した」か「直さない(理由)」で返事をする。
 * - 再レビューは同じレビュアーが、前回の指摘に「解決」「直さないのを了承」「まだ(再オープン)」で答え、前回からの変更を中心に見る。
 * - 「直さない」に対してレビュアーが再オープンしたら意見が割れたとして、リーダーが裁定する。
 *
 * 指摘の状態: open(未対応)→ addressed(直したと返事)/ disputed(直さないと返事)→ fixed(解決)/ wontfix(了承・裁定)/ open(再オープン)
 */

export type ThreadComment = { who: string; role: string; action: string; body: string; at: string };
export type Thread = {
  id: number;
  role: string;
  round: number;
  category: string;
  severity: string;
  blocking: boolean;
  path: string | null;
  line: number | null;
  body: string;
  status: string;
  comments: ThreadComment[];
};

const ACTION_LABEL: Record<string, string> = {
  raised: "指摘",
  fixed: "直した",
  wontfix: "直さない",
  resolved: "解決を確認",
  accepted: "直さないのを了承",
  reopened: "まだ直っていない",
  ruled: "裁定",
};

export async function threads(p: Project, ticketId: number, opts: { role?: string; reviewId?: number } = {}): Promise<Thread[]> {
  let q = p.pdb.k
    .selectFrom("findings as f")
    .innerJoin("reviews as r", "r.id", "f.review_id")
    .select(["f.id", "r.role", "r.round", "f.category", "f.severity", "f.blocking", "f.path", "f.line", "f.body", "f.status"])
    .where("f.project_id", "=", p.projectId)
    .where("r.project_id", "=", p.projectId)
    .where("r.ticket_id", "=", ticketId);
  if (opts.role) q = q.where("r.role", "=", opts.role);
  if (opts.reviewId) q = q.where("r.id", "=", opts.reviewId);
  const rows = await q.orderBy("f.id").execute();
  if (rows.length === 0) return [];
  // 指摘ごとのやりとりは、1 文でまとめて取る
  const cs = await p.pdb
    .from("finding_comments")
    .select(["finding_id", "member_id", "role", "action", "body", "at"])
    .where(
      "finding_id",
      "in",
      rows.map((f) => f.id),
    )
    .orderBy("id")
    .execute();
  const byFinding = new Map<number, ThreadComment[]>();
  for (const c of cs) {
    const list = byFinding.get(c.finding_id) ?? [];
    list.push({ who: c.member_id ? p.member(c.member_id).name : c.role === "lead" ? p.fixedMember("lead").name : "責任者", role: c.role, action: c.action, body: c.body, at: c.at });
    byFinding.set(c.finding_id, list);
  }
  return rows.map((f) => ({ ...f, blocking: !!f.blocking, comments: byFinding.get(f.id) ?? [] }));
}

/** 開発が返事をしなければならない指摘(必須で、未対応か再オープン・再発したもの)。 */
export async function mustAnswer(p: Project, ticketId: number): Promise<Thread[]> {
  return (await threads(p, ticketId)).filter((t) => t.blocking && (t.status === "open" || t.status === "recurred"));
}

/** 開発が見てもよい提案(nit)。返事は任意。 */
export async function openNits(p: Project, ticketId: number): Promise<Thread[]> {
  return (await threads(p, ticketId)).filter((t) => !t.blocking && t.status === "open");
}

/** 再レビューでレビュアーが答えなければならない、その役割の前回までの必須の指摘。 */
export async function mustResolve(p: Project, ticketId: number, role: string): Promise<Thread[]> {
  return (await threads(p, ticketId, { role })).filter((t) => t.blocking && ["open", "recurred", "addressed", "disputed"].includes(t.status));
}

export async function comment(p: Project, findingId: number, who: { memberId: number | null; role: string }, action: string, body = ""): Promise<void> {
  await p.pdb.insert("finding_comments", { finding_id: findingId, member_id: who.memberId, role: who.role, action, body, at: p.now() }).execute();
}

export async function setStatus(p: Project, findingId: number, status: string): Promise<void> {
  await p.pdb.update("findings", { status }).where("id", "=", findingId).execute();
}

/** そのチケットをその役割で最後にレビューした人(再レビューは同じ人に頼む)。 */
export async function lastReviewer(p: Project, ticketId: number, role: string): Promise<number | null> {
  const row = await p.pdb.k
    .selectFrom("reviews as rv")
    .innerJoin("runs as r", "r.id", "rv.run_id")
    .select("r.member_id")
    .where("rv.project_id", "=", p.projectId)
    .where("r.project_id", "=", p.projectId)
    .where("rv.ticket_id", "=", ticketId)
    .where("rv.role", "=", role)
    .orderBy("rv.id", "desc")
    .limit(1)
    .executeTakeFirst();
  return row?.member_id ?? null;
}

/** 担当への指示に入れる、スレッドの書き方。 */
export function threadText(t: Thread): string {
  const where = t.path ? ` ${t.path}${t.line ? `:${t.line}` : ""}` : "";
  const head = `- 指摘 ${t.id} [${ROLE_LABEL[t.role as Role] ?? t.role}・${t.blocking ? "必須" : "提案"}・${t.severity}]${where}: ${t.body}`;
  const thread = t.comments
    .filter((c) => c.action !== "raised")
    .map((c) => `    - ${c.who}(${ACTION_LABEL[c.action] ?? c.action})${c.body ? `: ${c.body}` : ""}`)
    .join("\n");
  return thread ? `${head}\n${thread}` : head;
}

export { ACTION_LABEL };
