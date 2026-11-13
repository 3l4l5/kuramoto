import { z } from "zod";
import { sql } from "kysely";
import { inScope, scopeIds } from "../db/count.js";
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

// ---- 一覧・追加・直す・消す・有効 / 無効(変えるたびに版が上がる) ----

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

export async function devRules(p: Project): Promise<DevRule[]> {
  return ((await inScope(p.pdb, "dev_rules").where("deleted_at", "is", null).orderBy("id").execute()) as unknown as RuleRow[]).map(toRule);
}

/** 画面の一覧用。ルールごとの違反の数(うち自動で直した数)つき。 */
export async function devRulesView(p: Project) {
  // ルールごとの違反の数は、違反を 1 文で取って JS で数える
  const counts = new Map<number, { n: number; fixed: number }>();
  for (const v of await inScope(p.pdb, "rule_violations").execute()) {
    const c = counts.get(v.rule_id) ?? { n: 0, fixed: 0 };
    c.n++;
    if (v.handled === "autofixed") c.fixed++;
    counts.set(v.rule_id, c);
  }
  const rules = (await devRules(p)).map((r) => ({ ...r, violations: counts.get(r.id)?.n ?? 0, autofixed: counts.get(r.id)?.fixed ?? 0 }));
  const added = new Set(rules.map((r) => r.template));
  return { version: await devRulesVersion(p), rules, templates: TEMPLATES.map((t) => ({ ...t, added: added.has(t.key) })) };
}

/** 開発ルールの今の版。ルールを足す・直す・消す・有効 / 無効にするたびに 1 つ上がり、そのときのルールの一覧を dev_rule_versions に残す。 */
export async function devRulesVersion(p: Project): Promise<number> {
  // 版はプロジェクトごと(主キーは (project_id, version))。まだ 0 のままの行(同期の INSERT)も、このプロジェクトのものとして数える
  const r = await p.pdb.k.selectFrom("dev_rule_versions").select(sql<number | null>`MAX(version)`.as("v")).where("project_id", "in", scopeIds(p.pdb)).executeTakeFirst();
  return Number(r?.v ?? 1);
}

/** 版を 1 つ上げて、いまのルールの一覧を残す。版を読んでから書くので、呼ぶ側の tx の中で使う(単独でもここで張る)。 */
async function bumpVersion(p: Project): Promise<number> {
  return p.pdb.transaction(async () => {
    const version = (await devRulesVersion(p)) + 1;
    const rules = (await devRules(p)).map((r) => ({ id: r.id, name: r.name, body: r.body, appliesTo: r.appliesTo, check: r.check, pattern: r.pattern, onFail: r.onFail, enabled: r.enabled }));
    await p.pdb.insert("dev_rule_versions", { version, rules: JSON.stringify(rules), created_at: p.now() }).execute();
    return version;
  });
}

/** 残してある版ごとの、そのときのルールの一覧。 */
export async function devRulesVersions(p: Project): Promise<{ version: number; createdAt: string; rules: { id: number; name: string; enabled: boolean }[] }[]> {
  return (await inScope(p.pdb, "dev_rule_versions").orderBy("version").execute()).map((v) => ({
    version: v.version,
    createdAt: v.created_at,
    rules: JSON.parse(v.rules) as { id: number; name: string; enabled: boolean }[],
  }));
}

function checkRegex(pattern: string): void {
  if (pattern.length > 500) throw new Error("正規表現が長すぎます(500 字まで)");
  try {
    new RegExp(pattern.startsWith("!") ? pattern.slice(1) : pattern);
  } catch {
    throw new Error(`正規表現として読めません: ${pattern}`);
  }
}

/** 足す・直すで共通の確かめ。足りない項目は、呼ぶ側が埋めてから渡す。 */
function validRule(base: Partial<RuleInput>): RuleInput & { pattern: string | null } {
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
  return { name, body, appliesTo, check: base.check!, pattern, onFail: base.onFail! };
}

