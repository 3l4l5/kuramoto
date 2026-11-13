import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ManualClock } from "../clock.js";
import { all, get, run } from "../db/sqlite.js";
import type { GitHub, PrStatus } from "../github/github.js";
import { autoMerge, ownerMerge } from "./merge.js";
import { refreshMergedWaits } from "./patrol.js";
import { Project } from "./project.js";
import { createTicket } from "./workflow.js";
import { GitWorkspace, StaticWorkspace } from "./workspace.js";

const REPO = "acme/shop";

/** merge 待ちで PR が 1 つあり、セッションに worktree_path が残っているチケット。 */
async function mergeWaiting(state: PrStatus["state"] = "OPEN") {
  const p = await Project.open(":memory:", new ManualClock());
  await p.addRepo(REPO, "API");
  const t = await createTicket(p, { title: "片付ける" });
  run(p.db, "UPDATE tickets SET stage = 'merge', triaged = 1 WHERE id = ?", [t.id]);
  const repoId = (await p.repos())[0]!.id;
  run(p.db, "INSERT INTO pull_requests (ticket_id, repo_id, number, head, gh_state) VALUES (?, ?, 10, 'kuramoto/1', ?)", [t.id, repoId, state]);
  const memberId = (await p.fixedMember("lead")).id;
  run(p.db, "INSERT INTO sessions (member_id, ticket_id, repo_id, harness, harness_session_id, worktree_path, branch, created_at, last_used_at) VALUES (?, ?, ?, 'h', 's', '/w/1-dev', 'kuramoto/1', '', '')", [memberId, t.id, repoId]);
  // 確認(レビュー)は済んでいる
  const msg = run(p.db, "INSERT INTO messages (ticket_id, to_role, kind, status, available_at, created_at) VALUES (?, 'review', 'review', 'done', '', '')", [t.id]).lastId;
  const runId = run(p.db, "INSERT INTO runs (message_id, ticket_id, member_id, role, policy_id, formation_id, started_at, ended_at, outcome) VALUES (?, ?, ?, 'review', 1, 1, '', '', 'ok')", [msg, t.id, memberId]).lastId;
  run(p.db, "INSERT INTO reviews (ticket_id, role, round, run_id, verdict, created_at) VALUES (?, 'review', 1, ?, 'approve', '')", [t.id, runId]);
  return { p, t };
}

function github(state: PrStatus["state"]): GitHub & { merged: number[] } {
  const merged: number[] = [];
  return {
    merged,
    prStatus: async () => ({ state, mergeable: "MERGEABLE", ci: "success" }),
    merge: async (_r, n) => void merged.push(n),
    comment: async () => "c",
  };
}

const sessionPaths = (p: Project) => all<{ worktree_path: string | null }>(p.db, "SELECT worktree_path FROM sessions").map((s) => s.worktree_path);
const failures = (p: Project) => all<{ data: string }>(p.db, "SELECT data FROM events WHERE type = 'worktree_cleanup_failed'");

describe("merge した(done になった)チケットの作業場所の片付け", () => {
  it("責任者が merge したら、そのチケットの作業場所を消し、DB の worktree_path も外す", async () => {
    const { p, t } = await mergeWaiting();
    const ws = new StaticWorkspace("/tmp/ws");
    expect(await ownerMerge(p, github("OPEN"), t.id, "owner", { workspace: ws })).toEqual({ result: "merged" });
    expect((await p.ticket(t.id)).stage).toBe("done");
    expect(ws.cleaned).toEqual([{ repo: REPO, ticketNumber: t.number }]);
    expect(sessionPaths(p)).toEqual([null]);
  });

  it("外で merge 済みで done にした道でも、同じように消す", async () => {
    const { p, t } = await mergeWaiting("MERGED");
    const ws = new StaticWorkspace("/tmp/ws");
    expect(await ownerMerge(p, github("MERGED"), t.id, "owner", { workspace: ws })).toEqual({ result: "merged" });
    expect(ws.cleaned).toEqual([{ repo: REPO, ticketNumber: t.number }]);
    expect(sessionPaths(p)).toEqual([null]);
  });

  it("見回りが外の merge を見つけて done にしたときも消す", async () => {
    const { p, t } = await mergeWaiting("OPEN");
    const ws = new StaticWorkspace("/tmp/ws");
    expect(await refreshMergedWaits(p, github("MERGED"), { workspace: ws })).toBe(1);
    expect((await p.ticket(t.id)).stage).toBe("done");
    expect(ws.cleaned).toEqual([{ repo: REPO, ticketNumber: t.number }]);
    expect(sessionPaths(p)).toEqual([null]);
  });

  it("チームの自動 merge でも消す", async () => {
    const { p, t } = await mergeWaiting();
    const ws = new StaticWorkspace("/tmp/ws");
    expect(await autoMerge(p, github("OPEN"), { workspace: ws })).toBe(1);
    expect(ws.cleaned).toEqual([{ repo: REPO, ticketNumber: t.number }]);
  });

  it("merge できなかった(まだ作業中の)チケットには触らない", async () => {
    const { p, t } = await mergeWaiting();
    const ws = new StaticWorkspace("/tmp/ws");
    const gh = github("OPEN");
    gh.prStatus = async () => ({ state: "OPEN", mergeable: "CONFLICTING", ci: "success" });
    expect(await ownerMerge(p, gh, t.id, "owner", { workspace: ws })).toMatchObject({ result: "conflict" });
    expect(ws.cleaned).toEqual([]);
    expect(sessionPaths(p)).toEqual(["/w/1-dev"]);
  });

  it("消すのに失敗しても merge は成功し、done になり、失敗は events に残る", async () => {
    const { p, t } = await mergeWaiting();
    const ws = new StaticWorkspace("/tmp/ws", { removeError: () => "ロック中" });
    expect(await ownerMerge(p, github("OPEN"), t.id, "owner", { workspace: ws })).toEqual({ result: "merged" });
    expect((await p.ticket(t.id)).stage).toBe("done");
    expect(failures(p)).toHaveLength(1);
    expect(failures(p)[0]!.data).toContain("ロック中");
    expect(sessionPaths(p)).toEqual([null]);
  });

  it("消せなかったものが返ってきたときも、merge は成功して events に残る", async () => {
    const { p, t } = await mergeWaiting();
    const ws = new StaticWorkspace("/tmp/ws");
    ws.removeTicketWorktrees = async () => ({ removed: [], failed: [{ path: "/w/1-qa", error: "busy" }] });
    expect(await ownerMerge(p, github("OPEN"), t.id, "owner", { workspace: ws })).toEqual({ result: "merged" });
    expect(failures(p)[0]!.data).toContain("/w/1-qa");
  });

  it("workspace が無い呼び出し(旧来の呼び方)でも merge できる", async () => {
    const { p, t } = await mergeWaiting();
    expect(await ownerMerge(p, github("OPEN"), t.id)).toEqual({ result: "merged" });
    expect(get(p.db, "SELECT stage FROM tickets WHERE id = ?", [t.id])).toEqual({ stage: "done" });
  });
});

