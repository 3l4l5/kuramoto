import { describe, expect, it } from "vitest";
import { ManualClock } from "../clock.js";
import { all, get, run } from "../db/sqlite.js";
import { FakeHarness } from "../harness/fake.js";
import { Dispatcher } from "./dispatcher.js";
import { leadMessages } from "./leadchat.js";
import type { GitHub, PrStatus } from "../github/github.js";
import { deadlockSignals, detectDeadlocks, finishPatrol, loopSignals, patrolPrompt, refreshMergedWaits, requestPatrol, setPatrolMinutes, startPatrol } from "./patrol.js";
import { ownerMerge } from "./merge.js";
import { Project } from "./project.js";
import { blockers } from "./triage.js";
import { createTicket, droppedInfo, reopenTicket } from "./workflow.js";
import { StaticWorkspace } from "./workspace.js";

async function setup() {
  const clock = new ManualClock();
  const p = await Project.open(":memory:", clock);
  await p.addRepo("acme/shop", "API");
  // 交通整理は済ませておく(見回りだけを見る)
  const make = async (title: string, body = "") => {
    const t = await createTicket(p, { title, body });
    run(p.db, "UPDATE tickets SET triaged = 1 WHERE id = ?", [t.id]);
    return t;
  };
  return { p, clock, make };
}

/** 終わった起動を 1 つ足す。 */
async function addRun(p: Project, ticketId: number, role: string, error: string | null = null): Promise<number> {
  const msg = run(p.db, "INSERT INTO messages (ticket_id, to_role, kind, status, available_at, created_at) VALUES (?, ?, 'review', 'done', '', '')", [ticketId, role]).lastId;
  const member = (await p.fixedMember("lead")).id;
  return run(
    p.db,
    "INSERT INTO runs (message_id, ticket_id, member_id, role, policy_id, formation_id, started_at, ended_at, outcome, error) VALUES (?, ?, ?, ?, 1, 1, '', '', ?, ?)",
    [msg, ticketId, member, role, error ? "error" : "ok", error],
  ).lastId;
}

/** レビューが差し戻し続けている状態を作る(差し戻し n 回、残っている必須の指摘 1 件)。 */
async function pingPong(p: Project, ticketId: number, n: number): Promise<number> {
  let finding = 0;
  for (let i = 1; i <= n; i++) {
    const runId = await addRun(p, ticketId, "review");
    const review = run(p.db, "INSERT INTO reviews (ticket_id, role, round, run_id, verdict, created_at) VALUES (?, 'review', ?, ?, 'changes', '')", [ticketId, i, runId]).lastId;
    if (i === 1)
      finding = run(p.db, "INSERT INTO findings (review_id, category, severity, blocking, body, fingerprint, status) VALUES (?, 'style', 'minor', 1, '変数名を変える', 'x', 'open')", [review]).lastId;
    await p.event("review", "changes_requested", ticketId, { round: i });
    await addRun(p, ticketId, "dev");
  }
  run(p.db, "UPDATE tickets SET rounds = ?, stage = 'dev', owner_member_id = ? WHERE id = ?", [n, (await p.fixedMember("lead")).id, ticketId]);
  return finding;
}

