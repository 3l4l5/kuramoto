import { describe, expect, it } from "vitest";
import { ManualClock } from "../clock.js";
import { all, run } from "../db/sqlite.js";
import { fixedAll, FakeHarness, withResolutions, type FakeStep } from "../harness/fake.js";
import { addDevRule, checkRules, deleteDevRule, devRulesVersions, devRulesView, openViolations, recordViolations, setDevRuleEnabled, TEMPLATES, updateDevRule, violationsOf, violationTotals, type RuleSubject } from "./dev-rules.js";
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

describe("開発ルール: 版・直す・消す", () => {
  it("足す・直す・消す・有効 / 無効のたびに版が 1 つ上がり、そのときのルールの一覧が残る", () => {
    const p = projectWith();
    expect(devRulesView(p).version).toBe(1);
    const r = template(p, "jira");
    expect(devRulesView(p).version).toBe(2);
    updateDevRule(p, r.id, { name: "Jira 番号" });
    expect(devRulesView(p).version).toBe(3);
    setDevRuleEnabled(p, r.id, false);
    expect(devRulesView(p).version).toBe(4);
    deleteDevRule(p, r.id);
    expect(devRulesView(p).version).toBe(5);
    // 断った操作では上がらない
    expect(() => updateDevRule(p, r.id, { name: "x" })).toThrow("ありません");
    expect(() => updateDevRule(p, 999, { name: "x" })).toThrow("ありません");
    expect(devRulesView(p).version).toBe(5);
    expect(devRulesVersions(p).map((v) => [v.version, v.rules.map((x) => [x.name, x.enabled])])).toEqual([
      [1, []],
      [2, [["Jira 番号をそろえる", true]]],
      [3, [["Jira 番号", true]]],
      [4, [["Jira 番号", false]]],
      [5, []],
    ]);
  });

  it("直せるのは渡した項目だけ。足すときと同じ確かめで断り、断ったら中身も版も変わらない", () => {
    const p = projectWith();
    const r = template(p, "jira");
    const u = updateDevRule(p, r.id, { onFail: "review", appliesTo: ["pr_title"] });
    expect(u).toMatchObject({ id: r.id, name: "Jira 番号をそろえる", pattern: r.pattern, onFail: "review", appliesTo: ["pr_title"], template: "jira" });
    // 確かめ方を AI に変えると、正規表現は外れる
    expect(updateDevRule(p, r.id, { check: "ai" })).toMatchObject({ check: "ai", pattern: null });
    expect(() => updateDevRule(p, r.id, { name: " " })).toThrow("名前");
    expect(() => updateDevRule(p, r.id, { appliesTo: [] })).toThrow("どこに効くか");
    expect(() => updateDevRule(p, r.id, { check: "pattern" })).toThrow("正規表現が要ります");
    expect(() => updateDevRule(p, r.id, { check: "pattern", pattern: "(" })).toThrow("正規表現");
    expect(devRulesView(p)).toMatchObject({ version: 4, rules: [{ check: "ai", pattern: null }] });
  });

  it("直したルールで確かめる", async () => {
    const p = projectWith();
    const r = template(p, "jira");
    const bad = subject({ branch: "kuramoto/7", title: "CSV", commits: ["x"] });
    expect((await checkRules(p, bad)).found).toHaveLength(1);
    updateDevRule(p, r.id, { pattern: "^" });
    expect((await checkRules(p, bad)).found).toHaveLength(0);
  });

  it("消したルールは一覧に出ず、確かめず、同じひな形をもう一度足せる。違反の記録は残る", async () => {
    const p = projectWith();
    const r = template(p, "jira");
    const t = createTicket(p, { title: "CSV の書き出し" });
    recordViolations(p, t.id, null, await checkRules(p, subject({ branch: "kuramoto/7", title: "CSV", commits: ["x"] })));
    expect(devRulesView(p).rules[0]).toMatchObject({ violations: 1 });
    deleteDevRule(p, r.id);
    expect(devRulesView(p).rules).toEqual([]);
    expect(devRulesView(p).templates.find((x) => x.key === "jira")!.added).toBe(false);
    expect((await checkRules(p, subject({ branch: "kuramoto/7", title: "CSV", commits: ["x"] }))).found).toEqual([]);
    expect(openViolations(p, t.id)).toEqual([]);
    expect(violationsOf(p, t.id)).toMatchObject([{ name: "Jira 番号をそろえる" }]);
    expect(violationTotals(p).total).toBe(1);
    expect(() => setDevRuleEnabled(p, r.id, true)).toThrow("ありません");
    expect(template(p, "jira").id).not.toBe(r.id);
    expect(devRulesView(p).rules).toHaveLength(1);
  });
});

