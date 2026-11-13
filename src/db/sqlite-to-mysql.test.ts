import type { DatabaseSync } from "node:sqlite";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { inferDevDone } from "../domain/dev-done.js";
import { migrate } from "./migrate.js";
import { migrateMysql } from "./mysql-migrate.js";
import { MYSQL_MIGRATIONS } from "./mysql-schema.js";
import { connectTest, resetDatabase } from "./mysql-test-support.js";
import { HQ_MIGRATIONS, PROJECT_ID_TABLES, PROJECT_MIGRATIONS } from "./schema.js";
import { transferSqliteToMysql, TRANSFER_TABLES } from "./sqlite-to-mysql.js";
import { all, openDb, run } from "./sqlite.js";

/**
 * SQLite → MySQL の移す道具(sqlite-to-mysql.ts)の試験。
 * 移したあとの dev_done が、SQLite の版 19 の決まりの結果とそろうこと(= 道具が backfillDevDone を呼んでいること)を確かめる。
 */
const STAGES = ["dev", "review", "sec", "qa", "decision", "merge", "done", "dropped"];
type Case = { number: number; stage: string; runs: string[] };
const CASES: Case[] = STAGES.flatMap((stage, i) => [
  { number: i * 3 + 1, stage, runs: [] },
  { number: i * 3 + 2, stage, runs: ["dev"] },
  { number: i * 3 + 3, stage, runs: ["review", "qa"] },
]);
/** 版 19 の決まりで、チケットの番号ごとの dev_done */
const EXPECTED: Record<number, number> = Object.fromEntries(CASES.map((c) => [c.number, inferDevDone(c.stage, c.runs.includes("dev")) ? 1 : 0]));

/**
 * 版 18 の SQLite にチケット・起動などを入れ、最新の版まで流す(版 19 が dev_done を埋める)。
 * resetDevDone なら、そのあとで dev_done を全部 0 に戻す(= dev_done が埋まっていない元を移す)。
 */
function projectDb(projectId: number, opts: { resetDevDone?: boolean } = {}): DatabaseSync {
  const db = openDb(":memory:", PROJECT_MIGRATIONS.slice(0, 18));
  db.exec(`
INSERT INTO repos (id, full_name, role) VALUES (1, 'acme/shop', 'API');
INSERT INTO formations (id, version, pull, created_at) VALUES (1, 1, 'down', '');
INSERT INTO policies (id, role, version, model, effort, focus, created_at) VALUES (1, 'dev', 1, 'm', 'high', '', '');
INSERT INTO members (id, name, look, joined_at) VALUES (1, 'a', '{}', '');
INSERT INTO messages (id, to_role, kind, available_at, created_at) VALUES (1, 'dev', 'implement', '', '');
`);
  let id = 0;
  for (const c of CASES) {
    id++;
    run(db, "INSERT INTO tickets (id, number, title, stage, created_at) VALUES (?, ?, ?, ?, '')", [id, c.number, `t${c.number}`, c.stage]);
    for (const role of c.runs) {
      run(db, "INSERT INTO runs (message_id, ticket_id, member_id, role, policy_id, formation_id, started_at, ended_at) VALUES (1, ?, 1, ?, 1, 1, '', '')", [id, role]);
    }
  }
  // 受信箱の payload・events の data に入っている id が、付け替えに追いつくか(チケット 1 の判断)
  db.exec(`
INSERT INTO decisions (id, ticket_id, question, options, recommended, why, impact, reversible, escalated) VALUES (1, 1, 'q', '[]', 0, '', '', 1, 0);
INSERT INTO messages (id, ticket_id, to_role, kind, payload, available_at, created_at) VALUES (2, 1, 'lead', 'decision', '{"decision_id":1,"resume":{"toMemberId":1}}', '', '');
INSERT INTO events (at, actor, type, ticket_id, data) VALUES ('', 'x', 'y', 1, '{"runId":1}');
`);
  migrate(db, PROJECT_MIGRATIONS, { projectId });
  if (opts.resetDevDone) db.exec("UPDATE tickets SET dev_done = 0");
  return db;
}

