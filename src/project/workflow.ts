import { createHash } from "node:crypto";
import { sql } from "kysely";
import { isExhausted } from "./budget.js";
import { iso } from "../clock.js";
import { dialect } from "../db/dialect/index.js";
import { isPreDev, nextStage, pipelineOf } from "../domain/formation.js";
import { flowFor, isTicketKind, KIND_LABEL, type TicketKind } from "../domain/flow.js";
import { WORK_ROLES, type Role, type WorkRole } from "../domain/roles.js";
import { send, type MessageKind, type MessageRow } from "./inbox.js";
import type { Project, TicketRow } from "./project.js";
import type { Finding, Followup, Question, RunReport } from "./tools.js";
import { comment, lastReviewer, mustResolve, setStatus, threadText } from "./review.js";
import { teamCiFindings } from "./team-ci.js";
import { openViolations, markListed, reviewFindingsFor } from "./dev-rules.js";

/**
 * ノンストップで進めるか(ADR-0022)。設定 nonstop が "0" でなければ、戻せる判断はチームで決め、責任者には報告だけする。
 * 責任者に上げて止まるのは、戻せない操作と、責任者にしかできないこと(保留)だけ。
 */
export function nonstop(p: Project): boolean {
  return p.setting("nonstop") !== "0";
}

/**
 * 確認(レビュー・セキュリティ・QA)のやり直しで、前の会話を引き継ぐか。設定 resume_checks が "0" なら毎回新しく始める。既定は引き継ぐ。
 * 引き継ぐと前回の見立てを覚えているが、過去の会話を毎回読み直すぶんトークンを使う。
 */
export function resumeChecks(p: Project): boolean {
  return p.setting("resume_checks") !== "0";
}

/** 止まった仕事を、止まったところから続けるためのメッセージ(宛先・種類・中身)。 */
export type ResumeMessage = { toRole: Role; toMemberId: number | null; kind: MessageKind; payload: Record<string, unknown> };

/** 選択肢を選んだときの動き。無ければ答えを持ち主に返して続けさせる。 */
export type DecisionOption = {
  label: string;
  /**
   * continue: 予算を足して続ける / unlimited: このチケットの予算を無制限にして続ける / resume: 保留を解いて続ける /
   * hold: 保留して責任者に相談する / fix: 指摘を直させる / waive: 指摘(findings)を直さずに通す(意見が割れたときの裁定) /
   * pass: 今の形で通す / drop: チケットをやめる(前の版の判断にだけ残る。新しくは出さない)
   */
  action?: "continue" | "unlimited" | "resume" | "hold" | "drop" | "pass" | "fix" | "waive";
  from?: WorkRole;
  findings?: number[];
  /** continue・unlimited・resume のとき、止まったところから続けるメッセージ。 */
  resume?: ResumeMessage;
};

export type DecisionRow = {
  id: number;
  ticket_id: number;
  question: string;
  options: string;
  recommended: number;
  why: string;
  impact: string;
  reversible: number;
  escalated: number;
  deadline_at: string | null;
  decided_by: "owner" | "lead" | "timeout" | null;
  choice: number | null;
  decided_at: string | null;
  /** リーダーが責任者に上げたときの理由・聞きたいこと */
  lead_note: string | null;
};

const REVIEW_KINDS: Record<string, WorkRole> = { review: "review", sec: "sec", qa: "qa" };

/** 工程に入れる。その工程のメッセージを出すか、merge 待ちに置く。 */
export async function enterStage(p: Project, ticket: TicketRow, stage: WorkRole | "merge", extra: { toMemberId?: number | null; payload?: Record<string, unknown> } = {}): Promise<void> {
  p.setStage(ticket.id, stage);
  if (stage === "merge") {
    // 確認がすべて済んだコミットを覚えておく。この後に戻ってきても、承認のあとの変更だけを確かめればよい
    const sha = p.setting(`pr_sha:${ticket.id}`);
    if (sha) p.setSetting(`approved_sha:${ticket.id}`, sha);
    p.setSetting(`recheck:${ticket.id}`, "");
    p.event("system", "ready_to_merge", ticket.id, { number: ticket.number });
    return;
  }
  const kind: MessageKind = stage === "dev" ? (ticket.owner_member_id ? "fix" : "implement") : stage;
  // 開発より前の工程(開発を通る前で、今の流れで開発より前にある)は、受信箱は review/sec/qa のまま preDev を付ける。
  // コードを見ずにチケットの中身を読んで申し送りを残すだけで、差し戻しは無い
  const now = p.ticket(ticket.id);
  const preDev = stage !== "dev" && !now.dev_done && isPreDev(pipelineOf(p.currentFormation(), now.kind), stage);
  // 再レビューは、前にこのチケットを見た同じレビュアーに頼む(実際の PR と同じく、文脈を持っている人が見る)
  const toMemberId = extra.toMemberId !== undefined ? extra.toMemberId : stage === "dev" ? ticket.owner_member_id : await lastReviewer(p, ticket.id, stage);
  send(p, { ticketId: ticket.id, toRole: stage, kind, toMemberId, payload: { ...(extra.payload ?? {}), ...(preDev ? { preDev: true } : {}) } });
}

/** チケットが最初に入る工程。種類の流れの先頭(開発より前の工程があればそれ。島が無い・省略の工程は飛ばす)。 */
export function firstStage(p: Project, ticket: TicketRow): WorkRole {
  return pipelineOf(p.currentFormation(), ticket.kind, { devDone: !!ticket.dev_done })[0] ?? "dev";
}

/**
 * 工程を通ったので次へ。工程を進むたびに、今の編成の版と、チケットの今の種類の流れから組み立て直すので、
 * 途中で編成の版や種類が変わっても、次の工程から新しい流れで進む。開発を通ったチケットは、開発より前へ戻らない。
 * preDev: 開発より前の工程として動いていた(終えたら、流れが変わっていても開発へ進む)。
 * 今の工程が(島を外した・省略にした)今の工程の並びに無いときは、島で絞る前の流れの中でその工程の位置を探し、
 * その後ろにある工程のうち今の並びにある最初のものへ進む(流れの順を入れ替えていても、島のある工程を飛ばさない)。
 * 流れにも無いときだけ、今までの WORK_ROLES の順に頼る。
 */
