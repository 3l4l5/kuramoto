import { statfsSync } from "node:fs";
import { all } from "../db/sqlite.js";
import type { Project } from "./project.js";
import type { Workspace } from "./workspace.js";

/**
 * PC を守るための見張り(作業場所が溜まってディスクが埋まり、PC ごと止まったことへの手当て)。
 * - Slots: すべてのプロジェクトを合わせて、同時に起こすエージェントの数を絞る(npm install などが一斉に走らないように)
 * - DiskGuard: 空き容量が少ないあいだは、新しいチケットの仕事を始めない
 * - sweepWorktrees: 終わったチケットの作業場所(git worktree)を消す
 */

/** 同時に起こせるエージェントの数(プロセスで 1 つ。すべてのプロジェクトで分け合う)。 */
export class Slots {
  private used = 0;
  private readonly listeners = new Set<() => void>();
  constructor(private readonly max: () => number) {}

  free(): boolean {
    return this.used < Math.max(1, this.max());
  }
  take(): void {
    this.used++;
  }
  give(): void {
    this.used = Math.max(0, this.used - 1);
    // 空きを待っている他のプロジェクトにも、受信箱を見直させる
    for (const f of this.listeners) f();
  }
  onFree(f: () => void): void {
    this.listeners.add(f);
  }
}

/** 既定の同時実行数。KURAMOTO_MAX_RUNS で変えられる。 */
export function maxRunsFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.KURAMOTO_MAX_RUNS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 3;
}

/** 新しい仕事を始めない空き容量の下限(GB)。KURAMOTO_MIN_FREE_GB で変えられる(0 で見張らない)。 */
export function minFreeGbFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.KURAMOTO_MIN_FREE_GB);
  return env.KURAMOTO_MIN_FREE_GB !== undefined && Number.isFinite(n) && n >= 0 ? n : 15;
}

/** そのパスがあるディスクの空き容量(バイト)。 */
export function diskFreeBytes(path: string): number {
  const s = statfsSync(path);
  return Number(s.bavail) * Number(s.bsize);
}

const GB = 1024 ** 3;

/** 空き容量を見張る。調べた結果は少しのあいだ使い回す(見回りのたびに調べない)。 */
export class DiskGuard {
  private checkedAt = -Infinity;
  private freeBytes = Infinity;
  constructor(
    private readonly opts: { path: string; minFreeGb: number; free?: (path: string) => number; now?: () => number; cacheMs?: number },
  ) {}

  /** 空き容量(GB)。調べられなければ Infinity(止めない)。 */
  freeGb(): number {
    const now = this.opts.now?.() ?? Date.now();
    if (now - this.checkedAt >= (this.opts.cacheMs ?? 30_000)) {
      this.checkedAt = now;
      try {
        this.freeBytes = (this.opts.free ?? diskFreeBytes)(this.opts.path);
      } catch {
        this.freeBytes = Infinity;
      }
    }
    return this.freeBytes / GB;
  }

  /** 空きが下限を切っていれば、その説明。足りていれば undefined。 */
  low(): string | undefined {
    if (this.opts.minFreeGb <= 0) return undefined;
    const free = this.freeGb();
    if (free >= this.opts.minFreeGb) return undefined;
    return `ディスクの空きが ${free.toFixed(1)}GB しかありません(下限 ${this.opts.minFreeGb}GB)`;
  }

  /** 次に low() を呼んだときに調べ直させる(片付けた直後など)。 */
  recheck(): void {
    this.checkedAt = -Infinity;
  }
}

/**
 * 終わったチケット(merge 済み・取りやめ)の作業場所を消す。
 * 取りやめは戻せるので、開発の作業場所は push 済みで変更が残っていないときだけ消す(残すときも node_modules は消す)。
 * いま担当が動いているチケットは触らない。消した作業場所の数を返す。
 */
export async function sweepWorktrees(p: Project, ws: Workspace): Promise<number> {
  if (!ws.cleanup) return 0;
  const busy = new Set(
    all<{ ticket_id: number }>(p.db, "SELECT ticket_id FROM runs WHERE ended_at IS NULL AND ticket_id IS NOT NULL").map((r) => r.ticket_id),
  );
  let removed = 0;
  for (const t of p.tickets()) {
    if (t.stage !== "done" && t.stage !== "dropped") continue;
    if (busy.has(t.id)) continue;
    const paths = await ws.cleanup.call(ws, { ticketNumber: t.number, keepUnpushedDev: t.stage === "dropped" }).catch(() => []);
    removed += paths.length;
  }
  if (removed) p.event("system", "worktrees_removed", null, { count: removed });
  return removed;
}
