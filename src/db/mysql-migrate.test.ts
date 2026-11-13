import { DatabaseSync } from "node:sqlite";
import { createConnection, type Connection } from "mysql2/promise";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { migrateMysql, mysqlVersion } from "./mysql-migrate.js";
import { MYSQL_MIGRATIONS, type MysqlMigration } from "./mysql-schema.js";
import { HQ_MIGRATIONS, PROJECT_MIGRATIONS } from "./schema.js";
import { all, openDb } from "./sqlite.js";

/**
 * 空の MySQL(compose.yaml の mysql-test。127.0.0.1:3307)に流す試験。
 * 接続先は KURAMOTO_MYSQL_TEST_URL で変えられる。繋がらないときは飛ばす(docker compose up -d mysql-test で立てる)。
 */
const URL_ = process.env.KURAMOTO_MYSQL_TEST_URL ?? "mysql://kuramoto_test:kuramoto-test@127.0.0.1:3307/kuramoto_test";

async function connect(): Promise<Connection | undefined> {
  try {
    return await createConnection({ uri: URL_, connectTimeout: 2000 });
  } catch {
    return undefined;
  }
}

const conn = await connect();
afterAll(async () => {
  await conn?.end();
});

/** database の中を空にする(外部キーを外してから全部の表を消す) */
async function reset(c: Connection): Promise<void> {
  const [rows] = await c.query<any[]>("SELECT table_name AS n FROM information_schema.tables WHERE table_schema = DATABASE()");
  await c.query("SET FOREIGN_KEY_CHECKS = 0");
  for (const r of rows) await c.query(`DROP TABLE IF EXISTS \`${r.n}\``);
  await c.query("SET FOREIGN_KEY_CHECKS = 1");
}

const tableNames = async (c: Connection) =>
  (await c.query<any[]>("SELECT table_name AS n FROM information_schema.tables WHERE table_schema = DATABASE() ORDER BY table_name"))[0].map((r) => r.n as string);
const columnNames = async (c: Connection, t: string) =>
  (await c.query<any[]>("SELECT column_name AS n FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? ORDER BY ordinal_position", [t]))[0].map((r) => r.n as string);
const versions = async (c: Connection) => (await c.query<any[]>("SELECT version FROM schema_version ORDER BY version"))[0].map((r) => Number(r.version));
/** 表・列・索引・外部キーの全部(流し直しで変わらないことの確認に使う) */
const shape = async (c: Connection) => ({
  columns: (await c.query<any[]>("SELECT table_name, column_name, column_type, is_nullable, column_default, extra, generation_expression FROM information_schema.columns WHERE table_schema = DATABASE() ORDER BY table_name, ordinal_position"))[0],
  indexes: (await c.query<any[]>("SELECT table_name, index_name, seq_in_index, column_name, non_unique FROM information_schema.statistics WHERE table_schema = DATABASE() ORDER BY table_name, index_name, seq_in_index"))[0],
  fks: (await c.query<any[]>("SELECT table_name, constraint_name, column_name, referenced_table_name, referenced_column_name FROM information_schema.key_column_usage WHERE table_schema = DATABASE() AND referenced_table_name IS NOT NULL ORDER BY table_name, constraint_name"))[0],
});

/** SQLite の本部 + プロジェクトの全マイグレーションを流した結果の、表ごとの列の名前 */
function sqliteColumns(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const add = (db: DatabaseSync) => {
    for (const { name } of all<{ name: string }>(db, "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")) {
      const cols = all<{ name: string }>(db, `PRAGMA table_info(${name})`).map((c) => c.name);
      out.set(name, [...new Set([...(out.get(name) ?? []), ...cols])]);
    }
  };
  add(openDb(":memory:", HQ_MIGRATIONS));
  add(openDb(":memory:", PROJECT_MIGRATIONS));
  return out;
}

describe("MySQL の最初の版", () => {
  it("版の番号は SQLite のプロジェクト DB の最新と同じ", () => {
    expect(MYSQL_MIGRATIONS.at(-1)!.version).toBe(PROJECT_MIGRATIONS.length);
    expect(MYSQL_MIGRATIONS.map((m) => m.version)).toEqual([...MYSQL_MIGRATIONS.map((m) => m.version)].sort((a, b) => a - b));
  });
});

