import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ManualClock } from "../clock.js";
import { FakeHarness, fixedAll, withResolutions } from "../harness/fake.js";
import { baseBranchOf, branchNameOk, setBaseBranch } from "./base-branch.js";
import { Dispatcher } from "./dispatcher.js";
import { Project } from "./project.js";
import { createTicket } from "./workflow.js";
import { GitWorkspace, StaticWorkspace } from "./workspace.js";

/** リポジトリごとの merge 先のブランチ。 */
describe("merge 先のブランチ", () => {
  it("git のブランチ名として使えるものだけを受け付ける", () => {
    for (const ok of ["develop", "release/1.2", "feature/a-b_c", "v1.0"]) expect(branchNameOk(ok)).toBe(true);
    for (const bad of ["", "-x", "a b", "a..b", "a~1", "a^", "a:b", "a?", "a*", "a[b", "a\\b", "/a", "a/", "a//b", "a.", "a.lock", "a/.b", "a@{1}", "@"]) expect(branchNameOk(bad)).toBe(false);
  });

  it("決めていなければ undefined(既定のブランチを使う)。空にすると戻る。使えない名前は断る", () => {
    const p = new Project(":memory:", new ManualClock());
    p.addRepo("acme/shop", "API");
    expect(baseBranchOf(p, "acme/shop")).toBeUndefined();
    setBaseBranch(p, "acme/shop", " develop ");
    expect(baseBranchOf(p, "acme/shop")).toBe("develop");
    setBaseBranch(p, "acme/shop", "");
    expect(baseBranchOf(p, "acme/shop")).toBeUndefined();
    expect(() => setBaseBranch(p, "acme/shop", "a..b")).toThrow("ブランチ名");
  });

  it("決めた merge 先に向けて PR を出す", async () => {
    const p = new Project(":memory:", new ManualClock());
    p.addRepo("acme/shop", "API");
    setBaseBranch(p, "acme/shop", "develop");
    const harness = new FakeHarness(async (req, call) => {
      if (req.tools.some((t) => t.name === "submit_pr")) await call("submit_pr", { summary: "足した", responses: fixedAll(req.prompt) });
      else await call("submit_review", withResolutions(req.prompt, { verdict: "approve", findings: [] }));
    });
    const workspace = new StaticWorkspace("/tmp/ws");
    const d = new Dispatcher(p, { harnesses: { "claude-agent-sdk": harness }, workspace });
    createTicket(p, { title: "CSV の書き出し" });
    await d.drain();
    expect(workspace.published).toMatchObject([{ repo: "acme/shop", base: "develop" }]);
    expect(harness.calls[0]!.prompt).toContain("origin/develop");
  });

  it("GitWorkspace は、決めた merge 先から作業を始め、チームの CI もそこと合わせる。origin に無ければ断る", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kuramoto-base-"));
    const git = (cwd: string, ...a: string[]) => execFileSync("git", ["-C", cwd, ...a], { encoding: "utf8" });
    execFileSync("git", ["init", "--bare", "-b", "main", join(dir, "origin.git")]);
    const w = join(dir, "w");
    execFileSync("git", ["clone", join(dir, "origin.git"), w], { stdio: "ignore" });
    git(w, "config", "user.email", "t@example.com");
    git(w, "config", "user.name", "t");
    git(w, "commit", "--allow-empty", "-m", "init");
    git(w, "push", "origin", "HEAD:main");
    writeFileSync(join(w, "dev.txt"), "d\n");
    git(w, "add", "dev.txt");
    git(w, "commit", "-m", "develop だけの変更");
    git(w, "push", "origin", "HEAD:develop");
    const developSha = git(w, "rev-parse", "HEAD").trim();
    // GitWorkspace は <workDir>/repos/<owner>__<repo> に clone があればそれを使う
    const workDir = join(dir, "work");
    execFileSync("git", ["clone", join(dir, "origin.git"), join(workDir, "repos", "acme__shop")], { stdio: "ignore" });
    const ws = new GitWorkspace(workDir);

    const dev = await ws.prepare({ repo: "acme/shop", ticketNumber: 1, role: "dev", memberName: "a", branch: "kuramoto/1", base: "develop" });
    expect(dev.base).toBe("develop");
    expect(git(dev.path, "rev-parse", "HEAD").trim()).toBe(developSha);
    // 決めていなければ origin の既定のブランチ
    expect((await ws.prepare({ repo: "acme/shop", ticketNumber: 2, role: "dev", memberName: "a", branch: "kuramoto/2" })).base).toBe("main");
    await expect(ws.prepare({ repo: "acme/shop", ticketNumber: 3, role: "dev", memberName: "a", branch: "kuramoto/3", base: "nope" })).rejects.toThrow("merge 先のブランチ nope が acme/shop にありません");

    git(dev.path, "config", "user.email", "t@example.com");
    git(dev.path, "config", "user.name", "t");
    writeFileSync(join(dev.path, "a.txt"), "a\n");
    git(dev.path, "add", "a.txt");
    git(dev.path, "commit", "-m", "a");
    git(dev.path, "push", "origin", "HEAD:refs/heads/kuramoto/1");
    const check = await ws.prepareCheck({ repo: "acme/shop", ticketNumber: 1, branch: "kuramoto/1", base: "develop" });
    expect(check).toMatchObject({ base: "develop", baseSha: developSha });
    expect(check.conflict).toBeUndefined();
    expect(await ws.baseSha("acme/shop", "develop")).toBe(developSha);
  });
});
