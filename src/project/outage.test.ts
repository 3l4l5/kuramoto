import { describe, expect, it } from "vitest";
import { ManualClock } from "../clock.js";
import { all, get, run } from "../db/sqlite.js";
import { fixedAll, FakeHarness, withResolutions } from "../harness/fake.js";
import type { CiDetail, GitHub, PrStatus } from "../github/github.js";
import { Dispatcher } from "./dispatcher.js";
import { leadMessages } from "./leadchat.js";
import { autoMerge, ownerMerge } from "./merge.js";
import { githubDown } from "./outage.js";
import { Project } from "./project.js";
import { StaticWorkspace, type PublishRequest } from "./workspace.js";
import { createTicket, holdTicket, pendingOwnerDecisions } from "./workflow.js";

const REPO = "acme/shop";
const AUTH = "Command failed: gh pr list --repo acme/shop --head kuramoto/1\nHTTP 401: Requires authentication (https://api.github.com/graphql)";

function setup(opts: { publishError?: () => string | undefined; github?: () => string | undefined; sha?: string } = {}) {
  const clock = new ManualClock();
  const p = new Project(":memory:", clock);
  p.addRepo(REPO, "API");
  const prompts: string[] = [];
  const harness = new FakeHarness(async (req, call) => {
    prompts.push(req.prompt);
    if (req.tools.some((t) => t.name === "submit_pr")) await call("submit_pr", { summary: "実装した", responses: fixedAll(req.prompt) });
    else if (req.tools.some((t) => t.name === "submit_review")) await call("submit_review", withResolutions(req.prompt, { verdict: "approve", findings: [] }));
  });
  class Ws extends StaticWorkspace {
    override async publish(r: PublishRequest) {
      const out = await super.publish(r);
      return opts.sha ? { ...out, sha: opts.sha } : out;
    }
  }
  const workspace = new Ws("/tmp/ws", { prNumber: (r) => r.ticketNumber + 9, publishError: opts.publishError, github: opts.github });
  const d = new Dispatcher(p, { harnesses: { "claude-agent-sdk": harness }, workspace });
  return { p, clock, d, harness, prompts, workspace };
}

class FakeGitHub implements GitHub {
  merged: number[] = [];
  reruns: number[] = [];
  ci: PrStatus["ci"] = "failure";
  detail: (number: number) => CiDetail = () => ({ headSha: "sha-1", base: "main", failing: [], baseFailing: [] });
  async prStatus(): Promise<PrStatus> {
    return { state: "OPEN", mergeable: "MERGEABLE", ci: this.ci };
  }
  async merge(_r: string, n: number): Promise<void> {
    this.merged.push(n);
  }
  async comment(): Promise<string> {
    return "";
  }
  async ciDetail(_r: string, n: number): Promise<CiDetail> {
    return this.detail(n);
  }
  async rerunFailed(_r: string, runId: number): Promise<void> {
    this.reruns.push(runId);
  }
}

describe("GitHub に入れない(認証切れ)とき(ADR-0027)", () => {
  it("チケットの失敗にせず、1 回だけ知らせて待ち、入れるようになったら自動で再開する", async () => {
    let down = true;
    const { p, d, clock, workspace } = setup({ publishError: () => (down ? AUTH : undefined), github: () => (down ? "HTTP 401: Bad credentials" : undefined) });
    const a = await createTicket(p, { title: "A" });
    await createTicket(p, { title: "B" });
    // 前に(この仕組みの前に)認証切れで保留になっていたチケット
    const held = await createTicket(p, { title: "C" });
    run(p.db, "UPDATE messages SET status = 'failed' WHERE ticket_id = ?", [held.id]);
    await holdTicket(p, held.id, { reason: "gh pr list が HTTP 401 (Requires authentication) を返す", ownerAction: "gh を認証し直す", resume: { toRole: "dev", toMemberId: null, kind: "implement", payload: {} } });

    await d.drain({ maxRuns: 5 });
    expect(githubDown(p)).toMatchObject({ error: expect.stringContaining("401") });
    // 失敗に数えない・保留にしない・リーダーの手助けも頼まない
    expect(all(p.db, "SELECT 1 FROM messages WHERE (status = 'failed' AND ticket_id <> ?) OR kind = 'unstick'", [held.id])).toEqual([]);
    expect((await pendingOwnerDecisions(p)).length).toBe(1); // 前からある C の保留だけ
    expect(leadMessages(p).filter((m) => m.body.includes("【GitHub に入れません】")).length).toBe(1);
    expect(leadMessages(p).at(-1)!.body).toContain("gh auth login");
    // 入れない間は、チケットの仕事を起こさない
    const runs = all(p.db, "SELECT id FROM runs").length;
    clock.advance(30_000);
    await d.drain({ maxRuns: 5 });
    expect(all(p.db, "SELECT id FROM runs").length).toBe(runs);

    // 認証し直した。次に確かめたときに気づいて再開する(保留にしていた C も)
    down = false;
    clock.advance(61_000);
    await d.drain();
    expect(githubDown(p)).toBeNull();
    expect(leadMessages(p).some((m) => m.body.includes("【GitHub に戻れました】"))).toBe(true);
    expect(await pendingOwnerDecisions(p)).toEqual([]);
    expect(p.tickets().map((t) => t.stage)).toEqual(["merge", "merge", "merge"]);
    expect(workspace.published.length).toBe(3);
    expect(p.ticket(a.id).stage).toBe("merge");
  });

  it("merge の見回りで認証切れに気づいたら、merge を止めて知らせる", async () => {
    const { p, d } = setup();
    const t = await createTicket(p, { title: "A" });
    await d.drain();
    expect(p.ticket(t.id).stage).toBe("merge");
    const gh = new FakeGitHub();
    gh.prStatus = async () => {
      throw new Error(AUTH);
    };
    expect(await autoMerge(p, gh)).toBe(0);
    expect(githubDown(p)).not.toBeNull();
    expect(p.ticket(t.id).stage).toBe("merge");
  });
});

