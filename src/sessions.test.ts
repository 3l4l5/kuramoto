import { describe, expect, it } from "vitest";
import { Sessions } from "./sessions.js";

describe("セッション(ADR-0061)", () => {
  it("ID は毎回違い、推測できない長さで、発行したものだけが通る", () => {
    const s = new Sessions();
    const a = s.issue();
    const b = s.issue();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(40);
    expect(s.valid(a)).toBe(true);
    expect(s.valid(b)).toBe(true);
    for (const bad of [undefined, "", "nope", a + "x", a.slice(1)]) expect(s.valid(bad)).toBe(false);
  });

  it("期限が来たら通らず、捨てられる", () => {
    let now = 0;
    const s = new Sessions(1000, () => now);
    const a = s.issue();
    now = 999;
    expect(s.valid(a)).toBe(true);
    now = 1000;
    expect(s.valid(a)).toBe(false);
    expect(s.size).toBe(0);
    expect(s.maxAgeSeconds).toBe(1);
  });

  it("1 つ・すべてを失効できる", () => {
    const s = new Sessions();
    const [a, b, c] = [s.issue(), s.issue(), s.issue()];
    s.revoke(a);
    s.revoke(undefined);
    expect(s.valid(a)).toBe(false);
    expect(s.valid(b)).toBe(true);
    expect(s.revokeAll()).toBe(2);
    expect(s.valid(b)).toBe(false);
    expect(s.valid(c)).toBe(false);
  });

  it("覚えているのは ID のハッシュだけ(メモリを覗かれても ID は復元できない)", () => {
    const s = new Sessions();
    const a = s.issue();
    const keys = [...(s as unknown as { live: Map<string, number> }).live.keys()];
    expect(keys).toHaveLength(1);
    expect(keys[0]).not.toContain(a);
  });
});
