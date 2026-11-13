import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Connection } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ProjectDb } from "./conn.js";
import { deleteProjectRows, PROJECT_DELETE_ORDER } from "./delete-project.js";
import { connectMysql, type MysqlHandle } from "./mysql.js";
import { connectTest, MYSQL_TEST_URL, resetDatabase } from "./mysql-test-support.js";
import { PROJECT_ID_TABLES, PROJECT_MIGRATIONS } from "./schema.js";
import { openDb } from "./sqlite.js";

/** プロジェクトの削除: 対象の project_id の行が全部の表から消え、同じ database の別のプロジェクトの行は残る。SQLite と MySQL の両方で流す。 */

const admin: Connection | undefined = await connectTest();
afterAll(async () => {
  await admin?.end();
});

const AT = "2026-11-13T00:00:00.000Z";

/** 全部の表(PROJECT_ID_TABLES)に、外部キーでつながる行を 1 行以上入れる。名前に tag を入れて、プロジェクトごとに区別する。 */
async function seed(pdb: ProjectDb, tag: string): Promise<void> {
  const add = async (table: string, values: Record<string, unknown>): Promise<number> => pdb.dialect.insertedId(pdb.insert(table as never, values) as never);
  // id を持たない表(主キーが別・主キー無し)は、挿入した id を返せない
  const put = async (table: string, values: Record<string, unknown>): Promise<void> => void (await pdb.insert(table as never, values).execute());
  const formation = await add("formations", { version: 1, pull: "down", created_at: AT, routes: "[]", flows: "{}" });
  const unit = await add("units", { formation_id: formation, name: `u-${tag}`, roles: "[]", max_members: 1, summon_at: 1, idle_sec: 1 });
  const policy = await add("policies", { role: "dev", version: 1, model: "m", effort: "high", focus: "", created_at: AT });
  const member = await add("members", { unit_id: unit, name: `m-${tag}`, look: "{}", joined_at: AT });
  const repo = await add("repos", { full_name: `acme/${tag}`, role: "API" });
  await put("settings", { key: "project_name", value: tag });
  const reqItem = await add("requirement_items", { code: "R1", name: "n", acceptance: "a", added_in: 1 });
  await add("requirements", { version: 1, created_at: AT });
  const ticket = await add("tickets", { number: 1, title: `t-${tag}`, stage: "dev", owner_member_id: member, requirement_item_id: reqItem, created_at: AT });
  await put("ticket_deps", { ticket_id: ticket, depends_on: ticket });
  await put("ticket_areas", { ticket_id: ticket, area: "a" });
  await add("ticket_notes", { ticket_id: ticket, who: "w", body: "b", at: AT });
  await add("ticket_questions", { ticket_id: ticket, to_target: "t", body: "b", asked_at: AT });
  await add("member_messages", { member_id: member, ticket_id: ticket, who: "w", body: "b", at: AT });
  await add("design_images", { ticket_id: ticket, screen_key: "s", kind: "actual", store_key: `k-${tag}`, width: 1, height: 1, created_at: AT });
  const session = await add("sessions", { member_id: member, ticket_id: ticket, repo_id: repo, harness: "h", harness_session_id: "s", created_at: AT, last_used_at: AT });
  const pr = await add("pull_requests", { ticket_id: ticket, repo_id: repo, number: 1, head: "h" });
  await add("merges", { pr_id: pr, result: "merged", checked: "[]", created_at: AT });
  await add("conflicts", { pr_id: pr, detected_at: AT });
  const message = await add("messages", { ticket_id: ticket, to_role: "dev", kind: "implement", available_at: AT, created_at: AT });
  const run = await add("runs", { message_id: message, ticket_id: ticket, member_id: member, role: "dev", session_id: session, policy_id: policy, formation_id: formation, started_at: AT });
  await add("run_steps", { run_id: run, at: AT, kind: "k", text: "t" });
  const review = await add("reviews", { ticket_id: ticket, role: "review", round: 1, run_id: run, verdict: "approve", created_at: AT });
  const finding = await add("findings", { review_id: review, category: "c", severity: "low", body: "b", fingerprint: "f" });
  await add("finding_comments", { finding_id: finding, role: "r", action: "raised", at: AT });
  const rule = await add("dev_rules", { name: "r", body: "b", applies_to: "*", check_kind: "ai", on_fail: "review" });
  await add("rule_violations", { rule_id: rule, ticket_id: ticket, handled: "review", created_at: AT, run_id: run });
  await put("dev_rule_versions", { version: 1, rules: "[]", created_at: AT });
  await add("decisions", { ticket_id: ticket, question: "q", options: "[]", recommended: 0, why: "w", impact: "i", reversible: 1, escalated: 0 });
  await add("events", { at: AT, actor: "a", type: "t", ticket_id: ticket });
  await add("lead_messages", { who: "owner", body: "b", at: AT });
  await put("plan_stages", { stage: "req", mode: "agree", version: 1 });
  const artifact = await add("plan_artifacts", { stage: "req", version: 1, kind: "k", key: "k", body: "b" });
  await add("plan_comments", { artifact_id: artifact, body: "b" });
  await add("plan_open_items", { stage: "req", question: "q", options: "[]", recommended: 0 });
  await add("plan_messages", { stage: "req", who: "w", body: "b", at: AT });
}

