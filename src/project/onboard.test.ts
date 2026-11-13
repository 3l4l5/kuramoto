import { describe, expect, it } from "vitest";
import { ManualClock } from "../clock.js";
import { all, get } from "../db/sqlite.js";
import { FakeHarness, fixedAll, withResolutions } from "../harness/fake.js";
import type { GitHub } from "../github/github.js";
import { Dispatcher } from "./dispatcher.js";
import { fetchGithubSnapshot, fromExisting, markExisting, snapshotText } from "./onboard.js";
import { planningTools } from "./planning-agent.js";
import { advance, handoff, stageRow, STAGES, setMode, upsertRequirement } from "./planning.js";
import { Project } from "./project.js";
import { StaticWorkspace } from "./workspace.js";

const REPO = "acme/shop";

const gh = {
  prStatus: async () => ({ state: "OPEN", mergeable: "MERGEABLE", ci: "success" }),
  merge: async () => {},
  comment: async () => "",
  openPulls: async () => [{ number: 42, title: "メモの検索", body: "検索欄を足す", head: "feature/search", url: "https://github.com/acme/shop/pull/42", draft: false, author: "a" }],
  openIssues: async (_r: string, label: string | null) => (label === "kuramoto" ? [{ number: 7, title: "保存に失敗したら知らせる", body: "412 のとき", url: "u", labels: ["kuramoto"] }] : []),
} as unknown as GitHub;

async function setup() {
  const p = new Project(":memory:", new ManualClock());
  p.addRepo(REPO, "API");
  await markExisting(p, "kuramoto");
  await fetchGithubSnapshot(p, gh);
  return p;
}

const call = async (p: Project, name: string, args: Record<string, unknown>) => (await planningTools(p, "handoff")).find((t) => t.name === name)!.handler(args as never);

describe("既存のリポジトリの続きから(ADR-0030)", () => {
  it("GitHub の途中の仕事を取ってきて、担当にはリポジトリを読んで現状を起こすよう頼む。画面の試作は既定で省く", async () => {
    const p = await setup();
    expect(fromExisting(p)).toBe(true);
    expect((await stageRow(p, "screen")).mode).toBe("skip");
    expect(snapshotText(p)).toContain("PR #42");
    expect(snapshotText(p)).toContain("Issue #7");
    await advance(p);
    const m = get<{ payload: string }>(p.db, "SELECT payload FROM messages WHERE kind = 'plan' AND to_role = 'planner'")!;
    const text = (JSON.parse(m.payload) as { events: { text: string }[] }).events[0]!.text;
    expect(text).toContain("既存のリポジトリの続きから");
    expect(text).toContain("済: ");
    expect(text).toContain("メモの検索");
    expect(text).toContain("保存に失敗したら知らせる");
  });

  it("チームに渡すとき、開いている PR は確認の工程から引き継ぎ、Issue のチケットの PR には Closes を付ける", async () => {
    const p = await setup();
    await upsertRequirement(p, { name: "検索", acceptance: "語で絞り込める" });
    for (const s of STAGES) if (s !== "req" && (await stageRow(p, s)).mode !== "skip") await setMode(p, s, "skip");
    p.setSetting("plan_started:req", p.now());
    run2(p);
    await handoff(p);
    const hand = get<{ payload: string }>(p.db, "SELECT payload FROM messages WHERE kind = 'plan' AND to_role = 'lead'")!;
    expect(hand.payload).toContain("adopt_pr");

    expect(await call(p, "adopt_pr", { number: 42, requirement: "R1" })).toContain("確認の工程から");
    expect(await call(p, "adopt_pr", { number: 42 })).toContain("もう引き継いで");
    expect(await call(p, "adopt_pr", { number: 99 })).toContain("ありません");
    const adopted = p.tickets().find((t) => t.title === "メモの検索")!;
    // 企画スタジオの引き渡しの表に出しても落ちないよう、ひも付けは空で埋めて渡す
    const { studioView } = await import("./planning.js");
    expect((await studioView(p)).tickets.find((t) => t.number === adopted.number)!.refs).toMatchObject({ adoptedPr: 42, screens: [], design: [], modes: {} });
    expect(adopted.stage).toBe("review");
    expect(get(p.db, "SELECT number, head FROM pull_requests WHERE ticket_id = ?", [adopted.id])).toEqual({ number: 42, head: "feature/search" });

    expect(await call(p, "create_ticket", { title: "保存に失敗したら知らせる", body: "412 のときに知らせる", screens: [], design: [], issue: 7 })).toContain("作りました");
    expect(snapshotText(p)).toContain("チケット済み");
    expect(snapshotText(p)).toContain("引き継ぎ済み");

    // 引き継いだ PR はレビューから、Issue のチケットは実装から。Issue のチケットの PR には Closes が付く
    const harness = new FakeHarness(async (req, c) => {
      if (req.tools.some((t) => t.name === "submit_pr")) await c("submit_pr", { summary: "実装した", responses: fixedAll(req.prompt) });
      else if (req.tools.some((t) => t.name === "submit_review")) await c("submit_review", withResolutions(req.prompt, { verdict: "approve", findings: [] }));
    });
    const ws = new StaticWorkspace("/tmp/ws");
    await new Dispatcher(p, { harnesses: { "claude-agent-sdk": harness }, workspace: ws }).drain();
    expect(harness.calls.find((x) => x.prompt.includes("PR #42"))).toBeTruthy();
    expect(ws.published.find((x) => x.title.includes("保存に失敗"))!.body).toContain("Closes #7");
    expect(p.ticket(adopted.id).stage).toBe("merge");
    expect(all(p.db, "SELECT 1 FROM pull_requests WHERE number = 42")).toHaveLength(1);
  });
});

/** 要件の段階に合意したことにする。 */
function run2(p: Project) {
  p.db.prepare("UPDATE plan_stages SET agreed_version = version WHERE stage = 'req'").run();
}
