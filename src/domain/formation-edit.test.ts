import { describe, expect, it } from "vitest";
import { changeCounts, changeSummary, flowDraftErrors, flowRows, moveStage, preDevStages, routeModeOf, routePairs, routesToNames, setStage, withFlow, withRoute } from "./formation-edit.js";
import { DEFAULT_FORMATION } from "./formation.js";

describe("流れの編集", () => {
  it("流れの工程を順に、そのあとに省略した工程を並べる", () => {
    expect(flowRows(["qa", "dev", "review"])).toEqual([
      { role: "qa", on: true },
      { role: "dev", on: true },
      { role: "review", on: true },
      { role: "sec", on: false },
    ]);
  });
  it("工程を入れ替える。端は動かない。開発はどこにでも置ける", () => {
    expect(moveStage(["dev", "review", "qa"], "qa", -1)).toEqual(["dev", "qa", "review"]);
    expect(moveStage(["dev", "review"], "dev", -1)).toEqual(["dev", "review"]);
    expect(moveStage(["dev", "review"], "review", 1)).toEqual(["dev", "review"]);
    expect(moveStage(["dev", "review", "qa"], "dev", 1)).toEqual(["review", "dev", "qa"]);
  });
  it("省略にした工程は外れ、必須にすると最後に足される。開発は省けない", () => {
    expect(setStage(["dev", "review", "sec"], "sec", false)).toEqual(["dev", "review"]);
    expect(setStage(["dev", "review"], "qa", true)).toEqual(["dev", "review", "qa"]);
    expect(setStage(["dev", "review"], "dev", false)).toEqual(["dev", "review"]);
  });
  it("開発より前の工程は申し送りだけ", () => {
    expect(preDevStages(["qa", "dev", "review"])).toEqual(["qa"]);
    expect(preDevStages(["dev", "qa"])).toEqual([]);
    expect(preDevStages(["review"])).toEqual([]);
  });
  it("決まりに反する流れは理由が出る(開発が無い・merge 待ちの前に工程が無い)", () => {
    expect(flowDraftErrors({ bugfix: ["review"] }, "bugfix")).toEqual(["開発がありません(開発は省けません)"]);
    expect(flowDraftErrors({ docs: [] }, "docs")).toEqual(["merge 待ちの前に工程がありません"]);
    expect(flowDraftErrors({}, "feature")).toEqual([]);
    expect(withFlow({ bugfix: ["dev"] }, "bugfix", undefined)).toEqual({});
  });
});

describe("連絡経路の編集", () => {
  it("組み合わせは、島どうしと、島とリーダー / アーキテクト", () => {
    const pairs = routePairs(["開発", "レビュー"]);
    expect(pairs.filter((p) => p.group === "islands")).toEqual([{ a: "開発", b: "レビュー", group: "islands" }]);
    expect(pairs.filter((p) => p.group === "fixed").map((p) => `${p.a}-${p.b}`)).toEqual(["開発-lead", "レビュー-lead", "開発-architect", "レビュー-architect"]);
  });
  it("向きは問わず切り替わり、連絡しないは持たない", () => {
    const on = withRoute([], "開発", "レビュー", "ask");
    expect(routeModeOf(on, "レビュー", "開発")).toBe("ask");
    expect(withRoute(on, "レビュー", "開発", "none")).toEqual([]);
  });
  it("経路は島の印で持ち、保存のときだけ名前に直す。名前の入力の途中で他の島と同じになっても混ざらない", () => {
    const ids = ["島 1", "島 2"];
    // 島 1 ↔ リーダー、島 2 ↔ レビュー(別の島)
    const routes = [
      { from: "島 1", to: "lead", mode: "ask" as const },
      { from: "島 2", to: "島 3", mode: "ask" as const },
    ];
    // 「島 2」を「島 15」にしようとして、途中で「島 1」と打った
    const mid = routesToNames(routes, ["島 1", "島 2", "島 3"], ["島 1", "島 1", "島 3"]);
    expect(mid).toEqual([
      { from: "島 1", to: "lead", mode: "ask" },
      { from: "島 1", to: "島 3", mode: "ask" },
    ]);
    // 打ち終えれば、もとの組み合わせのまま新しい名前になる
    expect(routesToNames(routes, ["島 1", "島 2", "島 3"], ["島 1", "島 15", "島 3"])).toEqual([
      { from: "島 1", to: "lead", mode: "ask" },
      { from: "島 15", to: "島 3", mode: "ask" },
    ]);
    // 外した島の経路は落ちる
    expect(routesToNames(routes, ids, ["島 1", "島 2"])).toEqual([{ from: "島 1", to: "lead", mode: "ask" }]);
  });
});

describe("保存していない変更の数", () => {
  const cur = { ...DEFAULT_FORMATION, routes: [], flows: {} };
  it("変えていなければ 0", () => {
    expect(changeCounts(cur, structuredClone(cur))).toEqual({ islands: 0, routes: 0, flows: 0 });
    expect(changeSummary({ islands: 0, routes: 0, flows: 0 })).toBe("保存してない変更はありません");
  });
  it("先頭の島を外しても、変えていない島は変更と数えない。足した島・名前を変えた島は 1 つずつ", () => {
    const four = { pull: "down" as const, units: ["a", "b", "c", "d"].map((name) => ({ name, roles: ["dev" as const], maxMembers: 2, summonAt: 2, idleSec: 300 })), routes: [], flows: {} };
    const draft = structuredClone(four);
    draft.units.shift();
    expect(changeCounts(four, draft, ["b", "c", "d"])).toEqual({ islands: 1, routes: 0, flows: 0 });
    draft.units[0]!.name = "b2";
    expect(changeCounts(four, draft, ["b", "c", "d"]).islands).toBe(2);
    draft.units.push({ ...draft.units[0]!, name: "e" });
    expect(changeCounts(four, draft, ["b", "c", "d", "\u00011"]).islands).toBe(3);
  });
  it("タブごとに数え、帯の文にする", () => {
    const draft = structuredClone(cur);
    draft.units[0]!.maxMembers = 2;
    draft.routes = withRoute(withRoute([], "開発の島", "レビューの島", "ask"), "開発の島", "lead", "ask");
    draft.flows = { bugfix: ["qa", "dev"] };
    const c = changeCounts(cur, draft);
    expect(c).toEqual({ islands: 1, routes: 2, flows: 1 });
    expect(changeSummary(c)).toBe("保存してない変更: 島 1 · 連絡経路 2 · 流れ 1");
  });
});
