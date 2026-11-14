import { answeredBlock } from "./questions.js";
import { configuredCommands, teamCiEnabled } from "./team-ci.js";
import { rulesNote } from "./dev-rules.js";
import { speechNote } from "../domain/cast.js";
import { mustAnswer, mustResolve, openNits, threadText } from "./review.js";
import { ROLE_LABEL, type Role } from "../domain/roles.js";
import type { MessageRow } from "./inbox.js";
import type { PolicyRow, Project, TicketRow } from "./project.js";
import { requirements } from "./planning.js";
import { inScope } from "../db/count.js";
import { teamBranchLabel } from "./team-branch.js";
import { decision, nonstop, type DecisionOption } from "./workflow.js";

/**
 * 役割ごとの基本指示。Kuramoto が固定で持ち、責任者が触れるのは「重視すること」だけ(ADR-0010)。
 */
const BASE: Partial<Record<Role, string>> = {
  dev: `あなたは Kuramoto の開発チームの開発担当です。割り当てられたチケットを実装し、GitHub に PR を出します。
- 作業はこの作業場所(git worktree)の中だけで行います。外のファイルは読めず、通信も一部のサイト(パッケージの取得先など)に限られます。
- 変更はこのブランチにコミットし、submit_pr で報告します。push と PR の作成・更新は Kuramoto が行うので、git push や gh は使いません(使えません)。
- 仕様・約束・セキュリティ・取り消せない操作に関わる判断は自分で決めず、raise_question でリーダーに上げます。
- merge はしません。merge は責任者が押します。`,
  review: `あなたは Kuramoto の開発チームのレビュー担当です。PR の差分とチケットだけを見てレビューします。
- 作業場所には PR のブランチが取り出してあります。差分は指示にある git diff で見ます(gh は使えません)。実装者の説明は判断材料にしません。
- コードは変更しません。
- 結果は submit_review で報告します。直してほしい点があれば changes と指摘を、無ければ approve を渡します。
- 基準はチケットの受け入れ条件です。止めてよいのは、受け入れ条件・セキュリティ・この差分で入った不具合だけです。範囲外のことは別チケットの候補にします。`,
  sec: `あなたは Kuramoto の開発チームのセキュリティ担当です。PR の差分を、認証・認可・入力の扱い・秘密情報の観点で確かめます。
- コードは変更しません。結果は submit_review で報告します。
- 止めてよいのはセキュリティの問題と、この差分で入った不具合だけです。範囲外のことは別チケットの候補にします。`,
  qa: `あなたは Kuramoto の開発チームの QA 担当です。チケットの受け入れ条件どおりに動くかを確かめます。
- 必要ならテストやアプリを動かして確かめます。コードは変更しません。結果は submit_review で報告します。`,
  lead: `あなたは Kuramoto の開発チームのリーダーです。チームから上がった判断を受けます。
- 判断は decide で返します。どこまで自分で決め、どこから escalate_to_owner で責任者に上げるかは、下の方針に従います。`,
};

const STRICTNESS: Record<string, string> = {
  important: "重要な指摘(不具合・セキュリティ・データの破損)だけを出してください。",
  standard: "不具合と、保守を明らかに難しくする点を指摘してください。好みの問題は指摘しません。",
  detailed: "細かい点も含めて指摘してください。",
};

const ASK_OWNER: Record<string, string> = {
  heavy: "責任者に上げるのは、取り消せない操作とセキュリティに関わるものだけにしてください。",
  medium: "仕様・契約・セキュリティ・取り消せない操作に関わるものは責任者に上げてください。",
  all: "迷うものはすべて責任者に上げてください。",
};

