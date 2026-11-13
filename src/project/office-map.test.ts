import { describe, expect, it } from "vitest";
import { ManualClock } from "../clock.js";
import type { UnitSpec } from "../domain/formation.js";
import { officeView } from "./office.js";
import { efficiencyDaily } from "./productivity.js";
import { Project } from "./project.js";

const unit = (name: string, roles: UnitSpec["roles"]): UnitSpec => ({ name, roles, maxMembers: 2, summonAt: 2, idleSec: 300 });
const UNITS = [unit("開発", ["dev"]), unit("レビュー", ["review"]), unit("QA", ["qa"])];

function setup(flows: Parameters<Project["saveFormation"]>[0]["flows"], routes: { from: string; to: string; mode: "ask" | "none" }[] = []) {
  const p = new Project(":memory:", new ManualClock());
  p.addRepo("acme/shop", "API");
  p.saveFormation({ pull: "down", units: UNITS, flows, routes });
  return p;
}

describe("オフィスの路線図(R16・R17)", () => {
  it("種類ごとの流れが、島(駅)を通る路線になる。開発より前の工程は pre で印が付く", () => {
    const p = setup({ default: ["review", "dev", "qa"], bugfix: ["qa", "dev", "review"], refactor: ["dev", "qa"] });
    const v = officeView(p);
    const id = (name: string) => v.units.find((u) => u.name === name)!.id;
    expect(v.lines.map((l) => l.kind)).toEqual(["feature", "bugfix", "refactor", "docs"]);
    const stops = (kind: string) => v.lines.find((l) => l.kind === kind)!.stops.map((s) => [s.unitId, s.pre]);
    expect(stops("bugfix")).toEqual([[id("QA"), true], [id("開発"), false], [id("レビュー"), false]]);
    // 流れを決めていない種類は既定の流れ。並びに無い工程は通過(停車しない)
    expect(stops("docs")).toEqual([[id("レビュー"), true], [id("開発"), false], [id("QA"), false]]);
    expect(stops("refactor")).toEqual([[id("開発"), false], [id("QA"), false]]);
  });

  it("許されている連絡経路は、向きを持たない線として駅の名前(unit:ID / lead / arch)で返る", () => {
    const p = setup(undefined, [
      { from: "開発", to: "レビュー", mode: "ask" },
      { from: "QA", to: "lead", mode: "ask" },
      { from: "開発", to: "architect", mode: "ask" },
      { from: "開発", to: "QA", mode: "none" },
    ]);
    const v = officeView(p);
    const id = (name: string) => `unit:${v.units.find((u) => u.name === name)!.id}`;
    const pairs = v.routes.map((r) => [r.a, r.b].sort().join("|"));
    expect(pairs.sort()).toEqual([[id("開発"), id("レビュー")], [id("QA"), "lead"], [id("開発"), "arch"]].map((x) => [...x].sort().join("|")).sort());
    expect(v.asks).toEqual([]);
  });
});

describe("フロー効率の日ごとの推移", () => {
  it("merge した日ごとに、手を動かした時間 ÷ リードタイムを集める。リードタイムが 0 の日は出さない", () => {
    const day = (d: number) => new Date(2026, 10, d, 12).getTime();
    expect(
      efficiencyDaily([
        { at: day(11), active: 30, lead: 100 },
        { at: day(11), active: 10, lead: 100 },
        { at: day(12), active: 50, lead: 100 },
        { at: day(13), active: 0, lead: 0 },
      ]),
    ).toEqual([
      { day: "2026-11-11", value: 0.2 },
      { day: "2026-11-12", value: 0.5 },
    ]);
  });
});
