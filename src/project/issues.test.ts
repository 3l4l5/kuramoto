import { describe, expect, it } from "vitest";
import { ManualClock } from "../clock.js";
import { FakeHarness } from "../harness/fake.js";
import type { GitHub } from "../github/github.js";
import { Dispatcher } from "./dispatcher.js";
import { leadChatTools, leadMessages } from "./leadchat.js";
import { finishIssues, issueCommentEnabled, issueTools, newIssues, pollIssues } from "./issues.js";
import { finishPatrol, patrolPrompt, requestPatrol } from "./patrol.js";
import { Project } from "./project.js";
import { ticketView } from "./ticket.js";
import { createTicket } from "./workflow.js";
import { StaticWorkspace } from "./workspace.js";

type FakeIssue = { number: number; title: string; body: string; url: string; labels: string[] };
const issue = (number: number, title = `課題 ${number}`): FakeIssue => ({ number, title, body: `${title} の本文`, url: `https://github.com/acme/shop/issues/${number}`, labels: ["kuramoto"] });

/** GitHub のフェイク。openIssues が返すものと、失敗させるかを外から変えられる。コメントは書き込みを数える。 */
function fakeGithub(state: { issues: FakeIssue[]; fail?: boolean; labels: (string | null)[]; comments: string[] }): GitHub {
  return {
    async openIssues(_repo, label) {
      state.labels.push(label);
      if (state.fail) throw new Error("gh: network is unreachable");
      return state.issues;
    },
    async commentIssue(_repo, n, body) {
      state.comments.push(`#${n} ${body}`);
    },
  } as unknown as GitHub;
}

async function setup() {
  const clock = new ManualClock();
  const p = await Project.open(":memory:", clock);
  await p.addRepo("acme/shop", "API");
  const state = { issues: [issue(5), issue(6)], fail: false, labels: [] as (string | null)[], comments: [] as string[] };
  return { p, clock, state, gh: fakeGithub(state) };
}

const tool = (tools: { name: string; handler: (a: never) => Promise<string> | string }[], name: string) => tools.find((t) => t.name === name)!;
const call = (t: { handler: (a: never) => Promise<string> | string }, args: Record<string, unknown>) => t.handler(args as never);

describe("GitHub の Issue を見回りで拾う(#79)", () => {
  it("新しい Issue を new として覚え、間隔が来るまでは取り直さない。同じ Issue は二度覚えない", async () => {
    const { p, clock, state, gh } = await setup();
    expect(await pollIssues(p, gh)).toBe(2);
    expect((await newIssues(p)).map((i) => i.number)).toEqual([5, 6]);
    // 既定のラベルは kuramoto
    expect(state.labels).toEqual(["kuramoto"]);
    // 間隔(既定 5 分)の中では取りに行かない
    state.issues.push(issue(7));
    expect(await pollIssues(p, gh)).toBe(0);
    expect(state.labels).toHaveLength(1);
    // 間隔が過ぎたら、新しい Issue だけ足す
    clock.advance(5 * 60_000);
    expect(await pollIssues(p, gh)).toBe(1);
    expect((await newIssues(p)).map((i) => i.number)).toEqual([5, 6, 7]);
  });

  it("ラベルで絞れる(設定 issue_label。\"*\" ならすべて)。見回りを止めている(0)と取らない", async () => {
    const { p, clock, state, gh } = await setup();
    await p.setSetting("issue_label", "*");
    await pollIssues(p, gh);
    expect(state.labels).toEqual([null]);
    await p.setSetting("issue_label", "bug");
    clock.advance(10 * 60_000);
    await pollIssues(p, gh);
    expect(state.labels).toEqual([null, "bug"]);
    await p.setSetting("patrol_min", "0");
    clock.advance(10 * 60_000);
    expect(await pollIssues(p, gh)).toBe(0);
    expect(state.labels).toHaveLength(2);
  });

  it("gh が失敗しても投げず、出来事に残して、次の周期でやり直す", async () => {
    const { p, clock, state, gh } = await setup();
    state.fail = true;
    expect(await pollIssues(p, gh)).toBe(0);
    expect((await p.events(100)).some((e) => e.type === "issue_poll_failed" && e.data.includes("network is unreachable"))).toBe(true);
    expect(await newIssues(p)).toEqual([]);
    state.fail = false;
    clock.advance(5 * 60_000);
    expect(await pollIssues(p, gh)).toBe(2);
  });

  it("プロジェクトを作るときに引き継いだ Issue は、新しい Issue として扱わない", async () => {
    const { p, gh } = await setup();
    await p.setSetting("onboard_ticketed_issues", JSON.stringify(["acme/shop#5"]));
    expect(await pollIssues(p, gh)).toBe(1);
    expect((await newIssues(p)).map((i) => i.number)).toEqual([6]);
  });

  it("新しい Issue があれば見回りを頼み、指示にその Issue が載る", async () => {
    const { p, clock, gh } = await setup();
    await p.setSetting("patrol_last_ticket", "0");
    await requestPatrol(p); // 間隔を数え始める
    clock.advance(5 * 60_000);
    expect(await requestPatrol(p)).toBe(false); // 見るものが無い
    await pollIssues(p, gh);
    const issues = await newIssues(p);
    expect(await requestPatrol(p)).toBe(true);
    const prompt = await patrolPrompt(p, [], { issues });
    expect(prompt).toContain("## 新しい GitHub Issue");
    expect(prompt).toContain("Issue #5(acme/shop): 課題 5");
    expect(prompt).toContain("https://github.com/acme/shop/issues/5");
    expect(prompt).toContain("issue_to_owner");
  });
});

