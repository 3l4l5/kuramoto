import { z } from "zod";
import { all, get, run, tx } from "../db/sqlite.js";
import { MODELS, ROLE_LABEL, type Role } from "../domain/roles.js";
import { defineTool, type KuramotoTool } from "../harness/types.js";
import { send } from "./inbox.js";
import { sayToLead } from "./leadchat.js";
import { KIND_LABEL } from "./office.js";
import { runWork } from "./progress.js";
import type { MemberRow, Project, TicketRow } from "./project.js";

/**
 * メンバーとの会話。責任者がメンバーに話しかけると、受信箱の member_chat でそのメンバーを起こし、
 * 今のチケットのセッションで答える。終業中でも返事が来る(チケットを持たない仕事なので、チケットの受付が止まっていても取り出せる)。
 * - 話したことは member_messages に残る。
 * - 伝えたことは、そのチケットのメモ(ticket_notes kind = 'member')に書き足す。担当・工程は変わらない。
 * - 新しい仕事を頼まれたら、メンバーが hand_to_lead でリーダーの受信箱へ回す(そのときはチケットのメモには書かない)。
 */

export type MemberMessage = { id: number; who: "owner" | "member" | "system"; body: string; at: string; ticketId: number | null };

type MessageSql = { id: number; who: MemberMessage["who"]; body: string; at: string; ticket_id: number | null };

export type MemberChatPayload = { memberId: number };

function toMessage(r: MessageSql): MemberMessage {
  return { id: r.id, who: r.who, body: r.body, at: r.at, ticketId: r.ticket_id };
}

export function memberMessages(p: Project, memberId: number, limit = 200): MemberMessage[] {
  return all<MessageSql>(p.db, "SELECT id, who, body, at, ticket_id FROM (SELECT * FROM member_messages WHERE member_id = ? ORDER BY id DESC LIMIT ?) ORDER BY id", [memberId, limit]).map(toMessage);
}

/** 終わったチケット(merge 済み・取り下げ済み)。話しかけられても、メモは足さず答えるだけにする。 */
export function isFinishedTicket(t: Pick<TicketRow, "stage">): boolean {
  return t.stage === "done" || t.stage === "dropped";
}

/** メンバーが「今」持っているチケット: 起動中ならその起動のチケット、手すきなら直前に動いたチケット。話しかけた内容はここにひも付く。 */
export function currentTicketOf(p: Project, memberId: number): { ticketId: number; role: Role } | null {
  const r = get<{ ticket_id: number; role: Role }>(
    p.db,
    `SELECT COALESCE(ticket_id, about_ticket_id) AS ticket_id, role FROM runs
     WHERE member_id = ? AND COALESCE(ticket_id, about_ticket_id) IS NOT NULL
     ORDER BY (ended_at IS NULL) DESC, id DESC LIMIT 1`,
    [memberId],
  );
  return r ? { ticketId: r.ticket_id, role: r.role } : null;
}

function chatMember(p: Project, memberId: number): MemberRow {
  const m = p.member(memberId);
  if (!m || m.unit_id === null) throw new Error("このメンバーとは話せません(島のメンバーだけです)");
  return m;
}

const readKey = (memberId: number) => `member_chat_read:${memberId}`;

/** メンバーがまだ読んでいない責任者のメッセージ。 */
export function unreadForMember(p: Project, memberId: number): MemberMessage[] {
  const read = Number(p.setting(readKey(memberId)) ?? 0);
  return memberMessages(p, memberId).filter((m) => m.who === "owner" && m.id > read);
}

/** 責任者がメンバーに話しかける。メッセージを残し、受信箱でメンバーを起こす。 */
export function sayToMember(p: Project, memberId: number, body: string): void {
  const text = body.trim();
  if (!text) throw new Error("メッセージがありません");
  const m = chatMember(p, memberId);
  if (m.left_at !== null) throw new Error(`${m.name} は今は席にいません`);
  const cur = currentTicketOf(p, m.id);
  if (!cur) throw new Error(`${m.name} はまだチケットを受け持っていないので、話しかけられません`);
  tx(p.db, () => {
    run(p.db, "INSERT INTO member_messages (member_id, ticket_id, who, body, at) VALUES (?, ?, 'owner', ?, ?)", [m.id, cur.ticketId, text, p.now()]);
    // まだ取り出されていない呼び出しがあれば、そこにまとめる(何通書いても、メンバーは 1 回で読む)
    const pending = all<{ id: number }>(p.db, "SELECT id FROM messages WHERE kind = 'member_chat' AND status = 'pending' AND to_member_id = ?", [m.id]);
    if (!pending.length) send(p, { ticketId: null, toRole: cur.role, toMemberId: m.id, kind: "member_chat", payload: { memberId: m.id } satisfies MemberChatPayload });
  });
}

