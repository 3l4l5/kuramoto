import { describe, expect, it } from "vitest";
import { LEG_GAP, linePath } from "../ui/src/linePath";

// オフィスの路線図の線の引き方(試作 office: 折り返しは半円で 1 本下の線に移り、折り返す駅の丸は半円の頂点に置く)。
describe("linePath", () => {
  it("折り返さない路線は、1 本の直線で、丸は各駅の真ん中に置く", () => {
    const l = linePath([100, 340, 610, 1120], 400);
    expect(l.d).toBe("M 100 400 L 340 400 L 610 400 L 1120 400");
    expect(l.stops).toEqual([{ x: 100, y: 400 }, { x: 340, y: 400 }, { x: 610, y: 400 }, { x: 1120, y: 400 }]);
    expect(l.turns).toEqual([]);
  });

  it("あとの駅が左にあるときは半円で折り返し、1 本下(LEG_GAP)の線に移る", () => {
    // 受け口 → QA(860) → 開発(340) → レビュー(610) → merge(1120)
    const l = linePath([100, 860, 340, 610, 1120], 296);
    const r = LEG_GAP / 2;
    expect(l.d).toBe(`M 100 296 L 860 296 A ${r} ${r} 0 0 1 860 ${296 + LEG_GAP} L 340 ${296 + LEG_GAP} A ${r} ${r} 0 0 0 340 ${296 + 2 * LEG_GAP} L 610 ${296 + 2 * LEG_GAP} L 1120 ${296 + 2 * LEG_GAP}`);
    // 折り返す駅(QA・開発)の丸は半円の頂点。ほかの駅は線の上
    expect(l.stops[1]).toEqual({ x: 860 + r, y: 296 + r });
    expect(l.stops[2]).toEqual({ x: 340 - r, y: 296 + LEG_GAP + r });
    expect(l.stops[3]).toEqual({ x: 610, y: 296 + 2 * LEG_GAP });
    expect(l.turns).toEqual([{ x1: 860, x2: 340, y: 296 + r }, { x1: 340, x2: 610, y: 296 + LEG_GAP + r }]);
    expect(l.ys).toEqual(l.stops.map((p) => p.y));
  });
});
