import { describe, expect, it } from "vitest";
import { ManualClock } from "../clock.js";
import { run } from "../db/sqlite.js";
import { addDevRule } from "./dev-rules.js";
import { productivity } from "./productivity.js";
import { Project } from "./project.js";
import { createTicket, dropTicket } from "./workflow.js";

const H = 3_600_000;

describe("生産性: 流れとメンバー(ADR-0029)", () => {
  it("時間あたりの merge・入った数と片付いた数・リードタイム・どこから入ったか・仕掛かりを数える", async () => {
    const clock = new ManualClock(new Date("2026-11-12T00:00:00Z"));
    const p = new Project(":memory:", clock);
    p.addRepo("acme/shop", "API");
    const lead = p.fixedMember("lead").id;
    /** 開発の起動を 1 つ足す(started からの長さ ms)。 */
    const devRun = (ticketId: number, ms: number) => {
      const msg = run(p.db, "INSERT INTO messages (ticket_id, to_role, kind, status, available_at, created_at) VALUES (?, 'dev', 'implement', 'done', '', '')", [ticketId]).lastId;
      run(p.db, "INSERT INTO runs (message_id, ticket_id, member_id, role, policy_id, formation_id, started_at, ended_at, cost_usd, outcome) VALUES (?, ?, ?, 'dev', 1, 1, ?, ?, 0.5, 'ok')", [
        msg,
        ticketId,
        lead,
        p.now(),
        new Date(clock.now().getTime() + ms).toISOString(),
      ]);
    };

    const a = await createTicket(p, { title: "A" }); // 手で足した
    const b = await createTicket(p, { title: "B", planRefs: { followupOf: a.number } }); // 確認で見つかった範囲外のこと
    clock.advance(H);
    devRun(a.id, 30 * 60_000);
    clock.advance(H);
    p.event("system", "ready_to_merge", a.id, {});
    clock.advance(H);
    p.event("team", "merged", a.id, {}); // 入ってから 3 時間・取りかかってから 2 時間・merge 待ち 1 時間
    run(p.db, "UPDATE tickets SET stage = 'done', active_ms = ? WHERE id = ?", [30 * 60_000, a.id]);
    const c = await createTicket(p, { title: "C", planRefs: { splitFrom: a.number } });
    await dropTicket(p, c.id, { by: "lead", reason: "いらなくなった" });

    const f = (await productivity(p)).flow;
    expect(f.throughput).toMatchObject({ mergedLast24h: 1, createdLast24h: 3, closedLast24h: 2, netLast24h: 1 });
    expect(f.throughput.activeHours).toBe(1);
    expect(f.throughput.mergedPerActiveHour).toBe(1);
    expect(f.times.leadMs.median).toBe(3 * H);
    expect(f.times.cycleMs.median).toBe(2 * H);
    expect(f.times.mergeWaitMs.median).toBe(H);
    expect(f.flowEfficiency).toBeCloseTo(30 / 180);
    expect(f.firstPassYield).toBe(1);
    expect(f.open).toBe(1);
    expect(f.wip).toEqual([{ key: "todo", label: "未着手", n: 1 }]);
    expect(f.aging.map((x) => x.number)).toEqual([b.number]);
    expect(f.sources.map((s) => [s.label, s.total, s.open])).toEqual(
      expect.arrayContaining([
        ["手で足した(あなた・チャット)", 1, 0],
        ["確認で見つかった範囲外のこと", 1, 1],
        ["大きすぎて切り出した", 1, 0],
      ]),
    );
    // 1 時間ごと: 最後の枠に、merge・切り出し・取りやめが入る。未完了は B だけ
    const last = f.hourly.at(-1)!;
    expect(last).toMatchObject({ merged: 1, created: 1, closed: 2, open: 1 });
    expect(f.hourly.reduce((s, x) => s + x.created, 0)).toBe(3);

    const m = (await productivity(p)).members;
    expect(m.list).toMatchObject([{ runs: 1, costUsd: 0.5, merged: 0 }]);
    expect(m.roles).toMatchObject([{ role: "dev", runs: 1, median: 30 * 60_000, errorRate: 0 }]);
  });
});

describe("生産性: ルール違反(R15)", () => {
  it("合計に加え、チケットごとの違反の数とうち自動で直した数が出る", async () => {
    const p = new Project(":memory:", new ManualClock(new Date("2026-11-12T00:00:00Z")));
    p.addRepo("acme/shop", "API");
    const a = await createTicket(p, { title: "A" });
    const b = await createTicket(p, { title: "B" });
    const fix = addDevRule(p, { template: "jira" });
    const block = addDevRule(p, { template: "migration-alone" });
    const add = (rule: number, ticket: number, handled: string) =>
      run(p.db, "INSERT INTO rule_violations (rule_id, ticket_id, handled, created_at, detail) VALUES (?, ?, ?, ?, '')", [rule, ticket, handled, p.now()]);
    add(fix.id, a.id, "autofixed");
    add(fix.id, a.id, "autofixed");
    add(block.id, a.id, "blocked");

    const v = (await productivity(p));
    expect(v.totals.ruleViolations).toEqual({ total: 3, autofixed: 2 });
    const row = (id: number) => v.tickets.find((t) => t.id === id)!;
    expect(row(a.id)).toMatchObject({ violations: 3, autofixed: 2, reviewed: 0, blocked: 1 });
    expect(row(b.id)).toMatchObject({ violations: 0, autofixed: 0 });
  });
});

describe("生産性: 同期の書き込みの行(project_id は TRIGGER が埋める)", () => {
  it("projectId が 0 でないプロジェクトで、p.event と createTicket が書いた直後の動きも、流れの指標に入る", async () => {
    const clock = new ManualClock(new Date("2026-11-12T00:00:00Z"));
    const p = new Project(":memory:", clock, 7);
    p.addRepo("acme/shop", "API");
    const a = await createTicket(p, { title: "A" });
    clock.advance(H);
    p.event("system", "ready_to_merge", a.id, {});
    clock.advance(H);
    p.event("team", "merged", a.id, {});
    run(p.db, "UPDATE tickets SET stage = 'done', done_at = ? WHERE id = ?", [p.now(), a.id]);
    // 同期の書き込みは project_id を書かないが、開いている間は TEMP TRIGGER がすぐ埋める(0 のまま残らない)
    expect(p.db.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'merged' AND project_id = 7").get()).toEqual({ n: 1 });

    const v = await productivity(p);
    expect(v.flow.mergedTotal).toBe(1);
    expect(v.flow.throughput.mergedLast24h).toBe(1);
    expect(v.flow.times.leadMs.n).toBe(1);
    expect(v.flow.times.mergeWaitMs.n).toBe(1);
    expect(v.totals.completed).toBe(1);
  });
});