/** 表ごとの、プロジェクト(project_id)の行数 */
async function counts(pdb: ProjectDb): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const t of PROJECT_ID_TABLES) out[t] = (await pdb.from(t as never).execute()).length;
  return out;
}

const zeros = Object.fromEntries(PROJECT_ID_TABLES.map((t) => [t, 0]));

/** 2 つのプロジェクトを同じ database に入れて、1 つ目を消す */
async function scenario(open: (id: number) => ProjectDb): Promise<void> {
  const a = open(1);
  const b = open(2);
  await seed(a, "a");
  await seed(b, "b");
  const beforeA = await counts(a);
  const beforeB = await counts(b);
  // どの表にも、消す側と残す側の行がある(seed が全部の表に入れている)
  for (const t of PROJECT_ID_TABLES) {
    expect(beforeA[t], t).toBeGreaterThan(0);
    expect(beforeB[t], t).toBeGreaterThan(0);
  }

  const deleted = await deleteProjectRows(a);
  expect(deleted.tickets).toBe(1);
  expect(await counts(a)).toEqual(zeros);
  // 別のプロジェクトの行は 1 行も減らない・変わらない
  expect(await counts(b)).toEqual(beforeB);
  expect((await b.from("tickets").executeTakeFirstOrThrow()).title).toBe("t-b");
  expect((await b.from("settings").executeTakeFirstOrThrow()).value).toBe("b");
}

describe("プロジェクトの行の削除", () => {
  it("消す順は、project_id を持つ全部の表をちょうど 1 回ずつ含む", () => {
    expect([...PROJECT_DELETE_ORDER].sort()).toEqual([...PROJECT_ID_TABLES].sort());
  });

  it("SQLite: 対象の行が全部の表から消え、同じファイルの別のプロジェクトの行は残る", async () => {
    const db = openDb(join(mkdtempSync(join(tmpdir(), "kuramoto-del-")), "p.sqlite"), PROJECT_MIGRATIONS);
    await scenario((id) => new ProjectDb(db, id));
    db.close();
  });

  it("SQLite: 途中で落ちたら何も消えない(1 つのトランザクション)", async () => {
    const db = openDb(join(mkdtempSync(join(tmpdir(), "kuramoto-del-")), "p.sqlite"), PROJECT_MIGRATIONS);
    const pdb = new ProjectDb(db, 1);
    await seed(pdb, "a");
    const before = await counts(pdb);
    // 子の表を消したあと、親の表で落とす(events の削除の途中で壊す)
    db.exec("CREATE TRIGGER boom BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT, 'boom'); END");
    await expect(deleteProjectRows(pdb)).rejects.toThrow();
    expect(await counts(pdb)).toEqual(before);
    db.close();
  });
});

describe.skipIf(!admin)("プロジェクトの行の削除(MySQL の実機)", () => {
  let handle: MysqlHandle;
  beforeAll(async () => {
    await resetDatabase(admin!);
    handle = (await connectMysql({ url: MYSQL_TEST_URL })).handle;
  });
  afterAll(async () => {
    await handle?.close();
  });

  it("対象の行が全部の表から消え、同じ database の別のプロジェクトの行は残る", async () => {
    const ids: number[] = [];
    for (const name of ["a", "b"]) {
      ids.push(await handle.kysely.insertInto("projects").values({ name, data_dir: `/d/${name}`, status: "planning", created_at: AT, workspace_id: 1 }).executeTakeFirst().then((r) => Number(r.insertId)));
    }
    await scenario((id) => new ProjectDb(handle.kysely, ids[id - 1]!));
  });
});
