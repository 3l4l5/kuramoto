import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ManualClock } from "../clock.js";
import { all, run } from "../db/sqlite.js";
import { fixedAll, FakeHarness, withResolutions } from "../harness/fake.js";
import type { Confinement } from "../harness/types.js";
import type { GitHub, PrStatus } from "../github/github.js";
import { Dispatcher } from "./dispatcher.js";
import { ownerMerge, type TeamCiHook } from "./merge.js";
import { Project, type TicketRow } from "./project.js";
import { detectCommands, runTeamCi, SandboxRunner, type CommandRunner } from "./team-ci.js";
import { StaticWorkspace } from "./workspace.js";
import { createTicket } from "./workflow.js";

const REPO = "acme/shop";

/** 決めた台本どおりに終わるコマンドの流し役。 */
class FakeRunner implements CommandRunner {
  ran: string[] = [];
  constructor(private readonly fail: (cmd: string, n: number) => string | null) {}
  async run(cmd: string): Promise<{ code: number | null; output: string }> {
    this.ran.push(cmd);
    const out = this.fail(cmd, this.ran.filter((c) => c === cmd).length);
    return out ? { code: 2, output: out } : { code: 0, output: "ok" };
  }
}

function setup(runner: CommandRunner, base = () => "main-1") {
  const clock = new ManualClock();
  const p = new Project(":memory:", clock);
  p.addRepo(REPO, "API");
  p.setSetting("ci_mode", "team");
  p.setSetting(`team_ci_commands:${REPO}`, "npm ci\nnpm run typecheck\nnpx vitest run");
  const prompts: { tools: string[]; prompt: string }[] = [];
  const harness = new FakeHarness(async (req, call) => {
    prompts.push({ tools: req.tools.map((t) => t.name), prompt: req.prompt });
    if (req.tools.some((t) => t.name === "submit_pr")) await call("submit_pr", { summary: "実装した", responses: fixedAll(req.prompt) });
    else if (req.tools.some((t) => t.name === "submit_review")) await call("submit_review", withResolutions(req.prompt, { verdict: "approve", findings: [] }));
  });
  const workspace = new StaticWorkspace("/tmp/ws", { prNumber: (r) => r.ticketNumber + 9, baseSha: base });
  const d = new Dispatcher(p, { harnesses: { "claude-agent-sdk": harness }, workspace, checkRunner: runner });
  const hook: TeamCiHook = { run: (t: TicketRow, repo, branch) => runTeamCi(p, workspace, runner, t, repo, branch), baseSha: () => workspace.baseSha() };
  return { p, d, prompts, hook, clock };
}

class FakeGitHub implements GitHub {
  merged: number[] = [];
  async prStatus(): Promise<PrStatus> {
    // チームの CI では、GitHub の CI は見ない(止めてあるので落ちている・始まらない)
    return { state: "OPEN", mergeable: "MERGEABLE", ci: "failure" };
  }
  async merge(_r: string, n: number): Promise<void> {
    this.merged.push(n);
  }
  async comment(): Promise<string> {
    return "";
  }
}

