import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";
import { ManualClock } from "../clock.js";
import { FakeHarness, fixedAll, withResolutions } from "../harness/fake.js";
import { ticketView } from "./ticket.js";
import { createServer } from "node:http";
import { colorDistance, deltaE76, rgbToLab } from "./design-color.js";
import { blockRenderPort, compareImages, FileDesignStore, isLocalUrl, playwrightLocalHtmlRenderer, playwrightRenderer, playwrightUrlRenderer, referenceImage, renderableUrl, type Renderer, type UrlRenderer } from "./design-visual.js";
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

  it("形は同じで色だけ少し違う(背景 #FFFFFF と #F5F5F5)と、形の差分は 0 のまま、色の差分ははっきり出る(CIE76)", () => {
    const white = png(40, 40, [255, 255, 255]);
    const grey = png(40, 40, [245, 245, 245]);
    const c = compareImages(white, grey);
    expect(c.ratio).toBe(0); // pixelmatch(threshold 0.1)は、この差を拾わない
    expect(c.color.method).toBe("CIE76");
    expect(c.color.ratio).toBe(1);
    expect(c.color.meanDeltaE).toBeGreaterThan(3);
    expect(c.color.maxDeltaE).toBeCloseTo(colorDistance(0xffffff, 0xf5f5f5), 1);
    const img = PNG.sync.read(c.colorDiff); // 色の差分の画像。違う画素は塗られる(黄など。白っぽい薄い色ではない)
    expect(img.width).toBe(40);
    expect([img.data[0], img.data[1], img.data[2]]).not.toEqual([255, 255, 255]);
  });

  it("全く同じ 2 枚では、色の差分は 0", () => {
    const a = png(40, 40, [255, 255, 255], [47, 103, 212]);
    const c = compareImages(a, a);
    expect(c.ratio).toBe(0);
    expect(c.color).toMatchObject({ ratio: 0, meanDeltaE: 0, maxDeltaE: 0, referenceOnly: [], actualOnly: [] });
  });

  it("目で分からない程度の違い(ΔE 2.3 以下)は、色の差分に数えない", () => {
    const c = compareImages(png(20, 20, [255, 255, 255]), png(20, 20, [253, 253, 253]));
    expect(c.color.maxDeltaE).toBeLessThan(2.3);
    expect(c.color.ratio).toBe(0);
  });

  it("主な色を並べ、お手本にだけある色・実装にだけある色を挙げる。トークンに近い色にはトークン名を添える", () => {
    // お手本: 白と青(トークン)。実装: 白と、トークンに近いが少し違う青 + ほぼ見えない程度の赤は入れない
    const ref = png(40, 40, [255, 255, 255], [47, 103, 212]);
    const act = png(40, 40, [255, 255, 255], [212, 47, 47]);
    const tokens = [{ name: "--color-primary", value: "#2f67d4" }, { name: "--color-danger", value: "#d42f2f" }];
    const c = compareImages(ref, act, tokens).color;
    expect(c.referenceColors.map((x) => x.hex)).toEqual(expect.arrayContaining(["#FFFFFF", "#2F67D4"]));
    expect(c.referenceOnly.map((x) => x.hex)).toEqual(["#2F67D4"]);
    expect(c.actualOnly.map((x) => x.hex)).toEqual(["#D42F2F"]);
    expect(c.referenceOnly[0]!.token).toMatchObject({ name: "--color-primary", deltaE: 0 });
    expect(c.actualOnly[0]!.token).toMatchObject({ name: "--color-danger", deltaE: 0 });
    expect(c.referenceColors.find((x) => x.hex === "#FFFFFF")!.token).toBeNull();
    // トークンと少し違う色(#2F67D4 → #3468D0)は、近いトークンと、少し違うことが分かる
    const near = compareImages(png(40, 40, [255, 255, 255]), png(40, 40, [255, 255, 255], [52, 104, 208]), tokens).color;
    expect(near.actualOnly[0]!.token!.name).toBe("--color-primary");
    expect(near.actualOnly[0]!.token!.deltaE).toBeGreaterThan(0.5);
  });

  it("ΔE(CIE76)の検算: 白 L=100、白と #F5F5F5 は約 3.5、同じ色は 0", () => {
    expect(rgbToLab(255, 255, 255)[0]).toBeCloseTo(100, 1);
    expect(rgbToLab(0, 0, 0)[0]).toBeCloseTo(0, 1);
    expect(colorDistance(0xffffff, 0xf5f5f5)).toBeCloseTo(3.46, 1);
    expect(deltaE76(rgbToLab(10, 20, 30), rgbToLab(10, 20, 30))).toBe(0);
  });

  it("お手本の画像は、同じ試作なら描き直さない", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kuramoto-ref-"));
    try {
      const p = await Project.open(":memory:", new ManualClock());
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
      const p = await Project.open(":memory:", new ManualClock());
      await p.addRepo("acme/shop", "API");
      await p.saveFormation({ pull: "down", units: [{ name: "開発", roles: ["dev"], maxMembers: 1, summonAt: 2, idleSec: 600 }, { name: "確認", roles: ["qa"], maxMembers: 1, summonAt: 2, idleSec: 600 }] });
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
      // 形の差分に加えて、色の差分(ΔE・画像・主な色の比べ)が QA に渡る
      expect(replies[0]).toContain("色の差分");
      expect(replies[0]).toContain("ΔE");
      expect(replies[0]).toContain("shots/list-color-diff.png");
      expect(replies[0]).toContain("実装にだけある色: #C80000");
      expect(workspace.designs.map((d) => d.file)).toContain(".kuramoto/design/shots/list-color-diff.png");
      expect(dev).toContain("色の差分");
      expect(qa).toContain("色の差分");
      expect(replies[1]).toContain("お手本はありません");
      const v = await ticketView(p, t.id);
      expect(v.designCompare).toMatchObject([{ screen: "list", name: "メモ一覧", ratio: 0.5 }]);
      expect(v.designCompare[0]!.reference).toBeTruthy();
      // 画面(チケットの詳細)に出す、色の差分の数値と画像
      const color = v.designCompare[0]!.color!;
      expect(color).toMatchObject({ method: "CIE76", threshold: 2.3 });
      expect(color.ratio).toBeCloseTo(0.5, 1);
      expect(color.maxDeltaE).toBeGreaterThan(10);
      expect(color.colorDiff).toBeGreaterThan(v.designCompare[0]!.diff);
      expect(color.actualOnly.map((x) => x.hex)).toContain("#C80000");
    } finally {
      rmSync(ws, { recursive: true, force: true });
      rmSync(storeDir, { recursive: true, force: true });
    }
  });

  it("担当はサンドボックスの中でブラウザを動かせないので、render_page でサーバに描かせる(アプリの URL と試作の HTML を、390px と 1280px で)", async () => {
    const ws = mkdtempSync(join(tmpdir(), "kuramoto-ws-"));
    try {
      const p = await Project.open(":memory:", new ManualClock());
      await p.addRepo("acme/shop", "API");
      await createTicket(p, { title: "一覧" });
      const rendered: string[] = [];
      const html: Renderer = async (h, w) => (rendered.push(`html ${w} ${h}`), png(w, 10, [255, 255, 255]));
      const url: UrlRenderer = async (u, w) => (rendered.push(`url ${w} ${u}`), png(w, 10, [0, 0, 255]));
      const replies: string[] = [];
      const harness = new FakeHarness(async (req, call) => {
        if (!req.tools.some((x) => x.name === "submit_pr")) return void (await call("submit_review", withResolutions(req.prompt, { verdict: "approve", findings: [] })));
        mkdirSync(join(ws, ".kuramoto/design"), { recursive: true });
        writeFileSync(join(ws, ".kuramoto/design/list.html"), "<h1>試作</h1>");
        replies.push(String(await call("render_page", { target: "http://localhost:5173/", width: 1280, name: "app" })));
        replies.push(String(await call("render_page", { target: "http://127.0.0.1:5173/memos", width: 390, name: "app" })));
        replies.push(String(await call("render_page", { target: ".kuramoto/design/list.html", width: 390, name: "../list" })));
        replies.push(String(await call("render_page", { target: "https://example.com/", width: 390, name: "ext" })));
        replies.push(String(await call("render_page", { target: "file:///etc/passwd", width: 390, name: "ext" })));
        replies.push(String(await call("render_page", { target: "../outside.html", width: 390, name: "x" })));
        replies.push(String(await call("render_page", { target: ".kuramoto/design/none.html", width: 390, name: "x" })));
        await call("submit_pr", { summary: "", responses: fixedAll(req.prompt) });
      });
      const workspace = new StaticWorkspace(ws);
      await new Dispatcher(p, { harnesses: { "claude-agent-sdk": harness }, workspace, localHtmlRenderer: html, urlRenderer: url }).drain();
      expect(harness.calls[0]!.tools.map((x) => x.name)).toContain("render_page");
      expect(rendered).toEqual(["url 1280 http://localhost:5173/", "url 390 http://127.0.0.1:5173/memos", "html 390 <h1>試作</h1>"]);
      expect(replies[0]).toContain(".kuramoto/design/shots/app-1280.png");
      expect(replies[2]).toContain(".kuramoto/design/shots/___list-390.png");
      // この機械の外の URL・file:・作業場所の外・無いファイルは描かない
      expect(replies[3]).toContain("外の URL");
      expect(replies[4]).toContain("外の URL");
      expect(replies[5]).toContain("見つかりません");
      expect(replies[6]).toContain("見つかりません");
      expect(workspace.designs.map((d) => d.file)).toEqual([".kuramoto/design/shots/app-1280.png", ".kuramoto/design/shots/app-390.png", ".kuramoto/design/shots/___list-390.png"]);
      expect(PNG.sync.read(workspace.designs[1]!.data as Buffer).width).toBe(390);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it("プロジェクトが担当からのローカルの通信を閉じている(sandbox_strict_sockets)ときは、URL を描かない。HTML は描く", async () => {
    const ws = mkdtempSync(join(tmpdir(), "kuramoto-ws-"));
    try {
      const p = await Project.open(":memory:", new ManualClock());
      await p.addRepo("acme/shop", "API");
      await p.setSetting("sandbox_strict_sockets", "1");
      await createTicket(p, { title: "一覧" });
      let urlCalls = 0;
      const replies: string[] = [];
      const harness = new FakeHarness(async (req, call) => {
        if (!req.tools.some((x) => x.name === "submit_pr")) return void (await call("submit_review", withResolutions(req.prompt, { verdict: "approve", findings: [] })));
        writeFileSync(join(ws, "a.html"), "<p>x</p>");
        replies.push(String(await call("render_page", { target: "http://localhost:5173/", width: 390, name: "app" })));
        replies.push(String(await call("render_page", { target: "a.html", width: 390, name: "a" })));
        await call("submit_pr", { summary: "", responses: fixedAll(req.prompt) });
      });
      const workspace = new StaticWorkspace(ws);
      const url: UrlRenderer = async (_u, w) => (urlCalls++, png(w, 10, [0, 0, 255]));
      await new Dispatcher(p, { harnesses: { "claude-agent-sdk": harness }, workspace, localHtmlRenderer: async (_h, w) => png(w, 10, [255, 255, 255]), urlRenderer: url }).drain();
      expect(replies[0]).toContain("sandbox_strict_sockets");
      expect(urlCalls).toBe(0);
      expect(replies[1]).toContain("a-390.png");
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it("描かせないポート(Kuramoto 自身)は、URL としても描かない。描けなかった理由は URL と HTML で分けて返す", async () => {
    const ws = mkdtempSync(join(tmpdir(), "kuramoto-ws-"));
    try {
      blockRenderPort(4300);
      expect(renderableUrl("http://localhost:4300/api/projects")).toBe(false);
      expect(renderableUrl("http://localhost:5173/")).toBe(true);
      const p = await Project.open(":memory:", new ManualClock());
      await p.addRepo("acme/shop", "API");
      await createTicket(p, { title: "一覧" });
      const replies: string[] = [];
      const harness = new FakeHarness(async (req, call) => {
        if (!req.tools.some((x) => x.name === "submit_pr")) return void (await call("submit_review", withResolutions(req.prompt, { verdict: "approve", findings: [] })));
        writeFileSync(join(ws, "a.html"), "<p>x</p>");
        replies.push(String(await call("render_page", { target: "http://localhost:4300/api/projects", width: 390, name: "self" })));
        replies.push(String(await call("render_page", { target: "http://localhost:5173/", width: 390, name: "u" })));
        replies.push(String(await call("render_page", { target: "a.html", width: 390, name: "h" })));
        await call("submit_pr", { summary: "", responses: fixedAll(req.prompt) });
      });
      const fail: Renderer = async () => {
        throw new Error("boom");
      };
      const failUrl: UrlRenderer = async () => {
        throw new Error("boom");
      };
      await new Dispatcher(p, { harnesses: { "claude-agent-sdk": harness }, workspace: new StaticWorkspace(ws), localHtmlRenderer: fail, urlRenderer: failUrl }).drain();
      expect(replies[0]).toContain("Kuramoto 自身の画面は描けません");
      expect(replies[1]).toContain("アプリが起動していて");
      expect(replies[2]).toContain("HTML のファイルを確かめて");
      expect(replies[2]).not.toContain("アプリが起動していて");
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  // 実ブラウザで、ローカルのサーバのページを 390/1280 で撮れること、外への読み込みが止まることを確かめる(darwin のみ)
  it.skipIf(process.platform !== "darwin")("render_page の描き手は、ローカルのページを 390px・1280px で撮り、外への読み込みを止める(URL も HTML も)", async () => {
    const hits: string[] = [];
    const server = createServer((req, res) => {
      hits.push(`${req.headers.host}${req.url}`);
      if (req.url === "/") {
        res.setHeader("content-type", "text/html");
        // localhost. は、名前の上では外(許す名前に無い)だが、解決すれば手元のこのサーバに届く。止まっていれば /blocked には来ない
        res.end(`<body style="margin:0"><div style="height:900px;background:#2f67d4"></div><img src="/ok.png"><img src="http://localhost.:${(server.address() as { port: number }).port}/blocked.png"></body>`);
      } else res.end("");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    try {
      for (const width of [390, 1280]) {
        const img = PNG.sync.read(await playwrightUrlRenderer(`http://localhost:${port}/`, width));
        expect(img.width).toBe(width);
        expect(img.height).toBeGreaterThanOrEqual(900);
      }
      const htmlShot = await playwrightLocalHtmlRenderer(`<body><img src="http://localhost.:${port}/blocked-html.png"><img src="http://localhost:${port}/ok-html.png"></body>`, 390);
      expect(PNG.sync.read(htmlShot).width).toBe(390);
      expect(hits.some((h) => h.endsWith("/ok.png"))).toBe(true);
      expect(hits.some((h) => h.endsWith("/ok-html.png"))).toBe(true);
      expect(hits.filter((h) => h.includes("blocked"))).toEqual([]);
    } finally {
      server.close();
    }
  }, 60_000); // Chrome を 3 回起動するので、macOS の CI のランナーなどの遅い環境では既定の 5 秒に収まらない(隣の「手元のブラウザで」の試験と同じ 60 秒)

  it("描いてよい URL は、この機械の中の http(s) だけ", () => {
    for (const ok of ["http://localhost:5173/", "https://127.0.0.1:8443/x?y=1", "http://[::1]:3000/"]) expect(isLocalUrl(ok)).toBe(true);
    for (const ng of ["https://example.com/", "http://localhost.evil.com/", "http://127.0.0.1.evil.com/", "file:///etc/passwd", "ftp://localhost/", "javascript:alert(1)", "localhost:5173", ""]) expect(isLocalUrl(ng)).toBe(false);
  });

  it("画面デザインの段階は、デザインシステムが無いと合意できない。引き渡しでは土台のチケットを先に並べられる", async () => {
    const p = await Project.open(":memory:", new ManualClock());
    await p.addRepo("acme/shop", "API");
    await putScreen(p, "list", { name: "一覧", device: "phone", requirements: [], variants: [{ id: "A", html: "<p>x</p>" }], chosen: "A", agreed: true });
    expect(await agreeBlocker(p, "screen")).toBe("デザインシステムがまだありません");
    await putArtifact(p, "screen", "designsystem", "main", DS);
    expect(await agreeBlocker(p, "screen")).toBeNull();

    const tool = async (name: string) => (await planningTools(p, "handoff")).find((x) => x.name === name)!;
    void (await tool("create_ticket")).handler({ title: "デザインシステムの土台", body: "トークン・部品・/_design", screens: [], design: [], design_system: true } as never);
    await (await tool("create_ticket")).handler({ title: "一覧の画面", body: "部品で組み立てる", screens: ["list"], design: [], after: [1] } as never);
    const [base, screen] = await p.tickets();
    expect(await blockers(p, screen!.id)).toEqual([base!.number]);
  });

  it.skipIf(process.platform !== "darwin")("手元のブラウザで、試作を実際の幅の画像にする", async () => {
    const shot = await playwrightRenderer("<body style='margin:0'><div style='height:1200px;background:#2f67d4'></div></body>", 390);
    const img = PNG.sync.read(shot);
    expect(img.width).toBe(390);
    expect(img.height).toBe(1200); // ページ全体
  }, 60_000);
});
