import { z } from "zod";
import { inScope } from "../db/count.js";
import { hasRoute } from "../domain/route.js";
import { defineTool, type KuramotoTool } from "../harness/types.js";
import { send } from "./inbox.js";
import { sayToLead } from "./leadchat.js";
import type { MemberRow, Project, TicketRow, UnitRow } from "./project.js";

/**
 * 島への質問・相談(R16)。
 * - 経路がある島へ聞くと、受信箱の ask で相手の島の手すきの人を起こして答えてもらう。
 * - 経路が無い(または相手がリーダー)ときは、リーダーに回す。経路が無かったことは「やりとり」に残る。
 * - 質問と答えは ticket_questions に残り、チケットの「やりとり」に並ぶ。聞いたチケットの担当・工程は変わらない。
 * - 答える起動は、チケットの起動ではなく about_ticket_id でそのチケットにひも付く(金額はそのチケットに数える)。
 * 聞いたメンバーは答えを待たずに作業を続ける。答えは、次にそのチケットの仕事をする担当の指示に載る。
 */

export type AskPayload = { questionId: number };

/** 質問の宛先が「リーダー」を指すときの印(ticket_questions.to_target)。 */
export const LEAD_TARGET = "lead";

export type QuestionRow = {
  id: number;
  ticket_id: number;
  from_member_id: number | null;
  to_target: string;
  body: string;
  routed_to_lead: number;
  answer: string | null;
  answered_by_member_id: number | null;
  asked_at: string;
  answered_at: string | null;
};

export async function question(p: Project, id: number): Promise<QuestionRow> {
  const q = (await inScope(p.pdb, "ticket_questions").where("id", "=", id).executeTakeFirst()) as unknown as QuestionRow | undefined;
  if (!q) throw new Error(`質問 ${id} はありません`);
  return q;
}

export async function questionsOf(p: Project, ticketId: number): Promise<QuestionRow[]> {
  return (await inScope(p.pdb, "ticket_questions").where("ticket_id", "=", ticketId).orderBy("id").execute()) as unknown as QuestionRow[];
}

const isLead = (to: string) => ["lead", "リーダー"].includes(to.trim().toLowerCase());

/**
 * 質問を出す。経路があれば相手の島の受信箱へ、無ければリーダーへ。
 * @returns 質問したメンバーに返す一言(道具の返事)
 */
export async function askQuestion(p: Project, from: MemberRow, ticket: TicketRow, to: string, body: string): Promise<string> {
  const text = body.trim();
  if (!text) return "質問の中身がありません。聞きたいことを書いて呼び直してください。";
  const formation = p.currentFormation();
  const mine = formation.units.find((u) => u.id === from.unit_id);
  const target = formation.units.find((u) => u.name === to.trim());
  const id = `#${ticket.number}`;
  const place = `${from.name}(${mine?.name ?? "島なし"})が ${id}「${ticket.title}」について`;

  if (target && mine && target.id === mine.id) return "自分の島には質問を送れません。同じ島のことは、自分で調べるか、チケットのメモに書いてください。";

  // リーダーへの質問は、そのままリーダーへ(経路は要らない)
  if (!target && isLead(to)) {
    await p.pdb.transaction(async () => {
      await p.pdb.insert("ticket_questions", { ticket_id: ticket.id, from_member_id: from.id, to_target: LEAD_TARGET, body: text, routed_to_lead: 1, asked_at: p.now() }).execute();
      await sayToLead(p, `【${place} 質問しています】\n${text}`);
      p.event(from.name, "question_asked", ticket.id, { to: LEAD_TARGET, routedToLead: true });
    });
    return "リーダーに送りました。答えを待たずに作業を続けてください。";
  }
  if (!target && !to.trim()) return "宛先がありません。島の名前かリーダーを指定してください。";

  // 経路があって、相手が島のときだけ、相手の島の手すきの人が答える
  if (target && mine && hasRoute(formation.routes, mine.name, target.name)) {
    await p.pdb.transaction(async () => {
      const qid = await p.pdb.dialect.insertedId(p.pdb.insert("ticket_questions", { ticket_id: ticket.id, from_member_id: from.id, to_target: target.name, body: text, asked_at: p.now() }));
      // 起動はチケットを持たない(チケットの 1 チケット 1 起動を邪魔しない)。ひも付けは payload と runs.about_ticket_id
      send(p, { ticketId: null, toRole: target.roles[0]!, kind: "ask", payload: { questionId: qid } satisfies AskPayload });
      p.event(from.name, "question_asked", ticket.id, { to: target.name, routedToLead: false });
    });
    return `${target.name} に送りました。手すきの人が答えます。答えを待たずに作業を続けてください(答えはこのチケットのやりとりに残り、次の仕事の指示に入ります)。`;
  }

  // 経路が無い(島が無い・結ばれていない・担当への質問): リーダーに回し、そのことを残す
  const label = target?.name ?? to.trim();
  await p.pdb.transaction(async () => {
    await p.pdb.insert("ticket_questions", { ticket_id: ticket.id, from_member_id: from.id, to_target: label, body: text, routed_to_lead: 1, asked_at: p.now() }).execute();
    await sayToLead(p, `【${place} 「${label}」に質問しようとしましたが、経路が無いのでリーダーに回ってきました】\n${text}`);
    p.event(from.name, "question_asked", ticket.id, { to: label, routedToLead: true, noRoute: true });
  });
  return `「${label}」との経路が無いので、リーダーに回しました。答えを待たずに作業を続けてください。`;
}

