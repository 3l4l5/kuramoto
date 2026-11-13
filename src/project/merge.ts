import { all, get, run, tx } from "../db/sqlite.js";
import { pipelineOf } from "../domain/formation.js";
import type { CiDetail, GitHub, PrStatus } from "../github/github.js";
import type { Project, TicketRow } from "./project.js";
import { createTicket, enterStage, flushFollowups, type DecisionOption } from "./workflow.js";
import { passedAt, teamCiEnabled, teamCiFindings, type TeamCiResult } from "./team-ci.js";
import { ciBlockAction, ciProbeDue, githubDown, isGithubAuthError, markCiBlocked, markCiRunning, markGithubDown } from "./outage.js";

type PrRow = { id: number; ticket_id: number; repo_id: number; number: number; head: string; full_name: string };

export type MergeResult = { result: "merged" } | { result: "conflict" | "blocked"; reason: string };

/**
 * merge する。責任者が押したとき(ADR-0013)と、チームが自動で merge するとき(ADR-0022)に使う。
 * その瞬間に「merge できるか・CI が緑か・レビュー済みか」を確かめ直し、だめなら merge せず持ち主に戻す。
 * merge できたら、残りの merge 待ちの衝突を確かめ直す。
 */
/** merge の直前にチームの CI を流すための口(ADR-0028)。 */
export type TeamCiHook = {
  run(ticket: TicketRow, repo: string, branch: string): Promise<TeamCiResult>;
  baseSha(repo: string): Promise<string>;
};

export async function ownerMerge(p: Project, gh: GitHub, ticketId: number, by: "owner" | "team" = "owner", opts: { teamCi?: TeamCiHook } = {}): Promise<MergeResult> {
  const ticket = p.ticket(ticketId);
  if (ticket.stage !== "merge") throw new Error(`チケット #${ticket.number} は merge 待ちではありません`);
  const prs = prsOf(p, ticketId);
  if (prs.length === 0) throw new Error(`チケット #${ticket.number} に PR がありません`);

  const statuses = await Promise.all(prs.map(async (pr) => [pr, await gh.prStatus(pr.full_name, pr.number)] as const));
  for (const [pr, s] of statuses) {
    snapshot(p, pr, s);
    // CI が通った PR があれば、CI は動いている
    if (s.ci === "success") markCiRunning(p, pr.full_name);
  }

  const reviewGap = unreviewedRoles(p, ticket);
  // チームの CI を使うなら、GitHub の CI は見ない(Actions は止めてある)
  const team = teamCiEnabled(p);
  for (const [pr, s] of statuses) {
    const checked = JSON.stringify({ mergeable: s.mergeable, ci: s.ci, reviewed: reviewGap.length === 0 });
    if (s.mergeable === "CONFLICTING") {
      tx(p.db, () => {
        run(p.db, "INSERT INTO merges (pr_id, result, checked, created_at) VALUES (?, 'conflict', ?, ?)", [pr.id, checked, p.now()]);
        backToOwnerForConflict(p, ticket, pr, null);
      });
      return { result: "conflict", reason: "main が先に進み、衝突しています" };
    }
    const reason =
      s.state !== "OPEN" ? `PR が ${s.state} です` : team ? (reviewGap.length ? `確認が済んでいません: ${reviewGap.join("・")}` : s.mergeable === "UNKNOWN" ? "GitHub が merge できるかをまだ計算中です" : null) : s.ci === "failure" ? await onCiFailure(p, gh, ticket, pr) : s.ci === "pending" ? "CI がまだ終わっていません" : reviewGap.length ? `確認が済んでいません: ${reviewGap.join("・")}` : s.mergeable === "UNKNOWN" ? "GitHub が merge できるかをまだ計算中です" : null;
    if (reason) {
      run(p.db, "INSERT INTO merges (pr_id, result, checked, created_at) VALUES (?, 'blocked', ?, ?)", [pr.id, checked, p.now()]);
      p.event("system", "merge_blocked", ticket.id, { reason });
      // CI の失敗は onCiFailure が持ち主に戻すか待つかを決めた。それ以外は待てば解けるので merge 待ちに置いたままにする。
      return { result: "blocked", reason };
    }
  }

  // チームの CI: 通ったときから main が進んでいれば、新しい main と合わせて流し直す(merge キューの代わり)
  if (team) {
    if (!opts.teamCi) return { result: "blocked", reason: "チームの CI を流す仕組みがありません" };
    for (const [pr] of statuses) {
      const pass = passedAt(p, ticket.id);
      const head = p.setting(`pr_sha:${ticket.id}`);
      const baseNow = await opts.teamCi.baseSha(pr.full_name).catch(() => "");
      if (pass && head && pass.sha === head && baseNow && pass.baseSha === baseNow) continue;
      const r = await opts.teamCi.run(ticket, pr.full_name, pr.head);
      if (r.ok) continue;
      run(p.db, "INSERT INTO merges (pr_id, result, checked, created_at) VALUES (?, ?, ?, ?)", [pr.id, r.conflict ? "conflict" : "blocked", JSON.stringify({ teamCi: false }), p.now()]);
      if (r.conflict) {
        tx(p.db, () => backToOwnerForConflict(p, ticket, pr, null));
        return { result: "conflict", reason: r.conflict };
      }
      const reason = r.noCommands ? "チームの CI で流すコマンドが決まっていません(プロジェクトの設定で決めてください)" : `新しい main と合わせると、チームの CI(${r.results.filter((x) => !x.ok).map((x) => x.command).join("・")})が落ちます`;
      p.event("system", "merge_blocked", ticket.id, { reason });
      if (!r.noCommands) tx(p.db, () => enterStage(p, ticket, "dev", { payload: { ci: true, team: true, sha: r.sha, findings: teamCiFindings(r) } }));
      return { result: "blocked", reason };
    }
  }

  for (const [pr] of statuses) {
    await gh.merge(pr.full_name, pr.number);
    run(p.db, "INSERT INTO merges (pr_id, result, checked, created_at) VALUES (?, 'merged', ?, ?)", [pr.id, JSON.stringify({ ok: true }), p.now()]);
  }
  p.setStage(ticket.id, "done");
  p.event(by, "merged", ticket.id, { number: ticket.number, by });
  // 確認で見つかった範囲外のことは、merge したときにまとめて別チケットにする
  await flushFollowups(p, ticket);

  await recheckConflicts(p, gh, prs);
  return { result: "merged" };
}

