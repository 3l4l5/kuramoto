import { fixedAll, withResolutions } from "../harness/fake.js";
import { describe, expect, it } from "vitest";
import { ManualClock } from "../clock.js";
import { all, get, run } from "../db/sqlite.js";
import { PROJECT_ID_TABLES } from "../db/schema.js";
import { FakeHarness } from "../harness/fake.js";
import { Dispatcher } from "./dispatcher.js";
import { Project } from "./project.js";
import { saveFormationInput, savePolicyInput, teamView } from "./team.js";
import { createTicket } from "./workflow.js";
import { StaticWorkspace } from "./workspace.js";

function setup() {
  const clock = new ManualClock();
  const p = new Project(":memory:", clock);
  p.addRepo("acme/shop", "API");
  const harness = new FakeHarness(async (req, call) => {
    clock.advance(60_000);
    if (req.tools.some((t) => t.name === "submit_pr")) await call("submit_pr", { summary: "", responses: fixedAll(req.prompt) });
    else await call("submit_review", withResolutions(req.prompt, { verdict: "approve", findings: [] }));
  });
  const d = new Dispatcher(p, { harnesses: { "claude-agent-sdk": harness }, workspace: new StaticWorkspace("/tmp") });
  return { p, d, harness, clock };
}

describe("チームの編成と方針", () => {
  it("方針を変えると版が上がり、次に起こしたメンバーから新しいモデル・深さ・重視することで動く", async () => {
    const { p, d, harness } = setup();
    await createTicket(p, { title: "a" });
    await d.drain();
    expect(harness.calls[0]!.model).toBe("claude-opus-5-5");

    const saved = savePolicyInput(p, "dev", { model: "claude-sonnet-5-5", effort: "medium", focus: "  型を厳しく  ", options: { requireTests: false, smallPr: true } });
    expect(saved).toMatchObject({ version: 2, model: "claude-sonnet-5-5", focus: "型を厳しく" });
    await createTicket(p, { title: "b" });
    await d.drain();
    const dev = harness.calls.filter((c) => c.tools.some((t) => t.name === "submit_pr"));
    expect(dev.at(-1)).toMatchObject({ model: "claude-sonnet-5-5", effort: "medium" });
    expect(dev.at(-1)!.systemPrompt).toContain("型を厳しく");
    expect(dev.at(-1)!.systemPrompt).not.toContain("テストを付けて");
    // どの版で動いたかは出来事にも残る
    const devStarts = p.events(100).filter((e) => e.type === "run_started").map((e) => JSON.parse(e.data)).filter((x) => x.role === "dev");
    expect(devStarts.map((x) => [x.model, x.policyVersion])).toEqual([
      ["claude-sonnet-5-5", 2], // 新しい順
      ["claude-opus-5-5", 1],
    ]);
  });

  it("おかしな方針・編成は理由を出して断る", async () => {
    const { p } = setup();
    expect(() => savePolicyInput(p, "dev", { model: "gpt-5", effort: "high", focus: "" })).toThrow(/知らないモデル/);
    expect(() => savePolicyInput(p, "review", { model: "claude-opus-5-5", effort: "high", focus: "", options: { strictness: "very" } })).toThrow(/レビューの設定/);
    expect(() => savePolicyInput(p, "sec", { model: "claude-opus-5-5", effort: "high", focus: "", options: { x: 1 } })).toThrow(/セキュリティの設定/);
    expect(() => savePolicyInput(p, "owner", { model: "claude-opus-5-5", effort: "high", focus: "" })).toThrow(/変えられません/);
    expect(() => saveFormationInput(p, { pull: "down", units: [{ name: "島", roles: ["review"], maxMembers: 3, summonAt: 2, idleSec: 300 }] })).toThrow(/開発の役割は必須/);
    expect(() => saveFormationInput(p, { pull: "down", units: [{ name: "", roles: ["dev"], maxMembers: 3, summonAt: 2, idleSec: 300 }] })).toThrow(/島の名前/);
    expect((await teamView(p)).formation.current).toBe(1);
  });

});

describe("開発生産性の指標", () => {
  it("トークン・金額・PR・手戻り・人間に助けを求めた数を、記録から数える", async () => {
    const { productivity } = await import("./productivity.js");
    const { addOpenItem, answerOpenItem } = await import("./planning.js");
    const clock = new ManualClock();
    const p = new Project(":memory:", clock);
    p.addRepo("acme/shop", "API");
    let reviews = 0;
    const harness = new FakeHarness(async (req, call) => {
      if (req.tools.some((t) => t.name === "submit_pr")) await call("submit_pr", { summary: "", responses: fixedAll(req.prompt) });
      else if (req.tools.some((t) => t.name === "submit_review"))
        await call("submit_review", withResolutions(req.prompt, reviews++ === 0 ? { verdict: "changes", findings: [{ category: "c", severity: "medium", basis: "acceptance", body: "直して" }] } : { verdict: "approve", findings: [] }));
      return { usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 10, costUsd: 0.5 } };
    });
    const d = new Dispatcher(p, { harnesses: { "claude-agent-sdk": harness }, workspace: new StaticWorkspace("/tmp") });
    const t = await createTicket(p, { title: "CSV" });
    await d.drain();
    answerOpenItem(p, addOpenItem(p, "req", { question: "q", options: ["a", "b"], recommended: 0, why: "", reversible: true }), "a");

    const m = (await productivity(p));
    // 実装 → 差し戻し → 直し → 通る の 4 回
    expect(m.totals).toMatchObject({ runs: 4, tokens: 640, costUsd: 2, prs: 1, completed: 1, costPerCompletedUsd: 2 });
    expect(m.totals.rework).toEqual({ total: 1, changes: 1, conflicts: 0, retries: 0 });
    expect(m.totals.help).toEqual({ total: 1, decisions: 0, planAsks: 1 });
    expect(m.daily).toEqual([{ day: "2026-11-07", tokens: 640, costUsd: 2, prs: 1, merged: 0, rework: 1, help: 1, completed: 1 }].map((x) => ({ ...x, day: m.daily[0]!.day })));
    expect(m.byRole.map((r) => [r.label, r.runs, r.costUsd])).toEqual([
      ["開発", 2, 1],
      ["レビュー", 2, 1],
    ]);
    expect(m.tickets[0]).toMatchObject({ number: t.number, prs: 1, rounds: 1, runs: 4, costUsd: 2 });
    // 金額の内訳: 何の仕事に・どのモデルに
    expect(m.byPurpose.map((x) => [x.label, x.runs, x.costUsd])).toEqual([
      ["レビュー", 2, 1],
      ["直し(差し戻し・衝突)", 1, 0.5],
      ["実装", 1, 0.5],
    ]);
    expect(m.byModel.map((x) => [x.label, x.costUsd])).toEqual([["Opus 5.5", 2]]);
  });
});

