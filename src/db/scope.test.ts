import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HQ_MIGRATIONS, PROJECT_ID_TABLES, PROJECT_MIGRATIONS } from "./schema.js";
import { all, get, openDb } from "./sqlite.js";

/** 版 21(project_id)・本部の版 2(workspace_id)のマイグレーションの試験 */

const V21 = PROJECT_MIGRATIONS.length;
const BEFORE = PROJECT_MIGRATIONS.slice(0, V21 - 1);
const HQ_BEFORE = HQ_MIGRATIONS.slice(0, HQ_MIGRATIONS.length - 1);

const tmpPath = (name: string) => join(mkdtempSync(join(tmpdir(), "kuramoto-scope-")), name);
const version = (db: DatabaseSync) => get<{ user_version: number }>(db, "PRAGMA user_version")!.user_version;
const tableNames = (db: DatabaseSync) =>
  all<{ name: string }>(db, "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").map((t) => t.name);
const columns = (db: DatabaseSync, t: string) => all<{ name: string; notnull: number; dflt_value: string | null }>(db, `PRAGMA table_info(${t})`);
const schema = (db: DatabaseSync) => all<{ type: string; name: string; sql: string }>(db, "SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name");

/** 版 20 までを流した DB に、全部の表に 1 行ずつ入れて閉じる */
function v20Db(): string {
  const path = tmpPath("p.sqlite");
  const db = openDb(path, BEFORE);
  db.exec(`
INSERT INTO repos (id, full_name, role) VALUES (1, 'acme/shop', 'API');
INSERT INTO settings (key, value) VALUES ('k', 'v');
INSERT INTO formations (id, version, pull, created_at) VALUES (1, 1, 'down', '');
INSERT INTO units (id, formation_id, name, roles, max_members, summon_at, idle_sec) VALUES (1, 1, 'u', '[]', 1, 1, 1);
INSERT INTO policies (id, role, version, model, effort, focus, created_at) VALUES (1, 'dev', 1, 'm', 'high', '', '');
INSERT INTO dev_rules (id, name, body, applies_to, check_kind, on_fail) VALUES (1, 'r', 'b', '*', 'ai', 'review');
-- plan_stages・requirements は、版 2 が最初の行を入れている
INSERT INTO requirement_items (id, code, name, acceptance, added_in) VALUES (1, 'R1', 'n', 'a', 1);
INSERT INTO plan_artifacts (id, stage, version, kind, key, body) VALUES (1, 'req', 1, 'k', 'k', 'b');
INSERT INTO plan_comments (id, artifact_id, body) VALUES (1, 1, 'b');
INSERT INTO plan_open_items (id, stage, question, options, recommended) VALUES (1, 'req', 'q', '[]', 0);
INSERT INTO plan_messages (id, stage, who, body, at) VALUES (1, 'req', 'w', 'b', '');
INSERT INTO members (id, name, look, joined_at) VALUES (1, 'a', '{}', '');
INSERT INTO tickets (id, number, title, stage, created_at) VALUES (1, 1, 't', 'dev', '');
INSERT INTO sessions (id, member_id, ticket_id, repo_id, harness, harness_session_id, created_at, last_used_at) VALUES (1, 1, 1, 1, 'h', 's', '', '');
INSERT INTO pull_requests (id, ticket_id, repo_id, number, head) VALUES (1, 1, 1, 1, 'h');
INSERT INTO messages (id, to_role, kind, available_at, created_at) VALUES (1, 'dev', 'implement', '', '');
INSERT INTO runs (id, message_id, member_id, role, policy_id, formation_id, started_at) VALUES (1, 1, 1, 'dev', 1, 1, '');
INSERT INTO run_steps (id, run_id, at, kind, text) VALUES (1, 1, '', 'k', 't');
INSERT INTO reviews (id, ticket_id, role, round, run_id, verdict, created_at) VALUES (1, 1, 'review', 1, 1, 'approve', '');
INSERT INTO findings (id, review_id, category, severity, body, fingerprint) VALUES (1, 1, 'c', 'low', 'b', 'f');
INSERT INTO finding_comments (id, finding_id, role, action, at) VALUES (1, 1, 'r', 'raised', '');
INSERT INTO rule_violations (id, rule_id, ticket_id, handled, created_at) VALUES (1, 1, 1, 'review', '');
INSERT INTO decisions (id, ticket_id, question, options, recommended, why, impact, reversible, escalated) VALUES (1, 1, 'q', '[]', 0, 'w', 'i', 1, 0);
INSERT INTO merges (id, pr_id, result, checked, created_at) VALUES (1, 1, 'merged', '[]', '');
INSERT INTO conflicts (id, pr_id, detected_at) VALUES (1, 1, '');
INSERT INTO events (id, at, actor, type) VALUES (1, '', 'a', 't');
INSERT INTO ticket_notes (id, ticket_id, who, body, at) VALUES (1, 1, 'w', 'b', '');
INSERT INTO lead_messages (id, who, body, at) VALUES (1, 'owner', 'b', '');
INSERT INTO ticket_deps (ticket_id, depends_on) VALUES (1, 1);
INSERT INTO ticket_areas (ticket_id, area) VALUES (1, 'a');
INSERT INTO design_images (id, screen_key, kind, store_key, width, height, created_at) VALUES (1, 's', 'actual', 'k', 1, 1, '');
INSERT INTO ticket_questions (id, ticket_id, to_target, body, asked_at) VALUES (1, 1, 't', 'b', '');
INSERT INTO member_messages (id, member_id, who, body, at) VALUES (1, 1, 'w', 'b', '');
`);
  db.close();
  return path;
}

