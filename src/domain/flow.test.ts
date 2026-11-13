import { describe, expect, it } from "vitest";
import { DEFAULT_FLOW, flowFor, flowsSchema, parseFlows, validateFlows } from "./flow.js";
import { DEFAULT_FORMATION, isPreDev, nextStage, pipelineOf, validateFormation, type FormationSpec } from "./formation.js";

const unit = (name: string, roles: ("dev" | "review" | "sec" | "qa")[]) => ({ name, roles, maxMembers: 2, summonAt: 2, idleSec: 300 });
const ALL = [unit("開発", ["dev"]), unit("レビュー", ["review"]), unit("セキュリティ", ["sec"]), unit("QA", ["qa"])];

describe("流れの検証", () => {
  it("開発が無い流れは保存できない", () => {
    expect(validateFlows({ bugfix: ["qa", "review"] })).toEqual(["バグ修正の流れ: 開発がありません(開発は省けません)"]);
  });

  it("merge 待ちの前に工程が無い流れは保存できない", () => {
    expect(validateFlows({ default: [] })).toEqual(["既定の流れ: merge 待ちの前に工程がありません"]);
  });

  it("同じ工程は 1 回だけ", () => {
    expect(validateFlows({ docs: ["dev", "review", "review"] })).toEqual(["ドキュメントの流れ: レビューが 2 回あります(同じ工程は 1 回だけです)"]);
  });

  it("開発だけの流れ・開発が先頭や途中にある流れ・省略した流れは保存できる", () => {
    expect(validateFlows({ docs: ["dev"], refactor: ["dev", "review"], bugfix: ["qa", "dev", "review"], feature: ["review", "dev", "qa"] })).toEqual([]);
    expect(validateFlows({})).toEqual([]);
  });

  it("知らない種類・知らない工程は受け付けない", () => {
    expect(flowsSchema.safeParse({ chore: ["dev"] }).success).toBe(false);
    expect(flowsSchema.safeParse({ default: ["dev", "deploy"] }).success).toBe(false);
  });

  it("編成の検証にも流れの決まりが入る", () => {
    const spec: FormationSpec = { pull: "down", units: ALL, flows: { bugfix: ["qa"] } };
    expect(validateFormation(spec)).toContain("バグ修正の流れ: 開発がありません(開発は省けません)");
    expect(validateFormation({ ...spec, flows: { bugfix: ["qa", "dev"] } })).toEqual([]);
  });

  it("保存してある流れが壊れていても、決まりに反する流れを捨てるだけで読める", () => {
    expect(parseFlows("not json")).toEqual({});
    expect(parseFlows(JSON.stringify({ default: ["dev", "qa"], bugfix: ["qa"], docs: "x" }))).toEqual({ default: ["dev", "qa"] });
  });
});

describe("工程の組み立て", () => {
  it("流れが無ければ、今までと同じ 開発 → レビュー → セキュリティ → QA", () => {
    expect(pipelineOf({ units: ALL })).toEqual(["dev", "review", "sec", "qa"]);
    expect(pipelineOf({ units: ALL, flows: {} }, "bugfix")).toEqual([...DEFAULT_FLOW]);
  });

  it("種類の流れ → 既定の流れ → 今までの流れ、の順に使う", () => {
    const flows = { default: ["dev", "review"] as const, bugfix: ["qa", "dev", "review"] as const };
    const f = { units: ALL, flows: { default: [...flows.default], bugfix: [...flows.bugfix] } };
    expect(pipelineOf(f, "bugfix")).toEqual(["qa", "dev", "review"]);
    expect(pipelineOf(f, "feature")).toEqual(["dev", "review"]);
    expect(pipelineOf(f)).toEqual(["dev", "review"]);
    expect(flowFor(undefined, "docs")).toEqual([...DEFAULT_FLOW]);
  });

  it("島が無い工程・流れに無い(省略の)工程は飛ばす", () => {
    expect(pipelineOf(DEFAULT_FORMATION)).toEqual(["dev", "review"]);
    expect(pipelineOf({ units: ALL, flows: { refactor: ["dev", "review", "sec"] } }, "refactor")).toEqual(["dev", "review", "sec"]);
    expect(pipelineOf({ units: [unit("開発", ["dev"]), unit("QA", ["qa"])], flows: { bugfix: ["qa", "review", "dev"] } }, "bugfix")).toEqual(["qa", "dev"]);
  });

  it("開発を通ったチケットは、開発より前を落とす", () => {
    const f = { units: ALL, flows: { bugfix: ["qa", "dev", "review"] as const } as never };
    expect(pipelineOf(f, "bugfix", { devDone: true })).toEqual(["dev", "review"]);
    expect(pipelineOf({ units: ALL }, "feature", { devDone: true })).toEqual(["dev", "review", "sec", "qa"]);
  });

  it("次の工程。最後の工程の次は merge 待ち", () => {
    const pipeline = pipelineOf({ units: ALL, flows: { bugfix: ["qa", "dev", "review"] } }, "bugfix");
    expect(nextStage(pipeline, "qa")).toBe("dev");
    expect(nextStage(pipeline, "dev")).toBe("review");
    expect(nextStage(pipeline, "review")).toBe("merge");
    expect(isPreDev(pipeline, "qa")).toBe(true);
    expect(isPreDev(pipeline, "review")).toBe(false);
  });

  it("開発より前の工程として動いていたものは、流れが変わっても開発を飛ばさない", () => {
    expect(nextStage(["dev", "review", "qa"], "qa", { preDev: true })).toBe("dev");
  });
});
