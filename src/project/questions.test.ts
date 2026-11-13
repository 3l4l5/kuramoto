import { describe, expect, it } from "vitest";
import { ManualClock } from "../clock.js";
import { all, get } from "../db/sqlite.js";
import type { UnitSpec } from "../domain/formation.js";
import type { RouteSpec } from "../domain/route.js";
import { FakeHarness, fixedAll, withResolutions, type FakeStep } from "../harness/fake.js";
import { Dispatcher } from "./dispatcher.js";
import { leadMessages } from "./leadchat.js";
import { formationMarks } from "./formation-marks.js";
import { productivity } from "./productivity.js";
import { Project } from "./project.js";
import { askQuestion, leadPendingQuestions, questionsOf } from "./questions.js";
import { saveFormationInput, teamView } from "./team.js";
import { ticketView } from "./ticket.js";
import { createTicket, ticketSpentUsd } from "./workflow.js";
import { StaticWorkspace } from "./workspace.js";

const unit = (name: string, roles: UnitSpec["roles"], maxMembers = 2): UnitSpec => ({ name, roles, maxMembers, summonAt: 2, idleSec: 300 });
const UNITS = [unit("開発", ["dev"]), unit("レビュー", ["review"]), unit("QA", ["qa"])];
const ROUTES: RouteSpec[] = [{ from: "開発", to: "レビュー", mode: "ask" }];

const isAsk = (req: { tools: { name: string }[] }) => req.tools.some((t) => t.name === "reply");

/** 開発・確認は普通に進め、質問に答える起動(reply を持つ)は台本で答える。 */
function setup(answer: FakeStep = (_req, call) => call("reply", { answer: "境界値は 0 件と 1 件を見て" }).then(() => undefined), routes: RouteSpec[] | undefined = ROUTES) {
  const clock = new ManualClock();
  const p = new Project(":memory:", clock);
  p.addRepo("acme/shop", "API");
  p.saveFormation({ pull: "down", units: UNITS, ...(routes ? { routes } : {}) });
  const harness = new FakeHarness(async (req, call) => {
    clock.advance(60_000);
    if (isAsk(req)) return answer(req, call);
    if (req.tools.some((t) => t.name === "submit_pr")) await call("submit_pr", { summary: "実装した", responses: fixedAll(req.prompt) });
    else if (req.tools.some((t) => t.name === "submit_review")) await call("submit_review", withResolutions(req.prompt, { verdict: "approve", findings: [] }));
  });
  const d = new Dispatcher(p, { harnesses: { "claude-agent-sdk": harness }, workspace: new StaticWorkspace("/tmp") });
  return { p, d, harness, clock };
}

/** チケットを 1 枚作って、QA まで通して merge 待ちにする。持ち主(開発のメンバー)も返す。 */
async function worked(p: Project, d: Dispatcher) {
  await createTicket(p, { title: "CSV 出力" });
  await d.drain();
  const ticket = p.tickets()[0]!;
  return { ticket, owner: p.member(ticket.owner_member_id!) };
}

const state = (p: Project, id: number) => {
  const t = p.ticket(id);
  return { stage: t.stage, owner: t.owner_member_id, rounds: t.rounds, kind: t.kind };
};

