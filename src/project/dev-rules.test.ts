import { describe, expect, it } from "vitest";
import { ManualClock } from "../clock.js";
import { all, run } from "../db/sqlite.js";
import { fixedAll, FakeHarness, withResolutions, type FakeStep } from "../harness/fake.js";
import { addDevRule, checkRules, devRulesView, setDevRuleEnabled, TEMPLATES, type RuleSubject } from "./dev-rules.js";
import { Dispatcher } from "./dispatcher.js";
import { productivity } from "./productivity.js";
import { Project } from "./project.js";
import { ticketView } from "./ticket.js";
import { StaticWorkspace } from "./workspace.js";
import { createTicket } from "./workflow.js";

const subject = (s: Partial<RuleSubject> = {}): RuleSubject => ({ branch: "SHOP-1/csv", title: "SHOP-1 CSV", body: "対象: 書き出し\nなぜ…", commits: ["SHOP-1 書き出し"], files: ["src/csv.ts"], code: "", ...s });
const projectWith = () => {
  const p = new Project(":memory:", new ManualClock());
  p.addRepo("acme/shop", "API");
  return p;
};
const template = (p: Project, key: string) => addDevRule(p, { template: key });

describe("開発ルール: 一覧・追加・有効 / 無効", () => {
  it("ひな形 4 つから足せる。足したものは 2 度目を断り、一覧では足した印が付く", () => {
    const p = projectWith();
    expect(TEMPLATES.map((t) => t.name)).toEqual(["Jira 番号をそろえる", "PR 本文の先頭に対象", "マイグレーションは単独の PR", "コミット 1 行目 50 字以内"]);
    const r = template(p, "jira");
    expect(r).toMatchObject({ name: "Jira 番号をそろえる", appliesTo: ["branch", "pr_title", "commit"], check: "pattern", onFail: "autofix", enabled: true, template: "jira" });
    expect(() => template(p, "jira")).toThrow("もう足してあります");
    const v = devRulesView(p);
    expect(v.rules).toHaveLength(1);
    expect(v.templates.map((t) => [t.key, t.added])).toEqual([["jira", true], ["pr-body-target", false], ["migration-alone", false], ["commit-50", false]]);
  });

  it("名前・何を守るか・どこに効くか・確かめ方・違反時の扱いを決めて足せる。足りない・読めない入力は断る", () => {
    const p = projectWith();
    const r = addDevRule(p, { name: "console.log を残さない", body: "デバッグ出力を残さない", appliesTo: ["code"], check: "pattern", pattern: "!console\\.log", onFail: "review" });
    expect(r).toMatchObject({ appliesTo: ["code"], pattern: "!console\\.log", onFail: "review", template: null });
    const ai = addDevRule(p, { name: "テストの名前が読める", body: "テストの名前が何を確かめるか分かる", appliesTo: ["code", "files"], check: "ai", onFail: "review" });
    expect(ai.pattern).toBeNull();
    expect(() => addDevRule(p, { name: "", body: "x", appliesTo: ["code"], check: "pattern", pattern: "x", onFail: "review" })).toThrow("名前");
    expect(() => addDevRule(p, { name: "a", body: "x", appliesTo: [], check: "pattern", pattern: "x", onFail: "review" })).toThrow("どこに効くか");
    expect(() => addDevRule(p, { name: "a", body: "x", appliesTo: ["code"], check: "pattern", pattern: "(", onFail: "review" })).toThrow("正規表現");
    expect(() => addDevRule(p, { name: "a", body: "x", appliesTo: ["code"], check: "pattern", onFail: "review" })).toThrow("正規表現が要ります");
    expect(() => addDevRule(p, { name: "a", body: "x", appliesTo: ["code"], check: "ai", onFail: "stop" as never })).toThrow("違反したときの扱い");
    expect(() => addDevRule(p, { template: "nothing" })).toThrow("ひな形がありません");
  });

  it("有効 / 無効を切り替えられる", () => {
    const p = projectWith();
    const r = template(p, "commit-50");
    expect(setDevRuleEnabled(p, r.id, false).enabled).toBe(false);
    expect(devRulesView(p).rules[0]!.enabled).toBe(false);
    expect(setDevRuleEnabled(p, r.id, true).enabled).toBe(true);
    expect(() => setDevRuleEnabled(p, 999, true)).toThrow("ありません");
  });
});

