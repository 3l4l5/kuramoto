import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ManualClock } from "../clock.js";
import { fixedAll, FakeHarness, withResolutions } from "../harness/fake.js";
import type { CommandRunner } from "./team-ci.js";
import { Dispatcher } from "./dispatcher.js";
import { runTeamCi } from "./team-ci.js";
import { Project } from "./project.js";
import { promptFor } from "./prompts.js";
import type { MessageRow } from "./inbox.js";
import { branchNameError, setTeamBranch, teamBranch, teamBranchLabel } from "./team-branch.js";
import { unstickPrompt } from "./unstick.js";
import { GitWorkspace, StaticWorkspace } from "./workspace.js";
import { closeAlreadyDone, createTicket, type ResumeMessage } from "./workflow.js";

const REPO = "acme/shop";

const okRunner: CommandRunner = { run: async () => ({ code: 0, output: "ok" }) };

async function setup(branch?: string) {
  const p = await Project.open(":memory:", new ManualClock());
  await p.addRepo(REPO, "API");
  await p.setSetting("ci_mode", "team");
  await p.setSetting(`team_ci_commands:${REPO}`, "npm test");
  if (branch !== undefined) await setTeamBranch(p, branch);
  const harness = new FakeHarness(async (req, call) => {
    if (req.tools.some((t) => t.name === "submit_pr")) await call("submit_pr", { summary: "実装した", responses: fixedAll(req.prompt) });
    else if (req.tools.some((t) => t.name === "submit_review")) await call("submit_review", withResolutions(req.prompt, { verdict: "approve", findings: [] }));
  });
  const ws = new StaticWorkspace("/tmp/ws", { prNumber: (r) => r.ticketNumber + 9 });
  const d = new Dispatcher(p, { harnesses: { "claude-agent-sdk": harness }, workspace: ws, checkRunner: okRunner });
  return { p, d, ws };
}

describe("チームが使うブランチの設定", () => {
  it("未設定なら undefined(表示は main)。設定でき、空に戻せる", async () => {
    const { p } = await setup();
    expect(await teamBranch(p)).toBeUndefined();
    expect(await teamBranchLabel(p)).toBe("main");
    await setTeamBranch(p, " develop ");
    expect(await teamBranch(p)).toBe("develop");
    expect(await teamBranchLabel(p)).toBe("develop");
    await setTeamBranch(p, "");
    expect(await teamBranch(p)).toBeUndefined();
  });

  it("ブランチ名として使えない形は保存しない", async () => {
    const { p } = await setup();
    for (const bad of ["-D", "a b", "a..b", "x/", "/x", "a.lock", "a~1", "a:b", "a@{1}", "a//b"]) {
      expect(branchNameError(bad), bad).toBeTruthy();
      await expect(setTeamBranch(p, bad)).rejects.toThrow("ブランチ名");
    }
    for (const good of ["develop", "release/1.2", "feature/x-y_z"]) expect(branchNameError(good), good).toBeUndefined();
    expect(await teamBranch(p)).toBeUndefined();
  });

  it("プロジェクトごとに持つ(別のプロジェクトには効かない)", async () => {
    const a = await setup("develop");
    const b = await setup();
    expect(await teamBranch(a.p)).toBe("develop");
    expect(await teamBranch(b.p)).toBeUndefined();
  });
});

describe("チームが使うブランチを、起点・PR の向き先・チームの CI に使う", () => {
  it("設定すると、新しく始めるチケットの作業場所の起点と PR の向き先と、チームの CI の合わせ先がそのブランチになる", async () => {
    const { p, d, ws } = await setup("develop");
    await createTicket(p, { title: "A" });
    await d.drain();
    expect(ws.prepared.length).toBeGreaterThan(0);
    expect(ws.prepared.every((r) => r.base === "develop")).toBe(true);
    expect(ws.published.map((r) => r.base)).toEqual(["develop"]);
    expect(ws.checks.map((c) => c.base)).toEqual(["develop"]);
  });

  it("未設定なら今までどおり(base を渡さず、PR は既定のブランチ向き)", async () => {
    const { p, d, ws } = await setup();
    await createTicket(p, { title: "A" });
    await d.drain();
    expect(ws.prepared.every((r) => r.base === undefined)).toBe(true);
    expect(ws.published.map((r) => r.base)).toEqual(["main"]);
    expect(ws.checks.map((c) => c.base)).toEqual([undefined]);
  });

  it("チームの CI は、設定したブランチと合わせた結果を残す", async () => {
    const { p, ws } = await setup("develop");
    const t = await createTicket(p, { title: "A" });
    const r = await runTeamCi(p, ws, okRunner, t, REPO, "kuramoto/1");
    expect(r.base).toBe("develop");
  });
});