export async function addDevRule(p: Project, input: Partial<RuleInput> & { template?: string }): Promise<DevRule> {
  let base: Partial<RuleInput> = input;
  let template: string | null = null;
  if (input.template) {
    const t = TEMPLATES.find((x) => x.key === input.template);
    if (!t) throw new Error(`ひな形がありません: ${input.template}`);
    base = { ...t, ...Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)) };
    template = t.key;
  }
  const v = validRule(base);
  return p.pdb.transaction(async () => {
    // 同じひな形がもうあるかを読んでから足すので、tx の中で
    if (template && (await devRules(p)).some((r) => r.template === template)) throw new Error(`「${TEMPLATES.find((x) => x.key === template)!.name}」はもう足してあります`);
    const id = await p.pdb.dialect.insertedId(
      p.pdb.insert("dev_rules", { name: v.name, body: v.body, applies_to: v.appliesTo.join(","), check_kind: v.check, pattern: v.pattern, on_fail: v.onFail, enabled: 1, template, created_at: p.now() }),
    );
    const version = await bumpVersion(p);
    await p.event("owner", "dev_rule_added", null, { id, name: v.name, version });
    return liveRule(p, id);
  });
}

async function liveRule(p: Project, id: number): Promise<DevRule> {
  const r = (await devRules(p)).find((x) => x.id === id);
  if (!r) throw new Error("そのルールはありません");
  return r;
}

/** ルールの中身を直す。渡した項目だけを変える(ひな形から足したものも直せる)。直すと版が上がる。 */
export async function updateDevRule(p: Project, id: number, input: Partial<RuleInput>): Promise<DevRule> {
  return p.pdb.transaction(async () => {
    const was = await liveRule(p, id);
    const given = Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined));
    const v = validRule({ name: was.name, body: was.body, appliesTo: was.appliesTo, check: was.check, pattern: was.pattern, onFail: was.onFail, ...given });
    await p.pdb.update("dev_rules", { name: v.name, body: v.body, applies_to: v.appliesTo.join(","), check_kind: v.check, pattern: v.pattern, on_fail: v.onFail }).where("id", "=", id).execute();
    const version = await bumpVersion(p);
    await p.event("owner", "dev_rule_updated", null, { id, name: v.name, version });
    return liveRule(p, id);
  });
}

/**
 * ルールを消す。違反の記録(チケットのやりとり・生産性の数)は残すので、行は消さずに印を付ける。
 * 消したルールは確かめず、一覧にも出さず、同じひな形をもう一度足せる。
 */
export async function deleteDevRule(p: Project, id: number): Promise<void> {
  await p.pdb.transaction(async () => {
    const was = await liveRule(p, id);
    await p.pdb.update("dev_rules", { deleted_at: p.now() }).where("id", "=", id).execute();
    const version = await bumpVersion(p);
    await p.event("owner", "dev_rule_deleted", null, { id, name: was.name, version });
  });
}

