import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";
import { ManualClock } from "../clock.js";
import { FakeHarness, fixedAll, withResolutions } from "../harness/fake.js";
import { ticketView } from "./ticket.js";
import { compareImages, FileDesignStore, playwrightRenderer, referenceImage, type Renderer } from "./design-visual.js";
import { Dispatcher } from "./dispatcher.js";
import { agreeBlocker, putArtifact, putScreen, upsertRequirement, type DesignSystem } from "./planning.js";
import { planningTools } from "./planning-agent.js";
import { Project } from "./project.js";
import { createTicket } from "./workflow.js";
import { StaticWorkspace } from "./workspace.js";
import { blockers } from "./triage.js";

/** 単色の画像(上半分を別の色にもできる)。 */
function png(w: number, h: number, color: [number, number, number], top?: [number, number, number]): Buffer {
  const img = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const c = top && y < h / 2 ? top : color;
      const i = (y * w + x) * 4;
      img.data[i] = c[0];
      img.data[i + 1] = c[1];
      img.data[i + 2] = c[2];
      img.data[i + 3] = 255;
    }
  return PNG.sync.write(img);
}

const DS: DesignSystem = {
  principles: ["主役の色は青 1 色"],
  tokens: [{ group: "color", name: "--color-primary", value: "#2f67d4", use: "主ボタン" }],
  components: [{ name: "主ボタン", use: "確定", states: ["通常", "押せない"], html: '<button style="background:var(--color-primary)">保存</button>' }],
};

