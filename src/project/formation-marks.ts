import { KIND_LABEL, parseFlows, type TicketKind } from "../domain/flow.js";
import { parseRoutes } from "../domain/route.js";
import { inScope } from "../db/count.js";
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
  /** 札を押したときに出す、何をどう変えたかの文(連絡経路 / 流れ / 島の順) */
  detail: string[];
};

/**
 * 効率のグラフの印(R16)。編成の版が上がった日と、何を変えたか。
 * 集計の表は作らず、版ごとに保存してある島・流れ・経路の差から毎回拾う。最初の版は「変えた」ものではないので印にしない。
 * 何も変わっていない保存(同じ内容で保存し直した)は印にしない。
 */
export async function formationMarks(p: Project): Promise<FormationMark[]> {
  const versions = await inScope(p.pdb, "formations").orderBy("version").execute();
  // 島は、版ごとに引かず 1 文でまとめて取る
  const units = versions.length ? await inScope(p.pdb, "units").where("formation_id", "in", versions.map((f) => f.id)).orderBy("id").execute() : [];
  const unitsOf = (f: (typeof versions)[number]) =>
    units
      .filter((u) => u.formation_id === f.id)
      .map((u) => ({ name: u.name, roles: u.roles, max_members: u.max_members, summon_at: u.summon_at, idle_sec: u.idle_sec, repos: u.repos, model: u.model, effort: u.effort, focus: u.focus, budget_usd: u.budget_usd }));
  const snapshot = (f: (typeof versions)[number]) => ({
    routes: JSON.stringify(parseRoutes(f.routes)),
    flows: JSON.stringify(sortKeys(parseFlows(f.flows))),
    units: JSON.stringify([f.pull, ...unitsOf(f)]),
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
    marks.push({ version: f.version, at: f.created_at, day, changed, detail: describe(versions[i - 1]!, f, changed, unitsOf) });
  }
  return marks;
}

type Version = { id: number; routes: string; flows: string; pull: string };
type UnitSnap = { name: string };

/** 札に出す、変えたことの文。経路は結んだ・外した組み合わせ、流れは変えた種類、島は増えた・減った・設定を変えた島の名前。 */
function describe<V extends Version, U extends UnitSnap>(a: V, b: V, changed: FormationChange[], unitsOf: (f: V) => U[]): string[] {
  const out: string[] = [];
  if (changed.includes("routes")) {
    const pair = (r: { from: string; to: string }) => `${r.from} ↔ ${r.to}`;
    const before = new Set(parseRoutes(a.routes).map(pair));
    const after = new Set(parseRoutes(b.routes).map(pair));
    for (const x of after) if (!before.has(x)) out.push(`連絡経路: ${x} を「質問・相談できる」にした`);
    for (const x of before) if (!after.has(x)) out.push(`連絡経路: ${x} を「連絡しない」にした`);
  }
  if (changed.includes("flows")) {
    const fa = sortKeys(parseFlows(a.flows)) as Record<string, unknown>;
    const fb = sortKeys(parseFlows(b.flows)) as Record<string, unknown>;
    const keys = [...new Set([...Object.keys(fa), ...Object.keys(fb)])].filter((k) => JSON.stringify(fa[k]) !== JSON.stringify(fb[k]));
    out.push(`流れ: ${keys.map((k) => (k === "default" ? "既定" : (KIND_LABEL[k as TicketKind] ?? k))).join("・")}の並びを変えた`);
  }
  if (changed.includes("units")) {
    const ua = new Map(unitsOf(a).map((u) => [u.name, JSON.stringify(u)]));
    const ub = new Map(unitsOf(b).map((u) => [u.name, JSON.stringify(u)]));
    const added = [...ub.keys()].filter((n) => !ua.has(n));
    const removed = [...ua.keys()].filter((n) => !ub.has(n));
    const edited = [...ub.keys()].filter((n) => ua.has(n) && ua.get(n) !== ub.get(n));
    if (added.length) out.push(`島: ${added.join("・")} を足した`);
    if (removed.length) out.push(`島: ${removed.join("・")} を外した`);
    if (edited.length) out.push(`島: ${edited.join("・")} の設定を変えた`);
    if (a.pull !== b.pull) out.push("島: 仕事の取り方を変えた");
  }
  return out;
}

function sortKeys(o: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));
}