describe("チームの CI(ADR-0028)", () => {
  it("package.json から、入れる → lint → 型 → テストを決める", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kuramoto-ci-"));
    try {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { lint: "eslint .", typecheck: "tsc", test: "vitest run", dev: "vite" } }));
      writeFileSync(join(dir, "package-lock.json"), "{}");
      expect(detectCommands(dir)).toEqual(["npm ci", "npm run lint", "npm run typecheck", "npm test"]);
      writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { "type-check": "tsc" } }));
      writeFileSync(join(dir, "pnpm-lock.yaml"), "");
      expect(detectCommands(dir)).toEqual(["pnpm install --frozen-lockfile", "pnpm run type-check"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("PR を出したら、レビューの前に流す。落ちたら出力を付けてその場で持ち主に戻し、通ったらレビューに回す", async () => {
    const runner = new FakeRunner((cmd, n) => (cmd === "npm run typecheck" && n === 1 ? "src/a.ts(3,1): error TS2322: Type 'string' is not assignable to type 'number'." : null));
    const { p, d, prompts } = setup(runner);
    const t = await createTicket(p, { title: "A" });
    await d.drain();

    // 1 回目は型で落ちる。テストは流さない(早く返す)。レビューには回さない
    expect(runner.ran.slice(0, 2)).toEqual(["npm ci", "npm run typecheck"]);
    expect(prompts[0]!.prompt).toContain("Kuramoto がチームの CI");
    expect(prompts[0]!.prompt).toContain("`npm run typecheck`");
    expect(prompts[1]!.tools).toContain("submit_pr"); // 2 回目も開発(直し)
    expect(prompts[1]!.prompt).toContain("チームの CI で確かめたところ、落ちました");
    expect(prompts[1]!.prompt).toContain("error TS2322");
    // 直したら通って、レビューを経て merge 待ちへ
    expect(prompts[2]!.tools).toContain("submit_review");
    expect(p.ticket(t.id).stage).toBe("merge");
    expect(all<{ type: string }>(p.db, "SELECT type FROM events WHERE type LIKE 'team_ci_%' ORDER BY id").map((e) => e.type)).toEqual(["team_ci_failed", "team_ci_passed"]);
  });

  it("merge では GitHub の CI を見ない。通ったときから main が進んでいなければそのまま merge し、進んでいれば流し直す", async () => {
    let base = "main-1";
    let failNext = false;
    const runner = new FakeRunner((cmd) => (failNext && cmd === "npx vitest run" ? "FAIL test/save.test.ts" : null));
    const { p, d, hook } = setup(runner, () => base);
    const a = await createTicket(p, { title: "A" });
    const b = await createTicket(p, { title: "B" });
    await d.drain();
    const gh = new FakeGitHub();

    const before = runner.ran.length;
    expect(await ownerMerge(p, gh, a.id, "team", { teamCi: hook })).toEqual({ result: "merged" });
    expect(runner.ran.length).toBe(before); // main が同じなので流し直さない

    // main が進んだ。B は新しい main と合わせると落ちるので、merge せず持ち主に戻す
    base = "main-2";
    failNext = true;
    expect(await ownerMerge(p, gh, b.id, "team", { teamCi: hook })).toMatchObject({ result: "blocked", reason: expect.stringContaining("npx vitest run") });
    expect(gh.merged).toEqual([10]);
    expect(p.ticket(b.id).stage).toBe("dev");

    // 持ち主が直した(今度は通る)。チームの CI を流す口が無ければ merge しない
    failNext = false;
    await d.drain({ maxRuns: 10 });
    expect(p.ticket(b.id).stage).toBe("merge");
    expect(await ownerMerge(p, gh, b.id, "team")).toMatchObject({ result: "blocked" });
  });

  it.skipIf(process.platform !== "darwin")("閉じ込めの中で流す: 作業場所は書けて、ホームの認証情報は読めない", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kuramoto-srt-"));
    mkdirSync(join(dir, "sub"));
    try {
      const conf: Confinement = { readable: [], writable: [], hidden: [join(homedir(), ".ssh")], allowedDomains: ["registry.npmjs.org"], hiddenEnv: ["GH_TOKEN"], allowLocalSockets: false, env: {} };
      const r = new SandboxRunner();
      process.env.GH_TOKEN = "secret-token";
      const ok = await r.run("echo hi > sub/out.txt && cat sub/out.txt && echo token=${GH_TOKEN:-none}", dir, conf, 60_000);
      expect(ok).toMatchObject({ code: 0 });
      expect(ok.output).toContain("hi");
      expect(ok.output).toContain("token=none");
      const denied = await r.run(`ls ${join(homedir(), ".ssh")} && echo READ`, dir, conf, 60_000);
      expect(denied.output).not.toContain("READ");
      const home = await r.run(`touch ${join(homedir(), ".kuramoto-srt-probe")} && echo WROTE`, dir, conf, 60_000);
      expect(home.output).not.toContain("WROTE");
      await r.close();
    } finally {
      delete process.env.GH_TOKEN;
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("チームの CI を使うなら、GitHub Actions の CI のためのチケット(main の CI を直す)は取りやめる。リーダーは、やることの無いチケットを手助けの中で取りやめられる", async () => {
    const runner = new FakeRunner(() => null);
    const { p, d } = setup(runner);
    const fixer = await createTicket(p, { title: "main の CI を直す(check)", planRefs: { repo: REPO, baseCi: REPO } });
    const { holdTicket, droppedInfo } = await import("./workflow.js");
    await holdTicket(p, fixer.id, { reason: "Actions の請求で止まっている", ownerAction: "請求を直す", resume: { toRole: "dev", toMemberId: null, kind: "implement", payload: {} } });
    p.setSetting("ci_blocked", JSON.stringify([{ repo: REPO, since: "", notes: [], probedAt: "", runIds: [] }]));
    await d.housekeep();
    expect(p.ticket(fixer.id).stage).toBe("dropped");
    expect((await droppedInfo(p, fixer.id))!.reason).toContain("チームの CI");
    expect(p.setting("ci_blocked")).toBe("[]");
    const { pendingOwnerDecisions } = await import("./workflow.js");
    expect(await pendingOwnerDecisions(p)).toEqual([]);

    // 手助けの道具: やることの無いチケットを取りやめる(リーダー自身の起動中でも)
    const { unstickTools } = await import("./unstick.js");
    const t = await createTicket(p, { title: "docs だけの調査" });
    const msg = run(p.db, "INSERT INTO messages (ticket_id, to_role, kind, status, available_at, created_at) VALUES (?, 'lead', 'unstick', 'claimed', '', '')", [t.id]).lastId;
    run(p.db, "INSERT INTO runs (message_id, ticket_id, member_id, role, policy_id, formation_id, started_at) VALUES (?, ?, ?, 'lead', 1, 1, '')", [msg, t.id, p.fixedMember("lead").id]);
    const done: { action?: "retry" | "hold" | "closed" | "dropped" } = {};
    const tools = await unstickTools(p, p.ticket(t.id), { error: "submit_pr が呼ばれませんでした", resume: { toRole: "dev", toMemberId: null, kind: "implement", payload: {} } }, done);
    expect(await tools.find((x) => x.name === "drop_ticket")!.handler({ reason: "直すコードが無い" } as never)).toContain("取りやめました");
    expect(done.action).toBe("dropped");
    // チームの CI では、GitHub の CI を調べる道具は渡さない
    const { ciTools } = await import("./ci-tools.js");
    expect(ciTools(p, { ciDetail: async () => ({}) } as never, { rerun: true })).toEqual([]);
  });
});