describe("開発ルール: 形式での確かめ(AI を使わない)", () => {
  it("ひな形 4 つが、守れているものを通し、守れていないものを見つける", async () => {
    const p = projectWith();
    for (const t of TEMPLATES) template(p, t.key);
    const names = async (s: RuleSubject) => (await checkRules(p, s)).found.map((f) => f.rule.name);

    expect(await names(subject())).toEqual([]);
    expect(await names(subject({ branch: "kuramoto/7", title: "CSV", commits: ["書き出し"] }))).toEqual(["Jira 番号をそろえる"]);
    expect(await names(subject({ body: "書き出しを足した" }))).toEqual(["PR 本文の先頭に対象"]);
    expect(await names(subject({ commits: [`SHOP-1 ${"あ".repeat(45)}`] }))).toEqual(["コミット 1 行目 50 字以内"]);
    // 1 行目だけを見る
    expect(await names(subject({ commits: [`SHOP-1 ${"あ".repeat(40)}\n${"い".repeat(100)}`] }))).toEqual([]);
    // マイグレーションだけ・マイグレーションを含まない、は通り、混ざると見つかる
    expect(await names(subject({ files: ["db/migrations/001.sql", "db/migrations/002.sql"] }))).toEqual([]);
    expect(await names(subject({ files: ["src/a.ts", "src/b.ts"] }))).toEqual([]);
    expect(await names(subject({ files: ["db/migrations/001.sql", "src/a.ts"] }))).toEqual(["マイグレーションは単独の PR"]);
  });

  it("「!」で始まる正規表現は、当てはまったら違反。コードは足した行を 1 行ずつ見る", async () => {
    const p = projectWith();
    addDevRule(p, { name: "console.log を残さない", body: "x", appliesTo: ["code"], check: "pattern", pattern: "!console\\.log", onFail: "review" });
    expect((await checkRules(p, subject({ code: "const a = 1;\nconsole.log(a);" }))).found).toHaveLength(1);
    expect((await checkRules(p, subject({ code: "const a = 1;" }))).found).toHaveLength(0);
  });

  it("無効のルールは確かめられない", async () => {
    const p = projectWith();
    const r = template(p, "jira");
    const bad = subject({ branch: "kuramoto/7", title: "CSV", commits: ["x"] });
    expect((await checkRules(p, bad)).found).toHaveLength(1);
    setDevRuleEnabled(p, r.id, false);
    const off = await checkRules(p, bad);
    expect(off.found).toEqual([]);
    expect(off.evaluated.size).toBe(0);
  });
});

type Attempt = { title?: string; body?: string; commits?: string[]; files?: string[] };

