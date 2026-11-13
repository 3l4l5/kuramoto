/**
 * MySQL 用のマイグレーション(ADR-0038)。
 *
 * SQLite の本部 DB(版 2)とプロジェクト DB(版 21)を合わせた形を、MySQL の最初の版として丸ごと作る。
 * 版の番号は SQLite のプロジェクト DB と同じ(21)。以後の版(22〜)は、同じ番号で SQLite にも MySQL にも流す。
 * 1 版 = 1 つの DDL(statements を順に流す)。MySQL の DDL はトランザクションで巻き戻せないので、
 * 途中で止まっても流し直せるよう、すべて IF NOT EXISTS / INSERT IGNORE で書く(索引は CREATE TABLE の中に書く)。
 *
 * SQLite との違い(形は同じで、MySQL で書き表せないところだけ変える):
 *  - id は BIGINT AUTO_INCREMENT。他の表を指す列も BIGINT。
 *  - 索引・UNIQUE・主キーに入る文字列は VARCHAR(191)。それ以外の文字列は TEXT。REAL は DOUBLE。
 *  - TEXT の既定値は式で書く(DEFAULT ('[]'))。
 *  - one_run_per_ticket(開発中の起動はチケットに 1 つ)は、部分索引が無いので生成列 active_ticket_id の UNIQUE にする。
 *  - project_id は全部の表にあり、projects(id) への外部キーを張る。既定値は無い(SQLite の 0 は「どのプロジェクトでもない」印だった)。
 *    1 つの database に複数のプロジェクトが入るので、UNIQUE・主キーは project_id 込みだけにする(tickets の number など)。
 *    SQLite は版 22 でこの形に揃う(版 21 は前の UNIQUE を残していた)。
 *  - 本部 DB と同じ database に入れるので、repos は 1 つにまとめる(本部の列 = プロジェクトの列)。
 *  - 最初の行は workspaces の id=1「既定」だけ。plan_stages・requirements の最初の行などは、プロジェクトを作るときに入れる。
 */

/** 1 つの版。version は SQLite と同じ番号、statements はその版で流す DDL(順に流す)。 */
export type MysqlMigration = { version: number; statements: string[] };

const TAIL = "ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin";

/** 本部の表(project_id を持たない) */
function plain(name: string, defs: string[]): string {
  return `CREATE TABLE IF NOT EXISTS \`${name}\` (\n  ${defs.join(",\n  ")}\n) ${TAIL}`;
}

/** プロジェクトの表。列の最後に project_id と、projects(id) への外部キーを足す */
function scoped(name: string, defs: string[]): string {
  return plain(name, [...defs, "project_id BIGINT NOT NULL", `CONSTRAINT fk_${name}_project FOREIGN KEY (project_id) REFERENCES projects(id)`]);
}

const ID = "id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY";
const T = "TEXT NOT NULL";
const S = "VARCHAR(191) NOT NULL";
const BIG = "BIGINT NOT NULL";
const fk = (col: string, table: string) => `FOREIGN KEY (${col}) REFERENCES ${table}(id)`;
const enumCheck = (col: string, values: string[]) => `CHECK (${col} IN (${values.map((v) => `'${v}'`).join(",")}))`;

