import { iso } from "../clock.js";
import { inScope } from "../db/count.js";
import { pipelineOf } from "../domain/formation.js";
import type { GitHub } from "../github/github.js";
import type { Project, TicketRow } from "./project.js";
import { enterStage } from "./workflow.js";

/**
 * 既存のリポジトリの続きから始める(ADR-0030)。
 * - 作るときに、Kuramoto が GitHub から開いている PR と Issue(既定はラベル kuramoto の付いたもの)を取ってきて控える
 *   (エージェントの作業場所からは GitHub が見えないため)
 * - 企画の各段階は、聞き取りから作るのではなく、リポジトリを読んで現状を下書きに起こす。責任者は確かめて合意する
 * - チームに渡すとき、開いている PR はチケットにして確認の工程から続け、Issue と残っている要件はチケットにする
 */

export type GithubPull = { number: number; title: string; body: string; head: string; url: string; draft: boolean; author: string; repo: string };
export type GithubIssue = { number: number; title: string; body: string; url: string; labels: string[]; repo: string };
export type GithubSnapshot = { fetchedAt: string; label: string; pulls: GithubPull[]; issues: GithubIssue[]; errors: string[] };

/** 既存のリポジトリの続きから始めたプロジェクトか。 */
export async function fromExisting(p: Project): Promise<boolean> {
  return await p.setting("origin") === "existing";
}

/** Issue を拾うラベル。"*" ならすべて。 */
export async function issueLabel(p: Project): Promise<string> {
  return await p.setting("issue_label") ?? "kuramoto";
}

export async function snapshotOf(p: Project): Promise<GithubSnapshot | null> {
  const v = await p.setting("onboard_github");
  return v ? (JSON.parse(v) as GithubSnapshot) : null;
}

/** 既存のリポジトリの続きから始める準備。画面の試作は既にある画面と重なるので、既定では省く(あとで戻せる)。 */
export async function markExisting(p: Project, label: string): Promise<void> {
  await p.setSetting("origin", "existing");
  await p.setSetting("issue_label", label.trim() || "*");
  await p.pdb.k.updateTable("plan_stages").set({ mode: "skip" }).where("project_id", "=", p.pdb.projectId).where("stage", "=", "screen").execute();
}