/**
 * CI が落ちていた(ADR-0027)。エージェントの作業場所からは GitHub が見えないので、Kuramoto がログを取ってきて決める。
 * - main でも同じ確認が落ちているなら、この PR のせいではない。持ち主に戻さず、main の CI を直すチケットを 1 枚だけ作って待つ
 * - 同じコミットで初めて落ちたなら、一時的な失敗かもしれないので、落ちたジョブを 1 回だけやり直して待つ
 * - それでも落ちるなら、落ちた確認とログを持ち主に渡して直させる
 * @returns merge しなかった理由
 */
async function onCiFailure(p: Project, gh: GitHub, ticket: TicketRow, pr: PrRow): Promise<string> {
  let detail: CiDetail | undefined;
  try {
    detail = await gh.ciDetail?.(pr.full_name, pr.number);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (isGithubAuthError(msg)) throw e;
    p.event("system", "ci_detail_failed", ticket.id, { error: msg.slice(0, 300) });
  }
  if (detail) p.setSetting(`ci_failure:${ticket.id}`, JSON.stringify(detail));
  const names = detail?.failing.map((f) => f.name) ?? [];
  const runIds = [...new Set(detail?.failing.flatMap((f) => (f.runId ? [f.runId] : [])) ?? [])];
  // ジョブが始まってもいない(請求・上限・ランナーなど、コードの外)。持ち主にも main の CI を直すチケットにも回さず、責任者に 1 回だけ知らせて待つ
  if (detail?.failing.length && detail.failing.every((f) => f.started === false)) {
    const notes = [...new Set(detail.failing.flatMap((f) => f.notes ?? []))];
    markCiBlocked(p, pr.full_name, notes, runIds);
    // 間を空けて、直ったかを確かめるためにやり直す
    for (const id of ciProbeDue(p, pr.full_name)) await gh.rerunFailed?.(pr.full_name, id).catch(() => undefined);
    return `CI のジョブが始まっていません(GitHub 側の原因)。${ciBlockAction(notes)}`;
  }
  // ジョブが動いている(落ちてはいる)なら、CI そのものは動いている
  if (detail?.failing.some((f) => f.started)) markCiRunning(p, pr.full_name);
  const onBase = detail ? names.filter((n) => detail.baseFailing.includes(n)) : [];
  if (detail && onBase.length) {
    const fixer = await ensureBaseCiTicket(p, ticket, pr, detail, onBase);
    p.event("system", "ci_red_on_base", ticket.id, { checks: onBase, fixer: fixer.number });
    return `${detail.base} でも同じ CI(${onBase.join("・")})が落ちています。#${fixer.number} で直してから merge します`;
  }
  const key = `ci_rerun:${ticket.id}`;
  if (detail && gh.rerunFailed && runIds.length && p.setting(key) !== detail.headSha) {
    p.setSetting(key, detail.headSha);
    for (const id of runIds) await gh.rerunFailed(pr.full_name, id).catch(() => undefined);
    p.event("system", "ci_rerun", ticket.id, { checks: names });
    return `CI(${names.join("・")})が落ちたので、一時的な失敗でないかを確かめるために、落ちたジョブを 1 回やり直しています`;
  }
  tx(p.db, () => enterStage(p, ticket, "dev", { payload: { ci: true, ...(detail ? { sha: detail.headSha } : {}), findings: ciFindings(detail) } }));
  return `CI${names.length ? `(${names.join("・")})` : ""}が失敗しています。ログを渡して持ち主に直してもらいます`;
}

