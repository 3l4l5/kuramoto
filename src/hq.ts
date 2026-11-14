import { existsSync, readdirSync, rmdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { iso, systemClock, type Clock } from "./clock.js";
import { openDb, type Db } from "./db/sqlite.js";
import { HqDb } from "./db/conn.js";
import type { MysqlHandle } from "./db/mysql.js";
import { deleteProjectRows } from "./db/delete-project.js";
import { HQ_MIGRATIONS } from "./db/schema.js";
import { isRepoFullName } from "./domain/repo-name.js";
import { Project } from "./project/project.js";
import { pendingOwnerDecisions } from "./project/workflow.js";

/** Kuramoto 本体(画面と API)が待ち受けるポート。KURAMOTO_PORT で変えられる(既定 4300)。閉じ込めの中からは届かせない(ADR-0059)。 */
export function kuramotoPort(): number {
  return Number(process.env.KURAMOTO_PORT ?? 4300);
}

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

/** 本部 DB の既定のワークスペース(id=1。版 2 が入れる)。 */
export const DEFAULT_WORKSPACE_ID = 1;

/**
 * いまのワークスペース。server / cli の入口で 1 回だけこれで決め、本部(Hq)へ渡す(ADR-0039)。
 * 今は常に既定の 1 つ。複数のワークスペースを選べるようになったら、ここで決める。
 */
export function currentWorkspaceId(): number {
  return DEFAULT_WORKSPACE_ID;
}

/** 本部(ADR-0004)。プロジェクトを作り、全プロジェクトを見渡す。本部の表はいまのワークスペース(workspace_id)の行だけを見る。 */
export class Hq {
  private readonly sqlite: Db | undefined;
  /** スコープつきの口(いまのワークスペースの行だけを見る・書く) */
  readonly hqdb: HqDb;

  /**
   * mysql を渡すと、本部もプロジェクトも、その MySQL(startDatabase が開いたもの)の上で動く(ADR-0041)。
   * 渡さなければ、home の hq.sqlite と各プロジェクトの project.sqlite(SQLite)。
   * mysql のプールは、開いた側(startDatabase の close())が閉じる。Hq.close() は閉じない。
   */
  constructor(
    readonly home: string = kuramotoHome(),
    readonly clock: Clock = systemClock,
    readonly workspaceId: number = currentWorkspaceId(),
    private readonly mysql?: MysqlHandle,
  ) {
    if (mysql) {
      this.hqdb = new HqDb(mysql.kysely, workspaceId);
    } else {
      this.sqlite = openDb(join(home, "hq.sqlite"), HQ_MIGRATIONS);
      this.hqdb = new HqDb(this.sqlite, workspaceId);
    }
  }

  /** SQLite の本部 DB(試験が直に見るため)。MySQL のときは使えない。 */
  get db(): Db {
    if (!this.sqlite) throw new Error("本部の DB は MySQL です(SQLite の接続はありません)");
    return this.sqlite;
  }

  close(): void {
    this.sqlite?.close();
  }

  /**
   * プロジェクトを作る。データは最初のリポジトリの名前で ~/.kuramoto/<owner>/<repo>/ に置く。
   * リポジトリはプロジェクトの DB だけに書く(正はプロジェクトの repos。本部の repos には書かない)。
   */
  async createProject(name: string, repos: RepoInput[]): Promise<ProjectRecord> {
    if (!name.trim()) throw new Error("名前がありません");
    if (repos.length === 0) throw new Error("リポジトリを 1 つ以上登録してください");
    for (const r of repos) if (!isRepoFullName(r.fullName)) throw new Error(`owner/repo の形ではありません: ${r.fullName}`);
    const [owner, repo] = repos[0]!.fullName.split("/") as [string, string];
    // 同じリポジトリから 2 つ目のプロジェクトを作る(設計書から復元するなど)ときは、置き場所を分ける
    let dataDir = join(this.home, owner, repo);
    for (let n = 2; (await this.hqdb.from("projects").select("id").where("data_dir", "=", dataDir).executeTakeFirst()) || existsSync(dataDir); n++) dataDir = join(this.home, owner, `${repo}-${n}`);
    const id = await this.hqdb.dialect.insertedId(this.hqdb.insert("projects", { name, data_dir: dataDir, status: "planning", created_at: iso(this.clock.now()) }));
    const p = await this.openProject(id);
    await p.setSetting("project_name", name);
    for (const r of repos) await p.addRepo(r.fullName, r.role);
    p.close();
    return this.project(id);
  }

  async projects(): Promise<ProjectRecord[]> {
    return (await this.hqdb.from("projects").where("status", "<>", "archived").orderBy("id").execute()) as ProjectRecord[];
  }

  /** いまのワークスペースの中のプロジェクトを返す。ワークスペースの外(または無い)id は投げる。 */
  async project(id: number): Promise<ProjectRecord> {
    const p = await this.hqdb.from("projects").where("id", "=", id).executeTakeFirst();
    if (!p) throw new Error(`プロジェクト ${id} がありません`);
    return p as ProjectRecord;
  }

  /** プロジェクトの DB を開く。id がいまのワークスペースの中にあることを、開く前に確かめる。 */
  async openProject(id: number): Promise<Project> {
    return await Project.open(join((await this.project(id)).data_dir, "project.sqlite"), this.clock, id, this.mysql);
  }

  /**
   * プロジェクトの名前とリポジトリを変える。足す・外す・役割を変えるを、渡された一覧との差で行う。
   * データの置き場所(最初のリポジトリの名前)は変えない。リポジトリはプロジェクトの DB だけに書く。
   */
  async updateProject(p: Project, id: number, input: { name: string; repos: RepoInput[] }): Promise<ProjectRecord> {
    const name = input.name.trim();
    if (!name) throw new Error("名前がありません");
    if (input.repos.length === 0) throw new Error("リポジトリを 1 つ以上登録してください");
    for (const r of input.repos) if (!isRepoFullName(r.fullName)) throw new Error(`owner/repo の形ではありません: ${r.fullName}`);
    if (new Set(input.repos.map((r) => r.fullName)).size !== input.repos.length) throw new Error("同じリポジトリが 2 回入っています");
    await this.project(id); // ワークスペースの外のプロジェクトは変えない
    const before = await p.repos();
    const wanted = new Map(input.repos.map((r) => [r.fullName, r.role]));
    // 外すものを先に確かめる(外せないものがあれば、何も変えずに止める)
    await p.pdb.transaction(async () => {
      for (const r of before) if (!wanted.has(r.full_name)) await p.removeRepo(r.full_name);
      for (const [fullName, role] of wanted) {
        if (before.some((r) => r.full_name === fullName)) await p.setRepoRole(fullName, role);
        else await p.addRepo(fullName, role);
      }
      await p.setSetting("project_name", name);
    });
    await this.hqdb.update("projects", { name }).where("id", "=", id).execute();
    await p.event("owner", "project_updated", null, { name, repos: input.repos.map((r) => r.fullName) });
    return this.project(id);
  }

  /**
   * プロジェクトを消す: プロジェクトの DB の行(project_id が id のもの。別のプロジェクトの行は触らない)と、本部の記録(repos・projects)。
   * 先に p を開いて渡す。ファイルと GitHub には触れない(それは呼ぶ側)。
   */
  async deleteProject(p: Project, id: number): Promise<void> {
    await this.project(id); // ワークスペースの外のプロジェクトは消さない
    await deleteProjectRows(p.pdb);
    await this.hqdb.transaction(async () => {
      // 本部の repos は project_id で結ぶ(workspace_id は持たない)。projects の行より先に消す
      await (this.hqdb.k as import("kysely").Kysely<any>).deleteFrom("repos").where("project_id", "=", id).execute();
      await this.hqdb.deleteFrom("projects").where("id", "=", id).execute();
    });
  }

  /**
   * プロジェクトのデータの置き場所(SQLite と design/ の画像)を丸ごと消す。呼ぶ前に、そのプロジェクトの SQLite を閉じておく。
   * 本部の置き場所(home)の外・home そのものは、何があっても消さない。owner の下が空になったら、その owner のディレクトリも片付ける。
   * 消せなかったときは投げる(呼ぶ側がログに残す)。
   */
  removeDataDir(dataDir: string): void {
    const home = resolve(this.home);
    const dir = resolve(dataDir);
    if (home === sep || !dir.startsWith(home + sep)) throw new Error(`データの置き場所が本部の置き場所の外なので消しません: ${dataDir}`);
    rmSync(dir, { recursive: true, force: true });
    const owner = dirname(dir);
    if (owner !== home && existsSync(owner) && readdirSync(owner).length === 0) rmdirSync(owner);
  }

  async setStatus(id: number, status: ProjectRecord["status"]): Promise<void> {
    await this.hqdb.update("projects", { status }).where("id", "=", id).execute();
  }

  /** 全プロジェクトの「あなたの対応」。数字は本部に写さず、各プロジェクトの DB を読みに行く。 */
  async ownerQueue(): Promise<{ project: ProjectRecord; decisions: number; merges: number }[]> {
    const out = [];
    for (const rec of await this.projects()) {
      const p = await this.openProject(rec.id);
      try {
        out.push({
          project: rec,
          decisions: (await pendingOwnerDecisions(p)).length,
          merges: (await p.tickets()).filter((t) => t.stage === "merge").length,
        });
      } finally {
        p.close();
      }
    }
    return out;
  }
}