describe("リーダーの見回り(ADR-0026)", () => {
  it("回っているチケットを数えて見つけ、間隔ごとに 1 回だけ見回りを頼む。見るものが無ければ頼まない", async () => {
    const { p, clock, make } = await setup();
    const a = await make("一覧");
    // 前回の見回りの後に新しいチケットが無く、回っているものも無い
    await p.setSetting("patrol_last_ticket", String(a.number));
    expect(await requestPatrol(p)).toBe(false); // 初めては、ここから間隔を数え始める
    clock.advance(6 * 60_000);
    expect(await requestPatrol(p)).toBe(false);

    await pingPong(p, a.id, 4);
    expect((await loopSignals(p)).map((s) => [s.ticket.number, s.reasons])).toEqual([[a.number, ["差し戻しが 4 回"]]]);
    expect(await requestPatrol(p)).toBe(true);
    expect(await requestPatrol(p)).toBe(false); // まだ待っている
    run(p.db, "UPDATE messages SET status = 'done' WHERE kind = 'patrol'");
    clock.advance(3 * 60_000);
    expect(await requestPatrol(p)).toBe(false); // 間隔(既定 5 分)がまだ
    clock.advance(3 * 60_000);
    expect(await requestPatrol(p)).toBe(true);

    // 止めておける
    run(p.db, "UPDATE messages SET status = 'done' WHERE kind = 'patrol'");
    clock.advance(60 * 60_000);
    await p.setSetting("patrol_min", "0");
    expect(await requestPatrol(p)).toBe(false);
  });

  it("始業したときは、見るものが無くても必ず見回る。間隔は設定で変えられ、0 なら見回らない", async () => {
    const { p, clock, make } = await setup();
    await make("一覧");
    const patrols = () => all(p.db, "SELECT payload FROM messages WHERE kind = 'patrol' AND status = 'pending'");
    expect(await startPatrol(p)).toBe(true);
    expect(patrols()).toEqual([{ payload: JSON.stringify({ start: true }) }]);
    expect(await startPatrol(p)).toBe(false); // まだ待っている見回りがあれば重ねない
    run(p.db, "UPDATE messages SET status = 'done' WHERE kind = 'patrol'");

    // 間隔を 30 分にすると、回っているものがあっても 30 分経つまで見回らない
    await setPatrolMinutes(p, 30);
    await p.event("system", "ready_to_merge", (await p.tickets())[0]!.id, {});
    await p.event("system", "ready_to_merge", (await p.tickets())[0]!.id, {});
    await p.event("system", "ready_to_merge", (await p.tickets())[0]!.id, {});
    clock.advance(10 * 60_000);
    expect(await requestPatrol(p)).toBe(false);
    clock.advance(21 * 60_000);
    expect(await requestPatrol(p)).toBe(true);
    run(p.db, "UPDATE messages SET status = 'done' WHERE kind = 'patrol'");

    await setPatrolMinutes(p, 0);
    expect(await startPatrol(p)).toBe(false);
    await expect(setPatrolMinutes(p, -1)).rejects.toThrow();
  });

  it("同じエラーが続いている・merge 待ちから何度も戻っているチケットも見つける", async () => {
    const { p, make } = await setup();
    const a = await make("CI");
    const b = await make("保存");
    for (let i = 0; i < 3; i++) await addRun(p, a.id, "dev", "npm test が落ちる");
    for (let i = 0; i < 3; i++) await p.event("system", "ready_to_merge", b.id, {});
    const s = await loopSignals(p);
    expect(s.map((x) => x.ticket.number)).toEqual([a.number, b.number]);
    expect(s[0]!.sameError).toEqual({ count: 3, error: "npm test が落ちる" });
    expect(s[1]!.reasons[0]).toContain("merge 待ちに 3 回");
  });

  it("リーダーが見回りで、往復を止めて通し、取りかかった後の重複を片付けて PR を閉じる。見たものは次から数え直す", async () => {
    const { p, make } = await setup();
    await p.saveFormation({ pull: "down", units: [{ name: "開発の島", roles: ["dev"], maxMembers: 1, summonAt: 2, idleSec: 600 }, { name: "レビューの島", roles: ["review"], maxMembers: 1, summonAt: 2, idleSec: 600 }] });
    const loop = await make("メモ一覧");
    const keep = await make("412 のときの文言");
    const dup = await make("手で押す保存で 412 が出たときの文言", "自動保存とそろえる");
    const later = await make("保存のテスト");
    run(p.db, "INSERT INTO ticket_deps (ticket_id, depends_on) VALUES (?, ?)", [later.id, dup.id]);
    const finding = await pingPong(p, loop.id, 4);
    // 重複の方も取りかかっていて、PR がある
    await addRun(p, dup.id, "dev");
    run(p.db, "INSERT INTO pull_requests (ticket_id, repo_id, number, head) VALUES (?, ?, 42, 'kuramoto/3')", [dup.id, (await p.repos())[0]!.id]);
    // 担当の仕事はまだ受信箱にあるが、見回りが先に動くよう、まだ取れない時刻にしておく
    run(p.db, "UPDATE messages SET available_at = '9999' WHERE kind <> 'patrol'");

    await p.setSetting("patrol_last_at", "2000-01-01T00:00:00.000Z");
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
    expect((await p.ticket(loop.id)).stage).toBe("merge");
    expect(get<{ status: string }>(p.db, "SELECT status FROM findings WHERE id = ?", [finding])!.status).toBe("wontfix");
    expect((await p.notes(loop.id)).at(-1)!.body).toContain("往復を止めました");
    // 取りかかった後の重複も片付け、PR を閉じ、待っていたチケットは残す方を待つ
    expect((await p.ticket(dup.id)).stage).toBe("dropped");
    expect(ws.closed).toMatchObject([{ repo: "acme/shop", number: 42 }]);
    expect((await p.notes(keep.id)).at(-1)!.body).toContain("自動保存とそろえる");
    expect(await blockers(p, later.id)).toEqual([keep.number]);
    expect(all(p.db, "SELECT 1 FROM messages WHERE ticket_id = ? AND status = 'pending'", [dup.id])).toEqual([]);
    // 責任者には報告だけ
    expect((await leadMessages(p)).at(-1)!.body).toContain("【見回り】");
    // 見たものは数え直すので、続けて見回りを頼まない
    expect(await loopSignals(p)).toEqual([]);
  });

  it("起動中・merge 待ちのチケットは片付けない", async () => {
    const { p, make } = await setup();
    const { dropDuplicate } = await import("./patrol.js");
    const a = await make("A");
    const b = await make("B");
    run(p.db, "UPDATE tickets SET stage = 'merge' WHERE id = ?", [a.id]);
    expect(await dropDuplicate(p, a.number, b.number)).toContain("merge 待ち");
    const msg = run(p.db, "INSERT INTO messages (ticket_id, to_role, kind, status, available_at, created_at) VALUES (?, 'dev', 'implement', 'claimed', '', '')", [b.id]).lastId;
    run(p.db, "INSERT INTO runs (message_id, ticket_id, member_id, role, policy_id, formation_id, started_at) VALUES (?, ?, ?, 'dev', 1, 1, '')", [msg, b.id, (await p.fixedMember("lead")).id]);
    expect(await dropDuplicate(p, b.number, a.number)).toContain("今動いています");
  });

  it("リーダーはいらなくなったチケットを取りやめられる。消さずに、誰が・なぜ取りやめたかを残し、待っていたチケットは動き出す", async () => {
    const { p, make } = await setup();
    const { dropUnneeded } = await import("./patrol.js");
    const { leadChatTools } = await import("./leadchat.js");
    const a = await make("CSV 出力");
    const b = await make("CSV のテスト");
    run(p.db, "INSERT INTO ticket_deps (ticket_id, depends_on) VALUES (?, ?)", [b.id, a.id]);
    run(p.db, "INSERT INTO pull_requests (ticket_id, repo_id, number, head) VALUES (?, ?, 7, 'kuramoto/1')", [a.id, (await p.repos())[0]!.id]);
    const closed: number[] = [];

    // チャットでも使える
    expect(leadChatTools(p).map((t) => t.name)).toContain("drop_ticket");
    expect(await dropUnneeded(p, a.number, "", async () => {})).toContain("理由");
    expect(await dropUnneeded(p, a.number, "責任者がチャットで CSV はいらないと言ったため", async (t) => void closed.push(t.number))).toContain("取りやめました");

    expect((await p.ticket(a.id)).stage).toBe("dropped");
    expect(await droppedInfo(p, a.id)).toMatchObject({ by: "lead", reason: "責任者がチャットで CSV はいらないと言ったため" });
    expect((await p.notes(a.id)).at(-1)!.body).toContain("【取りやめ】");
    expect(closed).toEqual([a.number]);
    expect(await blockers(p, b.id)).toEqual([]); // 待つのをやめる
    expect(all(p.db, "SELECT 1 FROM messages WHERE ticket_id = ? AND status = 'pending'", [a.id])).toEqual([]);
    expect(get<{ type: string }>(p.db, "SELECT type FROM events WHERE ticket_id = ? ORDER BY id DESC LIMIT 1", [a.id])!.type).toBe("ticket_dropped");
    expect(await dropUnneeded(p, a.number, "もう一度")).toContain("もう取りやめ");

    // 責任者が戻せば、取りやめの印は消える
    await reopenTicket(p, a.id);
    expect(await droppedInfo(p, a.id)).toBeNull();
  });

  it("重複の片付けも、取りやめた理由として残る", async () => {
    const { p, make } = await setup();
    const { dropAsDuplicate } = await import("./triage.js");
    const keep = await make("412 の文言");
    const dup = await make("保存で 412 の文言");
    await dropAsDuplicate(p, dup.number, keep.number);
    expect(await droppedInfo(p, dup.id)).toMatchObject({ by: "lead", reason: `#${keep.number}「412 の文言」と重複していたため` });
  });

  describe("デッドロック(待ちが解けずに止まっている)", () => {
    const wait = (p: Project, id: number, on: number) => run(p.db, "INSERT INTO ticket_deps (ticket_id, depends_on) VALUES (?, ?)", [id, on]);
    const setStage = (p: Project, id: number, stage: string) => run(p.db, "UPDATE tickets SET stage = ? WHERE id = ?", [stage, id]);
    const addPr = async (p: Project, ticketId: number, number: number, state: string | null) =>
      run(p.db, "INSERT INTO pull_requests (ticket_id, repo_id, number, head, gh_state) VALUES (?, ?, ?, ?, ?)", [ticketId, (await p.repos())[0]!.id, number, `kuramoto/${number}`, state]);
    const kinds = async (p: Project) => (await detectDeadlocks(p)).map((d) => [d.kind, d.tickets]);

    it("待ちの循環(A→B→A・長い輪・自分を待つもの)を見つけ、輪の中の道すじを理由に出す。輪の外は含めない", async () => {
      const { p, make } = await setup();
      const [a, b, c, d, e, f] = [await make("A"), await make("B"), await make("C"), await make("D"), await make("E"), await make("F")];
      wait(p, a.id, b.id);
      wait(p, b.id, a.id); // 2 枚の輪
      wait(p, c.id, d.id);
      wait(p, d.id, e.id);
      wait(p, e.id, c.id); // 3 枚の輪
      wait(p, f.id, a.id); // 輪を待っているだけ(輪ではない)
      const found = (await detectDeadlocks(p)).filter((x) => x.kind === "cycle");
      expect(found.map((x) => x.tickets)).toEqual([[a.number, b.number], [c.number, d.number, e.number]]);
      expect(found[0]!.reason).toContain(`#${a.number} → #${b.number} → #${a.number}`);
      expect(found[1]!.reason).toContain(`#${c.number} → #${d.number} → #${e.number} → #${c.number}`);
      // 輪の中の待ちが merge されれば、輪ではなくなる
      setStage(p, b.id, "done");
      expect((await detectDeadlocks(p)).filter((x) => x.kind === "cycle").map((x) => x.tickets)).toEqual([[c.number, d.number, e.number]]);
    });

    it("待ち先の PR が merge 済みなのにボードで done でないものを見つける(#44 が merge のまま、#45・#57 が待っていた形)", async () => {
      const { p, make } = await setup();
      const base = await make("DB の非同期化");
      const next = await make("プロンプトの非同期化");
      const later = await make("見回り");
      setStage(p, base.id, "merge");
      await addPr(p, base.id, 54, "MERGED");
      wait(p, next.id, base.id);
      wait(p, later.id, base.id);
      wait(p, later.id, next.id);
      const found = (await detectDeadlocks(p)).filter((x) => x.kind === "merged-wait");
      expect(found.map((x) => [x.key, x.tickets])).toEqual([[`merged-wait:${base.number}`, [base.number, next.number, later.number]]]);
      expect(found[0]!.reason).toContain(`#${base.number} は PR(#54)が merge 済みなのに`);
      expect(found[0]!.reason).toContain("merge 待ち");
      // 開いたままの PR(まだ merge されていない)や、待つ人のいない merge 済みは、デッドロックではない
      const open = await make("別の土台");
      const waiter = await make("別の続き");
      setStage(p, open.id, "merge");
      await addPr(p, open.id, 60, "OPEN");
      wait(p, waiter.id, open.id);
      const lone = await make("待たれていない");
      setStage(p, lone.id, "merge");
      await addPr(p, lone.id, 61, "MERGED");
      expect((await detectDeadlocks(p)).filter((x) => x.kind === "merged-wait")).toHaveLength(1);
    });

    it("外で merge された PR は、merge の確認で done になり、待っていたチケットが解ける(merge 済みなのに done にならない原因の修正)", async () => {
      const { p, make } = await setup();
      const base = await make("土台");
      const next = await make("続き");
      setStage(p, base.id, "merge");
      await addPr(p, base.id, 54, null);
      wait(p, next.id, base.id);
      const gh: GitHub = {
        prStatus: async (): Promise<PrStatus> => ({ state: "MERGED", mergeable: "UNKNOWN", ci: "none" }),
        merge: async () => {
          throw new Error("もう merge 済みなので、merge は呼ばない");
        },
        comment: async () => "c",
      };
      expect(await ownerMerge(p, gh, base.id, "team")).toEqual({ result: "merged" });
      expect((await p.ticket(base.id)).stage).toBe("done");
      expect(await blockers(p, next.id)).toEqual([]);
      expect(await detectDeadlocks(p)).toEqual([]);
    });

    it("見回りで、待たれている merge 待ちの PR を取り直し、外で merge 済みなら done にする(自動 merge を切って、GitHub から直接 merge した形)", async () => {
      const { p, clock, make } = await setup();
      await p.setSetting("auto_merge", "0");
      const base = await make("土台");
      const next = await make("続き");
      const lone = await make("待たれていない");
      setStage(p, base.id, "merge");
      setStage(p, lone.id, "merge");
      await addPr(p, base.id, 54, "OPEN");
      await addPr(p, lone.id, 55, "OPEN");
      wait(p, next.id, base.id);
      const asked: number[] = [];
      let state: PrStatus["state"] = "OPEN";
      const gh: GitHub = {
        prStatus: async (_repo, n): Promise<PrStatus> => (asked.push(n), { state: n === 54 ? state : "MERGED", mergeable: "UNKNOWN", ci: "none" }),
        merge: async () => {
          throw new Error("merge は呼ばない");
        },
        comment: async () => "c",
      };
      // まだ OPEN: 何も変えない。待たれていない lone は問い合わせない
      expect(await refreshMergedWaits(p, gh)).toBe(0);
      expect(asked).toEqual([54]);
      expect((await p.ticket(base.id)).stage).toBe("merge");
      // 見回りの間隔の間は、もう問い合わせない
      state = "MERGED";
      expect(await refreshMergedWaits(p, gh)).toBe(0);
      expect(asked).toEqual([54]);
      // 間隔が過ぎて、外で merge されていたら done にし、待っていたチケットが解ける
      clock.advance(5 * 60_000);
      expect(await refreshMergedWaits(p, gh)).toBe(1);
      expect((await p.ticket(base.id)).stage).toBe("done");
      expect((await p.ticket(lone.id)).stage).toBe("merge");
      expect(await blockers(p, next.id)).toEqual([]);
      expect(await detectDeadlocks(p)).toEqual([]);
    });

    it("見回りの PR の取り直しは、GitHub に入れない間は何もせず、問い合わせの失敗では止まらない・見回りを止めていれば動かない", async () => {
      const { p, clock, make } = await setup();
      const base = await make("土台");
      const next = await make("続き");
      setStage(p, base.id, "merge");
      await addPr(p, base.id, 54, "OPEN");
      wait(p, next.id, base.id);
      let calls = 0;
      let fail = false;
      const gh: GitHub = {
        prStatus: async (): Promise<PrStatus> => {
          calls++;
          if (fail) throw new Error("network timeout");
          return { state: "MERGED", mergeable: "UNKNOWN", ci: "none" };
        },
        merge: async () => "m",
        comment: async () => "c",
      } as unknown as GitHub;
      await p.setSetting("github_down", JSON.stringify({ since: "", error: "x", checkedAt: "" }));
      expect(await refreshMergedWaits(p, gh)).toBe(0);
      expect(calls).toBe(0);
      await p.setSetting("github_down", "");
      await setPatrolMinutes(p, 0);
      expect(await refreshMergedWaits(p, gh)).toBe(0);
      expect(calls).toBe(0);
      await setPatrolMinutes(p, 5);
      fail = true;
      expect(await refreshMergedWaits(p, gh)).toBe(0);
      expect((await p.ticket(base.id)).stage).toBe("merge");
      fail = false;
      clock.advance(5 * 60_000);
      expect(await refreshMergedWaits(p, gh)).toBe(1);
      expect((await p.ticket(base.id)).stage).toBe("done");
    });

    it("待ち先が取りやめなのに待ちが残っているものを見つける", async () => {
      const { p, make } = await setup();
      const gone = await make("やめた土台");
      const stuck = await make("続き");
      const fine = await make("別の続き");
      const ok = await make("終わった土台");
      wait(p, stuck.id, gone.id);
      wait(p, fine.id, ok.id);
      setStage(p, gone.id, "dropped"); // dropTicket を通さず、待ちが残った形
      setStage(p, ok.id, "done");
      const found = (await detectDeadlocks(p)).filter((x) => x.kind === "dropped-wait");
      expect(found.map((x) => [x.key, x.tickets])).toEqual([[`dropped-wait:${stuck.number}`, [stuck.number]]]);
      expect(found[0]!.reason).toContain(`#${gone.number}`);
    });

    it("手すきの席があるのに、取りかかれるはずの先頭が一定時間取られていないものを見つける(待っているものも道連れに数える)", async () => {
      const { p, clock, make } = await setup();
      await p.saveFormation({ pull: "down", units: [{ name: "開発の島", roles: ["dev"], maxMembers: 2, summonAt: 2, idleSec: 600 }] });
      const head = await make("先頭");
      const behind = await make("後ろ");
      const behind2 = await make("その後ろ");
      wait(p, behind.id, head.id);
      wait(p, behind2.id, behind.id);
      expect(await detectDeadlocks(p)).toEqual([]); // さっき入ったばかり
      clock.advance(9 * 60_000);
      expect(await detectDeadlocks(p)).toEqual([]); // まだ一定時間(既定 10 分)に満たない
      clock.advance(2 * 60_000);
      const found = await detectDeadlocks(p);
      expect(found.map((x) => [x.kind, x.tickets])).toEqual([["idle-head", [head.number, behind.number, behind2.number]]]);
      expect(found[0]!.reason).toContain("誰にも取られていません");
      expect(found[0]!.reason).toContain(`#${behind.number}`);

      // 待ち先が merge されたときから数え直す(merge の直後は、普通に取られるのを待つ)
      setStage(p, head.id, "done");
      await p.event("system", "merged", head.id, {});
      expect((await detectDeadlocks(p)).map((x) => x.tickets)).toEqual([]);
      clock.advance(11 * 60_000);
      expect((await detectDeadlocks(p)).map((x) => [x.kind, x.tickets])).toEqual([["idle-head", [behind.number, behind2.number]]]);
    });

    it("席が埋まっている・責任者の対応待ち・取りかかる前の交通整理待ちは、取られていなくてもデッドロックではない", async () => {
      const { p, clock, make } = await setup();
      await p.saveFormation({ pull: "down", units: [{ name: "開発の島", roles: ["dev"], maxMembers: 1, summonAt: 2, idleSec: 600 }] });
      const busy = await make("動いているもの");
      const free = await make("取られていないもの");
      // 開発の島の 1 人は、別のチケットで動いている
      const member = (await p.membersOfUnit((await p.currentFormation()).units[0]!.id))[0]!;
      const msg = run(p.db, "INSERT INTO messages (ticket_id, to_role, kind, status, available_at, created_at) VALUES (?, 'dev', 'implement', 'claimed', '', '')", [busy.id]).lastId;
      run(p.db, "INSERT INTO runs (message_id, ticket_id, member_id, role, policy_id, formation_id, started_at) VALUES (?, ?, ?, 'dev', 1, 1, '')", [msg, busy.id, member.id]);
      run(p.db, "UPDATE messages SET status = 'done' WHERE ticket_id = ? AND id <> ?", [busy.id, msg]);
      clock.advance(30 * 60_000);
      expect(await detectDeadlocks(p)).toEqual([]);

      // 席が空けば、止まっている
      run(p.db, "UPDATE runs SET ended_at = '' WHERE ticket_id = ?", [busy.id]);
      run(p.db, "UPDATE messages SET status = 'done' WHERE ticket_id = ?", [busy.id]);
      expect((await detectDeadlocks(p)).map((x) => x.tickets)).toEqual([[free.number]]);
      // 交通整理がまだなら、交通整理が先に見る
      run(p.db, "UPDATE tickets SET triaged = 0 WHERE id = ?", [free.id]);
      expect(await detectDeadlocks(p)).toEqual([]);
    });

    it("見せたデッドロックは覚え、続いていても見せない。止まりが解ければ忘れ、間隔が過ぎれば見せ直す", async () => {
      const { p, clock, make } = await setup();
      const a = await make("A");
      const b = await make("B");
      wait(p, a.id, b.id);
      wait(p, b.id, a.id);
      expect(await requestPatrol(p)).toBe(false); // 初めては、ここから間隔を数え始める
      clock.advance(6 * 60_000);
      await p.setSetting("patrol_last_ticket", String(b.number));
      const shown = await deadlockSignals(p);
      expect(shown).toHaveLength(1);
      expect(await requestPatrol(p)).toBe(true); // デッドロックだけでも、リーダーを起こす
      run(p.db, "UPDATE messages SET status = 'done' WHERE kind = 'patrol'");

      await finishPatrol(p, [], shown);
      expect(await deadlockSignals(p)).toEqual([]);
      clock.advance(6 * 60_000);
      expect(await requestPatrol(p)).toBe(false); // 続いていても、見せたものでは起こさない
      // 見せ直す間隔(既定 60 分)が過ぎたら、もう一度見せる
      clock.advance(60 * 60_000);
      expect(await deadlockSignals(p)).toHaveLength(1);
      await p.setSetting("patrol_deadlock_recheck_min", "0");
      expect(await deadlockSignals(p)).toEqual([]); // 0 なら見せ直さない

      // 解けたら忘れ、また同じ止まりが起きたら新しく見せる
      run(p.db, "DELETE FROM ticket_deps");
      await finishPatrol(p, [], []);
      expect(await p.setting("patrol_deadlock_seen")).toBe("{}");
      wait(p, a.id, b.id);
      wait(p, b.id, a.id);
      expect(await deadlockSignals(p)).toHaveLength(1);
    });

    it("見回りのプロンプトに、デッドロックの節と、原因・解消の手順(plan_work と create_ticket の使い分け)が出る", async () => {
      const { p, make } = await setup();
      const a = await make("A");
      const b = await make("B");
      wait(p, a.id, b.id);
      wait(p, b.id, a.id);
      const none = await patrolPrompt(p, [], { deadlocks: [] });
      expect(none).toContain("## デッドロック");
      expect(none).toMatch(/## デッドロック[^\n]*\n\(なし\)/);
      const prompt = await patrolPrompt(p, [], { deadlocks: await detectDeadlocks(p) });
      expect(prompt).toMatch(/## デッドロック[^\n]*\n- \[待ちの循環\] 待ちが輪になっていて/);
      expect(prompt).toContain(`#${a.number} → #${b.number} → #${a.number}`);
      expect(prompt).toContain("plan_work で直します");
      expect(prompt).toContain("create_ticket で「解消するチケット」");
      expect(prompt).toContain("既にあれば、作りません");
    });

    it("リーダーが見回りの中で、plan_work で循環を切り、create_ticket で解消のチケットを作る。2 回目の見回りでは重ねて作らない", async () => {
      const { p, clock, make } = await setup();
      const a = await make("A");
      const b = await make("B");
      const base = await make("土台");
      const waiter = await make("続き");
      wait(p, a.id, b.id);
      wait(p, b.id, a.id);
      setStage(p, base.id, "merge");
      await addPr(p, base.id, 54, "MERGED");
      wait(p, waiter.id, base.id);
      run(p.db, "UPDATE messages SET available_at = '9999' WHERE kind <> 'patrol'");
      await p.setSetting("patrol_last_at", "2000-01-01T00:00:00.000Z");
      await p.setSetting("patrol_last_ticket", String(waiter.number));

      const prompts: string[] = [];
      const harness = new FakeHarness(async (req, call) => {
        if (!req.tools.some((t) => t.name === "pass_as_is")) return {};
        prompts.push(req.prompt);
        expect(req.tools.map((t) => t.name)).toEqual(expect.arrayContaining(["plan_work", "create_ticket"]));
        if (prompts.length === 1) {
          expect(await call("plan_work", { items: [{ number: a.number, after: [] }] })).toContain("決めました");
          expect(await call("create_ticket", { title: "merge 済みなのに done にならない", body: `#${base.number} が止まっている`, kind: "bugfix" })).toContain("作りました");
        }
        return { finalText: "デッドロックを 2 件見つけ、1 件は待ちを付け直し、1 件は解消のチケットを作りました。" };
      });
      const run1 = async () => {
        const d = new Dispatcher(p, { harnesses: { "claude-agent-sdk": harness }, workspace: new StaticWorkspace("/tmp"), triage: true, recheckMs: 10 });
        await d.drain({ concurrency: 1, maxRuns: 1 });
      };
      await run1();

      expect(prompts[0]).toContain(`[待ちの循環] 待ちが輪になっていて`);
      expect(prompts[0]).toContain(`[merge 済みなのに done でない待ち先] #${base.number}`);
      expect(await blockers(p, a.id)).toEqual([]); // 循環は plan_work で切った
      expect((await p.tickets()).filter((t) => t.title.includes("done にならない"))).toHaveLength(1);
      expect((await leadMessages(p)).at(-1)!.body).toContain("デッドロックを 2 件");

      // 切った循環は消え、merge 済み待ちは続いているが見せ済み: 次の見回りでは起こさず、起こしても重ねて作らない
      clock.advance(6 * 60_000);
      await p.setSetting("patrol_last_ticket", String(Math.max(...(await p.tickets()).map((t) => t.number))));
      expect(await detectDeadlocks(p)).toHaveLength(1);
      expect(await deadlockSignals(p)).toEqual([]);
      expect(await requestPatrol(p)).toBe(false);
      expect((await p.tickets()).filter((t) => t.title.includes("done にならない"))).toHaveLength(1);
    });
  });
});
