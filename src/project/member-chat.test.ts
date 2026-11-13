import { describe, expect, it } from "vitest";
import { ManualClock } from "../clock.js";
import { all, get } from "../db/sqlite.js";
import { FakeHarness, fixedAll, withResolutions, type FakeStep } from "../harness/fake.js";
import { Dispatcher } from "./dispatcher.js";
import { leadMessages } from "./leadchat.js";
import { memberChatView, memberNow, sayToMember } from "./member-chat.js";
import { Project } from "./project.js";
import { createTicket } from "./workflow.js";
import { StaticWorkspace } from "./workspace.js";

/** 開発・レビューは普通に進め、メンバーとの会話(hand_to_lead だけを持つ起動)とリーダーのチャットは台本で答える。 */
function setup(chat: FakeStep, opts: { open?: boolean } = {}) {
  const clock = new ManualClock();
  const p = new Project(":memory:", clock);
  p.addRepo("acme/shop", "API");
  const harness = new FakeHarness(async (req, call) => {
    clock.advance(60_000);
    if (req.tools.some((t) => t.name === "submit_pr")) await call("submit_pr", { summary: "実装した", responses: fixedAll(req.prompt) });
    else if (req.tools.some((t) => t.name === "submit_review")) await call("submit_review", withResolutions(req.prompt, { verdict: "approve", findings: [] }));
    else return chat(req, call);
  });
  const d = new Dispatcher(p, { harnesses: { "claude-agent-sdk": harness }, workspace: new StaticWorkspace("/tmp"), ...(opts.open === false ? { ticketsAllowed: () => false } : {}) });
  return { p, d, harness, clock };
}

const isChat = (req: { tools: { name: string }[] }) => req.tools.some((t) => t.name === "hand_to_lead");

/** チケットを 1 枚作って、開発が終わるまで進める。持ち主のメンバーを返す。 */
async function worked(p: Project, d: Dispatcher) {
  createTicket(p, { title: "CSV 出力" });
  await d.drain();
  const t = p.tickets()[0]!;
  return { ticket: t, member: p.member(t.owner_member_id!) };
}