describe("CI が落ちたとき(ADR-0027)", () => {
  const failing = (log: string): CiDetail => ({
    headSha: "sha-same",
    base: "main",
    failing: [
      { name: "test", link: "https://github.com/acme/shop/actions/runs/77/job/1", runId: 77, log },
      { name: "lint", link: "https://github.com/acme/shop/actions/runs/77/job/2", runId: 77, log },
    ],
    baseFailing: [],
  });

  it("まず落ちたジョブを 1 回やり直す。それでも落ちたら、ログを持ち主に渡す。同じコミットのまま出し直したら受け付けない", async () => {
    const { p, d, prompts } = setup({ sha: "sha-same" });
    const t = await createTicket(p, { title: "A" });
    await d.drain();
    const gh = new FakeGitHub();
    gh.detail = () => failing("FAIL test/a.test.ts > 保存する\nExpected 200, received 412");

    expect(await ownerMerge(p, gh, t.id)).toMatchObject({ result: "blocked", reason: expect.stringContaining("1 回やり直して") });
    expect(gh.reruns).toEqual([77]);
    expect(p.ticket(t.id).stage).toBe("merge");

    expect(await ownerMerge(p, gh, t.id)).toMatchObject({ result: "blocked", reason: expect.stringContaining("持ち主に直してもらいます") });
    expect(gh.reruns).toEqual([77]); // やり直しは同じコミットで 1 回だけ
    expect(p.ticket(t.id).stage).toBe("dev");

    // 何も変えずに出し直す担当。受け付けず、続けばリーダーに手助けを頼む
    await d.dispatchOnce();
    const fix = prompts.at(-1)!;
    expect(fix).toContain("Expected 200, received 412");
    expect(fix).toContain("https://github.com/acme/shop/actions/runs/77/job/1");
    expect(fix).toContain("GitHub(Actions のログ・PR の Checks)は見えません");
    expect(fix.match(/Expected 200/g)!.length).toBe(1); // 同じ実行のログは 1 回だけ
    expect(get<{ last_error: string }>(p.db, "SELECT last_error FROM messages WHERE kind = 'fix' ORDER BY id DESC LIMIT 1")!.last_error).toContain("何も変わっていません");
    expect(p.ticket(t.id).stage).toBe("dev");
  });

  it("main でも同じ確認が落ちていたら、持ち主に戻さず、main の CI を直すチケットを 1 枚だけ作って待つ", async () => {
    const { p, d } = setup();
    const a = await createTicket(p, { title: "A" });
    const b = await createTicket(p, { title: "B" });
    await d.drain();
    const gh = new FakeGitHub();
    gh.detail = (n) => ({ ...failing("Error: secret DB_URL is not set"), headSha: `sha-${n}`, baseFailing: ["test"] });

    expect(await ownerMerge(p, gh, a.id)).toMatchObject({ result: "blocked", reason: expect.stringContaining("main でも同じ CI(test)") });
    expect(await ownerMerge(p, gh, b.id)).toMatchObject({ result: "blocked" });
    expect(p.ticket(a.id).stage).toBe("merge");
    expect(p.ticket(b.id).stage).toBe("merge");
    expect(gh.reruns).toEqual([]);
    const fixers = p.tickets().filter((t) => t.title.startsWith("main の CI を直す"));
    expect(fixers.map((t) => t.title)).toEqual(["main の CI を直す(test)"]);
    expect(fixers[0]!.body).toContain("secret DB_URL is not set");
  });

  it("ジョブが始まってもいない(請求・上限など)なら、持ち主にも main の CI を直すチケットにも回さず、1 回だけ知らせて待ち、動き出したら再開する", async () => {
    const { p, d, clock } = setup();
    const a = await createTicket(p, { title: "A" });
    const b = await createTicket(p, { title: "B" });
    await d.drain();
    const gh = new FakeGitHub();
    const note = "failure: The job was not started because recent account payments have failed or your spending limit needs to be increased.";
    gh.detail = (n) => ({
      headSha: `sha-${n}`,
      base: "main",
      failing: [{ name: "check", link: "https://github.com/acme/shop/actions/runs/88/job/1", runId: 88, log: "(ログを取れませんでした: log not found)", started: false, notes: [note] }],
      baseFailing: ["check"],
    });
    expect(await ownerMerge(p, gh, a.id)).toMatchObject({ result: "blocked", reason: expect.stringContaining("Spending limit") });
    expect(await ownerMerge(p, gh, b.id)).toMatchObject({ result: "blocked" });
    expect([p.ticket(a.id).stage, p.ticket(b.id).stage]).toEqual(["merge", "merge"]);
    expect(p.tickets().some((t) => t.title.includes("CI を直す"))).toBe(false);
    expect(leadMessages(p).filter((m) => m.body.includes("CI が動いていません")).length).toBe(1);
    expect(leadMessages(p).at(-1)!.body).toContain("spending limit");
    expect(gh.reruns).toEqual([]);

    // 間を空けて、直ったかを確かめにやり直す
    clock.advance(16 * 60_000);
    await ownerMerge(p, gh, a.id);
    expect(gh.reruns).toEqual([88]);

    // 責任者が直して、CI が通った
    gh.ci = "success";
    expect(await ownerMerge(p, gh, a.id)).toEqual({ result: "merged" });
    expect(leadMessages(p).at(-1)!.body).toContain("CI が動き出しました");
    const { ciBlocked } = await import("./outage.js");
    expect(ciBlocked(p)).toEqual([]);
  });
});

