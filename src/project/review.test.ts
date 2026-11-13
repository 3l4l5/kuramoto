import { describe, expect, it } from "vitest";
import { ManualClock } from "../clock.js";
import { all, get, run } from "../db/sqlite.js";
import { FakeHarness, mustFindingIds } from "../harness/fake.js";
import { Dispatcher } from "./dispatcher.js";
import { Project } from "./project.js";
import { threads } from "./review.js";
import { ticketView } from "./ticket.js";
import { StaticWorkspace } from "./workspace.js";
import { createTicket } from "./workflow.js";

const REPO = "acme/shop";

function setup(step: ConstructorParameters<typeof FakeHarness>[0]) {
  const p = new Project(":memory:", new ManualClock());
  p.addRepo(REPO, "API");
  // レビューは 2 人(最初に見た人が再レビューも見るかを確かめる)。往復の上限は高くしておく
  p.saveFormation({ pull: "down", units: [{ name: "開発", roles: ["dev"], maxMembers: 1, summonAt: 6, idleSec: 600 }, { name: "レビュー", roles: ["review", "sec"], maxMembers: 2, summonAt: 1, idleSec: 600 }] });
  { const r = p.policy("review"); p.savePolicy("review", { model: r.model, effort: r.effort, focus: r.focus, options: { ...JSON.parse(r.options), escalateAfterRounds: 9 } }); }
  const harness = new FakeHarness(step);
  const d = new Dispatcher(p, { harnesses: { "claude-agent-sdk": harness }, workspace: new StaticWorkspace("/tmp") });
  return { p, d, harness };
}

