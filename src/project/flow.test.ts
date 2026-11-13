import { fixedAll, mustFindingIds, withResolutions } from "../harness/fake.js";
import { describe, expect, it } from "vitest";
import { ManualClock } from "../clock.js";
import { all, get, run } from "../db/sqlite.js";
import { FakeHarness, type FakeStep } from "../harness/fake.js";
import type { GitHub, PrStatus } from "../github/github.js";
import { Dispatcher } from "./dispatcher.js";
import { ownerMerge } from "./merge.js";
import { metrics } from "./metrics.js";
import { Project } from "./project.js";
import { StaticWorkspace } from "./workspace.js";
import { answerDecision, createTicket, expireDecisions, pendingOwnerDecisions, setTicketBudget, ticketBudgetUsd, ticketSpentUsd } from "./workflow.js";

const REPO = "acme/shop";

/** PR の番号は、決めなければ 10・11…(チケットの番号 + 9)にする。push と PR は Kuramoto が作る(ADR-0020)。 */
function setup(script: FakeStep, prNumber: (ticketNumber: number) => number = (n) => n + 9) {
  const clock = new ManualClock();
  const p = new Project(":memory:", clock);
  p.addRepo(REPO, "API");
  const harness = new FakeHarness(script);
  const workspace = new StaticWorkspace("/tmp/ws", { prNumber: (r) => prNumber(r.ticketNumber) });
  const d = new Dispatcher(p, { harnesses: { "claude-agent-sdk": harness }, workspace });
  return { p, clock, harness, d, workspace };
}

/** 開発は PR を出し、レビューは verdicts の順に答える台本。 */
function script(opts: { verdicts?: ("approve" | "changes")[]; lead?: "decide" | "escalate" } = {}): FakeStep {
  const verdicts = [...(opts.verdicts ?? ["approve"])];
  return async (req, call) => {
    const names = req.tools.map((t) => t.name);
    if (names.includes("submit_pr")) {
      await call("submit_pr", { summary: "実装した", responses: fixedAll(req.prompt) });
    } else if (names.includes("submit_review")) {
      const v = verdicts.shift() ?? "approve";
      await call("submit_review", withResolutions(req.prompt, { verdict: v, findings: v === "changes" ? [{ category: "correctness", severity: "high", basis: "acceptance", path: "a.ts", body: "null を返す" }] : [] }));
    } else if (names.includes("decide")) {
      if (opts.lead === "escalate") await call("escalate_to_owner", { reason: "仕様に関わる" });
      else await call("decide", { choice: 0, reason: "直せば済む" });
    }
  };
}

class FakeGitHub implements GitHub {
  merged: number[] = [];
  status = new Map<number, Partial<PrStatus>>();
  async prStatus(_repo: string, number: number): Promise<PrStatus> {
    return { state: "OPEN", mergeable: "MERGEABLE", ci: "success", ...this.status.get(number) };
  }
  async merge(_repo: string, number: number): Promise<void> {
    this.merged.push(number);
  }
  async comment(): Promise<string> {
    return "c1";
  }
}

describe("仕事の流れ", () => {
  it("チケット → 開発 → レビュー → merge 待ち → 責任者が merge", async () => {
    const { p, d, harness } = setup(script());
    const t = await createTicket(p, { title: "CSV の書き出し" });
    await d.drain();

    expect(p.ticket(t.id).stage).toBe("merge");
    expect(p.ticket(t.id).done_at).not.toBeNull();
    expect(harness.calls.map((c) => c.tools.map((x) => x.name)[0])).toEqual(["submit_pr", "submit_review"]);
    // レビューには開発のセッションを渡さない
    expect(harness.calls[1]!.resumeSessionId).toBeUndefined();
    expect(harness.calls[1]!.prompt).toContain("PR #10");
    expect(harness.calls[1]!.prompt).toContain("git diff origin/main...HEAD");

    const gh = new FakeGitHub();
    expect(await ownerMerge(p, gh, t.id)).toEqual({ result: "merged" });
    expect(gh.merged).toEqual([10]);
    expect(p.ticket(t.id).stage).toBe("done");

    const runs = all<{ policy_id: number; formation_id: number }>(p.db, "SELECT policy_id, formation_id FROM runs");
    expect(runs).toHaveLength(2);
    expect(runs.every((r) => r.policy_id > 0 && r.formation_id > 0)).toBe(true);
    expect((await metrics(p)).completed).toBe(1);
  });

  it("確認のやり直しで前の会話を引き継がない設定なら、確認役は新しく始める(開発の直しは引き継ぐ)", async () => {
    const { p, d, harness } = setup(script({ verdicts: ["changes", "approve"] }));
    p.setSetting("resume_checks", "0");
    const t = await createTicket(p, { title: "退会" });
    await d.drain();

    expect(p.ticket(t.id).stage).toBe("merge");
    const [, , fix, recheck] = harness.calls;
    expect(fix!.resumeSessionId).toBe("fake-session-1");
    expect(recheck!.resumeSessionId).toBeUndefined();
    // 前回の指摘は、引き継がなくてもプロンプトで渡る
    expect(recheck!.prompt).toContain("前回の指摘");
  });

  it("差し戻されたら持ち主が自分のセッションを再開して直す", async () => {
    const { p, d, harness } = setup(script({ verdicts: ["changes", "approve"] }));
    const t = await createTicket(p, { title: "退会" });
    await d.drain();

    expect(p.ticket(t.id).stage).toBe("merge");
    expect(p.ticket(t.id).rounds).toBe(1);
    const [impl, , fix] = harness.calls;
    expect(fix!.prompt).toContain("null を返す");
    expect(fix!.resumeSessionId).toBe("fake-session-1");
    expect(impl!.resumeSessionId).toBeUndefined();
    const owner = p.ticket(t.id).owner_member_id;
    const devRuns = all<{ member_id: number }>(p.db, "SELECT member_id FROM runs WHERE role = 'dev'");
    expect(devRuns.every((r) => r.member_id === owner)).toBe(true);
    // 前の周回の指摘は直したことになる
    expect(all(p.db, "SELECT status FROM findings")).toEqual([{ status: "fixed" }]);
  });

  it("同じ指摘がまた出たら再発として数える", async () => {
    const { p, d } = setup(script({ verdicts: ["changes", "changes", "approve"] }));
    p.savePolicy("review", { model: "claude-opus-5-5", effort: "high", focus: "", options: { escalateAfterRounds: 5 } });
    await createTicket(p, { title: "x" });
    await d.drain();
    expect(all(p.db, "SELECT status FROM findings ORDER BY id")).toEqual([{ status: "fixed" }, { status: "fixed" }]);
    expect(get(p.db, "SELECT COUNT(*) AS n FROM findings f WHERE fingerprint IN (SELECT fingerprint FROM findings GROUP BY fingerprint HAVING COUNT(*) > 1)")).toEqual({ n: 2 });
  });
});