describe("リーダーの応答(#79)", () => {
  it("やる: create_ticket の issue でチケットにし、番号と URL が載る。Issue は扱い済みになり、同じ Issue では二度チケットを切らない。やりとりに残る。既定ではコメントを書かない", async () => {
    const { p, state, gh } = await setup();
    await pollIssues(p, gh);
    const create = tool(leadChatTools(p, { github: gh }), "create_ticket");
    expect(await call(create, { title: "課題 5 を直す", body: "やること", kind: "bugfix", issue: 5 })).toMatch(/#1 を作りました/);
    const t = (await p.tickets())[0]!;
    expect(JSON.parse(t.plan_refs)).toMatchObject({ issue: 5, issueUrl: "https://github.com/acme/shop/issues/5", issueRepo: "acme/shop" });
    const view = await ticketView(p, t.id);
    expect(view.issue).toEqual({ number: 5, url: "https://github.com/acme/shop/issues/5" });
    const row = (await p.pdb.from("github_issues").where("number", "=", 5).executeTakeFirst())!;
    expect(row).toMatchObject({ status: "ticketed", ticket_id: t.id });
    expect((await newIssues(p)).map((i) => i.number)).toEqual([6]);
    expect((await leadMessages(p)).some((m) => m.who === "lead" && m.body.includes("Issue #5") && m.body.includes("チケット #1"))).toBe(true);
    expect(state.comments).toEqual([]);
    // 二度目は断る(チケットは増えない)
    expect(await call(create, { title: "もう一度", body: "x", kind: "bugfix", issue: 5 })).toContain("チケットは増やしません");
    expect(await p.tickets()).toHaveLength(1);
  });

  it("コメントの書き込みは、設定 issue_comment を入れたときだけ。短い文を書き、失敗しても作業は続く", async () => {
    const { p, state, gh } = await setup();
    expect(await issueCommentEnabled(p)).toBe(false);
    await p.setSetting("issue_comment", "1");
    expect(await issueCommentEnabled(p)).toBe(true);
    await pollIssues(p, gh);
    const create = tool(leadChatTools(p, { github: gh }), "create_ticket");
    await call(create, { title: "課題 5", body: "x", kind: "feature", issue: 5 });
    expect(state.comments).toEqual(["#5 チケット #1 にしました"]);
    gh.commentIssue = async () => {
      throw new Error("403");
    };
    await call(create, { title: "課題 6", body: "x", kind: "feature", issue: 6 });
    expect((await p.tickets()).map((t) => t.number)).toEqual([1, 2]);
    expect((await p.events(100)).some((e) => e.type === "issue_comment_failed")).toBe(true);
  });

  it("重複: 既存のチケットのメモに足し、チケットは増やさない", async () => {
    const { p, gh } = await setup();
    await pollIssues(p, gh);
    const t = await createTicket(p, { title: "課題 5 と同じこと", body: "" });
    const tools = issueTools(p, { github: gh });
    expect(await call(tool(tools, "issue_duplicate"), { issue: 5, ticket: t.number, note: "再現手順が追加" })).toContain("足しました");
    expect((await p.notes(t.id)).some((n) => n.body.includes("Issue #5") && n.body.includes("再現手順が追加"))).toBe(true);
    expect(await p.tickets()).toHaveLength(1);
    expect(await call(tool(tools, "issue_duplicate"), { issue: 5, ticket: t.number })).toContain("もう扱いました");
    expect((await leadMessages(p)).some((m) => m.body.includes("Issue #5") && m.body.includes("重複"))).toBe(true);
  });

  it("やらない・聞きたい: 責任者に回し、理由をやりとりに残す(チケットは作らない)。責任者がやると言えば、あとでチケットにできる", async () => {
    const { p, gh } = await setup();
    await pollIssues(p, gh);
    const tools = issueTools(p, { github: gh });
    expect(await call(tool(tools, "issue_to_owner"), { issue: 6, lean: "decline", reason: "仕様の外です" })).toContain("責任者に回しました");
    const row = (await p.pdb.from("github_issues").where("number", "=", 6).executeTakeFirst())!;
    expect(row.status).toBe("owner");
    expect(await p.tickets()).toEqual([]);
    const said = (await leadMessages(p)).find((m) => m.body.includes("Issue #6"))!;
    expect(said.who).toBe("lead");
    expect(said.body).toContain("仕様の外です");
    // 責任者に回した Issue は、見回りには二度と出ない
    expect((await newIssues(p)).map((i) => i.number)).toEqual([5]);
    // 責任者が「やる」と言えば、チャットの create_ticket で Issue をひも付けてチケットにできる
    await call(tool(leadChatTools(p, { github: gh }), "create_ticket"), { title: "課題 6", body: "x", kind: "feature", issue: 6 });
    expect((await p.pdb.from("github_issues").where("number", "=", 6).executeTakeFirst())!.status).toBe("ticketed");
  });

  it("何も選ばれなかった Issue は、見回りを終えると見送りになり、二度は見せない。見回りが落ちたとき(終えていない)は残って、次に見せる。サーバーを立ち上げ直しても同じ", async () => {
    const { p, clock, state, gh } = await setup();
    await pollIssues(p, gh);
    const shown = await newIssues(p);
    // 見回りが終わらなかった(finishPatrol を通らない): まだ new のまま
    expect((await newIssues(p)).map((i) => i.number)).toEqual([5, 6]);
    await finishPatrol(p, [], [], shown);
    expect(await newIssues(p)).toEqual([]);
    expect(await finishIssues(p, shown)).toEqual([]);
    // 見送った Issue も、やりとりに残る(責任者が追える)
    const said = (await leadMessages(p)).filter((m) => m.body.includes("見送りました"));
    expect(said.map((m) => m.body.match(/Issue #(\d+)/)![1])).toEqual(["5", "6"]);
    // 取り直しても、同じ Issue は new に戻らない
    clock.advance(5 * 60_000);
    expect(await pollIssues(p, gh)).toBe(0);
    // 表に残っているので、立ち上げ直しても(別の Project インスタンスから見ても)覚えている
    expect((await p.pdb.from("github_issues").execute()).map((r) => r.status)).toEqual(["passed", "passed"]);
    state.issues.push(issue(8));
    clock.advance(5 * 60_000);
    expect(await pollIssues(p, gh)).toBe(1);
  });
});

describe("Dispatcher からの見回り(#79)", () => {
  const run1 = async (p: Project, gh: GitHub, harness: FakeHarness) => {
    await p.setSetting("patrol_last_at", "2000-01-01T00:00:00.000Z"); // 見回りの間隔は過ぎている
    const d = new Dispatcher(p, { harnesses: { "claude-agent-sdk": harness }, workspace: new StaticWorkspace("/tmp"), triage: true, github: gh, recheckMs: 10 });
    await d.drain({ concurrency: 1, maxRuns: 1 });
  };

  it("新しい Issue が無い周期では、リーダー(LLM)を一度も呼ばない", async () => {
    const { p, clock, state, gh } = await setup();
    state.issues = [];
    clock.advance(10 * 60_000);
    let called = 0;
    await run1(p, gh, new FakeHarness(async () => (called++, {})));
    expect(state.labels).toHaveLength(1); // 取りには行く(ふつうのコード)
    expect(called).toBe(0);
    expect(await newIssues(p)).toEqual([]);
  });

  it("新しい Issue があれば、見回りでリーダーが一度だけ応答し、チケットができる。次の周期では呼ばれない", async () => {
    const { p, clock, state, gh } = await setup();
    state.issues = [issue(5)];
    clock.advance(10 * 60_000);
    let called = 0;
    const harness = new FakeHarness(async (req, call) => {
      called++;
      expect(req.prompt).toContain("Issue #5(acme/shop): 課題 5");
      expect(await call("create_ticket", { title: "課題 5 を直す", body: "やること", kind: "bugfix", issue: 5 })).toMatch(/を作りました/);
      return { finalText: "Issue #5 をチケットにしました。" };
    });
    await run1(p, gh, harness);
    expect(called).toBe(1);
    const t = (await p.tickets())[0]!;
    expect(JSON.parse(t.plan_refs)).toMatchObject({ issue: 5, issueUrl: "https://github.com/acme/shop/issues/5" });
    expect(await newIssues(p)).toEqual([]);
    // 次の周期(同じ Issue がまだ開いている)では、Issue への応答でリーダーを呼ばず、チケットも増えない
    clock.advance(10 * 60_000);
    const prompts: string[] = [];
    await run1(p, gh, new FakeHarness(async (req) => (prompts.push(req.prompt), {})));
    expect(prompts.filter((x) => x.includes("Issue #5(acme/shop)"))).toEqual([]);
    expect((await p.tickets()).length).toBe(1);
    expect(state.comments).toEqual([]);
  });
});

describe("同じ番号の Issue が複数のリポジトリにあるとき(#79)", () => {
  it("リポジトリを指さないと断り、指せば、そのリポジトリの Issue を扱う", async () => {
    const { p, gh } = await setup();
    await p.addRepo("acme/api", "API");
    await pollIssues(p, gh); // どちらのリポジトリにも #5・#6(フェイクは同じ一覧を返す)
    expect(await newIssues(p)).toHaveLength(4);
    const owner = tool(issueTools(p, { github: gh }), "issue_to_owner");
    expect(await call(owner, { issue: 5, lean: "ask", reason: "x" })).toContain("repo");
    expect((await newIssues(p)).length).toBe(4);
    const create = tool(leadChatTools(p, { github: gh }), "create_ticket");
    expect(await call(create, { title: "t", body: "x", kind: "bugfix", issue: 5 })).toContain("repo");
    expect(await p.tickets()).toEqual([]);
    expect(await call(create, { title: "t", body: "x", kind: "bugfix", issue: 5, issue_repo: "acme/api" })).toMatch(/を作りました/);
    expect(JSON.parse((await p.tickets())[0]!.plan_refs)).toMatchObject({ issue: 5, issueRepo: "acme/api" });
    expect(await call(owner, { issue: 5, repo: "acme/shop", lean: "ask", reason: "x" })).toContain("責任者に回しました");
  });
});