function hqDb(projectIds: number[]): DatabaseSync {
  const hq = openDb(":memory:", HQ_MIGRATIONS);
  for (const id of projectIds) {
    run(hq, "INSERT INTO projects (id, name, data_dir, status, created_at) VALUES (?, ?, ?, 'running', '')", [id, `p${id}`, `/d/p${id}`]);
  }
  return hq;
}

describe("移す表の一覧", () => {
  it("プロジェクトの全部の表を、1 回ずつ含む", () => {
    expect(TRANSFER_TABLES.map(([t]) => t).sort()).toEqual([...PROJECT_ID_TABLES].sort());
  });

  it("SQLite の外部キーは、すべて一覧の参照にあり、親が先に入る", () => {
    const db = openDb(":memory:", PROJECT_MIGRATIONS);
    const order = TRANSFER_TABLES.map(([t]) => t);
    for (const [table, refs] of TRANSFER_TABLES) {
      const fks = all<{ from: string; table: string }>(db, `PRAGMA foreign_key_list(${table})`).filter((f) => f.table !== "projects");
      expect(Object.fromEntries(fks.map((f) => [f.from, f.table])), table).toEqual(
        Object.fromEntries(Object.entries(refs).filter(([, parent]) => fks.some((f) => f.table === parent))),
      );
      for (const parent of Object.values(refs)) expect(order.indexOf(parent), `${table} → ${parent}`).toBeLessThan(order.indexOf(table));
    }
  });
});

describe("移す順序(MySQL が無くても確かめる)", () => {
  /** 流れた文を記録するだけの接続 */
  function recorder() {
    const log: { sql: string; params?: unknown[] }[] = [];
    const conn = {
      async query(sql: string, params?: unknown[]) {
        log.push({ sql, params });
        if (/^SELECT COUNT/.test(sql)) return [[{ n: 0 }], []];
        if (/^SELECT COALESCE/.test(sql)) return [[{ m: 0 }], []];
        return [{ affectedRows: 0 }, []];
      },
      async beginTransaction() {},
      async commit() {},
      async rollback() {},
    };
    return { log, conn: conn as never };
  }

  it("プロジェクトごとに、tickets と runs を入れ終えてから backfillDevDone(projectId) を呼ぶ", async () => {
    const { log, conn: fake } = recorder();
    const dbs = new Map([[3, projectDb(3)], [5, projectDb(5)]]);
    await transferSqliteToMysql(fake, hqDb([3, 5]), (p) => dbs.get(p.id)!);
    const backfills = log.flatMap((l, i) => (/^UPDATE tickets SET dev_done = 1/.test(l.sql) ? [{ i, projectId: l.params![0] }] : []));
    expect(backfills.map((b) => b.projectId)).toEqual([3, 5]);
    const inserts = (table: string) => log.flatMap((l, i) => (l.sql.startsWith(`INSERT INTO \`${table}\``) ? [i] : []));
    // 1 つ目のプロジェクトの tickets・runs は、1 つ目の backfill より前。2 つ目の backfill は 2 つ目の tickets・runs より後
    const [t1, t2] = inserts("tickets");
    const [r1, r2] = inserts("runs");
    expect(Math.max(t1!, r1!)).toBeLessThan(backfills[0]!.i);
    expect(backfills[0]!.i).toBeLessThan(Math.min(t2!, r2!));
    expect(Math.max(t2!, r2!)).toBeLessThan(backfills[1]!.i);
  });
});

const conn = await connectTest();
afterAll(async () => {
  await conn?.end();
});