describe("判断", () => {
  it("往復が上限に達したらリーダーへ。軽い判断はリーダーが推奨で決めて持ち主に返す", async () => {
    const { p, d } = setup(script({ verdicts: ["changes", "changes", "approve"], lead: "decide" }));
    const t = await createTicket(p, { title: "x" });
    await d.drain();

    const decisions = all<{ decided_by: string; escalated: number }>(p.db, "SELECT decided_by, escalated FROM decisions");
    expect(decisions).toEqual([{ decided_by: "lead", escalated: 0 }]);
    expect(p.ticket(t.id).stage).toBe("merge");
    expect(p.events(100).some((e) => e.type === "decided_by_recommendation")).toBe(true);
  });

  it("ノンストップを切ると、重い判断は責任者に上がり、答えると持ち主に返る", async () => {
    const { p, d } = setup(script({ verdicts: ["changes", "changes", "approve"], lead: "escalate" }));
    p.setSetting("nonstop", "0");
    const t = await createTicket(p, { title: "x" });
    await d.drain();
    expect(p.ticket(t.id).stage).toBe("decision");
    const [card] = await pendingOwnerDecisions(p);
    expect(card).toBeDefined();
    expect(card!.deadline_at).not.toBeNull();

    await answerDecision(p, card!.id, 1); // 今の形で通す
    await d.drain();
    expect(p.ticket(t.id).stage).toBe("merge");
    expect(await ownerMerge(p, new FakeGitHub(), t.id)).toEqual({ result: "merged" });
  });

  it("リーダーが責任者に聞きたいことは判断のカードに載り、責任者が書いた答えは持ち主への指示に入る。残っている指摘の中身も判断に載る", async () => {
    const prompts: string[] = [];
    let reviews = 0;
    const { p, d } = setup(async (req, call) => {
      const names = req.tools.map((t) => t.name);
      prompts.push(req.prompt);
      if (names.includes("submit_pr")) await call("submit_pr", { summary: "", responses: fixedAll(req.prompt) });
      else if (names.includes("submit_review")) {
        // 1 回目は指摘、2 回目は直っていないと差し戻し直す(新しい指摘は無い)
        const first = reviews++ === 0;
        await call(
          "submit_review",
          first
            ? { verdict: "changes", findings: [{ category: "ci", severity: "high", basis: "acceptance", body: "MinIO のイメージが取れない" }] }
            : { verdict: "changes", findings: [], resolutions: mustFindingIds(req.prompt).map((id) => ({ finding_id: id, result: "reopen", comment: "まだ取れない" })) },
        );
      } else if (names.includes("escalate_to_owner")) {
        expect(req.prompt).toContain("MinIO のイメージが取れない");
        await call("escalate_to_owner", { reason: "(1) MySQL の版を決めてください" });
      }
    });
    p.setSetting("nonstop", "0");
    const t = await createTicket(p, { title: "CI" });
    await d.drain();
    const [card] = await pendingOwnerDecisions(p);
    expect(card!.lead_note).toBe("(1) MySQL の版を決めてください");
    expect(card!.impact).toContain("MinIO のイメージが取れない");

    await answerDecision(p, card!.id, 0, "MySQL は 8.4 にする");
    expect(p.notes(t.id).map((n) => n.body)).toContain("MySQL は 8.4 にする");
    await d.drain();
    expect(prompts.find((x) => x.includes("差し戻されました") && x.includes("MySQL は 8.4 にする"))).toBeDefined();
  });

  it("責任者が答えないまま期限を過ぎると推奨で決まり、持ち主に返る", async () => {
    const { p, d, clock } = setup(script({ verdicts: ["changes", "changes"], lead: "escalate" }));
    p.setSetting("nonstop", "0");
    const t = await createTicket(p, { title: "y" });
    await d.drain();
    expect(p.ticket(t.id).stage).toBe("decision");
    clock.advance(3601_000);
    expect(await expireDecisions(p)).toBe(1);
    expect(get(p.db, "SELECT decided_by, choice FROM decisions")).toEqual({ decided_by: "timeout", choice: 0 });
    expect(p.ticket(t.id).stage).toBe("dev");
    // 「指摘を直して続ける」は、指摘のスレッドつきの直しとして持ち主に返る
    expect(get(p.db, "SELECT kind, payload FROM messages WHERE status = 'pending'")).toEqual({ kind: "fix", payload: '{"from":"review"}' });
  });

  it("戻せない判断はリーダーが決めようとしても責任者に上がる", async () => {
    const { p, d } = setup(async (req, call) => {
      const names = req.tools.map((t) => t.name);
      if (names.includes("raise_question")) {
        await call("raise_question", {
          context: "退会",
          question: "退会したユーザーのデータを消しますか?",
          options: ["消す", "残す"],
          recommended: 1,
          why: "戻せないため",
          impact: "消すと戻せない",
          reversible: false,
        });
      } else if (names.includes("decide")) {
        await call("decide", { choice: 0, reason: "消す" });
      }
    });
    const t = await createTicket(p, { title: "退会" });
    await d.drain();
    expect(p.ticket(t.id).stage).toBe("decision");
    expect(await pendingOwnerDecisions(p)).toHaveLength(1);
  });
});

