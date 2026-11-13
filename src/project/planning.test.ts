import { describe, expect, it } from "vitest";
import { ManualClock } from "../clock.js";
import { FakeHarness, type FakeStep } from "../harness/fake.js";
import { Dispatcher } from "./dispatcher.js";
import { Project } from "./project.js";
import {
  addComment,
  advance,
  agree,
  agreeBlocker,
  agreeScreen,
  answerOpenItem,
  chat,
  handoff,
  handoffBlocker,
  messages,
  openItems,
  pickVariant,
  setMode,
  stageDone,
  stageRow,
  studioView,
} from "./planning.js";
import { StaticWorkspace } from "./workspace.js";

/** 企画の担当たちの台本。渡された道具の名前で、誰が起こされたかを見分ける。 */
const agents: FakeStep = async (req, call) => {
  const has = (n: string) => req.tools.some((t) => t.name === n);
  const ev = req.prompt;
  if (has("set_brief")) {
    if (ev.includes("責任者: 予約")) {
      await call("set_brief", { purpose: "スマホから予約を 1 分で終える", users: ["会員"], out_of_scope: ["決済"] });
      await call("upsert_requirement", { name: "空き枠を探す", acceptance: "店舗と日付を選ぶと、残りのある枠が時間順に並ぶ" });
      await call("upsert_requirement", { name: "予約する", acceptance: "枠を選んで確定すると予約が確定する" });
      await call("add_open_item", { question: "変更を作るか", options: ["作らない", "作る"], recommended: 0, why: "キャンセルと予約し直しで足りる", reversible: true });
      return { finalText: "要件を書きました。未決が 1 件あります。" };
    }
    if (ev.includes("[answer]")) {
      await call("upsert_requirement", { code: "R2", name: "予約する", acceptance: "枠を選んで確定すると予約が確定する。変更は作らない" });
      return { finalText: "反映しました。" };
    }
    if (ev.includes("[kickoff]")) return { finalText: "企画担当の咲季です。何のためのものですか?" };
  }
  if (has("set_infra")) {
    if (ev.includes("[answer]")) return { finalText: "反映しました。" };
    await call("set_infra", {
      hosting: { summary: "既存の AWS に載せる", reuse: ["acme の AWS アカウント"] },
      components: [
        { name: "Web", kind: "web", service: "CloudFront + S3", purpose: "画面を配る", isNew: true },
        { name: "API", kind: "api", service: "既存の shop-api(ECS)", purpose: "予約の API", isNew: false },
        { name: "DB", kind: "db", service: "既存の RDS PostgreSQL", purpose: "予約を保存", isNew: false },
      ],
      links: [{ from: "Web", to: "API", label: "HTTPS" }, { from: "API", to: "DB", label: "SQL" }],
      environments: [{ name: "staging", purpose: "確認用" }, { name: "production", purpose: "本番" }],
      deploy: { ci: "GitHub Actions", steps: ["main に merge で staging へ", "タグで本番へ"], migrations: "デプロイ前に流す", secrets: "AWS Secrets Manager" },
      operations: { monitoring: "CloudWatch", logging: "CloudWatch Logs", backup: "RDS の自動バックアップ 7 日", rollback: "前のタスク定義に戻す" },
      cost: { assumptions: ["月 1 万予約"], monthly: [{ item: "CloudFront + S3", usd: 5 }] },
    });
    await call("add_open_item", { question: "データを日本のリージョンに置くか", options: ["東京", "米国"], recommended: 0, why: "後から移すのは難しい", reversible: false });
    return { finalText: "既存の AWS に載せる構成にしました。" };
  }
  if (has("set_flow")) {
    await call("set_flow", {
      nodes: [
        { id: "S1", label: "空き枠を探す", sub: "R1", col: 0, row: 0 },
        { id: "S2", label: "予約の確認", sub: "R2", col: 1, row: 0 },
      ],
      edges: [{ from: "S1", to: "S2", label: "枠を選ぶ" }],
    });
    return { finalText: "フローを描きました。" };
  }
  if (has("upsert_screen")) {
    if (ev.includes("[comment]")) {
      const id = Number(ev.match(/コメント #(\d+)/)![1]);
      await call("upsert_screen", { key: "search", name: "空き枠を探す", device: "phone", requirements: ["R1"], variants: [{ id: "A", html: "<p>A2</p>" }, { id: "B", html: "<p>B</p>" }] });
      await call("resolve_comment", { id });
      return { finalText: "直しました。" };
    }
    await call("set_design_system", { principles: ["青 1 色"], tokens: [{ group: "color", name: "--color-primary", value: "#2f67d4", use: "主ボタン" }], components: [{ name: "主ボタン", use: "確定", states: ["通常"], html: "<button>確定</button>" }] });
    await call("upsert_screen", { key: "search", name: "空き枠を探す", device: "phone", requirements: ["R1"], variants: [{ id: "A", html: "<p>A</p>" }, { id: "B", html: "<p>B</p>" }] });
    await call("upsert_screen", { key: "confirm", name: "予約の確認", device: "phone", requirements: ["R2"], variants: [{ id: "A", html: "<p>C</p>" }] });
    return { finalText: "試作を作りました。" };
  }
  if (has("set_domain_model")) {
    await call("set_architecture", {
      style: { name: "モジュラーモノリス", why: "小さいチームで速く作れる", alternatives: [{ name: "サービス分割", whyNot: "運用が重い" }] },
      modules: [{ name: "予約", responsibility: "枠と予約", repo: "acme/shop" }],
      principles: ["ドメイン層はインフラに依存しない"],
      api: { style: "REST", notes: "" },
      frontend: { rendering: "SPA", state: "サーバーの状態はキャッシュする" },
      stack: [{ area: "API", choice: "Hono", why: "軽い" }],
    });
    await call("set_domain_model", {
      terms: ["枠 = 予約を受け付ける時間帯"], aggregates: ["予約"], rules: ["定員を超えない"], states: ["確定 → キャンセル"], boundaries: ["acme/shop が持つ"],
      build: [{ feature: "空き枠を探す", decision: "build", note: "" }],
      entities: [{ name: "予約", isNew: true, fields: ["id", "slot_id"] }], relations: [],
    });
    await call("set_data_design", { tables: [{ name: "reservations", change: "new", columns: ["id", "slot_id"], note: "", reversible: true }] });
    if (ev.includes("お任せ")) return { finalText: "お任せで決めました。" };
    if (ev.includes("[answer]")) return { finalText: "反映しました。" };
    await call("add_open_item", { question: "注文の表に載せるか", options: ["新しい表", "注文の表"], recommended: 0, why: "戻しにくい", reversible: false });
    return { finalText: "設計を書きました。" };
  }
  if (has("create_ticket")) {
    await call("create_ticket", { title: "予約の表を足す", body: "マイグレーション", requirement: "R2", screens: [], design: ["reservations 表"] });
    await call("create_ticket", { title: "空き枠を探す画面", body: "R1", requirement: "R1", screens: ["search"], design: [] });
    await call("finish_handoff", {});
    return { finalText: "" };
  }
};

async function setup(script: FakeStep = agents) {
  const p = await Project.open(":memory:", new ManualClock());
  await p.addRepo("acme/shop", "API");
  await p.setSetting("project_name", "acme 予約サイト");
  const harness = new FakeHarness(script);
  const d = new Dispatcher(p, { harnesses: { "claude-agent-sdk": harness }, workspace: new StaticWorkspace("/tmp/ws"), ticketsAllowed: () => false });
  return { p, d, harness };
}

describe("企画スタジオ", () => {
  it("要件 → フロー → 画面 → ドメインとデータ を順に決めて、チームに渡す", async () => {
    const { p, d, harness } = await setup();

    // リポジトリを登録すると、企画担当が聞き始める
    await advance(p);
    await d.drain();
    expect((await messages(p, "req")).map((m) => m.who)).toEqual(["plan"]);
    expect((await stageRow(p, "flow")).version).toBe(1);

    // 要件: 対話で書き、未決に答え、合意する
    await chat(p, "req", "予約サイトを作りたい");
    await d.drain();
    expect(await agreeBlocker(p, "req")).toMatch(/未決/);
    await answerOpenItem(p, (await openItems(p, "req"))[0]!.id, "作らない");
    await d.drain();
    expect((await studioView(p)).requirements.find((r) => r.code === "R2")!.acceptance).toContain("変更は作らない");
    // 次の段階は、前の段階を終えるまで始まらない
    expect(harness.calls.some((c) => c.tools.some((t) => t.name === "set_flow"))).toBe(false);
    await agree(p, "req");

    // フロー: 要件の合意をきっかけにデザイナーが描く
    await d.drain();
    expect((await studioView(p)).flow!.nodes).toHaveLength(2);
    await agree(p, "flow");

    // 画面: 2 案から選び、コメントを付けると直してくる
    await d.drain();
    expect(await agreeBlocker(p, "screen")).toMatch(/案を選んで/);
    await pickVariant(p, "search", "A");
    await addComment(p, "search", { variant: "A", x: 50, y: 80, body: "ボタンを大きく" });
    await expect(agreeScreen(p, "search")).rejects.toThrow(/対応待ち/);
    await d.drain();
    await agreeScreen(p, "search");
    await agreeScreen(p, "confirm");
    expect((await studioView(p)).screens.find((s) => s.key === "search")!.variants[0]!.html).toBe("<p>A2</p>");
    await agree(p, "screen");

    // インフラ: 画面の合意をきっかけにアーキテクトが書く。画面の中身も渡されている。戻せない選択は未決に入る
    await d.drain();
    expect((await studioView(p)).infra!.components).toHaveLength(3);
    const infraCall = harness.calls.find((c) => c.tools.some((t) => t.name === "set_infra"))!;
    expect(infraCall.prompt).toContain('"screens"');
    expect(await agreeBlocker(p, "infra")).toMatch(/未決/);
    expect(harness.calls.some((c) => c.tools.some((t) => t.name === "set_domain_model"))).toBe(false);
    await answerOpenItem(p, (await openItems(p, "infra"))[0]!.id, "東京");
    await d.drain();
    await agree(p, "infra");

    // アーキテクチャとデータ: インフラの合意をきっかけに、アーキテクチャスタイルから書く。戻せない判断は未決に入る
    await d.drain();
    expect((await studioView(p)).architecture!.style.name).toBe("モジュラーモノリス");
    expect(harness.calls.find((c) => c.tools.some((t) => t.name === "set_domain_model"))!.prompt).toContain('"infra"');
    expect((await openItems(p, "model")).filter((o) => o.answer === null)).toHaveLength(1);
    expect(await handoffBlocker(p)).toMatch(/アーキテクチャとデータ/);
    await answerOpenItem(p, (await openItems(p, "model"))[0]!.id, "新しい表");
    await d.drain();
    await agree(p, "model");

    // チームに渡す: リーダーがチケットを作る
    expect(await handoffBlocker(p)).toBeNull();
    await handoff(p);
    await d.drain();
    expect((await p.tickets()).map((t) => t.title)).toEqual(["予約の表を足す", "空き枠を探す画面"]);
    expect((await studioView(p)).handoff.handed).toBe(true);
    expect((await studioView(p)).tickets[1]!.refs).toMatchObject({ requirement: "R1", screens: ["search"], fromPlan: true });
    // チケットは開発の受信箱に入るが、オフィスを動かすまで取られない
    expect(harness.calls.some((c) => c.tools.some((t) => t.name === "submit_pr"))).toBe(false);
  });

  it("フローの未決の答えを要件に書き足しても、要件は合意済みのままで、フローに合意すると画面デザインが始まる", async () => {
    const { p, d, harness } = await setup(async (req, call) => {
      const has = (n: string) => req.tools.some((t) => t.name === n);
      if (has("set_brief")) {
        if (req.prompt.includes("責任者:")) await call("upsert_requirement", { name: "メモを書く", acceptance: "書くと保存される" });
        return { finalText: "書きました" };
      }
      if (has("set_flow")) {
        if (req.prompt.includes("[answer]")) {
          // デザイナーが、責任者の答えを要件の受け入れ条件に書き足す
          await call("upsert_requirement", { code: "R1", name: "メモを書く", acceptance: "書くと保存される。空のメモは自動で消す" });
          return { finalText: "反映しました" };
        }
        await call("set_flow", { nodes: [{ id: "S1", label: "一覧", col: 0, row: 0 }], edges: [] });
        await call("add_open_item", { question: "空のメモはどうするか", options: ["消す", "残す"], recommended: 0, why: "", reversible: true });
        return { finalText: "描きました" };
      }
      if (has("upsert_screen")) {
        await call("set_design_system", { principles: ["青 1 色"], tokens: [{ group: "color", name: "--color-primary", value: "#2f67d4", use: "主ボタン" }], components: [{ name: "主ボタン", use: "確定", states: ["通常"], html: "<button>確定</button>" }] });
        await call("upsert_screen", { key: "list", name: "一覧", device: "phone", requirements: ["R1"], variants: [{ id: "A", html: "<p/>" }] });
        return { finalText: "作りました" };
      }
    });
    await setMode(p, "infra", "skip");
    await advance(p);
    await chat(p, "req", "メモアプリ");
    await d.drain();
    await agree(p, "req");
    await d.drain();
    await answerOpenItem(p, (await openItems(p, "flow"))[0]!.id, "消す");
    await d.drain();

    expect(await stageRow(p, "req")).toMatchObject({ version: 2, agreed_version: 2 });
    expect((await messages(p, "req")).at(-1)!.body).toContain("書き足しました");
    await agree(p, "flow");
    await d.drain();
    expect(harness.calls.some((c) => c.tools.some((t) => t.name === "upsert_screen"))).toBe(true);
    expect((await studioView(p)).screens).toHaveLength(1);
  });

  it("合意した段階が後から下書きに戻っても、次の段階は止まらない(引き渡しには合意し直しが要る)", async () => {
    const { p, d } = await setup();
    await setMode(p, "infra", "skip");
    await advance(p);
    await chat(p, "req", "予約サイトを作りたい");
    await d.drain();
    await answerOpenItem(p, (await openItems(p, "req"))[0]!.id, "作らない");
    await d.drain();
    await agree(p, "req");
    const { upsertRequirement } = await import("./planning.js");
    await upsertRequirement(p, { code: "R1", name: "空き枠を探す", acceptance: "責任者が直接直した" });
    await d.drain();
    await agree(p, "flow");
    await d.drain();
    expect((await studioView(p)).screens.length).toBeGreaterThan(0);
    expect(await handoffBlocker(p)).toMatch(/要件/);
  });

  it("合意済みの段階を直すと版が上がり、合意し直しになる", async () => {
    const { p, d } = await setup();
    await advance(p);
    await chat(p, "req", "予約サイトを作りたい");
    await d.drain();
    await answerOpenItem(p, (await openItems(p, "req"))[0]!.id, "作らない");
    await d.drain();
    await agree(p, "req");
    expect(await stageRow(p, "req")).toMatchObject({ version: 1, agreed_version: 1 });
    expect(await stageDone(p, "req")).toBe(true);

    answerOpenItem; // 版上げのきっかけ: 要件を直す
    const { upsertRequirement } = await import("./planning.js");
    await upsertRequirement(p, { code: "R1", name: "空き枠を探す", acceptance: "変えた" });
    expect(await stageRow(p, "req")).toMatchObject({ version: 2, agreed_version: 1 });
    expect(await stageDone(p, "req")).toBe(false);
  });

  it("省いた段階は飛ばし、お任せの段階は担当が決めて仕上げる。要件は省けない", async () => {
    const { p, d } = await setup();
    await expect(setMode(p, "req", "skip")).rejects.toThrow(/省けません/);
    await setMode(p, "infra", "skip");
    await setMode(p, "flow", "skip");
    await setMode(p, "screen", "skip");
    await setMode(p, "model", "delegate");
    await advance(p);
    await chat(p, "req", "予約サイトを作りたい");
    await d.drain();
    await answerOpenItem(p, (await openItems(p, "req"))[0]!.id, "作らない");
    await d.drain();
    await agree(p, "req");
    await d.drain();
    // フローと画面は省略、ドメインはお任せで仕上がっている
    expect(await stageDone(p, "infra") && await stageDone(p, "flow") && await stageDone(p, "screen") && await stageDone(p, "model")).toBe(true);
    expect((await studioView(p)).stages.find((s) => s.key === "model")!.status).toBe("お任せ v1");
    expect(await handoffBlocker(p)).toBeNull();
  });

  it("お任せでも、戻せない未決は担当が決められない", async () => {
    const { p, d } = await setup(async (req, call) => {
      if (!req.tools.some((t) => t.name === "set_brief")) return;
      const id = Number((await call("add_open_item", { question: "データを消すか", options: ["消す", "残す"], recommended: 1, why: "戻せない", reversible: false })).match(/#(\d+)/)![1]);
      return { finalText: await call("answer_open_item", { id, answer: "消す" }) };
    });
    await setMode(p, "req", "delegate");
    await d.drain();
    await advance(p);
    await d.drain();
    expect((await messages(p, "req")).at(-1)!.body).toMatch(/責任者に聞きます/);
    expect((await openItems(p, "req"))[0]!.answer).toBeNull();
  });

  it("担当の起動がエラーになったら、会話にそう出して再試行する", async () => {
    const { p, d } = await setup(() => ({ status: "error", error: "claude にログインしていません" }));
    await advance(p);
    await d.drain();
    expect((await messages(p, "req")).at(-1)).toMatchObject({ who: "system" });
    expect((await messages(p, "req")).at(-1)!.body).toContain("ログインしていません");
  });
});

describe("技術選定", () => {
  it("選んだものが候補に無い書き方は、アーキテクトの道具が断る", async () => {
    const { planningTools } = await import("./planning-agent.js");
    const p = await Project.open(":memory:", new ManualClock());
    const tool = (await planningTools(p, "model")).find((t) => t.name === "set_architecture")!;
    const base = {
      style: { name: "モノリス", why: "", alternatives: [] },
      modules: [],
      principles: [],
      api: { style: "REST", notes: "" },
      frontend: { rendering: "SPA", state: "" },
      stack: [],
    };
    const sel = (choice: string) => ({ area: "DB", need: "", criteria: [], candidates: [{ name: "PostgreSQL", pros: "", cons: "" }, { name: "MySQL", pros: "", cons: "" }], choice, why: "", reversible: false });
    expect(await tool.handler({ ...base, selections: [sel("SQLite")] } as never)).toContain("選んだものが候補にありません: DB(SQLite)");
    expect(await tool.handler({ ...base, selections: [sel("PostgreSQL")] } as never)).toContain("アーキテクチャ v1 を書きました");
    expect((await studioView(p)).architecture!.selections![0]!.choice).toBe("PostgreSQL");
  });
});
