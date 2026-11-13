import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PROJECT_MIGRATIONS as ALL_MIGRATIONS, V21_TABLES } from "./schema.js";
import { all, get, openDb } from "./sqlite.js";

/** 版 22: 前の版の UNIQUE(tickets.number・settings.key など)を project_id 込みだけにする(ADR-0040) */

const V21 = ALL_MIGRATIONS.slice(0, 21);
const V22 = 22;
/** 版 22 までのマイグレーション(後の版は、この試験の対象ではない) */
const PROJECT_MIGRATIONS = ALL_MIGRATIONS.slice(0, V22);

/** 版 22 で作り直す表と、その UNIQUE(主キーも含む。project_id が先頭) */
const REBUILT: Record<string, string[]> = {
  repos: ["project_id", "full_name"],
  settings: ["project_id", "key"],
  formations: ["project_id", "version"],
  policies: ["project_id", "role", "version"],
  plan_stages: ["project_id", "stage"],
  requirements: ["project_id", "version"],
  tickets: ["project_id", "number"],
  dev_rule_versions: ["project_id", "version"],
};

const version = (db: DatabaseSync) => get<{ user_version: number }>(db, "PRAGMA user_version")!.user_version;
const columns = (db: DatabaseSync, t: string) => all<{ name: string; type: string; notnull: number; dflt_value: string | null }>(db, `PRAGMA table_info(${t})`).map(({ name, type, notnull, dflt_value }) => ({ name, type, notnull, dflt_value }));
const schema = (db: DatabaseSync) => all<{ type: string; name: string; sql: string | null }>(db, "SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_autoindex%' ORDER BY name");
/** 表の UNIQUE(索引・主キー・表に書いた UNIQUE)の列の一覧。rowid の主キーは含まない */
const uniques = (db: DatabaseSync, t: string) =>
  all<{ name: string; unique: number }>(db, `PRAGMA index_list(${t})`)
    .filter((i) => i.unique)
    .map((i) => all<{ name: string }>(db, `PRAGMA index_info(${i.name})`).map((c) => c.name));

/** 版 21 まで流した DB に、全部の表へ 1 行ずつ入れる(外部キーでつながる行も)。プロジェクトの id 7 で埋める */
function v21Db(): string {
  const path = join(mkdtempSync(join(tmpdir(), "kuramoto-v22-")), "p.sqlite");
  const db = openDb(path, V21, { projectId: 7 });
  db.exec(`
INSERT INTO repos (id, full_name, role, project_id) VALUES (1, 'acme/shop', 'API', 7);
INSERT INTO settings (key, value, project_id) VALUES ('k', 'v', 7);
INSERT INTO formations (id, version, pull, created_at, project_id) VALUES (1, 1, 'down', '', 7);
INSERT INTO units (id, formation_id, name, roles, max_members, summon_at, idle_sec, project_id) VALUES (1, 1, 'u', '[]', 1, 1, 1, 7);
INSERT INTO policies (id, role, version, model, effort, focus, created_at, project_id) VALUES (1, 'dev', 1, 'm', 'high', '', '', 7);
INSERT INTO requirement_items (id, code, name, acceptance, added_in, project_id) VALUES (1, 'R1', 'n', 'a', 1, 7);
INSERT INTO members (id, name, look, joined_at, project_id) VALUES (1, 'a', '{}', '', 7);
INSERT INTO tickets (id, number, title, stage, owner_member_id, requirement_item_id, kind, dev_done, dropped_by, created_at, project_id)
  VALUES (1, 1, 't', 'review', 1, 1, 'bug', 1, 'lead', '', 7);
INSERT INTO sessions (id, member_id, ticket_id, repo_id, harness, harness_session_id, created_at, last_used_at, project_id) VALUES (1, 1, 1, 1, 'h', 's', '', '', 7);
INSERT INTO pull_requests (id, ticket_id, repo_id, number, head, project_id) VALUES (1, 1, 1, 1, 'h', 7);
INSERT INTO messages (id, to_role, kind, available_at, created_at, project_id) VALUES (1, 'dev', 'implement', '', '', 7);
INSERT INTO runs (id, message_id, ticket_id, member_id, role, policy_id, formation_id, started_at, project_id) VALUES (1, 1, 1, 1, 'dev', 1, 1, '', 7);
INSERT INTO reviews (id, ticket_id, role, round, run_id, verdict, created_at, project_id) VALUES (1, 1, 'review', 1, 1, 'approve', '', 7);
INSERT INTO ticket_deps (ticket_id, depends_on, project_id) VALUES (1, 1, 7);
INSERT INTO dev_rule_versions (version, rules, created_at, project_id) VALUES (2, '[]', '', 7);
`);
  db.close();
  return path;
}

