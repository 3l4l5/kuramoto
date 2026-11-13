import { describe, expect, it } from "vitest";
import { ManualClock } from "../clock.js";
import { describeTool, progressOf } from "../harness/claude-agent-sdk.js";
import { FakeHarness } from "../harness/fake.js";
import { Dispatcher } from "./dispatcher.js";
import { advance, studioView } from "./planning.js";
import { planningWork } from "./progress.js";
import { Project } from "./project.js";
import { StaticWorkspace } from "./workspace.js";

describe("途中経過", () => {
  it("起動の途中で、作業中の人・経過・最後の動き・手順が見え、終わると消える", async () => {
    const clock = new ManualClock();
    const p = new Project(":memory:", clock);
    p.addRepo("acme/shop", "API");
    let seen: ReturnType<typeof planningWork> = {};
    const harness = new FakeHarness(async (req) => {
      req.onProgress!({ type: "step", kind: "status", text: "起動しました" });
      req.onProgress!({ type: "step", kind: "tool", text: "README.md を読んでいます" });
      clock.advance(5_000);
      req.onProgress!({ type: "heartbeat", text: "考えています(約 1,200 トークン)" });
      req.onProgress!({ type: "heartbeat", text: "考えています(約 1,300 トークン)" }); // 2 秒以内は書かない
      req.onProgress!({ type: "step", kind: "thinking", text: "目的から聞くのがよさそう" });
      seen = planningWork(p);
      return { finalText: "何のためのものですか?" };
    });
    const d = new Dispatcher(p, { harnesses: { "claude-agent-sdk": harness }, workspace: new StaticWorkspace("/tmp"), ticketsAllowed: () => false });

    await advance(p);
    expect(studioView(p).work).toEqual({ req: { state: "queued" } });
    await d.drain();

    expect(seen.req).toMatchObject({
      state: "running",
      member: "咲季",
      live: "考えています",
      lastActivityAt: "2026-11-07T00:00:05.000Z",
      steps: [
        { kind: "status", text: "起動しました" },
        { kind: "tool", text: "README.md を読んでいます" },
        { kind: "thinking", text: "目的から聞くのがよさそう" },
      ],
    });
    expect(studioView(p).work).toEqual({});
  });

  it("SDK のメッセージを、画面に出す言葉にする", () => {
    expect(describeTool("Read", { file_path: "/w/src/app.ts" })).toBe("app.ts を読んでいます");
    expect(describeTool("Grep", { pattern: "reservations" })).toBe("「reservations」を検索しています");
    expect(describeTool("mcp__kuramoto__upsert_screen", { name: "空き枠を探す" })).toBe("画面の試作を作っています: 空き枠を探す");
    const assistant = {
      type: "assistant",
      message: { content: [{ type: "thinking", thinking: "まず既存の\nコードを確かめる" }, { type: "tool_use", name: "Glob", input: { pattern: "**/*.tf" } }] },
    } as never;
    expect(progressOf(assistant)).toEqual([
      { type: "step", kind: "thinking", text: "まず既存の コードを確かめる" },
      { type: "step", kind: "tool", text: "ファイルを探しています(**/*.tf)" },
    ]);
    expect(progressOf({ type: "system", subtype: "thinking_tokens", estimated_tokens: 2400 } as never)).toEqual([{ type: "heartbeat", text: "考えています(約 2,400 トークン)" }]);
  });
});
