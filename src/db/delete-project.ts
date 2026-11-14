import type { ProjectDb } from "./conn.js";
import { PROJECT_ID_TABLES } from "./schema.js";

/**
 * プロジェクトの行を消す順(外部キーの子から親へ)。PROJECT_ID_TABLES の全部の表をちょうど 1 回ずつ含む(試験で確かめる)。
 * SQLite(foreign_keys = ON)も MySQL も、親を先に消すと外部キーで落ちるため、順番が要る。
 */
export const PROJECT_DELETE_ORDER: (typeof PROJECT_ID_TABLES)[number][] = [
  "conflicts", "merges", "finding_comments", "findings", "rule_violations", "reviews", "run_steps", "runs",
  "periodic_review_runs", "periodic_reviews", "github_issues", "decisions", "design_images", "member_messages", "ticket_questions", "ticket_areas", "ticket_deps", "ticket_notes",
  "pull_requests", "sessions", "messages", "tickets", "members", "units", "formations", "policies",
  "plan_comments", "plan_artifacts", "plan_open_items", "plan_messages", "plan_stages", "requirement_items", "requirements",
  "dev_rules", "dev_rule_versions", "repos", "settings", "events", "lead_messages",
];

/**
 * このプロジェクト(pdb の project_id)の行を、project_id を持つ全部の表から消す。1 つのトランザクションで、途中で落ちたら全部戻る。
 * pdb.deleteFrom は project_id で絞るので、同じ database にある別のプロジェクトの行には触れない。表ごとに消した行数を返す。
 */
export async function deleteProjectRows(pdb: ProjectDb): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  await pdb.transaction(async () => {
    for (const t of PROJECT_DELETE_ORDER) {
      const r = await pdb.deleteFrom(t).executeTakeFirst();
      counts[t] = Number(r.numDeletedRows ?? 0);
    }
  });
  return counts;
}
