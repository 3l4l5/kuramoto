import { z } from "zod";
import type { GitHub, PrDetail } from "../github/github.js";
import { defineTool, type KuramotoTool } from "../harness/types.js";
import { prsOf } from "./ci-tools.js";
import type { Project, TicketRow } from "./project.js";

/**
 * リーダーが GitHub の PR・CI・merge の状態を「読むだけ」する道具(#56)。
 * リーダーの作業場所は閉じ込められていて(confine.ts)、gh も GitHub API も認証つきでは使えない。
 * そこで Kuramoto 本体が持っている GitHub への接続で、外から読んで答える。トークンも ~/.config/gh も作業場所には出さない。
 * 渡すのは読み取りの口(prDetail)だけで、merge・push・コメント・ラベルなどの書き込みの口は型の上でも渡さない。
 */

/** この道具が GitHub に対して使ってよい口。書き込み(merge・comment・rerunFailed・setActionsEnabled)は含めない。 */
export type GitHubReader = Pick<GitHub, "prDetail">;

const MAX = 12_000;

/** 会話に出さない: 万一、本文やコメントに混ざったトークン。 */
const TOKEN = /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g;

function safe(s: string): string {
  const t = s.replace(TOKEN, "(トークンは伏せました)");
  return t.length > MAX ? `${t.slice(0, MAX)}\n…(長いので切りました)` : t;
}

function errText(e: unknown): string {
  const err = e as { stderr?: string; message?: string };
  return (err?.stderr || err?.message || String(e)).trim().slice(0, 400);
}

const FAILED = ["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE"];
const OK = ["SUCCESS", "NEUTRAL", "SKIPPED"];

function checkState(c: { status: string; conclusion: string | null }): "failed" | "ok" | "pending" {
  const s = (c.conclusion ?? c.status).toUpperCase();
  return FAILED.includes(s) ? "failed" : OK.includes(s) ? "ok" : "pending";
}

/** GitHub の判定から、merge できない理由を言葉にする(できるなら空)。 */
export function mergeBlockers(d: PrDetail): string[] {
  if (d.state !== "OPEN") return [`PR はすでに ${d.state === "MERGED" ? "merge 済み" : "閉じられて"}います(${d.state})`];
  const out: string[] = [];
  if (d.draft) out.push("下書き(draft)の PR です");
  if (d.mergeable === "CONFLICTING" || d.mergeStateStatus === "DIRTY") out.push(`${d.base} と衝突しています(${d.base} が ${d.behind ?? "?"} コミット先に進んでいる)`);
  else if (d.mergeStateStatus === "BEHIND") out.push(`${d.base} より ${d.behind ?? "?"} コミット遅れています(保護ルールで最新に追いつくことを求められている)`);
  if (d.mergeable === "UNKNOWN" || d.mergeStateStatus === "UNKNOWN") out.push("GitHub が merge できるかをまだ計算中です(少し待てば分かる)");
  const failed = d.checks.filter((c) => checkState(c) === "failed");
  const pending = d.checks.filter((c) => checkState(c) === "pending");
  if (failed.length) out.push(`CI が落ちています: ${failed.map((c) => c.name).join("・")}`);
  if (pending.length) out.push(`CI がまだ終わっていません: ${pending.map((c) => c.name).join("・")}`);
  if (d.reviewDecision === "CHANGES_REQUESTED") out.push("GitHub のレビューで変更が求められています");
  if (d.reviewDecision === "REVIEW_REQUIRED") out.push("GitHub のレビュー(承認)がまだ足りません");
  if (d.mergeStateStatus === "BLOCKED" && !out.length) out.push("保護ルール(必須の確認・承認・ブランチの規則)で止められています。リポジトリの設定を見てください");
  if (d.mergeStateStatus === "UNSTABLE" && !failed.length) out.push("必須ではない確認が落ちています(merge 自体はできる)");
  return out;
}

function detailText(d: PrDetail, blockers: string[]): string {
  const verdict = blockers.length ? `merge できません。理由:\n${blockers.map((b) => `- ${b}`).join("\n")}` : "merge できます(衝突なし・CI は通過・止める規則なし)";
  const checks = d.checks.length ? d.checks.map((c) => `- 「${c.name}」: ${c.conclusion ?? c.status ?? "不明"}${c.link ? `(${c.link})` : ""}`).join("\n") : "(確認はありません)";
  return `${d.title}(${d.url})
状態: ${d.state}${d.draft ? "(下書き)" : ""} / GitHub の判定: mergeable=${d.mergeable}, mergeState=${d.mergeStateStatus}, レビュー=${d.reviewDecision ?? "(なし)"}
ブランチ: ${d.head} → ${d.base}(${d.base} より ${d.ahead ?? "?"} 進み・${d.behind ?? "?"} 遅れ、コミット ${d.headSha.slice(0, 7)})

## ${verdict}

## CI の各チェック
${checks}`;
}