describe("GitWorkspace.removeTicketWorktrees(本物の git)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" } });

  function setup() {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "kuramoto-wt-")));
    dirs.push(root);
    const clone = join(root, "repos", "acme__shop");
    mkdirSync(clone, { recursive: true });
    git(clone, "init", "-q", "-b", "main");
    git(clone, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init");
    const add = (name: string) => git(clone, "worktree", "add", "-q", "--detach", join(root, "worktrees", name));
    return { root, clone, add, ws: new GitWorkspace(root), has: (name: string) => existsSync(join(root, "worktrees", name)), listed: () => git(clone, "worktree", "list", "--porcelain") };
  }

  it("チケットの番号の worktree を全部の役割ぶん消し、git worktree list にも出なくする。ほかは残す", async () => {
    const { ws, add, has, listed, root } = setup();
    for (const n of ["61-dev", "61-review", "61-sec", "61-qa", "61-ci", "61-chat", "6-dev", "610-dev", "62-dev", "plan-lead"]) add(n);
    const r = await ws.removeTicketWorktrees("acme/shop", 61);
    expect(r.failed).toEqual([]);
    expect(r.removed.map((x) => x.slice(join(root, "worktrees").length + 1)).sort()).toEqual(["61-chat", "61-ci", "61-dev", "61-qa", "61-review", "61-sec"]);
    for (const n of ["61-dev", "61-review", "61-sec", "61-qa", "61-ci", "61-chat"]) {
      expect(has(n), n).toBe(false);
      expect(listed()).not.toContain(`/${n}\n`);
    }
    for (const n of ["6-dev", "610-dev", "62-dev", "plan-lead"]) {
      expect(has(n), n).toBe(true);
      expect(listed()).toContain(`/${n}\n`);
    }
  });

  it("コミットしていない変更が残っていても(--force)消せる", async () => {
    const { ws, add, has, root } = setup();
    add("61-dev");
    writeFileSync(join(root, "worktrees", "61-dev", "wip.txt"), "未コミット");
    expect((await ws.removeTicketWorktrees("acme/shop", 61)).failed).toEqual([]);
    expect(has("61-dev")).toBe(false);
  });

  it("ディレクトリが既に無くても(登録だけ残っていても)失敗にせず、登録を片付ける。もう一度呼んでも何も起きない", async () => {
    const { ws, add, root, listed } = setup();
    add("61-dev");
    rmSync(join(root, "worktrees", "61-dev"), { recursive: true });
    const r = await ws.removeTicketWorktrees("acme/shop", 61);
    expect(r.failed).toEqual([]);
    expect(listed()).not.toContain("61-dev");
    expect(await ws.removeTicketWorktrees("acme/shop", 61)).toEqual({ removed: [], failed: [] });
  });

  it("元の clone が無いリポジトリ・番号 0 は何もしない", async () => {
    const { ws, add, has } = setup();
    add("plan-lead");
    expect(await ws.removeTicketWorktrees("acme/none", 61)).toEqual({ removed: [], failed: [] });
    expect(await ws.removeTicketWorktrees("acme/shop", 0)).toEqual({ removed: [], failed: [] });
    expect(has("plan-lead")).toBe(true);
  });
});
