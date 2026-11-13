import { describe, expect, it } from "vitest";
import { ManualClock } from "../clock.js";
import { all, get } from "../db/sqlite.js";
import type { FlowsSpec, TicketKind } from "../domain/flow.js";
import type { UnitSpec } from "../domain/formation.js";
import { FakeHarness, fixedAll, withResolutions, type FakeStep } from "../harness/fake.js";
import { Dispatcher } from "./dispatcher.js";
import { leadChatTools } from "./leadchat.js";
import { Project } from "./project.js";
import { ticketView } from "./ticket.js";
import { StaticWorkspace } from "./workspace.js";
import { claimNext } from "./inbox.js";
import { createTicket, setTicketKind } from "./workflow.js";

const REPO = "acme/shop";
const unit = (name: string, roles: UnitSpec["roles"]): UnitSpec => ({ name, roles, maxMembers: 2, summonAt: 2, idleSec: 300 });
const ALL = [unit("開発", ["dev"]), unit("レビュー", ["review"]), unit("セキュリティ", ["sec"]), unit("QA", ["qa"])];

/** 開発は PR を出し、確認は承認し、開発より前の確認は申し送りを残す台本。 */
const script: FakeStep = async (req, call) => {
  const names = req.tools.map((t) => t.name);
  if (names.includes("submit_pr")) await call("submit_pr", { summary: "実装した", responses: fixedAll(req.prompt) });
  else if (names.includes("leave_handoff")) await call("leave_handoff", { body: "再現手順を先に確かめる。境界値は 0 件のとき" });
  else if (names.includes("submit_review")) await call("submit_review", withResolutions(req.prompt, { verdict: "approve", findings: [] }));
};

function setup(flows?: FlowsSpec, units: UnitSpec[] = ALL) {
  const p = new Project(":memory:", new ManualClock());
  p.addRepo(REPO, "API");
  p.saveFormation({ pull: "down", units, ...(flows ? { flows } : {}) });
  const harness = new FakeHarness(script);
  const d = new Dispatcher(p, { harnesses: { "claude-agent-sdk": harness }, workspace: new StaticWorkspace("/tmp/ws", { prNumber: (r) => r.ticketNumber + 9 }) });
  return { p, d, harness };
}

/** 起動した役割を順に並べる。開発より前の確認は「qa*」のように * を付ける。 */
function trail(p: Project, ticketId: number): string[] {
  return all<{ role: string; payload: string }>(
    p.db,
    "SELECT r.role, m.payload FROM runs r JOIN messages m ON m.id = r.message_id WHERE r.ticket_id = ? ORDER BY r.id",
    [ticketId],
  ).map((r) => r.role + ((JSON.parse(r.payload) as { preDev?: boolean }).preDev ? "*" : ""));
}

const mk = (p: Project, kind?: TicketKind) => createTicket(p, { title: "一覧が空のとき落ちる", body: "0 件のとき 500 になる", ...(kind ? { kind } : {}) });

