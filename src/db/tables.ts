import type { Generated } from "kysely";

/**
 * 表の型(手で書く)。実際の表(src/db/schema.ts のマイグレーションを流した結果)との一致は tables.test.ts が確かめる。
 *
 * 書き方の決まり:
 * - INTEGER / REAL は number、TEXT は string。CHECK (... IN (...)) の付いた列は、その値の和にする。
 * - NOT NULL でない列は `| null`。ただし主キーの列は null にしない。
 * - 挿入のとき省いてよい列(INTEGER PRIMARY KEY・DEFAULT のある列)は Generated<...> で包む。
 * - JSON を入れる TEXT 列(payload・data・options・plan_refs など)も string のままにする。取り出しは dialect の jsonExtract を使う。
 * - 真偽は INTEGER の 0 / 1(number)。
 * - 版を足したら(マイグレーションを増やしたら)ここも直す。直し忘れは tables.test.ts が落とす。
 */

// ---- 本部 DB(HQ_MIGRATIONS) ----

export interface HqLimitsTable {
  key: string;
  value: string;
}

export interface HqPolicyTemplatesTable {
  id: Generated<number>;
  role: string;
  body: string;
}

export interface HqProjectsTable {
  id: Generated<number>;
  name: string;
  data_dir: string;
  status: "planning" | "defining" | "starting" | "running" | "archived";
  created_at: string;
}

export interface HqReposTable {
  id: Generated<number>;
  project_id: number;
  full_name: string;
  role: string;
}

export interface HqDatabase {
  limits: HqLimitsTable;
  policy_templates: HqPolicyTemplatesTable;
  projects: HqProjectsTable;
  repos: HqReposTable;
}

// ---- プロジェクト DB(PROJECT_MIGRATIONS) ----

export interface ConflictsTable {
  id: Generated<number>;
  pr_id: number;
  cause_pr_id: number | null;
  detected_at: string;
  resolution: "mechanical" | "logic" | "decision" | null;
  resolved_at: string | null;
}

export interface DecisionsTable {
  id: Generated<number>;
  ticket_id: number;
  question: string;
  options: string;
  recommended: number;
  why: string;
  impact: string;
  reversible: number;
  escalated: number;
  deadline_at: string | null;
  decided_by: "owner" | "lead" | "timeout" | null;
  choice: number | null;
  decided_at: string | null;
  gh_comment_id: string | null;
  lead_note: string | null;
}

export interface DesignImagesTable {
  id: Generated<number>;
  ticket_id: number | null;
  screen_key: string;
  kind: "reference" | "actual" | "diff";
  store_key: string;
  width: number;
  height: number;
  diff_ratio: number | null;
  created_at: string;
}

export interface DevRulesTable {
  id: Generated<number>;
  name: string;
  body: string;
  applies_to: string;
  check_kind: "pattern" | "ai";
  pattern: string | null;
  on_fail: "autofix" | "review" | "block";
  enabled: Generated<number>;
  template: string | null;
  created_at: Generated<string>;
}

export interface EventsTable {
  id: Generated<number>;
  at: string;
  actor: string;
  type: string;
  ticket_id: number | null;
  data: Generated<string>;
}

export interface FindingCommentsTable {
  id: Generated<number>;
  finding_id: number;
  member_id: number | null;
  role: string;
  action: "raised" | "fixed" | "wontfix" | "resolved" | "accepted" | "reopened" | "ruled";
  body: Generated<string>;
  at: string;
}

export interface FindingsTable {
  id: Generated<number>;
  review_id: number;
  category: string;
  severity: string;
  path: string | null;
  line: number | null;
  body: string;
  fingerprint: string;
  status: Generated<"open" | "addressed" | "disputed" | "fixed" | "recurred" | "wontfix">;
  blocking: Generated<number>;
}

export interface FormationsTable {
  id: Generated<number>;
  version: number;
  pull: "down" | "start";
  created_at: string;
  routes: Generated<string>;
  flows: Generated<string>;
}

export interface LeadMessagesTable {
  id: Generated<number>;
  who: "owner" | "lead" | "system";
  body: string;
  at: string;
}

export interface MemberMessagesTable {
  id: Generated<number>;
  member_id: number;
  ticket_id: number | null;
  who: string;
  body: string;
  at: string;
}

export interface MembersTable {
  id: Generated<number>;
  unit_id: number | null;
  name: string;
  look: string;
  is_base: Generated<number>;
  joined_at: string;
  left_at: string | null;
}

export interface MergesTable {
  id: Generated<number>;
  pr_id: number;
  result: "merged" | "conflict" | "blocked";
  checked: string;
  created_at: string;
}

export interface MessagesTable {
  id: Generated<number>;
  ticket_id: number | null;
  to_role: string;
  to_member_id: number | null;
  kind: string;
  payload: Generated<string>;
  status: Generated<"pending" | "claimed" | "done" | "failed">;
  available_at: string;
  attempts: Generated<number>;
  created_at: string;
  claimed_at: string | null;
  last_error: string | null;
}

export interface PlanArtifactsTable {
  id: Generated<number>;
  stage: string;
  version: number;
  kind: string;
  key: string;
  body: string;
  chosen: Generated<number>;
}

export interface PlanCommentsTable {
  id: Generated<number>;
  artifact_id: number;
  x: number | null;
  y: number | null;
  body: string;
  resolved_in: number | null;
  variant: string | null;
  created_at: Generated<string>;
}

export interface PlanMessagesTable {
  id: Generated<number>;
  stage: string;
  who: string;
  body: string;
  at: string;
}

