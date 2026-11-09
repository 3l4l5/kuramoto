import { speechNote } from "../domain/cast.js";
import { mustAnswer, mustResolve, openNits, threadText } from "./review.js";
import { ROLE_LABEL, type Role } from "../domain/roles.js";
import type { MessageRow } from "./inbox.js";
import type { PolicyRow, Project, TicketRow } from "./project.js";
import { requirements } from "./planning.js";
import { get } from "../db/sqlite.js";
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

export function systemPromptFor(p: Project, role: Role, policy: PolicyRow, unit?: { name: string | null; focus: string | null }, memberName?: string): string {
  const opts = JSON.parse(policy.options) as Record<string, unknown>;
  const parts = [BASE[role] ?? `あなたは Kuramoto の${ROLE_LABEL[role]}担当です。`];
  if (role === "dev") {
    if (opts.requireTests) parts.push("- 変更にはテストを付けてください。");
    if (opts.smallPr) parts.push("- PR は小さく保ってください。チケットの範囲を超える変更はしません。");
  }
  if (role === "review") parts.push(`- ${STRICTNESS[String(opts.strictness ?? "standard")] ?? STRICTNESS.standard}`);
  if (role === "lead")
    parts.push(
      nonstop(p)
        ? `- ノンストップで進めます。チームで責任を持って決め、責任者には上げません(上げてよいのは取り消せない操作だけ)。分からない点は仮に決め、その前提を decide の reason に、担当への指示を note に書きます。決めたことは責任者にあとで報告され、違えば指示が来ます。
- 往復が続くときは、受け入れ条件・セキュリティ・この差分の不具合だけを必須として通し、範囲外のことは別チケットに回す方針で決めます。保留は選びません。`
        : `- ${ASK_OWNER[String(opts.askOwner ?? "medium")] ?? ASK_OWNER.medium}`,
    );
  const jira = p.setting("jira_key");
  if (jira && role === "dev") parts.push(`- ブランチ名・コミット・PR タイトルにチケットの Jira 番号を入れてください。`);
  if (policy.focus.trim()) parts.push(`\n## このプロジェクトで重視すること\n${policy.focus.trim()}`);
  if (unit?.focus?.trim()) parts.push(`\n## あなたの島(${unit.name})で重視すること\n${unit.focus.trim()}`);
  if (memberName) parts.push(speechNote(memberName));
  return parts.join("\n");
}

