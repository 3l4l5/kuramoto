import { iso } from "../clock.js";
import { sql, type SqlBool } from "kysely";
import { run } from "../db/sqlite.js";
import { dialect } from "../db/dialect/index.js";
import type { Pull } from "../domain/formation.js";
import type { Role } from "../domain/roles.js";
import type { Project } from "./project.js";

/**
 * メッセージの種類。
 * - implement: 新しいチケットを実装する(開発へ)
 * - fix: 差し戻しや衝突を持ち主が直す(開発へ、宛先は持ち主)
 * - review / sec / qa: 各工程の確認
 * - decide: 判断をリーダーへ上げる
 * - answer: 判断の結果を持ち主へ返す
 * - plan: 企画スタジオの担当(企画・デザイナー・アーキテクト・リーダー)へ。チケットを持たない
 * - chat: 責任者からリーダーへのチャット(非同期)。チケットを持たない
 * - triage: リーダーの交通整理(チケットの順番と担当を決める)。チケットを持たない
 * - unstick: 詰まったチケットの手助けをリーダーへ(原因を調べ、やり直させるか保留する)
 * - patrol: リーダーの定期の見回り(重複と、回り続けているチケットに手を打つ)。チケットを持たない
 * - member_chat: 責任者からメンバーへの話しかけ。宛先はそのメンバー。チケットは持たない(チケットの 1 チケット 1 起動を邪魔しない。ひも付けは payload)
 * - ask: 島への質問・相談(R16)。経路のある島の手すきの人が答える。チケットは持たない(質問のひも付けは payload の questionId)。答えは道具 reply で返す
 */
export type MessageKind = "implement" | "fix" | "review" | "sec" | "qa" | "decide" | "answer" | "plan" | "chat" | "triage" | "unstick" | "patrol" | "member_chat" | "ask";

export type MessageRow = {
  id: number;
  ticket_id: number | null;
  to_role: Role;
  to_member_id: number | null;
  kind: MessageKind;
  payload: string;
  status: "pending" | "claimed" | "done" | "failed";
  available_at: string;
  attempts: number;
  created_at: string;
  claimed_at: string | null;
  last_error: string | null;
};

/**
 * 受信箱に 1 通入れる。
 * 同期のまま(まだ非同期に移していない workflow などの書き込みの途中から呼ばれるため)。非同期への移行の 2/2 で async にする。
 * project_id は書く側で入れる(ADR-0037)。
 */
export function send(
  p: Project,
  m: { ticketId: number | null; toRole: Role; toMemberId?: number | null; kind: MessageKind; payload?: Record<string, unknown>; delayMs?: number },
): number {
  const at = iso(new Date(p.clock.now().getTime() + (m.delayMs ?? 0)));
  return run(
    p.db,
    "INSERT INTO messages (project_id, ticket_id, to_role, to_member_id, kind, payload, available_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    [p.projectId, m.ticketId, m.toRole, m.toMemberId ?? null, m.kind, JSON.stringify(m.payload ?? {}), at, p.now()],
  ).lastId;
}

/**
 * 仕事の取り方(ADR-0007)ごとの並び順。
 * - 下流優先: 判断 → QA → セキュリティ → レビュー → 直し → 新しい実装(仕掛かりを先に片付ける)
 * - 着手優先: 新しい実装を先に取る。開発の中では直しを新しい実装より先にする(docs/design.md 5.2)
 */
const ORDER: Record<Pull, MessageKind[]> = {
  down: ["member_chat", "ask", "chat", "triage", "patrol", "plan", "unstick", "answer", "decide", "qa", "sec", "review", "fix", "implement"],
  start: ["member_chat", "ask", "chat", "triage", "patrol", "plan", "unstick", "answer", "decide", "fix", "implement", "review", "sec", "qa"],
};

function orderSql(pull: Pull) {
  return sql.raw(`CASE m.kind ${ORDER[pull].map((k, i) => `WHEN '${k}' THEN ${i}`).join(" ")} ELSE 99 END`);
}

/**
 * 同じ場所を触るチケットのうち、もう開発に取りかかっていて、まだ終わっていないもの(ADR-0024)。
 * これが残っている間は、このチケットの実装を始めない(先の方が merge されてから、新しい main の上で始める)。
 * 「取りかかった」は、開発の起動がある・実装の仕事を取り出し済み、のどちらか。
 */
export const AREA_BUSY_SQL = `EXISTS (
  SELECT 1 FROM ticket_areas a JOIN ticket_areas b ON b.area = a.area AND b.ticket_id <> a.ticket_id
  JOIN tickets o ON o.id = b.ticket_id
  WHERE a.ticket_id = %T AND o.stage NOT IN ('done','dropped')
    AND (EXISTS (SELECT 1 FROM runs r WHERE r.ticket_id = o.id AND r.role = 'dev')
      OR EXISTS (SELECT 1 FROM messages mm WHERE mm.ticket_id = o.id AND mm.kind = 'implement' AND mm.status = 'claimed'))
)`;

