import type { DatabaseSync } from "node:sqlite";
import type { Connection } from "mysql2/promise";
import { backfillDevDone } from "./mysql-backfill.js";
import { PROJECT_MIGRATIONS } from "./schema.js";
import { all, get } from "./sqlite.js";

/**
 * SQLite(本部 hq.sqlite と、プロジェクトごとの project.sqlite)から MySQL へデータを移す道具(ADR-0038)。
 *
 * 移し先は、migrateMysql で最新の版まで流した、プロジェクトがまだ 1 つも入っていない database。
 * 移し元は、本部が版 2、プロジェクトが版 22 まで流してある DB(openDb が流す)。
 *
 * 流れ(全部を 1 つのトランザクションで。途中で失敗したら全部巻き戻す):
 *  1. 本部の workspaces・limits・policy_templates・projects を、id のまま入れる。
 *  2. プロジェクトごとに、全部の表を親から順に入れる。
 *     id は「移し先のその表の最大の id + 元の id」に付け替える(1 つの database に複数のプロジェクトが入り、id が重ならないようにするため。
 *     最初のプロジェクトは、空の database に入れるので id のまま)。他の表を指す列と、受信箱の payload・events の data に入っている id も同じ付け替えをする。
 *  3. そのプロジェクトの tickets と runs を入れ終えたあとで backfillDevDone(conn, projectId) を呼ぶ(呼び忘れると、dev_done が全部 0 =「開発前」になり、
 *     開発より前へ戻せてしまう)。
 */

/** 移す表(親が先)と、他の表の id を指す列。id 列を持たない表は、列だけを書く。 */
export const TRANSFER_TABLES: [table: string, refs: Record<string, string>][] = [
  ["repos", {}],
  ["formations", {}],
  ["units", { formation_id: "formations" }],
  ["policies", {}],
  ["dev_rules", {}],
  ["plan_stages", {}],
  ["requirements", {}],
  ["requirement_items", {}],
  ["plan_artifacts", {}],
  ["plan_comments", { artifact_id: "plan_artifacts" }],
  ["plan_open_items", {}],
  ["plan_messages", {}],
  ["members", { unit_id: "units" }],
  ["tickets", { owner_member_id: "members", requirement_item_id: "requirement_items" }],
  ["sessions", { member_id: "members", ticket_id: "tickets", repo_id: "repos" }],
  ["pull_requests", { ticket_id: "tickets", repo_id: "repos" }],
  ["ticket_notes", { ticket_id: "tickets" }],
  ["ticket_deps", { ticket_id: "tickets", depends_on: "tickets" }],
  ["ticket_areas", { ticket_id: "tickets" }],
  ["ticket_questions", { ticket_id: "tickets", from_member_id: "members", answered_by_member_id: "members" }],
  ["member_messages", { member_id: "members", ticket_id: "tickets" }],
  ["github_issues", { ticket_id: "tickets" }],
  ["lead_messages", {}],
  ["design_images", { ticket_id: "tickets" }],
  ["messages", { ticket_id: "tickets", to_member_id: "members" }],
  ["runs", { message_id: "messages", ticket_id: "tickets", member_id: "members", session_id: "sessions", policy_id: "policies", formation_id: "formations", about_ticket_id: "tickets" }],
  ["run_steps", { run_id: "runs" }],
  ["reviews", { ticket_id: "tickets", run_id: "runs" }],
  ["findings", { review_id: "reviews" }],
  ["finding_comments", { finding_id: "findings", member_id: "members" }],
  ["rule_violations", { rule_id: "dev_rules", ticket_id: "tickets", run_id: "runs" }],
  ["decisions", { ticket_id: "tickets" }],
  ["merges", { pr_id: "pull_requests" }],
  ["conflicts", { pr_id: "pull_requests", cause_pr_id: "pull_requests" }],
  ["events", { ticket_id: "tickets" }],
  ["settings", {}],
  ["dev_rule_versions", {}],
];

/** payload(受信箱)・data(events)の JSON の中の、id を持つキー(どの深さでも)。 */
const JSON_ID_KEYS: Record<string, string> = {
  decision_id: "decisions",
  toMemberId: "members",
  memberId: "members",
  runId: "runs",
  run_id: "runs",
  unit_id: "units",
  questionId: "ticket_questions",
};
const JSON_COLUMNS: Record<string, string> = { messages: "payload", events: "data" };

export type TransferResult = {
  projects: { id: number; name: string; tickets: number; devDone: number }[];
};

type Mapper = (table: string, id: number) => number;

function remapJson(text: string, map: Mapper): string {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return text;
  }
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      return Object.fromEntries(
        Object.entries(v).map(([k, x]) => [k, typeof x === "number" && JSON_ID_KEYS[k] ? map(JSON_ID_KEYS[k]!, x) : walk(x)]),
      );
    }
    return v;
  };
  return JSON.stringify(walk(value));
}

const q = (name: string) => `\`${name}\``;
const BATCH = 200;

/**
 * 1 つのプロジェクトの DB の中身を、MySQL の projects.id = projectId のプロジェクトへ入れ、最後に backfillDevDone を呼ぶ。
 * projects の行は呼び出し側が先に入れておく。トランザクションも呼び出し側が持つ。返すのは backfill で 0 から 1 にした件数。
 */
