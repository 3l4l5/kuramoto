import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { DEV_DONE_STAGES, inferDevDone } from "../domain/dev-done.js";
import { backfillDevDone } from "./mysql-backfill.js";
import { migrateMysql } from "./mysql-migrate.js";
import { MYSQL_MIGRATIONS } from "./mysql-schema.js";
import { connectTest, resetDatabase } from "./mysql-test-support.js";
import { PROJECT_MIGRATIONS } from "./schema.js";
import { all, openDb } from "./sqlite.js";

/**
 * 既存のチケットの dev_done を埋める決まりが、SQLite の版 19 と MySQL(移すときの backfillDevDone)でそろうことの確認。
 * 工程 8 通り × 開発の起動の有無 × 開発以外の起動の有無。
 */
const STAGES = ["dev", "review", "sec", "qa", "decision", "merge", "done", "dropped"];
type Case = { id: number; stage: string; runs: string[] };
const CASES: Case[] = STAGES.flatMap((stage, i) => [
  { id: i * 3 + 1, stage, runs: [] },
  { id: i * 3 + 2, stage, runs: ["dev"] },
  { id: i * 3 + 3, stage, runs: ["review", "qa"] },
]);

/** 版 18 までの SQLite にチケットを入れ、版 19 を流して dev_done を読む */
function sqliteResult(): Record<number, number> {
  const db = openDb(":memory:", PROJECT_MIGRATIONS.slice(0, 18));
  db.exec(`
INSERT INTO repos (id, full_name, role) VALUES (1, 'acme/shop', 'API');
INSERT INTO formations (id, version, pull, created_at) VALUES (1, 1, 'down', '');
INSERT INTO policies (id, role, version, model, effort, focus, created_at) VALUES (1, 'dev', 1, 'm', 'high', '', '');
INSERT INTO members (id, name, look, joined_at) VALUES (1, 'a', '{}', '');
INSERT INTO messages (id, to_role, kind, available_at, created_at) VALUES (1, 'dev', 'implement', '', '');
`);
  for (const c of CASES) {
    db.prepare("INSERT INTO tickets (id, number, title, stage, created_at) VALUES (?, ?, ?, ?, '')").run(c.id, c.id, `t${c.id}`, c.stage);
    for (const role of c.runs) {
      db.prepare("INSERT INTO runs (message_id, ticket_id, member_id, role, policy_id, formation_id, started_at, ended_at) VALUES (1, ?, 1, ?, 1, 1, '', '')").run(c.id, role);
    }
  }
  const v19 = PROJECT_MIGRATIONS[18]!;
  db.exec(v19 as string);
  const out = Object.fromEntries(all<{ id: number; dev_done: number }>(db, "SELECT id, dev_done FROM tickets").map((r) => [r.id, r.dev_done]));
  (db as DatabaseSync).close();
  return out;
}

describe("dev_done を埋める決まり", () => {
  it("DEV_DONE_STAGES は SQLite の版 19 の工程の一覧と同じ", () => {
    const v19 = (PROJECT_MIGRATIONS[18] as string).match(/stage IN \(([^)]*)\)/)![1]!;
    expect(v19.split(",").map((s) => s.trim().replace(/'/g, ""))).toEqual([...DEV_DONE_STAGES]);
  });

  it("inferDevDone は SQLite の版 19 を流した結果と同じ", () => {
    const expected = sqliteResult();
    for (const c of CASES) expect(inferDevDone(c.stage, c.runs.includes("dev")) ? 1 : 0, `${c.stage} ${c.runs}`).toBe(expected[c.id]);
    // 決まりが効いている(全部 0・全部 1 ではない)
    expect(new Set(Object.values(expected))).toEqual(new Set([0, 1]));
  });
});

const conn = await connectTest();
afterAll(async () => {
  await conn?.end();
});

describe.skipIf(!conn)("MySQL に移したあとの backfillDevDone(mysql-test)", () => {
  const c = conn!;
  beforeEach(async () => {
    await resetDatabase(c);
    await migrateMysql(c, MYSQL_MIGRATIONS);
  });

  /** プロジェクトを作り、CASES のチケットと起動を入れる(dev_done は 0 のまま = 空の最初の版に流したあとの形)。チケットの id は採番される。 */
  async function seed(name: string): Promise<{ projectId: number; ids: Map<number, number> }> {
    const [p] = await c.query<any>("INSERT INTO projects (name, data_dir, status, created_at) VALUES (?, ?, 'running', '')", [name, `/d/${name}`]);
    const projectId = Number(p.insertId);
    const one = async (sql: string, params: unknown[]) => Number(((await c.query<any>(sql, params))[0] as any).insertId);
    const formation = await one("INSERT INTO formations (version, pull, created_at, project_id) VALUES (1, 'down', '', ?)", [projectId]);
    const policy = await one("INSERT INTO policies (role, version, model, effort, focus, created_at, project_id) VALUES ('dev', 1, 'm', 'high', '', '', ?)", [projectId]);
    const member = await one("INSERT INTO members (name, look, joined_at, project_id) VALUES ('a', '{}', '', ?)", [projectId]);
    const message = await one("INSERT INTO messages (to_role, kind, available_at, created_at, project_id) VALUES ('dev', 'implement', '', '', ?)", [projectId]);
    const ids = new Map<number, number>();
    for (const t of CASES) {
      const id = await one("INSERT INTO tickets (number, title, stage, created_at, project_id) VALUES (?, ?, ?, '', ?)", [t.id, `t${t.id}`, t.stage, projectId]);
      ids.set(t.id, id);
      for (const role of t.runs) {
        await c.query("INSERT INTO runs (message_id, ticket_id, member_id, role, policy_id, formation_id, started_at, ended_at, project_id) VALUES (?, ?, ?, ?, ?, ?, '', '', ?)", [message, id, member, role, policy, formation, projectId]);
      }
    }
    return { projectId, ids };
  }

  const devDone = async (projectId: number): Promise<Record<number, number>> => {
    const [rows] = await c.query<any[]>("SELECT number, dev_done FROM tickets WHERE project_id = ?", [projectId]);
    return Object.fromEntries(rows.map((r) => [Number(r.number), Number(r.dev_done)]));
  };

  it("SQLite の版 19 を流した結果と同じになる", async () => {
    const { projectId } = await seed("a");
    expect(Object.values(await devDone(projectId)).every((v) => v === 0)).toBe(true);
    const n = await backfillDevDone(c);
    const expected = sqliteResult();
    expect(await devDone(projectId)).toEqual(expected);
    expect(n).toBe(Object.values(expected).filter((v) => v === 1).length);
  });

  it("何度呼んでも同じ。すでに 1 のものは 0 に戻さない", async () => {
    const { projectId, ids } = await seed("a");
    await c.query("UPDATE tickets SET dev_done = 1 WHERE id = ?", [ids.get(1)]); // dev・起動なしのチケットを、開発を通ったことにしてある
    expect(await backfillDevDone(c)).toBeGreaterThan(0);
    const once = await devDone(projectId);
    expect(once[1]).toBe(1);
    expect(await backfillDevDone(c)).toBe(0);
    expect(await devDone(projectId)).toEqual(once);
  });

  it("projectId を渡すと、そのプロジェクトのチケットだけを埋める。起動は同じプロジェクトのものだけを見る", async () => {
    const a = await seed("a");
    const b = await seed("b");
    await backfillDevDone(c, a.projectId);
    expect(await devDone(a.projectId)).toEqual(sqliteResult());
    expect(Object.values(await devDone(b.projectId)).every((v) => v === 0)).toBe(true);
  });
});
