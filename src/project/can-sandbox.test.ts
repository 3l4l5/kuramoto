import { describe, expect, it } from "vitest";
import { canSandbox, insideConfinement } from "./can-sandbox.js";

describe("canSandbox / insideConfinement", () => {
  it("macOS 以外では、閉じ込められず、閉じ込めの中でもない。macOS では、閉じ込められるか閉じ込めの中かのどちらか", () => {
    if (process.platform !== "darwin") {
      expect(canSandbox()).toBe(false);
      expect(insideConfinement()).toBe(false);
    } else {
      expect(insideConfinement()).toBe(!canSandbox());
    }
  });
});
