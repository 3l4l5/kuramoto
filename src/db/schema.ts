import type { Migration } from "./sqlite.js";
import { dialect } from "./dialect/index.js";

/**
 * 本部 DB(docs/design.md 9.1)。
 * 本部の一覧に出す数字は本部に写さず、各プロジェクトの DB を読みに行く。
 */
export const HQ_MIGRATIONS: Migration[] = [
  `
CREATE TABLE projects (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL,
  data_dir TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('planning','defining','starting','running','archived')),
  created_at TEXT NOT NULL
);
CREATE TABLE repos (
  id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id),
  full_name TEXT NOT NULL, role TEXT NOT NULL,
  UNIQUE (project_id, full_name)
);
CREATE TABLE policy_templates (id INTEGER PRIMARY KEY, role TEXT NOT NULL, body TEXT NOT NULL);
CREATE TABLE limits (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`,
  // 2: ワークスペース(プロジェクトを束ねる単位)。id=1「既定」に今ある全部を入れる。
  // 足すだけ(前の版のコードでも開ける)。列に REFERENCES は付けない(SQLite は、外部キーが有効だと既定値のある REFERENCES 列を足せない)。
  (k) => [
    k.schema.createTable("workspaces").addColumn("id", "integer", (c) => dialect.idColumn(c)).addColumn("name", "text", (c) => c.notNull()),
    k.insertInto("workspaces").values({ id: 1, name: "既定" }),
    ...["projects", "limits", "policy_templates"].map((t) =>
      k.schema.alterTable(t).addColumn("workspace_id", "integer", (c) => c.notNull().defaultTo(1)),
    ),
    k.schema.createIndex("projects_workspace").on("projects").column("workspace_id"),
    k.schema.createIndex("limits_workspace_key").unique().on("limits").columns(["workspace_id", "key"]),
  ],
];

/**
 * プロジェクト DB(docs/design.md 9.2)。
 * 設計書からの追加: messages.claimed_at / messages.last_error(取りこぼし・再試行の扱いに使う)、
 * runs.error(失敗した起動の理由)。
 */
