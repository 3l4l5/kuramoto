import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ManualClock } from "../clock.js";
import { all, get } from "../db/sqlite.js";
import { FakeHarness, fixedAll, withResolutions, type FakeStep } from "../harness/fake.js";
import { Dispatcher } from "./dispatcher.js";
import { leadMessages } from "./leadchat.js";
import { memberChatView, memberNow, sayToMember } from "./member-chat.js";
import { Project } from "./project.js";
import { createTicket } from "./workflow.js";
import { GitWorkspace, StaticWorkspace, type WorkspaceRequest } from "./workspace.js";

/** 開発・レビューは普通に進め、メンバーとの会話(hand_to_lead だけを持つ起動)とリーダーのチャットは台本で答える。 */
async function setup(chat: FakeStep, opts: { open?: boolean } = {}) {
  const clock = new ManualClock();
  const p = await Project.open(":memory:", clock);
  await p.addRepo("acme/shop", "API");
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
  await createTicket(p, { title: "CSV 出力" });
  await d.drain();
  const t = (await p.tickets())[0]!;
  return { ticket: t, member: await p.member(t.owner_member_id!) };
}

describe("メンバーとの会話", () => {
  it("聞く: 今のチケットの会話を引き継いで答える。会話は残り、担当も工程も変わらない", async () => {
    const { p, d, harness } = await setup((req) => (isChat(req) ? { finalText: "いま CSV の文字コードを見ているよ" } : undefined));
    const { ticket, member } = await worked(p, d);
    const devSession = get<{ harness_session_id: string }>(p.db, "SELECT harness_session_id FROM sessions WHERE member_id = ? AND ticket_id = ?", [member.id, ticket.id])!.harness_session_id;
    const before = await p.ticket(ticket.id);

    await sayToMember(p, member.id, "いま何をやってる?");
    await d.drain();

    const call = harness.calls.find(isChat)!;
    expect(call.resumeSessionId).toBe(devSession);
    expect(call.prompt).toContain("CSV 出力");
    expect(call.prompt).toContain("- いま何をやってる?");
    expect(call.tools.map((t) => t.name)).toEqual(["hand_to_lead"]);
    expect(call.allowedTools).toEqual(["Read", "Glob", "Grep"]);
    expect((await memberChatView(p, member.id)).messages.filter((m) => m.who !== "system").map((m) => [m.who, m.body])).toEqual([
      ["owner", "いま何をやってる?"],
      ["member", "いま CSV の文字コードを見ているよ"],
    ]);
    // 起動はチケットの起動として数えず(1 チケット 1 起動を邪魔しない)、about_ticket_id でひも付く
    const r = get<{ ticket_id: number | null; about_ticket_id: number }>(p.db, "SELECT ticket_id, about_ticket_id FROM runs WHERE id = (SELECT MAX(id) FROM runs)")!;
    expect(r).toEqual({ ticket_id: null, about_ticket_id: ticket.id });
    expect(await p.ticket(ticket.id)).toMatchObject({ stage: before.stage, owner_member_id: before.owner_member_id, rounds: before.rounds });
    // 同じ人にもう一度話しかけても、読んだ分は読み直さない
    await sayToMember(p, member.id, "ありがとう");
    await d.drain();
    const second = harness.calls.filter(isChat)[1]!;
    expect(second.prompt.split("## 責任者のメッセージ(まだ返事をしていないもの)")[1]).not.toContain("いま何をやってる?");
  });

  it("終業中(チケットの受付が止まっている間)でも、返事が来る", async () => {
    const { p, d, harness } = await setup((req) => (isChat(req) ? { finalText: "了解" } : undefined));
    const { member } = await worked(p, d);
    // 終業した状態の起こし方で、会話だけが取り出される
    const closed = new Dispatcher(p, { harnesses: { "claude-agent-sdk": harness }, workspace: new StaticWorkspace("/tmp"), ticketsAllowed: () => false });
    await sayToMember(p, member.id, "調子はどう?");
    await closed.drain();
    expect((await memberChatView(p, member.id)).messages.map((m) => m.who)).toContain("member");
  });

  it("伝える: 伝えたことはそのチケットのメモ(kind = member)に残り、担当・工程は変わらない。次の仕事で読まれる", async () => {
    const { p, d } = await setup((req) => (isChat(req) ? { finalText: "了解!外したときのテストも足すね" } : undefined));
    const { ticket, member } = await worked(p, d);
    const before = await p.ticket(ticket.id);

    await sayToMember(p, member.id, "区切り文字を変えたときも見てね");
    await d.drain();

    const notes = (await p.notes(ticket.id)).filter((n) => n.kind === "member");
    expect(notes.map((n) => [n.who, n.body])).toEqual([["owner", "区切り文字を変えたときも見てね"]]);
    expect((await memberChatView(p, member.id)).messages.at(-1)).toMatchObject({ who: "system", body: `#${ticket.number} のメモに書き足しました` });
    expect(await p.ticket(ticket.id)).toMatchObject({ stage: before.stage, owner_member_id: before.owner_member_id });
    // 次にこのチケットの仕事をする担当の指示に、メモとして入る
    const { promptFor } = await import("./prompts.js");
    const msg = { id: 0, ticket_id: ticket.id, to_role: "dev", to_member_id: member.id, kind: "implement", payload: "{}", status: "pending", available_at: "", attempts: 0, created_at: "", claimed_at: null, last_error: null } as const;
    expect(await promptFor(p, msg, await p.ticket(ticket.id), {})).toContain("区切り文字を変えたときも見てね");
  });

  it("新しい仕事を頼まれたら、リーダーの受信箱に回す。メモには書かない。リーダーがチケットにできる", async () => {
    const { p, d, harness } = await setup(async (req, call) => {
      if (isChat(req)) {
        await call("hand_to_lead", { title: "PDF 出力も欲しい", body: "請求書を PDF で出したい" });
        return { finalText: "それは新しい仕事だから、リーダーに回したよ" };
      }
      // リーダーのチャット: チケットにする
      await call("create_ticket", { title: "PDF 出力", body: "請求書を PDF で出す" });
      return { finalText: "チケットにしました" };
    });
    const { ticket, member } = await worked(p, d);

    await sayToMember(p, member.id, "ついでに PDF 出力もお願い");
    await d.drain();

    const handed = (await leadMessages(p)).find((m) => m.who === "owner")!;
    expect(handed.body).toContain(`${member.name} から回ってきた新しい仕事`);
    expect(handed.body).toContain("PDF 出力も欲しい");
    expect(handed.body).toContain("請求書を PDF で出したい");
    expect((await p.notes(ticket.id)).filter((n) => n.kind === "member")).toEqual([]); // 今のチケットのメモには書かない
    expect((await memberChatView(p, member.id)).messages.at(-1)).toMatchObject({ who: "member", body: "それは新しい仕事だから、リーダーに回したよ" });
    // リーダーは、回ってきた頼みを読んでチケットを作る
    const leadCall = harness.calls.find((c) => c.prompt.includes("責任者からチャットが届きました"))!;
    expect(leadCall.prompt).toContain("PDF 出力も欲しい");
    expect((await p.tickets()).map((t) => t.title)).toContain("PDF 出力");
    expect((await p.ticket(ticket.id)).owner_member_id).toBe(member.id);
  });

  it("メンバーが今の仕事の最中なら、終わるまで待ってから答える", async () => {
    const order: string[] = [];
    const clock = new ManualClock();
    const p = await Project.open(":memory:", clock);
    await p.addRepo("acme/shop", "API");
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
          const t = (await p.tickets())[0]!;
          const m = get<{ member_id: number }>(p.db, "SELECT member_id FROM runs WHERE ticket_id = ? AND ended_at IS NULL", [t.id])!.member_id;
          await sayToMember(p, m, "どう?");
          expect((await memberNow(p, m)).state).toBe("working");
        }
        await call("submit_pr", { summary: "", responses: fixedAll(req.prompt) });
      } else await call("submit_review", withResolutions(req.prompt, { verdict: "approve", findings: [] }));
    });
    const d = new Dispatcher(p, { harnesses: { "claude-agent-sdk": harness }, workspace: new StaticWorkspace("/tmp") });
    await createTicket(p, { title: "A" });
    await d.drain();
    expect(order.indexOf("chat")).toBeGreaterThan(order.indexOf("dev"));
    expect(all(p.db, "SELECT 1 FROM runs WHERE about_ticket_id IS NOT NULL")).toHaveLength(1);
  });

  it("話しかけられないとき: 島のメンバーでない・まだチケットが無い・空のメッセージ", async () => {
    const { p, d } = await setup(() => undefined);
    await p.fillSeats();
    const idle = (await p.membersOfUnit((await p.currentFormation()).units[0]!.id))[0]!;
    await expect(sayToMember(p, idle.id, "やあ")).rejects.toThrow("まだチケットを受け持っていない");
    await expect(sayToMember(p, (await p.fixedMember("lead")).id, "やあ")).rejects.toThrow("島のメンバーだけ");
    const { member } = await worked(p, d);
    await expect(sayToMember(p, member.id, "  ")).rejects.toThrow("メッセージがありません");
  });
});