describe("レビューの往復(実際の PR レビューのモデル)", () => {
  it("必須と提案を分け、開発は必須に返事をし、同じレビュアーが前回の指摘だけを確かめて承認する。提案だけなら差し戻さない", async () => {
    const reviewers: string[] = [];
    const { p, d, harness } = setup(async (req, call) => {
      const names = req.tools.map((t) => t.name);
      if (names.includes("submit_pr")) {
        const ids = mustFindingIds(req.prompt);
        // 返事を漏らすと道具が受け付けない
        if (ids.length) expect(await call("submit_pr", { summary: "" })).toContain("返事がありません");
        await call("submit_pr", { summary: "", responses: ids.map((id) => ({ finding_id: id, action: "fixed", comment: "空配列を返すようにした" })) });
      } else if (names.includes("submit_review") && req.systemPrompt.includes("セキュリティ担当")) {
        await call("submit_review", {});
      } else if (names.includes("submit_review")) {
        reviewers.push(req.prompt.includes("再レビュー") ? "re" : "first");
        if (req.prompt.includes("再レビュー")) {
          const id = Number(req.prompt.match(/- 指摘 (\d+) \[/)![1]);
          expect(req.prompt).toContain("(直した): 空配列を返すようにした");
          expect(req.prompt).not.toContain("変数名"); // 提案は再レビューの対象にしない
          await call("submit_review", { findings: [], resolutions: [{ finding_id: id, result: "resolved" }] });
        } else {
          // 提案だけで差し戻そうとすると断られる
          expect(await call("submit_review", { verdict: "changes", findings: [{ category: "style", severity: "low", body: "変数名" }] })).toContain("提案だけなら承認");
          await call("submit_review", {
            findings: [
              { category: "correctness", severity: "high", basis: "acceptance", path: "a.ts", line: 3, body: "空のとき null を返す" },
              { category: "style", severity: "low", body: "変数名をもう少し具体的に" },
            ],
          });
        }
      }
    });
    const t = createTicket(p, { title: "CSV" });
    await d.drain();
    expect(p.ticket(t.id).stage).toBe("merge");
    expect(reviewers).toEqual(["first", "re"]);
    // 同じレビュアーが再レビューした
    const reviewRuns = all<{ member_id: number }>(p.db, "SELECT r.member_id FROM reviews rv JOIN runs r ON r.id = rv.run_id WHERE rv.role = 'review' ORDER BY rv.id");
    expect(new Set(reviewRuns.map((r) => r.member_id)).size).toBe(1);
    // 直しのプロンプトには必須と提案が分かれて入っている
    const fix = harness.calls.find((c) => c.prompt.includes("## 必須の指摘"))!;
    expect(fix.prompt).toMatch(/## 必須の指摘[\s\S]*空のとき null を返す[\s\S]*## 提案[\s\S]*変数名/);
    // スレッド: 指摘 → 直した → 解決を確認。提案は未対応のまま残る(通すのを妨げない)
    const th = threads(p, t.id);
    expect(th.map((x) => [x.blocking, x.status, x.comments.map((c) => c.action)])).toEqual([
      [true, "fixed", ["raised", "fixed", "resolved"]],
      [false, "open", ["raised"]],
    ]);
    expect((await ticketView(p, t.id)).timeline.filter((x) => x.type === "review").map((x) => (x as { verdict: string }).verdict)).toEqual(["差し戻し", "承認", "承認"]); // レビュー 2 回とセキュリティ 1 回
  });

  it("開発が理由を添えて「直さない」と返し、レビュアーが納得すれば通る。納得しなければリーダーが裁定する", async () => {
    let insist = false;
    const { p, d } = setup(async (req, call) => {
      const names = req.tools.map((t) => t.name);
      if (names.includes("submit_pr")) {
        const ids = mustFindingIds(req.prompt);
        await call("submit_pr", { summary: "", responses: ids.map((id) => ({ finding_id: id, action: "wontfix", comment: "チケットの範囲外。別チケットで扱う" })) });
      } else if (names.includes("submit_review")) {
        const id = req.prompt.match(/- 指摘 (\d+) \[/)?.[1];
        if (!id) await call("submit_review", { findings: [{ category: "design", severity: "medium", basis: "acceptance", body: "キャッシュを入れるべき" }] });
        else await call("submit_review", { resolutions: [{ finding_id: Number(id), result: insist ? "reopen" : "accept", comment: insist ? "遅すぎて使えない" : "了解" }] });
      } else if (names.includes("decide")) {
        expect(req.prompt).toContain("意見が割れています");
        expect(req.prompt).toContain("開発: チケットの範囲外。別チケットで扱う");
        expect(req.prompt).toContain("遅すぎて使えない");
        await call("decide", { choice: 1, reason: "範囲外なので別チケットにする" });
      }
    });
    // 1) レビュアーが納得する
    const a = createTicket(p, { title: "A" });
    await d.drain();
    expect(p.ticket(a.id).stage).toBe("merge");
    expect(threads(p, a.id)[0]).toMatchObject({ status: "wontfix", comments: [{ action: "raised" }, { action: "wontfix" }, { action: "accepted" }] });

    // 2) レビュアーが納得しない → リーダーが「開発の言い分を通す」と裁定 → 次の工程へ
    insist = true;
    const b = createTicket(p, { title: "B" });
    await d.drain();
    expect(get(p.db, "SELECT decided_by, choice FROM decisions WHERE ticket_id = ?", [b.id])).toEqual({ decided_by: "lead", choice: 1 });
    expect(threads(p, b.id)[0]!.comments.map((c) => c.action)).toEqual(["raised", "wontfix", "reopened", "ruled"]);
    expect(p.ticket(b.id).stage).toBe("merge");
  });

  it("後の工程(セキュリティ)で差し戻されたら、直したあとはセキュリティに戻る(レビューの承認は生きる)", async () => {
    const seen: string[] = [];
    const { p, d } = setup(async (req, call) => {
      const names = req.tools.map((t) => t.name);
      if (names.includes("submit_pr")) {
        seen.push("dev");
        await call("submit_pr", { summary: "", responses: mustFindingIds(req.prompt).map((id) => ({ finding_id: id, action: "fixed", comment: "直した" })) });
      } else if (names.includes("submit_review")) {
        const sec = req.systemPrompt.includes("セキュリティ担当");
        seen.push(sec ? "sec" : "review");
        const id = req.prompt.match(/- 指摘 (\d+) \[/)?.[1];
        if (sec && !id) await call("submit_review", { findings: [{ category: "security", severity: "high", basis: "acceptance", body: "SQL を組み立てている" }] });
        else await call("submit_review", { resolutions: id ? [{ finding_id: Number(id), result: "resolved" }] : [] });
      }
    });
    const t = createTicket(p, { title: "検索" });
    await d.drain();
    expect(seen).toEqual(["dev", "review", "sec", "dev", "sec"]);
    expect(p.ticket(t.id).stage).toBe("merge");
  });
});

describe("何を止めるか(受け入れ条件・セキュリティ・この差分の不具合だけ)", () => {
  it("根拠の無い必須の指摘は受け付けない。範囲外の指摘は別チケットとして切り出し、PR は止めない", async () => {
    const { upsertRequirement } = await import("./planning.js");
    const replies: string[] = [];
    let reviewPrompt = "";
    const { p, d } = setup(async (req, call) => {
      const names = req.tools.map((t) => t.name);
      if (names.includes("submit_pr")) {
        await call("submit_pr", { summary: "", responses: mustFindingIds(req.prompt).map((id) => ({ finding_id: id, action: "fixed", comment: "直した" })) });
        return;
      }
      if (!names.includes("submit_review")) return;
      if (req.systemPrompt.includes("セキュリティ担当")) {
        await call("submit_review", {});
        return;
      }
      if (!req.prompt.includes("## チケット #1:")) {
        await call("submit_review", {}); // 切り出されたチケットのレビュー
        return;
      }
      reviewPrompt = req.prompt;
      // 好みの指摘を必須にしようとすると断られる
      replies.push(await call("submit_review", { findings: [{ category: "perf", severity: "high", body: "数千件で重い" }] }));
      replies.push(
        await call("submit_review", {
          findings: [{ category: "perf", severity: "medium", blocking: false, body: "数千件で重い" }],
          followups: [
            { title: "ゴミ箱の画面を作る", body: "入口のリンク先が 404 になる" },
            { title: "検索の結果を並べる", body: "更新順にしてほしい", existing: search.number },
          ],
        }),
      );
    });
    upsertRequirement(p, { name: "一覧", acceptance: "すべてのメモが更新順で表示される" });
    const t = createTicket(p, { title: "一覧の外枠", body: "## 受け入れ条件\n- R1: 一覧が出る" });
    run(p.db, "UPDATE tickets SET triaged = 1 WHERE id = ?", [t.id]);
    // 別に開いているチケット(まだ着手しない)
    const search = createTicket(p, { title: "検索" });
    run(p.db, "UPDATE messages SET status = 'done' WHERE ticket_id = ?", [search.id]);
    await d.drain();

    expect(replies[0]).toContain("必須の指摘には根拠(basis)が要ります");
    expect(replies[1]).toContain("承認");
    expect(reviewPrompt).toContain("R1 一覧: すべてのメモが更新順で表示される");
    expect(reviewPrompt).toContain("merge できるかどうかは見ません");
    // 開いているチケットを見せて、重ならないか確かめさせる
    expect(reviewPrompt).toContain(`#${search.number} 検索`);
    // PR は止まらずに merge 待ちへ。すでにあるチケットに当たるものは、そのチケットのメモになる
    expect(p.ticket(t.id).stage).toBe("merge");
    expect(p.notes(search.id).at(-1)!.body).toContain("検索の結果を並べる");
    // 範囲外の指摘は、merge するまでは別チケットにしない。merge したら、交通整理待ちの新しいチケットになる(1 回だけ)
    expect(p.tickets().find((x) => x.title === "ゴミ箱の画面を作る")).toBeUndefined();
    const { ownerMerge } = await import("./merge.js");
    const gh = { prStatus: async () => ({ state: "OPEN" as const, mergeable: "MERGEABLE" as const, ci: "success" as const }), merge: async () => {}, comment: async () => "" };
    expect(await ownerMerge(p, gh, t.id)).toEqual({ result: "merged" });
    expect(p.tickets().filter((x) => x.title === "ゴミ箱の画面を作る")).toHaveLength(1);
    const followup = p.tickets().find((x) => x.title === "ゴミ箱の画面を作る")!;
    expect(followup.body).toContain(`#${t.number}「一覧の外枠」のレビューで見つかった`);
    expect(get(p.db, "SELECT triaged FROM tickets WHERE id = ?", [followup.id])).toEqual({ triaged: 0 });
  });
});