const FIRST: string[] = [
  // ---- 本部 ----
  plain("workspaces", [ID, `name ${T}`]),
  "INSERT IGNORE INTO workspaces (id, name) VALUES (1, '既定')",
  plain("projects", [
    ID, `name ${T}`, `data_dir ${S}`,
    `status VARCHAR(191) NOT NULL ${enumCheck("status", ["planning", "defining", "starting", "running", "archived"])}`,
    `created_at ${T}`, `workspace_id ${BIG} DEFAULT 1`,
    "UNIQUE KEY projects_data_dir (data_dir)", "KEY projects_workspace (workspace_id)", fk("workspace_id", "workspaces"),
  ]),
  plain("policy_templates", [ID, `role ${T}`, `body ${T}`, `workspace_id ${BIG} DEFAULT 1`, fk("workspace_id", "workspaces")]),
  plain("limits", [`workspace_id ${BIG} DEFAULT 1`, `\`key\` ${S}`, `value ${T}`, "PRIMARY KEY (workspace_id, `key`)", fk("workspace_id", "workspaces")]),

  // ---- 設定 ----
  scoped("repos", [ID, `full_name ${S}`, `role ${T}`, "UNIQUE KEY repos_project_full_name (project_id, full_name)"]),
  scoped("settings", [`\`key\` ${S}`, `value ${T}`, "PRIMARY KEY (project_id, `key`)"]),
  scoped("formations", [
    ID, `version INT NOT NULL`, `pull VARCHAR(191) NOT NULL ${enumCheck("pull", ["down", "start"])}`, `created_at ${T}`,
    "routes TEXT NOT NULL DEFAULT ('[]')", "flows TEXT NOT NULL DEFAULT ('{}')",
    "UNIQUE KEY formations_project_version (project_id, version)",
  ]),
  scoped("units", [
    ID, `formation_id ${BIG}`, `name ${T}`, `roles ${T}`, "max_members INT NOT NULL", "summon_at INT NOT NULL", "idle_sec INT NOT NULL",
    "repos TEXT NOT NULL DEFAULT ('[]')", "model TEXT", "effort TEXT", "focus TEXT", "budget_usd DOUBLE",
    fk("formation_id", "formations"),
  ]),
  scoped("policies", [
    ID, `role ${S}`, "version INT NOT NULL", `model ${T}`, `effort ${T}`, `focus ${T}`,
    "options TEXT NOT NULL DEFAULT ('{}')", "harness TEXT NOT NULL DEFAULT ('claude-agent-sdk')", `created_at ${T}`,
    "UNIQUE KEY policies_project_role_version (project_id, role, version)",
  ]),
  scoped("dev_rules", [
    ID, `name ${T}`, `body ${T}`, `applies_to ${T}`,
    `check_kind VARCHAR(191) NOT NULL ${enumCheck("check_kind", ["pattern", "ai"])}`, "pattern TEXT",
    `on_fail VARCHAR(191) NOT NULL ${enumCheck("on_fail", ["autofix", "review", "block"])}`,
    "enabled INT NOT NULL DEFAULT 1", "template TEXT", "created_at TEXT NOT NULL DEFAULT ('')", "deleted_at TEXT",
  ]),
  scoped("dev_rule_versions", [`version INT NOT NULL`, `rules ${T}`, `created_at ${T}`, "PRIMARY KEY (project_id, version)"]),

  // ---- 企画 ----
  scoped("plan_stages", [
    `stage ${S} ${enumCheck("stage", ["req", "infra", "flow", "screen", "model"])}`,
    `mode VARCHAR(191) NOT NULL ${enumCheck("mode", ["agree", "delegate", "skip"])}`, "version INT NOT NULL", "agreed_version INT",
    "PRIMARY KEY (project_id, stage)",
  ]),
  scoped("requirements", [ID, "version INT NOT NULL", `created_at ${T}`, "UNIQUE KEY requirements_project_version (project_id, version)"]),
  scoped("requirement_items", [ID, `code ${T}`, `name ${T}`, `acceptance ${T}`, "added_in INT NOT NULL", "removed_in INT"]),
  scoped("plan_artifacts", [ID, `stage ${T}`, "version INT NOT NULL", `kind ${T}`, `\`key\` ${T}`, `body ${T}`, "chosen INT NOT NULL DEFAULT 0"]),
  scoped("plan_comments", [
    ID, `artifact_id ${BIG}`, "x DOUBLE", "y DOUBLE", `body ${T}`, "resolved_in INT", "variant TEXT", "created_at TEXT NOT NULL DEFAULT ('')",
    fk("artifact_id", "plan_artifacts"),
  ]),
  scoped("plan_open_items", [
    ID, `stage ${T}`, `question ${T}`, `options ${T}`, "recommended INT NOT NULL", "answer TEXT", "decided_by TEXT",
    "why TEXT NOT NULL DEFAULT ('')", "reversible INT NOT NULL DEFAULT 1", "created_at TEXT NOT NULL DEFAULT ('')", "answered_at TEXT", "withdrawn TEXT",
  ]),
  scoped("plan_messages", [ID, `stage ${T}`, `who ${T}`, `body ${T}`, `at ${T}`]),

  // ---- チームとチケット ----
  scoped("members", [
    ID, "unit_id BIGINT", `name ${T}`, `look ${T}`, "is_base INT NOT NULL DEFAULT 0", `joined_at ${T}`, "left_at TEXT", fk("unit_id", "units"),
  ]),
  scoped("tickets", [
    ID, "number INT NOT NULL", "jira_key TEXT", `title ${T}`, "body TEXT NOT NULL DEFAULT ('')",
    `stage VARCHAR(191) NOT NULL ${enumCheck("stage", ["dev", "review", "sec", "qa", "decision", "merge", "done", "dropped"])}`,
    "owner_member_id BIGINT", "requirement_item_id BIGINT", "plan_refs TEXT NOT NULL DEFAULT ('{}')",
    "rounds INT NOT NULL DEFAULT 0", `created_at ${T}`, "done_at TEXT", "active_ms BIGINT NOT NULL DEFAULT 0",
    "triaged INT NOT NULL DEFAULT 1", "dropped_by TEXT", "dropped_reason TEXT", "dropped_at TEXT",
    "kind TEXT NOT NULL DEFAULT ('feature')", "dev_done INT NOT NULL DEFAULT 0",
    "UNIQUE KEY tickets_project_number (project_id, number)",
    fk("owner_member_id", "members"), fk("requirement_item_id", "requirement_items"),
  ]),
  scoped("sessions", [
    ID, `member_id ${BIG}`, `ticket_id ${BIG}`, `repo_id ${BIG}`, `harness ${T}`, `harness_session_id ${T}`,
    "worktree_path TEXT", "branch TEXT", `created_at ${T}`, `last_used_at ${T}`,
    "UNIQUE KEY sessions_project_member_ticket_repo (project_id, member_id, ticket_id, repo_id)",
    fk("member_id", "members"), fk("ticket_id", "tickets"), fk("repo_id", "repos"),
  ]),
  scoped("pull_requests", [
    ID, `ticket_id ${BIG}`, `repo_id ${BIG}`, "number INT NOT NULL", `head ${T}`, "gh_state TEXT", "mergeable TEXT", "ci TEXT", "fetched_at TEXT",
    "UNIQUE KEY pull_requests_ticket_repo (ticket_id, repo_id)", fk("ticket_id", "tickets"), fk("repo_id", "repos"),
  ]),
  scoped("ticket_notes", [ID, `ticket_id ${BIG}`, `who ${T}`, `body ${T}`, `at ${T}`, "kind TEXT NOT NULL DEFAULT ('note')", fk("ticket_id", "tickets")]),
  scoped("ticket_deps", [
    `ticket_id ${BIG}`, `depends_on ${BIG}`, "PRIMARY KEY (ticket_id, depends_on)", "KEY ticket_deps_project_dep (project_id, depends_on)",
    fk("ticket_id", "tickets"), "FOREIGN KEY (depends_on) REFERENCES tickets(id)",
  ]),
  scoped("ticket_areas", [
    `ticket_id ${BIG}`, `area ${S}`, "PRIMARY KEY (ticket_id, area)", "KEY ticket_areas_project_area (project_id, area)", fk("ticket_id", "tickets"),
  ]),
  scoped("ticket_questions", [
    ID, `ticket_id ${BIG}`, "from_member_id BIGINT", `to_target ${T}`, `body ${T}`, "routed_to_lead INT NOT NULL DEFAULT 0",
    "answer TEXT", "answered_by_member_id BIGINT", `asked_at ${T}`, "answered_at TEXT",
    "KEY ticket_questions_project_ticket (project_id, ticket_id)",
    fk("ticket_id", "tickets"), fk("from_member_id", "members"), fk("answered_by_member_id", "members"),
  ]),
  scoped("member_messages", [
    ID, `member_id ${BIG}`, "ticket_id BIGINT", `who ${T}`, `body ${T}`, `at ${T}`,
    "KEY member_messages_project_member (project_id, member_id, id)", fk("member_id", "members"), fk("ticket_id", "tickets"),
  ]),
  scoped("lead_messages", [ID, `who VARCHAR(191) NOT NULL ${enumCheck("who", ["owner", "lead", "system"])}`, `body ${T}`, `at ${T}`]),
  scoped("design_images", [
    ID, "ticket_id BIGINT", `screen_key ${S}`, `kind VARCHAR(191) NOT NULL ${enumCheck("kind", ["reference", "actual", "diff"])}`,
    `store_key ${T}`, "width INT NOT NULL", "height INT NOT NULL", "diff_ratio DOUBLE", `created_at ${T}`,
    "KEY design_images_project_ticket (project_id, ticket_id, screen_key)", fk("ticket_id", "tickets"),
  ]),

  // ---- 受信箱と起動の記録 ----
  scoped("messages", [
    ID, "ticket_id BIGINT", `to_role ${T}`, "to_member_id BIGINT", `kind ${S}`, "payload TEXT NOT NULL DEFAULT ('{}')",
    `status VARCHAR(191) NOT NULL DEFAULT 'pending' ${enumCheck("status", ["pending", "claimed", "done", "failed"])}`,
    `available_at ${S}`, "attempts INT NOT NULL DEFAULT 0", `created_at ${T}`, "claimed_at TEXT", "last_error TEXT",
    "KEY messages_project_pending (project_id, status, available_at)", "KEY messages_project_ticket (project_id, ticket_id, kind, status)",
    fk("ticket_id", "tickets"), fk("to_member_id", "members"),
  ]),
  scoped("runs", [
    ID, `message_id ${BIG}`, "ticket_id BIGINT", `member_id ${BIG}`, `role ${S}`, "session_id BIGINT", `policy_id ${BIG}`, `formation_id ${BIG}`,
    `started_at ${T}`, "ended_at TEXT", "input_tokens BIGINT", "output_tokens BIGINT", "cache_read_tokens BIGINT", "cost_usd DOUBLE", "outcome TEXT", "error TEXT",
    "last_activity_at TEXT", "live TEXT", "model TEXT", "effort TEXT", "summary TEXT", "unit_name TEXT", "about_ticket_id BIGINT",
    // one_run_per_ticket: 終わっていない起動はチケットに 1 つ(SQLite の部分索引の代わり。NULL どうしは重ならない)
    "active_ticket_id BIGINT GENERATED ALWAYS AS (IF(ended_at IS NULL, ticket_id, NULL)) STORED",
    "UNIQUE KEY one_run_per_ticket (active_ticket_id)",
    "KEY runs_project_ticket (project_id, ticket_id, role)", "KEY runs_project_member (project_id, member_id)",
    fk("message_id", "messages"), fk("ticket_id", "tickets"), fk("member_id", "members"), fk("session_id", "sessions"),
    fk("policy_id", "policies"), fk("formation_id", "formations"), "FOREIGN KEY (about_ticket_id) REFERENCES tickets(id)",
  ]),
  scoped("run_steps", [
    ID, `run_id ${BIG}`, `at ${T}`, `kind ${T}`, `\`text\` ${T}`, "KEY run_steps_project_run (project_id, run_id, id)", fk("run_id", "runs"),
  ]),

  // ---- レビュー・判断・merge ----
  scoped("reviews", [
    ID, `ticket_id ${BIG}`, `role ${T}`, "round INT NOT NULL", `run_id ${BIG}`,
    `verdict VARCHAR(191) NOT NULL ${enumCheck("verdict", ["approve", "changes", "escalate"])}`, `created_at ${T}`,
    "KEY reviews_project_ticket (project_id, ticket_id)", fk("ticket_id", "tickets"), fk("run_id", "runs"),
  ]),
  scoped("findings", [
    ID, `review_id ${BIG}`, `category ${T}`, `severity ${T}`, "path TEXT", "line INT", `body ${T}`, `fingerprint ${T}`,
    `status VARCHAR(191) NOT NULL DEFAULT 'open' ${enumCheck("status", ["open", "addressed", "disputed", "fixed", "recurred", "wontfix"])}`,
    "blocking INT NOT NULL DEFAULT 1", fk("review_id", "reviews"),
  ]),
  scoped("finding_comments", [
    ID, `finding_id ${BIG}`, "member_id BIGINT", `role ${T}`,
    `action VARCHAR(191) NOT NULL ${enumCheck("action", ["raised", "fixed", "wontfix", "resolved", "accepted", "reopened", "ruled"])}`,
    "body TEXT NOT NULL DEFAULT ('')", `at ${T}`, fk("finding_id", "findings"), fk("member_id", "members"),
  ]),
  scoped("rule_violations", [
    ID, `rule_id ${BIG}`, `ticket_id ${BIG}`,
    `handled VARCHAR(191) NOT NULL ${enumCheck("handled", ["autofixed", "review", "blocked"])}`, `created_at ${T}`,
    "detail TEXT NOT NULL DEFAULT ('')", "run_id BIGINT", "resolved_at TEXT",
    fk("rule_id", "dev_rules"), fk("ticket_id", "tickets"), fk("run_id", "runs"),
  ]),
  scoped("decisions", [
    ID, `ticket_id ${BIG}`, `question ${T}`, `options ${T}`, "recommended INT NOT NULL", `why ${T}`, `impact ${T}`,
    "reversible INT NOT NULL", "escalated INT NOT NULL", "deadline_at TEXT", `decided_by VARCHAR(191) ${enumCheck("decided_by", ["owner", "lead", "timeout"])}`,
    "choice INT", "decided_at TEXT", "gh_comment_id TEXT", "lead_note TEXT",
    "KEY decisions_project_ticket (project_id, ticket_id)", fk("ticket_id", "tickets"),
  ]),
  scoped("merges", [
    ID, `pr_id ${BIG}`, `result VARCHAR(191) NOT NULL ${enumCheck("result", ["merged", "conflict", "blocked"])}`, `checked ${T}`, `created_at ${T}`,
    fk("pr_id", "pull_requests"),
  ]),
  scoped("conflicts", [
    ID, `pr_id ${BIG}`, "cause_pr_id BIGINT", `detected_at ${T}`, `resolution VARCHAR(191) ${enumCheck("resolution", ["mechanical", "logic", "decision"])}`, "resolved_at TEXT",
    fk("pr_id", "pull_requests"), "FOREIGN KEY (cause_pr_id) REFERENCES pull_requests(id)",
  ]),

  // ---- 出来事(追記だけ) ----
  scoped("events", [
    ID, `at ${T}`, `actor ${T}`, `type ${S}`, "ticket_id BIGINT", "data TEXT NOT NULL DEFAULT ('{}')",
    "KEY events_project_ticket (project_id, ticket_id, type)", "KEY events_project_type (project_id, type)",
  ]),
];

/** 本部の表(project_id が無い) */
export const MYSQL_HQ_TABLES = ["workspaces", "projects", "policy_templates", "limits"] as const;

export const MYSQL_MIGRATIONS: MysqlMigration[] = [
  // 21: ② までの形を丸ごと(本部の版 2 + プロジェクトの版 21 = R15〜R17・メンバーとの会話・project_id まで)。
  { version: 21, statements: FIRST },
  // 22: SQLite の版 22(前の版の UNIQUE を project_id 込みだけにする)に当たる。最初の版が最初から project_id 込みだけなので、流すものは無い。
  // 版の番号を SQLite と揃えるための印(ADR-0040)。
  { version: 22, statements: [] },
];
