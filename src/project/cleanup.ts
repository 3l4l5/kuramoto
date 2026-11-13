import { sql, type SqlBool } from "kysely";
import type { Project, TicketRow } from "./project.js";
import type { Workspace } from "./workspace.js";

/**
 * merge で done になったチケットの作業場所(worktree)を、すべての役割ぶん消し、DB の worktree_path の記録も外す。
 * 消すのは Kuramoto の後始末であって merge の成否には関係しないので、何があっても投げない。消せなかったものは events に残して先へ進む。
 * 作業中のチケットや、リーダー用(plan-<役割>)の作業場所は、Workspace.removeTicketWorktrees が番号で絞っているので触らない。
 */
export async function releaseWorktrees(p: Project, workspace: Workspace | undefined, ticket: TicketRow, repos: string[]): Promise<void> {
  try {
    // 消した作業場所を指したままにしない。作業場所が無い環境(workspace なし)でも記録は外す
    await p.pdb.update("sessions", { worktree_path: null }).where("ticket_id", "=", ticket.id).execute();
  } catch (e) {
    console.error(`#${ticket.number} の worktree_path を外せませんでした: ${errorText(e)}`);
  }
  if (!workspace?.removeTicketWorktrees) return;
  for (const repo of new Set(repos)) {
    try {
      const r = await workspace.removeTicketWorktrees(repo, ticket.number);
      if (r.failed.length) await log(p, ticket, { repo, failed: r.failed });
    } catch (e) {
      await log(p, ticket, { repo, failed: [{ path: "", error: errorText(e) }] });
    }
  }
}

/**
 * merge を通らずに終わったチケット(すでに main に入っていた=closeAlreadyDone・取りやめ=dropTicket)の作業場所を片付ける。
 * done / dropped で、まだ worktree_path が残っているチケットを探して releaseWorktrees にかける(片付けると worktree_path が外れるので、一度きり)。
 * 終わらせる道がいくつもある(開発・リーダーの手助け・見回り・交通整理・CI の取りやめ)ので、道ごとではなくここでまとめて拾う。
 * 起動中のチケットには触らない(リーダーの手助けは、このチケットの番号の作業場所の中で動いているため)。取りやめを戻して
 * 工程が変わっていたら片付けない。消すのは作業場所だけで、ブランチ(push 済み)は残るので、戻したときは取り出し直せる。
 * @returns 片付けたチケットの数
 */
export async function releaseFinishedWorktrees(p: Project, workspace: Workspace | undefined): Promise<number> {
  const rows = await p.pdb.k
    .selectFrom("tickets as t")
    .innerJoin("sessions as s", "s.ticket_id", "t.id")
    .select("t.id")
    .distinct()
    .where("t.project_id", "=", p.projectId)
    .where("s.project_id", "=", p.projectId)
    .where("t.stage", "in", ["done", "dropped"])
    .where("s.worktree_path", "is not", null)
    .where(sql<SqlBool>`NOT EXISTS (SELECT 1 FROM runs r WHERE r.ticket_id = t.id AND r.ended_at IS NULL AND r.project_id = ${p.projectId})`)
    .execute();
  if (!rows.length) return 0;
  const repos = (await p.repos()).map((r) => r.full_name);
  let n = 0;
  for (const { id } of rows) {
    const ticket = await p.ticket(id);
    if (ticket.stage !== "done" && ticket.stage !== "dropped") continue;
    await releaseWorktrees(p, workspace, ticket, repos);
    n++;
  }
  return n;
}

async function log(p: Project, ticket: TicketRow, data: Record<string, unknown>): Promise<void> {
  console.error(`#${ticket.number} の作業場所を消せませんでした: ${JSON.stringify(data)}`);
  await p.event("system", "worktree_cleanup_failed", ticket.id, data).catch(() => undefined);
}

function errorText(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).slice(0, 300);
}
