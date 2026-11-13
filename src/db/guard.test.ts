import { describe, expect, it } from "vitest";
import { ProjectDb } from "./conn.js";
import { enableProjectIdGuard, projectIdViolation, requireProjectIdPlugin } from "./guard.js";
import { PROJECT_MIGRATIONS } from "./schema.js";
import { all, openDb, run, tx } from "./sqlite.js";
import { Kysely, DummyDriver, SqliteAdapter, SqliteIntrospector, SqliteQueryCompiler, sql } from "kysely";
import type { ProjectDatabase } from "./tables.js";

/** project_id の見張り(Kysely のプラグイン)と、同じ database に置いた 2 つのプロジェクトが混ざらないこと */

// 文を組むだけの Kysely(実行はしない)で、プラグインがどう判定するかを見る
const dry = new Kysely<ProjectDatabase>({
  dialect: { createAdapter: () => new SqliteAdapter(), createDriver: () => new DummyDriver(), createIntrospector: (db) => new SqliteIntrospector(db), createQueryCompiler: () => new SqliteQueryCompiler() },
});
const violation = (q: { toOperationNode(): unknown }) => projectIdViolation(q.toOperationNode() as never);

describe("requireProjectIdPlugin: project_id の無い文を落とす", () => {
  it("SELECT / UPDATE / DELETE は、project_id で絞っていなければ落ちる", () => {
    expect(violation(dry.selectFrom("tickets").selectAll())).toMatch(/project_id/);
    expect(violation(dry.selectFrom("tickets").selectAll().where("project_id", "=", 1))).toBeUndefined();
    expect(violation(dry.updateTable("tickets").set({ title: "x" }).where("id", "=", 1))).toMatch(/UpdateQuery/);
    expect(violation(dry.updateTable("tickets").set({ title: "x" }).where("id", "=", 1).where("project_id", "=", 1))).toBeUndefined();
    expect(violation(dry.deleteFrom("ticket_deps").where("ticket_id", "=", 1))).toMatch(/DeleteQuery/);
  });

  it("INSERT は、列に project_id が無ければ落ちる", () => {
    expect(violation(dry.insertInto("settings").values({ key: "k", value: "v" }))).toMatch(/InsertQuery/);
    expect(violation(dry.insertInto("settings").values({ key: "k", value: "v", project_id: 1 }))).toBeUndefined();
  });

  it("結合のどこかで project_id を見ていれば通す。project_id の表を触らない文は対象外", () => {
    const q = dry.selectFrom("tickets").innerJoin("pull_requests", "pull_requests.ticket_id", "tickets.id").selectAll("tickets").where("pull_requests.project_id", "=", 1);
    expect(violation(q)).toBeUndefined();
    expect(violation((dry as unknown as Kysely<{ other: { a: number } }>).selectFrom("other").selectAll())).toBeUndefined();
  });

  it("生 SQL は通せないので落ちる", () => {
    expect(() => requireProjectIdPlugin.transformQuery({ node: sql`SELECT 1`.compile(dry) && ({ kind: "RawNode" } as never), queryId: {} as never })).toThrow(/生 SQL/);
  });
});

function twoProjects() {
  const raw = openDb(":memory:", PROJECT_MIGRATIONS);
  return { raw, a: new ProjectDb(raw, 1), b: new ProjectDb(raw, 2) };
}

