import { execFile } from "node:child_process";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Role } from "../domain/roles.js";

const exec = promisify(execFile);

export type WorkspaceRequest = {
  repo: string;
  ticketNumber: number;
  role: Role;
  memberName: string;
  /** 開発のブランチ。レビュー側はこのブランチを読むだけ。 */
  branch: string;
};

export type PreparedWorkspace = {
  path: string;
  /** 既定のブランチ(PR の向き先・差分の起点)。 */
  base: string;
  /** git の本体(.git)。worktree の git 操作はここを読み書きする。 */
  gitDir: string;
};

export type PublishRequest = {
  repo: string;
  ticketNumber: number;
  path: string;
  branch: string;
  base: string;
  /** PR を新しく作るときのタイトルと本文。既にあれば push するだけ。 */
  title: string;
  body: string;
};

/**
 * チケットごとの作業場所(git worktree)を割り当てる(ADR-0001)。
 * エージェントは作業場所に閉じ込めるので、push と PR を作るのは Kuramoto が外で行う(ADR-0020)。
 */
export interface Workspace {
  prepare(req: WorkspaceRequest): Promise<PreparedWorkspace>;
  /** 報告を受けてよい状態か(コミットし忘れ・コミットが無いなど)。問題があればその理由。 */
  checkReady(path: string, base: string): Promise<string | undefined>;
  /** ブランチを push し、PR が無ければ作る。 */
  publish(req: PublishRequest): Promise<{ number: number; head: string }>;
}

/**
 * 作業場所の置き場所(~/.kuramoto-work/<owner>/<repo>/)の下に、元の clone と worktree を置く。
 * データの置き場所(DB)とは分ける(ADR-0020。データの置き場所はエージェントに丸ごと読ませない)。
 * - 開発: worktrees/<番号>-dev に、チケットのブランチで作る(持ち主が直すときも同じ場所)
 * - それ以外: worktrees/<番号>-<役割> に、ブランチを読むだけの detached で作る
 */
export class GitWorkspace implements Workspace {
  constructor(private readonly workDir: string) {}

  async prepare(req: WorkspaceRequest): Promise<PreparedWorkspace> {
    const base = this.clonePath(req.repo);
    const path = await this.preparePath(req);
    return { path, base: await defaultBranch(base), gitDir: realpathSync(join(base, ".git")) };
  }

  private clonePath(repo: string): string {
    return join(this.workDir, "repos", repo.replace("/", "__"));
  }

  private async preparePath(req: WorkspaceRequest): Promise<string> {
    // 企画の担当は、既定のブランチを読むだけの場所で動く
    const base = this.clonePath(req.repo);
    if (!existsSync(base)) {
      mkdirSync(join(this.workDir, "repos"), { recursive: true });
      await exec("gh", ["repo", "clone", req.repo, base]);
    }
    await git(base, "fetch", "origin", "--prune");
    const path = join(this.workDir, "worktrees", req.ticketNumber === 0 ? `plan-${req.role}` : `${req.ticketNumber}-${req.role === "dev" ? "dev" : req.role}`);
    if (existsSync(path)) {
      if (req.role !== "dev" && req.branch) await this.checkoutBranch(path, req.branch);
      else if (!req.branch) await git(path, "checkout", "--detach", `origin/${await defaultBranch(base)}`);
      return realpathSync(path);
    }
    if (req.role === "dev") {
      const remoteHasBranch = await git(base, "ls-remote", "--heads", "origin", req.branch).then((o) => o.trim() !== "");
      const start = remoteHasBranch ? `origin/${req.branch}` : `origin/${await defaultBranch(base)}`;
      await git(base, "worktree", "add", "-B", req.branch, path, start);
    } else {
      await git(base, "worktree", "add", "--detach", path, `origin/${await defaultBranch(base)}`);
      if (req.branch) await this.checkoutBranch(path, req.branch);
    }
    return realpathSync(path);
  }

  async checkReady(path: string, base: string): Promise<string | undefined> {
    const dirty = (await git(path, "status", "--porcelain")).trim();
    if (dirty) return `コミットしていない変更があります。コミットしてから呼び直してください:\n${dirty.split("\n").slice(0, 20).join("\n")}`;
    const ahead = Number((await git(path, "rev-list", "--count", `origin/${base}..HEAD`)).trim());
    if (!ahead) return `origin/${base} から進んだコミットがありません。変更をコミットしてから呼び直してください。`;
    return undefined;
  }

  async publish(req: PublishRequest): Promise<{ number: number; head: string }> {
    // 衝突を解くときに rebase してもよいように、自分が最後に見た状態からなら上書きを許す
    await git(req.path, "push", "--force-with-lease", "origin", `HEAD:refs/heads/${req.branch}`);
    const { stdout: open } = await exec("gh", ["pr", "list", "--repo", req.repo, "--head", req.branch, "--state", "open", "--json", "number"]);
    const existing = (JSON.parse(open) as { number: number }[])[0];
    if (existing) return { number: existing.number, head: req.branch };
    const { stdout } = await exec("gh", ["pr", "create", "--repo", req.repo, "--head", req.branch, "--base", req.base, "--title", req.title, "--body", req.body], { cwd: req.path });
    const m = stdout.match(/\/pull\/(\d+)/);
    if (!m) throw new Error(`PR の番号が分かりませんでした: ${stdout.trim()}`);
    return { number: Number(m[1]), head: req.branch };
  }

  /** ブランチがまだ push されていなければ(開発が push 前に判断を上げたときなど)、既定のブランチのままにする。 */
  private async checkoutBranch(path: string, branch: string): Promise<void> {
    const fetched = await git(path, "fetch", "origin", branch).then(
      () => true,
      () => false,
    );
    if (fetched) await git(path, "checkout", "--detach", "FETCH_HEAD");
  }
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec("git", ["-C", cwd, ...args]);
  return stdout;
}

async function defaultBranch(base: string): Promise<string> {
  const ref = await git(base, "symbolic-ref", "--short", "refs/remotes/origin/HEAD").catch(() => "origin/main");
  return ref.trim().replace(/^origin\//, "");
}

/** テストや動作確認用。決まった場所を返すだけ。PR の番号は、決めなければチケットの番号にする。 */
export class StaticWorkspace implements Workspace {
  readonly published: PublishRequest[] = [];
  constructor(
    private readonly path: string,
    private readonly opts: { prNumber?: (req: PublishRequest) => number; ready?: (path: string) => string | undefined } = {},
  ) {}
  async prepare(): Promise<PreparedWorkspace> {
    return { path: this.path, base: "main", gitDir: join(this.path, ".git") };
  }
  async checkReady(path: string): Promise<string | undefined> {
    return this.opts.ready?.(path);
  }
  private readonly prs = new Map<string, number>();
  async publish(req: PublishRequest): Promise<{ number: number; head: string }> {
    this.published.push(req);
    // 本物と同じく、同じブランチの PR が既にあればそれを使う
    const key = `${req.repo}#${req.branch}`;
    const number = this.prs.get(key) ?? this.opts.prNumber?.(req) ?? req.ticketNumber;
    this.prs.set(key, number);
    return { number, head: req.branch };
  }
}
