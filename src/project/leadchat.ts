import { z } from "zod";
import { KIND_LABEL, TICKET_KINDS } from "../domain/flow.js";
import { inScope } from "../db/count.js";
import type { GitHub } from "../github/github.js";
import { defineTool, type KuramotoTool } from "../harness/types.js";
import { send } from "./inbox.js";
import { issueRefs, markTicketed } from "./issues.js";
import { runWork } from "./progress.js";
import { teamStatus, triageTools } from "./triage.js";
import type { Project, TicketRow } from "./project.js";
import { dropTicketTool } from "./patrol.js";
import { answerLeadQuestion, leadPendingBlock } from "./questions.js";
import { pendingOwnerDecisions, createTicket } from "./workflow.js";
import { designSystem, requirements, screens } from "./planning.js";
import { addDependency } from "./planning-agent.js";

/**
 * 責任者とリーダーのチャット(非同期)。書いたメッセージは受信箱を通してリーダーに届き、リーダーが手すきのときに返事をする。
 * リーダーは今のチケットの状況を見て答え、頼まれればチケットを作ったり、チケットにメモを書き足して担当に伝えたりする。
 */

export type LeadMessage = { id: number; who: "owner" | "lead" | "system"; body: string; at: string };

export async function leadMessages(p: Project): Promise<LeadMessage[]> {
  return (await inScope(p.pdb, "lead_messages").orderBy("id").execute()) as unknown as LeadMessage[];
}

export async function sayToLead(p: Project, body: string): Promise<void> {
  const text = body.trim();
  if (!text) throw new Error("メッセージがありません");
  await p.pdb.transaction(async () => {
    await p.pdb.insert("lead_messages", { who: "owner", body: text, at: p.now() }).execute();
    // まだ取り出されていない依頼があれば、そこにまとめる(何通書いても、リーダーは 1 回で読む。読んでから書くので tx の中で)
    const pending = await inScope(p.pdb, "messages").where("kind", "=", "chat").where("status", "=", "pending").executeTakeFirst();
    if (!pending) await send(p, { ticketId: null, toRole: "lead", kind: "chat", payload: {} });
  });
}

export async function leadChatView(p: Project) {
  const r = await inScope(p.pdb, "messages").where("kind", "=", "chat").where("status", "in", ["pending", "claimed"]).orderBy("id").limit(1).executeTakeFirst();
  const open = r
    ? await p.pdb.k.selectFrom("runs").select("id").where("project_id", "=", p.pdb.projectId).where("message_id", "=", r.id).where("ended_at", "is", null).orderBy("id", "desc").limit(1).executeTakeFirst()
    : undefined;
  const run_id = open?.id ?? null;
  const w = run_id ? await runWork(p, run_id) : null;
  return {
    lead: (await p.fixedMember("lead")).name,
    messages: await leadMessages(p),
    work: w ? { state: "running" as const, ...w } : r ? { state: "queued" as const } : null,
  };
}

/**
 * リーダーがまだ読んでいない責任者のメッセージ。どこまで読んだかは、チャットの起動ごとに覚えておく(設定 lead_chat_read)。
 * 「最後のリーダーの発言より後」で数えると、交通整理・見回りの報告や、書いている最中の返事に追い越されたメッセージが読まれずに残っていた。
 */
export async function unreadOwnerMessages(p: Project): Promise<LeadMessage[]> {
  const msgs = await leadMessages(p);
  const read = await p.setting("lead_chat_read");
  if (read !== undefined) return msgs.filter((m) => m.who === "owner" && m.id > Number(read));
  // まだ覚えていない(この仕組みの前のデータ)なら、前のやり方で数える
  const lastLead = msgs.map((m) => m.who).lastIndexOf("lead");
  return msgs.slice(lastLead + 1).filter((m) => m.who === "owner");
}

/** 企画で合意した画面とデザインシステムの有無(リーダーが画面のチケットにひも付けるため)。 */
async function planScreens(p: Project): Promise<string> {
  const list = [...(await screens(p))].map(([key, s]) => `- ${key}: ${s.name}(${s.device === "phone" ? "スマホ" : "パソコン"}、要件 ${s.requirements.join("・") || "—"}${s.agreed ? "、合意済み" : "、まだ合意していない"})`);
  const ds = await designSystem(p);
  return `${list.join("\n") || "(なし)"}\nデザインシステム: ${ds ? `あり(トークン ${ds.tokens.length}・部品 ${ds.components.length})` : "まだありません"}`;
}

/** 返事をするメッセージより前の、最近のやりとり(責任者とリーダーの会話。報告は短く)。 */
async function recentChat(p: Project, unread: LeadMessage[]): Promise<string> {
  const first = unread[0]?.id ?? Infinity;
  const n = await p.settingNumber("lead_chat_history", 12);
  const lead = (await p.fixedMember("lead")).name;
  const rows = (await leadMessages(p)).filter((m) => m.id < first && m.who !== "system").slice(-n);
  return rows.map((m) => `- ${m.who === "owner" ? "責任者" : lead}: ${m.body.length > 400 ? `${m.body.slice(0, 400)}…` : m.body}`).join("\n") || "(なし)";
}