/** 聞いたメンバーの道具: 質問する。 */
export function askTools(p: Project, member: MemberRow, ticket: TicketRow): KuramotoTool[] {
  return [
    defineTool({
      name: "ask_island",
      description:
        "ほかの島(またはリーダー)に質問・相談する。経路がある島なら、その島の手すきの人が答える。経路が無い相手への質問は、リーダーに回る。答えを待たずに作業を続け、答えは次の仕事の指示に入る。担当や工程は変わらない。",
      input: { to: z.string().describe("宛先の島の名前(編成の島)。リーダーなら「リーダー」"), question: z.string().describe("聞きたいこと。背景と、答えてほしいことを具体的に") },
      handler: (a) => askQuestion(p, member, ticket, a.to, a.question),
    }),
  ];
}

// ---- 答える側 ----

/** 答える島を決める: 質問の宛先の島。席にいて、手すきで、聞いた本人でない人から選ぶのは dispatcher。 */
export function targetUnit(p: Project, q: QuestionRow): UnitRow | undefined {
  return p.currentFormation().units.find((u) => u.name === q.to_target);
}

export type AnswerReport = { answer?: string };

export function replyTools(report: AnswerReport): KuramotoTool[] {
  return [
    defineTool({
      name: "reply",
      description: "質問への答えを返す。最後に必ず 1 回呼ぶ。分からないことは分からないと書き、誰に聞けばよいかを添える。",
      input: { answer: z.string().describe("質問への答え。短く、具体的に") },
      handler: ({ answer }) => {
        if (!answer.trim()) return "答えが空です。答えを書いて呼び直してください。";
        report.answer = answer.trim();
        return "答えを受け付けました。聞いた人に届けます。";
      },
    }),
  ];
}

export function answerSystem(member: MemberRow, unit: { name: string | null; focus: string | null }): string {
  return `あなたは Kuramoto の開発チームの ${unit.name ?? "島"} のメンバー(${member.name})です。ほかの島のメンバーから質問・相談が届きました。
- 答えは短く、日本語で。分からないことは分からないと書き、誰に聞けばよいかを添えます。
- コードは読めますが、書き換えません。聞かれた側のチケットの担当・工程を変える頼みは引き受けず、リーダーに相談するよう答えます。
- 答えは reply で返します。最後に必ず 1 回呼びます。` + (unit.focus?.trim() ? `\n\n## このプロジェクトで重視すること\n${unit.focus.trim()}` : "");
}