export async function systemPromptFor(p: Project, role: Role, policy: PolicyRow, unit?: { name: string | null; focus: string | null }, memberName?: string): Promise<string> {
  const opts = JSON.parse(policy.options) as Record<string, unknown>;
  const parts = [BASE[role] ?? `あなたは Kuramoto の${ROLE_LABEL[role]}担当です。`];
  if (role === "dev") {
    if (opts.requireTests) parts.push("- 変更にはテストを付けてください。");
    if (opts.smallPr) parts.push("- PR は小さく保ってください。チケットの範囲を超える変更はしません。");
  }
  if (role === "review") parts.push(`- ${STRICTNESS[String(opts.strictness ?? "standard")] ?? STRICTNESS.standard}`);
  if (role === "lead")
    parts.push(
      await nonstop(p)
        ? `- ノンストップで進めます。チームで責任を持って決め、責任者には上げません(上げてよいのは取り消せない操作だけ)。分からない点は仮に決め、その前提を decide の reason に、担当への指示を note に書きます。決めたことは責任者にあとで報告され、違えば指示が来ます。
- 往復が続くときは、受け入れ条件・セキュリティ・この差分の不具合だけを必須として通し、範囲外のことは別チケットに回す方針で決めます。保留は選びません。`
        : `- ${ASK_OWNER[String(opts.askOwner ?? "medium")] ?? ASK_OWNER.medium}`,
    );
  const jira = await p.setting("jira_key");
  if (jira && role === "dev") parts.push(`- ブランチ名・コミット・PR タイトルにチケットの Jira 番号を入れてください。`);
  if (policy.focus.trim()) parts.push(`\n## このプロジェクトで重視すること\n${policy.focus.trim()}`);
  if (unit?.focus?.trim()) parts.push(`\n## あなたの島(${unit.name})で重視すること\n${unit.focus.trim()}`);
  if (memberName) parts.push(speechNote(memberName));
  return parts.join("\n");
}

/** チームの CI を使うプロジェクトなら、submit_pr のあとに流す確認を伝える(先に手元で通しておく)。 */
async function teamCiNote(p: Project, repo?: string): Promise<string> {
  if (!await teamCiEnabled(p) || !repo) return "";
  const cmds = await configuredCommands(p, repo);
  return `\nsubmit_pr のあと、Kuramoto がチームの CI(PR を最新の ${await teamBranchLabel(p)} と合わせて${cmds ? `、${cmds.map((c) => `\`${c}\``).join(" → ")} を流す` : "、lint・型・テストを流す"})で確かめ、通ったものだけをレビューに回します。報告の前に、手元で同じ確認を通しておいてください。`;
}

