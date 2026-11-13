import { describe, expect, it } from "vitest";
import { ManualClock } from "../clock.js";
import { run } from "../db/sqlite.js";
import type { GitHub, PrDetail, PrStatus } from "../github/github.js";
import { FakeHarness } from "../harness/fake.js";
import { Dispatcher } from "./dispatcher.js";
import { githubReadTools, mergeBlockers } from "./github-read.js";
import { leadChatTools, sayToLead } from "./leadchat.js";
import { Project } from "./project.js";
import { StaticWorkspace } from "./workspace.js";
import { createTicket } from "./workflow.js";

/** リーダーが GitHub の PR・CI・merge の状態を読む道具(#56)。 */

const detail = (over: Partial<PrDetail> = {}): PrDetail => ({
  title: "[feat] CSV 書き出し",
  url: "https://github.com/acme/shop/pull/44",
  state: "OPEN",
  draft: false,
  mergeable: "MERGEABLE",
  mergeStateStatus: "CLEAN",
  reviewDecision: null,
  base: "main",
  head: "kuramoto/44",
  headSha: "abcdef123456",
  checks: [{ name: "test (sqlite)", status: "COMPLETED", conclusion: "SUCCESS", link: "https://github.com/acme/shop/actions/runs/1" }],
  ahead: 2,
  behind: 0,
  reviews: [],
  comments: [],
  ...over,
});

/** 書き込みの口は、呼ばれたら記録する。読み取り(prDetail)だけが答える。 */
class RecordingGitHub implements GitHub {
  writes: string[] = [];
  reads: string[] = [];
  next: PrDetail = detail();
  async prDetail(repo: string, n: number): Promise<PrDetail> {
    this.reads.push(`${repo}#${n}`);
    return this.next;
  }
  async prStatus(): Promise<PrStatus> {
    return { state: "OPEN", mergeable: "MERGEABLE", ci: "success" };
  }
  async merge(): Promise<void> {
    this.writes.push("merge");
  }
  async comment(): Promise<string> {
    this.writes.push("comment");
    return "";
  }
  async rerunFailed(): Promise<void> {
    this.writes.push("rerunFailed");
  }
  async setActionsEnabled(): Promise<void> {
    this.writes.push("setActionsEnabled");
  }
}

async function setup() {
  const p = await Project.open(":memory:", new ManualClock());
  await p.addRepo("acme/shop", "API");
  const t = await createTicket(p, { title: "CSV 書き出し" });
  run(p.db, "INSERT INTO pull_requests (ticket_id, repo_id, number, head) VALUES (?, ?, 44, 'kuramoto/44')", [t.id, (await p.repos())[0]!.id]);
  const gh = new RecordingGitHub();
  const tools = githubReadTools(p, gh);
  const call = (name: string, args: Record<string, unknown>) => tools.find((x) => x.name === name)!.handler(args as never);
  return { p, t, gh, tools, call };
}