describe("開発ルール: 版はプロジェクトごと(dev_rule_versions)", () => {
  it("版の番号は自分のプロジェクトの行だけで決め、project_id を書いて残す。ほかのプロジェクトの版は混ざらない", () => {
    const p = new Project(":memory:", new ManualClock(new Date("2026-11-12T00:00:00Z")), 7);
    // ほかのプロジェクト(99)が、もっと先の版まで進んでいる
    run(p.db, "INSERT INTO dev_rule_versions (project_id, version, rules, created_at) VALUES (99, 50, '[]', '')");
    addDevRule(p, { template: "jira" });
    addDevRule(p, { template: "commit-50" });
    expect(devRulesView(p).version).toBe(3);
    expect(all<{ project_id: number; version: number }>(p.db, "SELECT project_id, version FROM dev_rule_versions ORDER BY project_id, version")).toEqual([
      { project_id: 7, version: 1 },
      { project_id: 7, version: 2 },
      { project_id: 7, version: 3 },
      { project_id: 99, version: 50 },
    ]);
    expect(devRulesVersions(p).map((v) => v.version)).toEqual([1, 2, 3]);
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

    expect((await productivity(p)).totals.ruleViolations).toEqual({ total: 1, autofixed: 1 });
    expect((await ticketView(p, t.id)).timeline.find((x) => x.type === "rule")).toMatchObject({ rule: "Jira 番号をそろえる", handled: "autofixed" });
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
    expect((await productivity(p)).totals.ruleViolations).toEqual({ total: 1, autofixed: 0 });
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
    expect((await ticketView(p, t.id)).ruleBlocked).toEqual(["マイグレーションは単独の PR"]);
  });

  it("ブランチ名は持ち主が直せない: Jira の番号が無いチケットで「Jira 番号をそろえる」を有効にしても、止まらない", async () => {
    // jira_key が無いので、ブランチは kuramoto/<番号> のまま。タイトルとコミットだけ直せる
    const { p, d, workspace, toolReplies, order } = setup([{ title: "CSV", commits: ["書き出し"] }, { title: "SHOP-1 CSV", commits: ["SHOP-1 書き出し"] }]);
    template(p, "jira");
    const t = createTicket(p, { title: "CSV の書き出し" });
    await d.drain();

    // 1 回目はタイトルとコミットだけを直すよう戻し、ブランチ名は直せとは言わない
    expect(toolReplies[0]).toContain("開発ルールに反しています");
    expect(toolReplies[0]).toContain("PR タイトル");
    expect(toolReplies[0]).not.toContain("ブランチ名が決まった形");
    // 2 回目で PR が出る。起動は失敗していない
    expect(workspace.published[0]!.title).toBe("SHOP-1 CSV");
    expect(all<{ outcome: string }>(p.db, "SELECT outcome FROM runs WHERE role = 'dev'").every((r) => r.outcome === "ok")).toBe(true);
    // ブランチ名の違反だけが残るので、自動で直した扱いにはせず、レビューで指摘に回る
    expect(all<{ handled: string; detail: string }>(p.db, "SELECT handled, detail FROM rule_violations")).toMatchObject([{ handled: "review" }]);
    expect(order).toContain("review");
    expect(all<{ category: string }>(p.db, "SELECT category FROM findings").map((f) => f.category)).toEqual(["dev-rule"]);
    expect(p.ticket(t.id).stage).toBe("merge");
    expect((await productivity(p)).totals.ruleViolations).toEqual({ total: 1, autofixed: 0 });
  });

  it("ブランチ名だけに効く「自動で直す」ルールは、戻さずに、レビューで指摘に回す", async () => {
    const { p, d, toolReplies } = setup([{}]);
    addDevRule(p, { name: "ブランチは SHOP- で始める", body: "x", appliesTo: ["branch"], check: "pattern", pattern: "^SHOP-", onFail: "autofix" });
    createTicket(p, { title: "CSV の書き出し" });
    await d.drain();

    // 直して出し直すよう戻すことは一度も無い(直せないので)
    expect(toolReplies.some((r) => r.includes("開発ルールに反しています"))).toBe(false);
    expect(all<{ handled: string }>(p.db, "SELECT handled FROM rule_violations")).toMatchObject([{ handled: "review" }]);
  });

  it("レビューの指摘は違反ごとに 1 件。違反の中身が変わっても、同じ違反の指摘を足さない", async () => {
    const { p, d } = setup([{ commits: ["あ".repeat(60)] }, { commits: ["い".repeat(70)] }, { commits: ["う".repeat(80)] }]);
    template(p, "commit-50");
    createTicket(p, { title: "CSV の書き出し" });
    await d.drain();

    // 直しの出し直しのたびにコミットは変わるが、違反は 1 件のまま、指摘も 1 件
    expect(all(p.db, "SELECT * FROM rule_violations")).toHaveLength(1);
    expect(all(p.db, "SELECT * FROM findings WHERE category = 'dev-rule'")).toHaveLength(1);
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
    // 読ませた分の使用量は、その開発の起動に足される(チケットの予算と生産性に入る)
    const devRuns = all<{ cost_usd: number; input_tokens: number }>(p.db, "SELECT cost_usd, input_tokens FROM runs WHERE role = 'dev' ORDER BY id");
    expect(devRuns.length).toBeGreaterThan(0);
    for (const r of devRuns) {
      expect(r.cost_usd).toBeCloseTo(0.02);
      expect(r.input_tokens).toBe(2000);
    }
    const rows = all<{ detail: string; handled: string }>(p.db, "SELECT detail, handled FROM rule_violations");
    expect(rows[0]).toMatchObject({ handled: "review", detail: "テストの名前が分かりにくい" });
    expect(p.ticket(t.id).stage).not.toBe("done");
  });
});
