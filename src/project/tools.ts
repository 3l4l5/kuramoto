import { z } from "zod";
import { defineTool, type KuramotoTool } from "../harness/types.js";
import type { MessageKind } from "./inbox.js";

/** 起動 1 回の中でエージェントが道具を通して報告した内容。起動が終わってから工程に反映する。 */
export type RunReport = {
  /** 開発が submit_pr で渡した PR の中身。起動のあとで Kuramoto が push して PR にし、pr に入れる(ADR-0020)。 */
  draft?: { title?: string; body?: string; summary: string; conflictResolution?: "mechanical" | "logic" };
  pr?: { repo: string; number: number; head: string; summary: string; conflictResolution?: "mechanical" | "logic" };
  /** 指摘への開発の返事 */
  responses?: Response[];
  review?: { findings: Finding[]; resolutions: Resolution[]; followups?: Followup[] };
  question?: Question;
  leadDecision?: { choice: number; reason: string; note?: string };
  escalate?: { reason: string };
};

export type Finding = {
  category: string;
  severity: "high" | "medium" | "low";
  blocking?: boolean;
  basis?: "acceptance" | "security" | "regression" | "other";
  path?: string;
  line?: number;
  body: string;
};

/** チケットの範囲外の指摘を、別チケットの候補として切り出したもの。リーダーが交通整理でチケットにする。 */
export type Followup = { title: string; body: string };
export type Response = { findingId: number; action: "fixed" | "wontfix"; comment: string };
export type Resolution = { findingId: number; result: "resolved" | "accept" | "reopen"; comment?: string };

/** 起動ごとに、返事・確認が必要な指摘の番号。道具がその場で漏れを指摘する。 */
export type ToolContext = {
  mustAnswer?: number[];
  mustResolve?: number[];
  /** 責任者に上げてよいか。ノンストップでは、戻せる判断は上げずにチームで決める(ADR-0022)。 */
  escalateAllowed?: boolean;
  /** submit_pr を受ける前に作業場所を確かめる(コミットし忘れなど)。問題があればその理由。 */
  checkReady?: () => Promise<string | undefined>;
};

export type Question = {
  /** 全体のどこの話か */
  context: string;
  /** 何を決めるか */
  question: string;
  options: string[];
  recommended: number;
  why: string;
  /** 間違えると何が起きるか */
  impact: string;
  reversible: boolean;
};

const finding = z.object({
  category: z.string().describe("指摘の種類(correctness / security / test / design / style など)"),
  severity: z.enum(["high", "medium", "low"]),
  blocking: z.boolean().optional().describe("直さないと通せないなら true(必須)、直すとよいが通してよいなら false(提案・nit)。省くと severity が low なら提案、それ以外は必須"),
  basis: z
    .enum(["acceptance", "security", "regression", "other"])
    .optional()
    .describe(
      "必須にする根拠。acceptance: チケットの受け入れ条件を満たしていない / security: セキュリティの問題 / regression: この差分で入った不具合(前は動いていたものが壊れた・明らかなバグ) / other: それ以外。必須(blocking: true)にできるのは acceptance・security・regression だけ",
    ),
  path: z.string().optional(),
  line: z.number().int().optional(),
  body: z.string().describe("何が問題で、どう直すべきか"),
});

const question = {
  context: z.string().describe("全体のどこの話か(要件・画面・機能のどこか)"),
  question: z.string().describe("何を決めるか。1 文で"),
  options: z.array(z.string()).min(2).max(4),
  recommended: z.number().int().min(0).describe("options の何番目を推奨するか(0 始まり)"),
  why: z.string().describe("推奨の理由"),
  impact: z.string().describe("間違えると何が起きるか"),
  reversible: z.boolean().describe("後から戻せるか"),
};