describe("プロンプトや文言の main をチームのブランチにする", () => {
  const msg = (kind: string, payload: object) => ({ kind, payload: JSON.stringify(payload) }) as unknown as MessageRow;

  it("衝突・CI・レビューのやり直しの指示が、設定したブランチを指す", async () => {
    const { p } = await setup("develop");
    const conflict = await promptFor(p, msg("fix", { conflict: true, cause: "x" }), null, { branch: "kuramoto/1", base: "develop", repo: REPO, prNumber: 3 });
    expect(conflict).toContain("origin/develop");
    expect(conflict).not.toContain("origin/main");
    const ci = await promptFor(p, msg("fix", { ci: true }), null, { branch: "kuramoto/1", base: "develop", repo: REPO, prNumber: 3 });
    expect(ci).toContain("git merge origin/develop");
    expect(ci).toContain("develop を取り込んで");
    // 開発の指示のチームの CI の説明
    const implement = await promptFor(p, msg("implement", {}), null, { branch: "kuramoto/1", base: "develop", repo: REPO });
    expect(implement).toContain("最新の develop と合わせて");
    expect(implement).not.toContain("最新の main");
  });

  it("base が渡されなくても、設定があればそれを使い、無ければ main のまま", async () => {
    const withSetting = await setup("develop");
    expect(await promptFor(withSetting.p, msg("fix", { conflict: true }), null, { repo: REPO })).toContain("origin/develop");
    const plain = await setup();
    expect(await promptFor(plain.p, msg("fix", { conflict: true }), null, { repo: REPO })).toContain("origin/main");
  });

  it("リーダーの詰まりの調べの指示が、設定したブランチを指す", async () => {
    const { p } = await setup("develop");
    const t = await createTicket(p, { title: "A" });
    const resume = { kind: "implement", toRole: "dev", toMemberId: null, payload: {} } as unknown as ResumeMessage;
    const text = await unstickPrompt(p, t, { error: "x", resume });
    expect(text).toContain("git log origin/develop");
    expect(text).toContain("すでに develop に入っている");
    expect(text).not.toContain("origin/main");
    const plain = await setup();
    const t2 = await createTicket(plain.p, { title: "A" });
    expect(await unstickPrompt(plain.p, t2, { error: "x", resume })).toContain("git log origin/main");
  });

  it("すでに入っていたものとして閉じるときのメモが、設定したブランチを指す", async () => {
    const { p } = await setup("develop");
    const t = await createTicket(p, { title: "A" });
    await closeAlreadyDone(p, t, { commit: "abc1234", reason: "先に入っていた", by: "lead" });
    const notes = await p.notes(t.id);
    expect(notes.map((n) => n.body).join("\n")).toContain("【すでに develop に入っていました】");
  });
});

describe("GitWorkspace(実際の git)", () => {
  function fixture() {
    const dir = mkdtempSync(join(tmpdir(), "kuramoto-tb-"));
    const git = (cwd: string, ...a: string[]) => execFileSync("git", ["-C", cwd, ...a], { encoding: "utf8" }).trim();
    const origin = join(dir, "origin.git");
    execFileSync("git", ["init", "--bare", "-b", "main", origin]);
    const seed = join(dir, "seed");
    execFileSync("git", ["clone", origin, seed], { stdio: "ignore" });
    git(seed, "config", "user.email", "t@example.com");
    git(seed, "config", "user.name", "t");
    git(seed, "commit", "--allow-empty", "-m", "main-1");
    git(seed, "push", "origin", "HEAD:main");
    const mainSha = git(seed, "rev-parse", "HEAD");
    git(seed, "commit", "--allow-empty", "-m", "develop-1");
    git(seed, "push", "origin", "HEAD:develop");
    const developSha = git(seed, "rev-parse", "HEAD");
    // Kuramoto の元の clone は、<workDir>/repos/<owner>__<repo>(あれば clone し直さない)
    mkdirSync(join(dir, "work", "repos"), { recursive: true });
    execFileSync("git", ["clone", origin, join(dir, "work", "repos", "acme__shop")], { stdio: "ignore" });
    return { dir, work: join(dir, "work"), git, mainSha, developSha };
  }
  const req = (n: number, base?: string) => ({ repo: REPO, ticketNumber: n, role: "dev" as const, memberName: "m", branch: `kuramoto/${n}`, ...(base ? { base } : {}) });

  it("設定したブランチから worktree を切り、base もそのブランチにする。未設定なら origin/HEAD(main)", async () => {
    const f = fixture();
    try {
      const ws = new GitWorkspace(f.work);
      const dev = await ws.prepare(req(1, "develop"));
      expect(dev.base).toBe("develop");
      expect(f.git(dev.path, "rev-parse", "HEAD")).toBe(f.developSha);
      const plain = await ws.prepare(req(2));
      expect(plain.base).toBe("main");
      expect(f.git(plain.path, "rev-parse", "HEAD")).toBe(f.mainSha);
      // ブランチを読むだけの場所(ブランチなし)も、設定したブランチ
      const chat = await ws.prepare({ ...req(3, "develop"), branch: "" });
      expect(f.git(chat.path, "rev-parse", "HEAD")).toBe(f.developSha);
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  });

  it("merge 直前の確かめは、設定したブランチの先頭を見る。merge 済みの判定もそのブランチで行う", async () => {
    const f = fixture();
    try {
      const ws = new GitWorkspace(f.work);
      expect(await ws.baseSha(REPO, "develop")).toBe(f.developSha);
      expect(await ws.baseSha(REPO)).toBe(f.mainSha);
      const dev = await ws.prepare(req(1, "develop"));
      // develop 上のコミットは develop には入っているが、main には入っていない
      expect(await ws.landed(dev.path, "develop", f.developSha)).toBeUndefined();
      expect(await ws.landed(dev.path, "main", f.developSha)).toContain("origin/main に入っていません");
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  });
});