describe("止まる条件", () => {
  it("同じエラーで再試行が尽きたら、リーダーが原因を調べて助言を渡し、止まった仕事をやり直させる", async () => {
    let leadPrompt = "";
    let devPrompts: string[] = [];
    let fixed = false;
    const { p, d, clock } = setup(async (req, call) => {
      const names = req.tools.map((t) => t.name);
      if (names.includes("retry_with_advice")) {
        leadPrompt = req.prompt;
        await call("retry_with_advice", { advice: "テストの前に npm ci を動かす" });
        fixed = true;
        return { finalText: "依存が入っていなかったわ。" };
      }
      if (names.includes("submit_pr")) {
        devPrompts.push(req.prompt);
        if (!fixed) return { status: "error", error: "vitest: command not found" };
        await call("submit_pr", { summary: "直した", responses: fixedAll(req.prompt) });
        return {};
      }
      await call("submit_review", withResolutions(req.prompt, { verdict: "approve", findings: [] }));
      return {};
    });
    const t = await createTicket(p, { title: "x" });
    for (let i = 0; i < 4; i++) {
      await d.drain();
      clock.advance(10 * 60_000);
    }
    // 責任者には上げずに、リーダーが調べて、助言つきでやり直させ、先に進んだ
    expect(leadPrompt).toContain("vitest: command not found");
    expect(p.notes(t.id).map((n) => n.body)).toContain("【手助け】テストの前に npm ci を動かす");
    expect(devPrompts.at(-1)).toContain("テストの前に npm ci を動かす");
    expect(await pendingOwnerDecisions(p)).toEqual([]);
    expect(p.ticket(t.id).stage).toBe("merge");
    expect(p.setting(`unstick_count:${t.id}`)).toBe("0"); // 前に進んだので数え直し
    devPrompts = [];
  });

  it("リーダーが手助けしても同じように止まり続けたら保留する。保留は期限で勝手に再開せず、責任者が再開すると止まった仕事から続ける", async () => {
    let broken = true;
    const { p, d, clock } = setup(async (req, call) => {
      const names = req.tools.map((t) => t.name);
      if (names.includes("retry_with_advice")) {
        await call("retry_with_advice", { advice: "設定を見直す" });
        return {};
      }
      if (names.includes("submit_pr")) {
        if (broken) return { status: "error", error: "DATABASE_URL がありません" };
        await call("submit_pr", { summary: "", responses: fixedAll(req.prompt) });
        return {};
      }
      await call("submit_review", withResolutions(req.prompt, { verdict: "approve", findings: [] }));
      return {};
    });
    p.setSetting("unstick_max", "2");
    const t = await createTicket(p, { title: "x" });
    for (let i = 0; i < 20 && !(await pendingOwnerDecisions(p)).length; i++) {
      await d.drain();
      clock.advance(10 * 60_000);
    }
    const [hold] = await pendingOwnerDecisions(p);
    expect(hold!.question).toContain("リーダーが 2 回手助けしても");
    expect(hold!.question).toContain("DATABASE_URL");
    expect(hold!.deadline_at).toBeNull();
    expect(JSON.parse(hold!.options)).toMatchObject([{ label: "対応したので再開する", action: "resume" }]);
    // 期限で勝手に再開しない。やめもしない
    clock.advance(48 * 3600_000);
    expect(await expireDecisions(p)).toBe(0);
    expect(p.ticket(t.id).stage).toBe("decision");

    broken = false;
    await answerDecision(p, hold!.id, 0);
    await d.drain();
    expect(p.ticket(t.id).stage).toBe("merge");
  });

  it("リーダーが「チームの中では解けない」と判断したら、責任者にしてほしいことを添えて保留する", async () => {
    const { p, d, clock } = setup(async (req, call) => {
      if (req.tools.some((t) => t.name === "hold")) {
        await call("hold", { reason: "CI の秘密情報が無い", owner_action: "リポジトリに NPM_TOKEN を登録してください" });
        return {};
      }
      return { status: "error", error: "401 Unauthorized" };
    });
    const t = await createTicket(p, { title: "x" });
    for (let i = 0; i < 4; i++) {
      await d.drain();
      clock.advance(10 * 60_000);
    }
    const [hold] = await pendingOwnerDecisions(p);
    expect(hold!.question).toContain("CI の秘密情報が無い");
    expect(hold!.impact).toContain("NPM_TOKEN");
    expect(p.ticket(t.id).stage).toBe("decision");
  });

  it("変更がすでに main に入っていたら、開発が確かめて完了にする。main に無いコミットなら断る", async () => {
    const clock = new ManualClock();
    const p = new Project(":memory:", clock);
    p.addRepo(REPO, "API");
    const replies: string[] = [];
    const harness = new FakeHarness(async (req, call) => {
      if (!req.tools.some((t) => t.name === "report_already_done")) return {};
      replies.push(await call("report_already_done", { commit: "deadbeef", reason: "#41 で入っている" }));
      replies.push(await call("report_already_done", { commit: "3677184", reason: "#41 で src/login-limiter.ts が入っていて、受け入れ条件を満たす" }));
      return {};
    });
    const workspace = new StaticWorkspace("/tmp/ws", { landed: (c) => (c === "3677184" ? undefined : `コミット ${c} は origin/main に入っていません`) });
    const d = new Dispatcher(p, { harnesses: { "claude-agent-sdk": harness }, workspace });
    const before = await createTicket(p, { title: "ログインの回数制限" });
    const after = await createTicket(p, { title: "回数制限の画面表示" });
    run(p.db, "INSERT INTO ticket_deps (ticket_id, depends_on) VALUES (?, ?)", [after.id, before.id]);
    // PR が残っていれば閉じる
    run(p.db, "INSERT INTO pull_requests (ticket_id, repo_id, number, head, gh_state) VALUES (?, 1, 77, 'kuramoto/1', 'OPEN')", [before.id]);
    await d.drain({ maxRuns: 1 });

    expect(replies[0]).toContain("入っていません");
    expect(p.ticket(before.id).stage).toBe("done");
    expect(p.notes(before.id).at(-1)!.body).toContain("すでに main に入っていました");
    expect(workspace.closed).toMatchObject([{ number: 77 }]);
    expect(all(p.db, "SELECT 1 FROM messages WHERE kind = 'unstick'")).toEqual([]);
    // 待っていたチケットは動き出せる
    const { blockers } = await import("./triage.js");
    expect(await blockers(p, after.id)).toEqual([]);
  });

  it("詰まったチケットの変更がすでに main に入っていたら、リーダーが確かめて完了にする(保留にしない)", async () => {
    const { p, d, clock } = setup(async (req, call) => {
      if (req.tools.some((t) => t.name === "close_as_already_done")) {
        await call("close_as_already_done", { commit: "3677184", reason: "#41 と重複していた" });
        return { finalText: "重複だったので閉じたわ。" };
      }
      return {};
    });
    const t = await createTicket(p, { title: "x" });
    for (let i = 0; i < 4; i++) {
      await d.drain();
      clock.advance(10 * 60_000);
    }
    expect(p.ticket(t.id).stage).toBe("done");
    expect(await pendingOwnerDecisions(p)).toEqual([]);
    expect(all(p.db, "SELECT 1 FROM messages WHERE ticket_id = ? AND status = 'pending'", [t.id])).toEqual([]);
  });

  it("利用の上限で止まったときは失敗に数えず、時間を置いてやり直す", async () => {
    const { p, d } = setup(() => ({ status: "error", error: "You've hit your 5-hour limit · resets 3am" }));
    await createTicket(p, { title: "x" });
    await d.drain();
    expect(get(p.db, "SELECT status, attempts FROM messages WHERE kind = 'implement'")).toEqual({ status: "pending", attempts: 0 });
    expect(all(p.db, "SELECT 1 FROM messages WHERE kind = 'unstick'")).toEqual([]);
  });

  it("報告の道具を呼ばずに終わったら失敗として再試行する", async () => {
    const { p, d } = setup(() => {});
    await createTicket(p, { title: "x" });
    await d.drain();
    expect(get(p.db, "SELECT status, attempts, last_error FROM messages")).toEqual({ status: "pending", attempts: 1, last_error: "submit_pr が呼ばれませんでした" });
  });

  it("チケットの予算を使い切ったら止めて責任者に聞く。続けると予算が足される", async () => {
    const { p, d } = setup(async (req, call) => {
      if (req.tools.some((t) => t.name === "submit_pr")) await call("submit_pr", { summary: "", responses: fixedAll(req.prompt) });
      else await call("submit_review", withResolutions(req.prompt, { verdict: "changes", findings: [{ category: "c", severity: "medium", basis: "acceptance", body: "直して" }] }));
      return { usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, costUsd: 1 } };
    });
    p.setSetting("ticket_budget_usd", "3");
    p.savePolicy("review", { model: "claude-opus-5-5", effort: "high", focus: "", options: { escalateAfterRounds: 99 } });
    const t = await createTicket(p, { title: "x" });
    await d.drain();
    expect(p.ticket(t.id).stage).toBe("decision");
    expect(get(p.db, "SELECT COUNT(*) AS n FROM runs")).toEqual({ n: 3 });

    await answerDecision(p, (await pendingOwnerDecisions(p))[0]!.id, 0);
    await d.drain();
    expect(get(p.db, "SELECT COUNT(*) AS n FROM runs")).toEqual({ n: 6 });
  });

  it("予算切れの判断には「やめる」を出さず、期限も付けない。「無制限にして続ける」で止まった仕事から再開する", async () => {
    const { p, d, clock } = setup(async (req, call) => {
      if (req.tools.some((t) => t.name === "submit_pr")) await call("submit_pr", { summary: "", responses: fixedAll(req.prompt) });
      else await call("submit_review", withResolutions(req.prompt, { verdict: "approve", findings: [] }));
      return { usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, costUsd: 1 } };
    });
    p.setSetting("ticket_budget_usd", "1");
    const t = await createTicket(p, { title: "x" });
    await d.drain();
    // 実装で 1 ドル使い切り、レビューの前で止まる。同じ判断を重ねて出さない
    await d.drain();
    const cards = await pendingOwnerDecisions(p);
    expect(cards).toHaveLength(1);
    expect(JSON.parse(cards[0]!.options).map((o: { action: string }) => o.action)).toEqual(["continue", "unlimited"]);
    expect(cards[0]!.deadline_at).toBeNull();
    clock.advance(48 * 3600_000);
    expect(await expireDecisions(p)).toBe(0);

    await answerDecision(p, cards[0]!.id, 1);
    expect(ticketBudgetUsd(p, t.id)).toBeNull();
    await d.drain();
    // 止まったのはレビューなので、レビューから続けて merge 待ちまで進む
    expect(all(p.db, "SELECT role FROM runs ORDER BY id")).toEqual([{ role: "dev" }, { role: "review" }]);
    expect(p.ticket(t.id).stage).toBe("merge");
  });

  it("チケット 1 枚の予算の既定を無制限にすると、予算では止まらない", async () => {
    const { setDefaultTicketBudget, defaultTicketBudgetUsd } = await import("./workflow.js");
    const { p, d } = setup(async (req, call) => {
      if (req.tools.some((t) => t.name === "submit_pr")) await call("submit_pr", { summary: "", responses: fixedAll(req.prompt) });
      else await call("submit_review", withResolutions(req.prompt, { verdict: "approve", findings: [] }));
      return { usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, costUsd: 50 } };
    });
    setDefaultTicketBudget(p, null);
    expect(defaultTicketBudgetUsd(p)).toBeNull();
    const t = await createTicket(p, { title: "x" });
    await d.drain();
    expect(ticketBudgetUsd(p, t.id)).toBeNull();
    expect(await pendingOwnerDecisions(p)).toEqual([]);
    expect(p.ticket(t.id).stage).toBe("merge");
  });

  it("チケットごとに予算を決められる。予算切れで止まっていても、使った額より多くすれば続きから動く", async () => {
    const { p, d } = setup(async (req, call) => {
      if (req.tools.some((t) => t.name === "submit_pr")) await call("submit_pr", { summary: "", responses: fixedAll(req.prompt) });
      else await call("submit_review", withResolutions(req.prompt, { verdict: "changes", findings: [{ category: "c", severity: "medium", basis: "acceptance", body: "直して" }] }));
      return { usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, costUsd: 1 } };
    });
    p.setSetting("ticket_budget_usd", "10");
    p.savePolicy("review", { model: "claude-opus-5-5", effort: "high", focus: "", options: { escalateAfterRounds: 99 } });
    const t = await createTicket(p, { title: "x" });
    const other = await createTicket(p, { title: "y" });
    await setTicketBudget(p, t.id, 2);
    expect(ticketBudgetUsd(p, t.id)).toBe(2);
    expect(ticketBudgetUsd(p, other.id)).toBe(10);
    await expect(setTicketBudget(p, t.id, 0)).rejects.toThrow("0 より大きい");

    await d.drain();
    expect(p.ticket(t.id).stage).toBe("decision");
    expect(await ticketSpentUsd(p, t.id)).toBe(2);

    // 使った額以下では止まったまま。上回ると判断が「続ける」で閉じ、足した分なしで新しい予算になる
    await setTicketBudget(p, t.id, 2);
    expect((await pendingOwnerDecisions(p)).filter((x) => x.ticket_id === t.id)).toHaveLength(1);
    await setTicketBudget(p, t.id, 4);
    expect((await pendingOwnerDecisions(p)).filter((x) => x.ticket_id === t.id)).toHaveLength(0);
    expect(ticketBudgetUsd(p, t.id)).toBe(4);
    await d.drain();
    expect(await ticketSpentUsd(p, t.id)).toBe(4);

    // 既定に戻す
    await setTicketBudget(p, t.id, null);
    expect(ticketBudgetUsd(p, t.id)).toBe(10);
  });
});