describe("メンバーとの会話", () => {
  it("聞く: 今のチケットの会話を引き継いで答える。会話は残り、担当も工程も変わらない", async () => {
    const { p, d, harness } = setup((req) => (isChat(req) ? { finalText: "いま CSV の文字コードを見ているよ" } : undefined));
    const { ticket, member } = await worked(p, d);
    const devSession = get<{ harness_session_id: string }>(p.db, "SELECT harness_session_id FROM sessions WHERE member_id = ? AND ticket_id = ?", [member.id, ticket.id])!.harness_session_id;
    const before = p.ticket(ticket.id);

    sayToMember(p, member.id, "いま何をやってる?");
    await d.drain();

    const call = harness.calls.find(isChat)!;
    expect(call.resumeSessionId).toBe(devSession);
    expect(call.prompt).toContain("CSV 出力");
    expect(call.prompt).toContain("- いま何をやってる?");
    expect(call.tools.map((t) => t.name)).toEqual(["hand_to_lead"]);
    expect(call.allowedTools).toEqual(["Read", "Glob", "Grep"]);
    expect(memberChatView(p, member.id).messages.filter((m) => m.who !== "system").map((m) => [m.who, m.body])).toEqual([
      ["owner", "いま何をやってる?"],
      ["member", "いま CSV の文字コードを見ているよ"],
    ]);
    // 起動はチケットの起動として数えず(1 チケット 1 起動を邪魔しない)、about_ticket_id でひも付く
    const r = get<{ ticket_id: number | null; about_ticket_id: number }>(p.db, "SELECT ticket_id, about_ticket_id FROM runs WHERE id = (SELECT MAX(id) FROM runs)")!;
    expect(r).toEqual({ ticket_id: null, about_ticket_id: ticket.id });
    expect(p.ticket(ticket.id)).toMatchObject({ stage: before.stage, owner_member_id: before.owner_member_id, rounds: before.rounds });
    // 同じ人にもう一度話しかけても、読んだ分は読み直さない
    sayToMember(p, member.id, "ありがとう");
    await d.drain();
    const second = harness.calls.filter(isChat)[1]!;
    expect(second.prompt.split("## 責任者のメッセージ(まだ返事をしていないもの)")[1]).not.toContain("いま何をやってる?");
  });

  it("終業中(チケットの受付が止まっている間)でも、返事が来る", async () => {
    const { p, d, harness } = setup((req) => (isChat(req) ? { finalText: "了解" } : undefined));
    const { member } = await worked(p, d);
    // 終業した状態の起こし方で、会話だけが取り出される
    const closed = new Dispatcher(p, { harnesses: { "claude-agent-sdk": harness }, workspace: new StaticWorkspace("/tmp"), ticketsAllowed: () => false });
    sayToMember(p, member.id, "調子はどう?");
    await closed.drain();
    expect(memberChatView(p, member.id).messages.map((m) => m.who)).toContain("member");
  });

  it("伝える: 伝えたことはそのチケットのメモ(kind = member)に残り、担当・工程は変わらない。次の仕事で読まれる", async () => {
    const { p, d } = setup((req) => (isChat(req) ? { finalText: "了解!外したときのテストも足すね" } : undefined));
    const { ticket, member } = await worked(p, d);
    const before = p.ticket(ticket.id);

    sayToMember(p, member.id, "区切り文字を変えたときも見てね");
    await d.drain();

    const notes = p.notes(ticket.id).filter((n) => n.kind === "member");
    expect(notes.map((n) => [n.who, n.body])).toEqual([["owner", "区切り文字を変えたときも見てね"]]);
    expect(memberChatView(p, member.id).messages.at(-1)).toMatchObject({ who: "system", body: `#${ticket.number} のメモに書き足しました` });
    expect(p.ticket(ticket.id)).toMatchObject({ stage: before.stage, owner_member_id: before.owner_member_id });
    // 次にこのチケットの仕事をする担当の指示に、メモとして入る
    const { promptFor } = await import("./prompts.js");
    const msg = { id: 0, ticket_id: ticket.id, to_role: "dev", to_member_id: member.id, kind: "implement", payload: "{}", status: "pending", available_at: "", attempts: 0, created_at: "", claimed_at: null, last_error: null } as const;
    expect(promptFor(p, msg, p.ticket(ticket.id), {})).toContain("区切り文字を変えたときも見てね");
  });

  it("新しい仕事を頼まれたら、リーダーの受信箱に回す。メモには書かない。リーダーがチケットにできる", async () => {
    const { p, d, harness } = setup(async (req, call) => {
      if (isChat(req)) {
        await call("hand_to_lead", { title: "PDF 出力も欲しい", body: "請求書を PDF で出したい" });
        return { finalText: "それは新しい仕事だから、リーダーに回したよ" };
      }
      // リーダーのチャット: チケットにする
      await call("create_ticket", { title: "PDF 出力", body: "請求書を PDF で出す" });
      return { finalText: "チケットにしました" };
    });
    const { ticket, member } = await worked(p, d);

    sayToMember(p, member.id, "ついでに PDF 出力もお願い");
    await d.drain();

    const handed = leadMessages(p).find((m) => m.who === "owner")!;
    expect(handed.body).toContain(`${member.name} から回ってきた新しい仕事`);
    expect(handed.body).toContain("PDF 出力も欲しい");
    expect(handed.body).toContain("請求書を PDF で出したい");
    expect(p.notes(ticket.id).filter((n) => n.kind === "member")).toEqual([]); // 今のチケットのメモには書かない
    expect(memberChatView(p, member.id).messages.at(-1)).toMatchObject({ who: "member", body: "それは新しい仕事だから、リーダーに回したよ" });
    // リーダーは、回ってきた頼みを読んでチケットを作る
    const leadCall = harness.calls.find((c) => c.prompt.includes("責任者からチャットが届きました"))!;
    expect(leadCall.prompt).toContain("PDF 出力も欲しい");
    expect(p.tickets().map((t) => t.title)).toContain("PDF 出力");
    expect(p.ticket(ticket.id).owner_member_id).toBe(member.id);
  });

  it("メンバーが今の仕事の最中なら、終わるまで待ってから答える", async () => {
    const order: string[] = [];
    const clock = new ManualClock();
    const p = new Project(":memory:", clock);
    p.addRepo("acme/shop", "API");
    let said = false;
    const harness = new FakeHarness(async (req, call) => {
      if (isChat(req)) {
        order.push("chat");
        return { finalText: "お待たせ" };
      }
      if (req.tools.some((t) => t.name === "submit_pr")) {
        order.push("dev");
        // 開発の最中に話しかける(今のチケットは、起動中のこのチケット)
        if (!said) {
          said = true;
          const t = p.tickets()[0]!;
          const m = get<{ member_id: number }>(p.db, "SELECT member_id FROM runs WHERE ticket_id = ? AND ended_at IS NULL", [t.id])!.member_id;
          sayToMember(p, m, "どう?");
          expect(memberNow(p, m).state).toBe("working");
        }
        await call("submit_pr", { summary: "", responses: fixedAll(req.prompt) });
      } else await call("submit_review", withResolutions(req.prompt, { verdict: "approve", findings: [] }));
    });
    const d = new Dispatcher(p, { harnesses: { "claude-agent-sdk": harness }, workspace: new StaticWorkspace("/tmp") });
    createTicket(p, { title: "A" });
    await d.drain();
    expect(order.indexOf("chat")).toBeGreaterThan(order.indexOf("dev"));
    expect(all(p.db, "SELECT 1 FROM runs WHERE about_ticket_id IS NOT NULL")).toHaveLength(1);
  });

  it("話しかけられないとき: 島のメンバーでない・まだチケットが無い・空のメッセージ", async () => {
    const { p, d } = setup(() => undefined);
    p.fillSeats();
    const idle = p.membersOfUnit(p.currentFormation().units[0]!.id)[0]!;
    expect(() => sayToMember(p, idle.id, "やあ")).toThrow("まだチケットを受け持っていない");
    expect(() => sayToMember(p, p.fixedMember("lead").id, "やあ")).toThrow("島のメンバーだけ");
    const { member } = await worked(p, d);
    expect(() => sayToMember(p, member.id, "  ")).toThrow("メッセージがありません");
  });
});