export function answerPrompt(p: Project, q: QuestionRow, ticket: TicketRow): string {
  const asker = q.from_member_id ? p.member(q.from_member_id) : null;
  const askerUnit = asker?.unit_id ? p.currentFormation().units.find((u) => u.id === asker.unit_id)?.name : null;
  return `${asker?.name ?? "ほかのメンバー"}(${askerUnit ?? "ほかの島"})から質問が届きました。

## 質問が出たチケット #${ticket.number}: ${ticket.title}
${ticket.body}

## 質問
${q.body}

聞かれたことに、コードを読んで答え、reply で返してください。`;
}

/** 答えを記録する。聞いたチケットの担当・工程には触らない。 */
export async function recordAnswer(p: Project, q: QuestionRow, by: MemberRow, answer: string): Promise<void> {
  await p.pdb.update("ticket_questions", { answer: answer.trim(), answered_by_member_id: by.id, answered_at: p.now() }).where("id", "=", q.id).execute();
  p.event(by.name, "question_answered", q.ticket_id, { questionId: q.id });
}

/** リーダーに回ってきて、まだ答えが無い質問(リーダー宛て・経路が無かったもの・島が無くなったもの)。 */
export async function leadPendingQuestions(p: Project): Promise<QuestionRow[]> {
  return (await inScope(p.pdb, "ticket_questions").where("routed_to_lead", "=", 1).where("answer", "is", null).orderBy("id").execute()) as unknown as QuestionRow[];
}

/**
 * リーダーの答えを、リーダーに回ってきた質問に結び付けて残す。
 * @returns リーダーに返す道具の返事
 */
export async function answerLeadQuestion(p: Project, lead: MemberRow, questionId: number, answer: string): Promise<string> {
  const text = answer.trim();
  if (!text) return "答えが空です。答えを書いて呼び直してください。";
  const q = (await inScope(p.pdb, "ticket_questions").where("id", "=", questionId).executeTakeFirst()) as unknown as QuestionRow | undefined;
  if (!q || !q.routed_to_lead) return `質問 ${questionId} は、リーダーに回ってきた質問にありません。`;
  if (q.answer !== null) return `質問 ${questionId} には、もう答えが残っています。`;
  await recordAnswer(p, q, lead, text);
  return `質問 ${questionId} の答えを、チケットのやりとりに残しました。次にそのチケットの仕事をする担当の指示に入ります。`;
}

/** リーダーへの指示に載せる、答えを待っている質問(番号つき)。 */
export async function leadPendingBlock(p: Project): Promise<string> {
  const qs = await leadPendingQuestions(p);
  if (!qs.length) return "(なし)";
  return qs
    .map((q) => {
      const t = p.ticket(q.ticket_id);
      const from = q.from_member_id ? p.member(q.from_member_id).name : "メンバー";
      const to = q.to_target === LEAD_TARGET ? "リーダー" : `「${q.to_target}」(経路が無い)`;
      return `- 質問 ${q.id}(#${t.number}「${t.title}」、${from} から ${to} へ): ${q.body}`;
    })
    .join("\n");
}

/** 次にそのチケットの仕事をする担当の指示に載せる、答えが返ってきた質問。 */
export async function answeredBlock(p: Project, ticketId: number): Promise<string> {
  const qs = (await questionsOf(p, ticketId)).filter((q) => q.answer !== null);
  if (!qs.length) return "";
  const label = (q: QuestionRow) => {
    const who = q.routed_to_lead ? "リーダー" : q.to_target;
    return q.answered_by_member_id ? `${p.member(q.answered_by_member_id).name}(${who})` : who;
  };
  return `\n\n### ほかの島への質問と答え\n${qs.map((q) => `- 質問: ${q.body}\n  ${label(q)} の答え: ${q.answer}`).join("\n")}`;
}

/** 答える島が無くなっていた(編成が変わった)質問を、リーダーに回す。 */
export async function reroutedToLead(p: Project, q: QuestionRow, ticket: TicketRow): Promise<void> {
  await p.pdb.update("ticket_questions", { routed_to_lead: 1 }).where("id", "=", q.id).execute();
  await sayToLead(p, `【#${ticket.number}「${ticket.title}」で、「${q.to_target}」への質問が、島が無くなったためリーダーに回ってきました】\n${q.body}`);
  p.event("system", "question_rerouted", q.ticket_id, { to: q.to_target });
}