describe("CI を調べる道具(ADR-0027)", () => {
  it("開発とリーダーは、Kuramoto に GitHub の CI を見てもらえる。やり直しはリーダーだけ", async () => {
    const { p, d } = setup();
    const t = await createTicket(p, { title: "A" });
    await d.drain();
    const gh = new FakeGitHub();
    gh.detail = () => ({ headSha: "sha-1", base: "main", failing: [{ name: "check", link: null, runId: 9, log: "Error: boom", started: true, notes: [], failedStep: "Run tests" }], baseFailing: [] });
    gh.ciRun = async () => ({ id: 9, url: "u", workflow: "CI", status: "completed", conclusion: "failure", headSha: "abc1234", jobs: [{ id: 1, name: "check", status: "completed", conclusion: "failure", started: false, failedStep: null, notes: ["The job was not started because ..."] }] });
    gh.runLog = async () => "";
    gh.ciSettings = async () => ({ secrets: ["SCREENSHOT_PASSWORD"], variables: [] });
    const { ciTools } = await import("./ci-tools.js");
    const dev = ciTools(p, gh, { ticket: p.ticket(t.id) });
    expect(dev.map((x) => x.name)).toEqual(["ci_status", "ci_run", "ci_settings"]);
    const call = (tools: typeof dev, name: string, args: Record<string, unknown>) => tools.find((x) => x.name === name)!.handler(args as never);
    expect(await call(dev, "ci_status", {})).toContain("落ちたステップ: Run tests");
    expect(await call(dev, "ci_run", { run_id: 9 })).toContain("始まっていない");
    expect(await call(dev, "ci_settings", {})).toContain("SCREENSHOT_PASSWORD");

    const lead = ciTools(p, gh, { rerun: true });
    for (let i = 0; i < 3; i++) expect(await call(lead, "ci_rerun", { run_id: 9, number: t.number })).toContain("やり直しました");
    expect(await call(lead, "ci_rerun", { run_id: 9, number: t.number })).toContain("3 回");
    expect(gh.reruns).toEqual([9, 9, 9]);
  });
});