/** 落ちた確認とログを、持ち主への指示にする。同じ実行のログは 1 回だけ載せる。 */
export function ciFindings(detail: CiDetail | undefined): { severity: string; body: string }[] {
  if (!detail?.failing.length) return [{ severity: "high", body: "CI が失敗しています(Kuramoto からも、どの確認が落ちたか・ログを取れませんでした)。手元で lint・型・テストを動かして確かめ、直してください。" }];
  const shown = new Set<number>();
  return detail.failing.map((f) => {
    const log = f.runId && !shown.has(f.runId) && f.log ? f.log : "";
    if (f.runId) shown.add(f.runId);
    return {
      severity: "high",
      body: `CI の「${f.name}」が落ちています${f.link ? `(${f.link})` : ""}。${f.failedStep ? `落ちたステップ: ${f.failedStep}。` : ""}${f.notes?.length ? `\nGitHub の注記: ${f.notes.join(" / ")}` : ""}${log ? `\n失敗したステップのログ(末尾。Kuramoto が取ってきたもの):\n\`\`\`\n${log}\n\`\`\`` : f.runId ? "(ログは上と同じ実行のもの)" : ""}`,
    };
  });
}

/** 最後に落ちた CI(Kuramoto が取ってきたもの)。リーダーに見せる。無ければ空。 */
export function lastCiFailure(p: Project, ticketId: number, maxChars = 3000): string {
  const v = p.setting(`ci_failure:${ticketId}`);
  if (!v) return "";
  const d = JSON.parse(v) as CiDetail;
  const text = ciFindings(d).map((f) => `- ${f.body}`).join("\n");
  return `## 最後に落ちた CI(コミット ${d.headSha.slice(0, 7)}。ログは Kuramoto が GitHub から取ってきたもの。エージェントからは GitHub は見えません)\n${d.baseFailing.length ? `${d.base} でも落ちている確認: ${d.baseFailing.join("・")}\n` : ""}${text.length > maxChars ? `${text.slice(0, maxChars)}…` : text}`;
}

/** main の CI を直すチケット。開いているものがあればそれを使い、無ければ 1 枚だけ作る。 */
async function ensureBaseCiTicket(p: Project, from: TicketRow, pr: PrRow, detail: CiDetail, checks: string[]): Promise<TicketRow> {
  const open = get<TicketRow>(p.db, "SELECT * FROM tickets WHERE stage NOT IN ('done','dropped') AND json_extract(plan_refs, '$.baseCi') = ? ORDER BY number LIMIT 1", [pr.full_name]);
  if (open) return open;
  const logs = ciFindings({ ...detail, failing: detail.failing.filter((f) => checks.includes(f.name)) })
    .map((f) => f.body)
    .join("\n\n");
  return createTicket(p, {
    title: `${detail.base} の CI を直す(${checks.join("・")})`,
    body: `${detail.base} の最新のコミットで、CI の ${checks.map((c) => `「${c}」`).join("・")} が落ちています。このままでは、どの PR も CI が通らず merge できません(最初に見つけたのは #${from.number} の PR #${pr.number})。\n\n受け入れ条件: ${detail.base} で落ちている確認が通ること。原因がワークフローの設定・秘密情報など、コードの外にあるなら、そう分かった時点で報告すること。\n\n${logs}`,
    planRefs: { repo: pr.full_name, baseCi: pr.full_name },
  });
}

/** merge が終わったのをきっかけに、残りの merge 待ちの衝突を確かめ直す。 */
export async function recheckConflicts(p: Project, gh: GitHub, causes: PrRow[]): Promise<number> {
  const waiting = p.tickets().filter((t) => t.stage === "merge");
  let n = 0;
  for (const t of waiting) {
    for (const pr of prsOf(p, t.id)) {
      const s = await gh.prStatus(pr.full_name, pr.number);
      snapshot(p, pr, s);
      if (s.mergeable !== "CONFLICTING") continue;
      const cause = causes.find((c) => c.repo_id === pr.repo_id) ?? null;
      tx(p.db, () => backToOwnerForConflict(p, t, pr, cause));
      n++;
      break;
    }
  }
  return n;
}

function backToOwnerForConflict(p: Project, ticket: TicketRow, pr: PrRow, cause: PrRow | null): void {
  run(p.db, "INSERT INTO conflicts (pr_id, cause_pr_id, detected_at) VALUES (?, ?, ?)", [pr.id, cause?.id ?? null, p.now()]);
  p.event("system", "conflict", ticket.id, { pr: pr.number, cause: cause?.number ?? null });
  enterStage(p, ticket, "dev", { payload: { conflict: true, cause: cause ? `${cause.full_name}#${cause.number}` : "main の更新" } });
}

function snapshot(p: Project, pr: PrRow, s: PrStatus): void {
  run(p.db, "UPDATE pull_requests SET gh_state = ?, mergeable = ?, ci = ?, fetched_at = ? WHERE id = ?", [s.state, s.mergeable, s.ci, p.now(), pr.id]);
}

function prsOf(p: Project, ticketId: number): PrRow[] {
  return all(p.db, "SELECT pr.*, r.full_name FROM pull_requests pr JOIN repos r ON r.id = pr.repo_id WHERE pr.ticket_id = ? ORDER BY pr.id", [ticketId]);
}

/**
 * 確認が済んでいない工程。確認を受けた工程は、最後の結果が approve か、その後に「今の形で通す」と決まっている必要がある。
 * 今の編成に確認の工程があるのに 1 度も確認を受けていなければ、それも済んでいないとみなす。
 */
function unreviewedRoles(p: Project, ticket: TicketRow): string[] {
  const reviews = all<{ role: string; verdict: string; created_at: string }>(p.db, "SELECT role, verdict, created_at FROM reviews WHERE ticket_id = ? ORDER BY id", [ticket.id]);
  const passes = all<{ options: string; choice: number; decided_at: string }>(
    p.db,
    "SELECT options, choice, decided_at FROM decisions WHERE ticket_id = ? AND decided_at IS NOT NULL",
    [ticket.id],
  ).flatMap((d) => {
    const o = (JSON.parse(d.options) as DecisionOption[])[d.choice];
    return o?.action === "pass" && o.from ? [{ role: o.from as string, at: d.decided_at }] : [];
  });
  const last = new Map<string, { verdict: string; created_at: string }>();
  for (const r of reviews) last.set(r.role, r);
  const gaps = [...last].filter(([role, r]) => r.verdict !== "approve" && !passes.some((x) => x.role === role && x.at >= r.created_at)).map(([role]) => role);
  const hasChecks = pipelineOf(p.currentFormation(), ticket.kind, { devDone: true }).some((r) => r !== "dev");
  if (hasChecks && last.size === 0) gaps.push("review");
  return gaps;
}

/** チームが自動で merge するか(ADR-0022)。設定 auto_merge が "0" なら責任者が押す。既定は自動。 */
export function autoMergeEnabled(p: Project): boolean {
  return p.setting("auto_merge") !== "0";
}

/**
 * merge 待ちのチケットを、確認がすべて済み・CI が緑・衝突なしなら、チームが merge する(ADR-0022)。
 * CI の途中などで merge できないものは、間を空けて確かめ直す(GitHub に問い合わせすぎないように)。
 * @returns merge したチケットの数
 */
export async function autoMerge(p: Project, gh: GitHub, opts: { retrySec?: number; teamCi?: TeamCiHook } = {}): Promise<number> {
  if (!autoMergeEnabled(p)) return 0;
  // GitHub に入れない間は見回らない(入れるようになったらディスパッチャが再開を知らせる)
  if (githubDown(p)) return 0;
  const retryMs = (opts.retrySec ?? 60) * 1000;
  let merged = 0;
  for (const t of suggestedMergeOrder(p)) {
    // 前の merge で衝突が見つかって持ち主に戻ったものは飛ばす
    if (p.ticket(t.id).stage !== "merge") continue;
    const key = `automerge_at:${t.id}`;
    const last = p.setting(key);
    if (last && p.clock.now().getTime() - new Date(last).getTime() < retryMs) continue;
    p.setSetting(key, p.now());
    try {
      const r = await ownerMerge(p, gh, t.id, "team", { ...(opts.teamCi ? { teamCi: opts.teamCi } : {}) });
      if (r.result === "merged") merged++;
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      if (isGithubAuthError(reason)) {
        markGithubDown(p, reason);
        break;
      }
      p.event("system", "merge_blocked", t.id, { reason });
    }
  }
  return merged;
}

/**
 * merge の順番の案内。衝突しにくい順として、往復が少なく、早く完成したものから並べる。
 */
export function suggestedMergeOrder(p: Project): TicketRow[] {
  return all<TicketRow>(p.db, "SELECT * FROM tickets WHERE stage = 'merge' ORDER BY rounds, done_at, number");
}
