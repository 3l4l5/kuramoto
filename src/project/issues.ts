import { z } from "zod";
import type { GitHub } from "../github/github.js";
import { defineTool, type KuramotoTool } from "../harness/types.js";
import { githubDown } from "./outage.js";
import type { Project, TicketRow } from "./project.js";

/**
 * GitHub の新しい Issue を見回りで拾い、リーダーが応答する(#79)。
 * - 見回りの間隔(patrol_min)ごとに、プロジェクトのリポジトリの開いている Issue を Kuramoto が取ってくる(エージェントの作業場所からは GitHub が見えないため)。
 *   拾うのはラベル(設定 issue_label。既定 kuramoto、"*" ですべて)の付いたものだけ。
 * - 取ってきた Issue は github_issues に status = new で覚える。一度覚えた Issue は、サーバーを立ち上げ直しても二度は拾わない。
 * - リーダーの見回りが、new の Issue を読んで、チケットにする(create_ticket の issue)・既存のチケットに足す(issue_duplicate)・責任者に回す(issue_to_owner)を選ぶ。
 *   選んだ時点で status が変わり、リーダーのやりとり(責任者とのチャット)に 1 行残る。何も選ばなかった Issue は passed にして、二度は見せない。
 * - 取ってくるのに失敗しても(ネットワーク・権限)見回りは止めない。出来事に残して、次の周期でやり直す。
 * - Issue へのコメントは外に出る操作なので、設定 issue_comment = "1" のときだけ書く(既定は書かない)。
 */

export type IssueStatus = "new" | "ticketed" | "duplicate" | "owner" | "passed";
export type IssueRow = { id: number; repo: string; number: number; title: string; body: string; url: string; status: IssueStatus; ticket_id: number | null; note: string | null; fetched_at: string; handled_at: string | null };

/** 1 回の見回りでリーダーに見せる Issue の数の上限。残りは次の見回りで見せる。 */
export const ISSUES_PER_PATROL = 10;

/** 見回りの間隔(分)。0 なら見回らない(Issue も取らない)。patrol.ts の patrolMinutes と同じ(patrol.ts がこのファイルを読むので、ここに置く)。 */
async function patrolMinutes(p: Project): Promise<number> {
  return Math.max(0, await p.settingNumber("patrol_min", 5));
}

/** Issue を拾うラベル。"*" ならすべて。 */
export async function watchLabel(p: Project): Promise<string> {
  return (await p.setting("issue_label")) ?? "kuramoto";
}

/** Issue にコメントを書くか(外に出る操作。既定は書かない)。 */
export async function issueCommentEnabled(p: Project): Promise<boolean> {
  return (await p.setting("issue_comment")) === "1";
}

/**
 * 開いている Issue を GitHub から取り、まだ覚えていないものを new として控える。見回りの間隔ごとに 1 回だけ。
 * リポジトリごとに失敗を分け、取れなかったものは出来事(issue_poll_failed)に残して続ける(次の周期でやり直す)。
 * @returns 新しく控えた Issue の数
 */
export async function pollIssues(p: Project, gh: GitHub): Promise<number> {
  const min = await patrolMinutes(p);
  if (min <= 0 || !gh.openIssues || (await githubDown(p))) return 0;
  const last = await p.setting("issue_polled_at");
  if (last && p.clock.now().getTime() - Date.parse(last) < min * 60_000) return 0;
  await p.setSetting("issue_polled_at", p.now());
  const label = await watchLabel(p);
  // 作るときの引き継ぎ(onboard)で、もうチケットにした Issue は拾わない
  const onboarded = new Set(JSON.parse((await p.setting("onboard_ticketed_issues")) || "[]") as string[]);
  let added = 0;
  for (const r of await p.repos()) {
    try {
      const open = await gh.openIssues(r.full_name, label === "*" ? null : label);
      const known = new Set((await p.pdb.from("github_issues").select("number").where("repo", "=", r.full_name).execute()).map((x) => x.number));
      for (const i of open) {
        if (known.has(i.number)) continue;
        const handled = onboarded.has(`${r.full_name}#${i.number}`);
        await p.pdb.insert("github_issues", { repo: r.full_name, number: i.number, title: i.title, body: i.body, url: i.url, status: handled ? "passed" : "new", note: handled ? "プロジェクトを作るときに引き継ぎ済み" : null, fetched_at: p.now(), handled_at: handled ? p.now() : null }).execute();
        if (!handled) added++;
      }
    } catch (e) {
      await p.event("system", "issue_poll_failed", null, { repo: r.full_name, reason: (e instanceof Error ? e.message : String(e)).slice(0, 300) });
    }
  }
  if (added) await p.event("system", "issues_fetched", null, { added });
  return added;
}

