import { all, get, run } from "../db/sqlite.js";
import type { ProgressEvent } from "../harness/types.js";
import type { Project } from "./project.js";

/** 生きている合図は頻繁に来るので、DB に書くのはこの間隔まで。 */
const HEARTBEAT_MS = 2_000;

/** 起動 1 回の途中経過を記録する受け口を作る。 */
export function progressRecorder(p: Project, runId: number): (e: ProgressEvent) => void {
  let lastBeat = 0;
  run(p.db, "UPDATE runs SET last_activity_at = ?, live = ? WHERE id = ?", [p.now(), "起動しています", runId]);
  return (e) => {
    const now = p.clock.now().getTime();
    if (e.type === "heartbeat") {
      if (now - lastBeat < HEARTBEAT_MS) return;
      lastBeat = now;
      run(p.db, "UPDATE runs SET last_activity_at = ?, live = ? WHERE id = ?", [p.now(), e.text, runId]);
      return;
    }
    run(p.db, "INSERT INTO run_steps (run_id, at, kind, text) VALUES (?, ?, ?, ?)", [runId, p.now(), e.kind, e.text]);
    run(p.db, "UPDATE runs SET last_activity_at = ?, live = ? WHERE id = ?", [p.now(), e.kind === "thinking" ? "考えています" : e.text, runId]);
  };
}

export type RunWork = {
  runId: number;
  member: string;
  startedAt: string;
  lastActivityAt: string;
  live: string | null;
  steps: { at: string; kind: string; text: string }[];
};

/** 終わっていない起動の様子。 */
export function runWork(p: Project, runId: number, steps = 8): RunWork | null {
  const r = get<{ id: number; member_id: number; started_at: string; last_activity_at: string | null; live: string | null; ended_at: string | null }>(
    p.db,
    "SELECT id, member_id, started_at, last_activity_at, live, ended_at FROM runs WHERE id = ?",
    [runId],
  );
  if (!r || r.ended_at) return null;
  return {
    runId: r.id,
    member: p.member(r.member_id).name,
    startedAt: r.started_at,
    lastActivityAt: r.last_activity_at ?? r.started_at,
    live: r.live,
    steps: all<{ at: string; kind: string; text: string }>(p.db, "SELECT at, kind, text FROM run_steps WHERE run_id = ? ORDER BY id DESC LIMIT ?", [runId, steps]).reverse(),
  };
}

/** 企画スタジオの段階ごとの、今の起動(順番待ちを含む)。 */
export function planningWork(p: Project): Record<string, { state: "queued" } | ({ state: "running" } & RunWork)> {
  const out: Record<string, { state: "queued" } | ({ state: "running" } & RunWork)> = {};
  const rows = all<{ stage: string; status: string; run_id: number | null }>(
    p.db,
    `SELECT json_extract(m.payload, '$.stage') AS stage, m.status,
       (SELECT r.id FROM runs r WHERE r.message_id = m.id AND r.ended_at IS NULL ORDER BY r.id DESC LIMIT 1) AS run_id
     FROM messages m WHERE m.kind = 'plan' AND m.status IN ('pending','claimed') ORDER BY m.id`,
  );
  for (const r of rows) {
    const w = r.run_id ? runWork(p, r.run_id) : null;
    if (w) out[r.stage] = { state: "running", ...w };
    else if (!out[r.stage]) out[r.stage] = { state: "queued" };
  }
  return out;
}