export const PROJECT_MIGRATIONS: Migration[] = [
  `
-- 設定
CREATE TABLE repos (id INTEGER PRIMARY KEY, full_name TEXT NOT NULL UNIQUE, role TEXT NOT NULL);
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE formations (id INTEGER PRIMARY KEY, version INTEGER NOT NULL UNIQUE, pull TEXT NOT NULL CHECK (pull IN ('down','start')), created_at TEXT NOT NULL);
CREATE TABLE units (id INTEGER PRIMARY KEY, formation_id INTEGER NOT NULL REFERENCES formations(id), name TEXT NOT NULL,
  roles TEXT NOT NULL,
  max_members INTEGER NOT NULL, summon_at INTEGER NOT NULL, idle_sec INTEGER NOT NULL);
CREATE TABLE policies (id INTEGER PRIMARY KEY, role TEXT NOT NULL, version INTEGER NOT NULL,
  model TEXT NOT NULL, effort TEXT NOT NULL, focus TEXT NOT NULL, options TEXT NOT NULL DEFAULT '{}',
  harness TEXT NOT NULL DEFAULT 'claude-agent-sdk', created_at TEXT NOT NULL, UNIQUE (role, version));
CREATE TABLE dev_rules (id INTEGER PRIMARY KEY, name TEXT NOT NULL, body TEXT NOT NULL, applies_to TEXT NOT NULL,
  check_kind TEXT NOT NULL CHECK (check_kind IN ('pattern','ai')), pattern TEXT,
  on_fail TEXT NOT NULL CHECK (on_fail IN ('autofix','review','block')), enabled INTEGER NOT NULL DEFAULT 1);

-- 企画
CREATE TABLE plan_stages (stage TEXT PRIMARY KEY CHECK (stage IN ('req','flow','screen','model')),
  mode TEXT NOT NULL CHECK (mode IN ('agree','delegate','skip')), version INTEGER NOT NULL, agreed_version INTEGER);
CREATE TABLE requirements (id INTEGER PRIMARY KEY, version INTEGER NOT NULL UNIQUE, created_at TEXT NOT NULL);
CREATE TABLE requirement_items (id INTEGER PRIMARY KEY, code TEXT NOT NULL,
  name TEXT NOT NULL, acceptance TEXT NOT NULL, added_in INTEGER NOT NULL, removed_in INTEGER);
CREATE TABLE plan_artifacts (id INTEGER PRIMARY KEY, stage TEXT NOT NULL, version INTEGER NOT NULL,
  kind TEXT NOT NULL,
  key TEXT NOT NULL, body TEXT NOT NULL, chosen INTEGER NOT NULL DEFAULT 0);
CREATE TABLE plan_comments (id INTEGER PRIMARY KEY, artifact_id INTEGER NOT NULL REFERENCES plan_artifacts(id),
  x REAL, y REAL, body TEXT NOT NULL, resolved_in INTEGER);
CREATE TABLE plan_open_items (id INTEGER PRIMARY KEY, stage TEXT NOT NULL, question TEXT NOT NULL,
  options TEXT NOT NULL, recommended INTEGER NOT NULL, answer TEXT, decided_by TEXT);

-- チームとチケット
CREATE TABLE members (id INTEGER PRIMARY KEY, unit_id INTEGER REFERENCES units(id), name TEXT NOT NULL,
  look TEXT NOT NULL, is_base INTEGER NOT NULL DEFAULT 0, joined_at TEXT NOT NULL, left_at TEXT);
CREATE TABLE tickets (id INTEGER PRIMARY KEY, number INTEGER NOT NULL UNIQUE, jira_key TEXT, title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '',
  stage TEXT NOT NULL CHECK (stage IN ('dev','review','sec','qa','decision','merge','done','dropped')),
  owner_member_id INTEGER REFERENCES members(id), requirement_item_id INTEGER REFERENCES requirement_items(id),
  plan_refs TEXT NOT NULL DEFAULT '{}',
  rounds INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, done_at TEXT, active_ms INTEGER NOT NULL DEFAULT 0);
CREATE TABLE sessions (id INTEGER PRIMARY KEY, member_id INTEGER NOT NULL REFERENCES members(id), ticket_id INTEGER NOT NULL REFERENCES tickets(id),
  repo_id INTEGER NOT NULL REFERENCES repos(id), harness TEXT NOT NULL, harness_session_id TEXT NOT NULL,
  worktree_path TEXT, branch TEXT, created_at TEXT NOT NULL, last_used_at TEXT NOT NULL, UNIQUE (member_id, ticket_id, repo_id));
CREATE TABLE pull_requests (id INTEGER PRIMARY KEY, ticket_id INTEGER NOT NULL REFERENCES tickets(id), repo_id INTEGER NOT NULL REFERENCES repos(id),
  number INTEGER NOT NULL, head TEXT NOT NULL, gh_state TEXT, mergeable TEXT, ci TEXT, fetched_at TEXT, UNIQUE (ticket_id, repo_id));

-- 受信箱と起動の記録
CREATE TABLE messages (id INTEGER PRIMARY KEY, ticket_id INTEGER REFERENCES tickets(id),
  to_role TEXT NOT NULL, to_member_id INTEGER REFERENCES members(id), kind TEXT NOT NULL, payload TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','claimed','done','failed')),
  available_at TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL,
  claimed_at TEXT, last_error TEXT);
CREATE INDEX messages_pending ON messages(status, available_at);
CREATE TABLE runs (id INTEGER PRIMARY KEY, message_id INTEGER NOT NULL REFERENCES messages(id), ticket_id INTEGER REFERENCES tickets(id),
  member_id INTEGER NOT NULL REFERENCES members(id), role TEXT NOT NULL, session_id INTEGER REFERENCES sessions(id),
  policy_id INTEGER NOT NULL REFERENCES policies(id), formation_id INTEGER NOT NULL REFERENCES formations(id),
  started_at TEXT NOT NULL, ended_at TEXT, input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, cost_usd REAL, outcome TEXT,
  error TEXT);
CREATE UNIQUE INDEX one_run_per_ticket ON runs(ticket_id) WHERE ended_at IS NULL;

-- レビュー・判断・merge
CREATE TABLE reviews (id INTEGER PRIMARY KEY, ticket_id INTEGER NOT NULL REFERENCES tickets(id), role TEXT NOT NULL, round INTEGER NOT NULL,
  run_id INTEGER NOT NULL REFERENCES runs(id), verdict TEXT NOT NULL CHECK (verdict IN ('approve','changes','escalate')), created_at TEXT NOT NULL);
CREATE TABLE findings (id INTEGER PRIMARY KEY, review_id INTEGER NOT NULL REFERENCES reviews(id), category TEXT NOT NULL, severity TEXT NOT NULL,
  path TEXT, line INTEGER, body TEXT NOT NULL, fingerprint TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','fixed','recurred','wontfix')));
CREATE TABLE rule_violations (id INTEGER PRIMARY KEY, rule_id INTEGER NOT NULL REFERENCES dev_rules(id), ticket_id INTEGER NOT NULL REFERENCES tickets(id),
  handled TEXT NOT NULL CHECK (handled IN ('autofixed','review','blocked')), created_at TEXT NOT NULL);
CREATE TABLE decisions (id INTEGER PRIMARY KEY, ticket_id INTEGER NOT NULL REFERENCES tickets(id), question TEXT NOT NULL, options TEXT NOT NULL,
  recommended INTEGER NOT NULL, why TEXT NOT NULL, impact TEXT NOT NULL, reversible INTEGER NOT NULL, escalated INTEGER NOT NULL,
  deadline_at TEXT, decided_by TEXT CHECK (decided_by IN ('owner','lead','timeout')), choice INTEGER, decided_at TEXT, gh_comment_id TEXT);
CREATE TABLE merges (id INTEGER PRIMARY KEY, pr_id INTEGER NOT NULL REFERENCES pull_requests(id),
  result TEXT NOT NULL CHECK (result IN ('merged','conflict','blocked')), checked TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE conflicts (id INTEGER PRIMARY KEY, pr_id INTEGER NOT NULL REFERENCES pull_requests(id), cause_pr_id INTEGER REFERENCES pull_requests(id),
  detected_at TEXT NOT NULL, resolution TEXT CHECK (resolution IN ('mechanical','logic','decision')), resolved_at TEXT);

-- 出来事(追記だけ。ログとアニメーションの元)
CREATE TABLE events (id INTEGER PRIMARY KEY, at TEXT NOT NULL, actor TEXT NOT NULL, type TEXT NOT NULL, ticket_id INTEGER, data TEXT NOT NULL DEFAULT '{}');
`,
  // 2: 企画スタジオ(docs/design.md 5.1・6.2)。会話の記録と、未決・コメントに要る列を足す。
  `
CREATE TABLE plan_messages (id INTEGER PRIMARY KEY, stage TEXT NOT NULL, who TEXT NOT NULL, body TEXT NOT NULL, at TEXT NOT NULL);
ALTER TABLE plan_open_items ADD COLUMN why TEXT NOT NULL DEFAULT '';
ALTER TABLE plan_open_items ADD COLUMN reversible INTEGER NOT NULL DEFAULT 1;
ALTER TABLE plan_open_items ADD COLUMN created_at TEXT NOT NULL DEFAULT '';
ALTER TABLE plan_open_items ADD COLUMN answered_at TEXT;
ALTER TABLE plan_open_items ADD COLUMN withdrawn TEXT;
ALTER TABLE plan_comments ADD COLUMN variant TEXT;
ALTER TABLE plan_comments ADD COLUMN created_at TEXT NOT NULL DEFAULT '';
INSERT INTO plan_stages (stage, mode, version) VALUES ('req','agree',1),('flow','agree',1),('screen','agree',1),('model','agree',1);
INSERT INTO requirements (version, created_at) VALUES (1, '');
`,
  // 3: インフラの段階を足す(ADR-0015)。CHECK 制約は変えられないので表を作り直す。
  `
CREATE TABLE plan_stages_new (stage TEXT PRIMARY KEY CHECK (stage IN ('req','infra','flow','screen','model')),
  mode TEXT NOT NULL CHECK (mode IN ('agree','delegate','skip')), version INTEGER NOT NULL, agreed_version INTEGER);
INSERT INTO plan_stages_new (stage, mode, version, agreed_version) SELECT stage, mode, version, agreed_version FROM plan_stages;
DROP TABLE plan_stages;
ALTER TABLE plan_stages_new RENAME TO plan_stages;
INSERT INTO plan_stages (stage, mode, version) VALUES ('infra','agree',1);
`,
  // 4: 起動の途中経過。考えている・ファイルを読んでいる、などを画面に出して、止まっていないことを分かるようにする。
  `
ALTER TABLE runs ADD COLUMN last_activity_at TEXT;
ALTER TABLE runs ADD COLUMN live TEXT;
CREATE TABLE run_steps (id INTEGER PRIMARY KEY, run_id INTEGER NOT NULL REFERENCES runs(id), at TEXT NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL);
CREATE INDEX run_steps_run ON run_steps(run_id, id);
`,
  // 5: 登場人物の名前を学園アイドルマスター(足りなければシリーズ全体)から取るように変えた(src/domain/cast.ts の RENAMED と同じ読み替え)
  `
UPDATE members SET name = CASE name WHEN 'サキ' THEN '咲季' WHEN 'ミオ' THEN '清夏' WHEN 'レイ' THEN '広' WHEN 'マキ' THEN '星南' WHEN 'ハル' THEN '手毬' WHEN 'ソラ' THEN 'ことね' WHEN 'ケイ' THEN '麻央' WHEN 'ユウ' THEN 'リーリヤ' WHEN 'ナギ' THEN '千奈' WHEN 'リク' THEN '莉波' WHEN 'ミナ' THEN '佑芽' WHEN 'トワ' THEN '美鈴' WHEN 'アオ' THEN '春香' WHEN 'ヒナ' THEN '千早' WHEN 'レン' THEN '美希' WHEN 'コウ' THEN '卯月' END WHERE name IN ('サキ','ミオ','レイ','マキ','ハル','ソラ','ケイ','ユウ','ナギ','リク','ミナ','トワ','アオ','ヒナ','レン','コウ');
`,
  // 6: 島ごとに受け持つリポジトリ(ADR-0019)。空ならすべてを受け持つ。
  `
ALTER TABLE units ADD COLUMN repos TEXT NOT NULL DEFAULT '[]';
`,
  // 7: 島ごとのモデル・考える深さ(空なら役割の方針どおり)と、起動ごとに実際に使ったモデル・深さ
  `
ALTER TABLE units ADD COLUMN model TEXT;
ALTER TABLE units ADD COLUMN effort TEXT;
ALTER TABLE runs ADD COLUMN model TEXT;
ALTER TABLE runs ADD COLUMN effort TEXT;
`,
  // 8: 島ごとの重視すること、起動ごとの担当の最後の報告、チケットへの責任者のメモ
  `
ALTER TABLE units ADD COLUMN focus TEXT;
ALTER TABLE runs ADD COLUMN summary TEXT;
CREATE TABLE ticket_notes (id INTEGER PRIMARY KEY, ticket_id INTEGER NOT NULL REFERENCES tickets(id), who TEXT NOT NULL, body TEXT NOT NULL, at TEXT NOT NULL);
`,
  // 9: 責任者とリーダーのチャット(非同期)
  `
CREATE TABLE lead_messages (id INTEGER PRIMARY KEY, who TEXT NOT NULL CHECK (who IN ('owner','lead','system')), body TEXT NOT NULL, at TEXT NOT NULL);
`,
  // 10: リーダーの交通整理(チケットの順番・担当)
  `
ALTER TABLE tickets ADD COLUMN triaged INTEGER NOT NULL DEFAULT 1;
CREATE TABLE ticket_deps (ticket_id INTEGER NOT NULL REFERENCES tickets(id), depends_on INTEGER NOT NULL REFERENCES tickets(id), PRIMARY KEY (ticket_id, depends_on));
UPDATE tickets SET triaged = 0 WHERE stage = 'dev' AND owner_member_id IS NULL AND NOT EXISTS (SELECT 1 FROM runs r WHERE r.ticket_id = tickets.id);
`,
  // 11: レビューのスレッド(指摘ごとのやりとり)。必須の指摘と提案(nit)を分け、開発の返事・レビュアーの確認を残す
  `
CREATE TABLE findings_new (id INTEGER PRIMARY KEY, review_id INTEGER NOT NULL REFERENCES reviews(id), category TEXT NOT NULL, severity TEXT NOT NULL,
  path TEXT, line INTEGER, body TEXT NOT NULL, fingerprint TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','addressed','disputed','fixed','recurred','wontfix')),
  blocking INTEGER NOT NULL DEFAULT 1);
INSERT INTO findings_new (id, review_id, category, severity, path, line, body, fingerprint, status, blocking)
  SELECT id, review_id, category, severity, path, line, body, fingerprint, status, CASE severity WHEN 'low' THEN 0 ELSE 1 END FROM findings;
DROP TABLE findings;
ALTER TABLE findings_new RENAME TO findings;
CREATE TABLE finding_comments (id INTEGER PRIMARY KEY, finding_id INTEGER NOT NULL REFERENCES findings(id), member_id INTEGER REFERENCES members(id),
  role TEXT NOT NULL, action TEXT NOT NULL CHECK (action IN ('raised','fixed','wontfix','resolved','accepted','reopened','ruled')),
  body TEXT NOT NULL DEFAULT '', at TEXT NOT NULL);
`,
  // 12: 島ごとの予算(null は無制限)と、起動ごとにどの島で動いたか(島の予算を数えるのに使う)。
  // 前の起動は島を記録していないので、メンバーが今いる島で読み替える(応援が島を移っていればずれる)。
  `
ALTER TABLE units ADD COLUMN budget_usd REAL;
ALTER TABLE runs ADD COLUMN unit_name TEXT;
UPDATE runs SET unit_name = (SELECT u.name FROM members m JOIN units u ON u.id = m.unit_id WHERE m.id = runs.member_id);
`,
  // 13: 前の版の予算切れの判断は、推奨が「やめる」で期限付きだったため、期限切れでチケットが取りやめになっていた。
  // まだ決まっていない「やめる」を含む判断から期限を外し、責任者が選ぶまで待たせる。
  `
UPDATE decisions SET deadline_at = NULL WHERE decided_at IS NULL AND options LIKE '%"drop"%';
`,
  // 14: リーダーが責任者に上げた理由・聞きたいことを判断に残す(前は出来事のログにしか無く、判断のカードに出なかった)
  `
ALTER TABLE decisions ADD COLUMN lead_note TEXT;
UPDATE decisions SET lead_note = (
  SELECT json_extract(e.data, '$.reason') FROM events e
  WHERE e.type = 'escalated' AND e.actor = 'lead' AND json_extract(e.data, '$.decision_id') = decisions.id
  ORDER BY e.id DESC LIMIT 1
);
`,
  // 15: チケットが触りそうな場所(ファイル・機能のまとまり)。同じ場所を触るチケットは同時に開発しない(ADR-0024)
  `
CREATE TABLE IF NOT EXISTS ticket_areas (ticket_id INTEGER NOT NULL REFERENCES tickets(id), area TEXT NOT NULL, PRIMARY KEY (ticket_id, area));
`,
  // 16: 画面の取得(プロジェクト・オフィス)が、チケットごとに起動・出来事・受信箱を全件なめていて、数秒かかっていた。よく引く列に索引を張る
  `
CREATE INDEX IF NOT EXISTS runs_ticket ON runs(ticket_id, role);
CREATE INDEX IF NOT EXISTS runs_member ON runs(member_id);
CREATE INDEX IF NOT EXISTS events_ticket ON events(ticket_id, type);
CREATE INDEX IF NOT EXISTS events_type ON events(type);
CREATE INDEX IF NOT EXISTS messages_ticket ON messages(ticket_id, kind, status);
CREATE INDEX IF NOT EXISTS ticket_areas_area ON ticket_areas(area);
CREATE INDEX IF NOT EXISTS reviews_ticket ON reviews(ticket_id);
CREATE INDEX IF NOT EXISTS decisions_ticket ON decisions(ticket_id);
CREATE INDEX IF NOT EXISTS ticket_deps_dep ON ticket_deps(depends_on);
`,
  // 17: 取りやめたチケットに、誰が・いつ・なぜ取りやめたかを残す(ボードとチケットに出す)。前の重複の片付けは出来事から埋める
  `
ALTER TABLE tickets ADD COLUMN dropped_by TEXT;
ALTER TABLE tickets ADD COLUMN dropped_reason TEXT;
ALTER TABLE tickets ADD COLUMN dropped_at TEXT;
UPDATE tickets SET dropped_by = 'lead',
  dropped_reason = (SELECT '#' || json_extract(e.data, '$.sameAs') || ' と重複していたため' FROM events e WHERE e.ticket_id = tickets.id AND e.type = 'duplicate_dropped' ORDER BY e.id DESC LIMIT 1),
  dropped_at = (SELECT e.at FROM events e WHERE e.ticket_id = tickets.id AND e.type = 'duplicate_dropped' ORDER BY e.id DESC LIMIT 1)
WHERE stage = 'dropped' AND EXISTS (SELECT 1 FROM events e WHERE e.ticket_id = tickets.id AND e.type = 'duplicate_dropped');
`,
  // 18: 画面を画像で見比べる(ADR-0034)。画像そのものは置き場所(ファイル・S3)に置き、ここには場所と大きさ・違いの割合だけを残す
  `
CREATE TABLE IF NOT EXISTS design_images (id INTEGER PRIMARY KEY, ticket_id INTEGER REFERENCES tickets(id), screen_key TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('reference','actual','diff')), store_key TEXT NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL,
  diff_ratio REAL, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS design_images_ticket ON design_images(ticket_id, screen_key);
`,
  // 19: R15(開発ルール)・R16(島どうしの連絡経路と質問)・R17(チケットの種類ごとの流れ)・メンバーとの会話。
  // 前の版のコードでも開けるよう、表・列・索引を足すだけにする(RENAME・列の削除・表の作り直しはしない)。新しい列に CHECK は付けない。
  // メッセージの kind には CHECK が無いので、ask / reply / member_chat はそのまま使える。
  // dev_done: 開発を一度でも通ったか。開発の起動があるか、開発より後の工程にいる既存のチケットは 1 にする。
  `
ALTER TABLE formations ADD COLUMN routes TEXT NOT NULL DEFAULT '[]';
ALTER TABLE formations ADD COLUMN flows TEXT NOT NULL DEFAULT '{}';
ALTER TABLE tickets ADD COLUMN kind TEXT NOT NULL DEFAULT 'feature';
ALTER TABLE tickets ADD COLUMN dev_done INTEGER NOT NULL DEFAULT 0;
UPDATE tickets SET dev_done = 1
  WHERE stage IN ('review','sec','qa','decision','merge','done')
     OR EXISTS (SELECT 1 FROM runs r WHERE r.ticket_id = tickets.id AND r.role = 'dev');
ALTER TABLE dev_rules ADD COLUMN template TEXT;
ALTER TABLE dev_rules ADD COLUMN created_at TEXT NOT NULL DEFAULT '';
ALTER TABLE rule_violations ADD COLUMN detail TEXT NOT NULL DEFAULT '';
ALTER TABLE rule_violations ADD COLUMN run_id INTEGER REFERENCES runs(id);
ALTER TABLE rule_violations ADD COLUMN resolved_at TEXT;
CREATE TABLE IF NOT EXISTS ticket_questions (id INTEGER PRIMARY KEY, ticket_id INTEGER NOT NULL REFERENCES tickets(id),
  from_member_id INTEGER REFERENCES members(id), to_target TEXT NOT NULL, body TEXT NOT NULL,
  routed_to_lead INTEGER NOT NULL DEFAULT 0, answer TEXT, answered_by_member_id INTEGER REFERENCES members(id),
  asked_at TEXT NOT NULL, answered_at TEXT);
CREATE INDEX IF NOT EXISTS ticket_questions_ticket ON ticket_questions(ticket_id);
CREATE TABLE IF NOT EXISTS member_messages (id INTEGER PRIMARY KEY, member_id INTEGER NOT NULL REFERENCES members(id),
  ticket_id INTEGER REFERENCES tickets(id), who TEXT NOT NULL, body TEXT NOT NULL, at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS member_messages_member ON member_messages(member_id, id);
ALTER TABLE ticket_notes ADD COLUMN kind TEXT NOT NULL DEFAULT 'note';
ALTER TABLE runs ADD COLUMN about_ticket_id INTEGER REFERENCES tickets(id);
`,
  // 20: 開発ルールに版(変えるたびに 1 つ上がり、そのときのルールの一覧を残す)と、消した印を足す。
  // 消しても違反の記録は残すので、行は消さずに deleted_at を入れる。今あるルールは版 1 として残す。表・列を足すだけ。
  `
CREATE TABLE IF NOT EXISTS dev_rule_versions (version INTEGER PRIMARY KEY, rules TEXT NOT NULL, created_at TEXT NOT NULL);
ALTER TABLE dev_rules ADD COLUMN deleted_at TEXT;
INSERT OR IGNORE INTO dev_rule_versions (version, rules, created_at)
  SELECT 1, json_group_array(json_object('id', id, 'name', name, 'enabled', json(CASE WHEN enabled = 1 THEN 'true' ELSE 'false' END))), '' FROM dev_rules;
`,
  // 21: プロジェクトの全部の表に project_id を足す(ADR-0037)。1 つのファイルに複数のプロジェクトを入れられるようにする下ごしらえ。
  // 足すだけ(RENAME・削除・表の作り直しはしない。前の版のコードでも開ける)。
  //  - 列は NOT NULL DEFAULT 0。今ある行は、実行器が渡すプロジェクトの id(ctx.projectId)で埋める。渡されなければ 0 のまま。
  //  - 索引は project_id を先頭にする。前の版の索引・UNIQUE は消せないので残し、project_id 込みの索引を足す。
  //  - 前の版のコードは project_id を書かない INSERT をする。DEFAULT 0 で通り、project_id 込みの UNIQUE にも収まる(同じ 0 の中で前と同じ決まり)。
  //    前の UNIQUE は、この版では残る(外すのは版 22)。
  (k, ctx) => [
    ...V21_TABLES.map((t) => k.schema.alterTable(t).addColumn("project_id", "integer", (c) => c.notNull().defaultTo(0))),
    ...(ctx.projectId === undefined ? [] : V21_TABLES.map((t) => k.updateTable(t).set({ project_id: ctx.projectId! }))),
    ...PROJECT_ID_INDEXES.map(({ table, columns, unique }) => {
      const name = [table, "project", ...columns].join("_");
      const b = unique ? k.schema.createIndex(name).unique() : k.schema.createIndex(name);
      return b.on(table).columns(["project_id", ...columns]);
    }),
  ],
  // 22: 前の版の UNIQUE(tickets.number・settings.key など)を project_id 込みだけにする(ADR-0040)。
  // 同じ database に 2 つのプロジェクトを置くと、別のプロジェクトでも同じ number・key が入らなかった。MySQL の最初の版は、最初から project_id 込みだけ。
  // SQLite は表に書いた UNIQUE・主キーを外せないので、対象の表を作り直す(行・id・列の並びはそのまま。project_id は最後)。
  //  - 外す: repos(full_name)・formations(version)・policies(role, version)・requirements(version)・tickets(number) の UNIQUE、
  //          settings(key)・plan_stages(stage)・dev_rule_versions(version) の主キー。
  //  - 付ける: 上の列の前に project_id を足した UNIQUE(id の表は版 21 と同じ名前の索引、主キーの表は (project_id, …) の主キー)。
  //  - 残す: sessions(member_id, ticket_id, repo_id)・pull_requests(ticket_id, repo_id)・ticket_deps・ticket_areas の主キー・one_run_per_ticket は、
  //          id だけでできていて id は全プロジェクトで重ならないので、project_id が要らない(MySQL も同じ)。
  // 他の表から指されている表(tickets・repos・formations・policies)は、DROP が外部キーに触れるので、トランザクションの最後まで検査を遅らせ、
  // 同じ行を入れ直した時点で満たす。表を RENAME はしない(子の REFERENCES が書き換わるため)。
  `
PRAGMA defer_foreign_keys = ON;
CREATE TABLE _v22_repos AS SELECT * FROM repos;
CREATE TABLE _v22_settings AS SELECT * FROM settings;
CREATE TABLE _v22_formations AS SELECT * FROM formations;
CREATE TABLE _v22_policies AS SELECT * FROM policies;
CREATE TABLE _v22_plan_stages AS SELECT * FROM plan_stages;
CREATE TABLE _v22_requirements AS SELECT * FROM requirements;
CREATE TABLE _v22_tickets AS SELECT * FROM tickets;
CREATE TABLE _v22_dev_rule_versions AS SELECT * FROM dev_rule_versions;
DROP TABLE repos;
DROP TABLE settings;
DROP TABLE formations;
DROP TABLE policies;
DROP TABLE plan_stages;
DROP TABLE requirements;
DROP TABLE tickets;
DROP TABLE dev_rule_versions;

CREATE TABLE repos (id INTEGER PRIMARY KEY, full_name TEXT NOT NULL, role TEXT NOT NULL, project_id INTEGER NOT NULL DEFAULT 0);
CREATE TABLE settings (key TEXT NOT NULL, value TEXT NOT NULL, project_id INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (project_id, key));
CREATE TABLE formations (id INTEGER PRIMARY KEY, version INTEGER NOT NULL, pull TEXT NOT NULL CHECK (pull IN ('down','start')), created_at TEXT NOT NULL,
  routes TEXT NOT NULL DEFAULT '[]', flows TEXT NOT NULL DEFAULT '{}', project_id INTEGER NOT NULL DEFAULT 0);
CREATE TABLE policies (id INTEGER PRIMARY KEY, role TEXT NOT NULL, version INTEGER NOT NULL,
  model TEXT NOT NULL, effort TEXT NOT NULL, focus TEXT NOT NULL, options TEXT NOT NULL DEFAULT '{}',
  harness TEXT NOT NULL DEFAULT 'claude-agent-sdk', created_at TEXT NOT NULL, project_id INTEGER NOT NULL DEFAULT 0);
CREATE TABLE plan_stages (stage TEXT NOT NULL CHECK (stage IN ('req','infra','flow','screen','model')),
  mode TEXT NOT NULL CHECK (mode IN ('agree','delegate','skip')), version INTEGER NOT NULL, agreed_version INTEGER,
  project_id INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (project_id, stage));
CREATE TABLE requirements (id INTEGER PRIMARY KEY, version INTEGER NOT NULL, created_at TEXT NOT NULL, project_id INTEGER NOT NULL DEFAULT 0);
CREATE TABLE tickets (id INTEGER PRIMARY KEY, number INTEGER NOT NULL, jira_key TEXT, title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '',
  stage TEXT NOT NULL CHECK (stage IN ('dev','review','sec','qa','decision','merge','done','dropped')),
  owner_member_id INTEGER REFERENCES members(id), requirement_item_id INTEGER REFERENCES requirement_items(id),
  plan_refs TEXT NOT NULL DEFAULT '{}',
  rounds INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, done_at TEXT, active_ms INTEGER NOT NULL DEFAULT 0,
  triaged INTEGER NOT NULL DEFAULT 1, dropped_by TEXT, dropped_reason TEXT, dropped_at TEXT,
  kind TEXT NOT NULL DEFAULT 'feature', dev_done INTEGER NOT NULL DEFAULT 0, project_id INTEGER NOT NULL DEFAULT 0);
CREATE TABLE dev_rule_versions (version INTEGER NOT NULL, rules TEXT NOT NULL, created_at TEXT NOT NULL,
  project_id INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (project_id, version));

INSERT INTO repos (id, full_name, role, project_id) SELECT id, full_name, role, project_id FROM _v22_repos;
INSERT INTO settings (key, value, project_id) SELECT key, value, project_id FROM _v22_settings;
INSERT INTO formations (id, version, pull, created_at, routes, flows, project_id) SELECT id, version, pull, created_at, routes, flows, project_id FROM _v22_formations;
INSERT INTO policies (id, role, version, model, effort, focus, options, harness, created_at, project_id)
  SELECT id, role, version, model, effort, focus, options, harness, created_at, project_id FROM _v22_policies;
INSERT INTO plan_stages (stage, mode, version, agreed_version, project_id) SELECT stage, mode, version, agreed_version, project_id FROM _v22_plan_stages;
INSERT INTO requirements (id, version, created_at, project_id) SELECT id, version, created_at, project_id FROM _v22_requirements;
INSERT INTO tickets (id, number, jira_key, title, body, stage, owner_member_id, requirement_item_id, plan_refs, rounds, created_at, done_at, active_ms,
    triaged, dropped_by, dropped_reason, dropped_at, kind, dev_done, project_id)
  SELECT id, number, jira_key, title, body, stage, owner_member_id, requirement_item_id, plan_refs, rounds, created_at, done_at, active_ms,
    triaged, dropped_by, dropped_reason, dropped_at, kind, dev_done, project_id FROM _v22_tickets;
INSERT INTO dev_rule_versions (version, rules, created_at, project_id) SELECT version, rules, created_at, project_id FROM _v22_dev_rule_versions;

DROP TABLE _v22_repos;
DROP TABLE _v22_settings;
DROP TABLE _v22_formations;
DROP TABLE _v22_policies;
DROP TABLE _v22_plan_stages;
DROP TABLE _v22_requirements;
DROP TABLE _v22_tickets;
DROP TABLE _v22_dev_rule_versions;

CREATE UNIQUE INDEX repos_project_full_name ON repos(project_id, full_name);
CREATE UNIQUE INDEX formations_project_version ON formations(project_id, version);
CREATE UNIQUE INDEX policies_project_role_version ON policies(project_id, role, version);
CREATE UNIQUE INDEX requirements_project_version ON requirements(project_id, version);
CREATE UNIQUE INDEX tickets_project_number ON tickets(project_id, number);
`,
  // 23: 見回りが取ってきた GitHub の Issue と、リーダーの扱い(#79)。同じ Issue に二度応答せず、二度チケットを切らないために、扱った Issue を覚える。
  //  - status: new = まだリーダーが見ていない / ticketed = チケットにした / duplicate = 既存のチケットに足した / owner = 責任者に回した / passed = リーダーが何も決めなかった
  //  - 新しい表なので project_id は最初から持つ(UNIQUE も project_id 込み)。
  `
CREATE TABLE github_issues (id INTEGER PRIMARY KEY, repo TEXT NOT NULL, number INTEGER NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', url TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','ticketed','duplicate','owner','passed')),
  ticket_id INTEGER REFERENCES tickets(id), note TEXT, fetched_at TEXT NOT NULL, handled_at TEXT, project_id INTEGER NOT NULL DEFAULT 0);
CREATE UNIQUE INDEX github_issues_project_issue ON github_issues(project_id, repo, number);
CREATE INDEX github_issues_project_status ON github_issues(project_id, status);
`,
];