describe("終わったチケット(done・dropped)について話しかける", () => {
  for (const stage of ["done", "dropped"] as const) {
    it(`${stage}: メモは書かず答えるだけ。作業場所は既定のブランチ(チケットのブランチを取り出さない)`, async () => {
      const prepared: WorkspaceRequest[] = [];
      class Recording extends StaticWorkspace {
        override async prepare(req?: WorkspaceRequest) {
          if (req) prepared.push(req);
          return super.prepare();
        }
      }
      const clock = new ManualClock();
      const p = await Project.open(":memory:", clock);
      await p.addRepo("acme/shop", "API");
      const harness = new FakeHarness(async (req, call) => {
        clock.advance(60_000);
        if (req.tools.some((t) => t.name === "submit_pr")) await call("submit_pr", { summary: "実装した", responses: fixedAll(req.prompt) });
        else if (req.tools.some((t) => t.name === "submit_review")) await call("submit_review", withResolutions(req.prompt, { verdict: "approve", findings: [] }));
        else return { finalText: "もう終わったチケットだよ" };
      });
      const d = new Dispatcher(p, { harnesses: { "claude-agent-sdk": harness }, workspace: new Recording("/tmp") });
      const { ticket, member } = await worked(p, d);
      p.db.prepare("UPDATE tickets SET stage = ? WHERE id = ?").run(stage, ticket.id);
      prepared.length = 0;
      // 会話の起動が新しく残すセッションに、チケットのブランチが入らないことを見たいので、開発のセッションは消しておく
      p.db.prepare("DELETE FROM sessions WHERE member_id = ? AND ticket_id = ?").run(member.id, ticket.id);
      const notesBefore = (await p.notes(ticket.id)).length;

      await sayToMember(p, member.id, "あれってどうなった?");
      await d.drain();

      const call = harness.calls.find(isChat)!;
      expect(call.systemPrompt).toContain("もう終わっています");
      expect(call.prompt).toContain("メモに残りません");
      expect(prepared.map((r) => [r.role, r.branch])).toEqual([[member.role ?? "dev", ""]]);
      // 答えは残るが、メモは増えず、「メモに書き足しました」も出ない
      expect((await memberChatView(p, member.id)).messages.map((m) => [m.who, m.body])).toEqual([
        ["owner", "あれってどうなった?"],
        ["member", "もう終わったチケットだよ"],
      ]);
      expect(await p.notes(ticket.id)).toHaveLength(notesBefore);
      expect((await p.ticket(ticket.id)).stage).toBe(stage);
      // 既定のブランチで動いた起動は、チケットのブランチを覚えない
      expect(get<{ branch: string | null }>(p.db, "SELECT branch FROM sessions WHERE member_id = ? AND ticket_id = ?", [member.id, ticket.id])!.branch).toBeNull();
    });
  }

  it("GitWorkspace: ブランチなしは、役割によらず読むだけの <番号>-chat を使う。ブランチが消えていてもよく、開発の作業場所には触らない", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kuramoto-ws-"));
    const git = (cwd: string, ...a: string[]) => execFileSync("git", ["-C", cwd, ...a], { encoding: "utf8" });
    execFileSync("git", ["init", "--bare", "-b", "main", join(dir, "o.git")]);
    const seed = join(dir, "seed");
    execFileSync("git", ["clone", join(dir, "o.git"), seed], { stdio: "ignore" });
    git(seed, "config", "user.email", "t@example.com");
    git(seed, "config", "user.name", "t");
    git(seed, "commit", "--allow-empty", "-m", "init");
    git(seed, "push", "origin", "HEAD:main");
    // 元の clone は、GitWorkspace の置き場所(<workDir>/repos/<owner>__<repo>)に置く
    const clone = join(dir, "repos", "acme__shop");
    execFileSync("git", ["clone", join(dir, "o.git"), clone], { stdio: "ignore" });
    const ws = new GitWorkspace(dir);
    const req = (role: "dev" | "review" | "qa", branch: string) => ({ repo: "acme/shop", ticketNumber: 7, role, memberName: "m", branch });

    // 開発が進めた: チケットのブランチに、push していないコミットとコミットしていない変更がある
    const dev = await ws.prepare(req("dev", "kuramoto/7"));
    git(dev.path, "config", "user.email", "t@example.com");
    git(dev.path, "config", "user.name", "t");
    writeFileSync(join(dev.path, "a.ts"), "a\n");
    git(dev.path, "add", "a.ts");
    git(dev.path, "commit", "-m", "a");
    const work = git(dev.path, "rev-parse", "HEAD").trim();
    writeFileSync(join(dev.path, "wip.ts"), "wip\n");

    // 取り下げたチケットに話しかける(ブランチは origin に無い)。どの島のメンバーでも、開発の作業場所とは別の場所
    const chats = new Set<string>();
    for (const role of ["dev", "review", "qa"] as const) {
      const first = await ws.prepare(req(role, ""));
      expect(first.base).toBe("main");
      expect(first.path).not.toBe(dev.path);
      expect(git(first.path, "rev-parse", "HEAD").trim()).toBe(git(first.path, "rev-parse", "origin/main").trim());
      expect((await ws.prepare(req(role, ""))).path).toBe(first.path); // 二度目も失敗しない
      chats.add(first.path);
    }
    expect(chats.size).toBe(1);
    // 開発の作業場所は、そのまま(ブランチ・コミット・コミットしていない変更)
    expect(git(dev.path, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("kuramoto/7");
    expect(git(dev.path, "rev-parse", "HEAD").trim()).toBe(work);
    expect(git(dev.path, "status", "--porcelain")).toContain("wip.ts");

    // 取り下げを戻した: 開発は元のブランチの続きから進める(別の場所で上書きしない)
    const again = await ws.prepare(req("dev", "kuramoto/7"));
    expect(again.path).toBe(dev.path);
    expect(git(again.path, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("kuramoto/7");
    expect(git(again.path, "rev-parse", "HEAD").trim()).toBe(work);
  }, 30_000);
});

describe("メンバーの今していること", () => {
  it("freeなら「free」と直前に終えたチケット、起動中ならチケットの種類・工程・往復・経過・トークンと直近の手順", async () => {
    const { p, d } = await setup(() => undefined);
    const { ticket, member } = await worked(p, d);
    const idle = await memberNow(p, member.id);
    expect(idle).toMatchObject({ state: "idle", doing: null, last: { number: ticket.number, title: "CSV 出力" }, ticket: { number: ticket.number, kind: "feature" } });
    expect(idle.ticket!.tokens).toBeGreaterThan(0);
    expect(idle.events.map((e) => e.type)).toContain("run_finished");

    // 起動中(途中経過つき)
    const { progressRecorder } = await import("./progress.js");
    const msgId = p.db.prepare("INSERT INTO messages (ticket_id, to_role, kind, payload, available_at, created_at) VALUES (?, 'dev', 'fix', '{}', ?, ?)").run(ticket.id, p.now(), p.now()).lastInsertRowid;
    const policy = await p.policy("dev");
    const runId = Number(
      p.db
        .prepare("INSERT INTO runs (message_id, ticket_id, member_id, role, policy_id, formation_id, started_at, model, effort) VALUES (?, ?, ?, 'dev', ?, ?, ?, ?, ?)")
        .run(msgId, ticket.id, member.id, policy.id, (await p.currentFormation()).id, p.now(), policy.model, policy.effort).lastInsertRowid,
    );
    const rec = progressRecorder(p, runId);
    rec({ type: "step", kind: "tool", text: "テストを流した" });
    await rec.flush();
    const now = await memberNow(p, member.id);
    expect(now).toMatchObject({ state: "working", last: null, doing: { kind: "直し", live: "テストを流した" } });
    expect(now.steps.map((s) => s.text)).toEqual(["テストを流した"]);
  });
});
