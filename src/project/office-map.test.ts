import { describe, expect, it } from "vitest";
import { ManualClock } from "../clock.js";
import type { UnitSpec } from "../domain/formation.js";
import { officeView } from "./office.js";
import { efficiencyDaily } from "./productivity.js";
import { Project } from "./project.js";
import { createTicket } from "./workflow.js";

const unit = (name: string, roles: UnitSpec["roles"]): UnitSpec => ({ name, roles, maxMembers: 2, summonAt: 2, idleSec: 300 });
const UNITS = [unit("開発", ["dev"]), unit("レビュー", ["review"]), unit("QA", ["qa"])];

async function setup(flows: Parameters<Project["saveFormation"]>[0]["flows"], routes: { from: string; to: string; mode: "ask" | "none" }[] = []) {
  const p = await Project.open(":memory:", new ManualClock());
  await p.addRepo("acme/shop", "API");
  await p.saveFormation({ pull: "down", units: UNITS, flows, routes });
  return p;
}

describe("オフィスの路線図(R16・R17)", () => {
  it("流れが同じ種類は 1 本の路線にまとまり、既定の流れと同じ路線は既定線、飛ばした工程は skipped に入る", async () => {
    const p = await setup({ default: ["review", "dev", "qa"], bugfix: ["qa", "dev", "review"], refactor: ["dev", "qa"] });
    const v = await officeView(p);
    const id = (name: string) => v.units.find((u) => u.name === name)!.id;
    // 機能とドキュメントは既定の流れ(1 本)、バグ修正、リファクタの 3 本
    expect(v.lines.map((l) => l.kinds.map((k) => k.kind))).toEqual([["feature", "docs"], ["bugfix"], ["refactor"]]);
    expect(v.lines.map((l) => l.isDefault)).toEqual([true, false, false]);
    const line = (kind: string) => v.lines.find((l) => l.kinds.some((k) => k.kind === kind))!;
    const stops = (kind: string) => line(kind).stops.map((s) => [s.unitId, s.pre]);
    // 開発より前の工程は pre。並びに無い工程は停車しない(省略)
    expect(stops("bugfix")).toEqual([[id("QA"), true], [id("開発"), false], [id("レビュー"), false]]);
    expect(stops("docs")).toEqual([[id("レビュー"), true], [id("開発"), false], [id("QA"), false]]);
    expect(stops("refactor")).toEqual([[id("開発"), false], [id("QA"), false]]);
    expect(line("refactor").skipped).toEqual(["レビュー"]);
    expect(line("bugfix").skipped).toEqual([]);
    expect(line("feature").skipped).toEqual([]);
  });

  it("どの種類も流れを決めていなければ、路線は既定線 1 本にまとまる", async () => {
    const v = await officeView(await setup(undefined));
    expect(v.lines).toHaveLength(1);
    expect(v.lines[0]).toMatchObject({ isDefault: true, skipped: [] });
    expect(v.lines[0]!.kinds.map((k) => k.kind)).toEqual(["feature", "bugfix", "refactor", "docs"]);
  });

  it("許されている連絡経路は、向きを持たない線として駅の名前(unit:ID / lead / arch)で返る", async () => {
    const p = await setup(undefined, [
      { from: "開発", to: "レビュー", mode: "ask" },
      { from: "QA", to: "lead", mode: "ask" },
      { from: "開発", to: "architect", mode: "ask" },
      { from: "開発", to: "QA", mode: "none" },
    ]);
    const v = await officeView(p);
    const id = (name: string) => `unit:${v.units.find((u) => u.name === name)!.id}`;
    const pairs = v.routes.map((r) => [r.a, r.b].sort().join("|"));
    expect(pairs.sort()).toEqual([[id("開発"), id("レビュー")], [id("QA"), "lead"], [id("開発"), "arch"]].map((x) => [...x].sort().join("|")).sort());
    expect(v.asks).toEqual([]);
  });
});

describe("路線の上の札", () => {
  it("開いているチケットは、その種類と居場所(where)で返る。完了したものは返さない", async () => {
    const p = await setup({ bugfix: ["qa", "dev"] });
    const t = await createTicket(p, { title: "ずれる", kind: "bugfix" });
    const v = await officeView(p);
    expect(v.ticketKinds[t.number]).toBe("bugfix");
    // 開発より前の QA から始まるので、居場所は QA の島
    expect(v.where[t.number]).toBe(`unit:${v.units.find((u) => u.name === "QA")!.id}`);
  });
});

describe("フロー効率の日ごとの推移", () => {
  it("merge した日ごとに、手を動かした時間 ÷ リードタイムを集める。リードタイムが 0 の日は出さない", async () => {
    const day = (d: number) => new Date(2026, 10, d, 12).getTime();
    expect(
      efficiencyDaily([
        { at: day(11), active: 30, lead: 100 },
        { at: day(11) + 3600_000, active: 10, lead: 100 },
        { at: day(12), active: 50, lead: 100 },
        { at: day(13), active: 0, lead: 0 },
      ]),
    ).toEqual([
      // at は、その日の最後の merge の時刻(推移の図で、時刻の軸に置く位置)
      { day: "2026-11-11", value: 0.2, at: new Date(day(11) + 3600_000).toISOString() },
      { day: "2026-11-12", value: 0.5, at: new Date(day(12)).toISOString() },
    ]);
  });
});