describe("版 22: 前の UNIQUE を project_id 込みだけにする", () => {
  it("版 21 の DB を開くと流れ、行・id・値・project_id がそのまま残る", () => {
    const path = v21Db();
    const old = openDb(path, V21);
    const counts = Object.fromEntries(V21_TABLES.map((t) => [t, get<{ n: number }>(old, `SELECT COUNT(*) AS n FROM ${t}`)!.n]));
    const dump = Object.fromEntries(Object.keys(REBUILT).map((t) => [t, all(old, `SELECT * FROM ${t} ORDER BY project_id, 1, 2`)]));
    old.close();

    const db = openDb(path, PROJECT_MIGRATIONS, { projectId: 7 });
    expect(version(db)).toBe(V22);
    for (const t of V21_TABLES) expect(get<{ n: number }>(db, `SELECT COUNT(*) AS n FROM ${t}`)!.n, t).toBe(counts[t]);
    for (const t of Object.keys(REBUILT)) expect(all(db, `SELECT * FROM ${t} ORDER BY project_id, 1, 2`), t).toEqual(dump[t]);
    // 外部キーでつながった行は、つながったまま(DROP で壊れていない)
    expect(all(db, "PRAGMA foreign_key_check")).toEqual([]);
    expect(get(db, "SELECT t.number, r.id AS run, s.id AS session FROM tickets t JOIN runs r ON r.ticket_id = t.id JOIN sessions s ON s.ticket_id = t.id")).toEqual({ number: 1, run: 1, session: 1 });
    db.close();
  });

  it("外部キーは効いたまま(子が指す表は、作り直しても同じ名前を指す)", () => {
    const db = openDb(v21Db(), PROJECT_MIGRATIONS, { projectId: 7 });
    const refs = (t: string) => [...new Set(all<{ table: string }>(db, `PRAGMA foreign_key_list(${t})`).map((f) => f.table))].sort();
    expect(refs("runs")).toEqual(["formations", "members", "messages", "policies", "sessions", "tickets"]);
    expect(refs("sessions")).toEqual(["members", "repos", "tickets"]);
    expect(refs("tickets")).toEqual(["members", "requirement_items"]);
    expect(() => db.exec("INSERT INTO sessions (member_id, ticket_id, repo_id, harness, harness_session_id, created_at, last_used_at, project_id) VALUES (1, 99, 1, 'h', 's', '', '', 7)")).toThrow(/FOREIGN KEY/);
    expect(() => db.exec("DELETE FROM tickets WHERE id = 1")).toThrow(/FOREIGN KEY/);
    db.close();
  });

  it("作り直した表の列(名前・並び・型・NOT NULL・既定値)は版 21 と同じ", () => {
    const a = openDb(":memory:", V21);
    const b = openDb(":memory:", PROJECT_MIGRATIONS);
    for (const t of V21_TABLES) {
      // 主キーだった TEXT の列(settings.key・plan_stages.stage)は、版 21 では NULL が入れられた。版 22 は NOT NULL を明示する(厳しくなるだけ)
      const strict = (cols: ReturnType<typeof columns>) => cols.map((c) => ({ ...c, notnull: 0 }));
      expect(strict(columns(b, t)), t).toEqual(strict(columns(a, t)));
      for (const [i, c] of columns(a, t).entries()) expect(columns(b, t)[i]!.notnull, `${t}.${c.name}`).toBeGreaterThanOrEqual(c.notnull);
    }
    expect(columns(b, "tickets").at(-1)).toEqual({ name: "project_id", type: "INTEGER", notnull: 1, dflt_value: "0" });
    a.close();
    b.close();
  });

  it("作り直した表の CHECK は残っている", () => {
    const db = openDb(":memory:", PROJECT_MIGRATIONS);
    expect(() => db.exec("INSERT INTO tickets (number, title, stage, created_at) VALUES (1, 't', 'nope', '')")).toThrow(/CHECK/);
    expect(() => db.exec("INSERT INTO formations (version, pull, created_at) VALUES (1, 'nope', '')")).toThrow(/CHECK/);
    expect(() => db.exec("INSERT INTO plan_stages (stage, mode, version) VALUES ('nope', 'agree', 1)")).toThrow(/CHECK/);
    expect(() => db.exec("INSERT INTO plan_stages (stage, mode, version, project_id) VALUES ('infra', 'nope', 1, 5)")).toThrow(/CHECK/);
    db.exec("INSERT INTO plan_stages (stage, mode, version, project_id) VALUES ('infra', 'skip', 1, 5)");
    db.close();
  });

  it("UNIQUE は project_id 込みの 1 つだけ(前の UNIQUE・主キーは無い)", () => {
    const db = openDb(":memory:", PROJECT_MIGRATIONS);
    for (const [t, cols] of Object.entries(REBUILT)) expect(uniques(db, t), t).toEqual([cols]);
    db.close();
  });

  it("版 21 で足した索引は、置き換わったもの以外は同じ名前・同じ定義で残る", () => {
    const dbA = openDb(":memory:", V21);
    const dbB = openDb(":memory:", PROJECT_MIGRATIONS);
    const a = new Map(schema(dbA).map((s) => [`${s.type} ${s.name}`, s.sql]));
    const b = new Map(schema(dbB).map((s) => [`${s.type} ${s.name}`, s.sql]));
    // 主キーが (project_id, …) になった表の、project_id 込みの UNIQUE 索引は主キーが兼ねる
    const replaced = ["index settings_project_key", "index plan_stages_project_stage", "index dev_rule_versions_project"];
    for (const k of a.keys()) {
      if (replaced.includes(k)) {
        expect(b.has(k), k).toBe(false);
        continue;
      }
      expect(b.has(k), k).toBe(true);
      if (k.startsWith("index ")) {
        const def = (d: DatabaseSync, name: string) => ({
          unique: get<{ sql: string }>(d, "SELECT sql FROM sqlite_master WHERE name = ?", [name])!.sql.startsWith("CREATE UNIQUE"),
          columns: all<{ name: string }>(d, `PRAGMA index_info(${name})`).map((c) => c.name),
        });
        expect(def(dbB, k.slice(6)), k).toEqual(def(dbA, k.slice(6)));
      }
    }
    expect([...b.keys()].filter((k) => !a.has(k))).toEqual([]);
  });

  it("別のプロジェクトなら、同じ number・key・version・full_name・stage が入る(同じプロジェクトでは入らない)", () => {
    const db = openDb(":memory:", PROJECT_MIGRATIONS);
    const sqls: Record<string, (p: number) => string> = {
      tickets: (p) => `INSERT INTO tickets (number, title, stage, created_at, project_id) VALUES (1, 't', 'dev', '', ${p})`,
      settings: (p) => `INSERT INTO settings (key, value, project_id) VALUES ('k', 'v', ${p})`,
      repos: (p) => `INSERT INTO repos (full_name, role, project_id) VALUES ('acme/shop', 'API', ${p})`,
      formations: (p) => `INSERT INTO formations (version, pull, created_at, project_id) VALUES (1, 'down', '', ${p})`,
      policies: (p) => `INSERT INTO policies (role, version, model, effort, focus, created_at, project_id) VALUES ('dev', 1, 'm', 'high', '', '', ${p})`,
      requirements: (p) => `INSERT INTO requirements (version, created_at, project_id) VALUES (1, '', ${p})`,
      plan_stages: (p) => `INSERT INTO plan_stages (stage, mode, version, project_id) VALUES ('req', 'agree', 1, ${p})`,
      dev_rule_versions: (p) => `INSERT INTO dev_rule_versions (version, rules, created_at, project_id) VALUES (1, '[]', '', ${p})`,
    };
    expect(Object.keys(sqls).sort()).toEqual(Object.keys(REBUILT).sort());
    for (const [t, sql] of Object.entries(sqls)) {
      db.exec(sql(1));
      db.exec(sql(2));
      expect(() => db.exec(sql(2)), t).toThrow(/UNIQUE constraint failed/);
      expect(get<{ n: number }>(db, `SELECT COUNT(*) AS n FROM ${t} WHERE project_id IN (1, 2)`)!.n, t).toBe(2);
    }
    db.close();
  });

  it("settings は (project_id, key) で upsert できる", () => {
    const db = openDb(":memory:", PROJECT_MIGRATIONS);
    const put = (p: number, v: string) => db.prepare("INSERT INTO settings (key, value, project_id) VALUES ('k', ?, ?) ON CONFLICT(project_id, key) DO UPDATE SET value = excluded.value").run(v, p);
    put(1, "a");
    put(2, "b");
    put(1, "c");
    expect(all(db, "SELECT project_id, value FROM settings ORDER BY project_id")).toEqual([{ project_id: 1, value: "c" }, { project_id: 2, value: "b" }]);
    db.close();
  });

  it("残した UNIQUE(sessions・pull_requests・one_run_per_ticket)は、id でできているので別のプロジェクトでも変わらない", () => {
    const db = openDb(":memory:", PROJECT_MIGRATIONS);
    expect(uniques(db, "sessions")).toEqual([["member_id", "ticket_id", "repo_id"]]);
    expect(uniques(db, "pull_requests")).toEqual([["ticket_id", "repo_id"]]);
    expect(uniques(db, "runs")).toEqual([["ticket_id"]]);
    db.close();
  });

  it("前の版(21)のコードで開ける(マイグレーションは流れず、project_id を書かない INSERT が動く)", () => {
    const path = v21Db();
    openDb(path, PROJECT_MIGRATIONS, { projectId: 7 }).close();
    const db = openDb(path, V21);
    expect(version(db)).toBe(V22);
    db.exec("INSERT INTO tickets (number, title, stage, created_at) VALUES (2, 't2', 'dev', '')");
    db.exec("INSERT INTO settings (key, value) VALUES ('k2', 'v2')");
    expect(all(db, "SELECT number, project_id FROM tickets ORDER BY number")).toEqual([{ number: 1, project_id: 7 }, { number: 2, project_id: 0 }]);
    db.close();
  });

  it("2 回開いても変わらない(版は 22 のまま、行も同じ)", () => {
    const path = v21Db();
    openDb(path, PROJECT_MIGRATIONS, { projectId: 7 }).close();
    const db = openDb(path, PROJECT_MIGRATIONS, { projectId: 7 });
    expect(version(db)).toBe(V22);
    expect(all(db, "SELECT number, project_id FROM tickets")).toEqual([{ number: 1, project_id: 7 }]);
    db.close();
  });
});