export async function advance(p: Project, ticket: TicketRow, from: WorkRole, opts: { preDev?: boolean } = {}): Promise<void> {
  const t = p.ticket(ticket.id);
  const pipeline = pipelineOf(p.currentFormation(), t.kind, { devDone: !!t.dev_done });
  // 島で絞る前の流れ。開発を通っていれば開発より後ろだけ
  const whole = [...new Set(flowFor(p.currentFormation().flows, t.kind))];
  const flow = t.dev_done && whole.indexOf("dev") > 0 ? whole.slice(whole.indexOf("dev")) : whole;
  const at = flow.indexOf(from);
  let to: WorkRole | "merge";
  if (pipeline.includes(from)) to = nextStage(pipeline, from, opts);
  // 開発より前の工程を終えたら開発へ(今の流れでは開発より後ろにある・流れに無いときも、開発を飛ばさない)
  else if (opts.preDev && !t.dev_done && pipeline.includes("dev") && (at < 0 || at > flow.indexOf("dev"))) to = "dev";
  else if (at >= 0) to = flow.slice(at + 1).find((r) => pipeline.includes(r)) ?? "merge";
  else to = pipeline.find((r) => WORK_ROLES.indexOf(r) > WORK_ROLES.indexOf(from)) ?? "merge";
  await enterStage(p, t, to);
}

/** 責任者がチケットの種類を変える。変えたことをやりとりに残し、次の工程から新しい種類の流れで進む(今いる工程はそのまま)。 */
export async function setTicketKind(p: Project, ticketId: number, kind: unknown, by = "owner"): Promise<TicketRow> {
  if (!isTicketKind(kind)) throw new Error(`知らないチケットの種類です: ${String(kind)}`);
  const t = p.ticket(ticketId);
  if (t.kind === kind) return t;
  await p.pdb.update("tickets", { kind }).where("id", "=", ticketId).execute();
  p.event(by, "kind_changed", ticketId, { from: t.kind, to: kind, fromLabel: KIND_LABEL[t.kind] ?? t.kind, toLabel: KIND_LABEL[kind] });
  return p.ticket(ticketId);
}

/**
 * 起動 1 回の報告を工程に反映する。
 * @returns 報告が足りないなど、起動を失敗として扱うべきときはその理由
 */
export async function applyReport(p: Project, ctx: { msg: MessageRow; runId: number; memberId: number }, report: RunReport): Promise<string | undefined> {
  const { msg } = ctx;
  if (msg.ticket_id === null) return undefined;
  const ticket = p.ticket(msg.ticket_id);

  return p.pdb.transaction(async () => {
    switch (msg.kind) {
      case "implement":
      case "fix":
      case "answer":
        return await applyDev(p, ticket, ctx.memberId, report, JSON.parse(msg.payload) as { from?: WorkRole; conflict?: boolean; ci?: boolean; sha?: string; rules?: unknown });
      case "review":
      case "sec":
      case "qa":
        if ((JSON.parse(msg.payload) as { preDev?: boolean }).preDev) return applyHandoff(p, ticket, REVIEW_KINDS[msg.kind]!, report);
        return await applyReview(p, ticket, REVIEW_KINDS[msg.kind]!, ctx.runId, report);
      case "decide":
        return await applyLead(p, ticket, JSON.parse(msg.payload) as { decision_id: number }, report);
      case "plan":
      case "chat":
      case "triage":
      case "unstick":
      case "patrol":
        return undefined;
    }
  });
}

/** 開発より前の確認(R17)の報告。申し送りを残して次の工程へ。差し戻しは無く、往復(rounds)にも数えない。 */
async function applyHandoff(p: Project, ticket: TicketRow, role: WorkRole, report: RunReport): Promise<string | undefined> {
  if (!report.handoff) return "leave_handoff が呼ばれませんでした。チケットの中身を読んで、申し送りを残してください";
  p.addHandoff(ticket.id, role, report.handoff.body);
  await advance(p, ticket, role, { preDev: true });
  return undefined;
}