export async function promptFor(p: Project, msg: MessageRow, ticket: TicketRow | null, ctx: { branch?: string; base?: string; repo?: string; prNumber?: number }): Promise<string> {
  const branch = ctx.base ?? await teamBranchLabel(p);
  const base = `origin/${branch}`;
  const payload = JSON.parse(msg.payload) as Record<string, unknown>;
  const notes = ticket ? await p.notes(ticket.id) : [];
  // 開発より前の確認(R17)が残した申し送りは、メモとは分けて載せる。開発は読んでから着手する
  const handoffs = ticket ? await p.handoffs(ticket.id) : [];
  const head = ticket
    ? ticketBlock(ticket) +
      (notes.length ? `\n\n### メモ(責任者・リーダーから)\n${notes.map((n) => `- ${n.who === "lead" ? "リーダー" : "責任者"}: ${n.body}`).join("\n")}` : "") +
      (ticket ? await answeredBlock(p, ticket.id) : "") +
      (handoffs.length ? `\n\n### 申し送り(開発より前の確認から。着手の前に読んでください)\n${handoffs.map((h) => `- ${ROLE_LABEL[h.role] ?? h.role}: ${h.body}`).join("\n")}` : "")
    : "";
  switch (msg.kind) {
    case "implement":
      return `${head}\n\nこのチケットを実装してください。リポジトリは ${ctx.repo}、ブランチは ${ctx.branch}(作業場所で取り出し済み)です。終わったら変更をコミットし、submit_pr で報告してください(PR のタイトルと本文も渡せます)。push と PR の作成は Kuramoto が行います。${await teamCiNote(p, ctx.repo)}${await rulesNote(p)}`;
    case "fix": {
      // CI の失敗など、スレッドにならない指示
      const extra = ((payload.findings as { severity: string; body: string }[] | undefined) ?? []).map((f) => `- [${f.severity}] ${f.body}`).join("\n");
      if (payload.conflict) {
        return `${head}\n\nあなたが出した PR #${ctx.prNumber ?? "?"} について。merge 待ちの間に ${base} が進み、衝突しました(原因: ${String(payload.cause ?? "不明")})。${base} は取得済みです。git merge ${base} で衝突を解いてコミットしてください。\n直したら submit_pr で報告してください(push は Kuramoto が行います)。`;
      }
      if (Array.isArray(payload.rules)) {
        const rules = payload.rules as { name: string; body: string; detail: string }[];
        return `${head}\n\nあなたが出した PR #${ctx.prNumber ?? "?"}(リポジトリは ${ctx.repo}、ブランチは ${ctx.branch})は、次の開発ルールに反したままです。直すまで次の工程(レビューなど)には進めません。\n${rules.map((r) => `- 「${r.name}」: ${r.detail}(守ること: ${r.body})`).join("\n")}\n\nルールを守るように直し、コミットして submit_pr で報告してください。何も変えずに出し直しても、同じように戻ってきます。${await rulesNote(p)}`;
      }
      const must = ticket ? await mustAnswer(p, ticket.id) : [];
      const nits = ticket ? await openNits(p, ticket.id) : [];
      const from = ROLE_LABEL[(payload.from as Role) ?? "review"];
      return `${head}

${payload.team ? `あなたが出した PR #${ctx.prNumber ?? "?"}(リポジトリは ${ctx.repo}、ブランチは ${ctx.branch})を、Kuramoto がチームの CI で確かめたところ、落ちました。レビューにはまだ回していません。\n${extra}\n\n## チームの CI の直し方\n- チームの CI は、PR のコミットを最新の ${base} と合わせた状態で、上のコマンドを順に流しています(あなたと同じ閉じ込めの中です)。\n- 出力から原因を見つけて直し、手元で git merge ${base} をしてから同じコマンドを流して、通ることを確かめてからコミットします。\n- 何も変えずに出し直しても、同じように落ちて戻ってきます。\n` : payload.ci ? `あなたが出した PR #${ctx.prNumber ?? "?"}(リポジトリは ${ctx.repo}、ブランチは ${ctx.branch})の CI が落ちて、merge できませんでした。\n${extra}\n\n## CI の直し方\n- あなたの作業場所からは GitHub(Actions のログ・PR の Checks)は見えません。上のログは Kuramoto が取ってきたものです。もっと見たいときは ci_status・ci_run・ci_settings で Kuramoto に取ってきてもらえます。ログから原因を見つけて直し、手元で同じコマンドを動かして確かめてからコミットします。\n- この PR の変更と関係のない失敗に見えるなら、git merge ${base} で ${branch} を取り込んでから確かめます(${branch} 側で直っていることがあります)。\n- 何も変えずに出し直しても、同じように落ちて戻ってきます。ログが届くのを待つことはしません(要るものは道具で取れます)。\n` : `あなたが出した PR #${ctx.prNumber ?? "?"}(リポジトリは ${ctx.repo}、ブランチは ${ctx.branch})が${from}から差し戻されました。${extra ? `\n${extra}\n` : ""}`}
## 必須の指摘(すべてに返事をする)
${must.map(threadText).join("\n") || "(なし)"}

## 提案(nit。直すかは任せる)
${nits.map(threadText).join("\n") || "(なし)"}

## 進め方
- 指摘に納得できるものは直し、responses に fixed とどう直したかを書きます。
- 指摘が間違っている・チケットの範囲外・直すと別の問題が起きるときは、直さずに wontfix と理由を書きます。言いなりにならず、根拠をもって返してください。
- 直したらコミットし、submit_pr(responses つき)で報告してください。push は Kuramoto が行い、同じ PR に反映されます。返事は${from}の同じ担当が読み、もう一度確かめます。`;
    }
    case "answer":
      return `${head}\n\n上げた判断に答えが出ました。\n問い: ${String(payload.question)}\n答え: ${String(payload.answer)}\nこの答えに沿って作業を続け、終わったらコミットして submit_pr で報告してください。`;
    case "review":
    case "sec":
    case "qa": {
      if (payload.preDev) return preDevPrompt(p, msg.kind, ticket, head);
      const prior = ticket ? await mustResolve(p, ticket.id, msg.kind) : [];
      const criteria = ticket ? (await acceptanceBlock(p, ticket)) : "";
      const how = `${criteria}## 何を止めるか(必須にしてよいのは 3 つだけ)
- 必須(blocking: true)にしてよいのは、次のどれかに当たるものだけです。根拠を basis に付けます。
  - acceptance: このチケットの受け入れ条件を満たしていない
  - security: セキュリティの問題(認証・認可・入力の扱い・秘密情報など)
  - regression: この差分で入った不具合(前は動いていたものが壊れた・明らかなバグ)
- それ以外(書き方・好み・性能の心配・もっと良くできる点)は提案(blocking: false)にします。必須が残らなければ承認になります。
- このチケットの範囲外のこと(後のチケットで扱う機能・別の画面・別の API)は、指摘にせず followups に書きます。PR は止めません。
  - 先に下の「開いているチケット」を見て、同じことを扱うチケットがあれば、followups の existing にその番号を書きます(新しいチケットは作らず、そのチケットにメモとして足します)。
  - 無ければ、この PR が merge されたときに別チケットになり、リーダーが順番と担当を決めます。
${ticket ? await openTicketsBlock(p, ticket) : ""}
- ベースのブランチとの衝突・merge できるかどうかは見ません。merge の前に Kuramoto が確かめ、衝突していれば持ち主に直させます。
- 確かめるための道具が動かない(テストやブラウザが起動しない)ときは、それを理由に差し戻しません。コードを読んで確かめられた範囲で判断し、動かせなかったことを提案として書きます。
- 指摘には、何が問題で、どう直すべきかを書きます。`;
      const recheck = ticket ? await p.setting(`recheck:${ticket.id}`) : undefined;
      if (recheck && !prior.length) {
        return `${head}

${ctx.repo} の PR #${ctx.prNumber} は、確認がすべて済んで merge を待っていましたが、その後に変更が入りました(${branch} との衝突の解消や、CI の失敗の直しなど)。
前に承認されたコミット ${recheck} のあとに、このブランチ自身が足した変更だけを確かめてください。全体を見直す必要はありません。

- 変更は git log --no-merges -p ${recheck}..HEAD ^${base} で見られます(${branch} から取り込んだものは除かれます)。
- その変更で、受け入れ条件を満たさなくなっていないか・セキュリティの問題や不具合が入っていないかを見ます。問題が無ければ承認します。承認すると、ほかの確認はやり直さずに merge 待ちに戻ります。
- 結果は submit_review で報告してください。

${how}`;
      }
      if (!prior.length) {
        return `${head}\n\n${ctx.repo} の PR #${ctx.prNumber} を確かめてください。作業場所に PR のブランチが取り出してあり、差分は git diff ${base}...HEAD で見られます。結果は submit_review で報告してください。\n\n${how}`;
      }
      return `${head}

${ctx.repo} の PR #${ctx.prNumber} の再レビューです。前回あなた(または同じ役割の担当)が差し戻し、開発が直して返事をしました。

## 前回の指摘とやりとり(すべてに resolutions で答える)
${prior.map(threadText).join("\n")}

## 進め方
- 前回からの変更を中心に見ます(git log ${base}..HEAD でコミットを確かめ、git diff ${base}...HEAD で差分を見る)。全体をまっさらに見直す必要はありません。
- 「直した」ものは本当に直っているかを確かめ、直っていれば resolved、まだなら reopen と何が足りないかを書きます。
- 「直さない」には理由を読み、納得できれば accept、それでも直すべきなら reopen と根拠を書きます(意見が割れたらリーダーが裁定します)。
- 新しい指摘は、直しで入った問題か、前回見落としていた重大な問題(受け入れ条件・セキュリティ・不具合)だけにします。後から論点を増やして往復を長引かせないでください。
- 前回の指摘でも、上の「必須にしてよい 3 つ」に当たらないもの・範囲外のものは、reopen せず accept します(範囲外なら followups に回します)。

${how}`;
    }
    case "plan":
    case "chat":
    case "triage":
    case "unstick":
    case "patrol":
    case "periodic_review":
    case "member_chat":
    case "ask":
      return "";
    case "decide": {
      const d = await decision(p, Number(payload.decision_id));
      const options = (JSON.parse(d.options) as DecisionOption[]).map((o, i) => `${i}. ${o.label}${i === d.recommended ? "(推奨)" : ""}`).join("\n");
      return `${head}\n\nチームから判断が上がりました。\n${d.question}\n選択肢:\n${options}\n推奨の理由: ${d.why}\n間違えると: ${d.impact}\n戻せるか: ${d.reversible ? "戻せる" : "戻せない"}\n\ndecide で決めるか、escalate_to_owner で責任者に上げてください。`;
    }
  }
}

