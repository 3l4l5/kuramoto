import type { ProgressEvent } from "../harness/types.js";
import type { Project } from "./project.js";

/** 生きている合図は頻繁に来るので、DB に書くのはこの間隔まで。 */
const HEARTBEAT_MS = 2_000;

/**
 * 起動 1 回の途中経過を記録する受け口を作る。
 * ハーネスは同期の関数として呼ぶので、書き込みは順番に 1 本ずつ流す(呼ばれた順に DB へ入る)。
 * 起動を終える前に flush() を await して、書き込みが済んでいることを確かめる。書き込みの失敗は flush() で投げる。
 */
export type ProgressRecorder = ((e: ProgressEvent) => void) & { flush(): Promise<void> };

export function progressRecorder(p: Project, runId: number): ProgressRecorder {
  let lastBeat = 0;
  let queue: Promise<void> = Promise.resolve();
  let failure: unknown;
  const enqueue = (job: () => Promise<void>) => {
    queue = queue.then(job).catch((e) => {
      failure ??= e;
    });
  };
  const touch = (live: string, at: string) => p.pdb.update("runs", { last_activity_at: at, live }).where("id", "=", runId).execute().then(() => {});
  const startAt = p.now();
  enqueue(() => touch("起動しています", startAt));
  const record = (e: ProgressEvent) => {
    const now = p.clock.now().getTime();
    if (e.type === "heartbeat") {
      if (now - lastBeat < HEARTBEAT_MS) return;
      lastBeat = now;
      const beatAt = p.now();
      enqueue(() => touch(e.text, beatAt));
      return;
    }
    const at = p.now();
    enqueue(async () => {
      await p.pdb.insert("run_steps", { run_id: runId, at, kind: e.kind, text: e.text }).execute();
      await touch(e.kind === "thinking" ? "考えています" : e.text, at);
    });
  };
  return Object.assign(record, {
    async flush() {
      await queue;
      if (failure !== undefined) throw failure;
    },
  });
}

export type RunWork = {
  runId: number;
  member: string;
  startedAt: string;
  lastActivityAt: string;
  live: string | null;
  steps: { at: string; kind: string; text: string }[];
};

type RunStepRow = { run_id: number; at: string; kind: string; text: string };

/** 終わっていない起動の様子(複数まとめて。起動の id → 様子。終わった起動・無い id は入らない)。 */
export async function runWorks(p: Project, runIds: number[], steps = 8): Promise<Map<number, RunWork>> {
  const out = new Map<number, RunWork>();
  const ids = [...new Set(runIds)];
  if (!ids.length) return out;
  const runs = await p.pdb.from("runs").select(["id", "member_id", "started_at", "last_activity_at", "live", "ended_at"]).where("id", "in", ids).execute();
  const open = runs.filter((r) => !r.ended_at);
  if (!open.length) return out;
  // 起動ごとに新しい方から steps 件。起動の数だけ引かず、1 回でまとめて引いて振り分ける(steps 件ずつに絞るのは、取れた行の上で)
  const rows = (await p.pdb
    .from("run_steps")
    .select(["run_id", "at", "kind", "text"])
    .where("run_id", "in", open.map((r) => r.id))
    .orderBy("id", "desc")
    .execute()) as RunStepRow[];
  const by = new Map<number, RunStepRow[]>();
  for (const s of rows) {
    const list = by.get(s.run_id) ?? [];
    if (list.length < steps) list.push(s);
    by.set(s.run_id, list);
  }
  for (const r of open) {
    out.set(r.id, {
      runId: r.id,
      member: p.member(r.member_id).name,
      startedAt: r.started_at,
      lastActivityAt: r.last_activity_at ?? r.started_at,
      live: r.live,
      steps: (by.get(r.id) ?? []).map(({ at, kind, text }) => ({ at, kind, text })).reverse(),
    });
  }
  return out;
}

/** 終わっていない起動の様子。 */
export async function runWork(p: Project, runId: number, steps = 8): Promise<RunWork | null> {
  return (await runWorks(p, [runId], steps)).get(runId) ?? null;
}

/** 企画スタジオの段階ごとの、今の起動(順番待ちを含む)。 */
export async function planningWork(p: Project): Promise<Record<string, { state: "queued" } | ({ state: "running" } & RunWork)>> {
  const out: Record<string, { state: "queued" } | ({ state: "running" } & RunWork)> = {};
  const msgs = await p.pdb
    .from("messages")
    .select(["id", "status", "payload"])
    .where("kind", "=", "plan")
    .where("status", "in", ["pending", "claimed"])
    .orderBy("id")
    .execute();
  const runs = msgs.length
    ? await p.pdb.from("runs").select(["id", "message_id"]).where("message_id", "in", msgs.map((m) => m.id)).where("ended_at", "is", null).orderBy("id").execute()
    : [];
  const runOf = new Map<number, number>(); // メッセージ → いちばん新しい終わっていない起動
  for (const r of runs) if (r.message_id !== null) runOf.set(r.message_id, r.id);
  const works = await runWorks(p, [...runOf.values()]);
  for (const m of msgs) {
    const stage = (JSON.parse(m.payload) as { stage: string }).stage;
    const w = runOf.has(m.id) ? works.get(runOf.get(m.id)!) : undefined;
    if (w) out[stage] = { state: "running", ...w };
    else if (!out[stage]) out[stage] = { state: "queued" };
  }
  return out;
}
