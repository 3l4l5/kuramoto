import { z } from "zod";
import { all, get, run } from "../db/sqlite.js";
import { defineTool, type Harness, type HarnessUsage } from "../harness/types.js";
import type { Project, TicketRow } from "./project.js";

/**
 * 開発ルール(R15・ADR-0011)。プロジェクトごとの小さな決まりごと。
 * - 確かめ方は「形式(正規表現。トークン 0)」を優先し、読まないと分からないものだけ「AI が読む」。
 * - 守れていなかったときの扱い: autofix = 持ち主が直してから PR が出る / review = レビューの指摘に載る / block = 直すまで次の工程に進まない。
 * - 開発が submit_pr を呼んだとき(PR を出す前)に、有効なルールだけを確かめる。無効のルールは確かめない。
 * - 違反は rule_violations に残し、チケットのやりとりに出す。直ったら resolved_at を入れる。
 */

export const TARGETS = ["branch", "commit", "pr_title", "pr_body", "files", "code"] as const;
export type RuleTarget = (typeof TARGETS)[number];
export const TARGET_LABEL: Record<RuleTarget, string> = { branch: "ブランチ名", commit: "コミット", pr_title: "PR タイトル", pr_body: "PR 本文", files: "変更したファイル", code: "コード" };
export const CHECKS = ["pattern", "ai"] as const;
export type RuleCheck = (typeof CHECKS)[number];
export const ON_FAILS = ["autofix", "review", "block"] as const;
export type RuleOnFail = (typeof ON_FAILS)[number];
export type Handled = "autofixed" | "review" | "blocked";
const HANDLED: Record<RuleOnFail, Handled> = { autofix: "autofixed", review: "review", block: "blocked" };

export type RuleInput = { name: string; body: string; appliesTo: RuleTarget[]; check: RuleCheck; pattern?: string | null; onFail: RuleOnFail };
export type DevRule = RuleInput & { id: number; pattern: string | null; enabled: boolean; template: string | null; createdAt: string };

/**
 * 形式のルールの書き方: 正規表現に当てはまればよい。先頭が「!」なら、当てはまったら違反(禁止)。
 * コミットは 1 件ずつ(1 行目)、コードは足した行を 1 行ずつ、ブランチ名・PR タイトル・PR 本文はそのまま、変更したファイルは改行でつないだ 1 つの文字列に当てる。
 */
const MIGRATION = String.raw`(?<![^/\n])(?:migrations?|db/migrate)/`;
const NOT_MIGRATION = String.raw`(?:(?![^\n]*?${MIGRATION})[^\n]*(?:\n|$))*`;
const ONLY_MIGRATION = String.raw`(?:(?=[^\n]*?${MIGRATION})[^\n]*(?:\n|$))*`;

export type RuleTemplate = RuleInput & { key: string; pattern: string };
export const TEMPLATES: RuleTemplate[] = [
  {
    key: "jira",
    name: "Jira 番号をそろえる",
    body: "ブランチ名・PR タイトル・コミットに Jira の課題番号(例: SHOP-121)を入れる。",
    appliesTo: ["branch", "pr_title", "commit"],
    check: "pattern",
    pattern: "[A-Z][A-Z0-9]*-[0-9]+",
    onFail: "autofix",
  },
  {
    key: "pr-body-target",
    name: "PR 本文の先頭に対象",
    body: "PR 本文の先頭に「対象: 何のどこを変えたか」を書く。",
    appliesTo: ["pr_body"],
    check: "pattern",
    pattern: "^\\s*(?:#+\\s*)?対象[::\\s]",
    onFail: "autofix",
  },
  {
    key: "migration-alone",
    name: "マイグレーションは単独の PR",
    body: "マイグレーションのファイルを変える PR では、ほかのファイルを変えない。",
    appliesTo: ["files"],
    check: "pattern",
    pattern: `^${NOT_MIGRATION}$|^${ONLY_MIGRATION}$`,
    onFail: "block",
  },
  {
    key: "commit-50",
    name: "コミット 1 行目 50 字以内",
    body: "コミットメッセージの 1 行目は 50 字以内にする。",
    appliesTo: ["commit"],
    check: "pattern",
    pattern: "^.{1,50}$",
    onFail: "review",
  },
];

// ---- 一覧・追加・有効 / 無効 ----

type RuleRow = { id: number; name: string; body: string; applies_to: string; check_kind: RuleCheck; pattern: string | null; on_fail: RuleOnFail; enabled: number; template: string | null; created_at: string };