describe("連絡経路の保存(R16)", () => {
  it("島・流れ・経路を 1 回の保存で、版が 1 つ上がる。既定は連絡しない(経路なし)", async () => {
    const p = new Project(":memory:", new ManualClock());
    p.addRepo("acme/shop", "API");
    const v1 = p.saveFormation({ pull: "down", units: UNITS });
    expect(v1.routes).toEqual([]);
    const v2 = saveFormationInput(p, { pull: "down", units: UNITS, flows: { default: ["dev", "review"] }, routes: [{ from: "レビュー", to: "開発", mode: "ask" }, { from: "開発", to: "QA", mode: "none" }] });
    expect(v2.version).toBe(v1.version + 1);
    expect(p.currentFormation().flows).toEqual({ default: ["dev", "review"] });
    // 向きは持たない。「連絡しない」は持たず、端は名前の順にそろう
    expect(p.currentFormation().routes).toEqual([{ from: "レビュー", to: "開発", mode: "ask" }]);
    expect((await teamView(p)).formation.versions.slice(-2).map((v) => [v.version, v.routes.length])).toEqual([[v1.version, 0], [v2.version, 1]]);
  });

  it("経路を渡さない保存は、前の版の経路を引き継ぐ。無くなった島の経路は外す", async () => {
    const p = new Project(":memory:", new ManualClock());
    p.addRepo("acme/shop", "API");
    p.saveFormation({ pull: "down", units: UNITS, routes: [...ROUTES, { from: "QA", to: "レビュー", mode: "ask" }, { from: "開発", to: "lead", mode: "ask" }] });
    p.saveFormation({ pull: "down", units: UNITS });
    expect(p.currentFormation().routes).toHaveLength(3);
    p.saveFormation({ pull: "down", units: [unit("開発", ["dev"]), unit("レビュー", ["review"])] });
    expect(p.currentFormation().routes.map((r) => `${r.from}-${r.to}`).sort()).toEqual(["lead-開発", "レビュー-開発"].sort());
    // 空の配列を渡せば、すべて「連絡しない」に戻せる
    p.saveFormation({ pull: "down", units: UNITS, routes: [] });
    expect(p.currentFormation().routes).toEqual([]);
  });

  it("島に無い端・自分自身との経路は保存できず、版も上がらない", async () => {
    const p = new Project(":memory:", new ManualClock());
    p.addRepo("acme/shop", "API");
    const base = p.saveFormation({ pull: "down", units: UNITS }).version;
    expect(() => saveFormationInput(p, { pull: "down", units: UNITS, routes: [{ from: "開発", to: "ない島", mode: "ask" }] })).toThrow(/ない島/);
    expect(() => saveFormationInput(p, { pull: "down", units: UNITS, routes: [{ from: "開発", to: "開発", mode: "ask" }] })).toThrow(/結べません/);
    expect(() => saveFormationInput(p, { pull: "down", units: UNITS, routes: [{ from: "開発", to: "QA", mode: "tell" }] })).toThrow();
    expect(p.currentFormation().version).toBe(base);
  });

  it("経路を変えた版が、効率のグラフの印として返る(版の差から拾う)", async () => {
    const p = new Project(":memory:", new ManualClock());
    p.addRepo("acme/shop", "API");
    p.saveFormation({ pull: "down", units: UNITS }); // 最初に決めた版(島の設定を変えた印は付く)
    const b = p.currentFormation().version;
    p.saveFormation({ pull: "down", units: UNITS, routes: ROUTES }); // b+1: 経路
    p.saveFormation({ pull: "down", units: UNITS, routes: ROUTES }); // b+2: 何も変わらない保存は印にしない
    p.saveFormation({ pull: "down", units: UNITS, flows: { default: ["dev", "qa"] } }); // b+3: 流れ(経路は引き継ぎ)
    p.saveFormation({ pull: "down", units: [unit("開発", ["dev"], 3), ...UNITS.slice(1)], flows: { default: ["dev", "qa"] }, routes: [] }); // b+4: 島と経路
    const marks = (await formationMarks(p)).filter((m) => m.version > b);
    expect(marks.map((m) => [m.version - b, m.changed])).toEqual([
      [1, ["routes"]],
      [3, ["flows"]],
      [4, ["routes", "units"]],
    ]);
    expect(marks[0]).toMatchObject({ day: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) });
    expect((await productivity(p)).flow.formationMarks.filter((m) => m.version > b).map((m) => m.version - b)).toEqual([1, 3, 4]);
  });
});

