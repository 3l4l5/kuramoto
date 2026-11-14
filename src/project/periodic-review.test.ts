import { describe, expect, it } from "vitest";
import { similarity, DUPLICATE_SIMILARITY } from "./periodic-review.js";

describe("定期レビューの重複判定", () => {
  it("同じ題名・記号や空白だけ違う題名は重複とみなす", () => {
    expect(similarity("一覧の余白がずれている", "一覧の余白がずれている")).toBe(1);
    expect(similarity("一覧の余白が ずれている!", "一覧の余白がずれている")).toBe(1);
  });
  it("似ている題名は重複、別のことは重複ではない", () => {
    expect(similarity("一覧の余白が試作とずれている", "一覧の余白が試作とずれてる")).toBeGreaterThanOrEqual(DUPLICATE_SIMILARITY);
    expect(similarity("一覧の余白が試作とずれている", "ボタンの色がトークン外")).toBeLessThan(DUPLICATE_SIMILARITY);
    expect(similarity("", "a")).toBe(0);
  });
});
