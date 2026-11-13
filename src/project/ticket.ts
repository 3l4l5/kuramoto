import { openViolations, violationsOf } from "./dev-rules.js";
import { latestComparisons } from "./design-visual.js";
import { screens } from "./planning.js";
import { inScope } from "../db/count.js";
import { KIND_LABEL as TICKET_KIND_LABEL } from "../domain/flow.js";
import { isPreDev, pipelineOf } from "../domain/formation.js";
import { MODELS, ROLE_LABEL, type Role } from "../domain/roles.js";
import type { Project } from "./project.js";
import { blockers, dependsOn, mergeBlockers, mergeUnblocks } from "./triage.js";
import { questionsOf, LEAD_TARGET } from "./questions.js";
import { threads, type Thread } from "./review.js";
import { defaultTicketBudgetUsd, droppedInfo, hasOwnBudget, ticketBudgetUsd, type DecisionOption } from "./workflow.js";

/**
 * チケットを開いたときに見せる中身。チケットの中身・ひも付く要件と画面・PR・金額と、
 * 起動・レビュー・判断・衝突・merge・責任者のメモを時刻順に並べた「やりとり」。
 */

const KIND_LABEL: Record<string, string> = { implement: "実装", fix: "直し", answer: "判断を受けて続き", review: "レビュー", sec: "セキュリティの確認", qa: "QA", decide: "判断" };
const VERDICT: Record<string, string> = { approve: "承認", changes: "差し戻し", escalate: "上げた" };

export type TimelineItem =
  | { type: "created"; at: string; title: string }
  | { type: "run"; at: string; who: string; role: string; kind: string; model: string; costUsd: number; tokens: number; ms: number | null; outcome: string | null; summary: string | null; error: string | null }
  | { type: "pr"; at: string; who: string; number: number; repo: string }
  | {
      type: "review";
      at: string;
      who: string;
      role: string;
      round: number;
      verdict: string;
      findings: Thread[];
    }
  | { type: "decision"; at: string; question: string; options: string[]; recommended: number; why: string; escalated: boolean; answer: string | null; decidedBy: string | null; decidedAt: string | null }
  | { type: "conflict"; at: string; cause: string | null; resolution: string | null }
  | { type: "merge"; at: string; result: string }
  | { type: "note"; at: string; who: string; body: string }
  /** 開発より前の確認(R17)が残した申し送り */
  | { type: "handoff"; at: string; role: string; body: string }
  /** 責任者がチケットの種類を変えた(R17) */
  | { type: "kind_change"; at: string; who: string; from: string; to: string }
  /**
   * 他の島(またはリーダー)への質問と答え(R16)。noRoute: 経路が無いのでリーダーに回した。
   * answeredAt が無ければ、まだ答えを待っている(リーダーに回したものは、リーダーが引き取る)。
   */
  | { type: "question"; at: string; from: string; to: string; body: string; routedToLead: boolean; noRoute: boolean; answer: string | null; answeredBy: string | null; answeredAt: string | null }
  | { type: "rule"; at: string; rule: string; handled: string; detail: string; resolvedAt: string | null };

