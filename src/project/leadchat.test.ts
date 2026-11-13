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
    const unreadPart = (s: string) => s.split("## 責任者のメッセージ(まだ返事をしていないもの)")[1]!.split("\n\n")[0]!;
    expect(unreadPart(prompts[1]!)).toContain("- #13 は僕が merge しておいた");
    expect(unreadPart(prompts[1]!)).not.toContain("どうなってる");
    // 前の会話は引き継がない代わりに、最近のやりとりとして渡す
    expect(harness.calls[1]!.resumeSessionId).toBeUndefined();
    expect(prompts[1]!.split("## 最近のやりとり")[1]).toContain("責任者: #13 はどうなってる?");
    expect(leadMessages(p).filter((m) => m.who === "lead").map((m) => m.body)).toEqual(["【交通整理 #20】順番を決めたわ", "返事 1", "返事 2"]);

    // 読んでいないメッセージが無ければ、チャットの担当を起こさない
    p.db.prepare("INSERT INTO messages (ticket_id, to_role, kind, payload, available_at, created_at) VALUES (NULL, 'lead', 'chat', '{}', ?, ?)").run(p.now(), p.now());
    await d.drain();
    expect(prompts).toHaveLength(2);
  });
});

describe("会話を引き継ぐ回数(ADR-0032)", () => {
  it("同じ会話を引き継ぐのは上限まで。超えたら新しく始める", async () => {
    const { canResume, noteSession } = await import("./sessions.js");
    const p = new Project(":memory:", new ManualClock());
    p.setSetting("session_max_resumes", "2");
    noteSession(p, "s", undefined); // 1 回目(新しく)
    expect(canResume(p, "s")).toBe(true);
    noteSession(p, "s", "s"); // 2 回目(引き継ぎ)
    expect(canResume(p, "s")).toBe(true);
    noteSession(p, "s", "s"); // 3 回目(引き継ぎ 2 回)
    expect(canResume(p, "s")).toBe(false);
    noteSession(p, "t", undefined); // 新しく始めた会話は数え直す
    expect(canResume(p, "t")).toBe(true);
    expect(canResume(p, undefined)).toBe(false);
  });

  it("チケットの担当も、上限を超えたら前の会話を引き継がずに始める", async () => {
    const { createTicket } = await import("./workflow.js");
    const { withResolutions } = await import("../harness/fake.js");
    const p = new Project(":memory:", new ManualClock());
    p.addRepo("acme/shop", "API");
    p.setSetting("session_max_resumes", "1");
    const verdicts = ["changes", "changes", "approve"];
    const harness = new FakeHarness(async (req, call) => {
      if (req.tools.some((t) => t.name === "submit_pr")) await call("submit_pr", { summary: "", responses: [...req.prompt.matchAll(/- 指摘 (\d+) \[/g)].map((m) => ({ finding_id: Number(m[1]), action: "fixed", comment: "直した" })) });
      else {
        const v = verdicts.shift() ?? "approve";
        await call("submit_review", withResolutions(req.prompt, { verdict: v, findings: v === "changes" ? [{ category: "correctness", severity: "high", basis: "acceptance", body: `直して ${verdicts.length}` }] : [] }));
      }
    });
    // 往復の上限でリーダーの判断に上がらないよう、上限を大きくする
    p.db.prepare("UPDATE policies SET options = json_set(COALESCE(options,'{}'), '$.escalateAfterRounds', 10) WHERE role = 'review'").run();
    await createTicket(p, { title: "A" });
    await new Dispatcher(p, { harnesses: { "claude-agent-sdk": harness }, workspace: new StaticWorkspace("/tmp") }).drain();
    const dev = harness.calls.filter((c) => c.tools.some((t) => t.name === "submit_pr")).map((c) => !!c.resumeSessionId);
    // 1 回目は新しく、2 回目は引き継ぎ、3 回目は上限(1 回)を超えたので新しく
    expect(dev).toEqual([false, true, false]);
  });
});

describe("チームに渡したあとのデザインの合わせ直し(ADR-0034)", () => {
  it("リーダーはチャットで、デザインシステムの土台と、画面をひも付けたチケットを作れる", async () => {
    const { leadChatTools, leadChatPrompt } = await import("./leadchat.js");
    const { putScreen, putArtifact } = await import("./planning.js");
    const { designFor, isDesignSystemTicket } = await import("./design.js");
    const { blockers } = await import("./triage.js");
    const p = new Project(":memory:", new ManualClock());
    p.addRepo("acme/shop", "API");
    putScreen(p, "list", { name: "メモ一覧", device: "phone", requirements: [], variants: [{ id: "A", html: "<p>一覧</p>" }], chosen: "A", agreed: true });
    putArtifact(p, "screen", "designsystem", "main", { principles: [], tokens: [{ group: "color", name: "--c", value: "#000", use: "x" }], components: [{ name: "ボタン", use: "x", states: [], html: "<button/>" }] });
    expect(leadChatPrompt(p, [])).toContain("- list: メモ一覧");
    expect(leadChatPrompt(p, [])).toContain("デザインシステム: あり");
    const create = (await leadChatTools(p)).find((t) => t.name === "create_ticket")!;
    expect(await create.handler({ title: "x", body: "", screens: ["nope"] } as never)).toContain("企画にありません");
    await create.handler({ title: "デザインシステムの土台", body: "トークン・部品・/_design", design_system: true } as never);
    await create.handler({ title: "一覧を試作に合わせ直す", body: "部品で組み立て直す", screens: ["list"], after: [1] } as never);
    const [base, screen] = p.tickets();
    expect(isDesignSystemTicket(p, base!)).toBe(true);
    expect(designFor(p, base!).map((d) => d.key)).toEqual(["list"]); // 土台はカタログに全部の画面を並べる
    expect(designFor(p, screen!).map((d) => d.key)).toEqual(["list"]);
    expect(blockers(p, screen!.id)).toEqual([base!.number]);
  });
});