describe("版 21: プロジェクトの全部の表の project_id", () => {
  it("既存の DB を開くと流れ、全部の表の今ある行に、渡したプロジェクトの id が入る", () => {
    const path = v20Db();
    const db = openDb(path, PROJECT_MIGRATIONS, { projectId: 7 });
    expect(version(db)).toBe(V21);
    for (const t of PROJECT_ID_TABLES) {
      const rows = all<{ project_id: number }>(db, `SELECT project_id FROM ${t}`);
      expect(rows.length, `${t} の行`).toBeGreaterThan(0);
      expect(new Set(rows.map((r) => r.project_id)), t).toEqual(new Set([7]));
    }
    // 元の値は変わらない
    expect(get(db, "SELECT number, title FROM tickets")).toEqual({ number: 1, title: "t" });
    db.close();
  });

  it("プロジェクトの id を渡さなければ 0 のまま", () => {
    const db = openDb(v20Db(), PROJECT_MIGRATIONS);
    expect(all(db, "SELECT project_id FROM tickets")).toEqual([{ project_id: 0 }]);
    db.close();
  });

  it("新しい DB でも流れる。全部の表(PROJECT_ID_TABLES と一致)に project_id が NOT NULL DEFAULT 0 である", () => {
    const db = openDb(":memory:", PROJECT_MIGRATIONS, { projectId: 3 });
    expect(tableNames(db)).toEqual([...PROJECT_ID_TABLES].sort());
    for (const t of tableNames(db)) {
      expect(columns(db, t).find((c) => c.name === "project_id"), t).toMatchObject({ notnull: 1, dflt_value: "0" });
    }
    db.close();
  });

  it("足すだけ: 前の表・列・索引は残り(列は並びも同じ)、新しいものが足されるだけ", () => {
    const path = v20Db();
    const old = openDb(path, BEFORE);
    const oldSchema = schema(old);
    const oldCols = new Map(tableNames(old).map((t) => [t, columns(old, t).map((c) => c.name)]));
    old.close();
    const db = openDb(path, PROJECT_MIGRATIONS, { projectId: 1 });
    const now = new Map(schema(db).map((s) => [s.name, s]));
    for (const s of oldSchema) {
      if (s.type === "table") {
        // ALTER TABLE ADD COLUMN は、表の定義に列を足すだけ
        expect(now.get(s.name)?.sql, s.name).toMatch(/"?project_id"? integer (default 0 not null|not null default 0)/i);
        expect(columns(db, s.name).map((c) => c.name), s.name).toEqual([...oldCols.get(s.name)!, "project_id"]);
      } else {
        expect(now.get(s.name)?.sql, `${s.type} ${s.name}`).toBe(s.sql);
      }
    }
    expect(PROJECT_MIGRATIONS[V21 - 1]).toBeTypeOf("function");
    db.close();
  });

  it("索引は project_id が先頭で、project_id 込みの UNIQUE が tickets・formations・policies・settings・plan_stages・requirements・repos に張られる", () => {
    const db = openDb(":memory:", PROJECT_MIGRATIONS);
    const before = new Set(schema(openDb(":memory:", BEFORE)).map((s) => s.name));
    const added = all<{ name: string; tbl_name: string }>(db, "SELECT name, tbl_name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%'").filter((i) => !before.has(i.name));
    expect(added.length).toBeGreaterThan(0);
    for (const i of added) {
      expect(all<{ name: string }>(db, `PRAGMA index_info(${i.name})`)[0]!.name, i.name).toBe("project_id");
    }
    // どの表にも、project_id が先頭の索引が 1 つはある
    for (const t of PROJECT_ID_TABLES) expect(added.some((i) => i.tbl_name === t), t).toBe(true);
    const uniques = (t: string) =>
      all<{ name: string; unique: number }>(db, `PRAGMA index_list(${t})`)
        .filter((i) => i.unique && added.some((a) => a.name === i.name))
        .map((i) => all<{ name: string }>(db, `PRAGMA index_info(${i.name})`).map((c) => c.name));
    expect(uniques("tickets")).toEqual([["project_id", "number"]]);
    expect(uniques("formations")).toEqual([["project_id", "version"]]);
    expect(uniques("policies")).toEqual([["project_id", "role", "version"]]);
    expect(uniques("settings")).toEqual([["project_id", "key"]]);
    expect(uniques("plan_stages")).toEqual([["project_id", "stage"]]);
    expect(uniques("requirements")).toEqual([["project_id", "version"]]);
    expect(uniques("repos")).toEqual([["project_id", "full_name"]]);
    db.close();
  });

  it("project_id 込みの UNIQUE が効く(同じプロジェクトの同じ番号は入らない)", () => {
    const db = openDb(":memory:", PROJECT_MIGRATIONS);
    const add = (n: number, p: number) => db.prepare("INSERT INTO tickets (number, title, stage, created_at, project_id) VALUES (?, 't', 'dev', '', ?)").run(n, p);
    add(1, 1);
    expect(() => add(1, 1)).toThrow(/UNIQUE constraint failed/);
    add(2, 1);
    db.close();
  });

  it("前の版のコードで新しい DB が開ける(マイグレーションは流れず、project_id を書かない INSERT・SELECT * が動く)", () => {
    const path = v20Db();
    openDb(path, PROJECT_MIGRATIONS, { projectId: 5 }).close();
    const db = openDb(path, BEFORE);
    expect(version(db)).toBe(V21);
    db.exec(`
INSERT INTO tickets (id, number, title, stage, created_at) VALUES (2, 2, 't2', 'dev', '');
INSERT INTO settings (key, value) VALUES ('k2', 'v2');
INSERT INTO events (at, actor, type) VALUES ('', 'a', 't');
INSERT INTO plan_messages (stage, who, body, at) VALUES ('req', 'w', 'b', '');
INSERT INTO formations (version, pull, created_at) VALUES (2, 'start', '');
`);
    // 前の版のコードが入れた行は DEFAULT 0
    expect(all(db, "SELECT id, project_id FROM tickets ORDER BY id")).toEqual([{ id: 1, project_id: 5 }, { id: 2, project_id: 0 }]);
    expect(get(db, "SELECT * FROM settings WHERE key = 'k2'")).toMatchObject({ value: "v2", project_id: 0 });
    // 前の UNIQUE も残っている
    expect(() => db.exec("INSERT INTO tickets (number, title, stage, created_at) VALUES (2, 't', 'dev', '')")).toThrow(/UNIQUE constraint failed/);
    db.close();
  });

  it("本物のプロジェクトとして開くと、プロジェクトの id が渡る(Hq.openProject)", async () => {
    const { Hq } = await import("../hq.js");
    const { ManualClock } = await import("../clock.js");
    const home = mkdtempSync(join(tmpdir(), "kuramoto-scope-hq-"));
    const hq = new Hq(home, new ManualClock());
    // 前の版のコード(版 20 まで)が作った DB を置き、本部の id 9 のプロジェクトとして開く
    const dir = join(home, "acme", "old");
    const old = openDb(join(dir, "project.sqlite"), BEFORE);
    old.exec("INSERT INTO tickets (number, title, stage, created_at) VALUES (1, 't', 'dev', '')");
    old.close();
    hq.db.prepare("INSERT INTO projects (id, name, data_dir, status, created_at) VALUES (9, 'old', ?, 'running', '')").run(dir);
    const p = hq.openProject(9);
    expect(version(p.db)).toBe(V21);
    expect(all(p.db, "SELECT number, project_id FROM tickets")).toEqual([{ number: 1, project_id: 9 }]);
    p.close();
    hq.close();
  });
});

