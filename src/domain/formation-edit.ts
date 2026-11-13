import { flowErrors, flowFor, TICKET_KINDS, type Flow, type FlowsSpec, type TicketKind } from "./flow.js";
import type { FormationSpec } from "./formation.js";
import { hasRoute, normalizeRoutes, ROUTE_FIXED, type RouteMode, type RouteSpec } from "./route.js";
import { WORK_ROLES, type WorkRole } from "./roles.js";

/**
 * 編成の引き出し(島 / 連絡経路 / 流れ)で下書きを組み立てる部品。画面を持たない純粋な関数だけ。
 * 3 タブの下書きは 1 つの FormationSpec で、保存すると編成の版が 1 つ上がる。
 */

// ---- 流れ(R17) ----

/** 流れを編集する単位: 既定の流れか、種類。 */
export type FlowKey = "default" | TicketKind;
export const FLOW_KEYS: readonly FlowKey[] = ["default", ...TICKET_KINDS];

/** 工程の一覧。流れに入っている工程を順に、そのあとに省略している工程。 */
export function flowRows(flow: readonly WorkRole[]): { role: WorkRole; on: boolean }[] {
  return [...flow.map((role) => ({ role, on: true })), ...WORK_ROLES.filter((r) => !flow.includes(r)).map((role) => ({ role, on: false }))];
}

/** 工程を 1 つ前(-1)・後ろ(1)へ。端・省略している工程は動かない。 */
export function moveStage(flow: readonly WorkRole[], role: WorkRole, dir: -1 | 1): Flow {
  const i = flow.indexOf(role);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= flow.length) return [...flow];
  const next = [...flow];
  [next[i], next[j]] = [next[j]!, next[i]!];
  return next;
}

/** 工程を必須(流れの最後に足す)・省略にする。開発は省けないので、そのまま返す。 */
export function setStage(flow: readonly WorkRole[], role: WorkRole, on: boolean): Flow {
  if (on) return flow.includes(role) ? [...flow] : [...flow, role];
  return role === "dev" ? [...flow] : flow.filter((r) => r !== role);
}

/** 開発より前の工程(コードを見ず、申し送りだけを残す)。 */
export function preDevStages(flow: readonly WorkRole[]): WorkRole[] {
  const dev = flow.indexOf("dev");
  return dev > 0 ? flow.slice(0, dev) : [];
}

/** その編集単位の今の流れ(専用の流れが無ければ、使われる流れ)。 */
export function effectiveFlow(flows: FlowsSpec | undefined, key: FlowKey): Flow {
  return key === "default" ? flowFor(flows) : flowFor(flows, key);
}

/** 専用の流れを持つか(既定の流れは、決めていれば専用)。 */
export function hasOwnFlow(flows: FlowsSpec | undefined, key: FlowKey): boolean {
  return flows?.[key] !== undefined;
}

/** 流れを置く・外す(外すと、種類は既定の流れ、既定は今までと同じ流れに戻る)。 */
export function withFlow(flows: FlowsSpec | undefined, key: FlowKey, flow: Flow | undefined): FlowsSpec {
  const next: FlowsSpec = { ...flows };
  if (flow) next[key] = flow;
  else delete next[key];
  return next;
}

/** 下書きの流れが決まりに反している理由(開発が無い・merge 待ちの前に工程が無い・同じ工程が 2 回)。 */
export function flowDraftErrors(flows: FlowsSpec | undefined, key: FlowKey): string[] {
  const own = flows?.[key];
  return own ? flowErrors(own) : [];
}

// ---- 連絡経路(R16) ----

export type RoutePair = { a: string; b: string; group: "islands" | "fixed" };

/** 経路を決められる組み合わせ: 島どうし、島とリーダー / アーキテクト。 */
export function routePairs(islands: readonly string[]): RoutePair[] {
  const pairs: RoutePair[] = [];
  islands.forEach((a, i) => islands.slice(i + 1).forEach((b) => pairs.push({ a, b, group: "islands" })));
  for (const f of ROUTE_FIXED) for (const a of islands) pairs.push({ a, b: f, group: "fixed" });
  return pairs;
}

export function routeModeOf(routes: readonly RouteSpec[] | undefined, a: string, b: string): RouteMode {
  return hasRoute(routes ?? [], a, b) ? "ask" : "none";
}

/** 組み合わせの切り替え。「連絡しない」の組み合わせは持たない。 */
export function withRoute(routes: readonly RouteSpec[] | undefined, a: string, b: string, mode: RouteMode): RouteSpec[] {
  return normalizeRoutes([...(routes ?? []), { from: a, to: b, mode }]);
}

/**
 * 下書きの経路は、島の名前ではなく島の id(変わらない印)で持つ。名前を打っている途中で他の島と同じ名前になっても、
 * 経路が混ざらない。保存と検証のときにだけ、id を今の名前に直す。端が lead / architect のものはそのまま。
 * 下書きから外した島(id が無い)の経路は落とす。
 */
export function routesToNames(routes: readonly RouteSpec[] | undefined, ids: readonly string[], names: readonly string[]): RouteSpec[] {
  const nameOf = (end: string): string | null => (ROUTE_FIXED.includes(end as (typeof ROUTE_FIXED)[number]) ? end : ids.includes(end) ? names[ids.indexOf(end)]! : null);
  return (routes ?? []).flatMap((r) => {
    const [from, to] = [nameOf(r.from), nameOf(r.to)];
    return from !== null && to !== null ? [{ ...r, from, to }] : [];
  });
}

// ---- 3 タブの「保存していない変更」 ----

export type ChangeCounts = { islands: number; routes: number; flows: number };

const askPairs = (routes: readonly RouteSpec[] | undefined) =>
  new Set((routes ?? []).filter((r) => r.mode === "ask").map((r) => JSON.stringify([r.from, r.to].sort())));

/**
 * 今の版と下書きの違いを、タブごとの件数で数える。島: 変わった島・足した島・外した島と仕事の取り方。
 * ids: 下書きの島ごとの印(もとの島は今の版の名前)。島は印で突き合わせるので、先頭の島を外しても後ろの島は変わったと数えない。
 * 経路は下書きも今の版も、この印(もとの島は名前)で持っている前提。
 */
export function changeCounts(current: FormationSpec, draft: FormationSpec, ids: readonly string[] = draft.units.map((u) => u.name)): ChangeCounts {
  const before = new Map(current.units.map((u) => [u.name, u]));
  let islands = draft.pull !== current.pull ? 1 : 0;
  draft.units.forEach((u, i) => {
    if (JSON.stringify(u) !== JSON.stringify(before.get(ids[i]!))) islands++;
  });
  islands += current.units.filter((u) => !ids.includes(u.name)).length;
  const [a, b] = [askPairs(current.routes), askPairs(draft.routes)];
  const routes = [...a].filter((k) => !b.has(k)).length + [...b].filter((k) => !a.has(k)).length;
  const flows = FLOW_KEYS.filter((k) => JSON.stringify(current.flows?.[k]) !== JSON.stringify(draft.flows?.[k])).length;
  return { islands, routes, flows };
}

/** 帯に出す文: 「保存してない変更: 島 1 · 連絡経路 2 · 流れ 1」。 */
export function changeSummary(c: ChangeCounts): string {
  const parts = [c.islands && `島 ${c.islands}`, c.routes && `連絡経路 ${c.routes}`, c.flows && `流れ ${c.flows}`].filter(Boolean);
  return parts.length ? `保存してない変更: ${parts.join(" · ")}` : "保存してない変更はありません";
}
