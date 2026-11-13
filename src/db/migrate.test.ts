import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "kysely";
import { describe, expect, it } from "vitest";
import { migrate, type Migration } from "./migrate.js";
import { dialect } from "./dialect/index.js";
import { all, get, openDb } from "./sqlite.js";
import { HQ_MIGRATIONS, PROJECT_MIGRATIONS } from "./schema.js";

const version = (db: DatabaseSync) => (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
const tables = (db: DatabaseSync) => all<{ name: string }>(db, "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").map((t) => t.name);

describe("マイグレーションの実行器", () => {
  it("文字列のマイグレーションを順に流し、版(user_version)を進める", () => {
    const db = new DatabaseSync(":memory:");
    migrate(db, ["CREATE TABLE a (id INTEGER PRIMARY KEY);", "CREATE TABLE b (id INTEGER PRIMARY KEY); INSERT INTO b (id) VALUES (1);"]);
    expect(version(db)).toBe(2);
    expect(tables(db)).toEqual(["a", "b"]);
  });

  it("流し終えた版は飛ばし、足された版だけ流す", () => {
    const db = new DatabaseSync(":memory:");
    const ms: Migration[] = ["CREATE TABLE a (id INTEGER PRIMARY KEY);"];
    migrate(db, ms);
    migrate(db, ms);
    ms.push("CREATE TABLE b (id INTEGER PRIMARY KEY);");
    migrate(db, ms);
    expect(version(db)).toBe(2);
    expect(tables(db)).toEqual(["a", "b"]);
  });

  it("Kysely のスキーマビルダの関数で書ける(表・列の追加・索引・部分索引・データの更新)", () => {
    const db = new DatabaseSync(":memory:");
    const ms: Migration[] = [
      "CREATE TABLE a (id INTEGER PRIMARY KEY, name TEXT NOT NULL); INSERT INTO a (name) VALUES ('x'), ('y');",
      (k) => [
        k.schema.createTable("b").addColumn("id", "integer", (c) => dialect.idColumn(c)).addColumn("code", dialect.indexableText, (c) => c.notNull().unique()).addColumn("ended_at", "text"),
        k.schema.alterTable("a").addColumn("note", "text", (c) => c.notNull().defaultTo("")),
        k.schema.createIndex("a_name").on("a").column("name"),
        dialect.createPartialIndex(k, { name: "b_open", table: "b", columns: ["code"], where: sql<boolean>`ended_at IS NULL`, unique: true }),
        k.updateTable("a").set({ note: "from-" + "migration" }).where("name", "=", "y"),
      ],
      (k) => k.schema.alterTable("b").addColumn("memo", "text"), // 1 件だけ返してもよい
    ];
    migrate(db, ms);
    expect(version(db)).toBe(3);
    expect(all(db, "SELECT name, note FROM a ORDER BY id")).toEqual([{ name: "x", note: "" }, { name: "y", note: "from-migration" }]);
    expect(all<{ name: string }>(db, "PRAGMA table_info(b)").map((c) => c.name)).toEqual(["id", "code", "ended_at", "memo"]);
    expect(get<{ sql: string }>(db, "SELECT sql FROM sqlite_master WHERE name = 'b_open'")!.sql).toMatch(/CREATE UNIQUE INDEX "b_open" ON "b" \("code"\) WHERE .*ended_at.* IS NULL/i);
  });

  it("文字列の版と関数の版が混ざっていても、前の版から続きを流せる", () => {
    const db = new DatabaseSync(":memory:");
    migrate(db, ["CREATE TABLE a (id INTEGER PRIMARY KEY);"]);
    migrate(db, ["CREATE TABLE a (id INTEGER PRIMARY KEY);", (k) => k.schema.createTable("b").addColumn("id", "integer", (c) => c.primaryKey())]);
    expect(version(db)).toBe(2);
    expect(tables(db)).toEqual(["a", "b"]);
  });

  it("失敗した版は巻き戻り、版も進まない(前の版までは残る)", () => {
    const db = new DatabaseSync(":memory:");
    const bad: Migration[] = [
      "CREATE TABLE a (id INTEGER PRIMARY KEY);",
      (k) => [k.schema.createTable("b").addColumn("id", "integer"), sql`INSERT INTO missing_table VALUES (1)`],
    ];
    expect(() => migrate(db, bad)).toThrow(/no such table/);
    expect(version(db)).toBe(1);
    expect(tables(db)).toEqual(["a"]);
    expect(db.isTransaction).toBe(false);
  });

  it("流すものが無ければ何もしない", () => {
    const db = new DatabaseSync(":memory:");
    migrate(db, []);
    expect(version(db)).toBe(0);
  });

  it("実際のマイグレーション(HQ・プロジェクト)は、これまでどおり開け、最新の版になる。開き直しても変わらない", () => {
    const path = join(mkdtempSync(join(tmpdir(), "kuramoto-migrate-")), "p.sqlite");
    const first = openDb(path, PROJECT_MIGRATIONS);
    expect(version(first)).toBe(PROJECT_MIGRATIONS.length);
    const before = all(first, "SELECT type, name, sql FROM sqlite_master ORDER BY name");
    first.close();
    const again = openDb(path, PROJECT_MIGRATIONS);
    expect(all(again, "SELECT type, name, sql FROM sqlite_master ORDER BY name")).toEqual(before);
    again.close();
    const hq = openDb(":memory:", HQ_MIGRATIONS);
    expect(version(hq)).toBe(HQ_MIGRATIONS.length);
    hq.close();
  });
});
