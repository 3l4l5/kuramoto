import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ManualClock } from "../clock.js";
import { FakeHarness, fixedAll, withResolutions } from "../harness/fake.js";
import { designFor } from "./design.js";
import { Dispatcher } from "./dispatcher.js";
import { putArtifact, putScreen, upsertRequirement } from "./planning.js";
import { Project } from "./project.js";
import { patrolTools } from "./patrol.js";
import { unstickTools } from "./unstick.js";
import { createTicket } from "./workflow.js";
import { leadChatTools } from "./leadchat.js";
import { GitWorkspace, StaticWorkspace } from "./workspace.js";

async function setup() {
  const p = await Project.open(":memory:", new ManualClock());
  await p.addRepo("acme/shop", "API");
  await p.saveFormation({ pull: "down", units: [{ name: "開発", roles: ["dev"], maxMembers: 1, summonAt: 2, idleSec: 600 }, { name: "確認", roles: ["review", "qa"], maxMembers: 1, summonAt: 2, idleSec: 600 }] });
  await upsertRequirement(p, { name: "メモの一覧", acceptance: "新しい順に並ぶ" }); // R1
  await upsertRequirement(p, { name: "設定", acceptance: "名前を変えられる" }); // R2
  await putScreen(p, "list", { name: "メモ一覧", device: "phone", requirements: ["R1"], variants: [{ id: "A", html: "<h1>A案</h1>" }, { id: "B", html: "<h1>B案: 青い見出し</h1>" }], chosen: "B", agreed: true });
  await putScreen(p, "settings", { name: "設定", device: "desktop", requirements: ["R2"], variants: [{ id: "A", html: "<h1>設定</h1>" }], chosen: null, agreed: true });
  return p;
}

describe("デザインを合わせる(ADR-0033)", () => {
  it("チケットにひも付けた画面と、要件をひも付けた画面の試作(選んだ案)を渡す", async () => {
    const p = await setup();
    const linked = await createTicket(p, { title: "一覧", planRefs: { screens: ["list"] } });
    const byReq = await createTicket(p, { title: "設定を変える", planRefs: { requirement: "R2" } });
    const none = await createTicket(p, { title: "API だけ" });
    expect((await designFor(p, linked)).map((d) => [d.key, d.html])).toEqual([["list", "<h1>B案: 青い見出し</h1>"]]);
    expect((await designFor(p, byReq)).map((d) => d.file)).toEqual([".kuramoto/design/settings.html"]);
    expect(await designFor(p, none)).toEqual([]);
  });

  it("開発は試作に合わせて作り、QA は試作と見比べるよう指示される。セキュリティには渡さない", async () => {
    const p = await setup();
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
  describe("切り出したチケットへのひも付けの引き継ぎ(#77)", () => {
    const stuck = { error: "x", resume: { toRole: "dev", toMemberId: null, kind: "implement", payload: {} } } as never;

    it("split_and_retry で切り出したチケットは、親の画面・要件を引き継ぎ、試作が渡る。all_screens なら全画面", async () => {
      const p = await setup();
      const parent = await createTicket(p, { title: "一覧を直す", requirementItemId: 1, planRefs: { screens: ["list"], requirement: "R1", designSystem: true, repo: "acme/shop" } });
      const tools = unstickTools(p, parent, stuck, {});
      await tools.find((t) => t.name === "split_and_retry")!.handler({
        tickets: [{ title: "残り", body: "b" }, { title: "全画面を見比べる", body: "b", all_screens: true }],
        advice: "絞る",
      } as never);
      const [, rest, every] = await p.tickets();
      const refs = JSON.parse(rest!.plan_refs);
      expect(refs).toEqual({ splitFrom: parent.number, screens: ["list"], requirement: "R1", repo: "acme/shop" }); // designSystem は引き継がない
      expect((await designFor(p, rest!)).map((d) => d.key)).toEqual(["list"]);
      expect((await p.pdb.from("tickets").select("requirement_item_id").where("id", "=", rest!.id).executeTakeFirst())?.requirement_item_id).toBe(1);
      expect(JSON.parse(every!.plan_refs).allScreens).toBe(true);
      expect((await designFor(p, every!)).map((d) => d.key).sort()).toEqual(["list", "settings"]);
    });

    it("見回りの split も、親の画面を引き継ぎ、all_screens を指定できる", async () => {
      const p = await setup();
      const parent = await createTicket(p, { title: "設定", planRefs: { requirement: "R2" } });
      await patrolTools(p).find((t) => t.name === "split")!.handler({ number: parent.number, tickets: [{ title: "子", body: "b" }, { title: "全部", body: "b", all_screens: true }], advice: "a" } as never);
      const [, child, all] = await p.tickets();
      expect((await designFor(p, child!)).map((d) => d.key)).toEqual(["settings"]);
      expect((await designFor(p, all!)).map((d) => d.key).sort()).toEqual(["list", "settings"]);
    });

    it("リーダーのチャットの create_ticket でも all_screens を指定できる", async () => {
      const p = await setup();
      await leadChatTools(p).find((t) => t.name === "create_ticket")!.handler({ title: "全画面", body: "b", all_screens: true } as never);
      expect((await designFor(p, (await p.tickets())[0]!)).map((d) => d.key).sort()).toEqual(["list", "settings"]);
    });

    it("画面にひも付かない開発にも、デザインシステムの tokens.css などは置く", async () => {
      const p = await setup();
      await putArtifact(p, "screen", "designsystem", "main", { principles: [], tokens: [{ group: "color", name: "--c", value: "#000", use: "x" }], components: [{ name: "ボタン", use: "x", states: [], html: "<button/>" }] });
      await createTicket(p, { title: "API だけ" });
      const harness = new FakeHarness(async (req, call) => {
        if (req.tools.some((t) => t.name === "submit_pr")) await call("submit_pr", { summary: "", responses: fixedAll(req.prompt) });
      });
      const ws = new StaticWorkspace("/tmp/ws");
      await new Dispatcher(p, { harnesses: { "claude-agent-sdk": harness }, workspace: ws }).drain();
      expect([...new Set(ws.designs.map((d) => d.file))]).toEqual([".kuramoto/design/design-system.json", ".kuramoto/design/tokens.css", ".kuramoto/design/components.html"]);
      expect(harness.calls[0]!.prompt).toContain("tokens.css");
    });
  });
});