/** Kuramoto 自身が merge を止めた記録(GitHub には残らない理由がここにある)。 */
async function kuramotoRecord(p: Project, t: TicketRow): Promise<string> {
  const events = await p.pdb.k
    .selectFrom("events")
    .select(["at", "type", "data"])
    .where("project_id", "=", p.projectId)
    .where("ticket_id", "=", t.id)
    .where("type", "in", ["merge_blocked", "conflict", "sent_back", "merged"])
    .orderBy("id", "desc")
    .limit(3)
    .execute();
  const lines = events.map((e) => {
    let reason = "";
    try {
      reason = (JSON.parse(e.data) as { reason?: string }).reason ?? "";
    } catch {
      /* 読めない記録は理由なしで出す */
    }
    return `- ${e.at} ${e.type}${reason ? `: ${reason}` : ""}`;
  });
  return `## Kuramoto の記録(チケット #${t.number} は「${t.stage}」)\n${lines.join("\n") || "(merge を断った記録はありません)"}`;
}

export function githubReadTools(p: Project, gh: GitHubReader | undefined): KuramotoTool[] {
  if (!gh?.prDetail) return [];
  const prDetail = gh.prDetail.bind(gh);

  /** チケット番号か PR 番号から、読む PR を決める。登録されているリポジトリの PR だけ読む。 */
  const resolve = async (a: { ticket?: number; pr?: number; repo?: string }): Promise<{ repo: string; pr: number; ticket?: TicketRow } | string> => {
    if (a.ticket !== undefined) {
      const t = (await p.pdb.from("tickets").where("number", "=", a.ticket).executeTakeFirst()) as TicketRow | undefined;
      if (!t) return `#${a.ticket} というチケットはありません`;
      const pr = (await prsOf(p, t.id)).at(-1);
      return pr ? { repo: pr.full_name, pr: pr.number, ticket: t } : `#${t.number} にはまだ PR がありません`;
    }
    if (a.pr === undefined) return "ticket(チケット番号)か pr(PR 番号)のどちらかを指定してください";
    const repos = (await p.repos()).map((r) => r.full_name);
    const repo = a.repo ?? repos[0];
    if (!repo || !repos.includes(repo)) return `リポジトリ ${a.repo ?? "(なし)"} は登録されていません。使えるのは ${repos.join("・") || "(なし)"}`;
    const row = await p.pdb.k
      .selectFrom("pull_requests as pr")
      .innerJoin("repos as r", "r.id", "pr.repo_id")
      .innerJoin("tickets as t", "t.id", "pr.ticket_id")
      .select("t.number as ticket_number")
      .where("pr.project_id", "=", p.projectId)
      .where("r.full_name", "=", repo)
      .where("pr.number", "=", a.pr)
      .executeTakeFirst();
    const ticket = row ? ((await p.pdb.from("tickets").where("number", "=", row.ticket_number).executeTakeFirst()) as TicketRow | undefined) : undefined;
    return { repo, pr: a.pr, ...(ticket ? { ticket } : {}) };
  };

  const input = {
    ticket: z.number().int().optional().describe("チケット番号(そのチケットの PR を読む)"),
    pr: z.number().int().optional().describe("PR 番号(チケット番号とは別。リポジトリが複数あれば repo も)"),
    repo: z.string().optional().describe("PR のリポジトリ(owner/name)。省くと最初のリポジトリ"),
  };

  return [
    defineTool({
      name: "pr_merge_status",
      description:
        "PR が merge できるか、できないならその理由(衝突・CI の失敗・レビュー・保護ルール)と、CI の各チェックの結果を、GitHub から読んで答える(読むだけ。あなたの作業場所からは GitHub は見えないので、Kuramoto が代わりに読む)。チケット番号か PR 番号を渡す。Kuramoto が merge を止めた記録も付く。",
      input,
      handler: async (a) => {
        const r = await resolve(a);
        if (typeof r === "string") return r;
        try {
          const d = await prDetail(r.repo, r.pr);
          const record = r.ticket ? `\n\n${await kuramotoRecord(p, r.ticket)}` : "";
          return safe(`PR #${r.pr}(${r.repo})${r.ticket ? ` = チケット #${r.ticket.number}` : ""}\n${detailText(d, mergeBlockers(d))}${record}`);
        } catch (e) {
          return safe(`PR #${r.pr} を GitHub から取れませんでした: ${errText(e)}`);
        }
      },
    }),
    defineTool({
      name: "pr_comments",
      description: "PR のレビュー(承認・変更の依頼)とコメント(コードの行へのものも)を読む。読むだけ。チケット番号か PR 番号を渡す。",
      input,
      handler: async (a) => {
        const r = await resolve(a);
        if (typeof r === "string") return r;
        try {
          const d = await prDetail(r.repo, r.pr);
          const reviews = d.reviews.map((x) => `- ${x.at} ${x.author}: ${x.state}${x.body ? ` — ${x.body}` : ""}`).join("\n") || "(レビューはありません)";
          const comments = d.comments.map((x) => `- ${x.at} ${x.author}${x.path ? `(${x.path})` : ""}: ${x.body}`).join("\n") || "(コメントはありません)";
          return safe(`PR #${r.pr}(${r.repo})\n## レビュー\n${reviews}\n\n## コメント\n${comments}`);
        } catch (e) {
          return safe(`PR #${r.pr} を GitHub から取れませんでした: ${errText(e)}`);
        }
      },
    }),
  ];
}
