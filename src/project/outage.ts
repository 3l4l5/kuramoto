import { iso } from "../clock.js";
import { all } from "../db/sqlite.js";
import { leadReply } from "./leadchat.js";
import type { Project, TicketRow } from "./project.js";
import { dropTicket, resumeHold, type DecisionOption, type DecisionRow } from "./workflow.js";

/**
 * GitHub に入れない(gh の認証切れ・git の認証エラー)ときの扱い(ADR-0027)。
 * チケットの問題ではなく Kuramoto が動いている環境の問題なので、チケットごとに失敗・保留にしない。
 * - 1 回だけ責任者に知らせ、GitHub を使う仕事(チケットの仕事)を止める。企画・チャットは動かす
 * - 間を空けて GitHub に入れるかを確かめ、入れたら知らせて自動で再開する
 * - 前に認証切れで保留になったチケットも、入れるようになったら自動で再開する
 */

const AUTH_ERROR = /HTTP 401|Requires authentication|Bad credentials|gh auth login|authentication failed|could not read Username|Permission denied \(publickey\)|token .*(expired|invalid)|認証(が|情報が)?切れ/i;

export function isGithubAuthError(error: string): boolean {
  return AUTH_ERROR.test(error);
}

export type Outage = { since: string; error: string; checkedAt: string };

/** GitHub に入れない状態か。入れないなら、いつから・どんなエラーか。 */
export function githubDown(p: Project): Outage | null {
  const v = p.setting("github_down");
  return v ? (JSON.parse(v) as Outage) : null;
}

/** GitHub に入れないことが分かった。初めてなら責任者に 1 回だけ知らせる。 */
export function markGithubDown(p: Project, error: string): void {
  const now = iso(p.clock.now());
  const cur = githubDown(p);
  if (cur) return;
  p.setSetting("github_down", JSON.stringify({ since: now, error: error.slice(0, 500), checkedAt: now } satisfies Outage));
  p.event("system", "github_down", null, { error: error.slice(0, 500) });
  leadReply(
    p,
    `【GitHub に入れません】Kuramoto が GitHub に入れなくなりました(gh か git の認証が切れているか、無効になっています)。チケットの問題ではないので、チームは GitHub を使う仕事を止めて待ちます。\nこの PC のターミナルで \`gh auth login\` をし直してください(\`gh auth status\` で確かめられます)。入れるようになったら、Kuramoto が気づいて自動で再開します。\nエラー: ${error.slice(0, 300)}`,
  );
}

/** 確かめた時刻を残す(次に確かめるまでの間を空ける)。 */
export function githubCheckDue(p: Project): boolean {
  const cur = githubDown(p);
  if (!cur) return false;
  const every = p.settingNumber("github_probe_sec", 60) * 1000;
  return p.clock.now().getTime() - new Date(cur.checkedAt).getTime() >= every;
}

export function githubStillDown(p: Project, error: string): void {
  const cur = githubDown(p);
  if (!cur) return;
  p.setSetting("github_down", JSON.stringify({ ...cur, error: error.slice(0, 500), checkedAt: iso(p.clock.now()) }));
}

/** また GitHub に入れるようになった。知らせて、認証切れで保留にしていたチケットを再開する。 */
export function markGithubUp(p: Project): number {
  const cur = githubDown(p);
  p.setSetting("github_down", "");
  const resumed = resumeAuthHolds(p);
  if (cur) {
    p.event("system", "github_up", null, { since: cur.since, resumed });
    leadReply(p, `【GitHub に戻れました】また GitHub に入れるようになったので、止めていた仕事を再開します。${resumed ? `認証切れで保留になっていたチケット ${resumed} 枚も再開しました。` : ""}`);
  }
  return resumed;
}

/** 認証切れが理由の保留(責任者の対応待ち)を、続きから再開する。 */
export function resumeAuthHolds(p: Project): number {
  const holds = all<DecisionRow>(p.db, "SELECT * FROM decisions WHERE escalated = 1 AND decided_at IS NULL ORDER BY id");
  let n = 0;
  for (const d of holds) {
    const options = JSON.parse(d.options) as DecisionOption[];
    if (!options.some((o) => o.action === "resume")) continue;
    if (!isGithubAuthError(`${d.question}\n${d.impact}\n${d.lead_note ?? ""}`)) continue;
    resumeHold(p, d.id, "lead");
    n++;
  }
  return n;
}

// ---- CI が動かない(ジョブが始まらない)とき ----

export type CiBlock = { repo: string; since: string; notes: string[]; probedAt: string; runIds: number[] };

const BILLING = /spending limit|payments? (have|has) failed|billing|payment method|account is locked|locked due to a billing issue/i;