/** まだリーダーが見ていない Issue(古い順)。 */
export async function newIssues(p: Project, limit = ISSUES_PER_PATROL): Promise<IssueRow[]> {
  return (await p.pdb.from("github_issues").selectAll().where("status", "=", "new").orderBy("id").limit(limit).execute()) as IssueRow[];
}

export async function hasNewIssues(p: Project): Promise<boolean> {
  return (await newIssues(p, 1)).length > 0;
}

/** 番号から Issue を探す(複数のリポジトリに同じ番号があれば、まだ扱っていないものを先に)。 */
export async function findIssue(p: Project, number: number): Promise<IssueRow | undefined> {
  const rows = (await p.pdb.from("github_issues").selectAll().where("number", "=", number).orderBy("id").execute()) as IssueRow[];
  return rows.find((r) => r.status === "new") ?? rows[0];
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** リーダーの見回りの指示に入れる、新しい Issue の一覧。 */
export function issuesText(issues: IssueRow[]): string {
  return issues
    .map((i) => {
      const body = i.body.trim().replace(/\s+/g, " ");
      return `- Issue #${i.number}(${i.repo}): ${i.title}\n  ${i.url}${body ? `\n  ${clip(body, 400)}` : ""}`;
    })
    .join("\n");
}

/** 責任者とのやりとり(ボードの「やりとり」)に、リーダーとして 1 行残す。 */
async function say(p: Project, body: string): Promise<void> {
  await p.pdb.insert("lead_messages", { who: "lead", body, at: p.now() }).execute();
}

/** Issue にコメントを書く(設定 issue_comment のときだけ)。失敗しても作業は止めず、出来事に残す。 */
async function commentOn(p: Project, gh: GitHub | undefined, issue: IssueRow, body: string): Promise<void> {
  if (!gh?.commentIssue || !(await issueCommentEnabled(p))) return;
  try {
    await gh.commentIssue(issue.repo, issue.number, body);
  } catch (e) {
    await p.event("system", "issue_comment_failed", issue.ticket_id, { repo: issue.repo, issue: issue.number, reason: (e instanceof Error ? e.message : String(e)).slice(0, 300) });
  }
}

async function mark(p: Project, issue: IssueRow, status: IssueStatus, ticketId: number | null, note: string | null): Promise<void> {
  await p.pdb.update("github_issues", { status, ticket_id: ticketId, note, handled_at: p.now() }).where("id", "=", issue.id).execute();
}

/** Issue からチケットを作ったとき(create_ticket の issue)。Issue を ticketed にし、やりとりに残す。 */
export async function markTicketed(p: Project, gh: GitHub | undefined, issue: IssueRow, t: TicketRow): Promise<void> {
  await mark(p, issue, "ticketed", t.id, null);
  await p.event((await p.fixedMember("lead")).name, "issue_ticketed", t.id, { repo: issue.repo, issue: issue.number, url: issue.url });
  await say(p, `【GitHub Issue #${issue.number}】「${issue.title}」を チケット #${t.number} にしました。\n${issue.url}`);
  await commentOn(p, gh, { ...issue, ticket_id: t.id }, `チケット #${t.number} にしました`);
}

/** チケットに付ける、Issue へのひも付け(plan_refs。チケットの詳細から Issue に飛べる。PR には Closes が付く)。 */
export async function issueRefs(p: Project, number: number): Promise<{ refs: Record<string, unknown>; issue?: IssueRow }> {
  const issue = await findIssue(p, number);
  return { issue, refs: { issue: number, ...(issue ? { issueUrl: issue.url, issueRepo: issue.repo } : {}) } };
}

/** 重複: 既存のチケットに Issue の中身を足す。 */
export async function issueAsDuplicate(p: Project, gh: GitHub | undefined, number: number, ticketNumber: number, note: string): Promise<string> {
  const issue = await findIssue(p, number);
  if (!issue) return `Issue #${number} は、取ってきたものの中にありません`;
  if (issue.status !== "new") return `Issue #${number} は、もう扱いました(${STATUS_TEXT[issue.status]})`;
  const t = (await p.tickets()).find((x) => x.number === ticketNumber);
  if (!t) return `#${ticketNumber} はありません`;
  await p.pdb.transaction(async () => {
    await p.addNote(t.id, `【GitHub Issue #${issue.number} は、このチケットと重複】${issue.title}\n${issue.url}${note.trim() ? `\n${note.trim()}` : ""}`, "lead");
    await mark(p, issue, "duplicate", t.id, note.trim() || null);
    await p.event((await p.fixedMember("lead")).name, "issue_duplicate", t.id, { repo: issue.repo, issue: issue.number, url: issue.url });
    await say(p, `【GitHub Issue #${issue.number}】「${issue.title}」は 既存の #${t.number} と重複なので、そちらに書き足しました。\n${issue.url}`);
  });
  await commentOn(p, gh, { ...issue, ticket_id: t.id }, `チケット #${t.number} と同じ内容として扱います`);
  return `Issue #${number} を #${t.number} のメモに足しました。`;
}

/** やらない・責任者に聞く: 責任者に回す。理由と、リーダーの見立てを、やりとりに残す(判断はチケットに付くので、チケットの無い Issue はやりとりで聞く)。 */
export async function issueToOwner(p: Project, number: number, reason: string, lean: "decline" | "ask"): Promise<string> {
  const issue = await findIssue(p, number);
  if (!issue) return `Issue #${number} は、取ってきたものの中にありません`;
  if (issue.status !== "new") return `Issue #${number} は、もう扱いました(${STATUS_TEXT[issue.status]})`;
  await p.pdb.transaction(async () => {
    await mark(p, issue, "owner", null, reason.trim());
    await p.event((await p.fixedMember("lead")).name, "issue_to_owner", null, { repo: issue.repo, issue: issue.number, url: issue.url, lean });
    await say(p, `【GitHub Issue #${issue.number}】「${issue.title}」は ${lean === "decline" ? "やらない方がよいと見ています" : "判断をください"}。\n${reason.trim()}\n${issue.url}\nやるなら、そう返事をください(チケットにします)。`);
  });
  return `Issue #${number} を責任者に回しました。`;
}

const STATUS_TEXT: Record<IssueStatus, string> = { new: "まだ", ticketed: "チケットにした", duplicate: "既存のチケットに足した", owner: "責任者に回した", passed: "見送った" };

/**
 * 見回りを終えた。見せたのに何も選ばれなかった Issue は passed にして、二度は見せない(リーダーが一度だけ応答する)。
 * @returns 見送った Issue
 */
export async function finishIssues(p: Project, shown: IssueRow[]): Promise<IssueRow[]> {
  const passed: IssueRow[] = [];
  for (const i of shown) {
    const now = (await p.pdb.from("github_issues").selectAll().where("id", "=", i.id).executeTakeFirst()) as IssueRow | undefined;
    if (!now || now.status !== "new") continue;
    await mark(p, now, "passed", null, "リーダーは何も決めませんでした");
    passed.push(now);
  }
  if (passed.length) await p.event("system", "issues_passed", null, { issues: passed.map((i) => i.number) });
  return passed;
}

/** リーダーの見回りの道具(Issue を扱う)。チケットにするときは create_ticket の issue に番号を書く。 */
export function issueTools(p: Project, ws: { github?: GitHub } = {}): KuramotoTool[] {
  return [
    defineTool({
      name: "issue_duplicate",
      description: "新しい GitHub Issue が、既にあるチケットと同じことを扱っているとき、その Issue の中身を既存のチケットのメモに足して、Issue を扱い済みにする(チケットは増やさない)。",
      input: {
        issue: z.number().int().describe("Issue の番号"),
        ticket: z.number().int().describe("足す先の既存のチケットの番号"),
        note: z.string().optional().describe("Issue から足すべき、チケットにまだ無い要点(任意)"),
      },
      handler: (a) => issueAsDuplicate(p, ws.github, a.issue, a.ticket, a.note ?? ""),
    }),
    defineTool({
      name: "issue_to_owner",
      description: "新しい GitHub Issue を、やらない・責任者に聞きたいときに、責任者に回す(責任者とのやりとりに理由が残る)。チケットは作らない。責任者がやると言えば、あとでチケットにできる。",
      input: {
        issue: z.number().int().describe("Issue の番号"),
        lean: z.enum(["decline", "ask"]).describe("decline: やらない方がよいと見ている / ask: 判断が要る"),
        reason: z.string().min(1).describe("なぜやらない・何を決めてほしいか(責任者が読む。短く)"),
      },
      handler: (a) => issueToOwner(p, a.issue, a.reason, a.lean),
    }),
  ];
}