/** 開いている PR と Issue を GitHub から取ってきて控える。取れなかったリポジトリは理由を残し、続ける。 */
export async function fetchGithubSnapshot(p: Project, gh: GitHub): Promise<GithubSnapshot> {
  const label = await issueLabel(p);
  const snap: GithubSnapshot = { fetchedAt: iso(p.clock.now()), label, pulls: [], issues: [], errors: [] };
  for (const r of await p.repos()) {
    try {
      if (gh.openPulls) snap.pulls.push(...(await gh.openPulls(r.full_name)).map((x) => ({ ...x, repo: r.full_name })));
      if (gh.openIssues) snap.issues.push(...(await gh.openIssues(r.full_name, label === "*" ? null : label)).map((x) => ({ ...x, repo: r.full_name })));
    } catch (e) {
      snap.errors.push(`${r.full_name}: ${(e instanceof Error ? e.message : String(e)).slice(0, 200)}`);
    }
  }
  await p.setSetting("onboard_github", JSON.stringify(snap));
  await p.event("system", "onboard_fetched", null, { pulls: snap.pulls.length, issues: snap.issues.length, errors: snap.errors.length });
  return snap;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** 担当に渡す、GitHub の途中の仕事の一覧。 */
export async function snapshotText(p: Project, opts: { bodies?: boolean } = {}): Promise<string> {
  const s = await snapshotOf(p);
  if (!s) return "(GitHub の途中の仕事は取ってきていません)";
  const body = (b: string) => (opts.bodies && b.trim() ? `\n  ${clip(b.trim().replace(/\s+/g, " "), 400)}` : "");
  const adopted = new Set(await adoptedPulls(p));
  const ticketed = new Set(await ticketedIssues(p));
  const pulls = s.pulls.map((x) => `- PR #${x.number}(${x.repo}、ブランチ ${x.head}${x.draft ? "、下書き" : ""}): ${x.title}${adopted.has(`${x.repo}#${x.number}`) ? " → 引き継ぎ済み" : ""}${body(x.body)}`);
  const issues = s.issues.map((x) => `- Issue #${x.number}(${x.repo}${x.labels.length ? `、${x.labels.join("・")}` : ""}): ${x.title}${ticketed.has(`${x.repo}#${x.number}`) ? " → チケット済み" : ""}${body(x.body)}`);
  return `### 開いている PR(${s.pulls.length} 件)\n${pulls.join("\n") || "(なし)"}\n\n### Issue(${s.label === "*" ? "すべて" : `ラベル「${s.label}」`}、${s.issues.length} 件)\n${issues.join("\n") || "(なし)"}${s.errors.length ? `\n\n(取れなかったもの: ${s.errors.join(" / ")})` : ""}`;
}

/** 既存のリポジトリの続きから始めたときの、各段階の最初の指示。 */
export async function existingKickoff(p: Project, stage: "req" | "flow" | "screen" | "infra" | "model"): Promise<string> {
  const common = "既存のリポジトリの続きから始めるプロジェクトです。責任者に一から聞くのではなく、まず作業場所のリポジトリ(README・docs・コード・設定)を読み、今の状態を下書きに起こしてください。分からないこと・コードから決めきれないことだけを未決にして、責任者に確かめてもらいます。";
  switch (stage) {
    case "req":
      return `${common}
- 目的・使う人・やらないことを、README・docs・コードから読み取って set_brief に書きます。
- 機能を要件の項目として upsert_requirement で書きます。すでに実装されている機能は、名前の先頭に「済: 」を付けます(チームはこれをチケットにしません)。途中のもの・まだ無いものは、そのまま書きます。受け入れ条件は、コードと動きから読み取れる形で書きます。
- 下の「GitHub の途中の仕事」(Kuramoto が取ってきたもの)も見て、開いている PR と Issue が扱う機能を要件に入れます。
- 最後の返事は、責任者への挨拶と「読み取った現状の要点・確かめてほしいこと」にします。

## GitHub の途中の仕事
${await snapshotText(p, { bodies: true })}`;
    case "flow":
      return `${common} 要件をもとに、今ある画面と遷移をコードから読み取ってユーザーフローを描きます。まだ無い画面(残っている要件のもの)は、新しく足す箱として描きます。`;
    case "screen":
      return `${common} まず今ある画面のコード(色・文字・余白・部品)からデザインシステムを set_design_system で起こし、ばらついているところは揃える案として未決にします。残っている要件のための新しい画面だけ、そのトークンと部品で触れる試作を作ってください。`;
    case "infra":
      return `${common} 今の環境・IaC・Dockerfile・CI・デプロイの仕組みを読み取り、set_infra に今の構成として書きます。変えるべきところがあれば、変える案として未決にします。`;
    case "model":
      return `${common} 今のアーキテクチャスタイル・モジュール・使っている技術・ドメイン・表を、コードとマイグレーションから読み取って書きます。残っている要件のために足す・変えるものは、作る / 既存を使う / 作らない とデータ設計に書きます。`;
  }
}

/** チームに渡すときの指示(既存のリポジトリの続きから)。 */
export function existingHandoffText(): string {
  return `

既存のリポジトリの続きからです。
- 名前が「済: 」で始まる要件は、もう実装されているのでチケットにしません。
- 開いている PR は、adopt_pr でチケットにして引き継ぎます(確認の工程から続け、merge まで持っていきます)。下書きや、もう要らない PR は引き継がず、返事で責任者に伝えます。
- Issue は create_ticket の issue に番号を書いてチケットにします(PR に「Closes #番号」が付きます)。同じことを扱う要件と Issue は 1 枚にまとめます。
- 残っている要件もチケットにします。`;
}

async function adoptedPulls(p: Project): Promise<string[]> {
  return JSON.parse(await p.setting("onboard_adopted_pulls") || "[]") as string[];
}

async function ticketedIssues(p: Project): Promise<string[]> {
  return JSON.parse(await p.setting("onboard_ticketed_issues") || "[]") as string[];
}

export async function markIssueTicketed(p: Project, repo: string, issue: number): Promise<void> {
  await p.setSetting("onboard_ticketed_issues", JSON.stringify([...new Set([...await ticketedIssues(p), `${repo}#${issue}`])]));
}

/**
 * 開いている PR を引き継ぐ。チケットを作って PR をひも付け、確認の最初の工程から続ける(確認の工程が無ければ merge 待ちへ)。
 * 指摘で差し戻されたら、開発の島の手すきの人が PR のブランチの続きから直す。
 */
export async function adoptPull(p: Project, a: { repo: string; number: number; title?: string; body?: string; requirementItemId?: number }): Promise<TicketRow | string> {
  const s = await snapshotOf(p);
  const pr = s?.pulls.find((x) => x.repo === a.repo && x.number === a.number);
  if (!pr) return `PR #${a.number}(${a.repo})は、取ってきた開いている PR の中にありません`;
  const repo = (await p.repos()).find((r) => r.full_name === a.repo);
  if (!repo) return `登録されていないリポジトリです: ${a.repo}`;
  if (await inScope(p.pdb, "pull_requests").where("repo_id", "=", repo.id).where("number", "=", a.number).executeTakeFirst()) return `PR #${a.number} はもう引き継いでいます`;
  return p.pdb.transaction(async () => {
    const t = await p.addTicket({
      title: a.title?.trim() || pr.title,
      body: `${a.body?.trim() || pr.body.trim() || "(本文なし)"}\n\n---\n既存の PR #${pr.number}(${pr.url})を引き継いだチケットです。PR のブランチ ${pr.head} の続きから進めます。`,
      ...(a.requirementItemId ? { requirementItemId: a.requirementItemId } : {}),
      planRefs: { fromPlan: true, repo: a.repo, adoptedPr: pr.number },
    });
    await p.pdb.insert("pull_requests", { ticket_id: t.id, repo_id: repo.id, number: pr.number, head: pr.head }).execute();
    // 引き継いだ PR は開発が済んでいる(開発より前の工程には戻らない)ので、交通整理も済み。addTicket の行はまだ project_id が 0 かもしれない
    await p.pdb.k.updateTable("tickets").set({ triaged: 1, dev_done: 1 }).where("project_id", "=", p.pdb.projectId).where("id", "=", t.id).execute();
    const first = pipelineOf(await p.currentFormation(), (await p.ticket(t.id)).kind, { devDone: true }).find((r) => r !== "dev");
    await enterStage(p, await p.ticket(t.id), first ?? "merge");
    await p.setSetting("onboard_adopted_pulls", JSON.stringify([...new Set([...await adoptedPulls(p), `${a.repo}#${a.number}`])]));
    await p.event((await p.fixedMember("lead")).name, "pr_adopted", t.id, { pr: pr.number, repo: a.repo });
    return await p.ticket(t.id);
  });
}