/** 開発は attempts の順に PR を出す(足りなければ最後のものを繰り返す)。レビューは verdicts の順に答える。 */
function setup(attempts: Attempt[], opts: { judge?: (prompt: string) => { rule_id: number; ok: boolean; detail: string }[] } = {}) {
  const p = projectWith();
  let n = 0;
  let current: Attempt = attempts[0]!;
  const workspace = new StaticWorkspace("/tmp/ws", { changes: () => ({ commits: current.commits ?? ["SHOP-1 書き出し"], files: current.files ?? ["src/csv.ts"] }) });
  const toolReplies: string[] = [];
  const order: string[] = [];
  const script: FakeStep = async (req, call) => {
    const names = req.tools.map((t) => t.name);
    if (names.includes("submit_pr")) {
      order.push("dev");
      current = attempts[Math.min(n++, attempts.length - 1)]!;
      // 自動で直すルールに反していると、submit_pr が直し方を返して戻ってくる。台本は次の案で出し直す
      for (let i = 0; i < 5; i++) {
        const reply = await call("submit_pr", { summary: "実装した", ...(current.title ? { title: current.title } : {}), body: current.body ?? "対象: 書き出し\nCSV を書き出す", responses: fixedAll(req.prompt) });
        toolReplies.push(reply);
        if (!reply.includes("開発ルールに反しています")) break;
        current = attempts[Math.min(n++, attempts.length - 1)]!;
      }
    } else if (names.includes("report_rule_check")) {
      order.push("judge");
      await call("report_rule_check", { results: opts.judge?.(req.prompt) ?? [] });
    } else if (names.includes("submit_review")) {
      order.push("review");
      await call("submit_review", withResolutions(req.prompt, { verdict: "approve", findings: [] }));
    }
  };
  const harness = new FakeHarness(script);
  const d = new Dispatcher(p, { harnesses: { "claude-agent-sdk": harness }, workspace });
  return { p, d, harness, workspace, order, toolReplies };
}