function toRule(r: RuleRow): DevRule {
  return {
    id: r.id,
    name: r.name,
    body: r.body,
    appliesTo: r.applies_to.split(",").filter((t): t is RuleTarget => (TARGETS as readonly string[]).includes(t)),
    check: r.check_kind,
    pattern: r.pattern,
    onFail: r.on_fail,
    enabled: !!r.enabled,
    template: r.template,
    createdAt: r.created_at,
  };
}

export function devRules(p: Project): DevRule[] {
  return all<RuleRow>(p.db, "SELECT * FROM dev_rules ORDER BY id").map(toRule);
}

/** 画面の一覧用。ルールごとの違反の数(うち自動で直した数)つき。 */
export function devRulesView(p: Project) {
  const counts = new Map(
    all<{ rule_id: number; n: number; fixed: number }>(p.db, "SELECT rule_id, COUNT(*) AS n, SUM(handled = 'autofixed') AS fixed FROM rule_violations GROUP BY rule_id").map((c) => [c.rule_id, c]),
  );
  const rules = devRules(p).map((r) => ({ ...r, violations: counts.get(r.id)?.n ?? 0, autofixed: counts.get(r.id)?.fixed ?? 0 }));
  const added = new Set(rules.map((r) => r.template));
  return { rules, templates: TEMPLATES.map((t) => ({ ...t, added: added.has(t.key) })) };
}

function checkRegex(pattern: string): void {
  if (pattern.length > 500) throw new Error("正規表現が長すぎます(500 字まで)");
  try {
    new RegExp(pattern.startsWith("!") ? pattern.slice(1) : pattern);
  } catch {
    throw new Error(`正規表現として読めません: ${pattern}`);
  }
}

export function addDevRule(p: Project, input: Partial<RuleInput> & { template?: string }): DevRule {
  let base: Partial<RuleInput> = input;
  let template: string | null = null;
  if (input.template) {
    const t = TEMPLATES.find((x) => x.key === input.template);
    if (!t) throw new Error(`ひな形がありません: ${input.template}`);
    if (devRules(p).some((r) => r.template === t.key)) throw new Error(`「${t.name}」はもう足してあります`);
    base = { ...t, ...Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)) };
    template = t.key;
  }
  const name = String(base.name ?? "").trim();
  if (!name) throw new Error("名前がありません");
  const appliesTo = [...new Set(base.appliesTo ?? [])];
  if (!appliesTo.length) throw new Error("どこに効くかを 1 つ以上選んでください");
  const bad = appliesTo.find((t) => !(TARGETS as readonly string[]).includes(t));
  if (bad) throw new Error(`どこに効くかが正しくありません: ${bad}`);
  if (!CHECKS.includes(base.check as RuleCheck)) throw new Error("確かめ方は pattern(形式)か ai(AI が読む)です");
  if (!ON_FAILS.includes(base.onFail as RuleOnFail)) throw new Error("違反したときの扱いは autofix・review・block のどれかです");
  const body = String(base.body ?? "").trim();
  if (base.check === "ai" && !body) throw new Error("AI が読むルールには、何を守るかが要ります");
  let pattern: string | null = null;
  if (base.check === "pattern") {
    pattern = String(base.pattern ?? "");
    if (!pattern) throw new Error("形式のルールには正規表現が要ります");
    checkRegex(pattern);
  }
  const id = run(p.db, "INSERT INTO dev_rules (name, body, applies_to, check_kind, pattern, on_fail, enabled, template, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)", [
    name,
    body,
    appliesTo.join(","),
    base.check!,
    pattern,
    base.onFail!,
    template,
    p.now(),
  ]).lastId;
  p.event("owner", "dev_rule_added", null, { id, name });
  return devRules(p).find((r) => r.id === id)!;
}

export function setDevRuleEnabled(p: Project, id: number, enabled: boolean): DevRule {
  const changed = run(p.db, "UPDATE dev_rules SET enabled = ? WHERE id = ?", [enabled ? 1 : 0, id]).changes;
  if (!changed) throw new Error("そのルールはありません");
  p.event("owner", enabled ? "dev_rule_enabled" : "dev_rule_disabled", null, { id });
  return devRules(p).find((r) => r.id === id)!;
}

// ---- 確かめる ----