/** 返事を書き終えた(チケットのメモに残すところまで)。 */
export function finishMemberChat(p: Project, member: MemberRow, unread: MemberMessage[], reply: string, handedOver: boolean): void {
  const ticket = unread[0]?.ticketId ?? null;
  if (reply.trim()) run(p.db, "INSERT INTO member_messages (member_id, ticket_id, who, body, at) VALUES (?, ?, 'member', ?, ?)", [member.id, ticket, reply.trim(), p.now()]);
  // 終わったチケットには、もう次の仕事が無いのでメモを足さない(足しても誰にも読まれない)。答えるだけ
  if (ticket !== null && !handedOver && !isFinishedTicket(p.ticket(ticket))) {
    // 伝えたことは、そのチケットのメモに残る。次に仕事を始める担当(この人も)が読む
    for (const m of unread) p.addNote(m.ticketId ?? ticket, m.body, "owner", "member");
    run(p.db, "INSERT INTO member_messages (member_id, ticket_id, who, body, at) VALUES (?, ?, 'system', ?, ?)", [member.id, ticket, `#${p.ticket(ticket).number} のメモに書き足しました`, p.now()]);
  }
  const last = Math.max(...unread.map((m) => m.id));
  if (last > Number(p.setting(readKey(member.id)) ?? 0)) p.setSetting(readKey(member.id), String(last));
  // 返事の最中に書き足されたメッセージがあれば、続けて起こす
  if (unreadForMember(p, member.id).length && !get(p.db, "SELECT 1 AS x FROM messages WHERE kind = 'member_chat' AND status = 'pending' AND to_member_id = ?", [member.id]))
    send(p, { ticketId: null, toRole: currentTicketOf(p, member.id)?.role ?? "dev", toMemberId: member.id, kind: "member_chat", payload: { memberId: member.id } satisfies MemberChatPayload });
}

export function memberChatSystem(p: Project, member: MemberRow, unit: { name: string | null; focus: string | null }, finished = false): string {
  return `あなたは Kuramoto の開発チームの ${unit.name ?? "島"} のメンバー(${member.name})です。いま、責任者(人間)があなたに話しかけています。
- 返事は短く、日本語で。分からないことは分からないと言います。
- あなたが今受け持っているチケットの話として答えます。状況を聞かれたら、この会話のこれまでの作業と、指示に書かれたチケット・メモ・最近の手順をもとに答えます。
${
    finished
      ? "- このチケットはもう終わっています(merge 済みか取り下げ済み)。伝えられたことはメモに書き足されません。作業場所は既定のブランチで、このチケットのブランチは無いことがあります。\n"
      : "- 伝えられたことは、このチケットのメモに書き足されます。あなたの担当も工程も変わりません。このあと仕事を始めるときにメモを読んで、そのとおりに進めてください。\n"
  }- 今のチケットの外の、新しい仕事(別の機能・別の修正)を頼まれたら、自分では引き受けず hand_to_lead でリーダーに回します。チケットの範囲を広げる頼みも同じです。
- コードは書き換えません(読むだけ)。merge はしません。
- 最後のテキストがそのまま責任者への返事になります。` +
    (unit.focus?.trim() ? `\n\n## このプロジェクトで重視すること\n${unit.focus.trim()}` : "");
}

