import { describe, expect, it } from "vitest";
import { ManualClock } from "../clock.js";
import { all, get, run } from "../db/sqlite.js";
import { FakeHarness } from "../harness/fake.js";
import { Dispatcher } from "./dispatcher.js";
import { leadMessages } from "./leadchat.js";
import { loopSignals, requestPatrol, setPatrolMinutes, startPatrol } from "./patrol.js";
import { Project } from "./project.js";
import { blockers } from "./triage.js";
import { createTicket, droppedInfo, reopenTicket } from "./workflow.js";
import { StaticWorkspace } from "./workspace.js";

function setup() {
  const clock = new ManualClock();
  const p = new Project(":memory:", clock);
  p.addRepo("acme/shop", "API");
  // 交通整理は済ませておく(見回りだけを見る)
  const make = (title: string, body = "") => {
    const t = createTicket(p, { title, body });
    run(p.db, "UPDATE tickets SET triaged = 1 WHERE id = ?", [t.id]);
    return t;
  };
  return { p, clock, make };
}

/** 終わった起動を 1 つ足す。 */
function addRun(p: Project, ticketId: number, role: string, error: string | null = null): number {
  const msg = run(p.db, "INSERT INTO messages (ticket_id, to_role, kind, status, available_at, created_at) VALUES (?, ?, 'review', 'done', '', '')", [ticketId, role]).lastId;
  const member = p.fixedMember("lead").id;
  return run(
    p.db,
    "INSERT INTO runs (message_id, ticket_id, member_id, role, policy_id, formation_id, started_at, ended_at, outcome, error) VALUES (?, ?, ?, ?, 1, 1, '', '', ?, ?)",
    [msg, ticketId, member, role, error ? "error" : "ok", error],
  ).lastId;
}

/** レビューが差し戻し続けている状態を作る(差し戻し n 回、残っている必須の指摘 1 件)。 */
function pingPong(p: Project, ticketId: number, n: number): number {
  let finding = 0;
  for (let i = 1; i <= n; i++) {
    const runId = addRun(p, ticketId, "review");
    const review = run(p.db, "INSERT INTO reviews (ticket_id, role, round, run_id, verdict, created_at) VALUES (?, 'review', ?, ?, 'changes', '')", [ticketId, i, runId]).lastId;
    if (i === 1)
      finding = run(p.db, "INSERT INTO findings (review_id, category, severity, blocking, body, fingerprint, status) VALUES (?, 'style', 'minor', 1, '変数名を変える', 'x', 'open')", [review]).lastId;
    p.event("review", "changes_requested", ticketId, { round: i });
    addRun(p, ticketId, "dev");
  }
  run(p.db, "UPDATE tickets SET rounds = ?, stage = 'dev', owner_member_id = ? WHERE id = ?", [n, p.fixedMember("lead").id, ticketId]);
  return finding;
}

