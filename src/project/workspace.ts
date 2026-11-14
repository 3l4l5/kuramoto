import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { Role } from "../domain/roles.js";
import { branchNameError } from "./team-branch.js";

const exec = promisify(execFile);

export type WorkspaceRequest = {
  repo: string;
  ticketNumber: number;
  role: Role;
  memberName: string;
  /** チームが使うブランチ(プロジェクトの設定)。空なら origin/HEAD(無ければ main)。作業の起点と PR の向き先になる。 */
  base?: string;
  /** 開発のブランチ。レビュー側はこのブランチを読むだけ。空なら既定のブランチ(終わったチケットの話をするときなど。ブランチは消えていてもよい)。 */
  branch: string;
};

export type PreparedWorkspace = {
  path: string;
  /** チームが使うブランチ(PR の向き先・差分の起点)。設定が無ければ既定のブランチ。 */
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
  /** 開発ルールで確かめる、このブランチの変更(コミットの 1 行目・変更したファイル・足した行)。 */
  changes?(path: string, base: string): Promise<import("./dev-rules.js").RuleChanges>;
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
  prepareCheck?(req: { repo: string; ticketNumber: number; branch: string; base?: string }): Promise<CheckWorkspace>;
  /** origin のチームが使うブランチ(base。無ければ既定のブランチ)の今のコミット(merge の直前に、チームの CI を流し直すかを決める)。 */
  baseSha?(repo: string, base?: string): Promise<string>;
  /** origin にそのブランチがあるか(設定で指定されたブランチの確かめ)。確かめられなければ投げる。 */
  branchExists?(repo: string, branch: string): Promise<boolean>;
  /** リポジトリの既定のブランチ(origin/HEAD。無ければ main)。 */
  defaultBranchOf?(repo: string): Promise<string>;
  /** 既定のブランチの先頭から branch を作って origin に push する。作った元の既定のブランチを返す。作れなければ(権限・名前など)理由つきで投げる。 */
  createBranch?(repo: string, branch: string): Promise<string>;
  /**
   * 終わったチケット(merge 済み)の作業場所を、すべての役割(開発・レビュー・QA・CI など)ぶん消す。
   * チケットの番号に結びついた worktrees/<番号>-* だけが対象で、リーダー用の plan-<役割> や、ほかのチケットのものには触らない。
   * 1 つ消せなくても止まらず、消せたものと消せなかったもの(理由つき)を返す。
   */
  removeTicketWorktrees?(repo: string, ticketNumber: number): Promise<{ removed: string[]; failed: { path: string; error: string }[] }>;
  /**
   * プロジェクトを消すとき、そのプロジェクトの作業場所を丸ごと消す: すべての worktree(git worktree remove)と、Kuramoto が clone したリポジトリの作業ディレクトリ。
   * GitHub 上のものには触れない。1 つ消せなくても止まらず、消せたものと消せなかったもの(理由つき)を返す。
   */
  removeProjectFiles?(repos: string[]): Promise<{ removed: string[]; failed: { path: string; error: string }[] }>;
  /** 画面の試作を作業場所に置く(ADR-0033)。git には入れない(info/exclude に足す)。 */
  writeDesign?(path: string, gitDir: string, files: { file: string; data: string | Buffer }[]): Promise<void>;
}

export type CheckWorkspace = PreparedWorkspace & { sha: string; baseSha: string; conflict?: string };

/**
 * 作業場所の置き場所(~/.kuramoto-work/<owner>/<repo>/)の下に、元の clone と worktree を置く。
 * データの置き場所(DB)とは分ける(ADR-0020。データの置き場所はエージェントに丸ごと読ませない)。
 * - 開発: worktrees/<番号>-dev に、チケットのブランチで作る(持ち主が直すときも同じ場所)
 * - それ以外: worktrees/<番号>-<役割> に、ブランチを読むだけの detached で作る
 * - ブランチなし(終わったチケットの会話など): 役割によらず worktrees/<番号>-chat に、既定のブランチを読むだけの detached で作る
 */
export class GitWorkspace implements Workspace {
  constructor(private readonly workDir: string) {}

