import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";
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
  publish(req: PublishRequest): Promise<{ number: number; head: string; sha?: string }>;
  /**
   * since(前に承認されたコミット)から後の、このブランチ自身の変更(main から取り込んだものと merge コミットを除く)のコミット数。
   * since が見つからなければ null。
   */
  ownCommits(path: string, base: string, since: string): Promise<number | null>;
  /**
   * 「このチケットの変更はすでに main に入っている」が本当か。commit が origin/<base> に入っていて、
   * 作業場所のブランチに main に無い変更が残っていなければ undefined。違えばその理由。
   */
  landed(path: string, base: string, commit: string): Promise<string | undefined>;
  /** 要らなくなった PR を、理由のコメントをつけて閉じる。 */
  closePr(repo: string, number: number, comment: string): Promise<void>;
  /** GitHub に入れるか(gh の認証・git の取得)。入れなければそのエラー。 */
  checkGithub?(repo: string): Promise<string | undefined>;
  /**
   * チームの CI(ADR-0028)の場所を用意する。チケットのブランチ(push 済みのもの)を取り出し、最新の main を合わせる。
   * 合わせられなければ conflict にその理由を入れる。
   */
  prepareCheck?(req: { repo: string; ticketNumber: number; branch: string }): Promise<CheckWorkspace>;
  /** origin の既定のブランチの今のコミット(merge の直前に、チームの CI を流し直すかを決める)。 */
  baseSha?(repo: string): Promise<string>;
  /** 画面の試作を作業場所に置く(ADR-0033)。git には入れない(info/exclude に足す)。 */
  writeDesign?(path: string, gitDir: string, files: { file: string; data: string | Buffer }[]): Promise<void>;
  /**
   * 終わったチケットの作業場所(worktrees/<番号>-<役割>)を消し、消した場所を返す。
   * keepUnpushedDev のときは、開発の作業場所に push していないコミットか、コミットしていない変更があれば残す(node_modules だけ消す)。
   */
  cleanup?(req: { ticketNumber: number; keepUnpushedDev: boolean }): Promise<string[]>;
}