describe("メンバーの今していること", () => {
  it("手すきなら「手すき」と直前に終えたチケット、起動中ならチケットの種類・工程・往復・経過・トークンと直近の手順", async () => {
    const { p, d } = setup(() => undefined);
    const { ticket, member } = await worked(p, d);
    const idle = memberNow(p, member.id);
    expect(idle).toMatchObject({ state: "idle", doing: null, last: { number: ticket.number, title: "CSV 出力" }, ticket: { number: ticket.number, kind: "feature" } });
    expect(idle.ticket!.tokens).toBeGreaterThan(0);
    expect(idle.events.map((e) => e.type)).toContain("run_finished");

    // 起動中(途中経過つき)
    const { progressRecorder } = await import("./progress.js");
    const msgId = p.db.prepare("INSERT INTO messages (ticket_id, to_role, kind, payload, available_at, created_at) VALUES (?, 'dev', 'fix', '{}', ?, ?)").run(ticket.id, p.now(), p.now()).lastInsertRowid;
    const policy = p.policy("dev");
    const runId = Number(
      p.db
        .prepare("INSERT INTO runs (message_id, ticket_id, member_id, role, policy_id, formation_id, started_at, model, effort) VALUES (?, ?, ?, 'dev', ?, ?, ?, ?, ?)")
        .run(msgId, ticket.id, member.id, policy.id, p.currentFormation().id, p.now(), policy.model, policy.effort).lastInsertRowid,
    );
    progressRecorder(p, runId)({ type: "step", kind: "tool", text: "テストを流した" });
    const now = memberNow(p, member.id);
    expect(now).toMatchObject({ state: "working", last: null, doing: { kind: "直し", live: "テストを流した" } });
    expect(now.steps.map((s) => s.text)).toEqual(["テストを流した"]);
  });
});
