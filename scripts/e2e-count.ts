/**
 * E2E(Playwright)の件数の読み取り(scripts/check-confined-browser.ts が使う)。
 * 件数を決め打ちにすると、E2E の試験ファイルを足すたびに合わなくなるので、
 * 流す前に `playwright test --list` で数えた件数(expected)と、流したあとの Playwright の「N passed」を突き合わせる。
 */

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*m/g;

/** `npx playwright test --list` の出力の末尾「Total: N tests in M files」から件数を読む。読めなければ null。 */
export function parseListTotal(output: string): number | null {
  const m = [...output.replace(ANSI, "").matchAll(/Total:\s*(\d+)\s+tests?\b/g)].pop();
  return m ? Number(m[1]) : null;
}

/**
 * Playwright の list reporter の要約「  25 passed (1.2m)」から、通った件数を読む(最後に出たもの)。
 * vitest の「Tests  25 passed (25)」は、行頭が数字ではないので拾わない。読めなければ null。
 */
export function parsePassedCount(output: string): number | null {
  const m = [...output.replace(ANSI, "").matchAll(/^\s*(\d+) passed\b/gm)].pop();
  return m ? Number(m[1]) : null;
}

export type E2eCount =
  | { kind: "ok"; passed: number; checkedAgainstList: boolean }
  | { kind: "missing" } // 「N passed」が出力に無い(E2E が流れていない)
  | { kind: "mismatch"; passed: number; expected: number }; // 数えた件数と通った件数が合わない(一部が飛んだ)

/** 出力の「N passed」と、事前に数えた件数(読めなかったら null)を突き合わせる。 */
export function judgeE2eCount(output: string, expected: number | null): E2eCount {
  const passed = parsePassedCount(output);
  if (passed === null || passed === 0) return { kind: "missing" };
  if (expected !== null && passed !== expected) return { kind: "mismatch", passed, expected };
  return { kind: "ok", passed, checkedAgainstList: expected !== null };
}

/** 画面に出す 1 行(通ったときは ○、それ以外は △)。 */
export function describeE2eCount(c: E2eCount): string {
  if (c.kind === "ok") return `○ E2E ${c.passed} 件が通った${c.checkedAgainstList ? "(playwright test --list の件数と一致)" : "(件数を事前に数えられなかったので、出力の「N passed」だけで見た)"}`;
  if (c.kind === "mismatch") return `△ npm test は通ったが、E2E の通った件数(${c.passed})が試験の件数(${c.expected})と合わない(一部が流れていない)`;
  return "△ npm test は通ったが、E2E の「N passed」が出力に見つからない(E2E が流れていない)";
}