export type CheckWorkspace = PreparedWorkspace & { sha: string; baseSha: string; conflict?: string };

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

  /** 元の clone を用意して、origin を取得し直す。 */
  private async ensureClone(repo: string): Promise<string> {
    const base = this.clonePath(repo);
    if (!existsSync(base)) {
      mkdirSync(join(this.workDir, "repos"), { recursive: true });
      await exec("gh", ["repo", "clone", repo, base]);
    }
    await git(base, "fetch", "origin", "--prune");
    return base;
  }

  private async preparePath(req: WorkspaceRequest): Promise<string> {
    // 企画の担当は、既定のブランチを読むだけの場所で動く
    const base = await this.ensureClone(req.repo);
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

  async ownCommits(path: string, base: string, since: string): Promise<number | null> {
    const ok = await git(path, "rev-parse", "--verify", "--quiet", `${since}^{commit}`).then(
      () => true,
      () => false,
    );
    if (!ok) return null;
    return Number((await git(path, "rev-list", "--count", "--no-merges", `${since}..HEAD`, `^origin/${base}`)).trim());
  }

  async publish(req: PublishRequest): Promise<{ number: number; head: string; sha?: string }> {
    const sha = (await git(req.path, "rev-parse", "HEAD")).trim();
    // 衝突を解くときに rebase してもよいように、自分が最後に見た状態からなら上書きを許す
    await git(req.path, "push", "--force-with-lease", "origin", `HEAD:refs/heads/${req.branch}`);
    const { stdout: open } = await exec("gh", ["pr", "list", "--repo", req.repo, "--head", req.branch, "--state", "open", "--json", "number"]);
    const existing = (JSON.parse(open) as { number: number }[])[0];
    if (existing) return { number: existing.number, head: req.branch, sha };
    const { stdout } = await exec("gh", ["pr", "create", "--repo", req.repo, "--head", req.branch, "--base", req.base, "--title", req.title, "--body", req.body], { cwd: req.path });
    const m = stdout.match(/\/pull\/(\d+)/);
    if (!m) throw new Error(`PR の番号が分かりませんでした: ${stdout.trim()}`);
    return { number: Number(m[1]), head: req.branch, sha };
  }

  async landed(path: string, base: string, commit: string): Promise<string | undefined> {
    await git(path, "fetch", "origin", base).catch(() => undefined);
    const sha = await git(path, "rev-parse", "--verify", "--quiet", `${commit}^{commit}`).then(
      (s) => s.trim(),
      () => "",
    );
    if (!sha) return `コミット ${commit} が見つかりません。git log origin/${base} で、このチケットの変更が入ったコミットを確かめてください。`;
    const onBase = await git(path, "merge-base", "--is-ancestor", sha, `origin/${base}`).then(
      () => true,
      () => false,
    );
    if (!onBase) return `コミット ${commit} は origin/${base} に入っていません。main に入っていないなら、作業を続けて submit_pr で報告してください。`;
    // ブランチに main に無い変更(同じ中身のコミットが main に無いもの)が残っていれば、まだ PR にすべき変更がある
    const rest = (await git(path, "cherry", `origin/${base}`, "HEAD").catch(() => ""))
      .split("\n")
      .filter((l) => l.startsWith("+"));
    if (rest.length) return `このブランチには origin/${base} に無いコミットが ${rest.length} 件あります。その変更が要るなら submit_pr で報告し、要らないなら取り消してから呼び直してください。`;
    return undefined;
  }

  async closePr(repo: string, number: number, comment: string): Promise<void> {
    await exec("gh", ["pr", "close", String(number), "--repo", repo, "--comment", comment]);
  }

  async prepareCheck(req: { repo: string; ticketNumber: number; branch: string }): Promise<CheckWorkspace> {
    const clone = await this.ensureClone(req.repo);
    const base = await defaultBranch(clone);
    const path = join(this.workDir, "worktrees", `${req.ticketNumber}-ci`);
    if (!existsSync(path)) await git(clone, "worktree", "add", "--detach", path, `origin/${base}`);
    await git(path, "fetch", "origin", req.branch, base);
    await git(path, "checkout", "--detach", "--force", `origin/${req.branch}`);
    // 前に流したときの生成物は消す。入れたパッケージ(node_modules)は残して、入れ直しを速くする
    await git(path, "clean", "-fdx", "-e", "node_modules");
    const sha = (await git(path, "rev-parse", "HEAD")).trim();
    const baseSha = (await git(path, "rev-parse", `origin/${base}`)).trim();
    const merged = await git(path, "-c", "user.name=Kuramoto", "-c", "user.email=kuramoto@localhost", "merge", "--no-edit", "--no-ff", `origin/${base}`).then(
      () => undefined,
      async (e: { stdout?: string; stderr?: string; message?: string }) => {
        await git(path, "merge", "--abort").catch(() => undefined);
        return `main(${baseSha.slice(0, 7)})と合わせると衝突します: ${(e.stdout || e.stderr || e.message || "").trim().slice(0, 500)}`;
      },
    );
    return { path: realpathSync(path), base, gitDir: realpathSync(join(clone, ".git")), sha, baseSha, ...(merged ? { conflict: merged } : {}) };
  }

  async writeDesign(path: string, gitDir: string, files: { file: string; data: string | Buffer }[]): Promise<void> {
    for (const f of files) {
      const to = join(path, f.file);
      mkdirSync(dirname(to), { recursive: true });
      writeFileSync(to, f.data);
    }
    // 試作はコミットしない。worktree は元の clone の info/exclude を共有する
    const exclude = join(gitDir, "info", "exclude");
    const cur = existsSync(exclude) ? readFileSync(exclude, "utf8") : "";
    if (!cur.split("\n").includes(".kuramoto/")) {
      mkdirSync(dirname(exclude), { recursive: true });
      writeFileSync(exclude, `${cur}${cur && !cur.endsWith("\n") ? "\n" : ""}.kuramoto/\n`);
    }
  }

  async cleanup(req: { ticketNumber: number; keepUnpushedDev: boolean }): Promise<string[]> {
    const dir = join(this.workDir, "worktrees");
    if (!existsSync(dir)) return [];
    const prefix = `${req.ticketNumber}-`;
    const removed: string[] = [];
    for (const name of readdirSync(dir)) {
      // 企画の担当の場所(plan-<役割>)は、チケットを持たないので消さない
      if (!name.startsWith(prefix) || !/^[a-z]+$/.test(name.slice(prefix.length))) continue;
      const path = join(dir, name);
      if (req.keepUnpushedDev && name === `${prefix}dev` && !(await pushedAndClean(path))) {
        await rm(join(path, "node_modules"), { recursive: true, force: true });
        continue;
      }
      await rm(path, { recursive: true, force: true });
      removed.push(path);
    }
    // 消した worktree の記録を、元の clone から外す
    if (removed.length) {
      const repos = join(this.workDir, "repos");
      for (const r of existsSync(repos) ? readdirSync(repos) : []) await git(join(repos, r), "worktree", "prune").catch(() => undefined);
    }
    return removed;
  }

  async baseSha(repo: string): Promise<string> {
    const clone = this.clonePath(repo);
    const base = await defaultBranch(clone);
    const out = await git(clone, "ls-remote", "origin", `refs/heads/${base}`);
    return out.split(/\s/)[0] ?? "";
  }

  async checkGithub(repo: string): Promise<string | undefined> {
    try {
      await exec("gh", ["api", `repos/${repo}`, "--silent"]);
      const base = this.clonePath(repo);
      if (existsSync(base)) await git(base, "ls-remote", "--heads", "origin");
      return undefined;
    } catch (e) {
      const err = e as { stderr?: string; message?: string };
      return (err.stderr || err.message || String(e)).trim();
    }
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

/** コミットしていない変更が無く、すべてのコミットが origin のどこかのブランチに入っているか。調べられなければ false(残す)。 */
async function pushedAndClean(path: string): Promise<boolean> {
  try {
    if ((await git(path, "status", "--porcelain")).trim()) return false;
    return Number((await git(path, "rev-list", "--count", "HEAD", "--not", "--remotes=origin")).trim()) === 0;
  } catch {
    return false;
  }
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
    private readonly opts: { prNumber?: (req: PublishRequest) => number; ready?: (path: string) => string | undefined; landed?: (commit: string) => string | undefined; ownCommits?: (since: string) => number | null; publishError?: () => string | undefined; github?: () => string | undefined; baseSha?: () => string } = {},
  ) {}
  /** テスト用: チームの CI の場所は、決まった場所に PR のコミット(sha-<push の回数>)と main を合わせたものとする。 */
  async prepareCheck(): Promise<CheckWorkspace> {
    return { path: this.path, base: "main", gitDir: join(this.path, ".git"), sha: `sha-${this.published.length}`, baseSha: this.opts.baseSha?.() ?? "main-1" };
  }
  async baseSha(): Promise<string> {
    return this.opts.baseSha?.() ?? "main-1";
  }
  async checkGithub(): Promise<string | undefined> {
    return this.opts.github?.();
  }
  /** テスト用: 置いた試作を覚えるだけ。 */
  readonly designs: { file: string; data: string | Buffer }[] = [];
  async writeDesign(_path: string, _gitDir: string, files: { file: string; data: string | Buffer }[]): Promise<void> {
    this.designs.push(...files);
  }
  async prepare(): Promise<PreparedWorkspace> {
    return { path: this.path, base: "main", gitDir: join(this.path, ".git") };
  }
  async checkReady(path: string): Promise<string | undefined> {
    return this.opts.ready?.(path);
  }
  readonly closed: { repo: string; number: number; comment: string }[] = [];
  async ownCommits(_path: string, _base: string, since: string): Promise<number | null> {
    return this.opts.ownCommits ? this.opts.ownCommits(since) : 1;
  }
  async landed(_path: string, _base: string, commit: string): Promise<string | undefined> {
    return this.opts.landed ? this.opts.landed(commit) : undefined;
  }
  async closePr(repo: string, number: number, comment: string): Promise<void> {
    this.closed.push({ repo, number, comment });
  }
  private readonly prs = new Map<string, number>();
  async publish(req: PublishRequest): Promise<{ number: number; head: string; sha?: string }> {
    const err = this.opts.publishError?.();
    if (err) throw new Error(err);
    this.published.push(req);
    // 本物と同じく、同じブランチの PR が既にあればそれを使う
    const key = `${req.repo}#${req.branch}`;
    const number = this.prs.get(key) ?? this.opts.prNumber?.(req) ?? req.ticketNumber;
    this.prs.set(key, number);
    return { number, head: req.branch, sha: `sha-${this.published.length}` };
  }
}
