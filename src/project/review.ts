import { all, get, run } from "../db/sqlite.js";
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

export function threads(p: Project, ticketId: number, opts: { role?: string; reviewId?: number } = {}): Thread[] {
  const rows = all<Omit<Thread, "blocking" | "comments"> & { blocking: number }>(
    p.db,
    `SELECT f.id, r.role, r.round, f.category, f.severity, f.blocking, f.path, f.line, f.body, f.status
     FROM findings f JOIN reviews r ON r.id = f.review_id
     WHERE r.ticket_id = ? ${opts.role ? "AND r.role = ?" : ""} ${opts.reviewId ? "AND r.id = ?" : ""} ORDER BY f.id`,
    [ticketId, ...(opts.role ? [opts.role] : []), ...(opts.reviewId ? [opts.reviewId] : [])],
  );
  return rows.map((f) => ({
    ...f,
    blocking: !!f.blocking,
    comments: all<{ member_id: number | null; role: string; action: string; body: string; at: string }>(
      p.db,
      "SELECT member_id, role, action, body, at FROM finding_comments WHERE finding_id = ? ORDER BY id",
      [f.id],
    ).map((c) => ({ who: c.member_id ? p.member(c.member_id).name : c.role === "lead" ? p.fixedMember("lead").name : "責任者", role: c.role, action: c.action, body: c.body, at: c.at })),
  }));
}

/** 開発が返事をしなければならない指摘(必須で、未対応か再オープン・再発したもの)。 */
export function mustAnswer(p: Project, ticketId: number): Thread[] {
  return threads(p, ticketId).filter((t) => t.blocking && (t.status === "open" || t.status === "recurred"));
}

/** 開発が見てもよい提案(nit)。返事は任意。 */
export function openNits(p: Project, ticketId: number): Thread[] {
  return threads(p, ticketId).filter((t) => !t.blocking && t.status === "open");
}

/** 再レビューでレビュアーが答えなければならない、その役割の前回までの必須の指摘。 */
export function mustResolve(p: Project, ticketId: number, role: string): Thread[] {
  return threads(p, ticketId, { role }).filter((t) => t.blocking && ["open", "recurred", "addressed", "disputed"].includes(t.status));
}

export function comment(p: Project, findingId: number, who: { memberId: number | null; role: string }, action: string, body = ""): void {
  run(p.db, "INSERT INTO finding_comments (finding_id, member_id, role, action, body, at) VALUES (?, ?, ?, ?, ?, ?)", [findingId, who.memberId, who.role, action, body, p.now()]);
}

export function setStatus(p: Project, findingId: number, status: string): void {
  run(p.db, "UPDATE findings SET status = ? WHERE id = ?", [status, findingId]);
}

/** そのチケットをその役割で最後にレビューした人(再レビューは同じ人に頼む)。 */
export function lastReviewer(p: Project, ticketId: number, role: string): number | null {
  return get<{ member_id: number }>(p.db, "SELECT r.member_id FROM reviews rv JOIN runs r ON r.id = rv.run_id WHERE rv.ticket_id = ? AND rv.role = ? ORDER BY rv.id DESC LIMIT 1", [ticketId, role])?.member_id ?? null;
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