  async prepare(req: WorkspaceRequest): Promise<PreparedWorkspace> {
    const base = this.clonePath(req.repo);
    const path = await this.preparePath(req);
    return { path, base: await baseBranch(base, req.base), gitDir: realpathSync(join(base, ".git")) };
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
    // ブランチを使わない(終わったチケットの会話など)ときは、どの役割でも専用の読むだけの場所(<番号>-chat)を使う。
    // 開発の作業場所(<番号>-dev)には触らない: 取り下げを戻したときに、前の作業がそのまま残っていなければならない
    const name = req.ticketNumber === 0 ? `plan-${req.role}` : req.branch ? `${req.ticketNumber}-${req.role === "dev" ? "dev" : req.role}` : `${req.ticketNumber}-chat`;
    const path = join(this.workDir, "worktrees", name);
    if (existsSync(path)) {
      if (req.role !== "dev" && req.branch) await this.checkoutBranch(path, req.branch);
      // 読むだけの場所なので、前の起動の残りがあっても捨てて既定のブランチに合わせる
      else if (!req.branch) await git(path, "checkout", "--detach", "--force", `origin/${await baseBranch(base, req.base)}`);
      return realpathSync(path);
    }
    if (!req.branch) {
      await git(base, "worktree", "add", "--detach", path, `origin/${await baseBranch(base, req.base)}`);
    } else if (req.role === "dev") {
      const remoteHasBranch = await git(base, "ls-remote", "--heads", "origin", req.branch).then((o) => o.trim() !== "");
      const start = remoteHasBranch ? `origin/${req.branch}` : `origin/${await baseBranch(base, req.base)}`;
      await git(base, "worktree", "add", "-B", req.branch, path, start);
    } else {
      await git(base, "worktree", "add", "--detach", path, `origin/${await baseBranch(base, req.base)}`);
      await this.checkoutBranch(path, req.branch);
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

  async changes(path: string, base: string): Promise<{ commits: string[]; files: string[]; code: string }> {
    const lines = (s: string) => s.split("\n").filter(Boolean);
    const commits = lines(await git(path, "log", "--no-merges", "--format=%s", `origin/${base}..HEAD`));
    const files = lines(await git(path, "diff", "--name-only", `origin/${base}...HEAD`));
    const diff = await git(path, "diff", "-U0", `origin/${base}...HEAD`).catch(() => "");
    const code = diff.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++")).map((l) => l.slice(1)).join("\n");
    return { commits, files, code: code.slice(0, 200_000) };
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
    if (!onBase) return `コミット ${commit} は origin/${base} に入っていません。origin/${base} に入っていないなら、作業を続けて submit_pr で報告してください。`;
    // ブランチに origin/${base} に無い変更(同じ中身のコミットが無いもの)が残っていれば、まだ PR にすべき変更がある
    const rest = (await git(path, "cherry", `origin/${base}`, "HEAD").catch(() => ""))
      .split("\n")
      .filter((l) => l.startsWith("+"));
    if (rest.length) return `このブランチには origin/${base} に無いコミットが ${rest.length} 件あります。その変更が要るなら submit_pr で報告し、要らないなら取り消してから呼び直してください。`;
    return undefined;
  }

  async closePr(repo: string, number: number, comment: string): Promise<void> {
    await exec("gh", ["pr", "close", String(number), "--repo", repo, "--comment", comment]);
  }

  async prepareCheck(req: { repo: string; ticketNumber: number; branch: string; base?: string }): Promise<CheckWorkspace> {
    const clone = await this.ensureClone(req.repo);
    const base = await baseBranch(clone, req.base);
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
        return `${base}(${baseSha.slice(0, 7)})と合わせると衝突します: ${(e.stdout || e.stderr || e.message || "").trim().slice(0, 500)}`;
      },
    );
    return { path: realpathSync(path), base, gitDir: realpathSync(join(clone, ".git")), sha, baseSha, ...(merged ? { conflict: merged } : {}) };
  }

  async removeTicketWorktrees(repo: string, ticketNumber: number): Promise<{ removed: string[]; failed: { path: string; error: string }[] }> {
    const removed: string[] = [];
    const failed: { path: string; error: string }[] = [];
    const clone = this.clonePath(repo);
    if (!existsSync(clone) || !Number.isInteger(ticketNumber) || ticketNumber <= 0) return { removed, failed };
    // git は realpath で覚えている(macOS の /var → /private/var など)ので、そろえて比べる
    const dir = resolve(this.workDir, "worktrees");
    const root = existsSync(dir) ? realpathSync(dir) : dir;
    // 「<番号>-」で始まる名前だけ(61 の片付けで 6 や 610 のものに触れないよう、番号のあとのハイフンまで合わせる)
    const mine = (path: string) => dirname(resolve(path)) === root && basename(path).startsWith(`${ticketNumber}-`);
    // git が覚えているもの(ディレクトリが既に無くても出てくる)と、ディスクに残っているもの(登録が外れたもの)の両方
    const paths = new Set<string>();
    const listed = await git(clone, "worktree", "list", "--porcelain").catch((e: unknown) => {
      failed.push({ path: clone, error: errorText(e) });
      return "";
    });
    for (const line of listed.split("\n")) if (line.startsWith("worktree ")) paths.add(line.slice("worktree ".length).trim());
    if (existsSync(root)) for (const name of readdirSync(root)) paths.add(join(root, name));
    for (const path of paths) {
      if (!mine(path)) continue;
      try {
        await git(clone, "worktree", "remove", "--force", path).catch(() => undefined);
        // 登録が無い・remove で消えなかった残りは、中身ごと消す(上で「worktrees の直下の <番号>-*」と確かめてある)
        if (existsSync(path)) rmSync(path, { recursive: true, force: true });
        removed.push(path);
      } catch (e) {
        failed.push({ path, error: errorText(e) });
      }
    }
    await git(clone, "worktree", "prune").catch((e: unknown) => {
      failed.push({ path: clone, error: errorText(e) });
    });
    return { removed, failed };
  }