describe.skipIf(!conn)("SQLite から MySQL へ移す(mysql-test)", () => {
  const c = conn!;
  beforeEach(async () => {
    await resetDatabase(c);
    await migrateMysql(c, MYSQL_MIGRATIONS);
  });

  const devDone = async (projectId: number): Promise<Record<number, number>> => {
    const [rows] = await c.query<any[]>("SELECT number, dev_done FROM tickets WHERE project_id = ?", [projectId]);
    return Object.fromEntries(rows.map((r) => [Number(r.number), Number(r.dev_done)]));
  };

  it("移したあとの dev_done は SQLite の版 19 の決まりとそろう(dev_done が 0 の元でも。プロジェクトごとに埋める)", async () => {
    const dbs = new Map([[1, projectDb(1, { resetDevDone: true })], [2, projectDb(2, { resetDevDone: true })]]);
    const result = await transferSqliteToMysql(c, hqDb([1, 2]), (p) => dbs.get(p.id)!);
    // 版 19 の決まりが効いている(全部 0・全部 1 ではない)
    expect(new Set(Object.values(EXPECTED))).toEqual(new Set([0, 1]));
    expect(await devDone(1)).toEqual(EXPECTED);
    expect(await devDone(2)).toEqual(EXPECTED);
    const ones = Object.values(EXPECTED).filter((v) => v === 1).length;
    expect(result.projects).toEqual([
      { id: 1, name: "p1", tickets: CASES.length, devDone: ones },
      { id: 2, name: "p2", tickets: CASES.length, devDone: ones },
    ]);
  });

  it("dev_done が埋まっている元は、そのまま移る(SQLite 側と同じ)", async () => {
    const src = projectDb(1);
    const sqliteSide = Object.fromEntries(all<{ number: number; dev_done: number }>(src, "SELECT number, dev_done FROM tickets").map((r) => [r.number, r.dev_done]));
    await transferSqliteToMysql(c, hqDb([1]), () => src);
    expect(await devDone(1)).toEqual(sqliteSide);
    expect(sqliteSide).toEqual(EXPECTED);
  });

  it("2 つ目のプロジェクトの id は付け替わり、参照(起動 → チケット、payload の id)はそのプロジェクトの行を指す", async () => {
    const dbs = new Map([[1, projectDb(1)], [2, projectDb(2)]]);
    await transferSqliteToMysql(c, hqDb([1, 2]), (p) => dbs.get(p.id)!);
    for (const projectId of [1, 2]) {
      const [runs] = await c.query<any[]>(
        "SELECT t.number, r.role, t.project_id AS tp, r.project_id AS rp, m.project_id AS mp FROM runs r JOIN tickets t ON t.id = r.ticket_id JOIN members m ON m.id = r.member_id WHERE r.project_id = ?",
        [projectId],
      );
      expect(runs.length).toBe(CASES.reduce((n, x) => n + x.runs.length, 0));
      for (const r of runs) expect([r.tp, r.mp]).toEqual([projectId, projectId]);
      const [dec] = await c.query<any[]>("SELECT id FROM decisions WHERE project_id = ?", [projectId]);
      const [msg] = await c.query<any[]>("SELECT payload FROM messages WHERE project_id = ? AND kind = 'decision'", [projectId]);
      const payload = typeof msg[0].payload === "string" ? JSON.parse(msg[0].payload) : msg[0].payload;
      expect(payload.decision_id).toBe(Number(dec[0].id));
    }
    const minId = async (projectId: number) => Number(((await c.query<any[]>("SELECT MIN(id) AS m FROM tickets WHERE project_id = ?", [projectId]))[0] as any[])[0].m);
    const [a, b] = [await minId(1), await minId(2)];
    expect(b).toBeGreaterThan(a);
  });

  it("移し先にプロジェクトがあるときは、何も入れずに止める", async () => {
    await c.query("INSERT INTO projects (name, data_dir, status, created_at) VALUES ('x', '/d/x', 'running', '')");
    await expect(transferSqliteToMysql(c, hqDb([1]), () => projectDb(1))).rejects.toThrow(/すでにプロジェクトが入っています/);
    const [rows] = await c.query<any[]>("SELECT COUNT(*) AS n FROM tickets");
    expect(Number(rows[0].n)).toBe(0);
  });

  it("途中で失敗したら全部巻き戻す", async () => {
    await expect(
      transferSqliteToMysql(c, hqDb([1, 2]), (p) => {
        if (p.id === 2) throw new Error("開けません");
        return projectDb(1);
      }),
    ).rejects.toThrow("開けません");
    for (const t of ["projects", "tickets", "runs"]) {
      const [rows] = await c.query<any[]>(`SELECT COUNT(*) AS n FROM ${t}`);
      expect(Number(rows[0].n), t).toBe(0);
    }
  });
});