async function applyDev(p: Project, ticket: TicketRow, memberId: number, report: RunReport, payload: { from?: WorkRole; conflict?: boolean; ci?: boolean; sha?: string; rules?: unknown } = {}): Promise<string | undefined> {
  if (ticket.owner_member_id === null) {
    await p.pdb.update("tickets", { owner_member_id: memberId }).where("id", "=", ticket.id).execute();
    ticket = p.ticket(ticket.id);
  }
  if (report.question) {
    await raiseToLead(p, ticket, report.question);
    return undefined;
  }
  if (report.alreadyDone) {
    await closeAlreadyDone(p, ticket, { ...report.alreadyDone, by: p.member(memberId).name });
    return undefined;
  }
  if (!report.pr) return "submit_pr が呼ばれませんでした";
  // CI が落ちたコミットのまま出し直しても、同じように落ちて戻ってくるだけ(ADR-0027)。失敗として扱い、続けばリーダーが手助けする
  if (payload.ci && payload.sha && report.pr.sha === payload.sha)
    return `CI が落ちたコミット(${payload.sha.slice(0, 7)})から何も変わっていません。渡したログから原因を直すか、git merge origin/main で main を取り込んでから出し直してください`;
  if (payload.rules && payload.sha && report.pr.sha === payload.sha)
    return `開発ルールに反したコミット(${payload.sha.slice(0, 7)})から何も変わっていません。ルールを守るように直してから出し直してください`;
  const repo = p.repos().find((r) => r.full_name === report.pr!.repo);
  if (!repo) return `登録されていないリポジトリです: ${report.pr.repo}`;
  await dialect.upsert(p.pdb.insert("pull_requests", { ticket_id: ticket.id, repo_id: repo.id, number: report.pr.number, head: report.pr.head }), ["ticket_id", "repo_id"], ["number", "head"]).execute();
  // 開発を通った。これより前の工程には戻らない
  await p.pdb.update("tickets", { dev_done: 1 }).where("id", "=", ticket.id).execute();
  ticket = p.ticket(ticket.id);
  p.event(p.member(memberId).name, "pr_submitted", ticket.id, { number: report.pr.number, repo: report.pr.repo });
  if (report.pr.sha) p.setSetting(`pr_sha:${ticket.id}`, report.pr.sha);
  // 指摘への返事をスレッドに残す
  for (const r of report.responses ?? []) {
    await comment(p, r.findingId, { memberId, role: "dev" }, r.action, r.comment);
    await setStatus(p, r.findingId, r.action === "fixed" ? "addressed" : "disputed");
  }
  // 「直すまで進めない」開発ルール(R15)に反したまま。PR は出したが、次の工程には進めず、持ち主に戻す
  const blocked = openViolations(p, ticket.id, "blocked");
  if (blocked.length) {
    p.event("system", "rule_blocked", ticket.id, { rules: blocked.map((v) => v.name) });
    await enterStage(p, ticket, "dev", {
      payload: { rules: blocked.map((v) => ({ name: v.name, body: v.body, detail: v.detail })), ...(report.pr.sha ? { sha: report.pr.sha } : {}), ...(payload.from ? { from: payload.from } : {}) },
    });
    return undefined;
  }
  // チームの CI が落ちた(ADR-0028)。レビューに回さず、出力を付けてその場で持ち主に戻す
  if (report.teamCi && !report.teamCi.ok) {
    const r = report.teamCi;
    p.event("team_ci", "sent_back", ticket.id, { sha: r.sha });
    if (r.conflict) await enterStage(p, ticket, "dev", { payload: { conflict: true, cause: r.conflict } });
    else await enterStage(p, ticket, "dev", { payload: { ci: true, team: true, ...(report.pr.sha ? { sha: report.pr.sha } : {}), ...(payload.from ? { from: payload.from } : {}), findings: teamCiFindings(r) } });
    return undefined;
  }
  // 衝突の解き方で行き先を分ける(ADR-0013): 機械的に解けたら merge 待ちへ、ロジックに手を入れたら確認をやり直す。
  const conflict = await p.pdb.k
    .selectFrom("conflicts as c")
    .innerJoin("pull_requests as pr", "pr.id", "c.pr_id")
    .select("c.id")
    .where("c.project_id", "=", p.pdb.projectId)
    .where("pr.ticket_id", "=", ticket.id)
    .where("c.resolved_at", "is", null)
    .orderBy("c.id", "desc")
    .limit(1)
    .executeTakeFirst();
  if (conflict) {
    const resolution = report.pr.conflictResolution ?? "logic";
    await p.pdb.update("conflicts", { resolution, resolved_at: p.now() }).where("id", "=", conflict.id).execute();
    if (resolution === "mechanical") {
      await enterStage(p, ticket, "merge");
      return undefined;
    }
  }
  const pipeline = pipelineOf(p.currentFormation(), ticket.kind, { devDone: true });
  // 確認がすべて済んだあとに(衝突・CI の失敗などで)戻ってきた。確認を最初からやり直さない
  const approved = p.setting(`approved_sha:${ticket.id}`);
  if (approved && !payload.from) {
    // main を取り込んだだけ(自分の変更が無い)なら、そのまま merge 待ちへ
    if (report.pr.ownCommitsSinceApproved === 0) {
      p.event("system", "recheck_skipped", ticket.id, { reason: "main の取り込みだけ" });
      await enterStage(p, ticket, "merge");
      return undefined;
    }
    // 自分で足した変更があれば、最初の確認の工程が、承認のあとの変更だけを軽く確かめる
    const first = pipeline.find((r) => r !== "dev");
    if (first) {
      p.setSetting(`recheck:${ticket.id}`, approved);
      await enterStage(p, ticket, first);
      return undefined;
    }
  }
  // 差し戻しの直しなら、差し戻した工程(同じレビュアー)に戻す。前の工程の承認はそのまま生かす
  if (payload.from && pipeline.includes(payload.from)) {
    await enterStage(p, ticket, payload.from);
    return undefined;
  }
  await advance(p, ticket, "dev");
  return undefined;
}

