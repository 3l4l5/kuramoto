import { describe, expect, it } from "vitest";
import { ManualClock } from "../clock.js";
import { send } from "./inbox.js";
import { budgetView, projectExhausted, projectLeftUsd, projectSpentUsd, setProjectBudget, unitSpentMap, unitSpentUsd } from "./budget.js";
import { comment, lastReviewer, threads } from "./review.js";
import { suggestedMergeOrder } from "./merge.js";
import { dropGithubCiTickets, markGithubDown, markGithubUp, githubDown } from "./outage.js";
import { Project } from "./project.js";
import { createTicket } from "./workflow.js";

/**
 * project_id が 0 でない(本部が採番した id を持つ)プロジェクトで、レビュー・merge・チームの CI・予算の読み書きが噛み合う。
 * 同期の書き方(Project.addTicket・setSetting など)で入れた行も、Kysely の読みから見える(project_id を書く側で入れる)。
 */
async function setup() {
  const p = await Project.open(":memory:", new ManualClock(), 7);
  await p.addRepo("acme/shop", "API");
  return p;
}

/** 開発の起動を 1 つ足す(島の名前と額つき)。 */
async function addRun(p: Project, unit: string | null, cost: number): Promise<number> {
  const msg = await send(p, { ticketId: null, toRole: "lead", kind: "chat" });
  const r = await p.pdb
    .insert("runs", { message_id: msg, ticket_id: null, member_id: (await p.fixedMember("lead")).id, role: "lead", policy_id: 1, formation_id: (await p.currentFormation()).id, started_at: p.now(), ended_at: p.now(), cost_usd: cost, outcome: "ok", unit_name: unit })
    .executeTakeFirst();
  return Number(r.insertId);
}

describe("project_id を持つプロジェクトでの読み書き(ADR-0040 B)", () => {
  it("同期で作ったチケットが merge 待ちの並びに出る", async () => {
    const p = await setup();
    const t = await createTicket(p, { title: "A" });
    expect(await suggestedMergeOrder(p)).toEqual([]);
    await p.setStage(t.id, "merge");
    expect((await suggestedMergeOrder(p)).map((x) => x.id)).toEqual([t.id]);
  });

  it("予算: 設定は同期で書いても、消すときに見える。使った額は島ごとに 1 文でまとめて取れる", async () => {
    const p = await setup();
    await addRun(p, "開発A", 0.5);
    await addRun(p, "開発A", 0.25);
    await addRun(p, "開発B", 1);
    await addRun(p, null, 2);
    expect(await projectSpentUsd(p)).toBeCloseTo(3.75);
    expect(await unitSpentUsd(p, "開発A")).toBeCloseTo(0.75);
    const m = await unitSpentMap(p, ["開発A", "開発B", "開発C"]);
    expect([...m]).toEqual([["開発A", 0.75], ["開発B", 1], ["開発C", 0]]);
    expect([...(await unitSpentMap(p, []))]).toEqual([]);

    await setProjectBudget(p, 3.8);
    expect(await projectLeftUsd(p)).toBeCloseTo(0.05);
    expect(await projectExhausted(p)).toBe(true);
    expect(await p.setting("project_budget_notified")).toBeTruthy();
    // 予算を変えると、使い切った知らせを出し直せる(同期で書いた設定を消せる)
    await setProjectBudget(p, null);
    expect(await p.setting("project_budget_usd")).toBeUndefined();
    expect(await p.setting("project_budget_notified")).toBeUndefined();
    expect((await budgetView(p)).project).toMatchObject({ budgetUsd: null, exhausted: false });
  });

  it("レビューのスレッド: 指摘ごとのやりとりを 1 文でまとめて取り、順に並べる", async () => {
    const p = await setup();
    const t = await createTicket(p, { title: "A" });
    const lead = await p.fixedMember("lead");
    const runId = await addRun(p, null, 0);
    const review = await p.pdb.insert("reviews", { ticket_id: t.id, role: "review", round: 1, run_id: runId, verdict: "changes", created_at: p.now() }).executeTakeFirst();
    const ids: number[] = [];
    for (const body of ["一つ目", "二つ目"]) {
      const f = await p.pdb.insert("findings", { review_id: Number(review.insertId), category: "bug", severity: "high", body, fingerprint: body }).executeTakeFirst();
      ids.push(Number(f.insertId));
    }
    await comment(p, ids[0]!, { memberId: lead.id, role: "review" }, "raised", "一つ目");
    await comment(p, ids[0]!, { memberId: null, role: "dev" }, "fixed", "直した");
    await comment(p, ids[1]!, { memberId: null, role: "lead" }, "ruled", "通す");
    const th = await threads(p, t.id);
    expect(th.map((x) => x.comments.map((c) => c.action))).toEqual([["raised", "fixed"], ["ruled"]]);
    expect(th[0]!.comments[1]!.who).toBe("責任者");
    expect(th[1]!.comments[0]!.who).toBe(lead.name);
    expect(await threads(p, t.id, { role: "sec" })).toEqual([]);
    expect(await lastReviewer(p, t.id, "review")).toBe(lead.id);
    expect(await lastReviewer(p, t.id, "qa")).toBeNull();
  });

  it("チームの CI: GitHub Actions の CI のチケットは、project_id を持つプロジェクトでも取りやめられる", async () => {
    const p = await setup();
    const t = await createTicket(p, { title: "main の CI を直す", planRefs: { baseCi: "acme/shop" } });
    await createTicket(p, { title: "別のチケット" });
    expect((await dropGithubCiTickets(p)).map((x) => x.id)).toEqual([t.id]);
    expect((await p.ticket(t.id)).stage).toBe("dropped");
  });

  it("GitHub に入れない知らせと、戻ったときの再開", async () => {
    const p = await setup();
    await markGithubDown(p, "HTTP 401");
    expect(await githubDown(p)).toMatchObject({ error: "HTTP 401" });
    expect(await markGithubUp(p)).toBe(0);
    expect(await githubDown(p)).toBeNull();
  });
});