/** 開発より前の確認(R17)の指示に足す、システムプロンプトの注意。 */
export const PRE_DEV_NOTE = `
## 今回の仕事: 開発より前の申し送り
- 今回は開発より前の確認です。PR も差分もありません。コードは見ず、指示にあるチケットの中身だけを読みます。
- 結果は submit_review ではなく leave_handoff で報告します。差し戻しはありません(往復にも数えません)。`;

/** 開発より前の確認(R17)の指示。コードは見ず、チケットの中身を読んで、開発への申し送りを残す。 */
async function preDevPrompt(p: Project, role: "review" | "sec" | "qa", ticket: TicketRow | null, head: string): Promise<string> {
  const refs = ticket ? (JSON.parse(ticket.plan_refs || "{}") as { screens?: string[]; design?: string[] }) : {};
  const refLines = [refs.screens?.length ? `- ひも付く画面: ${refs.screens.join("・")}` : "", refs.design?.length ? `- ひも付く設計の節: ${refs.design.join("・")}` : ""].filter(Boolean).join("\n");
  const view: Record<"review" | "sec" | "qa", string> = {
    review: "設計や進め方で、あとのレビューで引っかかりそうな点(責務の置き場所・既存の作りとのそろえ方・範囲の切り方)",
    sec: "認証・認可・入力の扱い・秘密情報の観点で、実装の前に気をつけておくべき点",
    qa: "受け入れ条件をどう確かめるか(確かめる観点・再現の手順・境界の条件・見落としやすい点)",
  };
  return `${head}

${ticket ? (await acceptanceBlock(p, ticket)) : ""}${refLines ? `${refLines}\n\n` : ""}このチケットは開発より前の${ROLE_LABEL[role]}です。コードは見ずに、上のチケットの中身(本文・要件の受け入れ条件・画面・設計)だけを読んでください。
開発が着手する前に知っておくべきこととして、特に次を、開発への申し送りにまとめます。
- ${view[role]}
- チケットの本文だけでは曖昧な点(あれば、どう解釈して進めるとよいか)
- 結果は leave_handoff で 1 回報告してください。差し戻しはなく、往復にも数えません。開発はこの申し送りを読んでから着手します。`;
}

