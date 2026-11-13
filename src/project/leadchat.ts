import { z } from "zod";
import { KIND_LABEL, TICKET_KINDS } from "../domain/flow.js";
import { all, run, tx } from "../db/sqlite.js";
import { defineTool, type KuramotoTool } from "../harness/types.js";
import { send } from "./inbox.js";
import { runWork } from "./progress.js";
import { teamStatus, triageTools } from "./triage.js";
import type { Project, TicketRow } from "./project.js";
import { dropTicketTool } from "./patrol.js";
import { answerLeadQuestion, leadPendingBlock } from "./questions.js";
import { pendingOwnerDecisions, createTicket } from "./workflow.js";
import { designSystem, requirements, screens } from "./planning.js";

/**
 * 責任者とリーダーのチャット(非同期)。書いたメッセージは受信箱を通してリーダーに届き、リーダーが手すきのときに返事をする。
 * リーダーは今のチケットの状況を見て答え、頼まれればチケットを作ったり、チケットにメモを書き足して担当に伝えたりする。
 */

export type LeadMessage = { id: number; who: "owner" | "lead" | "system"; body: string; at: string };

export function leadMessages(p: Project): LeadMessage[] {
  return all(p.db, "SELECT * FROM lead_messages ORDER BY id");
}

export function sayToLead(p: Project, body: string): void {
  const text = body.trim();
  if (!text) throw new Error("メッセージがありません");
  tx(p.db, () => {
    run(p.db, "INSERT INTO lead_messages (who, body, at) VALUES ('owner', ?, ?)", [text, p.now()]);
    // まだ取り出されていない依頼があれば、そこにまとめる(何通書いても、リーダーは 1 回で読む)
    const pending = all<{ id: number }>(p.db, "SELECT id FROM messages WHERE kind = 'chat' AND status = 'pending'");
    if (!pending.length) send(p, { ticketId: null, toRole: "lead", kind: "chat", payload: {} });
  });
}

export async function leadChatView(p: Project) {
  const r = all<{ id: number; status: string; run_id: number | null }>(
    p.db,
    `SELECT m.id, m.status, (SELECT r.id FROM runs r WHERE r.message_id = m.id AND r.ended_at IS NULL ORDER BY r.id DESC LIMIT 1) AS run_id
     FROM messages m WHERE m.kind = 'chat' AND m.status IN ('pending','claimed') ORDER BY m.id LIMIT 1`,
  )[0];
  const w = r?.run_id ? await runWork(p, r.run_id) : null;
  return {
    lead: p.fixedMember("lead").name,
    messages: leadMessages(p),
    work: w ? { state: "running" as const, ...w } : r ? { state: "queued" as const } : null,
  };
}

/**
 * リーダーがまだ読んでいない責任者のメッセージ。どこまで読んだかは、チャットの起動ごとに覚えておく(設定 lead_chat_read)。
 * 「最後のリーダーの発言より後」で数えると、交通整理・見回りの報告や、書いている最中の返事に追い越されたメッセージが読まれずに残っていた。
 */
export function unreadOwnerMessages(p: Project): LeadMessage[] {
  const msgs = leadMessages(p);
  const read = p.setting("lead_chat_read");
  if (read !== undefined) return msgs.filter((m) => m.who === "owner" && m.id > Number(read));
  // まだ覚えていない(この仕組みの前のデータ)なら、前のやり方で数える
  const lastLead = msgs.map((m) => m.who).lastIndexOf("lead");
  return msgs.slice(lastLead + 1).filter((m) => m.who === "owner");
}

/** 企画で合意した画面とデザインシステムの有無(リーダーが画面のチケットにひも付けるため)。 */
function planScreens(p: Project): string {
  const list = [...screens(p)].map(([key, s]) => `- ${key}: ${s.name}(${s.device === "phone" ? "スマホ" : "パソコン"}、要件 ${s.requirements.join("・") || "—"}${s.agreed ? "、合意済み" : "、まだ合意していない"})`);
  const ds = designSystem(p);
  return `${list.join("\n") || "(なし)"}\nデザインシステム: ${ds ? `あり(トークン ${ds.tokens.length}・部品 ${ds.components.length})` : "まだありません"}`;
}

