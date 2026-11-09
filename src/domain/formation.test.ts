import { describe, expect, it } from "vitest";
import { DEFAULT_FORMATION, nextStage, pipelineOf, validateFormation, type UnitSpec } from "./formation.js";

const unit = (roles: UnitSpec["roles"], maxMembers = 3): UnitSpec => ({ name: roles.join("+"), roles, maxMembers, summonAt: 2, idleSec: 60 });

describe("編成", () => {
  it("既定の編成は正しい", () => {
    expect(validateFormation(DEFAULT_FORMATION)).toEqual([]);
  });

  it("開発は必須。島は 1〜6 つ、同じ役割を複数の島に持たせてよい(ADR-0019)", () => {
    expect(validateFormation({ pull: "down", units: [unit(["review"])] })).toContain("開発の役割は必須です");
    expect(validateFormation({ pull: "down", units: [{ ...unit(["dev"]), name: "開発 A" }, { ...unit(["dev"]), name: "開発 B" }, unit(["review"])] })).toEqual([]);
    expect(validateFormation({ pull: "down", units: Array.from({ length: 7 }, (_, i) => ({ ...unit(["dev"]), name: `島${i}` })) })).toContain("島の数は 1〜6 です");
    expect(validateFormation({ pull: "down", units: [unit(["dev"]), unit(["dev"])] }).join()).toMatch(/重なっています/);
  });

  it("最大人数は島ごとに 1〜10 人", () => {
    expect(validateFormation({ pull: "down", units: [unit(["dev", "review"], 10)] })).toEqual([]);
    expect(validateFormation({ pull: "down", units: [unit(["dev", "review"], 11)] }).join()).toMatch(/1〜10 人/);
  });

  it("リポジトリを登録していれば、どのリポジトリの各工程も受け持つ島があること", () => {
    const repos = ["acme/web", "acme/api"];
    const split = {
      pull: "down" as const,
      units: [
        { ...unit(["dev"]), name: "フロント開発", repos: ["acme/web"] },
        { ...unit(["dev"]), name: "API 開発", repos: ["acme/api"] },
        unit(["review"]),
      ],
    };
    expect(validateFormation(split, repos)).toEqual([]);
    const missing = { ...split, units: [split.units[0]!, split.units[2]!] };
    expect(validateFormation(missing, repos)).toContain("acme/api の開発を受け持つ島がありません");
    expect(validateFormation({ ...split, units: [...split.units, { ...unit(["qa"]), name: "QA", repos: ["acme/other"] }] }, repos).join()).toMatch(/登録されていないリポジトリ acme\/other/);
  });

  it("開発と確認を兼ねる島は 2 人以上", () => {
    expect(validateFormation({ pull: "down", units: [unit(["dev", "qa"], 1)] }).join()).toMatch(/2 以上/);
  });

  it("工程は 開発 → レビュー → セキュリティ → QA の順に、ある役割だけで組む", () => {
    const p = pipelineOf({ units: [unit(["qa", "dev"]), unit(["review"])] });
    expect(p).toEqual(["dev", "review", "qa"]);
    expect(nextStage(p, "review")).toBe("qa");
    expect(nextStage(p, "qa")).toBe("merge");
  });
});