export function promptFor(p: Project, msg: MessageRow, ticket: TicketRow | null, ctx: { branch?: string; base?: string; repo?: string; prNumber?: number }): string {
  const base = `origin/${ctx.base ?? "main"}`;
  const payload = JSON.parse(msg.payload) as Record<string, unknown>;
  const notes = ticket ? p.notes(ticket.id) : [];
  const head = ticket ? ticketBlock(ticket) + (notes.length ? `\n\n### メモ(責任者・リーダーから)\n${notes.map((n) => `- ${n.who === "lead" ? "リーダー" : "責任者"}: ${n.body}`).join("\n")}` : "") : "";
  switch (msg.kind) {
    case "implement":
      return `${head}\n\nこのチケットを実装してください。リポジトリは ${ctx.repo}、ブランチは ${ctx.branch}(作業場所で取り出し済み)です。終わったら変更をコミットし、submit_pr で報告してください(PR のタイトルと本文も渡せます)。push と PR の作成は Kuramoto が行います。`;
    case "fix": {
      // CI の失敗など、スレッドにならない指示
      const extra = ((payload.findings as { severity: string; body: string }[] | undefined) ?? []).map((f) => `- [${f.severity}] ${f.body}`).join("\n");
      if (payload.conflict) {
        return `${head}\n\nあなたが出した PR #${ctx.prNumber ?? "?"} について。merge 待ちの間に ${base} が進み、衝突しました(原因: ${String(payload.cause ?? "不明")})。${base} は取得済みです。git merge ${base} で衝突を解いてコミットしてください。\n直したら submit_pr で報告してください(push は Kuramoto が行います)。`;
      }
      const must = ticket ? mustAnswer(p, ticket.id) : [];
      const nits = ticket ? openNits(p, ticket.id) : [];
      const from = ROLE_LABEL[(payload.from as Role) ?? "review"];
      return `${head}

あなたが出した PR #${ctx.prNumber ?? "?"}(リポジトリは ${ctx.repo}、ブランチは ${ctx.branch})が${from}から差し戻されました。${extra ? `\n${extra}\n` : ""}
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
      const prior = ticket ? mustResolve(p, ticket.id, msg.kind) : [];
      const criteria = ticket ? acceptanceBlock(p, ticket) : "";
      const how = `${criteria}## 何を止めるか(必須にしてよいのは 3 つだけ)
- 必須(blocking: true)にしてよいのは、次のどれかに当たるものだけです。根拠を basis に付けます。
  - acceptance: このチケットの受け入れ条件を満たしていない
  - security: セキュリティの問題(認証・認可・入力の扱い・秘密情報など)
  - regression: この差分で入った不具合(前は動いていたものが壊れた・明らかなバグ)
- それ以外(書き方・好み・性能の心配・もっと良くできる点)は提案(blocking: false)にします。必須が残らなければ承認になります。
- このチケットの範囲外のこと(後のチケットで扱う機能・別の画面・別の API)は、指摘にせず followups で別チケットの候補にします。PR は止めません。リーダーが順番と担当を決めます。
- ベースのブランチとの衝突・merge できるかどうかは見ません。merge の前に Kuramoto が確かめ、衝突していれば持ち主に直させます。
- 確かめるための道具が動かない(テストやブラウザが起動しない)ときは、それを理由に差し戻しません。コードを読んで確かめられた範囲で判断し、動かせなかったことを提案として書きます。
- 指摘には、何が問題で、どう直すべきかを書きます。`;
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
      return "";
    case "decide": {
      const d = decision(p, Number(payload.decision_id));
      const options = (JSON.parse(d.options) as DecisionOption[]).map((o, i) => `${i}. ${o.label}${i === d.recommended ? "(推奨)" : ""}`).join("\n");
      return `${head}\n\nチームから判断が上がりました。\n${d.question}\n選択肢:\n${options}\n推奨の理由: ${d.why}\n間違えると: ${d.impact}\n戻せるか: ${d.reversible ? "戻せる" : "戻せない"}\n\ndecide で決めるか、escalate_to_owner で責任者に上げてください。`;
    }
  }
}

/**
 * 判断の基準にする受け入れ条件。チケットにひも付いた要件と、本文に出てくる要件の番号(R1 など)の受け入れ条件を並べる。
 * チケットの本文の「受け入れ条件」は、チケットの節にそのまま入っている。
 */
export function acceptanceBlock(p: Project, t: TicketRow): string {
  const codes = new Set<string>(t.body.match(/\bR\d+\b/g) ?? []);
  const reqId = get<{ requirement_item_id: number | null }>(p.db, "SELECT requirement_item_id FROM tickets WHERE id = ?", [t.id])?.requirement_item_id;
  const linked = reqId ? requirements(p).find((r) => r.id === reqId) : undefined;
  if (linked) codes.add(linked.code);
  const items = requirements(p).filter((r) => codes.has(r.code));
  if (!items.length) return "## 判断の基準\nこのチケットの本文(やること・受け入れ条件)を基準にします。\n\n";
  return `## 判断の基準: 受け入れ条件\nこのチケットの本文に加えて、次の要件の受け入れ条件を基準にします。\n${items.map((r) => `- ${r.code} ${r.name}: ${r.acceptance}`).join("\n")}\n\n`;
}

function ticketBlock(t: TicketRow): string {
  const id = t.jira_key ? `${t.jira_key}(#${t.number})` : `#${t.number}`;
  return `## チケット ${id}: ${t.title}\n${t.body}`.trim();
}
