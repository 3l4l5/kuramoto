import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ManualClock } from "../clock.js";
import { get } from "../db/sqlite.js";
import { confineOptions } from "../harness/claude-agent-sdk.js";
import { FakeHarness, fixedAll, withResolutions } from "../harness/fake.js";
import { kuramotoHome } from "../hq.js";
import { Dispatcher } from "./dispatcher.js";
import { Project } from "./project.js";
import { createTicket } from "./workflow.js";
import { GitWorkspace, StaticWorkspace } from "./workspace.js";

/** 作業場所への閉じ込め(ADR-0020)。 */
describe("作業場所への閉じ込め", () => {
  it("どの起動も閉じ込める。git の本体を書けるのは開発だけ。Kuramoto のデータと認証情報は読ませない", async () => {
    const p = new Project(":memory:", new ManualClock());
    p.addRepo("acme/shop", "API");
    p.setSetting("sandbox_allowed_domains", "pkg.example.com, cdn.example.com");
    const harness = new FakeHarness(async (req, call) => {
      if (req.tools.some((t) => t.name === "submit_pr")) await call("submit_pr", { summary: "足した", responses: fixedAll(req.prompt) });
      else await call("submit_review", withResolutions(req.prompt, { verdict: "approve", findings: [] }));
    });
    const workspace = new StaticWorkspace("/tmp/ws");
    const d = new Dispatcher(p, { harnesses: { "claude-agent-sdk": harness }, workspace });
    createTicket(p, { title: "CSV の書き出し" });
    await d.drain();

    const [dev, review] = harness.calls;
    expect(dev!.confine!.writable).toContain("/tmp/ws/.git");
    expect(review!.confine!.writable).not.toContain("/tmp/ws/.git");
    // テストを動かせるように、ツールのキャッシュとローカルのソケットは開ける。mise には作業場所の設定を信用させる
    expect(review!.confine!.writable.some((w) => w.endsWith("/.npm"))).toBe(true);
    expect(review!.confine!.writable.some((w) => w.endsWith("/.local/state/mise"))).toBe(true);
    expect(review!.confine!.allowLocalSockets).toBe(true);
    expect(review!.confine!.env).toMatchObject({ MISE_TRUSTED_CONFIG_PATHS: "/tmp/ws" });
    expect(review!.confine!.hiddenEnv).toEqual(expect.arrayContaining(["SSH_AUTH_SOCK", "DOCKER_HOST"]));
    expect(review!.confine!.hidden.some((h) => h.endsWith("/.docker"))).toBe(true);
    // シェルの読み込みも作業場所に絞られるので、git の本体・ツールチェーン・git の設定を名指しで開ける。隠す場所は開けない
    expect(review!.confine!.readable).toContain("/tmp/ws/.git");
    expect(review!.confine!.readable.some((r) => r.endsWith("/.local/share/mise"))).toBe(true);
    expect(review!.confine!.readable.some((r) => r.endsWith("/.gitconfig"))).toBe(true);
    expect(review!.confine!.readable.some((r) => review!.confine!.hidden.some((h) => r === h || r.startsWith(`${h}/`)))).toBe(false);
    for (const c of [dev!, review!]) {
      expect(c.confine!.hidden.some((h) => h.endsWith(".kuramoto") || h === kuramotoHome())).toBe(true);
      expect(c.confine!.hidden.some((h) => h.endsWith("/.ssh"))).toBe(true);
      expect(c.confine!.hiddenEnv).toContain("GH_TOKEN");
      expect(c.confine!.allowedDomains).toEqual(expect.arrayContaining(["github.com", "registry.npmjs.org", "pkg.example.com", "cdn.example.com"]));
    }
    // エージェントには push も gh も使わせない。PR は Kuramoto が作る
    expect(dev!.systemPrompt).toContain("git push や gh は使いません");
    expect(review!.prompt).toContain("git diff origin/main...HEAD");
    expect(workspace.published).toMatchObject([{ repo: "acme/shop", ticketNumber: 1, branch: "kuramoto/1", base: "main", title: "CSV の書き出し" }]);
    expect(workspace.published[0]!.body).toContain("足した");
    expect(get(p.db, "SELECT number, head FROM pull_requests")).toEqual({ number: 1, head: "kuramoto/1" });
  });

  it("コミットし忘れていたら submit_pr を受けず、理由を返す。直して呼び直せば受ける", async () => {
    const p = new Project(":memory:", new ManualClock());
    p.addRepo("acme/shop", "API");
    let dirty = true;
    const replies: string[] = [];
    const harness = new FakeHarness(async (req, call) => {
      if (!req.tools.some((t) => t.name === "submit_pr")) return;
      replies.push(await call("submit_pr", { summary: "" }));
      dirty = false; // コミットした
      replies.push(await call("submit_pr", { summary: "" }));
    });
    const workspace = new StaticWorkspace("/tmp/ws", { ready: () => (dirty ? "コミットしていない変更があります" : undefined) });
    const d = new Dispatcher(p, { harnesses: { "claude-agent-sdk": harness }, workspace });
    createTicket(p, { title: "x" });
    await d.dispatchOnce();
    expect(replies[0]).toContain("コミットしていない変更");
    expect(replies[1]).toContain("受け付けました");
    expect(workspace.published).toHaveLength(1);
  });

  it("SDK には、ファイルの道具の締め出しと、抜け道の無いサンドボックスとして渡す", () => {
    const o = confineOptions("/w", { readable: ["/t"], writable: ["/g"], hidden: ["/k"], allowedDomains: ["github.com"], hiddenEnv: ["GH_TOKEN"], allowLocalSockets: true, env: { MISE_TRUSTED_CONFIG_PATHS: "/w" } });
    expect(o.env.MISE_TRUSTED_CONFIG_PATHS).toBe("/w");
    expect(o.env.PATH).toBe(process.env.PATH);
    expect(o.settings.permissions).toEqual({ blockReadsOutsideWorkingDirectories: true, blockWritesOutsideWorkingDirectories: true });
    // claude.ai のコネクタは読み込まない(関係ない指示が文脈に入らないように)
    expect(o.settings.disableClaudeAiConnectors).toBe(true);
    expect(o.sandbox).toMatchObject({
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      // 読める場所: 作業場所・名指しした場所・書ける場所(書いて読めないことが無いように)
      filesystem: { denyRead: ["/k"], allowRead: ["/w", "/t", "/g"], allowWrite: ["/w", "/g"] },
      network: { allowedDomains: ["github.com"], strictAllowlist: true, allowAllUnixSockets: true, allowLocalBinding: true },
      credentials: { envVars: [{ name: "GH_TOKEN", mode: "deny" }] },
    });
  });

  it("設定 sandbox_strict_sockets でソケットを閉じられる。sandbox_allow_write で書ける場所を足せる", async () => {
    const { confinementFor } = await import("./confine.js");
    const p = new Project(":memory:", new ManualClock());
    p.setSetting("sandbox_strict_sockets", "1");
    p.setSetting("sandbox_allow_write", "/opt/cache, relative/ignored");
    const c = confinementFor(p, { path: "/w", base: "main", gitDir: "/g" }, "qa");
    expect(c.allowLocalSockets).toBe(false);
    expect(c.writable).toContain("/opt/cache");
    expect(c.writable).not.toContain("relative/ignored");
    expect(confineOptions("/w", c).sandbox.network).not.toHaveProperty("allowAllUnixSockets");
  });

  it("作業場所(clone と worktree)は、エージェントに読ませないデータの置き場所の外に置く", async () => {
    const { workDirFor, kuramotoHome, kuramotoWorkHome } = await import("../hq.js");
    const { relative } = await import("node:path");
    const w = workDirFor(join(kuramotoHome(), "acme", "shop"));
    expect(w).toBe(join(kuramotoWorkHome(), "acme", "shop"));
    expect(relative(kuramotoHome(), w).startsWith("..")).toBe(true);
  });

  it("GitWorkspace は、コミットし忘れとコミットが無いことを見分ける", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kuramoto-ws-"));
    const git = (cwd: string, ...a: string[]) => execFileSync("git", ["-C", cwd, ...a], { encoding: "utf8" });
    execFileSync("git", ["init", "--bare", "-b", "main", join(dir, "origin.git")]);
    execFileSync("git", ["clone", join(dir, "origin.git"), join(dir, "w")], { stdio: "ignore" });
    const w = join(dir, "w");
    git(w, "config", "user.email", "t@example.com");
    git(w, "config", "user.name", "t");
    git(w, "commit", "--allow-empty", "-m", "init");
    git(w, "push", "origin", "HEAD:main");
    git(w, "fetch", "origin");
    const ws = new GitWorkspace(dir);
    expect(await ws.checkReady(w, "main")).toContain("進んだコミットがありません");
    writeFileSync(join(w, "a.txt"), "a");
    expect(await ws.checkReady(w, "main")).toContain("コミットしていない変更があります");
    git(w, "add", "a.txt");
    git(w, "commit", "-m", "a");
    expect(await ws.checkReady(w, "main")).toBeUndefined();
  });
});
