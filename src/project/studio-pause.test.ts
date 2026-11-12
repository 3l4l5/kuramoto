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
    d.housekeep();
    expect(await d.dispatchOnce()).toBe(false);
  });
});
