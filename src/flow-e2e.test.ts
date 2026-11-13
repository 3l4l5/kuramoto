import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Connection } from "mysql2/promise";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { ManualClock } from "./clock.js";
import type { KuramotoConfig } from "./config.js";
import { DbHealth } from "./db/mysql-health.js";
import { connectTest, MYSQL_TEST_URL, resetDatabase } from "./db/mysql-test-support.js";
import { startDatabase, type StartedDatabase } from "./db/startup.js";
import type { GitHub } from "./github/github.js";
import { FakeHarness, fixedAll, withResolutions } from "./harness/fake.js";
import { currentWorkspaceId, Hq } from "./hq.js";
import { Project } from "./project/project.js";
import { refreshMergedWaits } from "./project/patrol.js";
import { StaticWorkspace } from "./project/workspace.js";
import { KuramotoServer } from "./server.js";

/**
 * 流れ全体の e2e(ADR-0041): チケット → 起動(フェイクの担当) → merge 待ち → merge。本部もプロジェクトも、DB の上で動く。
 *  - SQLite の回(常に流れる)と MySQL の回(mysql-test に繋がるときだけ。npm test の MySQL の回では繋がらなければ落ちる)を、同じ試験で流す。
 *  - MySQL の回は、startDatabase(起動と同じ入口)で繋ぎ、Hq にその口を渡す。
 *  - あわせて、merge したチケットの作業場所の片付け(sessions.worktree_path を外す。#61)も、MySQL で確かめる。
 */
const admin: Connection | undefined = await connectTest();
afterAll(async () => {
  await admin?.end();
});

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const f of cleanups.splice(0).reverse()) await f();
});

type Kind = "sqlite" | "mysql";

/** その DB の上で本部を開く。reset なら、MySQL の database の中を空にしてから(SQLite は新しい home)。 */
async function openHq(kind: Kind, home: string, opts: { reset?: boolean } = {}): Promise<{ hq: Hq; db: StartedDatabase; health: DbHealth }> {
  if (kind === "sqlite") {
    const hq = new Hq(home, new ManualClock(), currentWorkspaceId());
    const health = new DbHealth(async () => {}, { intervalMs: 3_600_000 });
    return { hq, db: { async close() {} }, health };
  }
  if (opts.reset) await resetDatabase(admin!);
  const config: KuramotoConfig = { file: undefined, database: { type: "mysql", url: MYSQL_TEST_URL }, databaseUrlFromEnv: false };
  const db = await startDatabase(config, () => {}, home);
  return { hq: new Hq(home, new ManualClock(), currentWorkspaceId(), db.mysql), db, health: db.health! };
}

function fakeGithub() {
  const github = {
    merged: [] as number[],
    state: "OPEN" as "OPEN" | "MERGED",
    openPulls: async () => [],
    openIssues: async () => [],
    prStatus: async () => ({ state: github.state, mergeable: "MERGEABLE" as const, ci: "success" as const }),
    merge: async (_r: string, n: number) => void github.merged.push(n),
    comment: async () => "",
  };
  return github;
}

async function boot(kind: Kind) {
  const home = mkdtempSync(join(tmpdir(), "kuramoto-flow-"));
  writeFileSync(join(home, "index.html"), "<!doctype html><title>Kuramoto</title>");
  const { hq, db, health } = await openHq(kind, home, { reset: true });
  const harness = new FakeHarness(async (req, call) => {
    if (req.tools.some((t) => t.name === "submit_pr")) await call("submit_pr", { summary: "", responses: fixedAll(req.prompt) });
    else if (req.tools.some((t) => t.name === "submit_review")) await call("submit_review", withResolutions(req.prompt, { verdict: "approve", findings: [] }));
    else return { finalText: "企画担当の咲季です。" };
  });
  const github = fakeGithub();
  const ws = new StaticWorkspace(home, { prNumber: () => 5 });
  const app = new KuramotoServer({ hq, webDir: home, harnesses: { "claude-agent-sdk": harness }, github: github as unknown as GitHub, workspaceFor: () => ws, dbHealth: health });
  const server: Server = createServer((req, res) => void app.handle(req, res));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  cleanups.push(async () => {
    app.close();
    await new Promise((r) => server.close(r));
    hq.close();
    await db.close();
    rmSync(home, { recursive: true, force: true });
  });
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`http://localhost:${port}${path}`, { method, headers: { "content-type": "application/json", "x-kuramoto": "1" }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, json: (await res.json().catch(() => null)) as any };
  };
  return { app, call, github, ws, health, home };
}

/** プロジェクトを作り、チケットを 1 枚足して、始業し、merge 待ちになるまで待つ。 */
async function toMergeWait(kind: Kind) {
  const b = await boot(kind);
  const { json: created } = await b.call("POST", "/api/projects", { name: "お試し", repos: [{ fullName: "acme/shop", role: "API" }] });
  const projectId = created.id as number;
  const { json: ticket } = await b.call("POST", `/api/projects/${projectId}/tickets`, { title: "CSV の書き出し" });
  expect(ticket).toBeTruthy();
  await b.call("POST", `/api/projects/${projectId}/run`, { running: true });
  for (let i = 0; i < 400 && (await b.app.projectView(projectId)).mergeOrder.length === 0; i++) await new Promise((r) => setTimeout(r, 25));
  const ticketId = (await b.app.projectView(projectId)).mergeOrder[0]!;
  expect(ticketId).toBeTruthy();
  const p = b.app.project(projectId);
  // 作業場所のパスは本番のコードでは書かれない(この版では起動の記録だけ)ので、片付けの確かめ用に入れる
  await p.pdb.update("sessions", { worktree_path: "/w/1-dev" }).where("ticket_id", "=", ticketId).execute();
  return { ...b, projectId, ticketId, p };
}