describe("種類ごとの流れで工程を進める(R17)", () => {
  it("流れが無ければ今までどおり 開発 → レビュー → セキュリティ → QA → merge 待ち", async () => {
    const { p, d } = setup();
    const t = mk(p);
    expect(p.ticket(t.id).kind).toBe("feature");
    await d.drain();
    expect(trail(p, t.id)).toEqual(["dev", "review", "sec", "qa"]);
    expect(p.ticket(t.id).stage).toBe("merge");
  });

  it("種類の流れがあればそれ、無ければ既定の流れ", async () => {
    const { p, d } = setup({ default: ["dev", "review", "qa"], refactor: ["dev", "review"] });
    const a = mk(p, "refactor");
    const b = mk(p, "docs");
    await d.drain();
    expect(trail(p, a.id)).toEqual(["dev", "review"]);
    expect(trail(p, b.id)).toEqual(["dev", "review", "qa"]);
  });

  it("開発より前の QA: 受信箱は qa のまま preDev。申し送りを残し、差し戻しも往復も無く、開発のプロンプトに入る", async () => {
    const { p, d, harness } = setup({ bugfix: ["qa", "dev", "review"] });
    const t = mk(p, "bugfix");
    // 作った時点で、最初の工程は QA(開発の仕事はまだ無い)
    expect(p.ticket(t.id).stage).toBe("qa");
    const msgs = all<{ kind: string; to_role: string; payload: string }>(p.db, "SELECT kind, to_role, payload FROM messages WHERE ticket_id = ?", [t.id]);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({ kind: "qa", to_role: "qa" });
    expect(JSON.parse(msgs[0]!.payload)).toEqual({ preDev: true });

    await d.drain();
    expect(trail(p, t.id)).toEqual(["qa*", "dev", "review"]);
    expect(p.ticket(t.id).stage).toBe("merge");
    expect(p.ticket(t.id).rounds).toBe(0);
    expect(get(p.db, "SELECT 1 AS x FROM reviews WHERE role = 'qa'")).toBeUndefined();

    // 申し送りは ticket_notes(kind='handoff')。メモには混ざらない
    const rows = all<{ who: string; kind: string; body: string }>(p.db, "SELECT who, kind, body FROM ticket_notes WHERE ticket_id = ?", [t.id]);
    expect(rows).toEqual([{ who: "qa", kind: "handoff", body: "再現手順を先に確かめる。境界値は 0 件のとき" }]);
    expect(p.notes(t.id)).toEqual([]);

    const [qaCall, devCall] = harness.calls;
    // 確認の道具は申し送りだけ。コードは見ない(組み込みの道具は渡さない)
    expect(qaCall!.tools.map((x) => x.name)).toEqual(["leave_handoff"]);
    expect(qaCall!.allowedTools).toEqual([]);
    expect(qaCall!.prompt).toContain("コードは見ず");
    // 開発は申し送りを読んでから着手する
    expect(devCall!.tools.map((x) => x.name)).toContain("submit_pr");
    expect(devCall!.prompt).toContain("申し送り");
    expect(devCall!.prompt).toContain("再現手順を先に確かめる");
    // 開発より後のレビューは今までどおり差分を確かめる
    expect(harness.calls[2]!.tools.map((x) => x.name)).toEqual(["submit_review"]);
    expect(harness.calls[2]!.prompt).toContain("git diff");

    // やりとりに申し送りが残る
    expect(ticketView(p, t.id).timeline.some((i) => i.type === "handoff" && i.role === "QA")).toBe(true);
  });

  it("開発より前に複数の工程があれば、その順に申し送りを残してから開発へ", async () => {
    const { p, d } = setup({ feature: ["sec", "qa", "dev", "review"] });
    const t = mk(p);
    await d.drain();
    expect(trail(p, t.id)).toEqual(["sec*", "qa*", "dev", "review"]);
    expect(p.handoffs(t.id).map((h) => h.role)).toEqual(["sec", "qa"]);
  });

  it("省略した工程は飛ばす", async () => {
    const { p, d } = setup({ docs: ["dev", "qa"] });
    const t = mk(p, "docs");
    await d.drain();
    expect(trail(p, t.id)).toEqual(["dev", "qa"]);
  });

  it("島が無い工程は飛ばす(開発より前でも)", async () => {
    const { p, d } = setup({ bugfix: ["qa", "dev", "review", "sec"] }, [unit("開発", ["dev"]), unit("レビュー", ["review"])]);
    const t = mk(p, "bugfix");
    expect(p.ticket(t.id).stage).toBe("dev");
    await d.drain();
    expect(trail(p, t.id)).toEqual(["dev", "review"]);
  });

  it("種類を変えると、変えたことがやりとりに残り、今の工程はそのまま次の工程から新しい流れになる", async () => {
    const { p, d } = setup({ bugfix: ["dev"], feature: ["dev", "review", "qa"] });
    const t = mk(p, "feature");
    setTicketKind(p, t.id, "bugfix");
    expect(p.ticket(t.id).stage).toBe("dev");
    const item = ticketView(p, t.id).timeline.find((i) => i.type === "kind_change");
    expect(item).toMatchObject({ from: "機能", to: "バグ修正", who: "あなた" });
    expect(ticketView(p, t.id).kind).toBe("bugfix");
    await d.drain();
    expect(trail(p, t.id)).toEqual(["dev"]);
    expect(() => setTicketKind(p, t.id, "chore")).toThrow("知らないチケットの種類");
  });

  it("開発より前の工程にいるうちに種類を変えて流れで開発より後ろになっても、開発を飛ばさない", async () => {
    const { p, d } = setup({ bugfix: ["qa", "dev"], feature: ["dev", "review", "qa"] });
    const t = mk(p, "bugfix");
    setTicketKind(p, t.id, "feature");
    await d.drain();
    expect(trail(p, t.id)).toEqual(["qa*", "dev", "review", "qa"]);
  });

  it("工程を進むたびに今の版の流れを読む(版を上げたあとの次の工程から変わる)", async () => {
    const { p, d } = setup({ feature: ["dev", "review", "sec", "qa"] });
    const t = mk(p);
    await d.drain(); // 開発のあと、レビューまで進めるのは 1 回ずつ。全部通る
    expect(trail(p, t.id)).toEqual(["dev", "review", "sec", "qa"]);

    const u = mk(p);
    // 開発が終わったところで、版を上げて流れを変える
    let bumped = false;
    const harness = new FakeHarness(async (req, call) => {
      await script(req, call);
      if (!bumped && req.tools.some((x) => x.name === "submit_pr")) {
        bumped = true;
        p.saveFormation({ pull: "down", units: ALL, flows: { feature: ["dev", "qa"] } });
      }
    });
    const d2 = new Dispatcher(p, { harnesses: { "claude-agent-sdk": harness }, workspace: new StaticWorkspace("/tmp/ws", { prNumber: (r) => r.ticketNumber + 9 }) });
    await d2.drain();
    expect(trail(p, u.id)).toEqual(["dev", "qa"]);
    expect(p.currentFormation().version).toBe(3);
  });

  it("編成だけを変えて保存しても、前の版の流れを引き継ぐ。流れを渡せば置き換わる", () => {
    const { p } = setup({ bugfix: ["qa", "dev"] });
    p.saveFormation({ pull: "start", units: ALL });
    expect(p.currentFormation().flows).toEqual({ bugfix: ["qa", "dev"] });
    p.saveFormation({ pull: "start", units: ALL, flows: {} });
    expect(p.currentFormation().flows).toEqual({});
    expect(() => p.saveFormation({ pull: "down", units: ALL, flows: { docs: ["review"] } })).toThrow("開発がありません");
  });

  it("開発を通ったチケットは、種類を変えても開発より前へ戻らない", async () => {
    const { p, d } = setup({ feature: ["dev", "review"], bugfix: ["qa", "dev", "review", "sec"] });
    const t = mk(p, "feature");
    let changed = false;
    const harness = new FakeHarness(async (req, call) => {
      await script(req, call);
      if (!changed && req.tools.some((x) => x.name === "submit_pr")) {
        changed = true;
        setTicketKind(p, t.id, "bugfix");
      }
    });
    const d2 = new Dispatcher(p, { harnesses: { "claude-agent-sdk": harness }, workspace: new StaticWorkspace("/tmp/ws", { prNumber: (r) => r.ticketNumber + 9 }) });
    await d2.drain();
    expect(p.ticket(t.id).dev_done).toBe(1);
    expect(trail(p, t.id)).toEqual(["dev", "review", "sec"]);
    void d;
  });

  it("開発より前の工程を待っている間にその島を外して版を上げても、開発へ進む(開発を飛ばさない)", async () => {
    // 例 1: [qa, dev, review] で QA の島を外す → 今の流れは [dev, review]。merge 待ちに飛ばない
    const a = setup({ bugfix: ["qa", "dev", "review"] });
    const t1 = mk(a.p, "bugfix");
    a.p.saveFormation({ pull: "down", units: [unit("開発", ["dev"]), unit("レビュー", ["review"]), unit("セキュリティ", ["sec"])] });
    await a.d.drain();
    expect(trail(a.p, t1.id)).toEqual(["dev", "review"]);
    expect(a.p.ticket(t1.id).stage).toBe("merge");

    // 例 2: [review, dev, qa] でレビューの島を外す → 開発へ進み、PR が無いのに通常の QA が先に動かない
    const b = setup({ feature: ["review", "dev", "qa"] });
    const t2 = mk(b.p);
    b.p.saveFormation({ pull: "down", units: [unit("開発", ["dev"]), unit("QA", ["qa"])] });
    await b.d.drain();
    expect(trail(b.p, t2.id)).toEqual(["dev", "qa"]);
    expect(b.p.handoffs(t2.id)).toEqual([]);
  });

  it("入れ替えた順の流れで島を外しても、島のある工程を飛ばさない(流れの順で後ろの工程へ進む)", async () => {
    // feature の流れ [dev, qa, review] で、qa を待っている間に QA の島を外して版を上げる → review に進む(merge に行かない)
    const a = setup({ feature: ["dev", "qa", "review"] });
    const t1 = mk(a.p);
    let bumped = false;
    const harness = new FakeHarness(async (req, call) => {
      await script(req, call);
      if (!bumped && req.tools.some((x) => x.name === "submit_pr")) {
        bumped = true;
        a.p.saveFormation({ pull: "down", units: [unit("開発", ["dev"]), unit("レビュー", ["review"]), unit("セキュリティ", ["sec"])] });
      }
    });
    const d1 = new Dispatcher(a.p, { harnesses: { "claude-agent-sdk": harness }, workspace: new StaticWorkspace("/tmp/ws", { prNumber: (r) => r.ticketNumber + 9 }) });
    await d1.drain();
    expect(trail(a.p, t1.id)).toEqual(["dev", "review"]);
    expect(a.p.ticket(t1.id).stage).toBe("merge");

    // 開発より前でも同じ: [sec, qa, dev, review] で sec の島を外す → qa(申し送り)→ 開発 → レビュー
    const b = setup({ feature: ["sec", "qa", "dev", "review"] });
    const t2 = mk(b.p);
    b.p.saveFormation({ pull: "down", units: [unit("開発", ["dev"]), unit("レビュー", ["review"]), unit("QA", ["qa"])] });
    await b.d.drain();
    expect(trail(b.p, t2.id)).toEqual(["qa*", "dev", "review"]);
  });

  it("開発より前の確認も、リーダーの交通整理を待ってから動く", () => {
    const { p } = setup({ bugfix: ["qa", "dev"] });
    const t = mk(p, "bugfix");
    expect(p.db.prepare("SELECT triaged FROM tickets WHERE id = ?").get(t.id)).toEqual({ triaged: 0 });
    expect(claimNext(p, { triage: true })).toBeUndefined();
    p.db.prepare("UPDATE tickets SET triaged = 1 WHERE id = ?").run(t.id);
    expect(claimNext(p, { triage: true })).toMatchObject({ kind: "qa" });
  });

  it("リーダーが create_ticket で 4 種類から 1 つを付ける", () => {
    const { p } = setup({ bugfix: ["qa", "dev"] });
    const create = leadChatTools(p).find((x) => x.name === "create_ticket")!;
    expect(create.handler({ title: "落ちる", body: "直す", kind: "bugfix" } as never)).toMatch(/作りました/);
    const t = p.tickets().at(-1)!;
    expect(t.kind).toBe("bugfix");
    expect(t.stage).toBe("qa");
  });
});
