import { z } from "zod";
import { inScope } from "../db/count.js";
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

export async function memberMessages(p: Project, memberId: number, limit = 200): Promise<MemberMessage[]> {
  const rows = await inScope(p.pdb, "member_messages").where("member_id", "=", memberId).orderBy("id", "desc").limit(limit).execute();
  return (rows as unknown as MessageSql[]).reverse().map(toMessage);
}

/** 終わったチケット(merge 済み・取り下げ済み)。話しかけられても、メモは足さず答えるだけにする。 */
export function isFinishedTicket(t: Pick<TicketRow, "stage">): boolean {
  return t.stage === "done" || t.stage === "dropped";
}

/** メンバーが「今」持っているチケット: 起動中ならその起動のチケット、freeなら直前に動いたチケット。話しかけた内容はここにひも付く。 */
export async function currentTicketOf(p: Project, memberId: number): Promise<{ ticketId: number; role: Role } | null> {
  // 起動中のものを先に、無ければ直前の起動(チケットか、聞かれたチケットを持つもの)
  const withTicket = () =>
    inScope(p.pdb, "runs")
      .where("member_id", "=", memberId)
      .where((eb) => eb.or([eb("ticket_id", "is not", null), eb("about_ticket_id", "is not", null)]))
      .orderBy("id", "desc")
      .limit(1);
  const r = (await withTicket().where("ended_at", "is", null).executeTakeFirst()) ?? (await withTicket().where("ended_at", "is not", null).executeTakeFirst());
  return r ? { ticketId: (r.ticket_id ?? r.about_ticket_id)!, role: r.role as Role } : null;
}

async function chatMember(p: Project, memberId: number): Promise<MemberRow> {
  const m = await p.member(memberId);
  if (!m || m.unit_id === null) throw new Error("このメンバーとは話せません(島のメンバーだけです)");
  return m;
}

const readKey = (memberId: number) => `member_chat_read:${memberId}`;

/** メンバーがまだ読んでいない責任者のメッセージ。 */
export async function unreadForMember(p: Project, memberId: number): Promise<MemberMessage[]> {
  const read = Number(await p.setting(readKey(memberId)) ?? 0);
  return (await memberMessages(p, memberId)).filter((m) => m.who === "owner" && m.id > read);
}

const pendingMemberChat = (p: Project, memberId: number) =>
  inScope(p.pdb, "messages").where("kind", "=", "member_chat").where("status", "=", "pending").where("to_member_id", "=", memberId).executeTakeFirst();

/** 責任者がメンバーに話しかける。メッセージを残し、受信箱でメンバーを起こす。 */
export async function sayToMember(p: Project, memberId: number, body: string): Promise<void> {
  const text = body.trim();
  if (!text) throw new Error("メッセージがありません");
  const m = await chatMember(p, memberId);
  if (m.left_at !== null) throw new Error(`${m.name} は今は席にいません`);
  const cur = await currentTicketOf(p, m.id);
  if (!cur) throw new Error(`${m.name} はまだチケットを受け持っていないので、話しかけられません`);
  await p.pdb.transaction(async () => {
    await p.pdb.insert("member_messages", { member_id: m.id, ticket_id: cur.ticketId, who: "owner", body: text, at: p.now() }).execute();
    // まだ取り出されていない呼び出しがあれば、そこにまとめる(何通書いても、メンバーは 1 回で読む。読んでから書くので tx の中で)
    if (!(await pendingMemberChat(p, m.id))) await send(p, { ticketId: null, toRole: cur.role, toMemberId: m.id, kind: "member_chat", payload: { memberId: m.id } satisfies MemberChatPayload });
  });
}