export async function ticketView(p: Project, ticketId: number) {
  const t = await p.ticket(ticketId);
  const refs = JSON.parse(t.plan_refs || "{}") as { requirement?: string; screens?: string[]; design?: string[]; repo?: string };
  // 読むものは表ごとに 1 文で取り、結び付けは JS でやる(IN でまとめる)
  const [row, prRows, runRows, evs, reviewRows, decisionRows, aboutRuns] = await Promise.all([
    inScope(p.pdb, "tickets").where("id", "=", ticketId).executeTakeFirst(),
    inScope(p.pdb, "pull_requests").where("ticket_id", "=", ticketId).execute(),
    inScope(p.pdb, "runs").where("ticket_id", "=", ticketId).orderBy("id").execute(),
    inScope(p.pdb, "events").where("ticket_id", "=", ticketId).orderBy("id").execute(),
    inScope(p.pdb, "reviews").where("ticket_id", "=", ticketId).orderBy("id").execute(),
    inScope(p.pdb, "decisions").where("ticket_id", "=", ticketId).orderBy("id").execute(),
    inScope(p.pdb, "runs").where("ticket_id", "is", null).where("about_ticket_id", "=", ticketId).execute(),
  ]);
  const prIds = prRows.map((r) => r.id);
  const [requirementRow, repoRows, messageRows, policyRows, conflictRows, mergeRows] = await Promise.all([
    row?.requirement_item_id == null ? undefined : inScope(p.pdb, "requirement_items").where("id", "=", row.requirement_item_id).executeTakeFirst(),
    prRows.length ? inScope(p.pdb, "repos").execute() : [],
    runRows.length ? inScope(p.pdb, "messages").where("id", "in", runRows.map((r) => r.message_id)).execute() : [],
    runRows.length ? inScope(p.pdb, "policies").where("id", "in", runRows.map((r) => r.policy_id)).execute() : [],
    prIds.length ? inScope(p.pdb, "conflicts").where("pr_id", "in", prIds).orderBy("id").execute() : [],
    prIds.length ? inScope(p.pdb, "merges").where("pr_id", "in", prIds).orderBy("id").execute() : [],
  ]);
  const requirement = requirementRow ? { code: requirementRow.code, name: requirementRow.name, acceptance: requirementRow.acceptance } : undefined;
  const repoName = new Map(repoRows.map((r) => [r.id, r.full_name]));
  const prs = prRows.map((pr) => ({ number: pr.number, full_name: repoName.get(pr.repo_id) ?? "", ci: pr.ci, mergeable: pr.mergeable }));
  const causeIds = conflictRows.map((c) => c.cause_pr_id).filter((x): x is number => x !== null);
  const causePrs = causeIds.length ? await inScope(p.pdb, "pull_requests").where("id", "in", causeIds).execute() : [];
  const causeRepos = causePrs.length ? await inScope(p.pdb, "repos").execute() : [];
  const tok = (r: { input_tokens: number | null; output_tokens: number | null; cache_read_tokens: number | null }) => (r.input_tokens ?? 0) + (r.output_tokens ?? 0) + (r.cache_read_tokens ?? 0);
  const name = async (memberId: number) => (await p.member(memberId)).name;
  const items: TimelineItem[] = [{ type: "created", at: t.created_at, title: t.title }];
  // メモは、同じ時刻の起動より先に並べる(メモを書いた直後に担当が起こされることがあるため)
  for (const n of await p.notes(ticketId)) items.push({ type: "note", at: n.at, who: n.who === "lead" ? (await p.fixedMember("lead")).name + "(リーダー)" : "あなた", body: n.body });

  for (const h of await p.handoffs(ticketId)) items.push({ type: "handoff", at: h.at, role: ROLE_LABEL[h.role] ?? h.role, body: h.body });
  for (const e of evs.filter((e) => e.type === "kind_changed")) {
    const d = JSON.parse(e.data) as { from: string; to: string };
    items.push({ type: "kind_change", at: e.at, who: e.actor === "owner" ? "あなた" : e.actor, from: TICKET_KIND_LABEL[d.from as keyof typeof TICKET_KIND_LABEL] ?? d.from, to: TICKET_KIND_LABEL[d.to as keyof typeof TICKET_KIND_LABEL] ?? d.to });
  }

  const kindOf = new Map(messageRows.map((m) => [m.id, m.kind]));
  const policyModel = new Map(policyRows.map((x) => [x.id, x.model]));
  for (const r of runRows.map((x) => ({ ...x, kind: kindOf.get(x.message_id) ?? "", policy_model: policyModel.get(x.policy_id) ?? "", cost: x.cost_usd, tokens: tok(x) })).filter((x) => kindOf.has(x.message_id) && policyModel.has(x.policy_id))) {
    const model = r.model ?? r.policy_model;
    items.push({
      type: "run",
      // 終わった起動は終わった時刻に並べる(PR やレビューの結果は起動の終わりに記録されるため)
      at: r.ended_at ?? r.started_at,
      who: await name(r.member_id),
      role: ROLE_LABEL[r.role as Role] ?? r.role,
      kind: KIND_LABEL[r.kind] ?? r.kind,
      model: MODELS[model as keyof typeof MODELS]?.label ?? model,
      costUsd: r.cost ?? 0,
      tokens: r.tokens,
      ms: r.ended_at ? Date.parse(r.ended_at) - Date.parse(r.started_at) : null,
      outcome: r.ended_at ? r.outcome : "running",
      summary: r.summary,
      error: r.error,
    });
  }
  for (const e of evs.filter((e) => e.type === "pr_submitted")) {
    const d = JSON.parse(e.data) as { number: number; repo: string };
    items.push({ type: "pr", at: e.at, who: e.actor, number: d.number, repo: d.repo });
  }
  const runMember = new Map(runRows.map((r) => [r.id, r.member_id]));
  for (const rv of reviewRows.filter((x) => runMember.has(x.run_id)).map((x) => ({ ...x, member_id: runMember.get(x.run_id)! }))) {
    items.push({
      type: "review",
      at: rv.created_at,
      who: await name(rv.member_id),
      role: ROLE_LABEL[rv.role as Role] ?? rv.role,
      round: rv.round,
      verdict: VERDICT[rv.verdict] ?? rv.verdict,
      findings: await threads(p, ticketId, { reviewId: rv.id }),
    });
  }
  for (const d of decisionRows) {
    const raised = evs.find((e) => (e.type === "decision_raised" || e.type === "escalated") && (JSON.parse(e.data || "{}") as { decision_id?: number }).decision_id === d.id);
    const options = (JSON.parse(d.options) as DecisionOption[]).map((o) => o.label);
    items.push({
      type: "decision",
      at: raised?.at ?? d.decided_at ?? t.created_at,
      question: d.question,
      options,
      recommended: d.recommended,
      why: d.why,
      escalated: !!d.escalated,
      answer: d.choice === null ? null : (options[d.choice] ?? null),
      decidedBy: d.decided_by,
      decidedAt: d.decided_at,
    });
  }
  const causePr = new Map(causePrs.map((x) => [x.id, `${causeRepos.find((r) => r.id === x.repo_id)?.full_name ?? ""}#${x.number}`]));
  for (const c of conflictRows.map((x) => ({ detected_at: x.detected_at, cause: x.cause_pr_id === null ? null : (causePr.get(x.cause_pr_id) ?? null), resolution: x.resolution }))) {
    items.push({ type: "conflict", at: c.detected_at, cause: c.cause, resolution: c.resolution });
  }
  for (const m of mergeRows) {
    items.push({ type: "merge", at: m.created_at, result: m.result });
  }

  // 他の島への質問と答え(R16)
  for (const q of await questionsOf(p, ticketId)) {
    items.push({
      type: "question",
      at: q.asked_at,
      from: q.from_member_id ? await name(q.from_member_id) : "メンバー",
      to: q.to_target === LEAD_TARGET ? "リーダー" : q.to_target,
      body: q.body,
      routedToLead: !!q.routed_to_lead,
      noRoute: !!q.routed_to_lead && q.to_target !== LEAD_TARGET,
      answer: q.answer,
      answeredBy: q.answered_by_member_id ? await name(q.answered_by_member_id) : null,
      answeredAt: q.answered_at,
    });
  }

  // 開発ルールの違反(R15)。自動で直した記録も残す
  for (const v of await violationsOf(p, ticketId)) items.push({ type: "rule", at: v.created_at, rule: v.name, handled: v.handled, detail: v.detail, resolvedAt: v.resolved_at });

  // 同じ時刻なら、記録した順(配列の順)を保つ
  const timeline = items.map((x, i) => [x, i] as const).sort((a, b) => a[0].at.localeCompare(b[0].at) || a[1] - b[1]).map(([x]) => x);
  const costRuns = [...runRows, ...aboutRuns];
  const cost = { cost: costRuns.length ? costRuns.reduce((x, r) => x + (r.cost_usd ?? 0), 0) : null, tokens: costRuns.length ? costRuns.reduce((x, r) => x + tok(r), 0) : null };
  return {
    id: t.id,
    number: t.number,
    after: await dependsOn(p, t.id),
    waitFor: await blockers(p, t.id),
    waitMerge: await mergeBlockers(p, t.id),
    unblocks: (await mergeUnblocks(p)).get(t.id) ?? null,
    triaged: !!row?.triaged,
    jiraKey: t.jira_key,
    title: t.title,
    body: t.body,
    stage: t.stage,
    kind: t.kind,
    kindLabel: TICKET_KIND_LABEL[t.kind] ?? t.kind,
    /** このチケットの今の流れ(次の工程から進む順)。開発を通ったあとは、開発より前を含まない */
    flow: await (async () => {
      const pipeline = pipelineOf(await p.currentFormation(), t.kind, { devDone: !!t.dev_done });
      return pipeline.map((r) => ({ key: r, label: ROLE_LABEL[r], preDev: !t.dev_done && isPreDev(pipeline, r) }));
    })(),
    rounds: t.rounds,
    owner: t.owner_member_id ? await name(t.owner_member_id) : null,
    requirement: requirement ?? null,
    screens: refs.screens ?? [],
    design: refs.design ?? [],
    prs,
    costUsd: cost?.cost ?? 0,
    budgetUsd: await ticketBudgetUsd(p, t.id),
    ownBudget: await hasOwnBudget(p, t.id),
    defaultBudgetUsd: await defaultTicketBudgetUsd(p),
    tokens: cost?.tokens ?? 0,
    dropped: await droppedInfo(p, t.id),
    // 「直すまで進めない」ルールに反して止まっているか(ボードの赤い札)
    ruleBlocked: (await openViolations(p, t.id, "blocked")).map((v) => v.name),
    // 画面ごとの最新の見比べ(お手本・実装・違いの画像と、違いの割合。ADR-0034)
    designCompare: await (async () => {
      const scr = await screens(p);
      return (await latestComparisons(p, t.id)).map((c) => ({ ...c, name: scr.get(c.screen)?.name ?? c.screen }));
    })(),
    timeline,
  };
}

export type TicketView = Awaited<ReturnType<typeof ticketView>>;
