import { describe, expect, it } from "vitest";
import { ManualClock } from "../clock.js";
import { addDevRule, openViolations, openViolationsOf } from "./dev-rules.js";
import { send } from "./inbox.js";
import { Project } from "./project.js";
import { areaWait, areaWaitOf, blockers, blockersOf, mergeBlockers, mergeBlockersOf } from "./triage.js";
import { createTicket, dropTicket, droppedInfo, droppedInfos } from "./workflow.js";

/** ボードがチケットごとに引いていたものを、全部のチケットぶん 1 文で引く版(*Of)。1 枚ずつ引く版と同じ答えになる。 */
describe("ボードのクエリのまとめ引き", () => {
  async function setup() {
    const p = await Project.open(":memory:", new ManualClock(), 3);
    await p.addRepo("acme/shop", "API");
    const [a, b, c, d] = [await createTicket(p, { title: "A" }), await createTicket(p, { title: "B" }), await createTicket(p, { title: "C" }), await createTicket(p, { title: "D" })];
    // B は A と C を待つ。D は A を待つ
    for (const [t, dep] of [[b, a], [b, c], [d, a]] as const) await p.pdb.insert("ticket_deps", { ticket_id: t.id, depends_on: dep.id }).execute();
    await p.setStage(c.id, "merge");
    return { p, ids: [a.id, b.id, c.id, d.id], a, b, c, d };
  }

  it("blockers・mergeBlockers: 1 枚ずつ引いたものと同じ。待つものが無いチケットは入らない", async () => {
    const { p, ids, a, b, d } = await setup();
    const many = await blockersOf(p, ids);
    expect(many.get(b.id)).toEqual([1, 3]);
    expect(many.get(d.id)).toEqual([1]);
    expect(many.has(a.id)).toBe(false);
    for (const id of ids) expect(many.get(id) ?? []).toEqual(await blockers(p, id));
    const merging = await mergeBlockersOf(p, ids);
    expect(merging.get(b.id)).toEqual([3]);
    for (const id of ids) expect(merging.get(id) ?? []).toEqual(await mergeBlockers(p, id));
    expect((await blockersOf(p, [])).size).toBe(0);
  });

  it("areaWait: 同じ場所を触る先行チケットを待つ。開発に取りかかったチケットは待たない", async () => {
    const { p, ids, a, b } = await setup();
    for (const [t, area] of [[a, "src/x"], [b, "src/x"]] as const) await p.pdb.insert("ticket_areas", { ticket_id: t.id, area }).execute();
    // A は開発に取りかかっている(開発の起動がある)
    const m = (await p.activeMembers())[0]!;
    const msg = await send(p, { ticketId: a.id, toRole: "dev", kind: "implement", payload: {} });
    await p.pdb.insert("runs", { ticket_id: a.id, member_id: m.id, role: "dev", message_id: msg, policy_id: (await p.policy("dev")).id, formation_id: (await p.currentFormation()).id, started_at: p.now() } as never).execute();
    const many = await areaWaitOf(p, ids);
    expect(many.get(b.id)).toEqual([{ number: 1, areas: ["src/x"] }]);
    expect(many.has(a.id)).toBe(false);
    for (const id of ids) expect(many.get(id) ?? []).toEqual(await areaWait(p, id));
  });

  it("droppedInfos・openViolationsOf: 取りやめたチケット・止まっているチケットだけが入る", async () => {
    const { p, ids, a, b, c } = await setup();
    await dropTicket(p, b.id, { by: "owner", reason: "いらない" });
    const dropped = await droppedInfos(p, ids);
    expect([...dropped.keys()]).toEqual([b.id]);
    expect(dropped.get(b.id)).toMatchObject({ by: "owner", reason: "いらない" });
    for (const id of ids) expect(dropped.get(id) ?? null).toEqual(await droppedInfo(p, id));

    const rule = await addDevRule(p, { template: "migration-alone" });
    for (const t of [a, c]) await p.pdb.insert("rule_violations", { rule_id: rule.id, ticket_id: t.id, handled: "blocked", created_at: p.now(), detail: "" } as never).execute();
    const viol = await openViolationsOf(p, ids, "blocked");
    expect([...viol.keys()].sort()).toEqual([a.id, c.id].sort());
    for (const id of ids) expect((viol.get(id) ?? []).map((v) => v.id)).toEqual((await openViolations(p, id, "blocked")).map((v) => v.id));
    expect((await openViolationsOf(p, ids, "review")).size).toBe(0);
  });
});