describe("島への質問・相談(R16)", () => {
  it("経路あり: 相手の島の手すきの人が答える。答えはやりとりに残り、担当・工程は変わらず、金額はチケットに数える", async () => {
    const { p, d, harness } = setup();
    const { ticket, owner } = await worked(p, d);
    const before = state(p, ticket.id);
    const spent = await ticketSpentUsd(p, ticket.id);

    const said = askQuestion(p, owner, p.ticket(ticket.id), "レビュー", "CSV の空のときはどう確かめる?");
    expect(said).toContain("レビュー に送りました");
    // 経路があるのでリーダーには回らない。受信箱の ask が、チケットを持たずに入る
    expect(leadMessages(p)).toEqual([]);
    expect(all(p.db, "SELECT ticket_id, kind, to_role FROM messages WHERE kind = 'ask'")).toEqual([{ ticket_id: null, kind: "ask", to_role: "review" }]);

    await d.drain();

    const q = questionsOf(p, ticket.id)[0]!;
    expect(q).toMatchObject({ to_target: "レビュー", routed_to_lead: 0, answer: "境界値は 0 件と 1 件を見て", from_member_id: owner.id });
    // 答えたのは、レビューの島のメンバー
    const answerer = p.member(q.answered_by_member_id!);
    expect(get<{ name: string }>(p.db, "SELECT name FROM units WHERE id = ?", [answerer.unit_id])!.name).toBe("レビュー");
    // 起動はチケットを持たず、about_ticket_id にひも付く。道具は reply だけで、コードは読むだけ
    const run = get<{ ticket_id: number | null; about_ticket_id: number; role: string; cost_usd: number }>(p.db, "SELECT ticket_id, about_ticket_id, role, cost_usd FROM runs WHERE id = (SELECT MAX(id) FROM runs)")!;
    expect(run).toMatchObject({ ticket_id: null, about_ticket_id: ticket.id, role: "review" });
    const call = harness.calls.at(-1)!;
    expect(call.tools.map((t) => t.name)).toEqual(["reply"]);
    expect(call.allowedTools).toEqual(["Read", "Glob", "Grep"]);
    // 担当・工程・往復・種類は変わらない
    expect(state(p, ticket.id)).toEqual(before);
    // 答える起動の金額は、聞かれたチケットに数える
    expect(await ticketSpentUsd(p, ticket.id)).toBeCloseTo(spent + run.cost_usd, 6);
    expect((await ticketView(p, ticket.id)).costUsd).toBeCloseTo(spent + run.cost_usd, 6);
    // チケットのやりとりに、質問と答えが並ぶ
    const item = (await ticketView(p, ticket.id)).timeline.find((x) => x.type === "question");
    expect(item).toMatchObject({ type: "question", to: "レビュー", routedToLead: false, noRoute: false, body: "CSV の空のときはどう確かめる?", answer: "境界値は 0 件と 1 件を見て", answeredBy: answerer.name });
    // 次にこのチケットの仕事をする担当の指示に、答えが入る
    const { promptFor } = await import("./prompts.js");
    const msg = { id: 0, ticket_id: ticket.id, to_role: "dev", to_member_id: owner.id, kind: "fix", payload: "{}", status: "pending", available_at: "", attempts: 0, created_at: "", claimed_at: null, last_error: null } as const;
    expect(await promptFor(p, msg, p.ticket(ticket.id), {})).toContain("境界値は 0 件と 1 件を見て");
  });

  it("経路なし: 相手に届かず、リーダーに回る。「経路が無いのでリーダーに回した」がやりとりに残り、担当・工程は変わらない", async () => {
    const { p, d } = setup();
    const { ticket, owner } = await worked(p, d);
    const before = state(p, ticket.id);

    // 開発 ↔ QA は結んでいない
    const said = askQuestion(p, owner, p.ticket(ticket.id), "QA", "受け入れの観点は?");
    expect(said).toContain("経路が無い");
    expect(all(p.db, "SELECT 1 FROM messages WHERE kind = 'ask'")).toEqual([]);
    expect(leadMessages(p).map((m) => m.body)[0]).toContain("経路が無いのでリーダーに回ってきました");
    expect(all(p.db, "SELECT 1 FROM messages WHERE kind = 'chat' AND status = 'pending'")).toHaveLength(1);

    await d.drain();
    expect(state(p, ticket.id)).toEqual(before);
    const item = (await ticketView(p, ticket.id)).timeline.find((x) => x.type === "question");
    expect(item).toMatchObject({ type: "question", to: "QA", routedToLead: true, noRoute: true, answer: null });
    // 質問は ticket_questions に残る
    expect(questionsOf(p, ticket.id)).toHaveLength(1);
  });

  it("リーダーに回った質問(経路なし・リーダー宛て)にリーダーが answer_question で答えると、やりとりに残り、「答えを待っています」が消えて、次の担当の指示に載る", async () => {
    const clock = new ManualClock();
    const p = new Project(":memory:", clock);
    p.addRepo("acme/shop", "API");
    p.saveFormation({ pull: "down", units: UNITS, routes: ROUTES });
    let leadPrompt = "";
    let leadTools: string[] = [];
    const harness = new FakeHarness(async (req, call) => {
      clock.advance(60_000);
      if (req.tools.some((t) => t.name === "answer_question")) {
        leadPrompt = req.prompt;
        leadTools = req.tools.map((t) => t.name);
        const [noRoute, toLead] = questionsOf(p, p.tickets()[0]!.id);
        expect(await call("answer_question", { question_id: noRoute!.id, answer: "QA の観点は、受け入れ条件のとおり" })).toContain("やりとりに残しました");
        // 答えた質問をもう一度・リーダーに回っていない質問・空の答え・無い質問は受けない
        expect(await call("answer_question", { question_id: noRoute!.id, answer: "二度目" })).toContain("もう答えが残っています");
        expect(await call("answer_question", { question_id: 9999, answer: "x" })).toContain("リーダーに回ってきた質問にありません");
        expect(await call("answer_question", { question_id: toLead!.id, answer: "  " })).toContain("答えが空");
        return;
      }
      if (req.tools.some((t) => t.name === "submit_pr")) await call("submit_pr", { summary: "実装した", responses: fixedAll(req.prompt) });
      else if (req.tools.some((t) => t.name === "submit_review")) await call("submit_review", withResolutions(req.prompt, { verdict: "approve", findings: [] }));
    });
    const d = new Dispatcher(p, { harnesses: { "claude-agent-sdk": harness }, workspace: new StaticWorkspace("/tmp") });
    const { ticket, owner } = await worked(p, d);
    askQuestion(p, owner, p.ticket(ticket.id), "QA", "受け入れの観点は?");
    askQuestion(p, owner, p.ticket(ticket.id), "リーダー", "優先度を教えて");
    // 答えを待っている間は、やりとりでは答え無し
    expect((await ticketView(p, ticket.id)).timeline.filter((x) => x.type === "question")).toMatchObject([{ answer: null }, { answer: null }]);

    await d.drain();

    // リーダーの指示に、答えを待っている質問が番号つきで載り、道具が渡る
    expect(leadTools).toContain("answer_question");
    const [noRoute, toLead] = questionsOf(p, ticket.id);
    expect(leadPrompt).toContain(`質問 ${noRoute!.id}`);
    expect(leadPrompt).toContain(`質問 ${toLead!.id}`);
    // 答えた質問だけ、リーダーの答えが残る。答えていない方は待ちのまま
    const lead = p.fixedMember("lead");
    expect(noRoute).toMatchObject({ answer: "QA の観点は、受け入れ条件のとおり", answered_by_member_id: lead.id, routed_to_lead: 1 });
    expect(toLead).toMatchObject({ answer: null, answered_by_member_id: null });
    expect(leadPendingQuestions(p).map((q) => q.id)).toEqual([toLead!.id]);
    const items = (await ticketView(p, ticket.id)).timeline.filter((x) => x.type === "question");
    expect(items[0]).toMatchObject({ noRoute: true, answer: "QA の観点は、受け入れ条件のとおり", answeredBy: lead.name });
    expect(items[1]).toMatchObject({ answer: null });
    // 答えは次にそのチケットの仕事をする担当の指示に載る(答えのない質問は載らない)
    const { promptFor } = await import("./prompts.js");
    const msg = { id: 0, ticket_id: ticket.id, to_role: "dev", to_member_id: owner.id, kind: "fix", payload: "{}", status: "pending", available_at: "", attempts: 0, created_at: "", claimed_at: null, last_error: null } as const;
    const prompt = await promptFor(p, msg, p.ticket(ticket.id), {});
    expect(prompt).toContain("QA の観点は、受け入れ条件のとおり");
    expect(prompt).toContain(`${lead.name}(リーダー) の答え`);
    expect(prompt).not.toContain("優先度を教えて");
  });

  it("リーダーへの質問は経路が無くてもリーダーに届く(「経路が無い」とは残さない)。自分の島や空の質問は受けない", async () => {
    const { p, d } = setup(undefined, []);
    const { ticket, owner } = await worked(p, d);
    askQuestion(p, owner, p.ticket(ticket.id), "リーダー", "優先度を教えて");
    expect((await ticketView(p, ticket.id)).timeline.find((x) => x.type === "question")).toMatchObject({ to: "リーダー", routedToLead: true, noRoute: false });
    expect(askQuestion(p, owner, p.ticket(ticket.id), "開発", "自分たちに")).toContain("自分の島");
    expect(askQuestion(p, owner, p.ticket(ticket.id), "レビュー", "  ")).toContain("質問の中身がありません");
    expect(questionsOf(p, ticket.id)).toHaveLength(1);
  });

  it("開発の起動に「質問する」道具(ask_island)が渡り、呼ぶと経路のある島に届いて、作業は止まらずに答えが返る", async () => {
    const clock = new ManualClock();
    const p = new Project(":memory:", clock);
    p.addRepo("acme/shop", "API");
    p.saveFormation({ pull: "down", units: UNITS, routes: ROUTES });
    const tools: string[][] = [];
    const harness = new FakeHarness(async (req, call) => {
      clock.advance(60_000);
      tools.push(req.tools.map((t) => t.name));
      if (isAsk(req)) await call("reply", { answer: "レビューの観点: 空のとき" });
      else if (req.tools.some((t) => t.name === "submit_pr")) {
        await call("ask_island", { to: "レビュー", question: "空のときの期待は?" });
        await call("submit_pr", { summary: "実装した", responses: fixedAll(req.prompt) });
      } else if (req.tools.some((t) => t.name === "submit_review")) await call("submit_review", withResolutions(req.prompt, { verdict: "approve", findings: [] }));
    });
    const d = new Dispatcher(p, { harnesses: { "claude-agent-sdk": harness }, workspace: new StaticWorkspace("/tmp") });
    await createTicket(p, { title: "CSV 出力" });
    await d.drain();
    const t = p.tickets()[0]!;
    expect(tools[0]).toContain("ask_island");
    // 質問しても、チケットはそのまま流れ(レビューも QA も通って merge 待ち)、答えも返っている
    expect(p.ticket(t.id).stage).toBe("merge");
    expect(questionsOf(p, t.id)[0]).toMatchObject({ answer: "レビューの観点: 空のとき", to_target: "レビュー" });
    // チケットの起動は、質問で増えない(1 チケット 1 起動)
    expect(all<{ role: string }>(p.db, "SELECT role FROM runs WHERE ticket_id = ? ORDER BY id", [t.id]).map((r) => r.role)).toEqual(["dev", "review", "qa"]);
  });

  it("答える島が編成の変更で無くなっていたら、経路が無いものとしてリーダーに回す", async () => {
    const { p, d } = setup();
    const { ticket, owner } = await worked(p, d);
    askQuestion(p, owner, p.ticket(ticket.id), "レビュー", "いま空いてる?");
    p.saveFormation({ pull: "down", units: [unit("開発", ["dev"]), unit("QA", ["qa"])] });
    await d.drain();
    expect(questionsOf(p, ticket.id)[0]).toMatchObject({ routed_to_lead: 1, answer: null });
    expect(all(p.db, "SELECT status FROM messages WHERE kind = 'ask'")).toEqual([{ status: "done" }]);
  });
});