export async function transferProject(conn: Connection, src: DatabaseSync, projectId: number): Promise<{ devDone: number }> {
  // 付け替えの基準(移し先のいまの最大の id)は、入れ始める前に全部の表で取る
  const base = new Map<string, number>();
  for (const [table] of TRANSFER_TABLES) {
    if (!hasId(src, table)) continue;
    const [rows] = await conn.query<any[]>(`SELECT COALESCE(MAX(id), 0) AS m FROM ${q(table)}`);
    base.set(table, Number(rows[0].m));
  }
  const map: Mapper = (table, id) => id + (base.get(table) ?? 0);

  for (const [table, refs] of TRANSFER_TABLES) {
    const cols = all<{ name: string }>(src, `PRAGMA table_info(${table})`).map((c) => c.name);
    const rows = all<Record<string, unknown>>(src, `SELECT * FROM ${q(table)}`);
    const jsonCol = JSON_COLUMNS[table];
    const insertCols = cols.filter((c) => c !== "project_id");
    const values = rows.map((row) => [
      ...insertCols.map((c) => {
        const v = row[c];
        if (v === null || v === undefined) return null;
        if (c === "id") return map(table, Number(v));
        if (refs[c]) return map(refs[c]!, Number(v));
        if (c === jsonCol && typeof v === "string") return remapJson(v, map);
        return v;
      }),
      projectId,
    ]);
    const sql = `INSERT INTO ${q(table)} (${[...insertCols, "project_id"].map(q).join(", ")}) VALUES ?`;
    for (let i = 0; i < values.length; i += BATCH) await conn.query(sql, [values.slice(i, i + BATCH)]);
  }

  // tickets と runs を入れ終えたあと。SQLite の版 19 と同じ決まりで dev_done を埋める(ADR-0038)
  return { devDone: await backfillDevDone(conn, projectId) };
}

function hasId(db: DatabaseSync, table: string): boolean {
  return all<{ name: string }>(db, `PRAGMA table_info(${table})`).some((c) => c.name === "id");
}

/**
 * 本部とプロジェクトの全部を、SQLite から MySQL へ移す。
 * openProject は、本部の projects の行(id・data_dir)から、そのプロジェクトの DB を開いて返す(最新の版まで流してあること)。移したあとに閉じる。
 * 移し先にプロジェクトがすでに 1 つでも入っているときは、何もせずに投げる(二重に入れない)。
 */
export async function transferSqliteToMysql(
  conn: Connection,
  hq: DatabaseSync,
  openProject: (project: { id: number; name: string; data_dir: string }) => DatabaseSync,
): Promise<TransferResult> {
  const [existing] = await conn.query<any[]>("SELECT COUNT(*) AS n FROM projects");
  if (Number(existing[0].n) > 0) throw new Error("移し先の database にはすでにプロジェクトが入っています。空の database に移してください");
  const hqVersion = get<{ user_version: number }>(hq, "PRAGMA user_version")!.user_version;
  if (hqVersion < 2) throw new Error(`本部の DB の版が古いです(${hqVersion})。Kuramoto を一度起動して最新の版にしてから移してください`);

  const result: TransferResult = { projects: [] };
  await conn.beginTransaction();
  try {
    const insert = async (table: string, rows: Record<string, unknown>[], cols: string[], onDup?: "ignore" | "update-name") => {
      if (rows.length === 0) return;
      const sql = `INSERT ${onDup === "ignore" ? "IGNORE " : ""}INTO ${q(table)} (${cols.map(q).join(", ")}) VALUES ?${onDup === "update-name" ? " ON DUPLICATE KEY UPDATE name = VALUES(name)" : ""}`;
      await conn.query(sql, [rows.map((r) => cols.map((c) => r[c] ?? null))]);
    };
    await insert("workspaces", all(hq, "SELECT id, name FROM workspaces"), ["id", "name"], "update-name"); // 最初の版が入れた id=1「既定」も、元の名前にする
    await insert("limits", all(hq, "SELECT workspace_id, key, value FROM limits"), ["workspace_id", "key", "value"], "ignore");
    await insert("policy_templates", all(hq, "SELECT id, role, body, workspace_id FROM policy_templates"), ["id", "role", "body", "workspace_id"]);
    const projects = all<{ id: number; name: string; data_dir: string; status: string; created_at: string; workspace_id: number }>(
      hq,
      "SELECT id, name, data_dir, status, created_at, workspace_id FROM projects ORDER BY id",
    );
    await insert("projects", projects, ["id", "name", "data_dir", "status", "created_at", "workspace_id"]);

    for (const p of projects) {
      const src = openProject(p);
      try {
        const version = get<{ user_version: number }>(src, "PRAGMA user_version")!.user_version;
        const latest = PROJECT_MIGRATIONS.length;
        if (version < latest) throw new Error(`プロジェクト ${p.id}(${p.name})の DB の版が古いです(${version})。最新の版(${latest})にしてから移してください`);
        const { devDone } = await transferProject(conn, src, p.id);
        const tickets = get<{ n: number }>(src, "SELECT COUNT(*) AS n FROM tickets")!.n;
        result.projects.push({ id: p.id, name: p.name, tickets, devDone });
      } finally {
        src.close();
      }
    }
    await conn.commit();
  } catch (e) {
    await conn.rollback();
    throw e;
  }
  return result;
}
