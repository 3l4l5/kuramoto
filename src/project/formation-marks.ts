import { all } from "../db/sqlite.js";
import { parseFlows } from "../domain/flow.js";
import { parseRoutes } from "../domain/route.js";
import type { Project } from "./project.js";

/** 版が上がったとき、何を変えたか。routes: 連絡経路 / flows: 流れ / units: 島(取り方・島の設定)。 */
export type FormationChange = "routes" | "flows" | "units";

export type FormationMark = {
  version: number;
  /** 版を保存した時刻 */
  at: string;
  /** 日(ローカルの日付)。グラフの縦の点線の位置 */
  day: string;
  changed: FormationChange[];
};

/**
 * 効率のグラフの印(R16)。編成の版が上がった日と、何を変えたか。
 * 集計の表は作らず、版ごとに保存してある島・流れ・経路の差から毎回拾う。最初の版は「変えた」ものではないので印にしない。
 * 何も変わっていない保存(同じ内容で保存し直した)は印にしない。
 */
export function formationMarks(p: Project): FormationMark[] {
  const versions = all<{ id: number; version: number; pull: string; flows: string; routes: string; created_at: string }>(p.db, "SELECT id, version, pull, flows, routes, created_at FROM formations ORDER BY version");
  const snapshot = (f: (typeof versions)[number]) => ({
    routes: JSON.stringify(parseRoutes(f.routes)),
    flows: JSON.stringify(sortKeys(parseFlows(f.flows))),
    units: JSON.stringify([f.pull, ...all<Record<string, unknown>>(p.db, "SELECT name, roles, max_members, summon_at, idle_sec, repos, model, effort, focus, budget_usd FROM units WHERE formation_id = ? ORDER BY id", [f.id])]),
  });
  const marks: FormationMark[] = [];
  for (let i = 1; i < versions.length; i++) {
    const a = snapshot(versions[i - 1]!);
    const b = snapshot(versions[i]!);
    const changed = (["routes", "flows", "units"] as const).filter((k) => a[k] !== b[k]);
    if (!changed.length) continue;
    const f = versions[i]!;
    const d = new Date(f.created_at);
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    marks.push({ version: f.version, at: f.created_at, day, changed });
  }
  return marks;
}

function sortKeys(o: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));
}