describe.skipIf(!conn)("MySQL(mysql-test)に流す", () => {
  const c = conn!;
  beforeEach(() => reset(c));

  it("空の database に流すと、SQLite と同じ表・列が全部でき、版が SQLite と同じ番号になる", async () => {
    await migrateMysql(c, MYSQL_MIGRATIONS);
    expect(await versions(c)).toEqual([PROJECT_MIGRATIONS.length]);
    expect(await mysqlVersion(c)).toBe(21);

    const expected = sqliteColumns();
    expect(await tableNames(c)).toEqual([...expected.keys(), "schema_version"].sort());
    for (const [table, cols] of expected) {
      const mysql = await columnNames(c, table);
      // 生成列 active_ticket_id は MySQL だけ(SQLite の部分索引 one_run_per_ticket の代わり)
      const extra = table === "runs" ? ["active_ticket_id"] : [];
      expect([...mysql].sort(), table).toEqual([...cols, ...extra].sort());
    }
  });

  it("2 回流しても壊れない(版の行は増えず、形も中身も変わらない)", async () => {
    await migrateMysql(c, MYSQL_MIGRATIONS);
    await c.query("INSERT INTO projects (name, data_dir, status, created_at) VALUES ('p', '/d', 'running', '')");
    const before = await shape(c);
    await migrateMysql(c, MYSQL_MIGRATIONS);
    expect(await versions(c)).toEqual([21]);
    expect(await shape(c)).toEqual(before);
    expect((await c.query<any[]>("SELECT name FROM projects"))[0]).toEqual([{ name: "p" }]);
    expect((await c.query<any[]>("SELECT id, name FROM workspaces"))[0]).toEqual([{ id: 1, name: "既定" }]);
  });

  it("途中で止まった(版の行が無い)あとに流し直すと、足りない表だけできる", async () => {
    await migrateMysql(c, MYSQL_MIGRATIONS);
    const before = await shape(c);
    await c.query("DELETE FROM schema_version");
    await c.query("DROP TABLE member_messages");
    await migrateMysql(c, MYSQL_MIGRATIONS);
    expect(await versions(c)).toEqual([21]);
    expect(await shape(c)).toEqual(before);
  });

  it("InnoDB・utf8mb4_bin で、日本語も入る", async () => {
    await migrateMysql(c, MYSQL_MIGRATIONS);
    const [t] = await c.query<any[]>("SELECT DISTINCT engine, table_collation FROM information_schema.tables WHERE table_schema = DATABASE()");
    expect(t).toEqual([{ ENGINE: "InnoDB", TABLE_COLLATION: "utf8mb4_bin" }]);
    expect((await c.query<any[]>("SELECT name FROM workspaces WHERE name = '既定'"))[0]).toHaveLength(1);
    expect((await c.query<any[]>("SELECT name FROM workspaces WHERE name = 'ＡＢＣ'"))[0]).toHaveLength(0); // 大文字小文字・全角半角を区別する
  });

  it("project_id は全部のプロジェクトの表にあり、projects(id) への外部キーがある", async () => {
    await migrateMysql(c, MYSQL_MIGRATIONS);
    const [fks] = await c.query<any[]>(
      "SELECT table_name AS t FROM information_schema.key_column_usage WHERE table_schema = DATABASE() AND column_name = 'project_id' AND referenced_table_name = 'projects' AND referenced_column_name = 'id'",
    );
    const withFk = new Set(fks.map((r) => r.t as string));
    const scoped = [...sqliteColumns()].filter(([, cols]) => cols.includes("project_id")).map(([t]) => t);
    expect(scoped.length).toBeGreaterThan(30);
    for (const t of scoped) expect(withFk.has(t), t).toBe(true);
    await expect(
      c.query("INSERT INTO tickets (number, title, stage, created_at, project_id) VALUES (1, 't', 'dev', '', 999)"),
    ).rejects.toThrow(/foreign key/i);
  });

  it("id は BIGINT AUTO_INCREMENT。tickets の number はプロジェクトの中で一意", async () => {
    await migrateMysql(c, MYSQL_MIGRATIONS);
    const [ids] = await c.query<any[]>(
      "SELECT table_name AS t FROM information_schema.columns WHERE table_schema = DATABASE() AND column_name = 'id' AND (data_type <> 'bigint' OR extra NOT LIKE '%auto_increment%')",
    );
    expect(ids).toEqual([]);
    await c.query("INSERT INTO projects (name, data_dir, status, created_at) VALUES ('a', '/a', 'running', ''), ('b', '/b', 'running', '')");
    const ins = (project: number, n: number) => c.query("INSERT INTO tickets (number, title, stage, created_at, project_id) VALUES (?, 't', 'dev', '', ?)", [n, project]);
    await ins(1, 1);
    await ins(2, 1); // 別のプロジェクトなら同じ number でよい
    await expect(ins(1, 1)).rejects.toThrow(/Duplicate entry/);
  });

  it("one_run_per_ticket: 終わっていない起動はチケットに 1 つだけ(終わった起動はいくつでも)", async () => {
    await migrateMysql(c, MYSQL_MIGRATIONS);
    await c.query("INSERT INTO projects (name, data_dir, status, created_at) VALUES ('a', '/a', 'running', '')");
    await c.query("INSERT INTO members (name, look, joined_at, project_id) VALUES ('m', '{}', '', 1)");
    await c.query("INSERT INTO tickets (number, title, stage, created_at, project_id) VALUES (1, 't', 'dev', '', 1), (2, 't', 'dev', '', 1)");
    await c.query("INSERT INTO policies (role, version, model, effort, focus, created_at, project_id) VALUES ('dev', 1, 'm', 'high', '', '', 1)");
    await c.query("INSERT INTO formations (version, pull, created_at, project_id) VALUES (1, 'down', '', 1)");
    await c.query("INSERT INTO messages (to_role, kind, available_at, created_at, project_id) VALUES ('dev', 'implement', '', '', 1)");
    const run = (ticket: number, ended: string | null) =>
      c.query("INSERT INTO runs (message_id, ticket_id, member_id, role, policy_id, formation_id, started_at, ended_at, project_id) VALUES (1, ?, 1, 'dev', 1, 1, '', ?, 1)", [ticket, ended]);
    await run(1, null);
    await expect(run(1, null)).rejects.toThrow(/one_run_per_ticket/);
    await run(2, null); // 別のチケットはよい
    await run(1, "x");
    await run(1, "y"); // 終わった起動は重なってよい
    await c.query("UPDATE runs SET ended_at = 'z' WHERE ticket_id = 1 AND ended_at IS NULL");
    await run(1, null); // 終わらせれば、また 1 つ始められる
  });

  it("MySQL に無い版だけ流す(新しい版は足され、版の行が増える。古い版は流し直さない)", async () => {
    await migrateMysql(c, MYSQL_MIGRATIONS);
    const next: MysqlMigration = { version: 22, statements: ["CREATE TABLE IF NOT EXISTS probe (id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY)"] };
    await migrateMysql(c, [...MYSQL_MIGRATIONS, next]);
    expect(await versions(c)).toEqual([21, 22]);
    await c.query("DROP TABLE probe");
    await migrateMysql(c, [...MYSQL_MIGRATIONS, next]); // 22 は流し終えているので、消した表は戻らない
    expect(await tableNames(c)).not.toContain("probe");
    await expect(migrateMysql(c, [next, MYSQL_MIGRATIONS[0]!])).rejects.toThrow(/昇順/);
  });

  it("失敗した版は版の行を足さない(前の版までは残る)", async () => {
    await migrateMysql(c, MYSQL_MIGRATIONS);
    const bad: MysqlMigration = { version: 22, statements: ["CREATE TABLE IF NOT EXISTS ok_table (id BIGINT)", "INSERT INTO missing_table VALUES (1)"] };
    await expect(migrateMysql(c, [...MYSQL_MIGRATIONS, bad])).rejects.toThrow(/missing_table/);
    expect(await versions(c)).toEqual([21]);
    // ロックは外れているので、続けて流せる
    await migrateMysql(c, MYSQL_MIGRATIONS);
  });
});