/** メンバーへの指示。今のチケットの様子と、まだ返事をしていない責任者のメッセージを渡す。 */
export function memberChatPrompt(p: Project, member: MemberRow, ticket: TicketRow, unread: MemberMessage[]): string {
  const notes = p.notes(ticket.id).slice(-12);
  const first = unread[0]?.id ?? Infinity;
  const history = memberMessages(p, member.id, 40).filter((m) => m.id < first && m.who !== "system").slice(-10);
  const steps = all<{ text: string }>(
    p.db,
    "SELECT s.text FROM run_steps s JOIN runs r ON r.id = s.run_id WHERE COALESCE(r.ticket_id, r.about_ticket_id) = ? AND r.member_id = ? ORDER BY s.id DESC LIMIT 8",
    [ticket.id, member.id],
  )
    .reverse()
    .map((s) => `- ${s.text}`)
    .join("\n");
  const id = ticket.jira_key ? `${ticket.jira_key}(#${ticket.number})` : `#${ticket.number}`;
  return `責任者があなたに話しかけています。

## 今のチケット ${id}: ${ticket.title}
工程: ${ticket.stage}${ticket.rounds ? `、往復 ${ticket.rounds}` : ""}
${ticket.body}

## このチケットのメモ(新しい方から 12 件まで)
${notes.map((n) => `- ${n.kind === "member" ? "責任者があなたに伝えた" : n.who === "lead" ? "リーダー" : "責任者"}: ${n.body}`).join("\n") || "(なし)"}

## 最近の手順
${steps || "(なし)"}

## 最近のやりとり(古い順。前の起動の会話は引き継がないことがあるので、ここで流れをつかむ)
${history.map((m) => `- ${m.who === "owner" ? "責任者" : "あなた"}: ${m.body.length > 400 ? `${m.body.slice(0, 400)}…` : m.body}`).join("\n") || "(なし)"}

## 責任者のメッセージ(まだ返事をしていないもの)
${unread.map((m) => `- ${m.body}`).join("\n")}

聞かれたことには、上の状況と作業の記憶をもとに短く答えてください。${
    isFinishedTicket(ticket) ? "このチケットは終わっているので、伝えられたことはメモに残りません。続けたいことがあれば、新しい仕事として" : "伝えられたことは、了解したと返事をすれば、このチケットのメモに書き足されます。新しい仕事の頼みは、"
  }hand_to_lead でリーダーに回してください。`;
}

/** メンバーの道具: 新しい仕事をリーダーの受信箱に回す。 */
export function memberChatTools(p: Project, member: MemberRow, ticket: TicketRow, done: { handedOver?: boolean }): KuramotoTool[] {
  return [
    defineTool({
      name: "hand_to_lead",
      description: "責任者に頼まれた、今のチケットの外の新しい仕事を、リーダーに回す(リーダーがチケットにして、順番と担当を決める)。自分では引き受けない。",
      input: { title: z.string().describe("頼まれた仕事を一言で"), body: z.string().describe("頼まれたことの中身・理由・分かっていること") },
      handler: (a) => {
        const title = a.title.trim();
        if (!title) return "仕事の名前がありません";
        tx(p.db, () => {
          sayToLead(p, `【${member.name} から回ってきた新しい仕事】(#${ticket.number} について話しているときに、責任者から頼まれました。${member.name} は引き受けていません)\n${title}\n${a.body.trim()}`);
          p.event(member.name, "handed_to_lead", ticket.id, { title });
        });
        done.handedOver = true;
        return "リーダーに回しました。返事では、リーダーに回したことを責任者に伝えてください。";
      },
    }),
  ];
}

// ---- 今していること(メンバーを押して開く引き出しの上半分) ----

export type MemberNow = {
  member: { id: number; name: string; unit: string | null; helper: boolean };
  /** working: 起動中。chatting: 責任者と話している最中(チケットの仕事は止まっている)。idle: 手すき(last に直前に終えたチケット)。 */
  state: "working" | "chatting" | "idle";
  ticket: { id: number; number: number; title: string; kind: string; stage: string; rounds: number; activeMin: number; tokens: number } | null;
  /** 今の起動の種類(実装・直し・レビューなど) */
  doing: { kind: string; role: string; model: string | null; live: string | null; startedAt: string } | null;
  /** 手すきのとき、直前に終えたチケット */
  last: { number: number; title: string; endedAt: string; outcome: string | null } | null;
  /** 直近の手順(起動中ならその起動、手すきなら直前の起動。古い順) */
  steps: { at: string; kind: string; text: string }[];
  /** そのメンバーの直近の出来事(古い順) */
  events: { at: string; type: string; ticket: number | null }[];
};

