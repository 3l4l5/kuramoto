import { all, get, run, tx } from "../db/sqlite.js";
import { pipelineOf } from "../domain/formation.js";
import type { GitHub, PrStatus } from "../github/github.js";
import type { Project, TicketRow } from "./project.js";
import { enterStage, type DecisionOption } from "./workflow.js";

type PrRow = { id: number; ticket_id: number; repo_id: number; number: number; head: string; full_name: string };

export type MergeResult = { result: "merged" } | { result: "conflict" | "blocked"; reason: string };

/**
 * merge する。責任者が押したとき(ADR-0013)と、チームが自動で merge するとき(ADR-0022)に使う。
 * その瞬間に「merge できるか・CI が緑か・レビュー済みか」を確かめ直し、だめなら merge せず持ち主に戻す。
 * merge できたら、残りの merge 待ちの衝突を確かめ直す。
 */
export async function ownerMerge(p: Project, gh: GitHub, ticketId: number, by: "owner" | "team" = "owner"): Promise<MergeResult> {
  const ticket = p.ticket(ticketId);
  if (ticket.stage !== "merge") throw new Error(`チケット #${ticket.number} は merge 待ちではありません`);
  const prs = prsOf(p, ticketId);
  if (prs.length === 0) throw new Error(`チケット #${ticket.number} に PR がありません`);

  const statuses = await Promise.all(prs.map(async (pr) => [pr, await gh.prStatus(pr.full_name, pr.number)] as const));
  for (const [pr, s] of statuses) snapshot(p, pr, s);

  const reviewGap = unreviewedRoles(p, ticket);
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
      s.state !== "OPEN" ? `PR が ${s.state} です` : s.ci === "failure" ? "CI が失敗しています" : s.ci === "pending" ? "CI がまだ終わっていません" : reviewGap.length ? `確認が済んでいません: ${reviewGap.join("・")}` : s.mergeable === "UNKNOWN" ? "GitHub が merge できるかをまだ計算中です" : null;
    if (reason) {
      run(p.db, "INSERT INTO merges (pr_id, result, checked, created_at) VALUES (?, 'blocked', ?, ?)", [pr.id, checked, p.now()]);
      p.event("system", "merge_blocked", ticket.id, { reason });
      // CI の失敗だけは持ち主が直すもの。それ以外は待てば解けるので merge 待ちに置いたままにする。
      if (s.ci === "failure") tx(p.db, () => enterStage(p, ticket, "dev", { payload: { findings: [{ severity: "high", body: "CI が失敗しています。直してください。" }] } }));
      return { result: "blocked", reason };
    }
  }

  for (const [pr] of statuses) {
    await gh.merge(pr.full_name, pr.number);
    run(p.db, "INSERT INTO merges (pr_id, result, checked, created_at) VALUES (?, 'merged', ?, ?)", [pr.id, JSON.stringify({ ok: true }), p.now()]);
  }
  p.setStage(ticket.id, "done");
  p.event(by, "merged", ticket.id, { number: ticket.number, by });

  await recheckConflicts(p, gh, prs);
  return { result: "merged" };
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
  const hasChecks = pipelineOf(p.currentFormation()).some((r) => r !== "dev");
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
export async function autoMerge(p: Project, gh: GitHub, opts: { retrySec?: number } = {}): Promise<number> {
  if (!autoMergeEnabled(p)) return 0;
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
      const r = await ownerMerge(p, gh, t.id, "team");
      if (r.result === "merged") merged++;
    } catch (e) {
      p.event("system", "merge_blocked", t.id, { reason: e instanceof Error ? e.message : String(e) });
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
