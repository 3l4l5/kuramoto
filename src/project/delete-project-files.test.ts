import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GitWorkspace } from "./workspace.js";

/** プロジェクトを消すときの作業場所の片付け(本物の git) */
describe("GitWorkspace.removeProjectFiles", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" } });

  /** 作業場所の置き場所(root)に、clone を repos 個と worktree を数個作る。root の外に「別のもの」(other)も置く。 */
  function setup(repos = ["acme__shop"]) {
    const outer = realpathSync(mkdtempSync(join(tmpdir(), "kuramoto-delws-")));
    dirs.push(outer);
    const root = join(outer, "work", "acme", "shop");
    const other = join(outer, "work", "acme", "other");
    mkdirSync(other, { recursive: true });
    writeFileSync(join(other, "keep.txt"), "別のプロジェクト");
    const clones = repos.map((r) => {
      const clone = join(root, "repos", r);
      mkdirSync(clone, { recursive: true });
      git(clone, "init", "-q", "-b", "main");
      git(clone, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init");
      return clone;
    });
    return { root, other, clones, ws: new GitWorkspace(root) };
  }

  it("worktree(未コミットの変更つきでも)と clone を消す。別のプロジェクトの作業場所は残る", async () => {
    const { root, other, clones, ws } = setup();
    git(clones[0]!, "worktree", "add", "-q", "--detach", join(root, "worktrees", "1-dev"));
    git(clones[0]!, "worktree", "add", "-q", "--detach", join(root, "worktrees", "plan-lead"));
    writeFileSync(join(root, "worktrees", "1-dev", "wip.txt"), "未コミット");
    const r = await ws.removeProjectFiles(["acme/shop"]);
    expect(r.failed).toEqual([]);
    expect(existsSync(join(root, "worktrees"))).toBe(false);
    expect(existsSync(clones[0]!)).toBe(false);
    expect(existsSync(root)).toBe(false); // 空になった置き場所も片付ける
    expect(existsSync(join(other, "keep.txt"))).toBe(true);
  });

  it("リポジトリが複数あっても全部消す。同じ名前を 2 回渡しても、clone の無いリポジトリが混ざっても止まらない", async () => {
    const { root, clones, ws } = setup(["acme__shop", "acme__web"]);
    git(clones[1]!, "worktree", "add", "-q", "--detach", join(root, "worktrees", "2-dev"));
    const r = await ws.removeProjectFiles(["acme/shop", "acme/web", "acme/web", "acme/none"]);
    expect(r.failed).toEqual([]);
    for (const c of clones) expect(existsSync(c)).toBe(false);
    expect(existsSync(join(root, "worktrees"))).toBe(false);
  });

  it("もう無いときは何もせず成功する(2 回呼んでも同じ)", async () => {
    const { ws } = setup();
    await ws.removeProjectFiles(["acme/shop"]);
    expect(await ws.removeProjectFiles(["acme/shop"])).toEqual({ removed: [], failed: [] });
  });

  it("置き場所に clone 以外のものが残っていたら、置き場所ごとは消さない", async () => {
    const { root, ws } = setup();
    writeFileSync(join(root, "memo.txt"), "残す");
    await ws.removeProjectFiles(["acme/shop"]);
    expect(existsSync(join(root, "memo.txt"))).toBe(true);
  });
});