/** ここまで読んだ(返事を書き終えた)。 */
export async function markOwnerMessagesRead(p: Project, upTo: number): Promise<void> {
  if (upTo > Number(await p.setting("lead_chat_read") ?? 0)) await p.setSetting("lead_chat_read", String(upTo));
}

/** リーダーへの指示。今のチケットの状況と、まだ返事をしていない責任者のメッセージを渡す。 */
export async function leadChatPrompt(p: Project, unread?: LeadMessage[]): Promise<string> {
  unread ??= await unreadOwnerMessages(p);
  const tickets = (await p.tickets()).filter((t) => t.stage !== "dropped");
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
${await leadPendingBlock(p)}

## 企画の画面(画面を作る・直すチケットは、create_ticket の screens にこの key を書く)
${await planScreens(p)}

## 最近のやりとり(古い順。前の起動の会話は引き継がないので、ここで流れをつかむ)
${await recentChat(p, unread)}

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

export function leadChatTools(p: Project, ws: { closePrs?: (t: TicketRow, reason: string) => Promise<void>; github?: GitHub } = {}): KuramotoTool[] {
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
        all_screens: z.boolean().optional().describe("全画面を試作と見比べるチケットなら true(全画面の試作が担当に渡る)"),
        after: z.array(z.number().int()).optional().describe("先に merge されている必要があるチケットの番号(画面のチケットは、デザインシステムの土台のチケットを書く)"),
        issue: z.number().int().optional().describe("このチケットで片付ける GitHub Issue の番号(あれば)。チケットの詳細から Issue に飛べ、PR に「Closes #番号」が付く"),
        issue_repo: z.string().optional().describe("その Issue のリポジトリ(owner/repo)。複数のリポジトリに同じ番号があるときだけ要る"),
      },
      handler: async (a) => {
        const known = new Set((await screens(p)).keys());
        const bad = (a.screens ?? []).filter((k) => !known.has(k));
        if (bad.length) return `画面 ${bad.join("・")} は企画にありません。使えるのは ${[...known].join("・") || "(なし)"}`;
        const item = a.requirement ? (await requirements(p)).find((r) => r.code === a.requirement) : undefined;
        if (a.requirement && !item) return `要件 ${a.requirement} はありません`;
        const linked = a.issue ? await issueRefs(p, a.issue, a.issue_repo) : undefined;
        if (linked?.ambiguous) return linked.ambiguous;
        // 同じ Issue で二度チケットを切らない(チケットにした・既存のチケットに足した Issue は、もう扱い済み)
        if (linked?.issue && (linked.issue.status === "ticketed" || linked.issue.status === "duplicate")) return `Issue #${a.issue} は、もう${linked.issue.ticket_id ? `チケットに扱っています(#${(await p.ticket(linked.issue.ticket_id)).number})` : "扱い済みです"}。チケットは増やしません`;
        const t = await createTicket(p, {
          title: a.title,
          body: a.body,
          kind: a.kind ?? "feature",
          ...(item ? { requirementItemId: item.id } : {}),
          planRefs: { ...linked?.refs, ...(a.screens?.length ? { screens: a.screens } : {}), ...(a.requirement ? { requirement: a.requirement } : {}), ...(a.design_system ? { designSystem: true } : {}), ...(a.all_screens ? { allScreens: true } : {}) },
        });
        for (const n of a.after ?? []) {
          const dep = (await p.tickets()).find((x) => x.number === n);
          if (dep) await addDependency(p, t.id, dep.id);
        }
        // 取ってきた Issue なら、扱い済みにする(同じ Issue で二度チケットを切らない)
        if (linked?.issue) await markTicketed(p, ws.github, linked.issue, t);
        return `#${t.number} を作りました。`;
      },
    }),
    defineTool({
      name: "answer_question",
      description: "リーダーに回ってきたメンバーの質問(リーダー宛て・経路が無かったもの)に答える。答えはチケットのやりとりに残り、次にそのチケットの仕事をする担当の指示に入る。",
      input: { question_id: z.number().int().describe("質問の番号(「答えを待っている質問」の番号)"), answer: z.string().describe("質問への答え。短く、具体的に") },
      handler: async (a) => answerLeadQuestion(p, await p.fixedMember("lead"), a.question_id, a.answer),
    }),
    defineTool({
      name: "add_ticket_note",
      description: "既にあるチケットに、責任者からの指示をメモとして書き足す。次に仕事を始める担当が読む。",
      input: { number: z.number().int(), body: z.string() },
      handler: async (a) => {
        const t = (await p.tickets()).find((x) => x.number === a.number);
        if (!t) return `#${a.number} はありません`;
        await p.addNote(t.id, a.body, "lead");
        return `#${a.number} に書き足しました。`;
      },
    }),
  ];
}

export async function leadReply(p: Project, body: string): Promise<void> {
  if (body.trim()) await p.pdb.insert("lead_messages", { who: "lead", body: body.trim(), at: p.now() }).execute();
}