describe("2 つのプロジェクトを同じ database に置いても混ざらない", () => {
  it("ProjectDb はテストで見張りが付く(project_id の無い文は、実際に投げる)", async () => {
    const { a } = twoProjects();
    await expect(a.k.selectFrom("tickets").selectAll().execute()).rejects.toThrow(/project_id/);
    await expect(a.k.updateTable("tickets").set({ title: "x" }).execute()).rejects.toThrow(/project_id/);
  });

  it("insert / from / update / deleteFrom は、自分のプロジェクトの行だけを書く・見る", async () => {
    const { a, b } = twoProjects();
    // 版 22 で UNIQUE は project_id 込みだけになったので、別のプロジェクトなら同じ key(・number など)が入る
    await a.insert("settings", { key: "k", value: "a" }).execute();
    await b.insert("settings", { key: "k", value: "b" }).execute();
    expect((await a.from("settings").execute()).map((r) => r.value)).toEqual(["a"]);
    expect((await b.from("settings").execute()).map((r) => r.value)).toEqual(["b"]);

    await a.update("settings", { value: "a2" }).execute(); // 条件が無くても、自分の行だけ
    expect((await b.from("settings").execute()).map((r) => r.value)).toEqual(["b"]);
    expect((await a.from("settings").execute()).map((r) => r.value)).toEqual(["a2"]);

    await a.deleteFrom("settings").execute(); // 条件が無くても、自分の行だけ
    expect(await a.from("settings").execute()).toEqual([]);
    expect((await b.from("settings").execute()).map((r) => r.value)).toEqual(["b"]);
  });

  it("相手の id を指しても、更新と削除が相手の行へ届かない", async () => {
    const { raw, a, b } = twoProjects();
    const ticket = (p: ProjectDb, n: number) =>
      p.insert("tickets", { number: n, title: `t${p.projectId}`, stage: "dev", created_at: "" }).returningAll().executeTakeFirstOrThrow();
    const ta = await ticket(a, 1);
    const tb = await ticket(b, 2);
    await a.update("tickets", { title: "changed" }).where("id", "=", tb.id).execute(); // 相手の id を指しても届かない
    await a.deleteFrom("tickets").where("id", "=", tb.id).execute();
    expect(all<{ id: number; title: string; project_id: number }>(raw, "SELECT id, title, project_id FROM tickets ORDER BY id")).toEqual([
      { id: ta.id, title: "t1", project_id: 1 },
      { id: tb.id, title: "t2", project_id: 2 },
    ]);
  });

  it("scope を外した insert は書けない(project_id を上書きされない)", async () => {
    const { raw, a } = twoProjects();
    await a.insert("settings", { key: "kk", value: "v", project_id: 2 }).execute();
    expect(all<{ project_id: number }>(raw, "SELECT project_id FROM settings")).toEqual([{ project_id: 1 }]);
  });
});

describe("同期の書き込みは、他の流れの非同期トランザクションに混ざらない", () => {
  it("await の最中に run() を呼ぶと投げる。トランザクションの外・同じ流れの中なら通る", async () => {
    const { raw, a } = twoProjects();
    const insertSync = () => run(raw, "INSERT INTO settings (key, value, project_id) VALUES ('s', 'x', 1)");
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const open = a.transaction(async () => {
      await a.insert("settings", { key: "in", value: "1" }).execute();
      insertSync(); // 同じ流れ: 相乗りして通る
      await gate;
      throw new Error("巻き戻す");
    });
    await new Promise((r) => setTimeout(r, 5));
    expect(insertSync).toThrow(/別の処理のトランザクション/); // 別の流れ: 混ざらないよう投げる
    expect(() => tx(raw, () => 1)).toThrow(/別の処理のトランザクション/);
    release();
    await expect(open).rejects.toThrow("巻き戻す");
    expect(all(raw, "SELECT key FROM settings WHERE key IN ('in', 's')")).toEqual([]); // 巻き戻ったものに、別の流れの書き込みは混ざっていない
    insertSync(); // 終わったあとは普通に使える
    expect(all(raw, "SELECT key FROM settings WHERE key = 's'")).toHaveLength(1);
  });
});

it("enableProjectIdGuard(false) で見張りを外せる", () => {
  enableProjectIdGuard(false);
  try {
    const raw = openDb(":memory:", PROJECT_MIGRATIONS);
    expect(new ProjectDb(raw, 1).k).toBeDefined();
  } finally {
    enableProjectIdGuard(true);
  }
});