/** メッセージの種類ごとに、エージェントへ渡す道具を組み立てる。 */
export function toolsFor(kind: MessageKind, report: RunReport, ctx: ToolContext = {}): KuramotoTool[] {
  const submitPr = defineTool({
    name: "submit_pr",
    description:
      "作業が終わったことを Kuramoto に報告する。変更はすべてコミットしてから呼ぶ。push と PR の作成・更新は Kuramoto が行う。作業の最後に必ず 1 回呼ぶ。",
    input: {
      title: z.string().optional().describe("PR のタイトル。PR がまだ無いときに使う。省くとチケットのタイトル"),
      body: z.string().optional().describe("PR の本文(何を・なぜ変えたか、確かめ方)。PR がまだ無いときに使う。省くと summary"),
      summary: z.string().describe("何をしたかの要約(リーダー向け。レビューには渡さない)"),
      conflict_resolution: z
        .enum(["mechanical", "logic"])
        .optional()
        .describe("衝突を解いたときだけ: 機械的に解けたら mechanical、ロジックに手を入れたら logic"),
      responses: z
        .array(
          z.object({
            finding_id: z.number().int(),
            action: z.enum(["fixed", "wontfix"]).describe("直したら fixed、直さないなら wontfix"),
            comment: z.string().describe("fixed ならどう直したか、wontfix なら直さない理由"),
          }),
        )
        .default([])
        .describe("指摘への返事。必須の指摘にはすべて返事をする。提案(nit)への返事は任意"),
    },
    handler: async ({ conflict_resolution, responses: given, title, body, summary }) => {
      const responses = given ?? [];
      const missing = (ctx.mustAnswer ?? []).filter((id) => !responses.some((r) => r.finding_id === id));
      if (missing.length) return `必須の指摘 ${missing.join(", ")} に返事がありません。responses に fixed か wontfix(理由つき)で入れて呼び直してください。`;
      const empty = responses.filter((r) => r.action === "wontfix" && !r.comment.trim());
      if (empty.length) return `直さない指摘(${empty.map((r) => r.finding_id).join(", ")})には理由を書いてください。`;
      const notReady = await ctx.checkReady?.();
      if (notReady) return notReady;
      report.draft = { summary, ...(title?.trim() ? { title: title.trim() } : {}), ...(body?.trim() ? { body: body.trim() } : {}), ...(conflict_resolution ? { conflictResolution: conflict_resolution } : {}) };
      report.responses = responses.map((r) => ({ findingId: r.finding_id, action: r.action, comment: r.comment }));
      return "受け付けました。Kuramoto が push して PR に反映し、次の工程に回します。";
    },
  });

  const raiseQuestion = defineTool({
    name: "raise_question",
    description: "自分では決められない判断をリーダーに上げる。仕様・約束・セキュリティ・取り消せない操作に関わるときに使う。呼んだら作業を止めてよい。",
    input: question,
    handler: (a) => {
      if (a.recommended >= a.options.length) return "recommended が options の範囲外です。直して呼び直してください。";
      report.question = a;
      return "リーダーに上げました。答えが出たら続きから再開します。";
    },
  });

  const submitReview = defineTool({
    name: "submit_review",
    description:
      "確認の結果を報告する。最後に必ず 1 回呼ぶ。必須の指摘が残っていれば差し戻し、無ければ承認になる(提案だけなら承認)。再レビューでは、前回の必須の指摘すべてに resolutions で答える。チケットの範囲外の指摘は findings に入れず followups で別チケットの候補にする(PR は止めない)。",
    input: {
      verdict: z.enum(["approve", "changes"]).optional().describe("省いてよい。指摘から決まる(必須が残れば changes)"),
      findings: z.array(finding).default([]).describe("新しい指摘"),
      resolutions: z
        .array(
          z.object({
            finding_id: z.number().int(),
            result: z.enum(["resolved", "accept", "reopen"]).describe("直っていれば resolved、直さない理由に納得したら accept、まだ問題なら reopen"),
            comment: z.string().optional(),
          }),
        )
        .default([])
        .describe("前回までの指摘への答え"),
      followups: z
        .array(z.object({ title: z.string().min(1).describe("別チケットのタイトル"), body: z.string().describe("やること・なぜ必要か・どこで見つけたか") }))
        .default([])
        .describe("このチケットの範囲外だが、後で直すべきこと。別チケットの候補になり、リーダーが順番と担当を決める。この PR は止めない"),
    },
    handler: (input) => {
      const a = { ...input, findings: input.findings ?? [], resolutions: input.resolutions ?? [], followups: input.followups ?? [] };
      // 必須にしてよいのは、受け入れ条件・セキュリティ・この差分で入った不具合だけ(往復が終わらなくなるのを防ぐ)
      const unfounded = a.findings.filter((f) => (f.blocking ?? f.severity !== "low") && !["acceptance", "security", "regression"].includes(f.basis ?? ""));
      if (unfounded.length)
        return `必須の指摘には根拠(basis)が要ります: ${unfounded.map((f) => `「${f.body.slice(0, 40)}」`).join("、")}。受け入れ条件を満たしていない(acceptance)・セキュリティ(security)・この差分で入った不具合(regression)のどれかなら basis を付けて呼び直してください。どれでもなければ blocking: false の提案にするか、チケットの範囲外なら followups にしてください。`;
      const missing = (ctx.mustResolve ?? []).filter((id) => !a.resolutions.some((r) => r.finding_id === id));
      if (missing.length) return `前回の指摘 ${missing.join(", ")} に答えがありません。resolutions に resolved / accept / reopen で入れて呼び直してください。`;
      const findings = a.findings.map((f) => stripUndefined({ ...f, blocking: f.blocking ?? f.severity !== "low" }));
      const blocking = findings.some((f) => f.blocking) || a.resolutions.some((r) => r.result === "reopen");
      if (a.verdict === "changes" && !blocking) return "差し戻すなら、必須(blocking: true)の指摘を 1 件以上入れるか、前回の指摘を reopen してください。提案だけなら承認にしてください。";
      if (a.verdict === "approve" && blocking) return "必須の指摘や reopen が残っているので承認にはできません。提案にするなら blocking: false にしてください。";
      report.review = {
        findings,
        resolutions: a.resolutions.map((r) => stripUndefined({ findingId: r.finding_id, result: r.result, comment: r.comment })),
        followups: a.followups,
      };
      return blocking ? "差し戻しとして受け付けました。" : "承認として受け付けました。";
    },
  });

  const decide = defineTool({
    name: "decide",
    description:
      "判断を決める。決めた内容と理由は、あとで責任者に報告される(責任者は止めずに、違えばあとから指示する)。分からない点は仮に決め、その前提を reason と note に書く。",
    input: {
      choice: z.number().int().min(0),
      reason: z.string().describe("なぜそう決めたか。仮に決めた前提があれば書く"),
      note: z
        .string()
        .optional()
        .describe("担当への指示(チケットのメモになり、次に動く担当が読む)。例: 版は MySQL 8.4 に仮決め / 範囲外の指摘は別チケットに回す / 止めてよいのは受け入れ条件・セキュリティだけ"),
    },
    handler: (a) => {
      report.leadDecision = a;
      return "決めました。持ち主に伝えます。";
    },
  });

  const escalate = defineTool({
    name: "escalate_to_owner",
    description:
      "仕様・契約・セキュリティ・取り消せない操作に関わる判断を責任者に上げる。reason はそのまま責任者の判断のカードに出る。責任者は選択肢から選び、答え・指示を書いて返せる(書いた答えはチケットのメモになり、担当が読む)。",
    input: { reason: z.string().describe("責任者に上げる理由と、責任者に聞きたいこと(具体的に。番号を付けると答えやすい)") },
    handler: (a) => {
      if (ctx.escalateAllowed === false)
        return "ノンストップで進めるため、戻せる判断は責任者に上げません。チームで責任を持って decide で決めてください。分からない点は仮に決め、その前提を reason に、担当への指示を note に書いてください(責任者にはあとで報告され、違えば指示が来ます)。";
      report.escalate = a;
      return "責任者に上げました。";
    },
  });

  switch (kind) {
    case "implement":
    case "fix":
    case "answer":
      return [submitPr, raiseQuestion];
    case "review":
    case "sec":
    case "qa":
      return [submitReview];
    case "decide":
      return [decide, escalate];
    case "plan":
    case "chat":
    case "triage":
    case "unstick":
      return [];
  }
}

function stripUndefined<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}