  async removeProjectFiles(repos: string[]): Promise<{ removed: string[]; failed: { path: string; error: string }[] }> {
    const removed: string[] = [];
    const failed: { path: string; error: string }[] = [];
    const work = resolve(this.workDir);
    // 作業場所の置き場所の外は、何があっても消さない(置き場所が空・ルートなら何もしない)
    const inside = (path: string) => work !== sep && work !== "" && resolve(path).startsWith(work + sep);
    const wtDir = join(work, "worktrees");
    const dropPath = (path: string) => {
      if (!inside(path) || !existsSync(path)) return;
      try {
        rmSync(path, { recursive: true, force: true });
        removed.push(path);
      } catch (e) {
        failed.push({ path, error: errorText(e) });
      }
    };
    // clone ごとに、git が覚えている worktree を外す(clone 自体を消す前に。ディスクに残ったものは次の rmSync が消す)
    for (const repo of new Set(repos)) {
      const clone = this.clonePath(repo);
      if (!existsSync(clone)) continue;
      const listed = await git(clone, "worktree", "list", "--porcelain").catch((e: unknown) => {
        failed.push({ path: clone, error: errorText(e) });
        return "";
      });
      for (const line of listed.split("\n")) {
        if (!line.startsWith("worktree ")) continue;
        const path = line.slice("worktree ".length).trim();
        // 元の clone 自身(1 行目)は外せない。worktrees の下のものだけ
        if (resolve(path) === resolve(clone) || !inside(path)) continue;
        await git(clone, "worktree", "remove", "--force", path).catch(() => undefined);
      }
    }
    dropPath(wtDir);
    for (const repo of new Set(repos)) dropPath(this.clonePath(repo));
    // 空になった repos/ と作業場所の置き場所も片付ける(中身が残っていれば消さない)
    for (const dir of [join(work, "repos"), work]) {
      try {
        if (existsSync(dir) && readdirSync(dir).length === 0) rmdirSync(dir);
      } catch {
        // 空でも消せなかっただけなら、残してよい
      }
    }
    return { removed, failed };
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

  async baseSha(repo: string, configured?: string): Promise<string> {
    const clone = this.clonePath(repo);
    const base = await baseBranch(clone, configured);
    const out = await git(clone, "ls-remote", "origin", `refs/heads/${base}`);
    return out.split(/\s/)[0] ?? "";
  }

  async branchExists(repo: string, branch: string): Promise<boolean> {
    const clone = await this.ensureClone(repo);
    return (await git(clone, "ls-remote", "--heads", "origin", `refs/heads/${branch}`)).trim() !== "";
  }

  async defaultBranchOf(repo: string): Promise<string> {
    return defaultBranch(await this.ensureClone(repo));
  }

  async createBranch(repo: string, branch: string): Promise<string> {
    const bad = branchNameError(branch);
    if (bad) throw new Error(bad);
    try {
      const clone = await this.ensureClone(repo);
      // git 自身の決まりでも確かめる(refs/heads/ を付けた形)
      await git(clone, "check-ref-format", `refs/heads/${branch}`).catch(() => {
        throw new Error(`ブランチ名として使えません: ${branch}`);
      });
      if (await this.branchExists(repo, branch)) throw new Error(`${repo} には、ブランチ「${branch}」がもうあります`);
      const from = await defaultBranch(clone);
      await git(clone, "push", "origin", `refs/remotes/origin/${from}:refs/heads/${branch}`);
      return from;
    } catch (e) {
      throw new Error(`${repo} にブランチ「${branch}」を作れませんでした: ${errorText(e)}`);
    }
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

function errorText(e: unknown): string {
  const err = e as { stderr?: string; message?: string };
  return (err.stderr || err.message || String(e)).trim().slice(0, 300);
}

/** 設定されたブランチがあればそれ、無ければ origin/HEAD(無ければ main)。 */
async function baseBranch(clone: string, configured?: string): Promise<string> {
  return configured?.trim() || (await defaultBranch(clone));
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
    private readonly opts: { prNumber?: (req: PublishRequest) => number; ready?: (path: string) => string | undefined; landed?: (commit: string) => string | undefined; ownCommits?: (since: string) => number | null; publishError?: () => string | undefined; github?: () => string | undefined; baseSha?: () => string; changes?: () => { commits?: string[]; files?: string[]; code?: string }; removeError?: () => string | undefined; branches?: string[]; defaultBranch?: string; createBranchError?: () => string | undefined } = {},
  ) {
    this.branches = opts.branches ? [...opts.branches] : undefined;
  }
  /** テスト用: prepareCheck に渡された base。 */
  readonly checks: { base?: string }[] = [];
  /** テスト用: baseSha・prepare に渡された base(呼ばれた順)。 */
  readonly baseShaCalls: (string | undefined)[] = [];
  /** テスト用: origin にあるブランチ(決めなければ何でもある。createBranch で増える)。 */
  private branches: string[] | undefined;
  /** テスト用: branchExists で確かめたもの・createBranch で作ったもの(作った元の既定のブランチつき)。 */
  readonly checkedBranches: { repo: string; branch: string }[] = [];
  readonly createdBranches: { repo: string; branch: string; from: string }[] = [];
  async branchExists(repo: string, branch: string): Promise<boolean> {
    this.checkedBranches.push({ repo, branch });
    return !this.branches || this.branches.includes(branch);
  }
  async defaultBranchOf(): Promise<string> {
    return this.opts.defaultBranch ?? "main";
  }
  async createBranch(repo: string, branch: string): Promise<string> {
    const err = this.opts.createBranchError?.();
    if (err) throw new Error(`${repo} にブランチ「${branch}」を作れませんでした: ${err}`);
    const from = this.opts.defaultBranch ?? "main";
    this.createdBranches.push({ repo, branch, from });
    if (this.branches) this.branches.push(branch);
    return from;
  }
  /** テスト用: チームの CI の場所は、決まった場所に PR のコミット(sha-<push の回数>)と main を合わせたものとする。 */
  async prepareCheck(req?: { base?: string }): Promise<CheckWorkspace> {
    this.checks.push({ base: req?.base });
    return { path: this.path, base: req?.base || "main", gitDir: join(this.path, ".git"), sha: `sha-${this.published.length}`, baseSha: this.opts.baseSha?.() ?? "main-1" };
  }
  async baseSha(_repo?: string, base?: string): Promise<string> {
    this.baseShaCalls.push(base);
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
  /** テスト用: prepare に渡されたリクエスト(呼ばれた順)。 */
  readonly prepared: WorkspaceRequest[] = [];
  async prepare(req?: WorkspaceRequest): Promise<PreparedWorkspace> {
    if (req) this.prepared.push(req);
    return { path: this.path, base: req?.base || "main", gitDir: join(this.path, ".git") };
  }
  /** テスト用: 決めた変更を返す(決めなければ空)。 */
  async changes(): Promise<{ commits: string[]; files: string[]; code: string }> {
    const c = this.opts.changes?.() ?? {};
    return { commits: c.commits ?? [], files: c.files ?? [], code: c.code ?? "" };
  }
  async checkReady(path: string): Promise<string | undefined> {
    return this.opts.ready?.(path);
  }
  readonly closed: { repo: string; number: number; comment: string }[] = [];
  /** テスト用: 片付けを頼まれたチケット。removeError があれば、消せなかったことにする。 */
  readonly cleaned: { repo: string; ticketNumber: number }[] = [];
  /** removeProjectFiles に渡されたリポジトリの一覧(呼ばれた順) */
  readonly removedProjects: string[][] = [];
  async removeProjectFiles(repos: string[]): Promise<{ removed: string[]; failed: { path: string; error: string }[] }> {
    this.removedProjects.push(repos);
    return { removed: [], failed: [] };
  }
  async removeTicketWorktrees(repo: string, ticketNumber: number): Promise<{ removed: string[]; failed: { path: string; error: string }[] }> {
    this.cleaned.push({ repo, ticketNumber });
    const error = this.opts.removeError?.();
    if (error) throw new Error(error);
    return { removed: [`${ticketNumber}-dev`], failed: [] };
  }
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