/** PR を出す前の、確かめる対象。 */
export type RuleSubject = { branch: string; title: string; body: string; commits: string[]; files: string[]; code: string };
/** 作業場所から取る、コミットの 1 行目・変更したファイル・足した行。 */
export type RuleChanges = { commits: string[]; files: string[]; code: string };
/** AI が読んで確かめる(読むルールだけを渡す)。結果が返らなかったルールは確かめなかったことにする。 */
export type RuleJudge = (rules: DevRule[], subject: RuleSubject) => Promise<{ ruleId: number; ok: boolean; detail: string }[]>;
/**
 * onFail: 実際の扱い。ブランチ名は Kuramoto が決める名前で、持ち主は直せない。ブランチ名だけが反している「自動で直す」ルールは、直せないので「レビューで指摘」にする。
 * fixDetail: 持ち主が直せる分の説明(自動で直すときに返す)。
 */
export type Found = { rule: DevRule; detail: string; onFail: RuleOnFail; fixDetail: string };
export type Checked = { found: Found[]; evaluated: Set<number> };

const MAX_SUBJECT = 20_000;
const clip = (s: string, n = 80) => (s.length > n ? `${s.slice(0, n)}…` : s);

function subjectsOf(target: RuleTarget, s: RuleSubject): string[] {
  switch (target) {
    case "branch":
      return [s.branch];
    case "pr_title":
      return [s.title];
    case "pr_body":
      return [s.body];
    case "commit":
      return s.commits.map((c) => c.split("\n")[0] ?? "");
    case "files":
      return s.files.length ? [s.files.join("\n")] : [];
    case "code":
      return s.code.split("\n").filter(Boolean);
  }
}

function patternDetails(rule: DevRule, s: RuleSubject): { target: RuleTarget; text: string }[] {
  const forbid = rule.pattern!.startsWith("!");
  const re = new RegExp(forbid ? rule.pattern!.slice(1) : rule.pattern!);
  const out: { target: RuleTarget; text: string }[] = [];
  for (const target of rule.appliesTo) {
    const bad = subjectsOf(target, s).filter((x) => re.test(x.slice(0, MAX_SUBJECT)) === forbid);
    for (const x of bad.slice(0, 3)) out.push({ target, text: `${TARGET_LABEL[target]}${target === "files" ? "" : `「${clip(x.replace(/\n/g, " / "))}」`}${forbid ? "は禁止の形に当てはまります" : "が決まった形になっていません"}` });
    if (bad.length > 3) out.push({ target, text: `${TARGET_LABEL[target]}: ほか ${bad.length - 3} 件` });
  }
  return out;
}

/**
 * 有効なルールを確かめる。形式はここで(AI を使わない)、AI が読むものだけ judge に渡す。無効のルールは確かめない。
 * judge が無い・落ちたときは、AI のルールは確かめなかったことにする(PR は止めない)。
 */
export async function checkRules(p: Project, subject: RuleSubject, judge?: RuleJudge): Promise<Checked> {
  const rules = devRules(p).filter((r) => r.enabled);
  const found: Found[] = [];
  const evaluated = new Set<number>();
  for (const r of rules.filter((x) => x.check === "pattern" && x.pattern)) {
    evaluated.add(r.id);
    const details = patternDetails(r, subject);
    if (!details.length) continue;
    const fixable = details.filter((d) => d.target !== "branch");
    found.push({ rule: r, detail: details.map((d) => d.text).join(" / "), onFail: r.onFail === "autofix" && !fixable.length ? "review" : r.onFail, fixDetail: fixable.map((d) => d.text).join(" / ") });
  }
  const ai = rules.filter((x) => x.check === "ai");
  if (ai.length && judge) {
    try {
      const byId = new Map(ai.map((r) => [r.id, r]));
      for (const v of await judge(ai, subject)) {
        const rule = byId.get(v.ruleId);
        if (!rule) continue;
        evaluated.add(rule.id);
        if (v.ok) continue;
        const detail = v.detail.trim() || "AI が、守れていないと判断しました";
        found.push({ rule, detail, onFail: rule.onFail === "autofix" && !rule.appliesTo.some((t) => t !== "branch") ? "review" : rule.onFail, fixDetail: detail });
      }
    } catch (e) {
      p.event("system", "rule_ai_failed", null, { error: e instanceof Error ? e.message : String(e) });
    }
  }
  return { found, evaluated };
}

// ---- 違反を残す ----

export type ViolationRow = { id: number; rule_id: number; ticket_id: number; handled: Handled; detail: string; run_id: number | null; created_at: string; resolved_at: string | null };

/**
 * 確かめた結果を違反に反映する。新しく見つかった違反を残し、確かめた上で守れていたもの(前に違反していたもの)には resolved_at を入れる。
 * 同じルールの違反が直っていないうちは、出し直しても 1 件のまま。
 */