describe("登場人物の名前", () => {
  it("固定の担当と島のメンバーは cast.ts の名前で、前の名前の DB は読み替える", async () => {
    const { Project: P } = await import("./project.js");
    const { DatabaseSync } = await import("node:sqlite");
    const { mkdtempSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const p = new P(":memory:", new ManualClock());
    expect(["planner", "designer", "architect", "lead"].map((r) => p.fixedMember(r as never).name)).toEqual(["咲季", "清夏", "広", "星南"]);
    // 島のメンバーは最大人数ぶんずっといる(既定の編成: 開発 4 人・レビュー 3 人)
    expect(p.activeMembers().filter((m) => m.unit_id !== null).map((m) => m.name)).toEqual(["手毬", "ことね", "麻央", "リーリヤ", "千奈", "莉波", "佑芽"]);

    // 版 4 までの DB(前の名前)を開くと、新しい名前に書き換わる
    const path = join(mkdtempSync(join(tmpdir(), "kuramoto-cast-")), "p.sqlite");
    new P(path, new ManualClock()).close();
    const raw = new DatabaseSync(path);
    // 版 22 で主キーに project_id が入った表(settings・plan_stages・dev_rule_versions)は、列を外せないので前の形に作り直す
    raw.exec(`
CREATE TABLE settings_v1 (key TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT INTO settings_v1 (key, value) SELECT key, value FROM settings;
DROP TABLE settings;
ALTER TABLE settings_v1 RENAME TO settings;
CREATE TABLE plan_stages_v1 (stage TEXT PRIMARY KEY CHECK (stage IN ('req','infra','flow','screen','model')),
  mode TEXT NOT NULL CHECK (mode IN ('agree','delegate','skip')), version INTEGER NOT NULL, agreed_version INTEGER);
INSERT INTO plan_stages_v1 (stage, mode, version, agreed_version) SELECT stage, mode, version, agreed_version FROM plan_stages;
DROP TABLE plan_stages;
ALTER TABLE plan_stages_v1 RENAME TO plan_stages;
DROP TABLE dev_rule_versions;
`);
    // 版 21 で足した project_id の索引と列も外す
    for (const i of raw.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE '%\\_project%' ESCAPE '\\'").all() as { name: string }[]) raw.exec(`DROP INDEX ${i.name}`);
    for (const t of PROJECT_ID_TABLES.filter((t) => !(["settings", "plan_stages", "dev_rule_versions"] as string[]).includes(t))) raw.exec(`ALTER TABLE ${t} DROP COLUMN project_id`);
    raw.exec("UPDATE members SET name = CASE name WHEN '咲季' THEN 'サキ' WHEN '手毬' THEN 'ハル' ELSE name END; ALTER TABLE units DROP COLUMN repos; ALTER TABLE units DROP COLUMN model; ALTER TABLE units DROP COLUMN effort; ALTER TABLE runs DROP COLUMN model; ALTER TABLE runs DROP COLUMN effort; ALTER TABLE units DROP COLUMN focus; ALTER TABLE runs DROP COLUMN summary; DROP TABLE ticket_notes; DROP TABLE lead_messages; ALTER TABLE tickets DROP COLUMN triaged; DROP TABLE ticket_deps; DROP TABLE finding_comments; ALTER TABLE units DROP COLUMN budget_usd; ALTER TABLE runs DROP COLUMN unit_name; ALTER TABLE decisions DROP COLUMN lead_note; ALTER TABLE tickets DROP COLUMN dropped_by; ALTER TABLE tickets DROP COLUMN dropped_reason; ALTER TABLE tickets DROP COLUMN dropped_at; ALTER TABLE formations DROP COLUMN routes; ALTER TABLE formations DROP COLUMN flows; ALTER TABLE tickets DROP COLUMN kind; ALTER TABLE tickets DROP COLUMN dev_done; ALTER TABLE dev_rules DROP COLUMN template; ALTER TABLE dev_rules DROP COLUMN created_at; ALTER TABLE rule_violations DROP COLUMN detail; ALTER TABLE rule_violations DROP COLUMN run_id; ALTER TABLE rule_violations DROP COLUMN resolved_at; ALTER TABLE runs DROP COLUMN about_ticket_id; ALTER TABLE dev_rules DROP COLUMN deleted_at; PRAGMA user_version = 4;");
    raw.close();
    const q = new P(path, new ManualClock());
    expect(q.fixedMember("planner").name).toBe("咲季");
    expect(q.activeMembers().map((m) => m.name)).toContain("手毬");
  });
});

describe("島を増やし、同じ役割を複数の島に持たせる(ADR-0019)", () => {
  function twoRepos() {
    const clock = new ManualClock();
    const p = new Project(":memory:", clock);
    p.addRepo("acme/web", "フロント");
    p.addRepo("acme/api", "API");
    const harness = new FakeHarness(async (req, call) => {
      // 少し時間をかける(マイクロタスクの数に頼らず、先の起動が動いている間に次の担当が決まるようにする)
      await new Promise((r) => setTimeout(r, 5));
      if (req.tools.some((t) => t.name === "submit_pr")) {
        await call("submit_pr", { summary: "", responses: fixedAll(req.prompt) });
      } else await call("submit_review", withResolutions(req.prompt, { verdict: "approve", findings: [] }));
    });
    const d = new Dispatcher(p, { harnesses: { "claude-agent-sdk": harness }, workspace: new StaticWorkspace("/tmp") });
    return { p, d };
  }
  const devUnitOf = (p: Project, ticketId: number) =>
    all<{ name: string }>(p.db, "SELECT u.name FROM runs r JOIN members m ON m.id = r.member_id JOIN units u ON u.id = m.unit_id WHERE r.ticket_id = ? AND r.role = 'dev'", [ticketId])[0]?.name;

  it("受け持つリポジトリを決めた島には、そのリポジトリのチケットだけが行く", async () => {
    const { p, d } = twoRepos();
    saveFormationInput(p, {
      pull: "down",
      units: [
        { name: "フロント開発", roles: ["dev"], maxMembers: 2, summonAt: 2, idleSec: 300, repos: ["acme/web"] },
        { name: "API 開発", roles: ["dev"], maxMembers: 2, summonAt: 2, idleSec: 300, repos: ["acme/api"] },
        { name: "レビュー", roles: ["review"], maxMembers: 2, summonAt: 2, idleSec: 300 },
      ],
    });
    const web = await createTicket(p, { title: "画面", planRefs: { repo: "acme/web" } });
    const api = await createTicket(p, { title: "API", planRefs: { repo: "acme/api" } });
    await d.drain({ concurrency: 3 });
    expect(devUnitOf(p, web.id)).toBe("フロント開発");
    expect(devUnitOf(p, api.id)).toBe("API 開発");
    expect(p.ticket(web.id).stage).toBe("merge");
    // どこにも受け持たれないリポジトリが出る編成は、適用前に止める
    expect(() =>
      saveFormationInput(p, {
        pull: "down",
        units: [
          { name: "フロント開発", roles: ["dev"], maxMembers: 2, summonAt: 2, idleSec: 300, repos: ["acme/web"] },
          { name: "レビュー", roles: ["review"], maxMembers: 2, summonAt: 2, idleSec: 300 },
        ],
      }),
    ).toThrow(/acme\/api の開発を受け持つ島がありません/);
  });

  it("受け持ちを決めていない同じ役割の島が複数あれば、手の空いている島が取る", async () => {
    const { p, d } = twoRepos();
    saveFormationInput(p, {
      pull: "down",
      units: [
        { name: "開発 A", roles: ["dev"], maxMembers: 1, summonAt: 2, idleSec: 300 },
        { name: "開発 B", roles: ["dev"], maxMembers: 1, summonAt: 2, idleSec: 300 },
        { name: "レビュー", roles: ["review"], maxMembers: 2, summonAt: 2, idleSec: 300 },
      ],
    });
    const a = await createTicket(p, { title: "a" });
    const b = await createTicket(p, { title: "b" });
    await d.drain({ concurrency: 2 });
    expect(new Set([devUnitOf(p, a.id), devUnitOf(p, b.id)])).toEqual(new Set(["開発 A", "開発 B"]));
    expect((await teamView(p)).formation.versions.at(-1)!.units.map((u) => u.name)).toEqual(["開発 A", "開発 B", "レビュー"]);
  });
});

describe("島ごとのモデル", () => {
  it("島にモデル・深さを設定すると、その島のメンバーはそれを使い、実際に使ったモデルが記録と内訳に残る", async () => {
    const { productivity } = await import("./productivity.js");
    const { p, d, harness } = setup();
    saveFormationInput(p, {
      pull: "down",
      units: [
        { name: "開発", roles: ["dev"], maxMembers: 2, summonAt: 2, idleSec: 300, model: "claude-haiku-5-5", effort: "low" },
        { name: "レビュー", roles: ["review"], maxMembers: 2, summonAt: 2, idleSec: 300 },
      ],
    });
    await createTicket(p, { title: "a" });
    await d.drain();
    const dev = harness.calls.find((c) => c.tools.some((t) => t.name === "submit_pr"))!;
    const review = harness.calls.find((c) => c.tools.some((t) => t.name === "submit_review"))!;
    expect([dev.model, dev.effort]).toEqual(["claude-haiku-5-5", "low"]);
    expect([review.model, review.effort]).toEqual(["claude-opus-5-5", "high"]); // 設定の無い島は役割の方針どおり
    expect(all(p.db, "SELECT role, model, effort FROM runs ORDER BY id")).toEqual([
      { role: "dev", model: "claude-haiku-5-5", effort: "low" },
      { role: "review", model: "claude-opus-5-5", effort: "high" },
    ]);
    expect((await productivity(p)).byModel.map((m) => m.label).sort()).toEqual(["Haiku 5.5", "Opus 5.5"]);
    expect(() => saveFormationInput(p, { pull: "down", units: [{ name: "x", roles: ["dev"], maxMembers: 2, summonAt: 2, idleSec: 300, model: "gpt-5" }] })).toThrow(/知らないモデル/);
  });
});

describe("チケットの中身とやりとり", () => {
  it("起動・PR・レビューの指摘・直し・承認が時刻順に並び、責任者のメモは次の担当への指示に入る。島の重視することも入る", async () => {
    const { ticketView } = await import("./ticket.js");
    const clock = new ManualClock();
    const p = new Project(":memory:", clock);
    p.addRepo("acme/shop", "API");
    let reviews = 0;
    const harness = new FakeHarness(async (req, call) => {
      clock.advance(1000);
      if (req.tools.some((t) => t.name === "submit_pr")) {
        await call("submit_pr", { summary: req.prompt.includes("差し戻されました") ? "null を返さないよう直した" : "CSV の書き出しを足した", responses: fixedAll(req.prompt) });
        return {};
      }
      await call("submit_review", withResolutions(req.prompt, reviews++ === 0 ? { verdict: "changes", findings: [{ category: "correctness", severity: "high", basis: "acceptance", path: "src/csv.ts", line: 12, body: "空のときに null を返す" }] } : { verdict: "approve", findings: [] }));
      return { finalText: "見ました" };
    });
    const d = new Dispatcher(p, { harnesses: { "claude-agent-sdk": harness }, workspace: new StaticWorkspace("/tmp", { prNumber: () => 9 }) });
    saveFormationInput(p, {
      pull: "down",
      units: [
        { name: "開発", roles: ["dev"], maxMembers: 2, summonAt: 2, idleSec: 300, focus: "テストを先に書く" },
        { name: "レビュー", roles: ["review"], maxMembers: 2, summonAt: 2, idleSec: 300 },
      ],
    });
    const t = await createTicket(p, { title: "CSV を書き出す" });
    p.addNote(t.id, "文字コードは UTF-8(BOM あり)にして");
    await d.drain();

    const devCalls = harness.calls.filter((c) => c.tools.some((x) => x.name === "submit_pr"));
    expect(devCalls[0]!.prompt).toContain("### メモ(責任者・リーダーから)\n- 責任者: 文字コードは UTF-8(BOM あり)にして");
    expect(devCalls[0]!.systemPrompt).toContain("## あなたの島(開発)で重視すること\nテストを先に書く");
    // 話し方はメンバーごと(手毬)。成果物には使わないことも伝える
    expect(devCalls[0]!.systemPrompt).toContain("## あなたの話し方(あなたは手毬)");
    expect(devCalls[0]!.systemPrompt).toContain("コード・コミット・PR の本文");
    expect(harness.calls.find((c) => c.tools.some((x) => x.name === "submit_review"))!.systemPrompt).not.toContain("テストを先に書く");

    const v = await ticketView(p, t.id);
    expect(v.timeline.map((x) => (x.type === "run" ? `run:${x.kind}` : x.type === "review" ? `review:${x.verdict}` : x.type))).toEqual([
      "created",
      "note",
      "run:実装",
      "pr",
      "run:レビュー",
      "review:差し戻し",
      "run:直し",
      "pr",
      "run:レビュー",
      "review:承認",
    ]);
    const firstReview = v.timeline.find((x) => x.type === "review")!;
    expect(firstReview.type === "review" && firstReview.findings[0]).toMatchObject({ severity: "high", path: "src/csv.ts", line: 12, body: "空のときに null を返す", status: "fixed" });
    const runs = v.timeline.filter((x) => x.type === "run");
    expect(runs[0]!.type === "run" && runs[0]!.summary).toBe("CSV の書き出しを足した");
    expect(runs[2]!.type === "run" && runs[2]!.summary).toBe("null を返さないよう直した");
    expect(v.prs).toMatchObject([{ number: 9, full_name: "acme/shop" }]);

    p.editTicket(t.id, { title: "CSV を書き出す(UTF-8)", body: "注文履歴" });
    expect(await ticketView(p, t.id)).toMatchObject({ title: "CSV を書き出す(UTF-8)", body: "注文履歴" });
    expect(() => p.addNote(t.id, "  ")).toThrow(/メモがありません/);
  });
});

describe("リーダーとのチャット", () => {
  it("書いたメッセージは 1 回の起動でまとめて読まれ、返事が残る。頼まれた作業はチケットになり、既存のチケットへの指示はメモになる", async () => {
    const { leadChatView, sayToLead } = await import("./leadchat.js");
    const clock = new ManualClock();
    const p = new Project(":memory:", clock);
    p.addRepo("acme/shop", "API");
    const t = await createTicket(p, { title: "CSV" });
    const harness = new FakeHarness(async (req, call) => {
      if (!req.tools.some((x) => x.name === "add_ticket_note")) return {};
      expect(req.prompt).toContain("- #1 CSV [dev]");
      expect(req.prompt).toContain("- 進み具合は?");
      expect(req.prompt).toContain("- ログイン画面も作って");
      await call("create_ticket", { title: "ログイン画面", body: "メールとパスワード" });
      await call("add_ticket_note", { number: 1, body: "文字コードは UTF-8" });
      return { finalText: "#1 は実装待ちです。ログイン画面は #2 にしました。" };
    });
    // オフィスは終業中(チケットの仕事は取らない)でも、チャットには返事をする
    const d = new Dispatcher(p, { harnesses: { "claude-agent-sdk": harness }, workspace: new StaticWorkspace("/tmp"), ticketsAllowed: () => false });
    sayToLead(p, "進み具合は?");
    sayToLead(p, "ログイン画面も作って");
    expect((await leadChatView(p)).work).toEqual({ state: "queued" });
    await d.drain();
    expect(harness.calls).toHaveLength(1);
    expect((await leadChatView(p)).messages.map((m) => [m.who, m.body])).toEqual([
      ["owner", "進み具合は?"],
      ["owner", "ログイン画面も作って"],
      ["lead", "#1 は実装待ちです。ログイン画面は #2 にしました。"],
    ]);
    expect((await leadChatView(p)).work).toBeNull();
    expect(p.tickets().map((x) => x.title)).toEqual(["CSV", "ログイン画面"]);
    expect(p.notes(t.id)).toMatchObject([{ who: "lead", body: "文字コードは UTF-8" }]);
    expect(() => sayToLead(p, " ")).toThrow(/メッセージがありません/);
  });
});

describe("始業の反映", () => {
  it("企画の長い仕事が動いている間に始業しても、起こせばすぐにチケットの仕事を取る", async () => {
    const p = new Project(":memory:", new ManualClock());
    p.addRepo("acme/shop", "API");
    let finishPlan!: () => void;
    const planDone = new Promise<void>((r) => (finishPlan = r));
    const started: string[] = [];
    const harness = new FakeHarness(async (req) => {
      if (req.tools.some((t) => t.name === "submit_pr")) {
        started.push("dev");
        return {};
      }
      started.push("plan");
      await planDone;
      return {};
    });
    let running = false;
    const { send } = await import("./inbox.js");
    send(p, { ticketId: null, toRole: "architect", kind: "plan", payload: { stage: "infra", events: [] } });
    await createTicket(p, { title: "CSV" });
    const d = new Dispatcher(p, { harnesses: { "claude-agent-sdk": harness }, workspace: new StaticWorkspace("/tmp"), ticketsAllowed: () => running, recheckMs: 60_000 });
    const drained = d.drain({ concurrency: 2 });
    await new Promise((r) => setTimeout(r, 20));
    expect(started).toEqual(["plan"]); // 終業中はチケットを取らない
    running = true; // 始業
    d.wake();
    await new Promise((r) => setTimeout(r, 20));
    expect(started).toEqual(["plan", "dev"]); // 企画が終わるのを待たずに取る
    finishPlan();
    await drained;
  });
});

describe("並列と交通整理", () => {
  it("島のメンバー全員で並列に実装する。リーダーが順番を決めたチケットは、先のものが merge されるまで着手しない", async () => {
    const p = new Project(":memory:", new ManualClock());
    p.addRepo("acme/shop", "API");
    p.saveFormation({ pull: "down", units: [{ name: "開発の島", roles: ["dev"], maxMembers: 3, summonAt: 2, idleSec: 600 }, { name: "レビューの島", roles: ["review"], maxMembers: 1, summonAt: 2, idleSec: 600 }] });
    for (const t of ["土台", "メモ API", "検索 API", "画面"]) await createTicket(p, { title: t });
    const { leadMessages } = await import("./leadchat.js");
    const { blockers } = await import("./triage.js");

    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const running = new Set<string>();
    let peak = 0;
    const devTickets: string[] = [];
    const harness = new FakeHarness(async (req, call) => {
      if (req.tools.some((t) => t.name === "plan_work")) {
        expect(req.prompt).toContain("### #1 土台");
        expect(req.prompt).toContain("- 開発の島(開発): 3/3 人");
        await call("plan_work", {
          items: [
            { number: 1, after: [] },
            { number: 2, after: [1], note: "土台の DB 接続を使う" },
            { number: 3, after: [] },
            { number: 4, after: [] },
          ],
        });
        return { finalText: "#1・#3・#4 を並列に、#2 は #1 のあとにしたわ。" };
      }
      if (req.tools.some((t) => t.name === "submit_pr")) {
        const n = req.prompt.match(/チケット #(\d+)/)![1]!;
        devTickets.push(n);
        running.add(n);
        peak = Math.max(peak, running.size);
        await gate;
        running.delete(n);
        return {};
      }
      return {};
    });
    const d = new Dispatcher(p, { harnesses: { "claude-agent-sdk": harness }, workspace: new StaticWorkspace("/tmp"), triage: true, recheckMs: 10 });
    expect(d.capacity()).toBe(3 + 1 + 4); // 島の最大人数の合計 + 島に属さない 4 人
    const drained = d.drain({ concurrency: () => d.capacity(), maxRuns: 6 });
    await new Promise((r) => setTimeout(r, 80));
    // 交通整理が先。#2 は #1 待ちなので、#1・#3・#4 の 3 件が、島の 3 人で同時に動く
    expect(devTickets.sort()).toEqual(["1", "3", "4"]);
    expect(peak).toBe(3);
    expect(await blockers(p, p.tickets()[1]!.id)).toEqual([1]);
    expect(p.notes(p.tickets()[1]!.id)).toMatchObject([{ who: "lead", body: "土台の DB 接続を使う" }]);
    expect(leadMessages(p).at(-1)!.body).toContain("【交通整理 #1, #2, #3, #4】");
    release();
    await drained;
  });
});

describe("同じ場所を触るチケットは同時に開発しない(ADR-0024)", () => {
  it("触る場所が重なるチケットは、先に取りかかった方が終わるまで着手しない。重ならないものは並列に進む", async () => {
    const p = new Project(":memory:", new ManualClock());
    p.addRepo("acme/shop", "API");
    p.saveFormation({ pull: "down", units: [{ name: "開発の島", roles: ["dev"], maxMembers: 3, summonAt: 2, idleSec: 600 }] });
    for (const t of ["CI で画面を撮る", "CI で CSP を確かめる", "メモ一覧"]) await createTicket(p, { title: t });
    const { areaWait, areasOf } = await import("./triage.js");
    const { officeView } = await import("./office.js");

    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const devTickets: string[] = [];
    const harness = new FakeHarness(async (req, call) => {
      if (req.tools.some((t) => t.name === "plan_work")) {
        expect(req.prompt).toContain("areas");
        await call("plan_work", {
          items: [
            { number: 1, areas: ["./scripts/ci-screenshots.mjs", ".github/workflows/"] },
            { number: 2, areas: ["Scripts/CI-Screenshots.mjs"] },
            { number: 3, areas: ["メモ一覧"] },
          ],
        });
        return { finalText: "#1 と #2 は同じ場所なので順番に、#3 は並列にしたわ。" };
      }
      if (req.tools.some((t) => t.name === "submit_pr")) {
        devTickets.push(req.prompt.match(/チケット #(\d+)/)![1]!);
        await gate;
      }
      return {};
    });
    const d = new Dispatcher(p, { harnesses: { "claude-agent-sdk": harness }, workspace: new StaticWorkspace("/tmp"), triage: true, recheckMs: 10 });
    const drained = d.drain({ concurrency: () => d.capacity(), maxRuns: 4 });
    await new Promise((r) => setTimeout(r, 80));
    // 島には 3 人いるが、#2 は #1 と同じファイルを触るので待つ
    expect(devTickets.sort()).toEqual(["1", "3"]);
    const [t1, t2] = p.tickets();
    expect(await areasOf(p, t1!.id)).toEqual([".github/workflows", "scripts/ci-screenshots.mjs"]);
    expect(await areaWait(p, t2!.id)).toEqual([{ number: 1, areas: ["scripts/ci-screenshots.mjs"] }]);
    // 先に取りかかった #1 は #2 を待たない
    expect(await areaWait(p, t1!.id)).toEqual([]);
    const q = (await officeView(p)).units[0]!.queued;
    expect(q).toEqual([{ number: 2, why: "同じ場所(scripts/ci-screenshots.mjs)を触る #1 の完了待ち" }]);
    release();
    await drained;
    // #1 が merge されたら、#2 は待たない
    p.setStage(t1!.id, "done");
    expect(await areaWait(p, t2!.id)).toEqual([]);
  });
});

describe("島を離れた持ち主の直し(ADR-0023)", () => {
  it("持ち主が席替えで島を離れていたら、呼び戻さずに島の手すきの人が引き継ぐ。島の人数は最大人数のまま", async () => {
    const p = new Project(":memory:", new ManualClock());
    p.addRepo("acme/shop", "API");
    const formation = (n: number) => ({ pull: "down" as const, units: [{ name: "開発の島", roles: ["dev" as const], maxMembers: n, summonAt: 2, idleSec: 600 }] });
    p.saveFormation(formation(2));
    const [a, b] = p.activeMembers().filter((m) => m.unit_id !== null);
    const t = await createTicket(p, { title: "退会" });
    run(p.db, "UPDATE tickets SET owner_member_id = ? WHERE id = ?", [b!.id, t.id]);
    run(p.db, "UPDATE messages SET status = 'done' WHERE ticket_id = ?", [t.id]);
    p.saveFormation(formation(1));
    expect(p.member(b!.id).left_at).not.toBeNull();

    const { send } = await import("./inbox.js");
    send(p, { ticketId: t.id, toRole: "dev", toMemberId: b!.id, kind: "fix", payload: {} });
    const harness = new FakeHarness(async (req, call) => {
      if (req.tools.some((x) => x.name === "submit_pr")) await call("submit_pr", { summary: "直した", responses: fixedAll(req.prompt) });
    });
    const d = new Dispatcher(p, { harnesses: { "claude-agent-sdk": harness }, workspace: new StaticWorkspace("/tmp") });
    await d.drain({ maxRuns: 1 });

    expect(get(p.db, "SELECT member_id FROM runs WHERE role = 'dev'")).toEqual({ member_id: a!.id });
    expect(p.ticket(t.id).owner_member_id).toBe(a!.id);
    expect(p.member(b!.id).left_at).not.toBeNull();
    expect(p.activeMembers().filter((m) => m.unit_id !== null)).toHaveLength(1);
    expect(p.notes(t.id).at(-1)!.body).toContain("引き継ぎ");
  });

  it("最大人数を超えて席にいる人は、作業中でなければ帰す", async () => {
    const p = new Project(":memory:", new ManualClock());
    p.saveFormation({ pull: "down", units: [{ name: "開発の島", roles: ["dev"], maxMembers: 3, summonAt: 2, idleSec: 600 }] });
    const unit = p.currentFormation().units[0]!;
    p.addMember(unit.id, true);
    expect(p.membersOfUnit(unit.id)).toHaveLength(4);
    p.fillSeats();
    expect(p.membersOfUnit(unit.id)).toHaveLength(3);
  });
});

describe("重複したチケットを片付ける", () => {
  it("リーダーは、まだ着手していない重複チケットを片付け、中身と待ちを残す方へ移す", async () => {
    const p = new Project(":memory:", new ManualClock());
    p.addRepo("acme/shop", "API");
    const { dropAsDuplicate, blockers } = await import("./triage.js");
    const keep = await createTicket(p, { title: "412 のときの文言" });
    const dup = await createTicket(p, { title: "手で押す保存で 412 が出たときの文言", body: "自動保存とそろえる" });
    const later = await createTicket(p, { title: "保存のテスト" });
    run(p.db, "INSERT INTO ticket_deps (ticket_id, depends_on) VALUES (?, ?)", [later.id, dup.id]);

    expect(await dropAsDuplicate(p, dup.number, keep.number)).toContain("片付けました");
    expect(p.ticket(dup.id).stage).toBe("dropped");
    expect(p.notes(keep.id).at(-1)!.body).toContain("自動保存とそろえる");
    expect(await blockers(p, later.id)).toEqual([keep.number]);
    expect(all(p.db, "SELECT 1 FROM messages WHERE ticket_id = ? AND status = 'pending'", [dup.id])).toEqual([]);

    // 着手したチケットは片付けない
    run(p.db, "INSERT INTO runs (message_id, ticket_id, member_id, role, policy_id, formation_id, started_at, ended_at) VALUES (1, ?, 1, 'dev', 1, 1, '', '')", [later.id]);
    expect(await dropAsDuplicate(p, later.number, keep.number)).toContain("取りかかっている");
  });
});

describe("リーダーの割り当ての権限", () => {
  it("リーダーは島とメンバーの今を見て、島を名指しして割り当てられる。手すきがいなければ、島の誰かが空いたら取る", async () => {
    const { teamStatus, triageTools, planWork } = await import("./triage.js");
    const p = new Project(":memory:", new ManualClock());
    p.addRepo("acme/shop", "API");
    p.saveFormation({ pull: "down", units: [{ name: "フロント", roles: ["dev"], maxMembers: 2, summonAt: 6, idleSec: 600 }, { name: "レビュー", roles: ["review"], maxMembers: 1, summonAt: 2, idleSec: 600 }] });
    const a = await createTicket(p, { title: "A" });
    const b = await createTicket(p, { title: "B" });
    const c = await createTicket(p, { title: "C" });
    const [m1, m2] = p.membersOfUnit(p.currentFormation().units[0]!.id);
    expect(await teamStatus(p)).toContain(`- フロント(開発): 2/2 人 / 待ち 3 件\n  ${m1!.name}: 手すき\n  ${m2!.name}: 手すき`);

    // 島を名指し: 1・2 件目は手すきの 2 人に、3 件目は島の誰かが空いたら
    const out = await planWork(p, [
      { number: 1, assignee: "フロント" },
      { number: 2, assignee: "フロント" },
      { number: 3, assignee: "フロント" },
    ]);
    expect(out).toContain("フロント に手すきの人がいない");
    const to = (t: { id: number }) => get<{ to_member_id: number | null }>(p.db, "SELECT to_member_id FROM messages WHERE ticket_id = ? AND kind = 'implement'", [t.id])!.to_member_id;
    expect([to(a), to(b), to(c)]).toEqual([m1!.id, m2!.id, null]);
    expect(await teamStatus(p)).toContain(`${m2!.name}: 手すき / 次に #2`);
    // 応援を呼ぶ道具は無い(メンバーはずっといる)
    expect(triageTools(p).map((t) => t.name)).not.toContain("call_helper");
  });
});

describe("merge 待ちで止まっているチケット", () => {
  it("merge すると着手できるものと、その先で順に動き出すものを分けて返す", async () => {
    const { mergeBlockers, mergeUnblocks, planWork } = await import("./triage.js");
    const { run } = await import("../db/sqlite.js");
    const p = new Project(":memory:", new ManualClock());
    p.addRepo("acme/shop", "API");
    for (let i = 1; i <= 6; i++) await createTicket(p, { title: `T${i}` });
    // #1・#2 は merge 待ち。#3 は #1 だけ待ち、#4 は #3 待ち、#5 は #1 と #2 待ち、#6 は誰も待たない
    run(p.db, "UPDATE tickets SET stage = 'merge' WHERE number IN (1, 2)");
    expect(await planWork(p, [{ number: 3, after: [1] }, { number: 4, after: [3] }, { number: 5, after: [1, 2] }])).toContain("3 件");
    const u = await mergeUnblocks(p);
    const id = (n: number) => p.tickets().find((t) => t.number === n)!.id;
    expect(u.get(id(1))).toEqual({ now: [3], later: [4, 5] });
    expect(u.get(id(2))).toEqual({ now: [], later: [5] });
    expect(await mergeBlockers(p, id(5))).toEqual([1, 2]);
    expect(await mergeBlockers(p, id(4))).toEqual([]); // #3 はまだ作業中なので merge 待ちではない
    // #1 が merge されると、#1 は載らなくなる
    run(p.db, "UPDATE tickets SET stage = 'done' WHERE number = 1");
    expect((await mergeUnblocks(p)).has(id(1))).toBe(false);
    expect((await mergeUnblocks(p)).get(id(2))).toEqual({ now: [5], later: [] });
  });
});

describe("予算(全体・島)", () => {
  it("全体の予算を使い切ると何も起こさず、無制限にすると再開する。起動 1 回の予算は全体の残りで抑える", async () => {
    const { setProjectBudget, budgetView } = await import("./budget.js");
    const { p, d, harness } = setup();
    await createTicket(p, { title: "一覧" });
    setProjectBudget(p, 0.5);
    await d.dispatchOnce();
    expect(harness.calls[0]!.maxBudgetUsd).toBeCloseTo(0.5);
    // 使った額を足して、残りを 0.1 未満にする
    const { run } = await import("../db/sqlite.js");
    run(p.db, "UPDATE runs SET cost_usd = 0.45");
    expect(await d.dispatchOnce()).toBe(false);
    expect(budgetView(p).project.exhausted).toBe(true);
    expect(all(p.db, "SELECT type FROM events WHERE type = 'project_budget_reached'")).toHaveLength(1);
    setProjectBudget(p, null);
    expect(await d.dispatchOnce()).toBe(true);
  });

  it("島の予算を使い切ると、その島には回さず同じ役割のほかの島へ回す。ほかに無ければ待つ", async () => {
    const { budgetView } = await import("./budget.js");
    const { run } = await import("../db/sqlite.js");
    const { p, d, harness } = setup();
    p.saveFormation({
      pull: "down",
      units: [
        { name: "開発A", roles: ["dev"], maxMembers: 1, summonAt: 1, idleSec: 600, budgetUsd: 1 },
        { name: "開発B", roles: ["dev"], maxMembers: 1, summonAt: 1, idleSec: 600, budgetUsd: null },
        { name: "レビューの島", roles: ["review"], maxMembers: 1, summonAt: 1, idleSec: 600, budgetUsd: 0.5 },
      ],
    });
    await createTicket(p, { title: "一覧" });
    // 開発A の予算を使い切ったことにする
    const a = p.currentFormation().units.find((u) => u.name === "開発A")!;
    const am = p.membersOfUnit(a.id)[0]!;
    const msgId = run(p.db, "INSERT INTO messages (ticket_id, to_role, kind, available_at, created_at, status) VALUES (NULL, 'dev', 'implement', '', '', 'done')").lastId;
    run(p.db, "INSERT INTO runs (message_id, member_id, role, policy_id, formation_id, started_at, ended_at, cost_usd, unit_name) VALUES (?, ?, 'dev', 1, ?, '', '', 0.95, '開発A')", [msgId, am.id, p.currentFormation().id]);
    expect(budgetView(p).units.find((u) => u.name === "開発A")!.exhausted).toBe(true);

    await d.dispatchOnce();
    const b = p.currentFormation().units.find((u) => u.name === "開発B")!;
    expect(get<{ unit_name: string }>(p.db, "SELECT unit_name FROM runs ORDER BY id DESC LIMIT 1")!.unit_name).toBe("開発B");
    expect(p.ticket(p.tickets()[0]!.id).owner_member_id).toBe(p.membersOfUnit(b.id)[0]!.id);

    // レビューは島の残り 0.5 で起動を抑える。使い切ったら、ほかにレビューの島が無いので待つ
    await d.dispatchOnce();
    expect(harness.calls.at(-1)!.maxBudgetUsd).toBeCloseTo(0.5);
    run(p.db, "UPDATE runs SET cost_usd = 0.45 WHERE unit_name = 'レビューの島'");
    await createTicket(p, { title: "二つ目" });
    await d.dispatchOnce(); // 二つ目の実装(開発B)
    const before = harness.calls.length;
    expect(await d.dispatchOnce()).toBe(false); // 二つ目のレビューは待つ
    expect(harness.calls.length).toBe(before);
  });

  it("チケットの残りが少なすぎるときは起動せず、予算を足すかを聞く", async () => {
    const { run } = await import("../db/sqlite.js");
    const { p, d, harness } = setup();
    p.setSetting("ticket_budget_usd", "5");
    const t = await createTicket(p, { title: "CI" });
    const msgId = run(p.db, "INSERT INTO messages (ticket_id, to_role, kind, available_at, created_at, status) VALUES (?, 'dev', 'implement', '', '', 'done')", [t.id]).lastId;
    run(p.db, "INSERT INTO runs (message_id, ticket_id, member_id, role, policy_id, formation_id, started_at, ended_at, cost_usd) VALUES (?, ?, 1, 'dev', 1, ?, '', '', 4.95)", [msgId, t.id, p.currentFormation().id]);
    await d.dispatchOnce();
    expect(harness.calls).toHaveLength(0);
    expect(get<{ question: string }>(p.db, "SELECT question FROM decisions WHERE ticket_id = ?", [t.id])!.question).toContain("予算");
  });
});

describe("取りやめを戻す・オフィスの順番待ち", () => {
  it("取りやめたチケットを戻すと、持ち主が続きから進めて merge 待ちまで行く", async () => {
    const { reopenTicket } = await import("./workflow.js");
    const { p, d, harness } = setup();
    const t = await createTicket(p, { title: "ログイン" });
    await d.dispatchOnce(); // 実装して持ち主が決まる
    const owner = p.ticket(t.id).owner_member_id;
    p.setStage(t.id, "dropped");
    expect(await d.drain()).toBeGreaterThanOrEqual(0); // 取りやめの間は何も進まない
    expect(p.ticket(t.id).stage).toBe("dropped");

    await reopenTicket(p, t.id);
    await d.drain();
    const resumed = harness.calls.find((c) => c.prompt.includes("責任者が取りやめを戻しました"))!;
    expect(resumed).toBeDefined();
    expect(p.ticket(t.id).owner_member_id).toBe(owner);
    expect(p.ticket(t.id).stage).toBe("merge");
    await expect(reopenTicket(p, t.id)).rejects.toThrow("取りやめになっていない");
  });

  it("先のチケットを待っている実装は、島の「すぐ取れる仕事」に数えず、順番待ちとして理由を出す", async () => {
    const { officeView } = await import("./office.js");
    const { planWork, markTriaged } = await import("./triage.js");
    const { run } = await import("../db/sqlite.js");
    const p = new Project(":memory:", new ManualClock());
    p.addRepo("acme/shop", "API");
    for (const title of ["外枠", "編集", "検索"]) await createTicket(p, { title });
    run(p.db, "UPDATE tickets SET stage = 'merge' WHERE number = 1");
    run(p.db, "UPDATE messages SET status = 'done' WHERE ticket_id = (SELECT id FROM tickets WHERE number = 1)");
    await planWork(p, [{ number: 2, after: [1] }, { number: 3, after: [] }]);
    await markTriaged(p, p.tickets().map((t) => t.id));
    const dev = (await officeView(p)).units.find((u) => u.roleKeys.includes("dev"))!;
    expect(dev.waiting).toEqual([3]);
    expect(dev.queued).toEqual([{ number: 2, why: "#1 の merge 待ち" }]);
  });
});

describe("オフィスの様子(メンバー・島)", () => {
  it("メンバーの様子には、受け持ちのチケットとこれまでの仕事が新しい順に並ぶ。島の様子には、メンバー・待ち・予算・最近の仕事が並ぶ", async () => {
    const { memberView, unitView } = await import("./people.js");
    const { officeView } = await import("./office.js");
    const { p, d } = setup();
    const t = await createTicket(p, { title: "一覧" });
    await d.drain();
    const owner = p.ticket(t.id).owner_member_id!;
    const m = await memberView(p, owner);
    expect(m.owned).toMatchObject([{ number: 1, title: "一覧", stage: "merge" }]);
    expect(m.history[0]).toMatchObject({ ticket: { number: 1 }, kind: "実装", outcome: "終わった", running: false });
    expect(m.totals.runs).toBe(1);
    expect(m.work).toBeNull();

    const dev = p.currentFormation().units.find((u) => u.roles.includes("dev"))!;
    const u = await unitView(p, dev.id, (await officeView(p)));
    expect(u.name).toBe(dev.name);
    expect(u.members.map((x) => x.id)).toContain(owner);
    expect(u.budget.budgetUsd).toBeNull();
    expect(u.recent[0]).toMatchObject({ ticket: { number: 1 }, kind: "実装" });
    expect(u.last24h.runs).toBe(1);
  });
});
