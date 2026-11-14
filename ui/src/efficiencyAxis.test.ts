import { describe, expect, it } from "vitest";
import { axisLabel, axisRange, axisX, stamp, trendTimes } from "./efficiencyAxis";

const at = (d: number, h: number, m = 0) => new Date(2026, 10, d, h, m).getTime();

describe("フロー効率の推移の横軸(時刻)", () => {
  it("同じ日に 2 回編成を変えたら、時刻に応じて別の位置になる(時刻に比例する)", () => {
    // 11/12 〜 11/14 の記録。11/13 の 09:00 と 15:30 に版が上がった
    const first = at(12, 12);
    const last = at(14, 12);
    const range = axisRange([first, last, at(13, 9), at(13, 15, 30)])!;
    const x9 = axisX(at(13, 9), range, 34, 378);
    const x1530 = axisX(at(13, 15, 30), range, 34, 378);
    expect(x1530).toBeGreaterThan(x9);
    // 位置の差は、時刻の差(6 時間 30 分 / 48 時間)に比例する
    expect(x1530 - x9).toBeCloseTo(((6.5 * 3600_000) / (48 * 3600_000)) * (378 - 34), 6);
    expect(axisX(first, range, 34, 378)).toBe(34);
    expect(axisX(last, range, 34, 378)).toBe(378);
  });

  it("時刻が 1 つだけ(長さ 0)なら真ん中、何も無ければ範囲は無い", () => {
    const t = at(13, 9);
    expect(axisX(t, axisRange([t])!, 34, 378)).toBe(206);
    expect(axisRange([])).toBeNull();
  });

  it("時刻の表記: 札の詳細は 11/14 15:30。軸の端は、期間が 2 日以内なら時刻まで、長ければ日だけ", () => {
    expect(stamp(at(14, 15, 30))).toBe("11/14 15:30");
    expect(stamp(at(4, 9, 5))).toBe("11/04 09:05");
    const short = axisRange([at(14, 9), at(14, 15, 30)])!;
    expect(axisLabel(short.min, short)).toBe("11/14 09:00");
    expect(axisLabel(short.max, short)).toBe("11/14 15:30");
    const long = axisRange([at(1, 9), at(14, 15, 30)])!;
    expect(axisLabel(long.min, long)).toBe("11/01");
    expect(axisLabel(long.max, long)).toBe("11/14");
  });
});

describe("推移の図に並べる時刻", () => {
  it("効率の記録と編成の版の時刻を、同じ軸に並べる(同じ日の 2 つの版は別の時刻のまま)", () => {
    const iso = (t: number) => new Date(t).toISOString();
    const rows = [{ at: iso(at(12, 12)) }, { at: iso(at(14, 12)) }];
    const marks = [{ at: iso(at(13, 9)) }, { at: iso(at(13, 15, 30)) }];
    const times = trendTimes(rows, marks);
    expect(times).toEqual([at(12, 12), at(14, 12), at(13, 9), at(13, 15, 30)]);
    const range = axisRange(times)!;
    expect(axisX(times[3]!, range, 0, 100)).toBeGreaterThan(axisX(times[2]!, range, 0, 100));
    expect(trendTimes([], [])).toEqual([]);
  });
});