async function applyReview(p: Project, ticket: TicketRow, role: WorkRole, runId: number, report: RunReport): Promise<string | undefined> {
  if (!report.review) return "submit_review が呼ばれませんでした";
  const { resolutions } = report.review;
  // 「レビューで指摘」の開発ルール(R15)の違反は、最初の確認の工程が、まだ指摘にしていないものを指摘に足す
  // (開発より前の工程は差分を見ないので、最初の確認は開発より後ろの工程から数える)
  const first = pipelineOf(p.currentFormation(), ticket.kind, { devDone: true }).find((r) => r !== "dev");
  const ruleFindings = role === first ? reviewFindingsFor(p, ticket.id) : [];
  for (const f of ruleFindings) markListed(p, f.violationId);
  const findings: Finding[] = [...report.review.findings, ...ruleFindings.map(({ violationId: _, ...f }) => f)];
  const reviewer = (await p.pdb.from("runs").select("member_id").where("id", "=", runId).executeTakeFirstOrThrow()).member_id;
  const who = { memberId: reviewer, role };
  const round = ticket.rounds + 1;

  // 前回までの指摘に答える。「直さない」に対して再オープンしたものは、意見が割れたものとして控える
  const prior = new Map((await mustResolve(p, ticket.id, role)).map((t) => [t.id, t]));
  const disputes: number[] = [];
  for (const r of resolutions) {
    const t = prior.get(r.findingId);
    if (!t) continue;
    if (r.result === "resolved") await setStatus(p, t.id, "fixed");
    else if (r.result === "accept") await setStatus(p, t.id, "wontfix");
    else {
      if (t.status === "disputed") disputes.push(t.id);
      await setStatus(p, t.id, "open");
    }
    await comment(p, t.id, who, r.result === "resolved" ? "resolved" : r.result === "accept" ? "accepted" : "reopened", r.comment ?? "");
  }
  const blocking = findings.some((f) => f.blocking !== false) || resolutions.some((r) => r.result === "reopen" && prior.has(r.findingId));
  const verdict = blocking ? "changes" : "approve";
  const reviewId = await dialect.insertedId(p.pdb.insert("reviews", { ticket_id: ticket.id, role, round, run_id: runId, verdict, created_at: p.now() }));
  await recordFindings(p, ticket.id, role, reviewId, findings, who);
  await createFollowups(p, ticket, role, report.review.followups ?? []);

  if (verdict === "approve") {
    p.event(role, "approved", ticket.id, { round });
    // 承認のあとの変更だけを確かめる軽い確認なら、ほかの工程はやり直さずに merge 待ちへ
    if (p.setting(`recheck:${ticket.id}`)) await enterStage(p, ticket, "merge");
    else await advance(p, ticket, role);
    return undefined;
  }

  await p.pdb.update("tickets", { rounds: sql`rounds + 1` }).where("id", "=", ticket.id).execute();
  ticket = p.ticket(ticket.id);
  p.event(role, "changes_requested", ticket.id, { round: ticket.rounds, findings: findings.length, reopened: resolutions.filter((r) => r.result === "reopen").length });

  // 意見が割れた(開発は直さないと言い、レビュアーはまだと言う)。リーダーが裁定する
  if (disputes.length) {
    const texts = disputes.map((id) => {
      const t = prior.get(id)!;
      const devSaid = [...t.comments].reverse().find((c) => c.action === "wontfix")?.body ?? "";
      const reSaid = resolutions.find((r) => r.findingId === id)?.comment ?? "";
      return `指摘 ${id}: ${t.body}\n  開発: ${devSaid}\n  ${ROLE_TEXT[role]}: ${reSaid || "(まだ直っていない)"}`;
    });
    await raiseToLead(
      p,
      ticket,
      {
        context: `チケット #${ticket.number}「${ticket.title}」の${ROLE_TEXT[role]}`,
        question: `開発と${ROLE_TEXT[role]}で意見が割れています。指摘どおり直させますか?`,
        options: ["指摘どおり直させる", "開発の言い分を通す(直さない)"],
        recommended: 0,
        why: "指摘が正しければ、後で直すほど手戻りが大きくなるため",
        impact: texts.join("\n"),
        reversible: true,
      },
      [
        { label: "指摘どおり直させる", action: "fix", from: role },
        { label: "開発の言い分を通す(直さない)", action: "waive", from: role, findings: disputes },
      ],
    );
    return undefined;
  }

  const limit = Math.max(1, Number(p.policyOption("review", "escalateAfterRounds", 2)));
  if (ticket.rounds % limit === 0) {
    await raiseToLead(p, ticket, {
      context: `チケット #${ticket.number}「${ticket.title}」のレビュー`,
      question: `レビューの往復が ${ticket.rounds} 回に達しました。どう進めますか?`,
      options: ["指摘を直して続ける", "今の形で通す", "保留して責任者に相談する"],
      recommended: 0,
      why: "指摘が残ったまま通すと、後の手戻りが大きくなりやすいため",
      // 新しい指摘だけでなく、まだ直っていない(差し戻し直した)前の指摘も載せる。無いと判断する人が中身を見られない
      impact: (await mustResolve(p, ticket.id, role)).map(threadText).join("\n") || findings.map((f) => `[${f.severity}] ${f.body}`).join("\n") || "(残っている指摘はありません)",
      reversible: true,
    }, [
      { label: "指摘を直して続ける", action: "fix", from: role },
      { label: "今の形で通す", action: "pass", from: role },
      { label: "保留して責任者に相談する", action: "hold", from: role },
    ]);
    return undefined;
  }
  await enterStage(p, ticket, "dev", { payload: { from: role } });
  return undefined;
}

const ROLE_TEXT: Record<string, string> = { review: "レビュー", sec: "セキュリティ", qa: "QA" };

/**
 * チケットの範囲外の指摘(followups)を受け取る。PR は止めない。
 * - すでに同じことを扱うチケット(existing)があれば、新しく作らずそのチケットにメモとして足す。
 * - 無ければ控えておき、この PR が merge されたとき(flushFollowups)にまとめて 1 回だけ別チケットにする。
 *   確認をやり直すたびに同じ指摘が出ても、merge までに 1 つにまとまる(同じタイトルは 1 つにする)。
 */
async function createFollowups(p: Project, from: TicketRow, role: WorkRole, followups: Followup[]): Promise<void> {
  const key = `pending_followups:${from.id}`;
  const pending = JSON.parse(p.setting(key) || "[]") as (Followup & { role: string })[];
  for (const f of followups) {
    const title = f.title.trim();
    if (!title) continue;
    const existing = f.existing ? ((await p.pdb.from("tickets").where("number", "=", f.existing).where("stage", "not in", ["done", "dropped"]).executeTakeFirst()) as TicketRow | undefined) : undefined;
    if (existing && existing.id !== from.id) {
      p.addNote(existing.id, `【#${from.number} の${ROLE_TEXT[role] ?? role}から】${title}\n${f.body.trim()}`, "lead");
      p.event(role, "followup_noted", existing.id, { number: existing.number, from: from.number, title });
      continue;
    }
    if (pending.some((x) => x.title === title)) continue;
    pending.push({ title, body: f.body, role });
  }
  p.setSetting(key, JSON.stringify(pending));
}

/** merge されたチケットの、控えておいた followups を別チケットにする。同じタイトルのチケットが既にあれば作らない。 */
export async function flushFollowups(p: Project, from: TicketRow): Promise<void> {
  const key = `pending_followups:${from.id}`;
  const pending = JSON.parse(p.setting(key) || "[]") as (Followup & { role: string })[];
  p.setSetting(key, "[]");
  for (const f of pending) {
    const title = f.title;
    const role = f.role;
    if (await p.pdb.from("tickets").select("id").where("title", "=", title).executeTakeFirst()) continue;
    const refs = JSON.parse((await p.pdb.from("tickets").select("plan_refs").where("id", "=", from.id).executeTakeFirst())?.plan_refs ?? "{}") as { repo?: string };
    const t = await createTicket(p, {
      title,
      body: `${f.body.trim()}\n\n---\n#${from.number}「${from.title}」の${ROLE_TEXT[role] ?? role}で見つかった、チケットの範囲外のこと。`,
      ...(refs.repo ? { planRefs: { repo: refs.repo, followupOf: from.number } } : { planRefs: { followupOf: from.number } }),
    });
    p.event(role, "followup_created", t.id, { number: t.number, from: from.number, title });
  }
}

/**
 * 指摘を記録する。前の周回で開いていた指摘は「直した」にし、同じ指紋の指摘がまた出たら「再発」にする。
 */