describe("編成", () => {
  it("開発とレビューを兼ねる島では、自分の PR は別のメンバーが確かめる", async () => {
    const { p, d } = setup(script());
    p.saveFormation({ pull: "down", units: [{ name: "島", roles: ["dev", "review"], maxMembers: 3, summonAt: 2, idleSec: 60 }] });
    const t = await createTicket(p, { title: "x" });
    await d.drain();
    const runs = all<{ role: string; member_id: number }>(p.db, "SELECT role, member_id FROM runs ORDER BY id");
    expect(runs[0]!.member_id).toBe(p.ticket(t.id).owner_member_id);
    expect(runs[1]!.member_id).not.toBe(runs[0]!.member_id);
  });

  it("島のメンバーは最大人数ぶんずっといる。応援は呼ばず、手すきが続いても帰らない。人数を変えると席替えで増減する(ADR-0023)", async () => {
    const { p, d, clock } = setup(script());
    const seats = () => p.currentFormation().units.map((u) => p.membersOfUnit(u.id).length);
    expect(seats()).toEqual([4, 3]); // 既定の編成: 開発 4 人・レビュー 3 人
    const before = p.activeMembers().map((m) => m.id);
    for (const title of ["a", "b", "c"]) await createTicket(p, { title });
    await d.drain({ concurrency: 3 });
    expect(p.events(200).filter((e) => e.type === "summoned")).toHaveLength(0);
    clock.advance(3600_000);
    await d.housekeep();
    expect(p.activeMembers().map((m) => m.id)).toEqual(before);
    expect(seats()).toEqual([4, 3]);
    // 人数を増やすと席が埋まり、減らすと席替えで減る
    p.saveFormation({ pull: "down", units: [{ name: "開発の島", roles: ["dev"], maxMembers: 6, summonAt: 2, idleSec: 300 }, { name: "レビューの島", roles: ["review"], maxMembers: 2, summonAt: 2, idleSec: 300 }] });
    expect(seats()).toEqual([6, 2]);
  });

  it("工程は編成にある役割から組み立てる(セキュリティを足すとレビューの後に入る)", async () => {
    const { p, d, harness } = setup(script());
    p.saveFormation({
      pull: "down",
      units: [
        { name: "開発", roles: ["dev"], maxMembers: 4, summonAt: 2, idleSec: 60 },
        { name: "確認", roles: ["review", "sec"], maxMembers: 3, summonAt: 2, idleSec: 60 },
      ],
    });
    const t = await createTicket(p, { title: "x" });
    await d.drain();
    expect(all(p.db, "SELECT role FROM runs ORDER BY id")).toEqual([{ role: "dev" }, { role: "review" }, { role: "sec" }]);
    expect(p.ticket(t.id).stage).toBe("merge");
    expect(harness.calls[2]!.allowedTools).not.toContain("Edit");
  });

  it("下流優先では、新しい実装より先にレビューを取る", async () => {
    const { p, d } = setup(script());
    await createTicket(p, { title: "a" });
    await d.dispatchOnce(); // a の実装
    await createTicket(p, { title: "b" });
    await d.dispatchOnce();
    expect(all(p.db, "SELECT role FROM runs ORDER BY id")).toEqual([{ role: "dev" }, { role: "review" }]);
  });
});

