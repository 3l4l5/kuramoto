import { iso } from "../clock.js";
import { get, run, tx } from "../db/sqlite.js";
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
 */
export type MessageKind = "implement" | "fix" | "review" | "sec" | "qa" | "decide" | "answer" | "plan" | "chat" | "triage" | "unstick" | "patrol";

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

export function send(
  p: Project,
  m: { ticketId: number | null; toRole: Role; toMemberId?: number | null; kind: MessageKind; payload?: Record<string, unknown>; delayMs?: number },
): number {
  const at = iso(new Date(p.clock.now().getTime() + (m.delayMs ?? 0)));
  return run(
    p.db,
    "INSERT INTO messages (ticket_id, to_role, to_member_id, kind, payload, available_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [m.ticketId, m.toRole, m.toMemberId ?? null, m.kind, JSON.stringify(m.payload ?? {}), at, p.now()],
  ).lastId;
}

/**
 * 仕事の取り方(ADR-0007)ごとの並び順。
 * - 下流優先: 判断 → QA → セキュリティ → レビュー → 直し → 新しい実装(仕掛かりを先に片付ける)
 * - 着手優先: 新しい実装を先に取る。開発の中では直しを新しい実装より先にする(docs/design.md 5.2)
 */
const ORDER: Record<Pull, MessageKind[]> = {
  down: ["chat", "triage", "patrol", "plan", "unstick", "answer", "decide", "qa", "sec", "review", "fix", "implement"],
  start: ["chat", "triage", "patrol", "plan", "unstick", "answer", "decide", "fix", "implement", "review", "sec", "qa"],
};

function orderSql(pull: Pull): string {
  return `CASE kind ${ORDER[pull].map((k, i) => `WHEN '${k}' THEN ${i}`).join(" ")} ELSE 99 END`;
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
 * 受信箱から 1 通取り出す。取り出しは 1 文の UPDATE で行い、二重に取られないようにする。
 * 他の起動がまだ終わっていないチケット宛てのものは飛ばす(1 チケット 1 起動)。
 * 同じ場所を触るチケットが先に進んでいれば、まだ取りかかっていないチケットの実装は始めない(ADR-0024)。
 */
export function claimNext(p: Project, opts: { exclude?: number[]; planningOnly?: boolean; triage?: boolean; noPlan?: boolean } = {}): MessageRow | undefined {
  const pull = p.currentFormation().pull;
  const exclude = opts.exclude ?? [];
  return get<MessageRow>(
    p.db,
    `UPDATE messages SET status = 'claimed', claimed_at = ?, attempts = attempts + 1
     WHERE id = (
       SELECT m.id FROM messages m
       WHERE m.status = 'pending' AND m.available_at <= ?
         AND NOT EXISTS (SELECT 1 FROM runs r WHERE r.ticket_id = m.ticket_id AND r.ended_at IS NULL)
         AND NOT (m.ticket_id IS NULL AND EXISTS (SELECT 1 FROM runs r WHERE r.ticket_id IS NULL AND r.role = m.to_role AND r.ended_at IS NULL))
         ${opts.planningOnly ? "AND m.ticket_id IS NULL" : ""}
         ${opts.noPlan ? "AND m.kind <> 'plan'" : ""}
         ${
           opts.triage
             ? `AND NOT (m.kind = 'implement' AND EXISTS (SELECT 1 FROM tickets t WHERE t.id = m.ticket_id AND t.triaged = 0))
         AND NOT (m.kind = 'implement' AND EXISTS (SELECT 1 FROM ticket_deps d JOIN tickets b ON b.id = d.depends_on WHERE d.ticket_id = m.ticket_id AND b.stage NOT IN ('done','dropped')))
         AND NOT (m.kind = 'implement' AND NOT EXISTS (SELECT 1 FROM runs r0 WHERE r0.ticket_id = m.ticket_id AND r0.role = 'dev') AND ${AREA_BUSY_SQL.replace("%T", "m.ticket_id")})`
             : ""
         }
         ${exclude.length ? `AND m.id NOT IN (${exclude.map(() => "?").join(",")})` : ""}
       ORDER BY ${orderSql(pull)}, m.available_at, m.id
       LIMIT 1
     )
     RETURNING *`,
    [p.now(), p.now(), ...exclude],
  );
}

export function complete(p: Project, id: number): void {
  run(p.db, "UPDATE messages SET status = 'done' WHERE id = ?", [id]);
}

/** 起動できなかった(人手が足りない等)。試行回数を戻して後で取り直す。 */
export function release(p: Project, id: number, delayMs: number): void {
  const at = iso(new Date(p.clock.now().getTime() + delayMs));
  run(p.db, "UPDATE messages SET status = 'pending', claimed_at = NULL, attempts = attempts - 1, available_at = ? WHERE id = ?", [at, id]);
}

/**
 * 失敗した。上限までは間を空けて再試行し、尽きたら failed にする。
 * @returns 再試行が尽きたら true
 */
export function fail(p: Project, msg: MessageRow, error: string): boolean {
  const max = p.settingNumber("max_attempts", 3);
  if (msg.attempts >= max) {
    run(p.db, "UPDATE messages SET status = 'failed', last_error = ? WHERE id = ?", [error, msg.id]);
    return true;
  }
  const backoffMs = 30_000 * 2 ** (msg.attempts - 1);
  const at = iso(new Date(p.clock.now().getTime() + backoffMs));
  run(p.db, "UPDATE messages SET status = 'pending', claimed_at = NULL, last_error = ?, available_at = ? WHERE id = ?", [error, at, msg.id]);
  return false;
}

/** 起動中に Kuramoto が落ちたときの取りこぼしを戻す。起動時に 1 回呼ぶ。 */
export function recoverStale(p: Project): number {
  return tx(p.db, () => {
    run(p.db, "UPDATE runs SET ended_at = ?, outcome = 'abandoned', error = 'Kuramoto が止まっていました' WHERE ended_at IS NULL", [p.now()]);
    return run(p.db, "UPDATE messages SET status = 'pending', claimed_at = NULL WHERE status = 'claimed'").changes;
  });
}

export function pendingCount(p: Project, kinds: MessageKind[]): number {
  return (
    get<{ n: number }>(p.db, `SELECT COUNT(*) AS n FROM messages WHERE status = 'pending' AND kind IN (${kinds.map(() => "?").join(",")})`, kinds)?.n ?? 0
  );
}