export interface PlanOpenItemsTable {
  id: Generated<number>;
  stage: string;
  question: string;
  options: string;
  recommended: number;
  answer: string | null;
  decided_by: string | null;
  why: Generated<string>;
  reversible: Generated<number>;
  created_at: Generated<string>;
  answered_at: string | null;
  withdrawn: string | null;
}

export interface PlanStagesTable {
  stage: "req" | "infra" | "flow" | "screen" | "model";
  mode: "agree" | "delegate" | "skip";
  version: number;
  agreed_version: number | null;
}

export interface PoliciesTable {
  id: Generated<number>;
  role: string;
  version: number;
  model: string;
  effort: string;
  focus: string;
  options: Generated<string>;
  harness: Generated<string>;
  created_at: string;
}

export interface PullRequestsTable {
  id: Generated<number>;
  ticket_id: number;
  repo_id: number;
  number: number;
  head: string;
  gh_state: string | null;
  mergeable: string | null;
  ci: string | null;
  fetched_at: string | null;
}

export interface ReposTable {
  id: Generated<number>;
  full_name: string;
  role: string;
}

export interface RequirementItemsTable {
  id: Generated<number>;
  code: string;
  name: string;
  acceptance: string;
  added_in: number;
  removed_in: number | null;
}

export interface RequirementsTable {
  id: Generated<number>;
  version: number;
  created_at: string;
}

export interface ReviewsTable {
  id: Generated<number>;
  ticket_id: number;
  role: string;
  round: number;
  run_id: number;
  verdict: "approve" | "changes" | "escalate";
  created_at: string;
}

export interface RuleViolationsTable {
  id: Generated<number>;
  rule_id: number;
  ticket_id: number;
  handled: "autofixed" | "review" | "blocked";
  created_at: string;
  detail: Generated<string>;
  run_id: number | null;
  resolved_at: string | null;
}

export interface RunStepsTable {
  id: Generated<number>;
  run_id: number;
  at: string;
  kind: string;
  text: string;
}

export interface RunsTable {
  id: Generated<number>;
  message_id: number;
  ticket_id: number | null;
  member_id: number;
  role: string;
  session_id: number | null;
  policy_id: number;
  formation_id: number;
  started_at: string;
  ended_at: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cost_usd: number | null;
  outcome: string | null;
  error: string | null;
  last_activity_at: string | null;
  live: string | null;
  model: string | null;
  effort: string | null;
  summary: string | null;
  unit_name: string | null;
  about_ticket_id: number | null;
}

export interface SessionsTable {
  id: Generated<number>;
  member_id: number;
  ticket_id: number;
  repo_id: number;
  harness: string;
  harness_session_id: string;
  worktree_path: string | null;
  branch: string | null;
  created_at: string;
  last_used_at: string;
}

export interface SettingsTable {
  key: string;
  value: string;
}

export interface TicketAreasTable {
  ticket_id: number;
  area: string;
}

export interface TicketDepsTable {
  ticket_id: number;
  depends_on: number;
}

export interface TicketNotesTable {
  id: Generated<number>;
  ticket_id: number;
  who: string;
  body: string;
  at: string;
  kind: Generated<string>;
}

export interface TicketQuestionsTable {
  id: Generated<number>;
  ticket_id: number;
  from_member_id: number | null;
  to_target: string;
  body: string;
  routed_to_lead: Generated<number>;
  answer: string | null;
  answered_by_member_id: number | null;
  asked_at: string;
  answered_at: string | null;
}

export interface TicketsTable {
  id: Generated<number>;
  number: number;
  jira_key: string | null;
  title: string;
  body: Generated<string>;
  stage: "dev" | "review" | "sec" | "qa" | "decision" | "merge" | "done" | "dropped";
  owner_member_id: number | null;
  requirement_item_id: number | null;
  plan_refs: Generated<string>;
  rounds: Generated<number>;
  created_at: string;
  done_at: string | null;
  active_ms: Generated<number>;
  triaged: Generated<number>;
  dropped_by: string | null;
  dropped_reason: string | null;
  dropped_at: string | null;
  kind: Generated<string>;
  dev_done: Generated<number>;
}

export interface UnitsTable {
  id: Generated<number>;
  formation_id: number;
  name: string;
  roles: string;
  max_members: number;
  summon_at: number;
  idle_sec: number;
  repos: Generated<string>;
  model: string | null;
  effort: string | null;
  focus: string | null;
  budget_usd: number | null;
}

export interface ProjectDatabase {
  conflicts: ConflictsTable;
  decisions: DecisionsTable;
  design_images: DesignImagesTable;
  dev_rules: DevRulesTable;
  events: EventsTable;
  finding_comments: FindingCommentsTable;
  findings: FindingsTable;
  formations: FormationsTable;
  lead_messages: LeadMessagesTable;
  member_messages: MemberMessagesTable;
  members: MembersTable;
  merges: MergesTable;
  messages: MessagesTable;
  plan_artifacts: PlanArtifactsTable;
  plan_comments: PlanCommentsTable;
  plan_messages: PlanMessagesTable;
  plan_open_items: PlanOpenItemsTable;
  plan_stages: PlanStagesTable;
  policies: PoliciesTable;
  pull_requests: PullRequestsTable;
  repos: ReposTable;
  requirement_items: RequirementItemsTable;
  requirements: RequirementsTable;
  reviews: ReviewsTable;
  rule_violations: RuleViolationsTable;
  run_steps: RunStepsTable;
  runs: RunsTable;
  sessions: SessionsTable;
  settings: SettingsTable;
  ticket_areas: TicketAreasTable;
  ticket_deps: TicketDepsTable;
  ticket_notes: TicketNotesTable;
  ticket_questions: TicketQuestionsTable;
  tickets: TicketsTable;
  units: UnitsTable;
}
