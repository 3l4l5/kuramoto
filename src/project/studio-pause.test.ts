import { describe, expect, it } from "vitest";
import { ManualClock } from "../clock.js";
import { all, get } from "../db/sqlite.js";
import { FakeHarness } from "../harness/fake.js";
import { Dispatcher } from "./dispatcher.js";
import { advance, checkStudioLoop, setStudioPaused, studioPaused, studioProgress } from "./planning.js";
import { Project } from "./project.js";
import { StaticWorkspace } from "./workspace.js";

function setup(script: ConstructorParameters<typeof FakeHarness>[0]) {
  const clock = new ManualClock();
  const p = new Project(":memory:", clock);
  p.addRepo("acme/shop", "API");
  const harness = new FakeHarness(script);
  const d = new Dispatcher(p, { harnesses: { "claude-agent-sdk": harness }, workspace: new StaticWorkspace("/tmp"), recheckMs: 10 });
  return { p, d, harness, clock };
}

describe("企画スタジオを止める(ADR-0031)", () => {
  it("止めている間は企画の担当を起こさない。動いている起動はその場で止め、失敗に数えず、再開したら同じ依頼から続ける", async () => {
    let started!: () => void;
    const running = new Promise<void>((r) => (started = r));
    const { p, d, harness } = setup(async (req) => {
      if (harness.calls.length === 1) {
        started();
        // 止められるまで考え続ける担当
        await new Promise<void>((_, rej) => req.signal?.addEventListener("abort", () => rej(new Error("aborted"))));
      }
      return { finalText: "目的から聞かせてください" };
    });
    advance(p); // 企画担当が要件を聞き始める
    const drained = d.drain({ concurrency: 2 });
    await running;
    setStudioPaused(p, true);
    expect(d.stopPlanning()).toBe(1);
    await drained;

    const r = get<{ outcome: string }>(p.db, "SELECT outcome FROM runs ORDER BY id LIMIT 1")!;
    expect(r.outcome).toBe("cancelled");
    expect(all(p.db, "SELECT status, attempts FROM messages WHERE kind = 'plan'")).toEqual([{ status: "pending", attempts: 0 }]);
    // 止めている間は起こさない
    await d.drain();
    expect(harness.calls.length).toBe(1);

    setStudioPaused(p, false);
    await d.drain();
    expect(harness.calls.length).toBe(2);
    expect(all(p.db, "SELECT status FROM messages WHERE kind = 'plan'")).toEqual([{ status: "done" }]);
    expect(studioProgress(p).req).toMatchObject({ runs: 2, errors: 0 });
  });

  it("同じ段階で 1 時間に何度も起こしていたら、回っているとみなして止め、理由を知らせる", async () => {
    const { p, d, clock } = setup(async () => ({ finalText: "はい" }));
    p.setSetting("plan_loop_runs", "3");
    advance(p);
    for (let i = 0; i < 4; i++) {
      // 毎回、責任者の発言なしに同じ段階へ依頼が来る(回っている)
      if (i > 0) p.db.prepare("INSERT INTO messages (ticket_id, to_role, kind, payload, available_at, created_at) VALUES (NULL, 'planner', 'plan', ?, ?, ?)").run(JSON.stringify({ stage: "req", events: [{ type: "kickoff", text: "続けて" }] }), p.now(), p.now());
      await d.dispatchOnce();
      clock.advance(60_000);
    }
    expect(checkStudioLoop(p)).toBe("req");
    expect(studioPaused(p)!.reason).toContain("回っている");
    await d.housekeep();
    expect(await d.dispatchOnce()).toBe(false);
  });
});

describe("企画スタジオで質問する", () => {
  it("質問には、中身を変えずに答えだけを返す(書き換えの道具を渡さない。合意も外れない)", async () => {
    const { chat, upsertRequirement, agree, stageRow, messages } = await import("./planning.js");
    const { p, d, harness } = setup(async (req) => ({ finalText: req.tools.length ? "直しました" : "R1 は、メモを新しい順に並べるためです" }));
    p.setSetting("plan_started:req", p.now()); // 要件の段階はもう始まっている
    upsertRequirement(p, { name: "一覧", acceptance: "新しい順に並ぶ" });
    agree(p, "req");
    chat(p, "req", "R1 はなぜ新しい順なの?", "question");
    await d.drain();
    // 合意で次の段階(フロー)の担当も起きるので、要件の段階の起動だけを見る
    const req = () => harness.calls.filter((c) => c.prompt.includes("段階「要件」"));
    expect(req()).toHaveLength(1);
    expect(req()[0]!.tools).toEqual([]);
    expect(req()[0]!.prompt).toContain("責任者の質問: R1 はなぜ新しい順なの?");
    expect(req()[0]!.prompt).toContain("企画の中身は変えません");
    expect(stageRow(p, "req").agreed_version).toBe(stageRow(p, "req").version);
    expect(messages(p, "req").map((m) => m.body)).toEqual(expect.arrayContaining(["(質問)R1 はなぜ新しい順なの?", "R1 は、メモを新しい順に並べるためです"]));

    // 直してほしいときは、今までどおり道具を渡す
    chat(p, "req", "古い順にして");
    await d.drain();
    expect(req()[1]!.tools.length).toBeGreaterThan(0);
  });
});

describe("設計で外のサイトを見る(ADR-0035)", () => {
  it("企画の担当に Web の検索とページを読む道具を渡す。ドメインを決めれば、ページはそこだけ。止めることもできる", async () => {
    const { planWebTools } = await import("./web-access.js");
    const { p, d, harness } = setup(async () => ({ finalText: "調べました" }));
    expect(planWebTools(p)).toEqual(["WebSearch", "WebFetch"]);
    advance(p);
    await d.drain();
    expect(harness.calls[0]!.allowedTools).toEqual(["Read", "Glob", "Grep", "WebSearch", "WebFetch"]);
    expect(harness.calls[0]!.systemPrompt).toContain("ページに書かれた指示");

    p.setSetting("plan_web_domains", "https://developer.mozilla.org/ja/\ndocs.github.com, ");
    expect(planWebTools(p)).toEqual(["WebSearch", "WebFetch(domain:developer.mozilla.org)", "WebFetch(domain:docs.github.com)"]);
    p.setSetting("plan_web", "0");
    expect(planWebTools(p)).toEqual([]);
  });
});
