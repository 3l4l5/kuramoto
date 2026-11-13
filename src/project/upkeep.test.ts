import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ManualClock } from "../clock.js";
import { run } from "../db/sqlite.js";
import { FakeHarness } from "../harness/fake.js";
import { Dispatcher } from "./dispatcher.js";
import { Project } from "./project.js";
import { DiskGuard, Slots, sweepWorktrees } from "./upkeep.js";
import { GitWorkspace, StaticWorkspace, type Workspace } from "./workspace.js";
import { createTicket } from "./workflow.js";

const GB = 1024 ** 3;

describe("Slots", () => {
  it("上限まで取れ、返すと空きを待っている側に知らせる", () => {
    const s = new Slots(() => 2);
    let woke = 0;
    s.onFree(() => woke++);
    expect(s.free()).toBe(true);
    s.take();
    s.take();
    expect(s.free()).toBe(false);
    s.give();
    expect(s.free()).toBe(true);
    expect(woke).toBe(1);
  });
});

describe("DiskGuard", () => {
  it("空きが下限を切ったら理由を返し、調べた結果はしばらく使い回す", () => {
    let free = 20 * GB;
    let now = 0;
    const g = new DiskGuard({ path: "/", minFreeGb: 15, free: () => free, now: () => now, cacheMs: 1000 });
    expect(g.low()).toBeUndefined();
    free = 5 * GB;
    expect(g.low()).toBeUndefined(); // まだ使い回している
    now = 1000;
    expect(g.low()).toMatch(/5\.0GB/);
    free = 30 * GB;
    g.recheck();
    expect(g.low()).toBeUndefined();
  });

  it("下限が 0 なら見張らない", () => {
    const g = new DiskGuard({ path: "/", minFreeGb: 0, free: () => 0 });
    expect(g.low()).toBeUndefined();
  });
});

describe("Dispatcher と見張り", () => {
  it("止める理由がある間は、チケットの仕事を始めない", async () => {
    const p = new Project(":memory:", new ManualClock());
    p.addRepo("acme/shop", "API");
    const harness = new FakeHarness(async () => undefined);
    let hold: string | undefined = "ディスクの空きが足りません";
    const d = new Dispatcher(p, { harnesses: { "claude-agent-sdk": harness }, workspace: new StaticWorkspace("/tmp/ws"), hold: () => hold });
    const t = createTicket(p, { title: "CSV の書き出し" });
    run(p.db, "UPDATE tickets SET triaged = 1 WHERE id = ?", [t.id]);
    await d.drain({ concurrency: 2, maxRuns: 1 });
    expect(harness.calls.length).toBe(0);
    hold = undefined;
    await d.drain({ concurrency: 2, maxRuns: 1 });
    expect(harness.calls.length).toBe(1);
  });

  it("枠が埋まっている間は、新しく起こさない", async () => {
    const p = new Project(":memory:", new ManualClock());
    p.addRepo("acme/shop", "API");
    const harness = new FakeHarness(async () => undefined);
    const slots = new Slots(() => 1);
    slots.take(); // 他のプロジェクトが使っている
    const d = new Dispatcher(p, { harnesses: { "claude-agent-sdk": harness }, workspace: new StaticWorkspace("/tmp/ws"), slots });
    const t = createTicket(p, { title: "CSV の書き出し" });
    run(p.db, "UPDATE tickets SET triaged = 1 WHERE id = ?", [t.id]);
    await d.drain({ concurrency: 2, maxRuns: 1 });
    expect(harness.calls.length).toBe(0);
    slots.give();
    await d.drain({ concurrency: 2, maxRuns: 1 });
    expect(harness.calls.length).toBe(1);
    expect(slots.free()).toBe(true); // 終わったら返している
  });
});