async function recordFindings(p: Project, ticketId: number, role: string, reviewId: number, findings: Finding[], who: { memberId: number; role: string }): Promise<void> {
  // 前に直したはずの指摘と同じものがまた出たら「再発」
  const prior = await p.pdb.k
    .selectFrom("findings as f")
    .innerJoin("reviews as r", "r.id", "f.review_id")
    .select("f.fingerprint")
    .where("f.project_id", "=", p.pdb.projectId)
    .where("r.ticket_id", "=", ticketId)
    .where("r.role", "=", role)
    .where("r.id", "<>", reviewId)
    .execute();
  const seen = new Set(prior.map((f) => f.fingerprint));
  for (const f of findings) {
    const fp = fingerprint(f);
    const id = await dialect.insertedId(
      p.pdb.insert("findings", {
        review_id: reviewId,
        category: f.category,
        severity: f.severity,
        path: f.path ?? null,
        line: f.line ?? null,
        body: f.body,
        fingerprint: fp,
        status: seen.has(fp) ? "recurred" : "open",
        blocking: f.blocking === false ? 0 : 1,
      }),
    );
    await comment(p, id, who, "raised", f.body);
  }
}

/** 指摘の指紋。行番号は直すたびにずれるので入れない。 */
export function fingerprint(f: Pick<Finding, "category" | "path" | "body">): string {
  const norm = f.body.toLowerCase().replace(/\s+/g, " ").trim();
  return createHash("sha1").update(`${f.category}|${f.path ?? ""}|${norm}`).digest("hex").slice(0, 16);
}

// ---- 判断(ADR-0006) ----

async function insertDecision(p: Project, ticket: TicketRow, q: Question, opts: { escalated: boolean; options?: DecisionOption[]; noDeadline?: boolean }): Promise<number> {
  const options: DecisionOption[] = opts.options ?? q.options.map((label) => ({ label }));
  const deadline = opts.escalated && !opts.noDeadline ? iso(new Date(p.clock.now().getTime() + p.settingNumber("decision_timeout_sec", 3600) * 1000)) : null;
  return dialect.insertedId(
    p.pdb.insert("decisions", {
      ticket_id: ticket.id,
      question: `${q.context}\n${q.question}`,
      options: JSON.stringify(options),
      recommended: q.recommended,
      why: q.why,
      impact: q.impact,
      reversible: q.reversible ? 1 : 0,
      escalated: opts.escalated ? 1 : 0,
      deadline_at: deadline,
    }),
  );
}

async function raiseToLead(p: Project, ticket: TicketRow, q: Question, options: DecisionOption[] = q.options.map((label) => ({ label }))): Promise<void> {
  const id = await insertDecision(p, ticket, q, { escalated: false, options });
  p.setStage(ticket.id, "decision");
  p.event("system", "decision_raised", ticket.id, { decision_id: id });
  send(p, { ticketId: ticket.id, toRole: "lead", kind: "decide", payload: { decision_id: id } });
}

/**
 * リーダーを通さず責任者に直接上げる(予算切れ・保留など、責任者にしか解けないとき)。
 * noDeadline なら期限を付けない(期限切れで勝手に推奨を選ばない。保留に使う)。
 */
export async function raiseToOwner(p: Project, ticketId: number, q: Omit<Question, "options">, options: DecisionOption[], opts: { noDeadline?: boolean } = {}): Promise<number> {
  const ticket = p.ticket(ticketId);
  const id = await insertDecision(p, ticket, { ...q, options: options.map((o) => o.label) }, { escalated: true, options, ...opts });
  p.setStage(ticket.id, "decision");
  p.event("system", "escalated", ticket.id, { decision_id: id });
  return id;
}

async function applyLead(p: Project, ticket: TicketRow, payload: { decision_id: number }, report: RunReport): Promise<string | undefined> {
  const d = await decision(p, payload.decision_id);
  if (report.leadDecision && !report.escalate) {
    const options = JSON.parse(d.options) as DecisionOption[];
    if (report.leadDecision.choice >= options.length) return "decide の choice が選択肢の範囲外です";
    if (!d.reversible) {
      // 戻せない判断は必ず責任者へ(ADR-0006)。リーダーが決めようとしても上げる。
      await escalate(p, d, "戻せない判断のため");
      return undefined;
    }
    const { choice, reason, note } = report.leadDecision;
    if (note?.trim()) p.addNote(ticket.id, note.trim(), "lead");
    await resolve(p, d, choice, "lead");
    p.event("lead", "decided_by_recommendation", ticket.id, { decision_id: d.id, choice, reason });
    // 止めずに進め、責任者には何をどう決めたかを報告する(違えばあとから指示できる)
    await p.pdb
      .insert("lead_messages", {
        who: "lead",
        body: `【#${ticket.number} の判断】「${d.question.split("\n").pop()}」は「${options[choice]!.label}」に決めました。\n理由: ${reason}${note?.trim() ? `\n担当への指示: ${note.trim()}` : ""}\n違えば、チャットかチケットのメモで教えてください。`,
        at: p.now(),
      })
      .execute();
    return undefined;
  }
  if (report.escalate) {
    await escalate(p, d, report.escalate.reason);
    return undefined;
  }
  return "decide も escalate_to_owner も呼ばれませんでした";
}

async function escalate(p: Project, d: DecisionRow, reason: string): Promise<void> {
  const deadline = iso(new Date(p.clock.now().getTime() + p.settingNumber("decision_timeout_sec", 3600) * 1000));
  // リーダーが責任者に上げた理由・聞きたいことは、判断のカードに出す
  await p.pdb.update("decisions", { escalated: 1, deadline_at: deadline, lead_note: reason.trim() || null }).where("id", "=", d.id).execute();
  p.event("lead", "escalated", d.ticket_id, { decision_id: d.id, reason });
}

export async function decision(p: Project, id: number): Promise<DecisionRow> {
  const d = (await p.pdb.from("decisions").where("id", "=", id).executeTakeFirst()) as DecisionRow | undefined;
  if (!d) throw new Error(`判断 ${id} がありません`);
  return d;
}

/** 責任者が画面で答えた。 */
/**
 * 責任者が画面で答えた。note を書いたら、チケットのメモとして残し、次に動く担当(持ち主・レビュアー)が読む。
 * リーダーの問いへの答え(版を決める・線引きをする)は、ここに書く。
 */
