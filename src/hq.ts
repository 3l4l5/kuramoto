import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { iso, systemClock, type Clock } from "./clock.js";
import { all, get, openDb, run, tx, type Db } from "./db/sqlite.js";
import { HQ_MIGRATIONS } from "./db/schema.js";
import { Project } from "./project/project.js";
import { pendingOwnerDecisions } from "./project/workflow.js";

/** データの置き場所。作業場のリポジトリの外(ADR-0004)。KURAMOTO_HOME で変えられる。 */
export function kuramotoHome(): string {
  return process.env.KURAMOTO_HOME ?? join(homedir(), ".kuramoto");
}

/**
 * エージェントが作業する場所(clone と worktree)の置き場所。KURAMOTO_WORK_HOME で変えられる。
 * データの置き場所(DB)とは分ける。エージェントのシェルにはデータの置き場所を丸ごと読ませないため(ADR-0020)、
 * その中に作業場所を置くと、作業場所まで読めなくなる(サンドボックスは読ませない場所の中を開け直せない)。
 */
export function kuramotoWorkHome(): string {
  return process.env.KURAMOTO_WORK_HOME ?? join(homedir(), ".kuramoto-work");
}

/** プロジェクトのデータの置き場所に対応する、作業場所の置き場所(~/.kuramoto/acme/shop → ~/.kuramoto-work/acme/shop)。 */
export function workDirFor(dataDir: string): string {
  const rel = relative(kuramotoHome(), dataDir);
  // データの置き場所が既定の外にあるときは、そのパスを作業場所の置き場所の下にそのまま写す
  return join(kuramotoWorkHome(), rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : dataDir.replace(/^\/+/, ""));
}

export type ProjectRecord = { id: number; name: string; data_dir: string; status: string; created_at: string };
export type RepoInput = { fullName: string; role: string };

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** 本部(ADR-0004)。プロジェクトを作り、リポジトリを登録し、全プロジェクトを見渡す。 */
export class Hq {
  readonly db: Db;

  constructor(
    readonly home: string = kuramotoHome(),
    readonly clock: Clock = systemClock,
  ) {
    this.db = openDb(join(home, "hq.sqlite"), HQ_MIGRATIONS);
  }

  close(): void {
    this.db.close();
  }

  /** プロジェクトを作る。データは最初のリポジトリの名前で ~/.kuramoto/<owner>/<repo>/ に置く。 */
  createProject(name: string, repos: RepoInput[]): ProjectRecord {
    if (!name.trim()) throw new Error("名前がありません");
    if (repos.length === 0) throw new Error("リポジトリを 1 つ以上登録してください");
    for (const r of repos) if (!REPO_RE.test(r.fullName)) throw new Error(`owner/repo の形ではありません: ${r.fullName}`);
    const [owner, repo] = repos[0]!.fullName.split("/") as [string, string];
    // 同じリポジトリから 2 つ目のプロジェクトを作る(設計書から復元するなど)ときは、置き場所を分ける
    let dataDir = join(this.home, owner, repo);
    for (let n = 2; get(this.db, "SELECT 1 AS x FROM projects WHERE data_dir = ?", [dataDir]) || existsSync(dataDir); n++) dataDir = join(this.home, owner, `${repo}-${n}`);
    const id = tx(this.db, () => {
      const pid = run(this.db, "INSERT INTO projects (name, data_dir, status, created_at) VALUES (?, ?, 'planning', ?)", [name, dataDir, iso(this.clock.now())]).lastId;
      for (const r of repos) run(this.db, "INSERT INTO repos (project_id, full_name, role) VALUES (?, ?, ?)", [pid, r.fullName, r.role]);
      return pid;
    });
    const p = this.openProject(id);
    p.setSetting("project_name", name);
    for (const r of repos) p.addRepo(r.fullName, r.role);
    p.close();
    return this.project(id);
  }

  projects(): ProjectRecord[] {
    return all(this.db, "SELECT * FROM projects WHERE status <> 'archived' ORDER BY id");
  }

  project(id: number): ProjectRecord {
    const p = get<ProjectRecord>(this.db, "SELECT * FROM projects WHERE id = ?", [id]);
    if (!p) throw new Error(`プロジェクト ${id} がありません`);
    return p;
  }

  openProject(id: number): Project {
    return new Project(join(this.project(id).data_dir, "project.sqlite"), this.clock, id);
  }

  /**
   * プロジェクトの名前とリポジトリを変える。足す・外す・役割を変えるを、渡された一覧との差で行う。
   * データの置き場所(最初のリポジトリの名前)は変えない。
   */
  updateProject(p: Project, id: number, input: { name: string; repos: RepoInput[] }): ProjectRecord {
    const name = input.name.trim();
    if (!name) throw new Error("名前がありません");
    if (input.repos.length === 0) throw new Error("リポジトリを 1 つ以上登録してください");
    for (const r of input.repos) if (!REPO_RE.test(r.fullName)) throw new Error(`owner/repo の形ではありません: ${r.fullName}`);
    if (new Set(input.repos.map((r) => r.fullName)).size !== input.repos.length) throw new Error("同じリポジトリが 2 回入っています");
    const before = p.repos();
    const wanted = new Map(input.repos.map((r) => [r.fullName, r.role]));
    // 外すものを先に確かめる(外せないものがあれば、何も変えずに止める)
    tx(p.db, () => {
      for (const r of before) if (!wanted.has(r.full_name)) p.removeRepo(r.full_name);
      for (const [fullName, role] of wanted) {
        if (before.some((r) => r.full_name === fullName)) p.setRepoRole(fullName, role);
        else p.addRepo(fullName, role);
      }
      p.setSetting("project_name", name);
    });
    tx(this.db, () => {
      run(this.db, "UPDATE projects SET name = ? WHERE id = ?", [name, id]);
      run(this.db, "DELETE FROM repos WHERE project_id = ?", [id]);
      for (const r of input.repos) run(this.db, "INSERT INTO repos (project_id, full_name, role) VALUES (?, ?, ?)", [id, r.fullName, r.role]);
    });
    p.event("owner", "project_updated", null, { name, repos: input.repos.map((r) => r.fullName) });
    return this.project(id);
  }

  setStatus(id: number, status: ProjectRecord["status"]): void {
    run(this.db, "UPDATE projects SET status = ? WHERE id = ?", [status, id]);
  }

  /** 全プロジェクトの「あなたの対応」。数字は本部に写さず、各プロジェクトの DB を読みに行く。 */
  ownerQueue(): { project: ProjectRecord; decisions: number; merges: number }[] {
    return this.projects().map((rec) => {
      const p = this.openProject(rec.id);
      try {
        return {
          project: rec,
          decisions: pendingOwnerDecisions(p).length,
          merges: p.tickets().filter((t) => t.stage === "merge").length,
        };
      } finally {
        p.close();
      }
    });
  }
}