export async function setDevRuleEnabled(p: Project, id: number, enabled: boolean): Promise<DevRule> {
  return p.pdb.transaction(async () => {
    await liveRule(p, id);
    await p.pdb.update("dev_rules", { enabled: enabled ? 1 : 0 }).where("id", "=", id).execute();
    const version = await bumpVersion(p);
    await p.event("owner", enabled ? "dev_rule_enabled" : "dev_rule_disabled", null, { id, version });
    return liveRule(p, id);
  });
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
  const rules = (await devRules(p)).filter((r) => r.enabled);
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
      await p.event("system", "rule_ai_failed", null, { error: e instanceof Error ? e.message : String(e) });
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
export async function recordViolations(p: Project, ticketId: number, runId: number | null, checked: Checked): Promise<void> {
  await p.pdb.transaction(async () => {
    const open = (await inScope(p.pdb, "rule_violations").where("ticket_id", "=", ticketId).where("resolved_at", "is", null).execute()) as unknown as ViolationRow[];
    const foundIds = new Set(checked.found.map((f) => f.rule.id));
    for (const f of checked.found) {
      const was = open.find((v) => v.rule_id === f.rule.id);
      if (was) {
        // 持ち主が直せる分を直したあとに、直せない分(ブランチ名)だけが残ったなら、レビューで指摘に回す
        const handled = was.handled === "autofixed" && f.onFail !== "autofix" ? HANDLED[f.onFail] : was.handled;
        await p.pdb.update("rule_violations", { detail: f.detail, handled }).where("id", "=", was.id).execute();
        continue;
      }
      await p.pdb.insert("rule_violations", { rule_id: f.rule.id, ticket_id: ticketId, handled: HANDLED[f.onFail], created_at: p.now(), detail: f.detail, run_id: runId }).execute();
      await p.event("system", "rule_violated", ticketId, { rule: f.rule.name, handled: HANDLED[f.onFail] });
    }
    for (const v of open) if (checked.evaluated.has(v.rule_id) && !foundIds.has(v.rule_id)) await p.pdb.update("rule_violations", { resolved_at: p.now() }).where("id", "=", v.id).execute();
  });
}

/** 違反にルールの名前・本文を付けて取る(JOIN で 1 文)。 */
function violationsWithRule(p: Project, ticketId: number) {
  return p.pdb.k
    .selectFrom("rule_violations as v")
    .innerJoin("dev_rules as r", "r.id", "v.rule_id")
    .selectAll("v")
    .select(["r.name as name", "r.body as body"])
    .where("v.project_id", "in", scopeIds(p.pdb))
    .where("v.ticket_id", "=", ticketId)
    .orderBy("v.id");
}

/** 今も直っていない違反(有効なルールのものだけ)。 */
export async function openViolations(p: Project, ticketId: number, handled?: Handled): Promise<(ViolationRow & { name: string; body: string })[]> {
  let q = violationsWithRule(p, ticketId).where("v.resolved_at", "is", null).where("r.enabled", "=", 1).where("r.deleted_at", "is", null);
  if (handled) q = q.where("v.handled", "=", handled);
  return (await q.execute()) as unknown as (ViolationRow & { name: string; body: string })[];
}

/** チケットのやりとりに出す、違反の記録(ルールの名前つき)。 */
export async function violationsOf(p: Project, ticketId: number): Promise<(ViolationRow & { name: string })[]> {
  return (await violationsWithRule(p, ticketId).execute()) as unknown as (ViolationRow & { name: string })[];
}

/** 生産性: ルール違反の件数と、うち自動で直した件数(handled = 'autofixed')。 */
export async function violationTotals(p: Project): Promise<{ total: number; autofixed: number }> {
  const rows = await p.pdb.k.selectFrom("rule_violations").select("handled").where("project_id", "in", scopeIds(p.pdb)).execute();
  return { total: rows.length, autofixed: rows.filter((r) => r.handled === "autofixed").length };
}

/** レビューの指摘に載せる違反(handled = 'review'で、直っておらず、まだ指摘にしていないもの)。指摘にしたかは違反の番号で覚える。 */
export async function reviewFindingsFor(p: Project, ticketId: number): Promise<{ violationId: number; category: string; severity: "medium"; blocking: true; basis: "acceptance"; body: string }[]> {
  const open = await openViolations(p, ticketId, "review");
  const listed = await Promise.all(open.map(async (v) => !!(await p.setting(`rule_listed:${v.id}`))));
  return open.filter((_, i) => !listed[i]).map((v) => ({
    violationId: v.id,
    category: "dev-rule",
    severity: "medium" as const,
    blocking: true as const,
    basis: "acceptance" as const,
    body: ruleFindingBody(v.name, v.detail),
  }));
}

/** 違反を指摘にしたと覚える(同じ違反の指摘を、確かめるたびに足さない)。 */
export async function markListed(p: Project, violationId: number): Promise<void> {
  await p.setSetting(`rule_listed:${violationId}`, "1");
}

export function ruleFindingBody(name: string, detail: string): string {
  return `開発ルール「${name}」に反しています: ${detail}`;
}

/** 担当への指示に足す、守ってほしい開発ルールの一覧。無ければ空。 */
export async function rulesNote(p: Project): Promise<string> {
  const rules = (await devRules(p)).filter((r) => r.enabled);
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
  if (!(await devRules(p)).some((r) => r.enabled)) return undefined;
  const changes = await c.changes();
  const checked = await checkRules(p, { branch: c.branch, title: c.draft.title ?? c.defaultTitle, body: c.draft.body ?? c.draft.summary, ...changes }, c.judge);
  await recordViolations(p, c.ticket.id, c.runId, checked);
  // 持ち主が直せる違反だけを返して戻す(ブランチ名は Kuramoto が決めるので、戻さない)
  const fix = checked.found.filter((f) => f.onFail === "autofix");
  if (!fix.length) return undefined;
  return `開発ルールに反しています。直してから submit_pr を呼び直してください(PR のタイトルと本文は submit_pr の title・body で、コミットは git で直します。ブランチ名は Kuramoto が決めるので変えません):\n${fix.map((f) => `- 「${f.rule.name}」: ${f.fixDetail}(守ること: ${f.rule.body})`).join("\n")}`;
}

// ---- AI が読んで確かめる ----

/** 読むルールを 1 回の起動でまとめて確かめる。道具は結果の報告だけ。ファイルも通信も使わない。 */
export function agentJudge(p: Project, harness: Harness, cwd: string, onUsage?: (u: HarnessUsage) => void): RuleJudge {
  return async (rules, subject) => {
    const policy = await p.policy("review");
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
