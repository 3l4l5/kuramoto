import { DatabaseSync } from "node:sqlite";
import { sql, type Generated } from "kysely";
import { describe, expect, it } from "vitest";
import { dialect } from "./index.js";
import { createKysely } from "../kysely.js";
import { openDb } from "../sqlite.js";
import { migrate } from "../migrate.js";
import { PROJECT_MIGRATIONS } from "../schema.js";
import type { ProjectDatabase } from "../tables.js";

function project() {
  const db = openDb(":memory:", PROJECT_MIGRATIONS);
  return { db, k: createKysely<ProjectDatabase>(db) };
}

async function addMessage(k: ReturnType<typeof project>["k"], v: { kind: string; availableAt?: string; payload?: string; to?: string }): Promise<number> {
  return dialect.insertedId(
    k.insertInto("messages").values({ to_role: v.to ?? "dev", kind: v.kind, payload: v.payload ?? "{}", available_at: v.availableAt ?? "2026-01-01", created_at: "" }),
  );
}

describe("方言の助け(SQLite)", () => {
  it("jsonExtract: JSON の列から値を取り出す(列名でも式でも、入れ子のパスでも)", async () => {
    const { k } = project();
    const id = await addMessage(k, { kind: "plan", payload: JSON.stringify({ stage: "req", preDev: 1, a: { b: "deep" } }) });
    const row = await k
      .selectFrom("messages as m")
      .select([dialect.jsonExtract<string>("m.payload", "stage").as("stage"), dialect.jsonExtract<string>(sql.ref("m.payload"), "a.b").as("deep"), dialect.jsonExtract("m.payload", "none").as("none")])
      .where(dialect.jsonExtract<number>("m.payload", "preDev"), "=", 1)
      .where("m.id", "=", id)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({ stage: "req", deep: "deep", none: null });
  });

  it("jsonExtract: パスは値として渡る(SQL に混ざらない)", () => {
    const c = dialect.jsonExtract("m.payload", "x') OR 1=1 --").compile(createKysely<ProjectDatabase>(new DatabaseSync(":memory:")));
    expect(c.sql).toBe('json_extract("m"."payload", ?)');
    expect(c.parameters).toEqual(["$.x') OR 1=1 --"]);
  });

  it("upsert: 衝突したら指定の列だけ、挿入しようとした値で更新する", async () => {
    const { k } = project();
    const put = (key: string, value: string) => dialect.upsert(k.insertInto("settings").values({ key, value }), ["key"], ["value"]).execute();
    await put("a", "1");
    await put("a", "2");
    await put("b", "3");
    expect(await k.selectFrom("settings").selectAll().orderBy("key").execute()).toEqual([{ key: "a", value: "2" }, { key: "b", value: "3" }]);
  });

  it("upsert: 複数の列の衝突(sessions の member_id, ticket_id, repo_id)", async () => {
    const { db, k } = project();
    db.exec(`PRAGMA foreign_keys = OFF`);
    const put = (sid: string, at: string) =>
      dialect
        .upsert(
          k.insertInto("sessions").values({ member_id: 1, ticket_id: 1, repo_id: 1, harness: "h", harness_session_id: sid, created_at: "c", last_used_at: at }),
          ["member_id", "ticket_id", "repo_id"],
          ["harness_session_id", "last_used_at"],
        )
        .execute();
    await put("s1", "t1");
    await put("s2", "t2");
    expect(await k.selectFrom("sessions").select(["harness_session_id", "last_used_at", "created_at"]).execute()).toEqual([{ harness_session_id: "s2", last_used_at: "t2", created_at: "c" }]);
  });

  it("insertedId: 挿入した行の id を数で返す", async () => {
    const { k } = project();
    const a = await dialect.insertedId(k.insertInto("repos").values({ full_name: "o/a", role: "API" }));
    const b = await dialect.insertedId(k.insertInto("repos").values({ full_name: "o/b", role: "API" }));
    expect([a, b]).toEqual([1, 2]);
    expect(typeof a).toBe("number");
  });

  it("claimMessage: 候補の先頭を pending → claimed にして返し、試行回数を 1 増やす。無ければ undefined", async () => {
    const { k } = project();
    const claim = (now: string) =>
      dialect.claimMessage(
        k,
        k.selectFrom("messages as m").select("m.id").where("m.status", "=", "pending").where("m.available_at", "<=", now).orderBy("m.available_at").orderBy("m.id").limit(1),
        now,
      );
    expect(await claim("2026-02-01")).toBeUndefined();
    const later = await addMessage(k, { kind: "implement", availableAt: "2026-01-05" });
    const first = await addMessage(k, { kind: "review", availableAt: "2026-01-02" });
    const future = await addMessage(k, { kind: "qa", availableAt: "2099-01-01" });
    expect(await claim("2026-02-01")).toMatchObject({ id: first, kind: "review", status: "claimed", claimed_at: "2026-02-01", attempts: 1 });
    expect(await claim("2026-02-01")).toMatchObject({ id: later, status: "claimed" });
    expect(await claim("2026-02-01")).toBeUndefined();
    expect(await k.selectFrom("messages").select(["id", "status"]).where("id", "=", future).executeTakeFirst()).toEqual({ id: future, status: "pending" });
  });

  it("idColumn / indexableText / createPartialIndex: スキーマビルダの関数のマイグレーションで使える", async () => {
    const db = new DatabaseSync(":memory:");
    migrate(db, [
      (k) => [
        k.schema.createTable("jobs").addColumn("id", "integer", (c) => dialect.idColumn(c)).addColumn("ticket_id", "integer").addColumn("tag", dialect.indexableText, (c) => c.notNull()).addColumn("ended_at", "text"),
        k.schema.createIndex("jobs_tag").on("jobs").column("tag"),
        dialect.createPartialIndex(k, { name: "one_job_per_ticket", table: "jobs", columns: ["ticket_id"], where: sql<boolean>`ended_at IS NULL`, unique: true, ifNotExists: true }),
      ],
    ]);
    const k = createKysely<{ jobs: { id: Generated<number>; ticket_id: number | null; tag: string; ended_at: string | null } }>(db);
    const ins = (ticket_id: number, ended_at: string | null) => k.insertInto("jobs").values({ ticket_id, tag: "t", ended_at }).execute();
    await ins(1, null);
    await ins(1, "done"); // 終わった行は何件あってよい
    await ins(1, "done2");
    await ins(2, null);
    await expect(ins(1, null)).rejects.toThrow(/UNIQUE constraint failed/); // 動いている行は 1 つだけ(runs の one_run_per_ticket と同じ)
    expect((db.prepare("SELECT sql FROM sqlite_master WHERE name = 'jobs'").get() as { sql: string }).sql).toMatch(/"id" integer primary key/i);
  });
});