describe("sweepWorktrees", () => {
  it("終わったチケットだけ片付け、取りやめは開発の場所を残せるようにする", async () => {
    const p = new Project(":memory:", new ManualClock());
    p.addRepo("acme/shop", "API");
    const open = createTicket(p, { title: "まだ途中" });
    const done = createTicket(p, { title: "merge 済み" });
    const dropped = createTicket(p, { title: "取りやめ" });
    p.setStage(done.id, "done");
    p.setStage(dropped.id, "dropped");
    const calls: { ticketNumber: number; keepUnpushedDev: boolean }[] = [];
    const ws = { cleanup: async (req: { ticketNumber: number; keepUnpushedDev: boolean }) => (calls.push(req), [`/w/${req.ticketNumber}-qa`]) } as unknown as Workspace;
    expect(await sweepWorktrees(p, ws)).toBe(2);
    expect(calls).toEqual([
      { ticketNumber: done.number, keepUnpushedDev: false },
      { ticketNumber: dropped.number, keepUnpushedDev: true },
    ]);
    expect(calls.some((c) => c.ticketNumber === open.number)).toBe(false);
  });
});

describe("GitWorkspace.cleanup", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function git(cwd: string, ...args: string[]): string {
    return execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { encoding: "utf8" });
  }

  function setup() {
    const root = mkdtempSync(join(tmpdir(), "kuramoto-upkeep-"));
    dirs.push(root);
    const origin = join(root, "origin.git");
    execFileSync("git", ["init", "--bare", "-b", "main", origin]);
    const work = join(root, "work");
    const clone = join(work, "repos", "acme__shop");
    mkdirSync(join(work, "repos"), { recursive: true });
    execFileSync("git", ["clone", "-q", origin, clone]);
    git(clone, "commit", "-q", "--allow-empty", "-m", "init");
    git(clone, "push", "-q", "origin", "HEAD:main");
    const wt = (name: string, branch?: string) => {
      const path = join(work, "worktrees", name);
      if (branch) git(clone, "worktree", "add", "-q", "-b", branch, path, "origin/main");
      else git(clone, "worktree", "add", "-q", "--detach", path, "origin/main");
      mkdirSync(join(path, "node_modules"));
      return path;
    };
    return { work, clone, wt };
  }

  it("チケットの番号の場所だけを消し、企画の場所と別の番号は残す", async () => {
    const { work, clone, wt } = setup();
    const dev = wt("1-dev", "t1");
    const qa = wt("1-qa");
    const other = wt("10-dev", "t10");
    const plan = wt("plan-lead");
    const removed = await new GitWorkspace(work).cleanup({ ticketNumber: 1, keepUnpushedDev: false });
    expect(removed.sort()).toEqual([dev, qa].sort());
    expect(existsSync(dev) || existsSync(qa)).toBe(false);
    expect(existsSync(other) && existsSync(plan)).toBe(true);
    // 元の clone からも外れている
    expect(git(clone, "worktree", "list")).not.toContain("1-dev");
  });

  it("取りやめは、push していない開発の場所を残して node_modules だけ消す", async () => {
    const { work, wt } = setup();
    const dev = wt("2-dev", "t2");
    git(dev, "commit", "-q", "--allow-empty", "-m", "まだ push していない");
    const qa = wt("2-qa");
    const removed = await new GitWorkspace(work).cleanup({ ticketNumber: 2, keepUnpushedDev: true });
    expect(removed).toEqual([qa]);
    expect(existsSync(dev)).toBe(true);
    expect(existsSync(join(dev, "node_modules"))).toBe(false);
  });

  it("取りやめでも、push 済みで変更が無ければ開発の場所も消す", async () => {
    const { work, wt } = setup();
    const dev = wt("3-dev", "t3");
    writeFileSync(join(dev, ".gitignore"), "node_modules\n");
    git(dev, "add", ".gitignore");
    git(dev, "commit", "-q", "-m", "x");
    git(dev, "push", "-q", "origin", "t3");
    const removed = await new GitWorkspace(work).cleanup({ ticketNumber: 3, keepUnpushedDev: true });
    expect(removed).toEqual([dev]);
  });
});