describe("画面を画像で見比べる(ADR-0034)", () => {
  it("同じ画像は違い 0、半分違えば約 50%。大きさが違えば知らせる", async () => {
    const a = png(40, 40, [255, 255, 255]);
    expect(compareImages(a, a).ratio).toBe(0);
    expect(compareImages(a, png(40, 40, [255, 255, 255], [0, 0, 0])).ratio).toBeCloseTo(0.5, 1);
    expect(compareImages(a, png(30, 40, [255, 255, 255])).sizeNote).toContain("幅が違います");
  });

  it("お手本の画像は、同じ試作なら描き直さない", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kuramoto-ref-"));
    try {
      const p = new Project(":memory:", new ManualClock());
      let renders = 0;
      const render: Renderer = async (_h, w) => (renders++, png(w, 10, [255, 255, 255]));
      const store = new FileDesignStore(dir);
      const s = { key: "list", html: "<h1>x</h1>", device: "phone" as const };
      const a = await referenceImage(p, store, render, s);
      const b = await referenceImage(p, store, render, s);
      expect(a!.id).toBe(b!.id);
      expect(renders).toBe(1);
      expect(PNG.sync.read(a!.png).width).toBe(390); // スマホは実際の幅で描く
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("担当にデザインシステムとお手本の画像を渡し、QA が撮った画面を比べて、チケットに並べる", async () => {
    const ws = mkdtempSync(join(tmpdir(), "kuramoto-ws-"));
    const storeDir = mkdtempSync(join(tmpdir(), "kuramoto-store-"));
    try {
      const p = new Project(":memory:", new ManualClock());
      p.addRepo("acme/shop", "API");
      p.saveFormation({ pull: "down", units: [{ name: "開発", roles: ["dev"], maxMembers: 1, summonAt: 2, idleSec: 600 }, { name: "確認", roles: ["qa"], maxMembers: 1, summonAt: 2, idleSec: 600 }] });
      await upsertRequirement(p, { name: "一覧", acceptance: "並ぶ" });
      await putArtifact(p, "screen", "designsystem", "main", DS);
      await putScreen(p, "list", { name: "メモ一覧", device: "phone", requirements: ["R1"], variants: [{ id: "A", html: "<h1>一覧</h1>" }], chosen: "A", agreed: true });
      const t = await createTicket(p, { title: "一覧", planRefs: { screens: ["list"] } });
      const render: Renderer = async (_h, w) => png(w, 20, [255, 255, 255]);
      const replies: string[] = [];
      const harness = new FakeHarness(async (req, call) => {
        if (req.tools.some((x) => x.name === "submit_pr")) return void (await call("submit_pr", { summary: "", responses: fixedAll(req.prompt) }));
        // QA: 上半分が違う画面を撮って比べる
        mkdirSync(join(ws, ".kuramoto/shots"), { recursive: true });
        writeFileSync(join(ws, ".kuramoto/shots/list.png"), png(390, 20, [255, 255, 255], [200, 0, 0]));
        replies.push(String(await call("compare_screen", { screen: "list", path: ".kuramoto/shots/list.png" })));
        replies.push(String(await call("compare_screen", { screen: "nope", path: ".kuramoto/shots/list.png" })));
        await call("submit_review", withResolutions(req.prompt, { verdict: "approve", findings: [] }));
      });
      const workspace = new StaticWorkspace(ws);
      await new Dispatcher(p, { harnesses: { "claude-agent-sdk": harness }, workspace, designStore: new FileDesignStore(storeDir), renderer: render }).drain();
      const [dev, qa] = harness.calls.map((c) => c.prompt);
      expect(dev).toContain("tokens.css");
      expect(dev).toContain("お手本の画像 `.kuramoto/design/list.png`");
      expect(qa).toContain("compare_screen");
      expect(harness.calls[0]!.tools.map((x) => x.name)).toContain("compare_screen");
      expect(workspace.designs.map((d) => d.file)).toEqual(expect.arrayContaining([".kuramoto/design/list.html", ".kuramoto/design/list.png", ".kuramoto/design/tokens.css", ".kuramoto/design/components.html", ".kuramoto/design/shots/list-diff.png"]));
      expect(replies[0]).toContain("お手本との違い: 50.0%");
      expect(replies[0]).toContain("違いが大きい");
      expect(replies[1]).toContain("お手本はありません");
      const v = await ticketView(p, t.id);
      expect(v.designCompare).toMatchObject([{ screen: "list", name: "メモ一覧", ratio: 0.5 }]);
      expect(v.designCompare[0]!.reference).toBeTruthy();
    } finally {
      rmSync(ws, { recursive: true, force: true });
      rmSync(storeDir, { recursive: true, force: true });
    }
  });

  it("画面デザインの段階は、デザインシステムが無いと合意できない。引き渡しでは土台のチケットを先に並べられる", async () => {
    const p = new Project(":memory:", new ManualClock());
    p.addRepo("acme/shop", "API");
    await putScreen(p, "list", { name: "一覧", device: "phone", requirements: [], variants: [{ id: "A", html: "<p>x</p>" }], chosen: "A", agreed: true });
    expect(await agreeBlocker(p, "screen")).toBe("デザインシステムがまだありません");
    await putArtifact(p, "screen", "designsystem", "main", DS);
    expect(await agreeBlocker(p, "screen")).toBeNull();

    const tool = (name: string) => planningTools(p, "handoff").find((x) => x.name === name)!;
    void tool("create_ticket").handler({ title: "デザインシステムの土台", body: "トークン・部品・/_design", screens: [], design: [], design_system: true } as never);
    await tool("create_ticket").handler({ title: "一覧の画面", body: "部品で組み立てる", screens: ["list"], design: [], after: [1] } as never);
    const [base, screen] = p.tickets();
    expect(await blockers(p, screen!.id)).toEqual([base!.number]);
  });

  it.skipIf(process.platform !== "darwin")("手元のブラウザで、試作を実際の幅の画像にする", async () => {
    const shot = await playwrightRenderer("<body style='margin:0'><div style='height:1200px;background:#2f67d4'></div></body>", 390);
    const img = PNG.sync.read(shot);
    expect(img.width).toBe(390);
    expect(img.height).toBe(1200); // ページ全体
  }, 60_000);
});