export function memberNow(p: Project, memberId: number, steps = 8): MemberNow {
  const m = p.member(memberId);
  if (!m) throw new Error(`メンバー ${memberId} はいません`);
  const unit = m.unit_id === null ? null : get<{ name: string }>(p.db, "SELECT name FROM units WHERE id = ?", [m.unit_id]);
  const open = get<{ id: number; role: string; model: string | null; started_at: string; about: number | null; ticket_id: number | null; kind: string }>(
    p.db,
    "SELECT r.id, r.role, r.model, r.started_at, r.about_ticket_id AS about, r.ticket_id, msg.kind FROM runs r JOIN messages msg ON msg.id = r.message_id WHERE r.member_id = ? AND r.ended_at IS NULL ORDER BY r.id DESC LIMIT 1",
    [memberId],
  );
  // 起動中でないとき(手すき)は、直前に終えたチケットの仕事
  const lastRun = open
    ? null
    : get<{ id: number; ticket_id: number; ended_at: string; outcome: string | null }>(
        p.db,
        "SELECT id, ticket_id, ended_at, outcome FROM runs WHERE member_id = ? AND ticket_id IS NOT NULL AND ended_at IS NOT NULL ORDER BY id DESC LIMIT 1",
        [memberId],
      );
  const ticketId = open ? (open.ticket_id ?? open.about) : (lastRun?.ticket_id ?? null);
  const t = ticketId ? p.ticket(ticketId) : null;
  const kindOf = get<{ kind: string }>(p.db, "SELECT kind FROM tickets WHERE id = ?", [ticketId ?? -1])?.kind ?? "feature";
  const tokens = t ? (get<{ n: number | null }>(p.db, "SELECT SUM(COALESCE(input_tokens,0) + COALESCE(output_tokens,0)) AS n FROM runs WHERE ticket_id = ?", [t.id])?.n ?? 0) : 0;
  const w = open ? runWork(p, open.id, steps) : null;
  const stepRunId = open?.id ?? lastRun?.id;
  const stepRows = stepRunId ? all<{ at: string; kind: string; text: string }>(p.db, "SELECT at, kind, text FROM run_steps WHERE run_id = ? ORDER BY id DESC LIMIT ?", [stepRunId, steps]).reverse() : [];
  const elapsedMs = open ? Math.max(0, p.clock.now().getTime() - Date.parse(open.started_at)) : 0;
  const events = all<{ at: string; type: string; ticket_id: number | null }>(p.db, "SELECT at, type, ticket_id FROM events WHERE actor = ? ORDER BY id DESC LIMIT 10", [m.name]).reverse();
  const numberOf = new Map<number, number>();
  for (const e of events) if (e.ticket_id !== null && !numberOf.has(e.ticket_id)) numberOf.set(e.ticket_id, p.ticket(e.ticket_id).number);
  return {
    member: { id: m.id, name: m.name, unit: unit?.name ?? null, helper: !m.is_base && m.unit_id !== null },
    state: open ? (open.kind === "member_chat" ? "chatting" : "working") : "idle",
    ticket: t ? { id: t.id, number: t.number, title: t.title, kind: kindOf, stage: t.stage, rounds: t.rounds, activeMin: Math.round((t.active_ms + elapsedMs) / 60000), tokens } : null,
    doing: open
      ? {
          kind: KIND_LABEL[open.kind] ?? open.kind,
          role: ROLE_LABEL[open.role as Role] ?? open.role,
          model: open.model ? (MODELS[open.model as keyof typeof MODELS]?.label ?? open.model) : null,
          live: w?.live ?? null,
          startedAt: open.started_at,
        }
      : null,
    last: lastRun && t ? { number: t.number, title: t.title, endedAt: lastRun.ended_at, outcome: lastRun.outcome } : null,
    steps: stepRows,
    events: events.map((e) => ({ at: e.at, type: e.type, ticket: e.ticket_id === null ? null : (numberOf.get(e.ticket_id) ?? null) })),
  };
}

/** 引き出しの「話す欄」: 会話の記録と、返事を待っている・書いている最中かどうか。 */
export function memberChatView(p: Project, memberId: number) {
  const m = chatMember(p, memberId);
  const pending = get<{ id: number; status: string }>(p.db, "SELECT id, status FROM messages WHERE kind = 'member_chat' AND to_member_id = ? AND status IN ('pending','claimed') ORDER BY id LIMIT 1", [m.id]);
  const open = pending
    ? get<{ id: number }>(p.db, "SELECT id FROM runs WHERE message_id = ? AND ended_at IS NULL ORDER BY id DESC LIMIT 1", [pending.id])
    : undefined;
  const w = open ? runWork(p, open.id, 3) : null;
  return {
    member: { id: m.id, name: m.name },
    now: memberNow(p, m.id),
    messages: memberMessages(p, m.id),
    // typing: 返事を書いている最中(startedAt から数えられる)。queued: メンバーの今の仕事が終わるのを待っている
    work: w ? { state: "typing" as const, startedAt: w.startedAt, live: w.live } : pending ? { state: "queued" as const } : null,
  };
}

export type MemberChatView = ReturnType<typeof memberChatView>;
