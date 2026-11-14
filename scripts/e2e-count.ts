/**
 * E2E(Playwright)の件数の読み取り(scripts/check-confined-browser.ts が使う)。
 * 件数を決め打ちにすると、E2E の試験ファイルを足すたびに合わなくなるので、
 * 流す前に `playwright test --list` で数えた件数(expected)と、流したあとの Playwright の要約(N passed / N skipped / N flaky)を突き合わせる。
 * `--list` の件数には、実行時に飛ばす試験(お手本の画像が無いと test.skip する app.spec.ts のオフィスの床など)も入るので、passed + flaky + skipped で比べる。
 */

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*m/g;

/** `npx playwright test --list` の出力の末尾「Total: N tests in M files」から件数を読む。読めなければ null。 */
export function parseListTotal(output: string): number | null {
  const m = [...output.replace(ANSI, "").matchAll(/Total:\s*(\d+)\s+tests?\b/g)].pop();
  return m ? Number(m[1]) : null;
}

/**
 * Playwright の list reporter の要約行(「  16 passed (1.4m)」「  1 skipped」「  1 flaky」)から、その種類の件数を読む(最後に出たもの。出ていなければ 0)。
 * vitest の「Tests  25 passed (25)」は、行頭が数字ではないので拾わない。
 */
function summaryCount(output: string, word: "passed" | "skipped" | "flaky"): number {
  const m = [...output.replace(ANSI, "").matchAll(new RegExp(`^\\s*(\\d+) ${word}\\b`, "gm"))].pop();
  return m ? Number(m[1]) : 0;
}

/** 通った件数(要約に「N passed」が無ければ null)。 */
export function parsePassedCount(output: string): number | null {
  const m = [...output.replace(ANSI, "").matchAll(/^\s*(\d+) passed\b/gm)].pop();
  return m ? Number(m[1]) : null;
}

export type E2eCount =
  | { kind: "ok"; passed: number; skipped: number; flaky: number; checkedAgainstList: boolean }
  | { kind: "missing" } // 「N passed」が出力に無い(E2E が流れていない)
  | { kind: "mismatch"; passed: number; skipped: number; flaky: number; expected: number }; // 数えた件数と合わない(一部が流れていない)

/** 出力の要約と、事前に数えた件数(読めなかったら null)を突き合わせる。 */
export function judgeE2eCount(output: string, expected: number | null): E2eCount {
  const passed = parsePassedCount(output);
  if (passed === null || passed === 0) return { kind: "missing" };
  const skipped = summaryCount(output, "skipped");
  const flaky = summaryCount(output, "flaky");
  if (expected !== null && passed + skipped + flaky !== expected) return { kind: "mismatch", passed, skipped, flaky, expected };
  return { kind: "ok", passed, skipped, flaky, checkedAgainstList: expected !== null };
}

/** 画面に出す 1 行(通ったときは ○、それ以外は △)。 */
export function describeE2eCount(c: E2eCount): string {
  if (c.kind === "missing") return "△ npm test は通ったが、E2E の「N passed」が出力に見つからない(E2E が流れていない)";
  const extra = `${c.skipped ? `・${c.skipped} 件は飛ばした` : ""}${c.flaky ? `・${c.flaky} 件は再試行で通った(flaky)` : ""}`;
  if (c.kind === "mismatch") return `△ npm test は通ったが、E2E の件数(通った ${c.passed}${extra})が試験の件数(${c.expected})と合わない(一部が流れていない)`;
  return `○ E2E ${c.passed} 件が通った${extra}${c.checkedAgainstList ? "(playwright test --list の件数と一致)" : "(件数を事前に数えられなかったので、出力の「N passed」だけで見た)"}`;
}