/** 版 21 で project_id を足す表(その時点のプロジェクト DB の全部)。版 21 の実行と索引に使うので、足さない(後の版の表は PROJECT_ID_TABLES にだけ足す)。 */
export const V21_TABLES = [
  "repos", "settings", "formations", "units", "policies", "dev_rules",
  "plan_stages", "requirements", "requirement_items", "plan_artifacts", "plan_comments", "plan_open_items", "plan_messages",
  "members", "tickets", "sessions", "pull_requests", "messages", "runs", "run_steps",
  "reviews", "findings", "finding_comments", "rule_violations", "decisions", "merges", "conflicts",
  "dev_rule_versions", "events", "ticket_notes", "lead_messages", "ticket_deps", "ticket_areas", "design_images", "ticket_questions", "member_messages",
] as const;

/**
 * プロジェクト DB の全部の表(project_id を持つ)。表を足すときは、足す版で project_id も一緒に持たせ(新しい表なので ALTER は要らない)、
 * ここに足す(scope.test.ts・delete-project.test.ts・sqlite-to-mysql.test.ts が確かめる)。
 *  - 版 23: github_issues(見回りが取ってきた GitHub の Issue と、リーダーの扱い。#79)
 */
export const PROJECT_ID_TABLES = [...V21_TABLES, "github_issues"] as const;