describe("PR の merge の可否(#56)", () => {
  it("チケット番号からも PR 番号からも、merge できるかと CI の各チェックを読める", async () => {
    const { t, gh, call } = await setup();
    gh.next = detail({ checks: [{ name: "test (sqlite)", status: "COMPLETED", conclusion: "SUCCESS", link: null }, { name: "test (mysql)", status: "COMPLETED", conclusion: "FAILURE", link: "https://github.com/acme/shop/actions/runs/9" }] });
    for (const args of [{ ticket: t.number }, { pr: 44 }]) {
      const out = await call("pr_merge_status", args);
      expect(out).toContain("PR #44(acme/shop) = チケット");
      expect(out).toContain("merge できません");
      expect(out).toContain("CI が落ちています: test (mysql)");
      expect(out).toContain("「test (sqlite)」: SUCCESS");
      expect(out).toContain("「test (mysql)」: FAILURE(https://github.com/acme/shop/actions/runs/9)");
    }
    gh.next = detail();
    expect(await call("pr_merge_status", { ticket: t.number })).toContain("merge できます");
  });

  it("衝突・遅れ・計算中・レビュー・保護ルール・閉じたあとを、それぞれ理由として言う", () => {
    expect(mergeBlockers(detail({ mergeable: "CONFLICTING", mergeStateStatus: "DIRTY", behind: 3 })).join()).toContain("main と衝突しています(main が 3 コミット先に進んでいる)");
    expect(mergeBlockers(detail({ mergeStateStatus: "BEHIND", behind: 5 })).join()).toContain("5 コミット遅れ");
    expect(mergeBlockers(detail({ mergeable: "UNKNOWN", mergeStateStatus: "UNKNOWN" })).join()).toContain("計算中");
    expect(mergeBlockers(detail({ reviewDecision: "CHANGES_REQUESTED" })).join()).toContain("変更が求められて");
    expect(mergeBlockers(detail({ mergeStateStatus: "BLOCKED" })).join()).toContain("保護ルール");
    expect(mergeBlockers(detail({ checks: [{ name: "lint", status: "IN_PROGRESS", conclusion: null, link: null }] })).join()).toContain("まだ終わっていません: lint");
    expect(mergeBlockers(detail({ state: "MERGED" })).join()).toContain("merge 済み");
    expect(mergeBlockers(detail())).toEqual([]);
  });

  it("Kuramoto が merge を止めた理由(GitHub に残らないもの)も付く", async () => {
    const { p, t, call } = await setup();
    await p.event("system", "merge_blocked", t.id, { reason: "確認が済んでいません: QA" });
    const out = await call("pr_merge_status", { ticket: t.number });
    expect(out).toContain("Kuramoto の記録");
    expect(out).toContain("merge_blocked: 確認が済んでいません: QA");
  });

  it("PR のレビューとコメントを読める。トークンが混ざっていたら伏せる", async () => {
    const { t, gh, call } = await setup();
    gh.next = detail({
      reviews: [{ author: "ryusei", state: "CHANGES_REQUESTED", body: "直して", at: "2026-11-01" }],
      comments: [{ author: "bot", body: "token ghp_abcdefghijklmnopqrstuvwxyz0123456789 を使った", at: "2026-11-02", path: "src/a.ts" }],
    });
    const out = await call("pr_comments", { ticket: t.number });
    expect(out).toContain("ryusei: CHANGES_REQUESTED — 直して");
    expect(out).toContain("src/a.ts");
    expect(out).not.toContain("ghp_");
  });

  it("ないチケット・PR のないチケット・登録されていないリポジトリは、GitHub に聞かずに断る", async () => {
    const { p, gh, call } = await setup();
    const bare = await createTicket(p, { title: "PR なし" });
    expect(await call("pr_merge_status", { ticket: 999 })).toContain("チケットはありません");
    expect(await call("pr_merge_status", { ticket: bare.number })).toContain("まだ PR がありません");
    expect(await call("pr_merge_status", { pr: 1, repo: "evil/other" })).toContain("登録されていません");
    expect(await call("pr_merge_status", {})).toContain("どちらかを指定");
    expect(gh.reads).toEqual([]);
  });
});

describe("リーダーは GitHub に書けない(#56)", () => {
  it("道具は読み取りだけ。どの道具を呼んでも merge・コメント・やり直し・設定の変更は GitHub に届かない", async () => {
    const { gh, tools, t, call } = await setup();
    expect(tools.map((x) => x.name).sort()).toEqual(["pr_comments", "pr_merge_status"]);
    await call("pr_merge_status", { ticket: t.number });
    await call("pr_comments", { pr: 44 });
    expect(gh.reads).toHaveLength(2);
    expect(gh.writes).toEqual([]);
    // 読み取りの口がない環境では、道具を渡さない
    const { p } = await setup();
    expect(githubReadTools(p, undefined)).toEqual([]);
    expect(githubReadTools(p, {})).toEqual([]);
  });

  it("リーダーの起動(チャット・見回り)に渡る道具に、merge・push・コメントの道具は無い。読む道具は渡る", async () => {
    const { p, gh, t } = await setup();
    const harness = new FakeHarness(async (req, call) => {
      const names = req.tools.map((x) => x.name);
      expect(names).toEqual(expect.arrayContaining(["pr_merge_status", "pr_comments"]));
      expect(names.filter((n) => /merge$|^merge|push|comment_pr|pr_comment$|label|rerun|close_pr/.test(n) && n !== "pr_merge_status")).toEqual([]);
      const out = await call("pr_merge_status", { ticket: t.number });
      return { finalText: out.includes("merge できます") ? "merge できます" : out };
    });
    const d = new Dispatcher(p, { harnesses: { "claude-agent-sdk": harness }, workspace: new StaticWorkspace("/tmp"), github: gh });
    await sayToLead(p, "#1 はなぜ merge できないの?");
    await d.drain();
    expect(gh.reads.length).toBeGreaterThan(0);
    expect(gh.writes).toEqual([]);
    // 会話にも認証情報は出ない
    const sent = JSON.stringify(harness.calls.map((c) => ({ p: c.prompt, s: c.systemPrompt })));
    expect(sent).not.toMatch(/ghp_|github_pat_|\.config\/gh/);
    // リーダーの閉じ込め(~/.config/gh・GH_TOKEN を隠す。git の本体には書けない)は、このチケットで変えていない
    const confine = harness.calls[0]!.confine!;
    expect(confine.hidden.some((h) => h.endsWith("/.config/gh"))).toBe(true);
    expect(confine.hiddenEnv).toEqual(expect.arrayContaining(["GH_TOKEN", "GITHUB_TOKEN"]));
    expect(confine.writable.some((w) => w.endsWith(".git"))).toBe(false);
    // チャットの道具の登録は、GitHub が無くても今までどおり
    expect(leadChatTools(p).map((x) => x.name)).not.toContain("pr_merge_status");
  });
});
