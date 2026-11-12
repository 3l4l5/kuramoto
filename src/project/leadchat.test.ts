import { describe, expect, it } from "vitest";
import { ManualClock } from "../clock.js";
import { FakeHarness } from "../harness/fake.js";
import { Dispatcher } from "./dispatcher.js";
import { leadMessages, leadReply, sayToLead } from "./leadchat.js";
import { Project } from "./project.js";
import { StaticWorkspace } from "./workspace.js";

describe("リーダーとのチャット: 読んだところを覚える", () => {
  it("返事を書いている最中に届いたメッセージや、交通整理の報告に追い越されたメッセージも、次の起動で読む", async () => {
    const p = new Project(":memory:", new ManualClock());
    p.addRepo("acme/shop", "API");
    const prompts: string[] = [];
    const harness = new FakeHarness(async (req) => {
      prompts.push(req.prompt);
      // 1 回目の返事を書いている最中に、責任者が続けて書き、交通整理の報告も入る
      if (prompts.length === 1) {
        sayToLead(p, "#13 は僕が merge しておいた");
        leadReply(p, "【交通整理 #20】順番を決めたわ");
      }
      return { finalText: `返事 ${prompts.length}` };
    });
    const d = new Dispatcher(p, { harnesses: { "claude-agent-sdk": harness }, workspace: new StaticWorkspace("/tmp") });

    sayToLead(p, "#13 はどうなってる?");
    await d.drain();

    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toContain("- #13 はどうなってる?");
    expect(prompts[0]).not.toContain("merge しておいた");
    // 追い越されていても、2 回目にはちゃんと届く(前は空に見えていた)
    expect(prompts[1]).toContain("- #13 は僕が merge しておいた");
    expect(prompts[1]).not.toContain("どうなってる");
    expect(leadMessages(p).filter((m) => m.who === "lead").map((m) => m.body)).toEqual(["【交通整理 #20】順番を決めたわ", "返事 1", "返事 2"]);

    // 読んでいないメッセージが無ければ、チャットの担当を起こさない
    p.db.prepare("INSERT INTO messages (ticket_id, to_role, kind, payload, available_at, created_at) VALUES (NULL, 'lead', 'chat', '{}', ?, ?)").run(p.now(), p.now());
    await d.drain();
    expect(prompts).toHaveLength(2);
  });
});