describe("開発ルール: PR を出す前の確かめと違反時の扱い", () => {
  it("自動で直す: 持ち主が直してから PR が出る。違反は残り、直した数に数えられ、やりとりに出る", async () => {
    const { p, d, workspace, toolReplies, harness } = setup([{ title: "CSV" }, { title: "SHOP-1 CSV" }]);
    template(p, "jira");
    const t = createTicket(p, { title: "CSV の書き出し" });
    run(p.db, "UPDATE tickets SET jira_key = 'SHOP-1' WHERE id = ?", [t.id]);
    await d.drain();

    // 1 回目は戻され(PR は出ていない)、2 回目で PR が出た
    expect(toolReplies[0]).toContain("開発ルールに反しています");
    expect(toolReplies[0]).toContain("Jira 番号をそろえる");
    expect(workspace.published).toHaveLength(1);
    expect(workspace.published[0]!.title).toBe("SHOP-1 CSV");
    expect(p.ticket(t.id).stage).toBe("merge");
    // 形式のルールだけなので、確かめに AI は使っていない(開発とレビューの 2 回だけ)
    expect(harness.calls).toHaveLength(2);

    const rows = all<{ handled: string; resolved_at: string | null; run_id: number | null; detail: string }>(p.db, "SELECT handled, resolved_at, run_id, detail FROM rule_violations");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ handled: "autofixed" });
    expect(rows[0]!.resolved_at).not.toBeNull();
    expect(rows[0]!.run_id).not.toBeNull();
    expect(rows[0]!.detail).toContain("PR タイトル");

    expect(productivity(p).totals.ruleViolations).toEqual({ total: 1, autofixed: 1 });
    expect(ticketView(p, t.id).timeline.find((x) => x.type === "rule")).toMatchObject({ rule: "Jira 番号をそろえる", handled: "autofixed" });
    expect(devRulesView(p).rules[0]).toMatchObject({ violations: 1, autofixed: 1 });
  });

  it("レビューで指摘: PR は出て、レビューの指摘に載る。直せば解決する", async () => {
    const long = "あ".repeat(60);
    const { p, d, workspace, order } = setup([{ commits: [long] }, { commits: ["短くした"] }]);
    template(p, "commit-50");
    const t = createTicket(p, { title: "CSV の書き出し" });
    // 台本のレビューは常に承認するが、ルール違反が指摘として足される。2 回目の開発の直しで短くする
    await d.drain();

    expect(workspace.published).toHaveLength(2);
    expect(order).toEqual(["dev", "review", "dev", "review"]);
    const f = all<{ category: string; body: string; status: string; blocking: number }>(p.db, "SELECT category, body, status, blocking FROM findings");
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ category: "dev-rule", blocking: 1, status: "fixed" });
    expect(f[0]!.body).toContain("コミット 1 行目 50 字以内");
    expect(all<{ handled: string; resolved_at: string | null }>(p.db, "SELECT handled, resolved_at FROM rule_violations")).toMatchObject([{ handled: "review" }]);
    expect(all<{ resolved_at: string | null }>(p.db, "SELECT resolved_at FROM rule_violations")[0]!.resolved_at).not.toBeNull();
    expect(p.ticket(t.id).stage).toBe("merge");
    // 自動で直したのではない
    expect(productivity(p).totals.ruleViolations).toEqual({ total: 1, autofixed: 0 });
  });

  it("直すまで進めない: PR は出るが、直るまで次の工程に進まず持ち主に戻る", async () => {
    const bad = ["db/migrations/001.sql", "src/a.ts"];
    const { p, d, workspace, order, harness } = setup([{ files: bad }, { files: bad }, { files: ["db/migrations/001.sql"] }]);
    template(p, "migration-alone");
    const t = createTicket(p, { title: "列を足す" });
    await d.drain();

    // 直るまでレビューには回らない
    expect(order).toEqual(["dev", "dev", "dev", "review"]);
    expect(workspace.published).toHaveLength(3);
    expect(harness.calls[1]!.prompt).toContain("開発ルールに反したまま");
    expect(harness.calls[1]!.prompt).toContain("マイグレーションは単独の PR");
    expect(p.ticket(t.id).stage).toBe("merge");
    const rows = all<{ handled: string; resolved_at: string | null }>(p.db, "SELECT handled, resolved_at FROM rule_violations");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ handled: "blocked" });
    expect(rows[0]!.resolved_at).not.toBeNull();
  });

  it("直すまで進めない: 止まっているあいだは、チケットに止めているルールが出る", async () => {
    const bad = ["db/migrations/001.sql", "src/a.ts"];
    const { p, d } = setup([{ files: bad }]);
    template(p, "migration-alone");
    const t = createTicket(p, { title: "列を足す" });
    // 開発の最初の 1 回だけ動かす
    await d.drain({ maxRuns: 1 });
    expect(p.ticket(t.id).stage).toBe("dev");
    expect(ticketView(p, t.id).ruleBlocked).toEqual(["マイグレーションは単独の PR"]);
  });

  it("無効のルールは確かめられず、違反も残らない", async () => {
    const { p, d, workspace, toolReplies } = setup([{ title: "CSV", files: ["db/migrations/001.sql", "src/a.ts"], commits: ["あ".repeat(80)], body: "本文" }]);
    for (const t of TEMPLATES) setDevRuleEnabled(p, template(p, t.key).id, false);
    const t = createTicket(p, { title: "CSV の書き出し" });
    await d.drain();

    expect(toolReplies).toHaveLength(1);
    expect(toolReplies[0]).not.toContain("開発ルール");
    expect(workspace.published).toHaveLength(1);
    expect(all(p.db, "SELECT * FROM rule_violations")).toHaveLength(0);
    expect(p.ticket(t.id).stage).toBe("merge");
  });

  it("AI が読むルールだけ、エージェントに確かめさせる。形式のルールには使わない", async () => {
    const { p, d, order } = setup([{}], { judge: () => [{ rule_id: 1, ok: false, detail: "テストの名前が分かりにくい" }] });
    addDevRule(p, { name: "テストの名前が読める", body: "テストの名前が何を確かめるか分かる", appliesTo: ["code"], check: "ai", onFail: "review" });
    template(p, "commit-50");
    const t = createTicket(p, { title: "CSV の書き出し" });
    await d.drain();

    expect(order.filter((x) => x === "judge")).toHaveLength(2);
    const rows = all<{ detail: string; handled: string }>(p.db, "SELECT detail, handled FROM rule_violations");
    expect(rows[0]).toMatchObject({ handled: "review", detail: "テストの名前が分かりにくい" });
    expect(p.ticket(t.id).stage).not.toBe("done");
  });
});