/**
 * 受信箱から 1 通取り出す。取り出しは方言の助け(dialect.claimMessage)で、他の取り出しと重ならない 1 文にする(SQLite は 1 文の UPDATE)。
 * 他の起動がまだ終わっていないチケット宛てのものは飛ばす(1 チケット 1 起動)。
 * 同じ場所を触るチケットが先に進んでいれば、まだ取りかかっていないチケットの実装は始めない(ADR-0024)。
 */
export async function claimNext(p: Project, opts: { exclude?: number[]; planningOnly?: boolean; triage?: boolean; noPlan?: boolean } = {}): Promise<MessageRow | undefined> {
  const pull = p.currentFormation().pull;
  const exclude = opts.exclude ?? [];
  const now = p.now();
  const k = p.pdb.k;
  let candidate = k
    .selectFrom("messages as m")
    .select("m.id")
    .where("m.project_id", "=", p.projectId)
    .where("m.status", "=", "pending")
    .where("m.available_at", "<=", now)
    .where(sql<SqlBool>`NOT EXISTS (SELECT 1 FROM runs r WHERE r.ticket_id = m.ticket_id AND r.ended_at IS NULL)`)
    .where(sql<SqlBool>`NOT (m.ticket_id IS NULL AND m.kind NOT IN ('member_chat','ask') AND EXISTS (SELECT 1 FROM runs r WHERE r.ticket_id IS NULL AND r.role = m.to_role AND r.ended_at IS NULL))`)
    .where(sql<SqlBool>`NOT (m.kind = 'member_chat' AND EXISTS (SELECT 1 FROM runs r WHERE r.member_id = m.to_member_id AND r.ended_at IS NULL))`);
  if (opts.planningOnly) candidate = candidate.where("m.ticket_id", "is", null);
  if (opts.noPlan) candidate = candidate.where("m.kind", "<>", "plan");
  if (opts.triage) {
    candidate = candidate
      .where(sql<SqlBool>`NOT ((m.kind = 'implement' OR ${dialect.jsonExtract("m.payload", "preDev")} = 1) AND EXISTS (SELECT 1 FROM tickets t WHERE t.id = m.ticket_id AND t.triaged = 0))`)
      .where(sql<SqlBool>`NOT (m.kind = 'implement' AND EXISTS (SELECT 1 FROM ticket_deps d JOIN tickets b ON b.id = d.depends_on WHERE d.ticket_id = m.ticket_id AND b.stage NOT IN ('done','dropped')))`)
      .where(sql<SqlBool>`NOT (m.kind = 'implement' AND NOT EXISTS (SELECT 1 FROM runs r0 WHERE r0.ticket_id = m.ticket_id AND r0.role = 'dev') AND ${sql.raw(AREA_BUSY_SQL.replace("%T", "m.ticket_id"))})`);
  }
  if (exclude.length) candidate = candidate.where("m.id", "not in", exclude);
  candidate = candidate.orderBy(orderSql(pull)).orderBy("m.available_at").orderBy("m.id").limit(1);
  return (await dialect.claimMessage(k, candidate, now)) as MessageRow | undefined;
}

export async function complete(p: Project, id: number): Promise<void> {
  await p.pdb.update("messages", { status: "done" }).where("id", "=", id).execute();
}

/** 起動できなかった(人手が足りない等)。試行回数を戻して後で取り直す。 */
export async function release(p: Project, id: number, delayMs: number): Promise<void> {
  const at = iso(new Date(p.clock.now().getTime() + delayMs));
  await p.pdb.update("messages", { status: "pending", claimed_at: null, attempts: sql`attempts - 1`, available_at: at }).where("id", "=", id).execute();
}

/**
 * 失敗した。上限までは間を空けて再試行し、尽きたら failed にする。
 * @returns 再試行が尽きたら true
 */
export async function fail(p: Project, msg: MessageRow, error: string): Promise<boolean> {
  const max = p.settingNumber("max_attempts", 3);
  if (msg.attempts >= max) {
    await p.pdb.update("messages", { status: "failed", last_error: error }).where("id", "=", msg.id).execute();
    return true;
  }
  const backoffMs = 30_000 * 2 ** (msg.attempts - 1);
  const at = iso(new Date(p.clock.now().getTime() + backoffMs));
  await p.pdb.update("messages", { status: "pending", claimed_at: null, last_error: error, available_at: at }).where("id", "=", msg.id).execute();
  return false;
}

/** 起動中に Kuramoto が落ちたときの取りこぼしを戻す。起動時に 1 回呼ぶ。 */
export async function recoverStale(p: Project): Promise<number> {
  return p.pdb.transaction(async () => {
    await p.pdb.update("runs", { ended_at: p.now(), outcome: "abandoned", error: "Kuramoto が止まっていました" }).where("ended_at", "is", null).execute();
    const r = await p.pdb.update("messages", { status: "pending", claimed_at: null }).where("status", "=", "claimed").executeTakeFirst();
    return Number(r.numUpdatedRows);
  });
}

export async function pendingCount(p: Project, kinds: MessageKind[]): Promise<number> {
  const row = await p.pdb.k
    .selectFrom("messages")
    .select((eb) => eb.fn.countAll<number>().as("n"))
    .where("project_id", "=", p.projectId)
    .where("status", "=", "pending")
    .where("kind", "in", kinds)
    .executeTakeFirst();
  return Number(row?.n ?? 0);
}