/** 返事をするメッセージより前の、最近のやりとり(責任者とリーダーの会話。報告は短く)。 */
function recentChat(p: Project, unread: LeadMessage[]): string {
  const first = unread[0]?.id ?? Infinity;
  const n = p.settingNumber("lead_chat_history", 12);
  const lead = p.fixedMember("lead").name;
  const rows = leadMessages(p).filter((m) => m.id < first && m.who !== "system").slice(-n);
  return rows.map((m) => `- ${m.who === "owner" ? "責任者" : lead}: ${m.body.length > 400 ? `${m.body.slice(0, 400)}…` : m.body}`).join("\n") || "(なし)";
}

/** ここまで読んだ(返事を書き終えた)。 */
export function markOwnerMessagesRead(p: Project, upTo: number): void {
  if (upTo > Number(p.setting("lead_chat_read") ?? 0)) p.setSetting("lead_chat_read", String(upTo));
}

/** リーダーへの指示。今のチケットの状況と、まだ返事をしていない責任者のメッセージを渡す。 */
export async function leadChatPrompt(p: Project, unread: LeadMessage[] = unreadOwnerMessages(p)): Promise<string> {
  const tickets = p.tickets().filter((t) => t.stage !== "dropped");
  const board = tickets.map((t) => `- #${t.number} ${t.title} [${t.stage}]${t.rounds ? ` 往復 ${t.rounds}` : ""}`).join("\n") || "(チケットはまだありません)";
  const decisions = (await pendingOwnerDecisions(p)).map((d) => `- ${d.question.split("\n").pop()}`).join("\n") || "(なし)";
  return `責任者からチャットが届きました。

## 今のチケット
${board}

## チームの今(島・メンバー・空き)
${await teamStatus(p)}

## 責任者の答えを待っている判断
${decisions}

## メンバーからの質問で、リーダーの答えを待っているもの(経路が無くて回ってきたものを含む)
${leadPendingBlock(p)}

## 企画の画面(画面を作る・直すチケットは、create_ticket の screens にこの key を書く)
${planScreens(p)}

## 最近のやりとり(古い順。前の起動の会話は引き継がないので、ここで流れをつかむ)
${recentChat(p, unread)}

## 責任者のメッセージ(まだ返事をしていないもの)
${unread.map((m) => `- ${m.body}`).join("\n")}

状況を答える・相談に乗るときは、上の状況をもとに短く答えてください。作業を頼まれたら create_ticket でチケットを作り、既にあるチケットへの指示は add_ticket_note で担当に伝えてください。順番や担当を変えてと言われたら plan_work で決め直してください(assignee にはメンバーか島の名前を書けます)。メンバーからの質問に答えられるときは answer_question に質問の番号と答えを書いてください(答えはチケットのやりとりに残り、次にそのチケットの仕事をする担当の指示に入ります)。最後のテキストがそのまま責任者への返事になります。`;
}

export const LEAD_CHAT_SYSTEM = `あなたは Kuramoto の開発チームのリーダーです。責任者(人間)とチャットで話します。
- 返事は短く、日本語で。分からないことは分からないと言います。
- 作業を頼まれたら create_ticket でチケットにします。既にあるチケットへの指示は add_ticket_note で担当に伝えます。
- いらなくなったチケット(責任者にいらないと言われた・仕様が変わった・ほかで済んだ)は drop_ticket で理由を書いて取りやめます。
- あなたはチームの交通整理役です。誰がどのチケットをやるかを plan_work で割り当てます。島には最大人数ぶんのメンバーがずっといます。島の最大人数を変えるのは責任者の権限です。
- PR が merge できない理由・CI の結果・レビューは、pr_merge_status と pr_comments で GitHub から読んで答えます(読むだけ)。ブランチを比べた推測で答えません。
- メンバーからの質問(「答えを待っている質問」)は、答えられるものを answer_question で答えます。分からないものは、責任者に聞くか、そのまま残します。
- merge はしません。merge は責任者が押します。`;