/** 返事を書き終えた(チケットのメモに残すところまで)。 */
export async function finishMemberChat(p: Project, member: MemberRow, unread: MemberMessage[], reply: string, handedOver: boolean): Promise<void> {
  const ticket = unread[0]?.ticketId ?? null;
  await p.pdb.transaction(async () => {
    if (reply.trim()) await p.pdb.insert("member_messages", { member_id: member.id, ticket_id: ticket, who: "member", body: reply.trim(), at: p.now() }).execute();
    // 終わったチケットには、もう次の仕事が無いのでメモを足さない(足しても誰にも読まれない)。答えるだけ
    if (ticket !== null && !handedOver && !isFinishedTicket(await p.ticket(ticket))) {
      // 伝えたことは、そのチケットのメモに残る。次に仕事を始める担当(この人も)が読む
      for (const m of unread) await p.addNote(m.ticketId ?? ticket, m.body, "owner", "member");
      await p.pdb.insert("member_messages", { member_id: member.id, ticket_id: ticket, who: "system", body: `#${(await p.ticket(ticket)).number} のメモに書き足しました`, at: p.now() }).execute();
    }
    const last = Math.max(...unread.map((m) => m.id));
    if (last > Number(await p.setting(readKey(member.id)) ?? 0)) await p.setSetting(readKey(member.id), String(last));
    // 返事の最中に書き足されたメッセージがあれば、続けて起こす
    if ((await unreadForMember(p, member.id)).length && !(await pendingMemberChat(p, member.id)))
      await send(p, { ticketId: null, toRole: (await currentTicketOf(p, member.id))?.role ?? "dev", toMemberId: member.id, kind: "member_chat", payload: { memberId: member.id } satisfies MemberChatPayload });
  });
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
export async function memberChatPrompt(p: Project, member: MemberRow, ticket: TicketRow, unread: MemberMessage[]): Promise<string> {
  const notes = (await p.notes(ticket.id)).slice(-12);
  const first = unread[0]?.id ?? Infinity;
  const history = (await memberMessages(p, member.id, 40)).filter((m) => m.id < first && m.who !== "system").slice(-10);
  // このメンバーが、このチケットのために動いた起動(チケットの起動か、聞かれて答えた起動)の手順
  const runIds = (
    await inScope(p.pdb, "runs")
      .where("member_id", "=", member.id)
      .where((eb) => eb.or([eb("ticket_id", "=", ticket.id), eb.and([eb("ticket_id", "is", null), eb("about_ticket_id", "=", ticket.id)])]))
      .execute()
  ).map((r) => r.id);
  const stepRows = runIds.length ? await inScope(p.pdb, "run_steps").where("run_id", "in", runIds).orderBy("id", "desc").limit(8).execute() : [];
  const steps = stepRows
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
      handler: async (a) => {
        const title = a.title.trim();
        if (!title) return "仕事の名前がありません";
        await p.pdb.transaction(async () => {
          await sayToLead(p, `【${member.name} から回ってきた新しい仕事】(#${ticket.number} について話しているときに、責任者から頼まれました。${member.name} は引き受けていません)\n${title}\n${a.body.trim()}`);
          await p.event(member.name, "handed_to_lead", ticket.id, { title });
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
  /** working: 起動中。chatting: 責任者と話している最中(チケットの仕事は止まっている)。idle: free(last に直前に終えたチケット)。 */
  state: "working" | "chatting" | "idle";
  ticket: { id: number; number: number; title: string; kind: string; stage: string; rounds: number; activeMin: number; tokens: number } | null;
  /** 今の起動の種類(実装・直し・レビューなど) */
  doing: { kind: string; role: string; model: string | null; live: string | null; startedAt: string } | null;
  /** freeのとき、直前に終えたチケット */
  last: { number: number; title: string; endedAt: string; outcome: string | null } | null;
  /** 直近の手順(起動中ならその起動、freeなら直前の起動。古い順) */
  steps: { at: string; kind: string; text: string }[];
  /** そのメンバーの直近の出来事(古い順) */
  events: { at: string; type: string; ticket: number | null }[];
};

export async function memberNow(p: Project, memberId: number, steps = 8): Promise<MemberNow> {
  const m = await p.member(memberId);
  if (!m) throw new Error(`メンバー ${memberId} はいません`);
  const unit = m.unit_id === null ? null : ((await inScope(p.pdb, "units").where("id", "=", m.unit_id).executeTakeFirst()) ?? null);
  const open = await p.pdb.k
    .selectFrom("runs as r")
    .innerJoin("messages as msg", "msg.id", "r.message_id")
    .select(["r.id as id", "r.role as role", "r.model as model", "r.started_at as started_at", "r.about_ticket_id as about", "r.ticket_id as ticket_id", "msg.kind as kind"])
    .where("r.project_id", "=", p.pdb.projectId)
    .where("r.member_id", "=", memberId)
    .where("r.ended_at", "is", null)
    .orderBy("r.id", "desc")
    .limit(1)
    .executeTakeFirst();
  // 起動中でないとき(free)は、直前に終えたチケットの仕事
  const lastRun = open
    ? null
    : ((await inScope(p.pdb, "runs").where("member_id", "=", memberId).where("ticket_id", "is not", null).where("ended_at", "is not", null).orderBy("id", "desc").limit(1).executeTakeFirst()) as unknown as
        | { id: number; ticket_id: number; ended_at: string; outcome: string | null }
        | undefined) ?? null;
  const ticketId = open ? (open.ticket_id ?? open.about) : (lastRun?.ticket_id ?? null);
  const t = ticketId ? await p.ticket(ticketId) : null;
  const kindOf = (await inScope(p.pdb, "tickets").where("id", "=", ticketId ?? -1).executeTakeFirst())?.kind ?? "feature";
  const tokens = t ? (await inScope(p.pdb, "runs").where("ticket_id", "=", t.id).execute()).reduce((s, r) => s + (r.input_tokens ?? 0) + (r.output_tokens ?? 0), 0) : 0;
  const w = open ? await runWork(p, open.id, steps) : null;
  const stepRunId = open?.id ?? lastRun?.id;
  const stepRows = stepRunId ? (await inScope(p.pdb, "run_steps").where("run_id", "=", stepRunId).orderBy("id", "desc").limit(steps).execute()).reverse() : [];
  const elapsedMs = open ? Math.max(0, p.clock.now().getTime() - Date.parse(open.started_at)) : 0;
  const events = (await inScope(p.pdb, "events").where("actor", "=", m.name).orderBy("id", "desc").limit(10).execute()).reverse();
  const numberOf = new Map<number, number>();
  for (const e of events) if (e.ticket_id !== null && !numberOf.has(e.ticket_id)) numberOf.set(e.ticket_id, (await p.ticket(e.ticket_id)).number);
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
export async function memberChatView(p: Project, memberId: number) {
  const m = await chatMember(p, memberId);
  const pending = await inScope(p.pdb, "messages").where("kind", "=", "member_chat").where("to_member_id", "=", m.id).where("status", "in", ["pending", "claimed"]).orderBy("id").limit(1).executeTakeFirst();
  const open = pending ? await inScope(p.pdb, "runs").where("message_id", "=", pending.id).where("ended_at", "is", null).orderBy("id", "desc").limit(1).executeTakeFirst() : undefined;
  const w = open ? await runWork(p, open.id, 3) : null;
  return {
    member: { id: m.id, name: m.name },
    now: await memberNow(p, m.id),
    messages: await memberMessages(p, m.id),
    // typing: 返事を書いている最中(startedAt から数えられる)。queued: メンバーの今の仕事が終わるのを待っている
    work: w ? { state: "typing" as const, startedAt: w.startedAt, live: w.live } : pending ? { state: "queued" as const } : null,
  };
}

export type MemberChatView = Awaited<ReturnType<typeof memberChatView>>;
