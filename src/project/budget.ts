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
export async function projectBudgetUsd(p: Project): Promise<number | null> {
  const v = await p.setting("project_budget_usd");
  if (v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export async function setProjectBudget(p: Project, usd: number | null): Promise<void> {
  if (usd !== null && !(Number.isFinite(usd) && usd > 0)) throw new Error("全体の予算は 0 より大きい金額か、無制限にしてください");
  if (usd === await projectBudgetUsd(p)) return;
  await p.pdb.transaction(async () => {
    if (usd === null) await p.pdb.deleteFrom("settings").where("key", "=", "project_budget_usd").execute();
    else await p.setSetting("project_budget_usd", String(usd));
    // 使い切った知らせは、予算を変えたら出し直せるようにする
    await p.pdb.deleteFrom("settings").where("key", "=", "project_budget_notified").execute();
    await p.event("owner", "project_budget_set", null, { usd });
  });
}

/** プロジェクトで使った額(企画・リーダーの起動も含む)。 */
export async function projectSpentUsd(p: Project): Promise<number> {
  const row = await p.pdb.k.selectFrom("runs").select((eb) => eb.fn.sum<number | null>("cost_usd").as("s")).where("project_id", "=", p.projectId).executeTakeFirst();
  return Number(row?.s ?? 0);
}

export async function projectLeftUsd(p: Project): Promise<number> {
  return leftUsd(await projectBudgetUsd(p), await projectSpentUsd(p));
}

/** 全体の予算を使い切っているか。使い切っていたら、最初の 1 回だけ出来事に残す。 */
export async function projectExhausted(p: Project): Promise<boolean> {
  const budget = await projectBudgetUsd(p);
  const spent = await projectSpentUsd(p);
  if (!isExhausted(budget, spent)) return false;
  if (!await p.setting("project_budget_notified")) {
    await p.setSetting("project_budget_notified", p.now());
    await p.event("system", "project_budget_reached", null, { usd: budget, spent });
  }
  return true;
}

// ---- 島 ----

/** 島で使った額。島の名前で数える(編成の版が変わっても、同じ名前の島なら続けて数える)。 */
export async function unitSpentUsd(p: Project, unitName: string): Promise<number> {
  const row = await p.pdb.k.selectFrom("runs").select((eb) => eb.fn.sum<number | null>("cost_usd").as("s")).where("project_id", "=", p.projectId).where("unit_name", "=", unitName).executeTakeFirst();
  return Number(row?.s ?? 0);
}

export async function unitLeftUsd(p: Project, u: Pick<UnitRow, "name" | "budget_usd">): Promise<number> {
  return leftUsd(u.budget_usd, await unitSpentUsd(p, u.name));
}

export async function unitExhausted(p: Project, u: Pick<UnitRow, "name" | "budget_usd">): Promise<boolean> {
  return isExhausted(u.budget_usd, await unitSpentUsd(p, u.name));
}

/** 島ごとの使った額を、1 文でまとめて取る(島の名前 → 額)。画面の取得用。 */
export async function unitSpentMap(p: Project, unitNames: string[]): Promise<Map<string, number>> {
  if (unitNames.length === 0) return new Map();
  const rows = await p.pdb.k
    .selectFrom("runs")
    .select(["unit_name", (eb) => eb.fn.sum<number | null>("cost_usd").as("s")])
    .where("project_id", "=", p.projectId)
    .where("unit_name", "in", unitNames)
    .groupBy("unit_name")
    .execute();
  return new Map(unitNames.map((n) => [n, Number(rows.find((r) => r.unit_name === n)?.s ?? 0)]));
}

/** 画面に出す: 全体と島ごとの予算と使った額。 */
export async function budgetView(p: Project) {
  const budget = await projectBudgetUsd(p);
  const spent = await projectSpentUsd(p);
  const units = (await p.currentFormation()).units;
  const spentBy = await unitSpentMap(p, units.map((u) => u.name));
  return {
    project: { budgetUsd: budget, spentUsd: spent, exhausted: isExhausted(budget, spent) },
    units: units.map((u) => {
      const s = spentBy.get(u.name) ?? 0;
      return { name: u.name, budgetUsd: u.budget_usd, spentUsd: s, exhausted: isExhausted(u.budget_usd, s) };
    }),
  };
}