export function leadChatTools(p: Project, ws: { closePrs?: (t: TicketRow, reason: string) => Promise<void> } = {}): KuramotoTool[] {
  return [
    ...triageTools(p),
    dropTicketTool(p, ws.closePrs),
    defineTool({
      name: "create_ticket",
      description:
        "責任者に頼まれた作業を、チケットとして開発の受信箱に入れる。画面を作る・直すチケットは screens に企画の画面の key を書く(担当に試作とお手本の画像が渡り、画像で見比べる)。デザインシステムの土台(トークン・共通の部品・カタログ /_design)を作るチケットは design_system: true にする。",
      input: {
        title: z.string(),
        body: z.string().describe("やること・受け入れ条件"),
        kind: z.enum(TICKET_KINDS).default("feature").describe(`チケットの種類。必ず 1 つ選ぶ(${TICKET_KINDS.map((k) => `${k}: ${KIND_LABEL[k]}`).join(" / ")})。種類ごとに工程の流れが違う`),
        screens: z.array(z.string()).optional().describe("ひも付ける企画の画面の key(下の「企画の画面」から)"),
        requirement: z.string().optional().describe("ひも付ける要件の code(例: R1)"),
        design_system: z.boolean().optional().describe("デザインシステムの土台のチケットなら true"),
        after: z.array(z.number().int()).optional().describe("先に merge されている必要があるチケットの番号(画面のチケットは、デザインシステムの土台のチケットを書く)"),
      },
      handler: async (a) => {
        const known = new Set(screens(p).keys());
        const bad = (a.screens ?? []).filter((k) => !known.has(k));
        if (bad.length) return `画面 ${bad.join("・")} は企画にありません。使えるのは ${[...known].join("・") || "(なし)"}`;
        const item = a.requirement ? requirements(p).find((r) => r.code === a.requirement) : undefined;
        if (a.requirement && !item) return `要件 ${a.requirement} はありません`;
        const t = await createTicket(p, {
          title: a.title,
          body: a.body,
          kind: a.kind ?? "feature",
          ...(item ? { requirementItemId: item.id } : {}),
          planRefs: { ...(a.screens?.length ? { screens: a.screens } : {}), ...(a.requirement ? { requirement: a.requirement } : {}), ...(a.design_system ? { designSystem: true } : {}) },
        });
        for (const n of a.after ?? []) {
          const dep = p.tickets().find((x) => x.number === n);
          if (dep) run(p.db, "INSERT OR IGNORE INTO ticket_deps (ticket_id, depends_on) VALUES (?, ?)", [t.id, dep.id]);
        }
        return `#${t.number} を作りました。`;
      },
    }),
    defineTool({
      name: "answer_question",
      description: "リーダーに回ってきたメンバーの質問(リーダー宛て・経路が無かったもの)に答える。答えはチケットのやりとりに残り、次にそのチケットの仕事をする担当の指示に入る。",
      input: { question_id: z.number().int().describe("質問の番号(「答えを待っている質問」の番号)"), answer: z.string().describe("質問への答え。短く、具体的に") },
      handler: (a) => answerLeadQuestion(p, p.fixedMember("lead"), a.question_id, a.answer),
    }),
    defineTool({
      name: "add_ticket_note",
      description: "既にあるチケットに、責任者からの指示をメモとして書き足す。次に仕事を始める担当が読む。",
      input: { number: z.number().int(), body: z.string() },
      handler: (a) => {
        const t = p.tickets().find((x) => x.number === a.number);
        if (!t) return `#${a.number} はありません`;
        p.addNote(t.id, a.body, "lead");
        return `#${a.number} に書き足しました。`;
      },
    }),
  ];
}

export function leadReply(p: Project, body: string): void {
  if (body.trim()) run(p.db, "INSERT INTO lead_messages (who, body, at) VALUES ('lead', ?, ?)", [body.trim(), p.now()]);
}