/**
 * CI のジョブが始まってもいない(ステップが 1 つも動かない)。請求・使用額の上限・アカウントのロック・ランナーなど、
 * コードの外の原因なので、チケットで直せない。リポジトリごとに 1 回だけ責任者に知らせ、PR は merge 待ちのまま待つ。
 * 開発・確認の仕事は止めない(merge だけが待つ)。
 */
export function ciBlocked(p: Project, repo?: string): CiBlock[] {
  const all = JSON.parse(p.setting("ci_blocked") || "[]") as CiBlock[];
  return repo ? all.filter((b) => b.repo === repo) : all;
}

function saveBlocks(p: Project, blocks: CiBlock[]): void {
  p.setSetting("ci_blocked", JSON.stringify(blocks));
}

/** 責任者にしてほしいこと。注記から請求・上限が原因と分かれば、どこを見ればよいかまで書く。 */
export function ciBlockAction(notes: string[]): string {
  if (notes.some((n) => BILLING.test(n)))
    return "GitHub の Settings > Billing and plans で、支払い方法と Actions の使用額の上限(Spending limit)を確かめてください。直したら、Kuramoto が気づいて CI をやり直し、merge を再開します。";
  return "GitHub の Actions で、ジョブが始まらない理由(ランナー・権限・ワークフローの設定・請求)を確かめてください。直したら、Kuramoto が気づいて CI をやり直し、merge を再開します。";
}

export function markCiBlocked(p: Project, repo: string, notes: string[], runIds: number[]): boolean {
  const blocks = ciBlocked(p);
  const cur = blocks.find((b) => b.repo === repo);
  if (cur) {
    cur.runIds = [...new Set([...cur.runIds, ...runIds])].slice(-5);
    saveBlocks(p, blocks);
    return false;
  }
  const now = iso(p.clock.now());
  saveBlocks(p, [...blocks, { repo, since: now, notes: notes.slice(0, 5), probedAt: now, runIds }]);
  p.event("system", "ci_blocked", null, { repo, notes: notes.slice(0, 5) });
  leadReply(
    p,
    `【${repo} の CI が動いていません】CI のジョブが始まってもいません(ステップが 1 つも動かず、ログもありません)。コードではなく GitHub 側の原因なので、チームでは直せません。開発と確認は続け、merge だけ止めて待ちます。\n${notes.length ? `GitHub の注記: ${notes.slice(0, 3).join(" / ")}\n` : ""}${ciBlockAction(notes)}`,
  );
  return true;
}

/** 止まっている CI を、確かめにやり直す頃か(設定 ci_probe_min、既定 15 分ごと)。やり直す実行を返し、時刻を進める。 */
export function ciProbeDue(p: Project, repo: string): number[] {
  const blocks = ciBlocked(p);
  const cur = blocks.find((b) => b.repo === repo);
  if (!cur) return [];
  if (p.clock.now().getTime() - new Date(cur.probedAt).getTime() < p.settingNumber("ci_probe_min", 15) * 60_000) return [];
  cur.probedAt = iso(p.clock.now());
  saveBlocks(p, blocks);
  return cur.runIds.slice(-2);
}

/** CI がまた動き出した(ジョブが始まった・通った)。知らせる。 */
export function markCiRunning(p: Project, repo: string): void {
  const blocks = ciBlocked(p);
  const cur = blocks.find((b) => b.repo === repo);
  if (!cur) return;
  saveBlocks(p, blocks.filter((b) => b.repo !== repo));
  p.event("system", "ci_running", null, { repo, since: cur.since });
  leadReply(p, `【${repo} の CI が動き出しました】CI のジョブがまた始まるようになったので、merge を再開します。`);
}

/**
 * チームの CI を使うときは、GitHub Actions の CI のために作ったチケット(main の CI を直す)はいらない(ADR-0028)。
 * 理由を付けて取りやめ、GitHub の CI が動かないという知らせも消す。起動中のものは次に回す。
 * @returns 取りやめたチケット
 */
export function dropGithubCiTickets(p: Project): TicketRow[] {
  const open = all<TicketRow>(
    p.db,
    `SELECT * FROM tickets WHERE stage NOT IN ('done','dropped') AND json_extract(plan_refs, '$.baseCi') IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM runs r WHERE r.ticket_id = tickets.id AND r.ended_at IS NULL)`,
  );
  for (const t of open)
    dropTicket(p, t.id, { by: "lead", reason: "チームの CI を使うようになったので、GitHub Actions の CI を直す必要がなくなりました(Actions は止めてあり、merge はチームの CI で決めます)" });
  if (p.setting("ci_blocked") && p.setting("ci_blocked") !== "[]") p.setSetting("ci_blocked", "[]");
  if (open.length) leadReply(p, `【チームの CI】GitHub Actions の CI を直すためのチケット #${open.map((t) => t.number).join("・#")} は、チームの CI を使うようになっていらなくなったので取りやめました。`);
  return open;
}