const worktreePaths = async (p: Awaited<ReturnType<typeof toMergeWait>>["p"]) => (await p.pdb.from("sessions").execute()).map((s) => s.worktree_path);

describe("MySQL の口を渡して開く(接続は要らない確かめ)", () => {
  it("Hq は、MySQL の口を渡されたら hq.sqlite を作らず、SQLite の接続も持たない", () => {
    const home = mkdtempSync(join(tmpdir(), "kuramoto-hq-mysql-"));
    cleanups.push(() => rmSync(home, { recursive: true, force: true }));
    const hq = new Hq(home, new ManualClock(), currentWorkspaceId(), { kysely: {} } as never);
    expect(existsSync(join(home, "hq.sqlite"))).toBe(false);
    expect(() => hq.db).toThrow(/MySQL/);
    expect(() => hq.close()).not.toThrow();
  });

  it("Project は、MySQL ではプロジェクトの id が無いと開かない(project_id の行を決められないため)", async () => {
    await expect(Project.open("/ない/project.sqlite", new ManualClock(), undefined, { kysely: {} } as never)).rejects.toThrow(/id が要ります/);
    expect(existsSync("/ない")).toBe(false);
  });
});

for (const kind of ["sqlite", "mysql"] as const) {
  describe.skipIf(kind === "mysql" && !admin)(`流れ全体(${kind})`, () => {
    it("チケット → 起動 → merge 待ち → merge: 担当が動き(開発・確認)、merge で done になり、作業場所の片付けが DB に反映される", async () => {
      const { app, call, github, ws, p, projectId, ticketId } = await toMergeWait(kind);
      expect((await p.ticket(ticketId)).stage).toBe("merge");
      expect((await p.pdb.from("runs").where("ticket_id", "=", ticketId).orderBy("id").execute()).map((r) => r.role)).toEqual(["dev", "review"]);
      const hq = (await call("GET", "/api/hq")).json;
      expect(hq.queue).toMatchObject([{ kind: "merge", projectName: "お試し" }]);
      expect(hq.projects[0]).toMatchObject({ running: true, merges: 1 });
      expect(await worktreePaths(p)).not.toContain(null);

      expect((await call("POST", `/api/projects/${projectId}/merge/${ticketId}`)).json).toEqual({ result: "merged" });
      expect(github.merged).toEqual([5]);
      expect((await p.ticket(ticketId)).stage).toBe("done");
      expect(ws.cleaned.map((c) => c.repo)).toEqual(["acme/shop"]);
      expect(await worktreePaths(p)).toEqual(expect.arrayContaining([null]));
      expect((await worktreePaths(p)).every((w) => w === null)).toBe(true);
      expect((await app.hq.project(projectId)).status).toBe("running");
    });

    it("見回りが外の merge を見つけて done にしたときも、作業場所を片付けて worktree_path を外す", async () => {
      const { github, ws, p, ticketId } = await toMergeWait(kind);
      github.state = "MERGED";
      await p.setSetting("patrol_pr_check_at", ""); // 始業の見回りがもう 1 回確かめているので、間隔の制限を外す
      expect(await refreshMergedWaits(p, github as unknown as GitHub, { workspace: ws })).toBe(1);
      expect((await p.ticket(ticketId)).stage).toBe("done");
      expect(ws.cleaned.map((c) => c.repo)).toEqual(["acme/shop"]);
      expect((await worktreePaths(p)).every((w) => w === null)).toBe(true);
    });

    it("DB が切れたら画面に出て(/api/db)、繋がり直したら消える", async () => {
      const { call, health, projectId } = await toMergeWait(kind);
      expect((await call("GET", "/api/db")).json).toEqual({ dbDown: null });
      health.reportFailure(Object.assign(new Error("connect ECONNRESET"), { code: "ECONNRESET" }));
      const down = (await call("GET", "/api/db")).json.dbDown;
      expect(down).toMatchObject({ error: "connect ECONNRESET" });
      expect((await call("GET", `/api/projects/${projectId}`)).json.dbDown).toMatchObject({ error: "connect ECONNRESET" });
      await health.check(); // ping が通る(MySQL は実際に SELECT 1)
      expect((await call("GET", "/api/db")).json).toEqual({ dbDown: null });
      expect((await call("GET", `/api/projects/${projectId}`)).json.dbDown).toBeNull();
    });

    it("起動し直しても(本部と DB を開き直しても)、プロジェクト・チケット・起動の記録が残っている", async () => {
      const { app, home, p, projectId, ticketId } = await toMergeWait(kind);
      const runsBefore = (await p.pdb.from("runs").execute()).length;
      const { hq, db } = await openHq(kind, home);
      cleanups.push(async () => {
        hq.close();
        await db.close();
      });
      expect((await hq.projects()).map((r) => r.id)).toEqual([projectId]);
      const reopened = await hq.openProject(projectId);
      expect((await reopened.ticket(ticketId)).stage).toBe("merge");
      expect((await reopened.pdb.from("runs").execute()).length).toBe(runsBefore);
      reopened.close();
      expect(app.hq.workspaceId).toBe(hq.workspaceId);
    });
  });
}
