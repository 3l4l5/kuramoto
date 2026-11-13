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

async function log(p: Project, ticket: TicketRow, data: Record<string, unknown>): Promise<void> {
  console.error(`#${ticket.number} の作業場所を消せませんでした: ${JSON.stringify(data)}`);
  await p.event("system", "worktree_cleanup_failed", ticket.id, data).catch(() => undefined);
}

function errorText(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).slice(0, 300);
}