/**
 * 版 21 で足す索引(列は project_id の後ろ。名前は <表>_project_<列>)。
 *  - unique: 前の版の UNIQUE に project_id を足したもの(前の UNIQUE は版 22 で外す)。
 *  - 前の版にあった索引は、project_id を先頭にしたものを足す。
 *  - どちらも無い表には (project_id) だけの索引を足す。
 */
type IndexSpec = { table: (typeof V21_TABLES)[number]; columns: string[]; unique?: boolean };
const NAMED_INDEXES: IndexSpec[] = [
  { table: "tickets", columns: ["number"], unique: true },
  { table: "formations", columns: ["version"], unique: true },
  { table: "policies", columns: ["role", "version"], unique: true },
  { table: "settings", columns: ["key"], unique: true },
  { table: "plan_stages", columns: ["stage"], unique: true },
  { table: "requirements", columns: ["version"], unique: true },
  { table: "repos", columns: ["full_name"], unique: true },
  { table: "messages", columns: ["status", "available_at"] },
  { table: "messages", columns: ["ticket_id", "kind", "status"] },
  { table: "runs", columns: ["ticket_id", "role"] },
  { table: "runs", columns: ["member_id"] },
  { table: "run_steps", columns: ["run_id", "id"] },
  { table: "events", columns: ["ticket_id", "type"] },
  { table: "events", columns: ["type"] },
  { table: "ticket_areas", columns: ["area"] },
  { table: "ticket_deps", columns: ["depends_on"] },
  { table: "reviews", columns: ["ticket_id"] },
  { table: "decisions", columns: ["ticket_id"] },
  { table: "design_images", columns: ["ticket_id", "screen_key"] },
  { table: "ticket_questions", columns: ["ticket_id"] },
  { table: "member_messages", columns: ["member_id", "id"] },
];
const PROJECT_ID_INDEXES: IndexSpec[] = [
  ...NAMED_INDEXES,
  ...V21_TABLES.filter((t) => !NAMED_INDEXES.some((i) => i.table === t)).map((table) => ({ table, columns: [] })),
];
