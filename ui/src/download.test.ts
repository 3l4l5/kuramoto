import { describe, expect, it } from "vitest";
import { filenameFromDisposition } from "./download";

describe("ダウンロードの名前(Content-Disposition)", () => {
  it("filename* (UTF-8)を優先して、日本語の名前を戻す", () => {
    const h = `attachment; filename="design.md"; filename*=UTF-8''${encodeURIComponent("予約サイト-設計書.md")}`;
    expect(filenameFromDisposition(h, "x.md")).toBe("予約サイト-設計書.md");
  });
  it("filename* が無ければ filename を使う", () => {
    expect(filenameFromDisposition('attachment; filename="design.zip"', "x.zip")).toBe("design.zip");
  });
  it("壊れた filename* は filename に進む", () => {
    expect(filenameFromDisposition(`attachment; filename="design.md"; filename*=UTF-8''%E0%A4%A`, "x.md")).toBe("design.md");
  });
  it("ヘッダーが無い・名前が無いときは fallback", () => {
    expect(filenameFromDisposition(null, "x.md")).toBe("x.md");
    expect(filenameFromDisposition("attachment", "x.md")).toBe("x.md");
  });
});