export function recordViolations(p: Project, ticketId: number, runId: number | null, checked: Checked): void {
  const open = all<ViolationRow>(p.db, "SELECT * FROM rule_violations WHERE ticket_id = ? AND resolved_at IS NULL", [ticketId]);
  const foundIds = new Set(checked.found.map((f) => f.rule.id));
  for (const f of checked.found) {
    const was = open.find((v) => v.rule_id === f.rule.id);
    if (was) {
      // 持ち主が直せる分を直したあとに、直せない分(ブランチ名)だけが残ったなら、レビューで指摘に回す
      const handled = was.handled === "autofixed" && f.onFail !== "autofix" ? HANDLED[f.onFail] : was.handled;
      run(p.db, "UPDATE rule_violations SET detail = ?, handled = ? WHERE id = ?", [f.detail, handled, was.id]);
      continue;
    }
    run(p.db, "INSERT INTO rule_violations (rule_id, ticket_id, handled, created_at, detail, run_id) VALUES (?, ?, ?, ?, ?, ?)", [f.rule.id, ticketId, HANDLED[f.onFail], p.now(), f.detail, runId]);
    p.event("system", "rule_violated", ticketId, { rule: f.rule.name, handled: HANDLED[f.onFail] });
  }
  for (const v of open) if (checked.evaluated.has(v.rule_id) && !foundIds.has(v.rule_id)) run(p.db, "UPDATE rule_violations SET resolved_at = ? WHERE id = ?", [p.now(), v.id]);
}

/** 今も直っていない違反(有効なルールのものだけ)。 */
export function openViolations(p: Project, ticketId: number, handled?: Handled): (ViolationRow & { name: string; body: string })[] {
  return all<ViolationRow & { name: string; body: string }>(
    p.db,
    `SELECT v.*, r.name, r.body FROM rule_violations v JOIN dev_rules r ON r.id = v.rule_id
     WHERE v.ticket_id = ? AND v.resolved_at IS NULL AND r.enabled = 1 ${handled ? "AND v.handled = ?" : ""} ORDER BY v.id`,
    handled ? [ticketId, handled] : [ticketId],
  );
}

/** チケットのやりとりに出す、違反の記録(ルールの名前つき)。 */
export function violationsOf(p: Project, ticketId: number) {
  return all<ViolationRow & { name: string }>(p.db, "SELECT v.*, r.name FROM rule_violations v JOIN dev_rules r ON r.id = v.rule_id WHERE v.ticket_id = ? ORDER BY v.id", [ticketId]);
}

/** 生産性: ルール違反の件数と、うち自動で直した件数(handled = 'autofixed')。 */
export function violationTotals(p: Project): { total: number; autofixed: number } {
  const r = get<{ n: number; fixed: number | null }>(p.db, "SELECT COUNT(*) AS n, SUM(handled = 'autofixed') AS fixed FROM rule_violations");
  return { total: r?.n ?? 0, autofixed: r?.fixed ?? 0 };
}

/** レビューの指摘に載せる違反(handled = 'review'で、直っておらず、まだ指摘にしていないもの)。指摘にしたかは違反の番号で覚える。 */
export function reviewFindingsFor(p: Project, ticketId: number): { violationId: number; category: string; severity: "medium"; blocking: true; basis: "acceptance"; body: string }[] {
  return openViolations(p, ticketId, "review").filter((v) => !p.setting(`rule_listed:${v.id}`)).map((v) => ({
    violationId: v.id,
    category: "dev-rule",
    severity: "medium" as const,
    blocking: true as const,
    basis: "acceptance" as const,
    body: ruleFindingBody(v.name, v.detail),
  }));
}

/** 違反を指摘にしたと覚える(同じ違反の指摘を、確かめるたびに足さない)。 */
export function markListed(p: Project, violationId: number): void {
  p.setSetting(`rule_listed:${violationId}`, "1");
}

export function ruleFindingBody(name: string, detail: string): string {
  return `開発ルール「${name}」に反しています: ${detail}`;
}

/** 担当への指示に足す、守ってほしい開発ルールの一覧。無ければ空。 */
export function rulesNote(p: Project): string {
  const rules = devRules(p).filter((r) => r.enabled);
  if (!rules.length) return "";
  const how = { autofix: "反していたら submit_pr が戻ってくるので、直して出し直す", review: "反していたらレビューで指摘される", block: "反していたら、直すまで次の工程に進めない" };
  const branchNote = (r: DevRule) => (r.onFail === "autofix" && r.appliesTo.includes("branch") ? "ブランチ名は Kuramoto が決めるので直せません。ブランチ名だけが反しているときはレビューで指摘されます。" : "");
  return `\n\n## 開発ルール(PR を出す前に Kuramoto が確かめます)\n${rules.map((r) => `- ${r.name}: ${r.body}(${r.appliesTo.map((t) => TARGET_LABEL[t]).join("・")}。${how[r.onFail]}。${branchNote(r)})`.replace("。)", ")")).join("\n")}`;
}

