import { z } from "zod";

/**
 * 島どうしの連絡経路(R16)。
 * 経路があると、メンバーが相手の島に質問・相談を送れ、相手の島の手すきの人が答える。
 * 経路は向きを持たない(「開発 A ↔ レビュー」は、どちら側からでも聞ける)。無い組み合わせは「連絡しない」(既定)。
 * 端は島の名前か、島に属さない担当(lead: リーダー / architect: アーキテクト)。
 */

export const ROUTE_MODES = ["none", "ask"] as const;
export type RouteMode = (typeof ROUTE_MODES)[number];

/** 島に属さない担当。 */
export const ROUTE_FIXED = ["lead", "architect"] as const;

export type RouteSpec = { from: string; to: string; mode: RouteMode };

export const routeSchema = z.object({ from: z.string().trim().min(1, "経路の端がありません"), to: z.string().trim().min(1, "経路の端がありません"), mode: z.enum(ROUTE_MODES) }).strict();
export const routesSchema = z.array(routeSchema);

/** 向きを持たない組み合わせの鍵。 */
const pairKey = (a: string, b: string) => JSON.stringify([a, b].sort());

/**
 * 経路を整える: 「連絡しない」は持たず(無い=連絡しない)、同じ組み合わせは 1 本にまとめ、順は端の名前で決める。
 * 同じ組み合わせが 2 つあれば、あとのものが勝つ(画面で切り替えた最後の状態)。
 */
export function normalizeRoutes(routes: readonly RouteSpec[] | undefined): RouteSpec[] {
  const byPair = new Map<string, RouteSpec>();
  for (const r of routes ?? []) byPair.set(pairKey(r.from, r.to), r);
  return [...byPair.values()]
    .filter((r) => r.mode !== "none")
    .map((r) => {
      const [from, to] = [r.from, r.to].sort() as [string, string];
      return { from, to, mode: r.mode };
    })
    .sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
}

/** 経路が決まりに反している理由。islands は今の編成の島の名前。 */
export function routeErrors(routes: readonly RouteSpec[] | undefined, islands: readonly string[]): string[] {
  const errors: string[] = [];
  const known = new Set<string>([...islands, ...ROUTE_FIXED]);
  for (const r of routes ?? []) {
    if (r.from === r.to) errors.push(`連絡経路: 「${r.from}」どうしは結べません`);
    for (const end of [r.from, r.to]) if (!known.has(end)) errors.push(`連絡経路: 「${end}」という島はありません`);
  }
  return [...new Set(errors)];
}

/** 保存してある経路(JSON)を読む。壊れていても止めない。 */
export function parseRoutes(json: string | null | undefined): RouteSpec[] {
  try {
    const r = routesSchema.safeParse(JSON.parse(json || "[]"));
    return r.success ? normalizeRoutes(r.data) : [];
  } catch {
    return [];
  }
}

/** この 2 つの島(または担当)のあいだに、質問・相談の経路があるか。 */
export function hasRoute(routes: readonly RouteSpec[], a: string, b: string): boolean {
  const k = pairKey(a, b);
  return routes.some((r) => r.mode === "ask" && pairKey(r.from, r.to) === k);
}

/** 島の名前が変わる・島が無くなったとき、残っている島どうしの経路だけを引き継ぐ。 */
export function routesAmong(routes: readonly RouteSpec[], islands: readonly string[]): RouteSpec[] {
  const known = new Set<string>([...islands, ...ROUTE_FIXED]);
  return routes.filter((r) => known.has(r.from) && known.has(r.to));
}
