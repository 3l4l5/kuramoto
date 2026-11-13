import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PROJECT_MIGRATIONS } from "./schema.js";
import { all, get, openDb } from "./sqlite.js";

const V19 = 19;
const BEFORE = PROJECT_MIGRATIONS.slice(0, V19 - 1);

/** 版 18 までを流した DB を作り、既存のデータを入れて閉じる */
function v18Db(seed: (db: DatabaseSync) => void): string {
  const path = join(mkdtempSync(join(tmpdir(), "kuramoto-schema-")), "p.sqlite");
  const db = openDb(path, BEFORE);
  expect((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(V19 - 1);
  seed(db);
  db.close();
  return path;
}

function seedBase(db: DatabaseSync): void {
  db.exec(`
INSERT INTO repos (id, full_name, role) VALUES (1, 'acme/shop', 'API');
INSERT INTO formations (id, version, pull, created_at) VALUES (1, 1, 'down', '');
INSERT INTO policies (id, role, version, model, effort, focus, created_at) VALUES (1, 'dev', 1, 'm', 'high', '', '');
INSERT INTO members (id, name, look, joined_at) VALUES (1, 'a', '{}', '');
INSERT INTO messages (id, to_role, kind, available_at, created_at) VALUES (1, 'dev', 'implement', '', '');
`);
}

function addTicket(db: DatabaseSync, id: number, stage: string): void {
  db.prepare("INSERT INTO tickets (id, number, title, stage, created_at) VALUES (?, ?, ?, ?, '')").run(id, id, `t${id}`, stage);
}

function addRun(db: DatabaseSync, ticketId: number, role: string): void {
  db.prepare(
    "INSERT INTO runs (message_id, ticket_id, member_id, role, policy_id, formation_id, started_at, ended_at) VALUES (1, ?, 1, ?, 1, 1, '', '')",
  ).run(ticketId, role);
}

describe("版 19: R15〜R17 とメンバーとの会話", () => {
  it("既存の DB を開くと流れ、開発の起動があるか開発より後の工程のチケットだけ dev_done = 1 になる", () => {
    const path = v18Db((db) => {
      seedBase(db);
      addTicket(db, 1, "dev"); // 起動なし → 0
      addTicket(db, 2, "dev"); // 開発の起動あり → 1
      addRun(db, 2, "dev");
      addTicket(db, 3, "dev"); // 開発以外の起動だけ → 0
      addRun(db, 3, "qa");
      for (const [i, stage] of ["review", "sec", "qa", "decision", "merge", "done"].entries()) addTicket(db, 10 + i, stage);
      addTicket(db, 20, "dropped"); // 起動なしで取りやめ → 0
      addTicket(db, 21, "dropped"); // 開発してから取りやめ → 1
      addRun(db, 21, "dev");
    });
    const db = openDb(path, PROJECT_MIGRATIONS);
    expect(get<{ user_version: number }>(db, "PRAGMA user_version")!.user_version).toBe(PROJECT_MIGRATIONS.length);
    const rows = all<{ id: number; dev_done: number; kind: string }>(db, "SELECT id, dev_done, kind FROM tickets ORDER BY id");
    expect(Object.fromEntries(rows.map((r) => [r.id, r.dev_done]))).toEqual({
      1: 0, 2: 1, 3: 0, 10: 1, 11: 1, 12: 1, 13: 1, 14: 1, 15: 1, 20: 0, 21: 1,
    });
    expect(new Set(rows.map((r) => r.kind))).toEqual(new Set(["feature"]));
    db.close();
  });

  it("表・列・索引が足され、既定の値が入る", () => {
    const db = openDb(":memory:", PROJECT_MIGRATIONS);
    const cols = (t: string) => all<{ name: string; dflt_value: string | null; notnull: number }>(db, `PRAGMA table_info(${t})`);
    const col = (t: string, c: string) => cols(t).find((x) => x.name === c);
    expect(col("formations", "routes")).toMatchObject({ dflt_value: "'[]'", notnull: 1 });
    expect(col("formations", "flows")).toMatchObject({ dflt_value: "'{}'", notnull: 1 });
    expect(col("tickets", "kind")).toMatchObject({ dflt_value: "'feature'", notnull: 1 });
    expect(col("tickets", "dev_done")).toMatchObject({ dflt_value: "0", notnull: 1 });
    expect(col("dev_rules", "template")).toMatchObject({ notnull: 0 });
    expect(col("dev_rules", "created_at")).toMatchObject({ dflt_value: "''", notnull: 1 });
    expect(col("rule_violations", "detail")).toMatchObject({ dflt_value: "''", notnull: 1 });
    expect(col("rule_violations", "run_id")).toMatchObject({ notnull: 0 });
    expect(col("rule_violations", "resolved_at")).toMatchObject({ notnull: 0 });
    expect(col("ticket_notes", "kind")).toMatchObject({ dflt_value: "'note'", notnull: 1 });
    expect(col("runs", "about_ticket_id")).toMatchObject({ notnull: 0 });
    expect(cols("ticket_questions").map((c) => c.name)).toEqual([
      "id", "ticket_id", "from_member_id", "to_target", "body", "routed_to_lead", "answer", "answered_by_member_id", "asked_at", "answered_at",
    ]);
    expect(col("ticket_questions", "routed_to_lead")).toMatchObject({ dflt_value: "0", notnull: 1 });
    expect(cols("member_messages").map((c) => c.name)).toEqual(["id", "member_id", "ticket_id", "who", "body", "at"]);

    const fks = (t: string) => all<{ from: string; table: string }>(db, `PRAGMA foreign_key_list(${t})`).map((f) => `${f.from}->${f.table}`);
    expect(fks("rule_violations")).toContain("run_id->runs");
    expect(fks("runs")).toContain("about_ticket_id->tickets");

    const idx = (name: string) => all<{ name: string }>(db, `PRAGMA index_info(${name})`).map((c) => c.name);
    expect(idx("ticket_questions_ticket")).toEqual(["ticket_id"]);
    expect(idx("member_messages_member")).toEqual(["member_id", "id"]);
    db.close();
  });

  it("表・列・索引を足すだけで、作り直し・RENAME・列の削除をせず、新しい列に CHECK を付けない", () => {
    const sql = PROJECT_MIGRATIONS[V19 - 1]!;
    expect(sql).not.toMatch(/\bRENAME\b|\bDROP\b|_new\b/i);
    expect(sql).not.toMatch(/\bCHECK\b/i);
    const statements = sql.split(";").map((s) => s.replace(/--.*$/gm, "").trim()).filter(Boolean);
    for (const s of statements) expect(s).toMatch(/^(ALTER TABLE \w+ ADD COLUMN|CREATE TABLE IF NOT EXISTS|CREATE INDEX IF NOT EXISTS|UPDATE tickets SET dev_done)/);
  });

  it("前の版のコードと同じ書き方(新しい列を書かない INSERT・SELECT *)でも、版 19 の DB で動く", () => {
    const path = v18Db(() => {});
    openDb(path, PROJECT_MIGRATIONS.slice(0, V19)).close();
    // 前の版のコードは版 18 までしか知らない。版 19 の DB を開いてもマイグレーションは流れず、そのまま使える
    const db = openDb(path, BEFORE);
    expect(get<{ user_version: number }>(db, "PRAGMA user_version")!.user_version).toBe(V19);
    seedBase(db);
    addTicket(db, 1, "dev");
    addRun(db, 1, "dev");
    db.exec(`
INSERT INTO dev_rules (id, name, body, applies_to, check_kind, on_fail) VALUES (1, 'r', 'b', '*', 'ai', 'review');
INSERT INTO rule_violations (rule_id, ticket_id, handled, created_at) VALUES (1, 1, 'review', '');
INSERT INTO ticket_notes (ticket_id, who, body, at) VALUES (1, 'owner', 'memo', '');
INSERT INTO formations (version, pull, created_at) VALUES (2, 'start', '');
`);
    expect(get<{ kind: string; dev_done: number }>(db, "SELECT * FROM tickets WHERE id = 1")).toMatchObject({ kind: "feature", dev_done: 0 });
    expect(get<{ kind: string }>(db, "SELECT * FROM ticket_notes")).toMatchObject({ kind: "note" });
    expect(get<{ routes: string; flows: string }>(db, "SELECT * FROM formations WHERE version = 2")).toMatchObject({ routes: "[]", flows: "{}" });
    expect(get<{ detail: string; run_id: number | null }>(db, "SELECT * FROM rule_violations")).toMatchObject({ detail: "", run_id: null });
    db.close();
  });

  it("版 20: 開発ルールに版と消した印が付き、今あるルールは版 1 として残る。表・列を足すだけ", () => {
    const sql = PROJECT_MIGRATIONS[19]!;
    expect(sql).not.toMatch(/\bRENAME\b|\bDROP\b|_new\b|\bCHECK\b/i);
    const path = join(mkdtempSync(join(tmpdir(), "kuramoto-schema-")), "p.sqlite");
    const before = openDb(path, PROJECT_MIGRATIONS.slice(0, 19));
    before.exec(`
INSERT INTO dev_rules (id, name, body, applies_to, check_kind, on_fail, enabled) VALUES (1, 'a', 'b', 'branch', 'ai', 'review', 1), (2, 'c', 'd', 'code', 'ai', 'block', 0);
`);
    before.close();
    const db = openDb(path, PROJECT_MIGRATIONS);
    expect(get<{ user_version: number }>(db, "PRAGMA user_version")!.user_version).toBe(PROJECT_MIGRATIONS.length);
    const v = all<{ version: number; rules: string }>(db, "SELECT version, rules FROM dev_rule_versions");
    expect(v.map((x) => x.version)).toEqual([1]);
    expect(JSON.parse(v[0]!.rules)).toEqual([{ id: 1, name: "a", enabled: true }, { id: 2, name: "c", enabled: false }]);
    expect(all<{ deleted_at: string | null }>(db, "SELECT deleted_at FROM dev_rules").map((r) => r.deleted_at)).toEqual([null, null]);
    db.close();
    // ルールが無い DB でも版 1 ができる
    const empty = openDb(":memory:", PROJECT_MIGRATIONS);
    expect(all<{ version: number; rules: string }>(empty, "SELECT version, rules FROM dev_rule_versions")).toEqual([{ version: 1, rules: "[]" }]);
    empty.close();
  });

  it("メッセージの kind に ask / reply / member_chat を入れられる", () => {
    const db = openDb(":memory:", PROJECT_MIGRATIONS);
    for (const kind of ["ask", "reply", "member_chat"]) {
      db.prepare("INSERT INTO messages (to_role, kind, available_at, created_at) VALUES ('dev', ?, '', '')").run(kind);
    }
    expect(all<{ kind: string }>(db, "SELECT kind FROM messages ORDER BY id").map((m) => m.kind)).toEqual(["ask", "reply", "member_chat"]);
    db.close();
  });
});