// ---- PR を出す前に確かめる(submit_pr から) ----

export type PreCheck = {
  ticket: TicketRow;
  runId: number | null;
  branch: string;
  draft: { title?: string; body?: string; summary: string };
  /** チケットのタイトルから作る、PR の既定のタイトル */
  defaultTitle: string;
  changes: () => Promise<RuleChanges>;
  judge?: RuleJudge;
};

/**
 * submit_pr の中で呼ぶ。違反を残し、「持ち主が自動で直す」ルールに反していれば、直して出し直すための指示(文)を返す。
 * 返さなければ PR を出してよい(レビューで指摘・直すまで進めない、は PR を出したあとに工程が扱う)。
 */
export async function checkBeforePr(p: Project, c: PreCheck): Promise<string | undefined> {
  if (!devRules(p).some((r) => r.enabled)) return undefined;
  const changes = await c.changes();
  const checked = await checkRules(p, { branch: c.branch, title: c.draft.title ?? c.defaultTitle, body: c.draft.body ?? c.draft.summary, ...changes }, c.judge);
  recordViolations(p, c.ticket.id, c.runId, checked);
  // 持ち主が直せる違反だけを返して戻す(ブランチ名は Kuramoto が決めるので、戻さない)
  const fix = checked.found.filter((f) => f.onFail === "autofix");
  if (!fix.length) return undefined;
  return `開発ルールに反しています。直してから submit_pr を呼び直してください(PR のタイトルと本文は submit_pr の title・body で、コミットは git で直します。ブランチ名は Kuramoto が決めるので変えません):\n${fix.map((f) => `- 「${f.rule.name}」: ${f.fixDetail}(守ること: ${f.rule.body})`).join("\n")}`;
}

// ---- AI が読んで確かめる ----

/** 読むルールを 1 回の起動でまとめて確かめる。道具は結果の報告だけ。ファイルも通信も使わない。 */
export function agentJudge(p: Project, harness: Harness, cwd: string, onUsage?: (u: HarnessUsage) => void): RuleJudge {
  return async (rules, subject) => {
    const policy = p.policy("review");
    const results: { ruleId: number; ok: boolean; detail: string }[] = [];
    const report = defineTool({
      name: "report_rule_check",
      description: "開発ルールごとの確かめの結果を報告する。すべてのルールについて、1 回で呼ぶ。",
      input: {
        results: z.array(z.object({ rule_id: z.number().int(), ok: z.boolean().describe("守れていれば true"), detail: z.string().describe("守れていないときは、どこがどう違うか。守れていれば空でよい") })),
      },
      handler: ({ results: given }) => {
        for (const r of given) results.push({ ruleId: r.rule_id, ok: r.ok, detail: r.detail });
        return "受け付けました。";
      },
    });
    const res = await harness.run({
      cwd,
      systemPrompt: "あなたは、PR を出す前に開発ルールを守れているかを確かめる担当です。渡された内容だけを読み、ルールごとに守れているかを判断します。コードは変更しません。結果は report_rule_check で報告します。",
      prompt: [
        "次のルールを、下の PR の内容が守れているか確かめてください。",
        "## ルール",
        ...rules.map((r) => `- ルール ${r.id}「${r.name}」(見るところ: ${r.appliesTo.map((t) => TARGET_LABEL[t]).join("・")}): ${r.body}`),
        "## PR の内容",
        `ブランチ名: ${subject.branch}`,
        `PR タイトル: ${subject.title}`,
        `PR 本文:\n${subject.body.slice(0, MAX_SUBJECT)}`,
        `コミット(1 行目):\n${subject.commits.map((c) => `- ${c.split("\n")[0]}`).join("\n")}`,
        `変更したファイル:\n${subject.files.join("\n")}`,
        `足したコード:\n${subject.code.slice(0, MAX_SUBJECT)}`,
      ].join("\n"),
      model: policy.model,
      effort: "low",
      tools: [report],
      allowedTools: [],
      maxTurns: 3,
    });
    onUsage?.(res.usage);
    if (res.status === "error") throw new Error(res.error ?? "ハーネスがエラーで終わりました");
    return results;
  };
}
