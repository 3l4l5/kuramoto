import { DatabaseSync } from "node:sqlite";
import { sql, type Generated } from "kysely";
import { describe, expect, it } from "vitest";
import { createKysely } from "./kysely.js";
import { openDb } from "./sqlite.js";
import { PROJECT_MIGRATIONS } from "./schema.js";
import type { ProjectDatabase } from "./tables.js";

interface T {
  t: { id: Generated<number>; name: string; flag: number | null };
}

function setup() {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT NOT NULL, flag INTEGER)");
  return { db, k: createKysely<T>(db) };
}

describe("node:sqlite を Kysely につなぐドライバ", () => {
  it("挿入・取得・更新・削除ができ、件数と挿入した id が返る", async () => {
    const { k } = setup();
    const ins = await k.insertInto("t").values({ name: "a", flag: null }).executeTakeFirstOrThrow();
    expect(ins.insertId).toBe(1n);
    expect(ins.numInsertedOrUpdatedRows).toBe(1n);
    await k.insertInto("t").values([{ name: "b", flag: 1 }, { name: "c", flag: 0 }]).execute();
    expect(await k.selectFrom("t").selectAll().orderBy("id").execute()).toEqual([
      { id: 1, name: "a", flag: null },
      { id: 2, name: "b", flag: 1 },
      { id: 3, name: "c", flag: 0 },
    ]);
    const up = await k.updateTable("t").set({ flag: 5 }).where("id", ">", 1).executeTakeFirstOrThrow();
    expect(up.numUpdatedRows).toBe(2n);
    const del = await k.deleteFrom("t").where("name", "=", "a").executeTakeFirstOrThrow();
    expect(del.numDeletedRows).toBe(1n);
  });

  it("RETURNING の付いた挿入・更新は行を返す(reader の判定)", async () => {
    const { k } = setup();
    const row = await k.insertInto("t").values({ name: "a", flag: null }).returning(["id", "name"]).executeTakeFirstOrThrow();
    expect(row).toEqual({ id: 1, name: "a" });
    const up = await k.updateTable("t").set({ name: "z" }).returningAll().execute();
    expect(up).toEqual([{ id: 1, name: "z", flag: null }]);
  });

  it("真偽値は 1 / 0、undefined は null で渡る", async () => {
    const { k, db } = setup();
    await sql`INSERT INTO t (name, flag) VALUES (${"x"}, ${true}), (${"y"}, ${false}), (${"z"}, ${undefined})`.execute(k);
    expect(db.prepare("SELECT flag FROM t ORDER BY id").all()).toEqual([{ flag: 1 }, { flag: 0 }, { flag: null }]);
  });

  it("DDL(引数も行も無い文)も流せる", async () => {
    const { k, db } = setup();
    await k.schema.createTable("u").addColumn("id", "integer", (c) => c.primaryKey()).execute();
    await sql`PRAGMA user_version = 3`.execute(k);
    expect((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(3);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'u'").all()).toHaveLength(1);
  });

  it("Kysely のトランザクションは BEGIN IMMEDIATE で始まり、成功で確定・失敗で巻き戻る", async () => {
    const { k, db } = setup();
    await k.transaction().execute(async (trx) => {
      expect(db.isTransaction).toBe(true);
      await trx.insertInto("t").values({ name: "a", flag: null }).execute();
    });
    expect(db.isTransaction).toBe(false);
    await expect(
      k.transaction().execute(async (trx) => {
        await trx.insertInto("t").values({ name: "b", flag: null }).execute();
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(db.isTransaction).toBe(false);
    expect(db.prepare("SELECT name FROM t").all()).toEqual([{ name: "a" }]);
  });

  it("書き込みのロックは最初に取る(別の接続の書き込み中は BEGIN の時点で待つ・失敗する)", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const path = join(mkdtempSync(join(tmpdir(), "kuramoto-kysely-")), "x.sqlite");
    const a = new DatabaseSync(path);
    a.exec("PRAGMA journal_mode = WAL; CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT NOT NULL, flag INTEGER)");
    const b = new DatabaseSync(path, { timeout: 0 });
    a.exec("BEGIN IMMEDIATE");
    const kb = createKysely<T>(b);
    await expect(kb.transaction().execute(async () => {})).rejects.toThrow(/locked/);
    a.exec("ROLLBACK");
    await kb.transaction().execute(async () => {});
    a.close();
    b.close();
  });

  it("Kysely を閉じても DatabaseSync は閉じない(接続は持ち主が閉じる)", async () => {
    const { k, db } = setup();
    await k.selectFrom("t").selectAll().execute();
    await k.destroy();
    expect(db.prepare("SELECT 1 AS x").get()).toEqual({ x: 1 });
    db.close();
  });

  it("openDb の接続の上でも使え、既存の書き方(db.prepare)と同じ接続を見る", async () => {
    const db = openDb(":memory:", PROJECT_MIGRATIONS);
    const k = createKysely<ProjectDatabase>(db);
    db.prepare("INSERT INTO settings (key, value) VALUES ('a', '1')").run();
    expect(await k.selectFrom("settings").selectAll().execute()).toEqual([{ key: "a", value: "1" }]);
    await k.insertInto("repos").values({ full_name: "o/r", role: "API" }).execute();
    expect(db.prepare("SELECT full_name FROM repos").all()).toEqual([{ full_name: "o/r" }]);
  });
});
