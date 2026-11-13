import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ManualClock } from "../clock.js";
import { FakeHarness, fixedAll, withResolutions } from "../harness/fake.js";
import { designFor } from "./design.js";
import { Dispatcher } from "./dispatcher.js";
import { putScreen, upsertRequirement } from "./planning.js";
import { Project } from "./project.js";
import { createTicket } from "./workflow.js";
import { GitWorkspace, StaticWorkspace } from "./workspace.js";

function setup() {
  const p = new Project(":memory:", new ManualClock());
  p.addRepo("acme/shop", "API");
  p.saveFormation({ pull: "down", units: [{ name: "開発", roles: ["dev"], maxMembers: 1, summonAt: 2, idleSec: 600 }, { name: "確認", roles: ["review", "qa"], maxMembers: 1, summonAt: 2, idleSec: 600 }] });
  upsertRequirement(p, { name: "メモの一覧", acceptance: "新しい順に並ぶ" }); // R1
  upsertRequirement(p, { name: "設定", acceptance: "名前を変えられる" }); // R2
  putScreen(p, "list", { name: "メモ一覧", device: "phone", requirements: ["R1"], variants: [{ id: "A", html: "<h1>A案</h1>" }, { id: "B", html: "<h1>B案: 青い見出し</h1>" }], chosen: "B", agreed: true });
  putScreen(p, "settings", { name: "設定", device: "desktop", requirements: ["R2"], variants: [{ id: "A", html: "<h1>設定</h1>" }], chosen: null, agreed: true });
  return p;
}

describe("デザインを合わせる(ADR-0033)", () => {
  it("チケットにひも付けた画面と、要件をひも付けた画面の試作(選んだ案)を渡す", async () => {
    const p = setup();
    const linked = await createTicket(p, { title: "一覧", planRefs: { screens: ["list"] } });
    const byReq = await createTicket(p, { title: "設定を変える", planRefs: { requirement: "R2" } });
    const none = await createTicket(p, { title: "API だけ" });
    expect(designFor(p, linked).map((d) => [d.key, d.html])).toEqual([["list", "<h1>B案: 青い見出し</h1>"]]);
    expect(designFor(p, byReq).map((d) => d.file)).toEqual([".kuramoto/design/settings.html"]);
    expect(designFor(p, none)).toEqual([]);
  });

  it("開発は試作に合わせて作り、QA は試作と見比べるよう指示される。セキュリティには渡さない", async () => {
    const p = setup();
    await createTicket(p, { title: "一覧", planRefs: { screens: ["list"] } });
    const harness = new FakeHarness(async (req, call) => {
      if (req.tools.some((t) => t.name === "submit_pr")) await call("submit_pr", { summary: "", responses: fixedAll(req.prompt) });
      else await call("submit_review", withResolutions(req.prompt, { verdict: "approve", findings: [] }));
    });
    const ws = new StaticWorkspace("/tmp/ws");
    await new Dispatcher(p, { harnesses: { "claude-agent-sdk": harness }, workspace: ws }).drain();
    const [dev, review, qa] = harness.calls.map((c) => c.prompt);
    expect(dev).toContain("## 画面のデザイン");
    expect(dev).toContain("`.kuramoto/design/list.html`");
    expect(dev).toContain("お手本の画像に合わせて作ります");
    expect(review).toContain("試作と食い違っていないか");
    expect(qa).toContain("compare_screen");
    expect(qa).toContain("スマホ(幅 390px)");
    expect(ws.designs[0]).toEqual({ file: ".kuramoto/design/list.html", data: "<h1>B案: 青い見出し</h1>" });
  });

  it("作業場所に置いた試作は、git の変更に出てこない", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kuramoto-design-"));
    try {
      execFileSync("git", ["init", "-q", dir]);
      await new GitWorkspace(dir).writeDesign(dir, join(dir, ".git"), [{ file: ".kuramoto/design/list.html", data: "<h1>x</h1>" }]);
      expect(existsSync(join(dir, ".kuramoto/design/list.html"))).toBe(true);
      expect(execFileSync("git", ["-C", dir, "status", "--porcelain"]).toString()).toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