describe("merge", () => {
  it("押した瞬間に CI が失敗していたら merge せず持ち主に戻す", async () => {
    const { p, d } = setup(script());
    const t = await createTicket(p, { title: "x" });
    await d.drain();
    const gh = new FakeGitHub();
    gh.status.set(10, { ci: "failure" });
    expect(await ownerMerge(p, gh, t.id)).toMatchObject({ result: "blocked" });
    expect(gh.merged).toEqual([]);
    expect(p.ticket(t.id).stage).toBe("dev");
  });

  it("確認が済んだあとに CI の失敗で戻ってきたら、承認のあとの変更だけを 1 回確かめて merge 待ちに戻す(確認を最初からやり直さない)", async () => {
    const { p, d, harness } = setup(script());
    p.saveFormation({ pull: "down", units: [{ name: "開発", roles: ["dev"], maxMembers: 1, summonAt: 2, idleSec: 600 }, { name: "確認", roles: ["review", "sec", "qa"], maxMembers: 1, summonAt: 2, idleSec: 600 }] });
    const t = await createTicket(p, { title: "x" });
    await d.drain();
    expect(p.ticket(t.id).stage).toBe("merge");
    const before = all(p.db, "SELECT role FROM runs").length; // 開発・レビュー・セキュリティ・QA
    expect(before).toBe(4);

    const gh = new FakeGitHub();
    gh.status.set(10, { ci: "failure" });
    await ownerMerge(p, gh, t.id);
    expect(p.ticket(t.id).stage).toBe("dev");
    await d.drain();

    expect(p.ticket(t.id).stage).toBe("merge");
    expect(all(p.db, "SELECT role FROM runs ORDER BY id").slice(before)).toEqual([{ role: "dev" }, { role: "review" }]);
    expect(harness.calls.at(-1)!.prompt).toContain("前に承認されたコミット sha-1");
    // 戻ったあとは CI が通れば merge できる(セキュリティ・QA の承認は前のまま生きている)
    gh.status.set(10, { ci: "success" });
    expect(await ownerMerge(p, gh, t.id)).toEqual({ result: "merged" });
  });

  it("確認が済んだあとに衝突で戻ってきて、main を取り込んだだけなら確認せずに merge 待ちへ", async () => {
    const clock = new ManualClock();
    const p = new Project(":memory:", clock);
    p.addRepo(REPO, "API");
    const harness = new FakeHarness(async (req, call) => {
      if (req.tools.some((x) => x.name === "submit_pr")) await call("submit_pr", { summary: "", responses: fixedAll(req.prompt), ...(req.prompt.includes("衝突") ? { conflict_resolution: "logic" } : {}) });
      else await call("submit_review", withResolutions(req.prompt, { verdict: "approve", findings: [] }));
    });
    const d = new Dispatcher(p, { harnesses: { "claude-agent-sdk": harness }, workspace: new StaticWorkspace("/tmp/ws", { ownCommits: () => 0 }) });
    const t = await createTicket(p, { title: "x" });
    await d.drain();
    const before = all(p.db, "SELECT role FROM runs").length;
    const gh = new FakeGitHub();
    gh.status.set(t.number, { mergeable: "CONFLICTING" });
    await ownerMerge(p, gh, t.id);
    expect(p.ticket(t.id).stage).toBe("dev");
    await d.drain();
    expect(p.ticket(t.id).stage).toBe("merge");
    expect(all(p.db, "SELECT role FROM runs ORDER BY id").slice(before)).toEqual([{ role: "dev" }]);
  });

  it("merge の後、残りの merge 待ちの衝突を確かめ直し、衝突したら持ち主に戻す。機械的に解けたら merge 待ちに直行", async () => {
    const { p, d } = setup(async (req, call) => {
      const names = req.tools.map((t) => t.name);
      if (names.includes("submit_pr")) {
        const conflict = req.prompt.includes("衝突");
        await call("submit_pr", { summary: "", responses: fixedAll(req.prompt), ...(conflict ? { conflict_resolution: "mechanical" } : {}) });
      } else await call("submit_review", withResolutions(req.prompt, { verdict: "approve", findings: [] }));
    }, (n) => n + 19); // a は PR #20、b は PR #21
    const a = await createTicket(p, { title: "a" });
    const b = await createTicket(p, { title: "b" });
    await d.drain();
    expect([p.ticket(a.id).stage, p.ticket(b.id).stage]).toEqual(["merge", "merge"]);

    const gh = new FakeGitHub();
    gh.status.set(21, { mergeable: "CONFLICTING" });
    await ownerMerge(p, gh, a.id);
    expect(p.ticket(b.id).stage).toBe("dev");
    expect(get(p.db, "SELECT cause_pr_id IS NOT NULL AS has_cause FROM conflicts")).toEqual({ has_cause: 1 });

    gh.status.delete(21);
    await d.drain();
    expect(p.ticket(b.id).stage).toBe("merge");
    expect(get(p.db, "SELECT resolution FROM conflicts")).toEqual({ resolution: "mechanical" });
    expect(all(p.db, "SELECT role FROM runs WHERE ticket_id = ? ORDER BY id", [b.id])).toEqual([{ role: "dev" }, { role: "review" }, { role: "dev" }]);
  });
});

