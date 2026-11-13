import { openViolations, violationsOf } from "./dev-rules.js";
import { latestComparisons } from "./design-visual.js";
import { screens } from "./planning.js";
import { all, get } from "../db/sqlite.js";
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
  const t = p.ticket(ticketId);
  const refs = JSON.parse(t.plan_refs || "{}") as { requirement?: string; screens?: string[]; design?: string[]; repo?: string };
  const requirement = get<{ code: string; name: string; acceptance: string }>(
    p.db,
    "SELECT ri.code, ri.name, ri.acceptance FROM requirement_items ri JOIN tickets t ON t.requirement_item_id = ri.id WHERE t.id = ?",
    [ticketId],
  );
  const prs = all<{ number: number; full_name: string; ci: string | null; mergeable: string | null }>(
    p.db,
    "SELECT pr.number, r.full_name, pr.ci, pr.mergeable FROM pull_requests pr JOIN repos r ON r.id = pr.repo_id WHERE pr.ticket_id = ?",
    [ticketId],
  );
  const name = (memberId: number) => p.member(memberId).name;
  const items: TimelineItem[] = [{ type: "created", at: t.created_at, title: t.title }];
  // メモは、同じ時刻の起動より先に並べる(メモを書いた直後に担当が起こされることがあるため)
  for (const n of p.notes(ticketId)) items.push({ type: "note", at: n.at, who: n.who === "lead" ? p.fixedMember("lead").name + "(リーダー)" : "あなた", body: n.body });

  for (const h of p.handoffs(ticketId)) items.push({ type: "handoff", at: h.at, role: ROLE_LABEL[h.role] ?? h.role, body: h.body });
  for (const e of all<{ at: string; actor: string; data: string }>(p.db, "SELECT at, actor, data FROM events WHERE ticket_id = ? AND type = 'kind_changed' ORDER BY id", [ticketId])) {
    const d = JSON.parse(e.data) as { from: string; to: string };
    items.push({ type: "kind_change", at: e.at, who: e.actor === "owner" ? "あなた" : e.actor, from: TICKET_KIND_LABEL[d.from as keyof typeof TICKET_KIND_LABEL] ?? d.from, to: TICKET_KIND_LABEL[d.to as keyof typeof TICKET_KIND_LABEL] ?? d.to });
  }

  for (const r of all<{ id: number; member_id: number; role: string; kind: string; model: string | null; policy_model: string; cost: number | null; tokens: number; started_at: string; ended_at: string | null; outcome: string | null; summary: string | null; error: string | null }>(
    p.db,
    `SELECT r.id, r.member_id, r.role, m.kind, r.model, pol.model AS policy_model, r.cost_usd AS cost,
       COALESCE(r.input_tokens,0) + COALESCE(r.output_tokens,0) + COALESCE(r.cache_read_tokens,0) AS tokens,
       r.started_at, r.ended_at, r.outcome, r.summary, r.error
     FROM runs r JOIN messages m ON m.id = r.message_id JOIN policies pol ON pol.id = r.policy_id WHERE r.ticket_id = ? ORDER BY r.id`,
    [ticketId],
  )) {
    const model = r.model ?? r.policy_model;
    items.push({
      type: "run",
      // 終わった起動は終わった時刻に並べる(PR やレビューの結果は起動の終わりに記録されるため)
      at: r.ended_at ?? r.started_at,
      who: name(r.member_id),
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
  for (const e of all<{ at: string; actor: string; data: string }>(p.db, "SELECT at, actor, data FROM events WHERE ticket_id = ? AND type = 'pr_submitted' ORDER BY id", [ticketId])) {
    const d = JSON.parse(e.data) as { number: number; repo: string };
    items.push({ type: "pr", at: e.at, who: e.actor, number: d.number, repo: d.repo });
  }
  for (const rv of all<{ id: number; role: string; round: number; verdict: string; created_at: string; member_id: number }>(
    p.db,
    "SELECT rv.id, rv.role, rv.round, rv.verdict, rv.created_at, r.member_id FROM reviews rv JOIN runs r ON r.id = rv.run_id WHERE rv.ticket_id = ? ORDER BY rv.id",
    [ticketId],
  )) {
    items.push({
      type: "review",
      at: rv.created_at,
      who: name(rv.member_id),
      role: ROLE_LABEL[rv.role as Role] ?? rv.role,
      round: rv.round,
      verdict: VERDICT[rv.verdict] ?? rv.verdict,
      findings: threads(p, ticketId, { reviewId: rv.id }),
    });
  }
  for (const d of all<{ id: number; question: string; options: string; recommended: number; why: string; escalated: number; choice: number | null; decided_by: string | null; decided_at: string | null }>(
    p.db,
    "SELECT * FROM decisions WHERE ticket_id = ? ORDER BY id",
    [ticketId],
  )) {
    const raised = get<{ at: string }>(p.db, "SELECT at FROM events WHERE ticket_id = ? AND type IN ('decision_raised','escalated') AND json_extract(data, '$.decision_id') = ? ORDER BY id LIMIT 1", [ticketId, d.id]);
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
  for (const c of all<{ detected_at: string; cause: string | null; resolution: string | null }>(
    p.db,
    `SELECT c.detected_at, cr.full_name || '#' || cp.number AS cause, c.resolution FROM conflicts c JOIN pull_requests pr ON pr.id = c.pr_id
     LEFT JOIN pull_requests cp ON cp.id = c.cause_pr_id LEFT JOIN repos cr ON cr.id = cp.repo_id WHERE pr.ticket_id = ? ORDER BY c.id`,
    [ticketId],
  )) {
    items.push({ type: "conflict", at: c.detected_at, cause: c.cause, resolution: c.resolution });
  }
  for (const m of all<{ created_at: string; result: string }>(p.db, "SELECT m.created_at, m.result FROM merges m JOIN pull_requests pr ON pr.id = m.pr_id WHERE pr.ticket_id = ? ORDER BY m.id", [ticketId])) {
    items.push({ type: "merge", at: m.created_at, result: m.result });
  }

  // 他の島への質問と答え(R16)
  for (const q of questionsOf(p, ticketId)) {
    items.push({
      type: "question",
      at: q.asked_at,
      from: q.from_member_id ? name(q.from_member_id) : "メンバー",
      to: q.to_target === LEAD_TARGET ? "リーダー" : q.to_target,
      body: q.body,
      routedToLead: !!q.routed_to_lead,
      noRoute: !!q.routed_to_lead && q.to_target !== LEAD_TARGET,
      answer: q.answer,
      answeredBy: q.answered_by_member_id ? name(q.answered_by_member_id) : null,
      answeredAt: q.answered_at,
    });
  }

  // 開発ルールの違反(R15)。自動で直した記録も残す
  for (const v of violationsOf(p, ticketId)) items.push({ type: "rule", at: v.created_at, rule: v.name, handled: v.handled, detail: v.detail, resolvedAt: v.resolved_at });

  // 同じ時刻なら、記録した順(配列の順)を保つ
  const timeline = items.map((x, i) => [x, i] as const).sort((a, b) => a[0].at.localeCompare(b[0].at) || a[1] - b[1]).map(([x]) => x);
  const cost = get<{ cost: number | null; tokens: number | null }>(
    p.db,
    "SELECT SUM(cost_usd) AS cost, SUM(COALESCE(input_tokens,0) + COALESCE(output_tokens,0) + COALESCE(cache_read_tokens,0)) AS tokens FROM runs WHERE COALESCE(ticket_id, about_ticket_id) = ?",
    [ticketId],
  );
  return {
    id: t.id,
    number: t.number,
    after: dependsOn(p, t.id),
    waitFor: blockers(p, t.id),
    waitMerge: mergeBlockers(p, t.id),
    unblocks: mergeUnblocks(p).get(t.id) ?? null,
    triaged: !!get<{ triaged: number }>(p.db, "SELECT triaged FROM tickets WHERE id = ?", [t.id])?.triaged,
    jiraKey: t.jira_key,
    title: t.title,
    body: t.body,
    stage: t.stage,
    kind: t.kind,
    kindLabel: TICKET_KIND_LABEL[t.kind] ?? t.kind,
    /** このチケットの今の流れ(次の工程から進む順)。開発を通ったあとは、開発より前を含まない */
    flow: (() => {
      const pipeline = pipelineOf(p.currentFormation(), t.kind, { devDone: !!t.dev_done });
      return pipeline.map((r) => ({ key: r, label: ROLE_LABEL[r], preDev: !t.dev_done && isPreDev(pipeline, r) }));
    })(),
    rounds: t.rounds,
    owner: t.owner_member_id ? name(t.owner_member_id) : null,
    requirement: requirement ?? null,
    screens: refs.screens ?? [],
    design: refs.design ?? [],
    prs,
    costUsd: cost?.cost ?? 0,
    budgetUsd: ticketBudgetUsd(p, t.id),
    ownBudget: hasOwnBudget(p, t.id),
    defaultBudgetUsd: defaultTicketBudgetUsd(p),
    tokens: cost?.tokens ?? 0,
    dropped: droppedInfo(p, t.id),
    // 「直すまで進めない」ルールに反して止まっているか(ボードの赤い札)
    ruleBlocked: openViolations(p, t.id, "blocked").map((v) => v.name),
    // 画面ごとの最新の見比べ(お手本・実装・違いの画像と、違いの割合。ADR-0034)
    designCompare: (await latestComparisons(p, t.id)).map((c) => ({ ...c, name: screens(p).get(c.screen)?.name ?? c.screen })),
    timeline,
  };
}

export type TicketView = Awaited<ReturnType<typeof ticketView>>;