/**
 * 判断の基準にする受け入れ条件。チケットにひも付いた要件と、本文に出てくる要件の番号(R1 など)の受け入れ条件を並べる。
 * チケットの本文の「受け入れ条件」は、チケットの節にそのまま入っている。
 */
export async function acceptanceBlock(p: Project, t: TicketRow): Promise<string> {
  const codes = new Set<string>(t.body.match(/\bR\d+\b/g) ?? []);
  const reqId = (await inScope(p.pdb, "tickets").where("id", "=", t.id).executeTakeFirst())?.requirement_item_id;
  const linked = reqId ? (await requirements(p)).find((r) => r.id === reqId) : undefined;
  if (linked) codes.add(linked.code);
  const items = (await requirements(p)).filter((r) => codes.has(r.code));
  if (!items.length) return "## 判断の基準\nこのチケットの本文(やること・受け入れ条件)を基準にします。\n\n";
  return `## 判断の基準: 受け入れ条件\nこのチケットの本文に加えて、次の要件の受け入れ条件を基準にします。\n${items.map((r) => `- ${r.code} ${r.name}: ${r.acceptance}`).join("\n")}\n\n`;
}

function ticketBlock(t: TicketRow): string {
  const id = t.jira_key ? `${t.jira_key}(#${t.number})` : `#${t.number}`;
  return `## チケット ${id}: ${t.title}\n${t.body}`.trim();
}

/** 確認する人に見せる、開いているチケットの一覧(followups の重複を避けるため)。このチケットから出たものを先に、多すぎれば新しいものから。 */
async function openTicketsBlock(p: Project, ticket: TicketRow): Promise<string> {
  const rows = await inScope(p.pdb, "tickets").where("stage", "not in", ["done", "dropped"]).where("id", "<>", ticket.id).orderBy("number", "desc").limit(200).execute();
  const mine = rows.filter((r) => (JSON.parse(r.plan_refs || "{}") as { followupOf?: number }).followupOf === ticket.number);
  const others = rows.filter((r) => !mine.includes(r)).slice(0, Math.max(0, 80 - mine.length));
  const list = [...mine, ...others].map((r) => `  - #${r.number} ${r.title}`).join("\n");
  return list ? `\n## 開いているチケット(followups が重ならないか確かめる)\n${list}\n` : "";
}