describe("受信箱", () => {
  it("1 つのチケットを同時に触る起動は 1 つまで", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { p, d } = setup(async (req, call) => {
      await gate;
      await call("submit_pr", { summary: "", responses: fixedAll(req.prompt) });
    });
    p.savePolicy("dev", { model: "claude-opus-5-5", effort: "high", focus: "" });
    const t = await createTicket(p, { title: "x" });
    const job = (await d.next())!;
    const running = d.execute(job);
    // 起動の行が書かれるまで待つ(書く前に、DB を何度か待つため)
    while (!get(p.db, "SELECT 1 AS x FROM runs")) await new Promise((r) => setTimeout(r, 1));
    // 同じチケットへの別のメッセージがあっても取り出されない
    p.db.prepare("INSERT INTO messages (ticket_id, to_role, kind, available_at, created_at) VALUES (?, 'dev', 'fix', ?, ?)").run(t.id, p.now(), p.now());
    expect(await d.next()).toBeNull();
    release();
    await running;
  });
});

describe("ノンストップ(ADR-0022)", () => {
  it("戻せる判断はリーダーが決め、責任者には上げずに報告だけする。担当への指示はメモになる", async () => {
    const { leadMessages } = await import("./leadchat.js");
    const replies: string[] = [];
    let reviews = 0;
    const { p, d } = setup(async (req, call) => {
      const names = req.tools.map((t) => t.name);
      if (names.includes("submit_pr")) await call("submit_pr", { summary: "", responses: fixedAll(req.prompt) });
      else if (names.includes("submit_review")) {
        if (reviews++ < 2) await call("submit_review", withResolutions(req.prompt, { verdict: "changes", findings: [{ category: "c", severity: "high", basis: "acceptance", body: "版が決まっていない" }] }));
        else await call("submit_review", withResolutions(req.prompt, { findings: [] }));
      } else if (names.includes("escalate_to_owner")) {
        expect(req.systemPrompt).toContain("ノンストップで進めます");
        replies.push(await call("escalate_to_owner", { reason: "版を決めてほしい" }));
        replies.push(await call("decide", { choice: 0, reason: "受け入れ条件から MySQL 8.4 に仮決め", note: "MySQL は 8.4 で進める" }));
      }
    });
    const t = await createTicket(p, { title: "CI" });
    await d.drain();
    expect(replies[0]).toContain("責任者に上げません");
    expect(await pendingOwnerDecisions(p)).toEqual([]);
    expect(p.notes(t.id).map((n) => n.body)).toContain("MySQL は 8.4 で進める");
    expect((await leadMessages(p)).at(-1)!.body).toContain("【#1 の判断】");
    expect(p.ticket(t.id).stage).toBe("merge");
  });

  it("確認が済み CI が緑なら、チームが自動で merge し、待っていた後のチケットが着手できるようになる。CI の途中なら待って確かめ直す", async () => {
    const { autoMerge } = await import("./merge.js");
    const { planWork, blockers } = await import("./triage.js");
    const { p, d, clock } = setup(script());
    const a = await createTicket(p, { title: "土台" });
    const b = await createTicket(p, { title: "画面" });
    await planWork(p, [{ number: 2, after: [1] }]);
    await d.drain();
    expect(p.ticket(a.id).stage).toBe("merge");
    expect(await blockers(p, b.id)).toEqual([1]);

    const gh = new FakeGitHub();
    // このディスパッチャは交通整理をしないので、#2 も merge 待ちまで来ている。#2(PR #11)は CI の途中にしておく
    gh.status.set(10, { ci: "pending" });
    gh.status.set(11, { ci: "pending" });
    expect(await autoMerge(p, gh)).toBe(0);
    gh.status.delete(10);
    expect(await autoMerge(p, gh)).toBe(0); // 間を空けるまでは問い合わせない
    clock.advance(61_000);
    expect(await autoMerge(p, gh)).toBe(1);
    expect(gh.merged).toEqual([10]);
    expect(p.ticket(a.id).stage).toBe("done");
    expect(await blockers(p, b.id)).toEqual([]);
    expect(p.events(50).some((e) => e.type === "merged" && e.actor === "team")).toBe(true);

    // 設定で切ると、責任者が押すまで merge しない
    await d.drain();
    p.setSetting("auto_merge", "0");
    clock.advance(61_000);
    expect(await autoMerge(p, gh)).toBe(0);
    expect(p.ticket(b.id).stage).toBe("merge");
  });

  it("詰まったとき、リーダーは別のメンバーに渡せる。新しい担当がブランチの続きから進める", async () => {
    let stuck = true;
    const { p, d, clock } = setup(async (req, call) => {
      const names = req.tools.map((t) => t.name);
      if (names.includes("reassign")) {
        const other = req.prompt.includes("手毬") ? "ことね" : "手毬";
        expect(await call("reassign", { to: "誰もいない", advice: "x" })).toContain("島のメンバーでも島でもありません");
        await call("reassign", { to: "開発の島", advice: "前の担当は依存の入れ方で詰まっていた" });
        stuck = false;
        return { finalText: other };
      }
      if (names.includes("submit_pr")) {
        if (stuck) return { status: "error", error: "npm ERR! peer dep" };
        await call("submit_pr", { summary: "", responses: fixedAll(req.prompt) });
        return {};
      }
      await call("submit_review", withResolutions(req.prompt, { findings: [] }));
      return {};
    });
    const t = await createTicket(p, { title: "x" });
    for (let i = 0; i < 5; i++) {
      await d.drain();
      clock.advance(10 * 60_000);
    }
    expect(p.notes(t.id).map((n) => n.body)).toContain("【手助け・担当替え】前の担当は依存の入れ方で詰まっていた");
    expect(p.ticket(t.id).stage).toBe("merge");
    expect(await pendingOwnerDecisions(p)).toEqual([]);
  });
});
