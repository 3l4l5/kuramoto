import { get, run } from "../db/sqlite.js";
import type { Project, UnitRow } from "./project.js";

/**
 * 予算(プロジェクト全体・島ごと・チケットごと)。どれも「これまでに使った合計」で数える。
 * 全体と島は決めなければ無制限。チケットは既定の額がある(workflow.ts の ticketBudgetUsd)。
 */

/** 残りがこれより少ないと、起動しても何もできずに止まるので、使い切ったとみなす。 */
export const MIN_RUN_USD = 0.1;

/** 残りの額。予算が無制限なら Infinity。 */
export function leftUsd(budget: number | null, spent: number): number {
  return budget === null ? Infinity : Math.max(0, budget - spent);
}

export function isExhausted(budget: number | null, spent: number): boolean {
  return leftUsd(budget, spent) < MIN_RUN_USD;
}

// ---- プロジェクト全体 ----

/** プロジェクト全体の予算。null なら無制限。 */
export function projectBudgetUsd(p: Project): number | null {
  const v = p.setting("project_budget_usd");
  if (v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function setProjectBudget(p: Project, usd: number | null): void {
  if (usd !== null && !(Number.isFinite(usd) && usd > 0)) throw new Error("全体の予算は 0 より大きい金額か、無制限にしてください");
  if (usd === projectBudgetUsd(p)) return;
  if (usd === null) run(p.db, "DELETE FROM settings WHERE key = 'project_budget_usd'");
  else p.setSetting("project_budget_usd", String(usd));
  // 使い切った知らせは、予算を変えたら出し直せるようにする
  run(p.db, "DELETE FROM settings WHERE key = 'project_budget_notified'");
  p.event("owner", "project_budget_set", null, { usd });
}

/** プロジェクトで使った額(企画・リーダーの起動も含む)。 */
export function projectSpentUsd(p: Project): number {
  return get<{ s: number | null }>(p.db, "SELECT SUM(cost_usd) AS s FROM runs")?.s ?? 0;
}

export function projectLeftUsd(p: Project): number {
  return leftUsd(projectBudgetUsd(p), projectSpentUsd(p));
}

/** 全体の予算を使い切っているか。使い切っていたら、最初の 1 回だけ出来事に残す。 */
export function projectExhausted(p: Project): boolean {
  const budget = projectBudgetUsd(p);
  const spent = projectSpentUsd(p);
  if (!isExhausted(budget, spent)) return false;
  if (!p.setting("project_budget_notified")) {
    p.setSetting("project_budget_notified", p.now());
    p.event("system", "project_budget_reached", null, { usd: budget, spent });
  }
  return true;
}

// ---- 島 ----

/** 島で使った額。島の名前で数える(編成の版が変わっても、同じ名前の島なら続けて数える)。 */
export function unitSpentUsd(p: Project, unitName: string): number {
  return get<{ s: number | null }>(p.db, "SELECT SUM(cost_usd) AS s FROM runs WHERE unit_name = ?", [unitName])?.s ?? 0;
}

export function unitLeftUsd(p: Project, u: Pick<UnitRow, "name" | "budget_usd">): number {
  return leftUsd(u.budget_usd, unitSpentUsd(p, u.name));
}

export function unitExhausted(p: Project, u: Pick<UnitRow, "name" | "budget_usd">): boolean {
  return isExhausted(u.budget_usd, unitSpentUsd(p, u.name));
}

/** 画面に出す: 全体と島ごとの予算と使った額。 */
export function budgetView(p: Project) {
  const budget = projectBudgetUsd(p);
  const spent = projectSpentUsd(p);
  return {
    project: { budgetUsd: budget, spentUsd: spent, exhausted: isExhausted(budget, spent) },
    units: p.currentFormation().units.map((u) => {
      const s = unitSpentUsd(p, u.name);
      return { name: u.name, budgetUsd: u.budget_usd, spentUsd: s, exhausted: isExhausted(u.budget_usd, s) };
    }),
  };
}