describe("リーダーの見回り(ADR-0026)", () => {
  it("回っているチケットを数えて見つけ、間隔ごとに 1 回だけ見回りを頼む。見るものが無ければ頼まない", () => {
    const { p, clock, make } = setup();
    const a = make("一覧");
    // 前回の見回りの後に新しいチケットが無く、回っているものも無い
    p.setSetting("patrol_last_ticket", String(a.number));
    expect(requestPatrol(p)).toBe(false); // 初めては、ここから間隔を数え始める
    clock.advance(6 * 60_000);
    expect(requestPatrol(p)).toBe(false);

    pingPong(p, a.id, 4);
    expect(loopSignals(p).map((s) => [s.ticket.number, s.reasons])).toEqual([[a.number, ["差し戻しが 4 回"]]]);
    expect(requestPatrol(p)).toBe(true);
    expect(requestPatrol(p)).toBe(false); // まだ待っている
    run(p.db, "UPDATE messages SET status = 'done' WHERE kind = 'patrol'");
    clock.advance(3 * 60_000);
    expect(requestPatrol(p)).toBe(false); // 間隔(既定 5 分)がまだ
    clock.advance(3 * 60_000);
    expect(requestPatrol(p)).toBe(true);

    // 止めておける
    run(p.db, "UPDATE messages SET status = 'done' WHERE kind = 'patrol'");
    clock.advance(60 * 60_000);
    p.setSetting("patrol_min", "0");
    expect(requestPatrol(p)).toBe(false);
  });

  it("始業したときは、見るものが無くても必ず見回る。間隔は設定で変えられ、0 なら見回らない", () => {
    const { p, clock, make } = setup();
    make("一覧");
    const patrols = () => all(p.db, "SELECT payload FROM messages WHERE kind = 'patrol' AND status = 'pending'");
    expect(startPatrol(p)).toBe(true);
    expect(patrols()).toEqual([{ payload: JSON.stringify({ start: true }) }]);
    expect(startPatrol(p)).toBe(false); // まだ待っている見回りがあれば重ねない
    run(p.db, "UPDATE messages SET status = 'done' WHERE kind = 'patrol'");

    // 間隔を 30 分にすると、回っているものがあっても 30 分経つまで見回らない
    setPatrolMinutes(p, 30);
    p.event("system", "ready_to_merge", p.tickets()[0]!.id, {});
    p.event("system", "ready_to_merge", p.tickets()[0]!.id, {});
    p.event("system", "ready_to_merge", p.tickets()[0]!.id, {});
    clock.advance(10 * 60_000);
    expect(requestPatrol(p)).toBe(false);
    clock.advance(21 * 60_000);
    expect(requestPatrol(p)).toBe(true);
    run(p.db, "UPDATE messages SET status = 'done' WHERE kind = 'patrol'");

    setPatrolMinutes(p, 0);
    expect(startPatrol(p)).toBe(false);
    expect(() => setPatrolMinutes(p, -1)).toThrow();
  });

  it("同じエラーが続いている・merge 待ちから何度も戻っているチケットも見つける", () => {
    const { p, make } = setup();
    const a = make("CI");
    const b = make("保存");
    for (let i = 0; i < 3; i++) addRun(p, a.id, "dev", "npm test が落ちる");
    for (let i = 0; i < 3; i++) p.event("system", "ready_to_merge", b.id, {});
    const s = loopSignals(p);
    expect(s.map((x) => x.ticket.number)).toEqual([a.number, b.number]);
    expect(s[0]!.sameError).toEqual({ count: 3, error: "npm test が落ちる" });
    expect(s[1]!.reasons[0]).toContain("merge 待ちに 3 回");
  });

  it("リーダーが見回りで、往復を止めて通し、取りかかった後の重複を片付けて PR を閉じる。見たものは次から数え直す", async () => {
    const { p, make } = setup();
    p.saveFormation({ pull: "down", units: [{ name: "開発の島", roles: ["dev"], maxMembers: 1, summonAt: 2, idleSec: 600 }, { name: "レビューの島", roles: ["review"], maxMembers: 1, summonAt: 2, idleSec: 600 }] });
    const loop = make("メモ一覧");
    const keep = make("412 のときの文言");
    const dup = make("手で押す保存で 412 が出たときの文言", "自動保存とそろえる");
    const later = make("保存のテスト");
    run(p.db, "INSERT INTO ticket_deps (ticket_id, depends_on) VALUES (?, ?)", [later.id, dup.id]);
    const finding = pingPong(p, loop.id, 4);
    // 重複の方も取りかかっていて、PR がある
    addRun(p, dup.id, "dev");
    run(p.db, "INSERT INTO pull_requests (ticket_id, repo_id, number, head) VALUES (?, ?, 42, 'kuramoto/3')", [dup.id, p.repos()[0]!.id]);
    // 担当の仕事はまだ受信箱にあるが、見回りが先に動くよう、まだ取れない時刻にしておく
    run(p.db, "UPDATE messages SET available_at = '9999' WHERE kind <> 'patrol'");

    p.setSetting("patrol_last_at", "2000-01-01T00:00:00.000Z");
    const ws = new StaticWorkspace("/tmp");
    const harness = new FakeHarness(async (req, call) => {
      if (!req.tools.some((t) => t.name === "pass_as_is")) return {};
      expect(req.prompt).toContain(`### #${loop.number} メモ一覧`);
      expect(req.prompt).toContain("差し戻しが 4 回");
      expect(req.prompt).toContain("変数名を変える");
      expect(await call("pass_as_is", { number: loop.number, reason: "名前の好みで、受け入れ条件には関わらない" })).toContain("次の工程へ");
      expect(await call("drop_duplicate", { number: dup.number, same_as: keep.number })).toContain("片付けました");
      return { finalText: `#${loop.number} の往復を止め、#${dup.number} を #${keep.number} にまとめました。` };
    });
    const d = new Dispatcher(p, { harnesses: { "claude-agent-sdk": harness }, workspace: ws, triage: true, recheckMs: 10 });
    await d.drain({ concurrency: 1, maxRuns: 1 });

    // 往復を止めて、レビューの次(merge 待ち)へ
    expect(p.ticket(loop.id).stage).toBe("merge");
    expect(get<{ status: string }>(p.db, "SELECT status FROM findings WHERE id = ?", [finding])!.status).toBe("wontfix");
    expect(p.notes(loop.id).at(-1)!.body).toContain("往復を止めました");
    // 取りかかった後の重複も片付け、PR を閉じ、待っていたチケットは残す方を待つ
    expect(p.ticket(dup.id).stage).toBe("dropped");
    expect(ws.closed).toMatchObject([{ repo: "acme/shop", number: 42 }]);
    expect(p.notes(keep.id).at(-1)!.body).toContain("自動保存とそろえる");
    expect(blockers(p, later.id)).toEqual([keep.number]);
    expect(all(p.db, "SELECT 1 FROM messages WHERE ticket_id = ? AND status = 'pending'", [dup.id])).toEqual([]);
    // 責任者には報告だけ
    expect(leadMessages(p).at(-1)!.body).toContain("【見回り】");
    // 見たものは数え直すので、続けて見回りを頼まない
    expect(loopSignals(p)).toEqual([]);
  });

  it("起動中・merge 待ちのチケットは片付けない", async () => {
    const { p, make } = setup();
    const { dropDuplicate } = await import("./patrol.js");
    const a = make("A");
    const b = make("B");
    run(p.db, "UPDATE tickets SET stage = 'merge' WHERE id = ?", [a.id]);
    expect(await dropDuplicate(p, a.number, b.number)).toContain("merge 待ち");
    const msg = run(p.db, "INSERT INTO messages (ticket_id, to_role, kind, status, available_at, created_at) VALUES (?, 'dev', 'implement', 'claimed', '', '')", [b.id]).lastId;
    run(p.db, "INSERT INTO runs (message_id, ticket_id, member_id, role, policy_id, formation_id, started_at) VALUES (?, ?, ?, 'dev', 1, 1, '')", [msg, b.id, p.fixedMember("lead").id]);
    expect(await dropDuplicate(p, b.number, a.number)).toContain("今動いています");
  });

  it("リーダーはいらなくなったチケットを取りやめられる。消さずに、誰が・なぜ取りやめたかを残し、待っていたチケットは動き出す", async () => {
    const { p, make } = setup();
    const { dropUnneeded } = await import("./patrol.js");
    const { leadChatTools } = await import("./leadchat.js");
    const a = make("CSV 出力");
    const b = make("CSV のテスト");
    run(p.db, "INSERT INTO ticket_deps (ticket_id, depends_on) VALUES (?, ?)", [b.id, a.id]);
    run(p.db, "INSERT INTO pull_requests (ticket_id, repo_id, number, head) VALUES (?, ?, 7, 'kuramoto/1')", [a.id, p.repos()[0]!.id]);
    const closed: number[] = [];

    // チャットでも使える
    expect(leadChatTools(p).map((t) => t.name)).toContain("drop_ticket");
    expect(await dropUnneeded(p, a.number, "", async () => {})).toContain("理由");
    expect(await dropUnneeded(p, a.number, "責任者がチャットで CSV はいらないと言ったため", async (t) => void closed.push(t.number))).toContain("取りやめました");

    expect(p.ticket(a.id).stage).toBe("dropped");
    expect(droppedInfo(p, a.id)).toMatchObject({ by: "lead", reason: "責任者がチャットで CSV はいらないと言ったため" });
    expect(p.notes(a.id).at(-1)!.body).toContain("【取りやめ】");
    expect(closed).toEqual([a.number]);
    expect(blockers(p, b.id)).toEqual([]); // 待つのをやめる
    expect(all(p.db, "SELECT 1 FROM messages WHERE ticket_id = ? AND status = 'pending'", [a.id])).toEqual([]);
    expect(get<{ type: string }>(p.db, "SELECT type FROM events WHERE ticket_id = ? ORDER BY id DESC LIMIT 1", [a.id])!.type).toBe("ticket_dropped");
    expect(await dropUnneeded(p, a.number, "もう一度")).toContain("もう取りやめ");

    // 責任者が戻せば、取りやめの印は消える
    reopenTicket(p, a.id);
    expect(droppedInfo(p, a.id)).toBeNull();
  });

  it("重複の片付けも、取りやめた理由として残る", async () => {
    const { p, make } = setup();
    const { dropAsDuplicate } = await import("./triage.js");
    const keep = make("412 の文言");
    const dup = make("保存で 412 の文言");
    dropAsDuplicate(p, dup.number, keep.number);
    expect(droppedInfo(p, dup.id)).toMatchObject({ by: "lead", reason: `#${keep.number}「412 の文言」と重複していたため` });
  });
});