export async function answerDecision(p: Project, id: number, choice: number, note?: string): Promise<void> {
  await p.pdb.transaction(async () => {
    const d = await decision(p, id);
    if (d.decided_at) throw new Error("この判断はもう決まっています");
    if (!d.escalated) throw new Error("この判断はまだリーダーが見ています");
    if (choice < 0 || choice >= (JSON.parse(d.options) as unknown[]).length) throw new Error("選択肢の範囲外です");
    if (note?.trim()) p.addNote(d.ticket_id, note.trim(), "owner");
    await resolve(p, d, choice, "owner");
  });
}

/** 保留を解いて、止まったところから続ける(保留の原因が無くなったと Kuramoto が確かめたとき)。 */
export async function resumeHold(p: Project, id: number, by: "owner" | "lead"): Promise<void> {
  await p.pdb.transaction(async () => {
    const d = await decision(p, id);
    if (d.decided_at) return;
    const i = (JSON.parse(d.options) as DecisionOption[]).findIndex((o) => o.action === "resume");
    if (i >= 0) await resolve(p, d, i, by);
  });
}

/** 期限を過ぎた判断を推奨で決める。 */
export async function expireDecisions(p: Project): Promise<number> {
  const due = (await p.pdb.from("decisions").where("escalated", "=", 1).where("decided_at", "is", null).where("deadline_at", "<=", p.now()).execute()) as DecisionRow[];
  let n = 0;
  for (const d of due) {
    const options = JSON.parse(d.options) as DecisionOption[];
    // チケットをやめる・保留を解くのは、責任者が選んだときだけ。期限で勝手に選ばず、期限を外して待つ
    if (["drop", "resume", "unlimited", "continue"].includes(options[d.recommended]?.action ?? "")) {
      await p.pdb.update("decisions", { deadline_at: null }).where("id", "=", d.id).execute();
      continue;
    }
    await p.pdb.transaction(() => resolve(p, d, d.recommended, "timeout"));
    n++;
  }
  return n;
}

async function resolve(p: Project, d: DecisionRow, choice: number, by: "owner" | "lead" | "timeout"): Promise<void> {
  await p.pdb.update("decisions", { decided_by: by, choice, decided_at: p.now() }).where("id", "=", d.id).execute();
  const option = (JSON.parse(d.options) as DecisionOption[])[choice]!;
  const ticket = p.ticket(d.ticket_id);
  p.event(by, "decided", ticket.id, { decision_id: d.id, choice, label: option.label });
  if (option.action === "drop") {
    p.setStage(ticket.id, "dropped");
    await p.pdb.update("tickets", { dropped_by: by === "lead" ? "lead" : "owner", dropped_reason: `判断「${d.question.split("\n").pop()}」で「${option.label}」を選んだため`, dropped_at: p.now() }).where("id", "=", ticket.id).execute();
    return;
  }
  if (option.action === "pass" && option.from) {
    await advance(p, ticket, option.from);
    return;
  }
  if (option.action === "fix" && option.from) {
    await enterStage(p, ticket, "dev", { payload: { from: option.from } });
    return;
  }
  if (option.action === "waive" && option.from) {
    // 裁定: 割れた指摘は直さない。ほかに必須の指摘が残っていれば直しに戻し、無ければ次の工程へ
    for (const id of option.findings ?? []) {
      await setStatus(p, id, "wontfix");
      await comment(p, id, { memberId: null, role: by === "owner" ? "owner" : "lead" }, "ruled", "直さずに通す");
    }
    const left = (await mustResolve(p, ticket.id, option.from)).filter((t) => t.status === "open" || t.status === "recurred");
    if (left.length) await enterStage(p, ticket, "dev", { payload: { from: option.from } });
    else await advance(p, ticket, option.from);
    return;
  }
  if (option.action === "continue" && (await ticketExhausted(p, ticket.id))) {
    // 既定の額(無制限なら、このチケットの額)をもう 1 枚分足す
    const key = `ticket_budget_extra_usd:${ticket.id}`;
    const step = defaultTicketBudgetUsd(p) ?? ticketBaseBudgetUsd(p, ticket.id) ?? 5;
    p.setSetting(key, String(p.settingNumber(key, 0) + step));
  }
  if (option.action === "unlimited") {
    p.setSetting(`ticket_budget_usd:${ticket.id}`, "unlimited");
    await p.pdb.deleteFrom("settings").where("key", "=", `ticket_budget_extra_usd:${ticket.id}`).execute();
    p.event(by, "budget_set", ticket.id, { usd: null, own: true });
  }
  if (option.action === "hold") {
    const from = option.from ?? "review";
    await holdTicket(p, ticket.id, {
      reason: d.question,
      ownerAction: "リーダーが責任者に相談したいと判断しました。チケットの「やりとり」を見て、方針をチケットのメモに書いてから再開してください。",
      resume: { toRole: "dev", toMemberId: ticket.owner_member_id, kind: ticket.owner_member_id ? "fix" : "implement", payload: { from } },
    });
    return;
  }
  // 止まったところから続ける(保留を解いた・予算を足した)
  if (option.resume && (option.action === "continue" || option.action === "unlimited" || option.action === "resume")) {
    resumeWork(p, ticket, option.resume);
    return;
  }
  // 答えを持ち主に返し、続きから直してもらう(ADR-0005)。
  p.setStage(ticket.id, "dev");
  send(p, {
    ticketId: ticket.id,
    toRole: "dev",
    toMemberId: ticket.owner_member_id,
    kind: ticket.owner_member_id ? "answer" : "implement",
    payload: { decision_id: d.id, question: d.question, answer: option.label },
  });
}

/** 責任者の対応の一覧(判断カード)。期限の近い順。 */
export async function pendingOwnerDecisions(p: Project): Promise<DecisionRow[]> {
  return (await p.pdb.from("decisions").where("escalated", "=", 1).where("decided_at", "is", null).orderBy("deadline_at").orderBy("id").execute()) as DecisionRow[];
}

/**
 * チケット 1 枚の予算。チケットごとに決めた額(無ければプロジェクトの既定)に、「予算を足して続ける」で足した分を加える。
 * null は無制限。
 */
export function ticketBudgetUsd(p: Project, ticketId: number): number | null {
  const base = ticketBaseBudgetUsd(p, ticketId);
  return base === null ? null : base + p.settingNumber(`ticket_budget_extra_usd:${ticketId}`, 0);
}

