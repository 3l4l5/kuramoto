import { describe, expect, it } from "vitest";
import { describeE2eCount, judgeE2eCount, parseListTotal, parsePassedCount } from "./e2e-count.js";

const VITEST = "      Tests  15 passed (15)\n   Duration  3.2s\n";
const PLAYWRIGHT = "  ✓  1 [chromium] › e2e/auth.spec.ts:5:1 › x (1.0s)\n\n  17 passed (1.4m)\n";

describe("parseListTotal", () => {
  it("--list の末尾の件数を読む", () => {
    expect(parseListTotal("Listing tests:\n  e2e/a.spec.ts:3:1 › x\nTotal: 17 tests in 5 files\n")).toBe(17);
    expect(parseListTotal("Total: 1 test in 1 file")).toBe(1);
  });
  it("色つきでも読める。読めなければ null", () => {
    expect(parseListTotal("\u001b[2mTotal: 17 tests in 5 files\u001b[22m")).toBe(17);
    expect(parseListTotal("Error: Cannot find module")).toBeNull();
  });
});

describe("parsePassedCount", () => {
  it("Playwright の要約を読み、vitest の「Tests  N passed」は拾わない", () => {
    expect(parsePassedCount(VITEST + PLAYWRIGHT)).toBe(17);
    expect(parsePassedCount(VITEST)).toBeNull();
  });
  it("最後の要約を読む・色つきでも読める", () => {
    expect(parsePassedCount("  3 passed (1s)\n\u001b[32m  17 passed\u001b[39m (1m)")).toBe(17);
  });
});

describe("judgeE2eCount", () => {
  it("事前の件数と合えば ok(auth.spec.ts を足して件数が変わっても、決め打ちなしで通る)", () => {
    expect(judgeE2eCount(PLAYWRIGHT, 17)).toEqual({ kind: "ok", passed: 17, checkedAgainstList: true });
  });
  it("事前の件数が数えられなかったときは、N passed だけで ok", () => {
    expect(judgeE2eCount(PLAYWRIGHT, null)).toEqual({ kind: "ok", passed: 17, checkedAgainstList: false });
  });
  it("件数が合わなければ mismatch、N passed が無ければ missing", () => {
    expect(judgeE2eCount(PLAYWRIGHT, 25)).toEqual({ kind: "mismatch", passed: 17, expected: 25 });
    expect(judgeE2eCount(VITEST, 15)).toEqual({ kind: "missing" });
    expect(judgeE2eCount("  0 passed (1s)", 0)).toEqual({ kind: "missing" });
  });
  it("画面の 1 行は、ok のときだけ ○", () => {
    expect(describeE2eCount({ kind: "ok", passed: 17, checkedAgainstList: true })).toMatch(/^○ E2E 17 件/);
    expect(describeE2eCount({ kind: "mismatch", passed: 17, expected: 25 })).toMatch(/^△/);
    expect(describeE2eCount({ kind: "missing" })).toMatch(/^△/);
  });
});