describe("本部の版 2: ワークスペース", () => {
  function hqV1(): string {
    const path = tmpPath("hq.sqlite");
    const db = openDb(path, HQ_BEFORE);
    db.exec(`
INSERT INTO projects (id, name, data_dir, status, created_at) VALUES (1, 'p', '/d', 'running', '');
INSERT INTO policy_templates (id, role, body) VALUES (1, 'dev', 'b');
INSERT INTO limits (key, value) VALUES ('budget', '10');
`);
    db.close();
    return path;
  }

  it("既存の DB を開くと流れ、workspaces に id=1「既定」ができ、既存の行は workspace_id = 1", () => {
    const db = openDb(hqV1(), HQ_MIGRATIONS);
    expect(version(db)).toBe(HQ_MIGRATIONS.length);
    expect(all(db, "SELECT id, name FROM workspaces")).toEqual([{ id: 1, name: "既定" }]);
    for (const t of ["projects", "limits", "policy_templates"]) {
      expect(all(db, `SELECT workspace_id FROM ${t}`), t).toEqual([{ workspace_id: 1 }]);
      expect(columns(db, t).find((c) => c.name === "workspace_id"), t).toMatchObject({ notnull: 1, dflt_value: "1" });
    }
    db.close();
  });

  it("新しい DB にも「既定」がある", () => {
    const db = openDb(":memory:", HQ_MIGRATIONS);
    expect(all(db, "SELECT id, name FROM workspaces")).toEqual([{ id: 1, name: "既定" }]);
    db.close();
  });

  it("projects の INDEX(workspace_id)、limits の UNIQUE(workspace_id, key)", () => {
    const db = openDb(":memory:", HQ_MIGRATIONS);
    const idx = (t: string) =>
      all<{ name: string; unique: number }>(db, `PRAGMA index_list(${t})`).map((i) => ({
        unique: i.unique === 1,
        cols: all<{ name: string }>(db, `PRAGMA index_info(${i.name})`).map((c) => c.name),
      }));
    expect(idx("projects")).toContainEqual({ unique: false, cols: ["workspace_id"] });
    expect(idx("limits")).toContainEqual({ unique: true, cols: ["workspace_id", "key"] });
    db.exec("INSERT INTO limits (key, value) VALUES ('a', '1')");
    db.exec("INSERT INTO limits (key, value, workspace_id) VALUES ('b', '1', 2)");
    expect(() => db.exec("INSERT INTO limits (key, value) VALUES ('a', '2')")).toThrow(/UNIQUE constraint failed/);
    db.close();
  });

  it("足すだけ: 前の表・列・索引は残る", () => {
    const path = hqV1();
    const old = openDb(path, HQ_BEFORE);
    const oldSchema = schema(old);
    old.close();
    const db = openDb(path, HQ_MIGRATIONS);
    const now = new Map(schema(db).map((s) => [s.name, s]));
    for (const s of oldSchema) {
      if (s.type === "index") expect(now.get(s.name)?.sql).toBe(s.sql);
      else expect(now.has(s.name), s.name).toBe(true);
    }
    expect(columns(db, "projects").map((c) => c.name)).toEqual(["id", "name", "data_dir", "status", "created_at", "workspace_id"]);
    db.close();
  });

  it("前の版のコードで新しい DB が開ける(workspace_id を書かない INSERT が動く)", () => {
    const path = hqV1();
    openDb(path, HQ_MIGRATIONS).close();
    const db = openDb(path, HQ_BEFORE);
    expect(version(db)).toBe(HQ_MIGRATIONS.length);
    db.exec(`
INSERT INTO projects (name, data_dir, status, created_at) VALUES ('q', '/e', 'planning', '');
INSERT INTO policy_templates (role, body) VALUES ('qa', 'b');
INSERT INTO limits (key, value) VALUES ('other', '1');
`);
    expect(all(db, "SELECT workspace_id FROM projects ORDER BY id")).toEqual([{ workspace_id: 1 }, { workspace_id: 1 }]);
    db.close();
  });
});