/** 予算の設定値を読む。"unlimited"・空は無制限(null)。 */
function budgetValue(v: string | undefined, fallback: number | null): number | null {
  if (v === undefined) return fallback;
  if (v === "" || v === "unlimited") return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** チケット 1 枚の予算の既定。null は無制限。 */
export function defaultTicketBudgetUsd(p: Project): number | null {
  return budgetValue(p.setting("ticket_budget_usd"), 5);
}

export function setDefaultTicketBudget(p: Project, usd: number | null): void {
  if (usd !== null && !(Number.isFinite(usd) && usd > 0)) throw new Error("チケット 1 枚の予算は 0 より大きい金額か、無制限にしてください");
  p.setSetting("ticket_budget_usd", usd === null ? "unlimited" : String(usd));
}

/** チケットの予算を使い切っているか(残りが少なすぎて起動しても進まないときも含む)。 */
export async function ticketExhausted(p: Project, ticketId: number): Promise<boolean> {
  return isExhausted(ticketBudgetUsd(p, ticketId), await ticketSpentUsd(p, ticketId));
}

function ticketBaseBudgetUsd(p: Project, ticketId: number): number | null {
  const own = p.setting(`ticket_budget_usd:${ticketId}`);
  return own === undefined ? defaultTicketBudgetUsd(p) : budgetValue(own, defaultTicketBudgetUsd(p));
}

/** チケットごとに予算を決めているか。 */
export function hasOwnBudget(p: Project, ticketId: number): boolean {
  return p.setting(`ticket_budget_usd:${ticketId}`) !== undefined;
}

/**
 * チケットの予算を決める(null ならプロジェクトの既定に戻す)。決めた額がそのまま予算になるよう、足した分は消す。
 * 予算切れで止まっていて、新しい予算が使った額を上回るなら、止めた判断を「続ける」で閉じて仕事に戻す。
 */
export async function setTicketBudget(p: Project, ticketId: number, usd: number | null | "unlimited"): Promise<void> {
  if (usd !== null && usd !== "unlimited" && !(Number.isFinite(usd) && usd > 0)) throw new Error("予算は 0 より大きい金額にしてください");
  const ticket = p.ticket(ticketId);
  if (!ticket) throw new Error(`チケット ${ticketId} はありません`);
  await p.pdb.transaction(async () => {
    if (usd === null) await p.pdb.deleteFrom("settings").where("key", "=", `ticket_budget_usd:${ticketId}`).execute();
    else p.setSetting(`ticket_budget_usd:${ticketId}`, String(usd));
    await p.pdb.deleteFrom("settings").where("key", "=", `ticket_budget_extra_usd:${ticketId}`).execute();
    p.event("owner", "budget_set", ticketId, { usd: ticketBudgetUsd(p, ticketId), own: usd !== null });
  });
  if (await ticketExhausted(p, ticketId)) return;
  const open = (await p.pdb.from("decisions").where("ticket_id", "=", ticketId).where("decided_at", "is", null).execute()) as DecisionRow[];
  const stopped = open.find((d) => (JSON.parse(d.options) as DecisionOption[]).some((o) => o.action === "continue"));
  if (!stopped) return;
  const options = JSON.parse(stopped.options) as DecisionOption[];
  await p.pdb.transaction(() => resolve(p, stopped, options.findIndex((o) => o.action === "continue"), "owner"));
}

export async function ticketSpentUsd(p: Project, ticketId: number): Promise<number> {
  const row = await p.pdb
    .from("runs")
    .clearSelect()
    .select((eb) => eb.fn.sum<number | string | null>("cost_usd").as("s"))
    .where((eb) => eb.fn.coalesce("ticket_id", "about_ticket_id"), "=", ticketId)
    .executeTakeFirst();
  return Number(row?.s ?? 0);
}

/** チケットを作り、開発の受信箱に入れる。 */
export async function createTicket(p: Project, t: Parameters<Project["addTicket"]>[0]): Promise<TicketRow> {
  return p.pdb.transaction(async () => {
    const ticket = p.addTicket(t);
    // リーダーの交通整理を待つ(交通整理をしない設定なら、そのまま取られる)
    await p.pdb.update("tickets", { triaged: 0 }).where("id", "=", ticket.id).execute();
    // 種類の流れの先頭から始める(開発より前の工程があれば、そこから)
    await enterStage(p, ticket, firstStage(p, ticket));
    return p.ticket(ticket.id);
  });
}

// ---- 止まった仕事を続ける・保留する ----

/** 止まったところから続ける。メッセージの宛先の工程にチケットを戻し、同じ仕事をもう一度頼む。 */
export function resumeWork(p: Project, ticket: TicketRow, m: ResumeMessage): void {
  const stage = (WORK_ROLES as readonly string[]).includes(m.toRole) ? (m.toRole as WorkRole) : "dev";
  p.setStage(ticket.id, stage);
  send(p, { ticketId: ticket.id, toRole: m.toRole, toMemberId: m.toMemberId, kind: m.kind, payload: m.payload });
  p.event("system", "resumed", ticket.id, { kind: m.kind, role: m.toRole });
}

/**
 * 保留する。リーダーが手を尽くしても進まないときの最後の手。チケットはやめずに止めておき、
 * 責任者が対応して「再開する」を押すまで待つ(期限で勝手に再開しない)。待っている後のチケットも待ち続ける。
 */
/**
 * チケットの変更が、すでに main に入っていた(別のチケット・PR で先に入った、重複していた)。
 * コミットが main に入っていることは、呼ぶ前に Kuramoto が確かめておく(Workspace.landed)。
 * 待っている判断と仕事を片付け、チケットを完了にする。後に待っていたチケットはそのまま動き出す。
 */
export async function closeAlreadyDone(p: Project, ticket: TicketRow, a: { commit: string; reason: string; by: string }): Promise<void> {
  await p.pdb.transaction(async () => {
    await p.pdb.update("decisions", { decided_by: "lead", decided_at: p.now() }).where("ticket_id", "=", ticket.id).where("decided_at", "is", null).execute();
    await p.pdb.update("messages", { status: "done" }).where("ticket_id", "=", ticket.id).where("status", "=", "pending").execute();
    p.setStage(ticket.id, "merge"); // 完了の時刻を入れる
    p.setStage(ticket.id, "done");
    p.addNote(ticket.id, `【すでに main に入っていました】${a.reason}(コミット ${a.commit})`, "lead");
    await flushFollowups(p, ticket);
    p.event(a.by, "already_done", ticket.id, { commit: a.commit, reason: a.reason });
  });
}

/**
 * チケットを取りやめる(いらなくなった・重複していた)。記録は消さず、誰が・いつ・なぜ取りやめたかを残す。
 * 待っている仕事と判断を閉じる。このチケットを待っていた後のチケットは、残す方(sameAs)があればそちらを待ち、無ければ待つのをやめる。
 * 開いている PR を閉じるのは呼ぶ側(外の操作なので)。起動中でないことも呼ぶ側で確かめる。
 */
export async function dropTicket(p: Project, ticketId: number, d: { by: "lead" | "owner"; reason: string; sameAs?: TicketRow }): Promise<void> {
  const ticket = p.ticket(ticketId);
  const actor = d.by === "lead" ? p.fixedMember("lead").name : "owner";
  await p.pdb.transaction(async () => {
    await p.pdb.update("messages", { status: "done" }).where("ticket_id", "=", ticketId).where("status", "=", "pending").execute();
    await p.pdb.update("decisions", { decided_by: d.by, decided_at: p.now() }).where("ticket_id", "=", ticketId).where("decided_at", "is", null).execute();
    if (d.sameAs) {
      // 待っていたチケットは、残す方(sameAs)を待つようにつけ替える。すでに sameAs を待っているものは、そのまま(下で消える)
      const same = d.sameAs.id;
      const waiting = await p.pdb.from("ticket_deps").where("depends_on", "=", ticketId).where("ticket_id", "<>", same).execute();
      const already = new Set((await p.pdb.from("ticket_deps").where("depends_on", "=", same).execute()).map((r) => r.ticket_id));
      for (const w of waiting) if (!already.has(w.ticket_id)) await p.pdb.update("ticket_deps", { depends_on: same }).where("depends_on", "=", ticketId).where("ticket_id", "=", w.ticket_id).execute();
    }
    await p.pdb.deleteFrom("ticket_deps").where((eb) => eb.or([eb("depends_on", "=", ticketId), eb("ticket_id", "=", ticketId)])).execute();
    await p.pdb.update("tickets", { triaged: 1, dropped_by: d.by, dropped_reason: d.reason, dropped_at: p.now() }).where("id", "=", ticketId).execute();
    p.setStage(ticketId, "dropped");
    p.addNote(ticketId, `【取りやめ】${d.reason}`, d.by);
    p.event(actor, d.sameAs ? "duplicate_dropped" : "ticket_dropped", ticketId, { number: ticket.number, reason: d.reason, ...(d.sameAs ? { sameAs: d.sameAs.number } : {}) });
  });
}

/** 取りやめたチケットの、誰が・いつ・なぜ。取りやめていなければ null。 */
export async function droppedInfo(p: Project, ticketId: number): Promise<{ by: "lead" | "owner" | null; reason: string | null; at: string | null } | null> {
  const r = (await p.pdb.from("tickets").select(["stage", "dropped_by", "dropped_reason", "dropped_at"]).where("id", "=", ticketId).executeTakeFirst()) as
    | { stage: string; dropped_by: "lead" | "owner" | null; dropped_reason: string | null; dropped_at: string | null }
    | undefined;
  return r && r.stage === "dropped" ? { by: r.dropped_by, reason: r.dropped_reason, at: r.dropped_at } : null;
}

export async function holdTicket(p: Project, ticketId: number, h: { reason: string; ownerAction: string; resume: ResumeMessage }): Promise<number> {
  const ticket = p.ticket(ticketId);
  const open = await p.pdb.from("decisions").select("id").where("ticket_id", "=", ticketId).where("decided_at", "is", null).where("options", "like", '%"resume"%').executeTakeFirst();
  if (open) return open.id;
  const id = await raiseToOwner(
    p,
    ticketId,
    {
      context: `チケット #${ticket.number}「${ticket.title}」を保留しました`,
      question: h.reason,
      recommended: 0,
      why: "チームの中では解けないため、責任者の対応を待っています",
      impact: h.ownerAction,
      reversible: true,
    },
    [{ label: "対応したので再開する", action: "resume", resume: h.resume }],
    { noDeadline: true },
  );
  p.event("system", "held", ticketId, { reason: h.reason });
  return id;
}

/**
 * 取りやめたチケットを戻して、続きから進める。持ち主がいれば持ち主に、いなければ新しい実装として開発に回す。
 * 持ち主はセッションを続きから再開するので、前にしたことを覚えている。取りやめの間に溜まった判断は閉じる。
 */
export async function reopenTicket(p: Project, ticketId: number, by: "owner" | "lead" = "owner"): Promise<void> {
  const ticket = p.ticket(ticketId);
  if (!ticket) throw new Error(`チケット ${ticketId} はありません`);
  if (ticket.stage !== "dropped") throw new Error("取りやめになっていないチケットです");
  await p.pdb.transaction(async () => {
    await p.pdb.update("decisions", { decided_by: by, decided_at: p.now() }).where("ticket_id", "=", ticketId).where("decided_at", "is", null).execute();
    // 取りやめの前のメッセージが残っていても、取り出したときに捨てられているので、新しく頼み直す
    await p.pdb.update("messages", { status: "done" }).where("ticket_id", "=", ticketId).where("status", "in", ["pending", "claimed"]).execute();
    p.setStage(ticketId, "dev");
    await p.pdb.update("tickets", { dropped_by: null, dropped_reason: null, dropped_at: null }).where("id", "=", ticketId).execute();
    if (ticket.owner_member_id) {
      send(p, {
        ticketId,
        toRole: "dev",
        toMemberId: ticket.owner_member_id,
        kind: "answer",
        payload: {
          question: "このチケットは取りやめになっていました(前の版の Kuramoto が、予算切れの判断の期限切れで取りやめていました)",
          answer: "責任者が取りやめを戻しました。チケットの完成に向けて、今のブランチの続きから進めてください。終わっていれば、コミットして submit_pr で報告してください",
        },
      });
    } else {
      send(p, { ticketId, toRole: "dev", kind: "implement" });
    }
    p.event(by, "reopened", ticketId, { number: ticket.number });
  });
}
