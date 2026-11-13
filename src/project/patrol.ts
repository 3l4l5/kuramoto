import { z } from "zod";
import { iso } from "../clock.js";
import { ROLE_LABEL, type Role, type WorkRole } from "../domain/roles.js";
import { defineTool, type KuramotoTool } from "../harness/types.js";
import { send } from "./inbox.js";
import type { Project, TicketRow } from "./project.js";
import { comment, mustResolve, setStatus } from "./review.js";
import { lastCiFailure } from "./merge.js";
import { lastTeamCi, teamCiEnabled } from "./team-ci.js";
import { areaWait, areasOf, blockers, dependsOn, dropAsDuplicate, teamStatus } from "./triage.js";
import { advance, createTicket, dropTicket, holdTicket, ticketSpentUsd, type ResumeMessage } from "./workflow.js";

/**
 * リーダーの見回り(ADR-0026)。始業中は、始業したときと、間隔(設定 patrol_min、既定 5 分。"0" で止める)ごとにボードを見て、
 * - 同じことを扱うチケット(重複)を片付ける。取りかかった後のものも、残す方にまとめて PR を閉じる
 * - 同じところを回り続けている(差し戻しの往復・merge 待ちからの戻り・同じエラー・起動の回数)チケットを止めて、手を打つ
 * - 待ち(after)が解けずに止まっている(デッドロック)チケットを、待ちの付け直しや、解消するチケットで片付ける
 * 回っているかどうかの見立ては Kuramoto が数えて(LLM を使わずに)出し、何もなければリーダーを起こさない(始業のときは必ず見回る)。
 */

/** チケットごとの「前回リーダーが見たところ」。これより後の起動・出来事だけを数える。 */
type Seen = { run: number; event: number };

function seenOf(p: Project, ticketId: number): Seen {
  const v = p.setting(`patrol_seen:${ticketId}`);
  return v ? (JSON.parse(v) as Seen) : { run: 0, event: 0 };
}

/** リーダーが見た(手を打った・様子を見ると決めた)ので、ここから数え直す。 */
export async function markSeen(p: Project, ticketId: number): Promise<void> {
  const r = await maxOf(p, "runs", "id");
  const e = await maxOf(p, "events", "id");
  p.setSetting(`patrol_seen:${ticketId}`, JSON.stringify({ run: r, event: e } satisfies Seen));
}

/** プロジェクトの行のうち、列の最大値(無ければ 0)。 */
async function maxOf(p: Project, table: "runs" | "events" | "tickets", column: "id" | "number"): Promise<number> {
  const row = await p.pdb.from(table).clearSelect().select((eb) => eb.fn.max<number | null>(column).as("n")).executeTakeFirst();
  return Number(row?.n ?? 0);
}

/** 未完了(完了・取りやめ以外)のチケット。番号順。 */
function openTickets(p: Project) {
  return p.pdb.from("tickets").where("stage", "not in", ["done", "dropped"]).orderBy("number");
}

export type LoopSignal = {
  ticket: TicketRow;
  /** 前回見てからの起動の回数 */
  runs: number;
  /** 前回見てからの差し戻しの回数 */
  changes: number;
  /** 前回見てから merge 待ちに入った回数(2 回目からは戻ってきたということ) */
  readyToMerge: number;
  /** 同じエラーが続いた回数と、そのエラー */
  sameError: { count: number; error: string } | null;
  /** 何が引っかかったか(リーダーに見せる) */
  reasons: string[];
};

/** 回っていると見なす目安。設定で変えられる。 */
function limits(p: Project) {
  return {
    runs: p.settingNumber("patrol_loop_runs", 12),
    changes: p.settingNumber("patrol_loop_changes", 4),
    merges: p.settingNumber("patrol_loop_merges", 3),
    errors: p.settingNumber("patrol_loop_errors", 3),
  };
}

/** 開いているチケットのうち、同じところを回っていそうなもの。 */
export async function loopSignals(p: Project): Promise<LoopSignal[]> {
  const lim = limits(p);
  const open = (await openTickets(p).execute()) as TicketRow[];
  // 責任者の対応待ち(保留・予算切れ)は、もう止まっているので見ない(まとめて 1 回で引く)
  const waiting = new Set(
    open.length
      ? (await p.pdb.from("decisions").select("ticket_id").where("ticket_id", "in", open.map((t) => t.id)).where("escalated", "=", 1).where("decided_at", "is", null).execute()).map((d) => d.ticket_id)
      : [],
  );
  const out: LoopSignal[] = [];
  for (const t of open) {
    if (waiting.has(t.id)) continue;
    const seen = seenOf(p, t.id);
    const runs = await p.pdb.from("runs").select(["error", "outcome"]).where("ticket_id", "=", t.id).where("id", ">", seen.run).orderBy("id", "desc").execute();
    const count = async (type: string) => {
      const row = await p.pdb.from("events").clearSelect().select((eb) => eb.fn.countAll<number>().as("n")).where("ticket_id", "=", t.id).where("id", ">", seen.event).where("type", "=", type).executeTakeFirst();
      return Number(row?.n ?? 0);
    };
    const changes = await count("changes_requested");
    const readyToMerge = await count("ready_to_merge");
    // 新しい方から、同じエラーが何回続いたか
    let sameError: LoopSignal["sameError"] = null;
    const first = runs[0]?.error?.trim();
    if (first) {
      let n = 0;
      for (const r of runs) {
        if (r.error?.trim() !== first) break;
        n++;
      }
      sameError = { count: n, error: first };
    }
    const reasons: string[] = [];
    if (changes >= lim.changes) reasons.push(`差し戻しが ${changes} 回`);
    if (readyToMerge >= lim.merges) reasons.push(`merge 待ちに ${readyToMerge} 回入った(merge されずに戻ってきている)`);
    if (sameError && sameError.count >= lim.errors) reasons.push(`同じエラーが ${sameError.count} 回続いた`);
    if (runs.length >= lim.runs) reasons.push(`起動が ${runs.length} 回`);
    if (reasons.length) out.push({ ticket: t, runs: runs.length, changes, readyToMerge, sameError, reasons });
  }
  return out;
}

/** デッドロック(待ちが解けずに止まっている状態)の 1 件。 */
export type Deadlock = {
  /** 同じ止まりを見分ける印(見たことにして、毎回見せないのに使う) */
  key: string;
  kind: "cycle" | "merged-wait" | "dropped-wait" | "idle-head";
  /** 関わっているチケットの番号(原因のものが先) */
  tickets: number[];
  /** どの待ちが原因か(リーダーに見せる) */
  reason: string;
};

type DeadTicket = { id: number; number: number; stage: TicketRow["stage"]; triaged: number };

/** 輪になっている待ち(強連結成分)を、番号の組で返す。自分を待つものも輪とみなす。 */
function waitCycles(open: Set<number>, waits: Map<number, number[]>): number[][] {
  let counter = 0;
  const index = new Map<number, number>();
  const low = new Map<number, number>();
  const onStack = new Set<number>();
  const stack: number[] = [];
  const out: number[][] = [];
  const visit = (v: number): void => {
    index.set(v, counter);
    low.set(v, counter++);
    stack.push(v);
    onStack.add(v);
    for (const w of waits.get(v) ?? []) {
      if (!open.has(w)) continue;
      if (!index.has(w)) {
        visit(w);
        low.set(v, Math.min(low.get(v)!, low.get(w)!));
      } else if (onStack.has(w)) low.set(v, Math.min(low.get(v)!, index.get(w)!));
    }
    if (low.get(v) === index.get(v)) {
      const comp: number[] = [];
      let w: number;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        comp.push(w);
      } while (w !== v);
      if (comp.length > 1 || (waits.get(v) ?? []).includes(v)) out.push(comp);
    }
  };
  for (const v of open) if (!index.has(v)) visit(v);
  return out;
}

/** 輪の中の 1 周(最小の番号から、待ちをたどって戻るまで)。 */
function cyclePath(start: number, comp: Set<number>, waits: Map<number, number[]>): number[] {
  const prev = new Map<number, number>();
  const queue = [start];
  while (queue.length) {
    const v = queue.shift()!;
    for (const w of waits.get(v) ?? []) {
      if (!comp.has(w)) continue;
      if (w === start) {
        const path = [v];
        while (path[0] !== start) path.unshift(prev.get(path[0]!)!);
        return [...path, start];
      }
      if (!prev.has(w)) {
        prev.set(w, v);
        queue.push(w);
      }
    }
  }
  return [start, start];
}

/** 開発の席に手すきがあるか(空いている席・割り当ての無い手すきの人)。 */
async function devSeatFree(p: Project): Promise<boolean> {
  const busy = new Set<number>((await p.pdb.from("runs").select("member_id").where("ended_at", "is", null).execute()).map((r) => r.member_id));
  for (const m of (await p.pdb.from("messages").select("to_member_id").where("status", "=", "pending").where("to_member_id", "is not", null).execute()).map((r) => r.to_member_id)) if (m !== null) busy.add(m);
  for (const u of p.currentFormation().units.filter((x) => x.roles.includes("dev" as WorkRole))) {
    const members = p.membersOfUnit(u.id);
    if (members.length < u.max_members || members.some((m) => !busy.has(m.id))) return true;
  }
  return false;
}

/**
 * 今、待ちが解けずに止まっているもの(見せたかどうかに関わらず、全部)。
 * - 待ちの循環: A は B を待ち、B は A を待つ(長い輪も)
 * - merge 済みなのに終わっていない待ち先: PR は merged なのに、ボードで done になっていないチケットを、ほかが待っている
 * - 取りやめた待ち先: 待ち先が dropped なのに待ちが残っている
 * - 手すきがいるのに取られない先頭: 待つものが無く、席も空いているのに、一定時間(設定 patrol_stuck_min、既定 10 分)誰にも取られていない
 */
export async function detectDeadlocks(p: Project): Promise<Deadlock[]> {
  const all = (await p.pdb.from("tickets").select(["id", "number", "stage", "triaged"]).execute()) as DeadTicket[];
  const byId = new Map(all.map((t) => [t.id, t]));
  const isOpen = (t: DeadTicket) => t.stage !== "done" && t.stage !== "dropped";
  const open = new Set(all.filter(isOpen).map((t) => t.id));
  // 待っている側 → 待たれている側(終わっていないチケットが待っているものだけ)
  const waits = new Map<number, number[]>();
  for (const d of await p.pdb.from("ticket_deps").select(["ticket_id", "depends_on"]).execute()) {
    if (!open.has(d.ticket_id) || !byId.has(d.depends_on)) continue;
    waits.set(d.ticket_id, [...(waits.get(d.ticket_id) ?? []), d.depends_on]);
  }
  const num = (id: number) => byId.get(id)!.number;
  const nums = (ids: number[]) => [...new Set(ids.map(num))].sort((a, b) => a - b);
  const label = (ids: number[]) => nums(ids).map((n) => `#${n}`).join("・");
  const out: Deadlock[] = [];

  // 1. 待ちの循環
  for (const comp of waitCycles(open, waits)) {
    const members = nums(comp);
    const path = cyclePath(comp.find((id) => num(id) === members[0])!, new Set(comp), waits);
    out.push({
      key: `cycle:${members.join(",")}`,
      kind: "cycle",
      tickets: members,
      reason: `待ちが輪になっていて、どれも始まれません: ${path.map((id) => `#${num(id)}`).join(" → ")}(after の付け直しが要ります)`,
    });
  }

  // 2. 待ち先の PR が merge 済みなのに、ボードで done になっていない
  const waitedOpen = [...new Set([...waits.values()].flat())].filter((id) => open.has(id));
  const prs = waitedOpen.length ? await p.pdb.from("pull_requests").select(["id", "ticket_id", "number", "gh_state"]).where("ticket_id", "in", waitedOpen).orderBy("id").execute() : [];
  const mergedPrIds = new Set(
    prs.length ? (await p.pdb.from("merges").select("pr_id").where("pr_id", "in", prs.map((r) => r.id)).where("result", "=", "merged").execute()).map((r) => r.pr_id) : [],
  );
  const mergedStale = new Set<number>();
  for (const id of waitedOpen) {
    const mine = prs.filter((r) => r.ticket_id === id);
    if (!mine.length || !mine.every((r) => r.gh_state === "MERGED" || mergedPrIds.has(r.id))) continue;
    mergedStale.add(id);
    const waiters = [...waits].filter(([, ws]) => ws.includes(id)).map(([w]) => w);
    out.push({
      key: `merged-wait:${num(id)}`,
      kind: "merged-wait",
      tickets: [num(id), ...nums(waiters)],
      reason: `#${num(id)} は PR(${mine.map((r) => `#${r.number}`).join("・")})が merge 済みなのに、ボードでは「${stageText(byId.get(id)!)}」のまま done になっていません。待っている ${label(waiters)} が進めません`,
    });
  }

  // 3. 待ち先が取りやめなのに、待ちが残っている
  for (const [id, ws] of waits) {
    const gone = ws.filter((d) => byId.get(d)?.stage === "dropped");
    if (gone.length) out.push({ key: `dropped-wait:${num(id)}`, kind: "dropped-wait", tickets: [num(id)], reason: `#${num(id)} は、取りやめになった ${label(gone)} を待ったままです(待つのをやめるか、代わりの待ち先に付け直します)` });
  }

  // 4. 席が空いているのに、取りかかれるはずの先頭が取られていない
  const stuckMs = Math.max(1, p.settingNumber("patrol_stuck_min", 10)) * 60_000;
  const now = p.clock.now().getTime();
  const pending = await p.pdb.from("messages").select(["ticket_id", "to_member_id", "created_at", "available_at"]).where("kind", "=", "implement").where("status", "=", "pending").execute();
  let seatFree: boolean | undefined;
  const runningMembers = async () => new Set((await p.pdb.from("runs").select("member_id").where("ended_at", "is", null).execute()).map((r) => r.member_id));
  for (const m of pending) {
    const t = m.ticket_id === null ? undefined : byId.get(m.ticket_id);
    if (!t || t.stage !== "dev" || !t.triaged || mergedStale.has(t.id)) continue;
    if (m.available_at > p.now()) continue;
    // 待つものが無い(先頭)・同じ場所を先に触っているものが無い・動いていない・責任者の対応待ちでもない
    if ((await blockers(p, t.id)).length || (await areaWait(p, t.id)).length) continue;
    if (await runningNow(p, t.id)) continue;
    if (await waitingOwner(p, t.id)) continue;
    if (m.to_member_id !== null && (await runningMembers()).has(m.to_member_id)) continue;
    // 待つものが無くなったとき(待ち先の merge・取りやめ、待ちの付け直し)・仕事が入ったときから数える
    const deps = await p.pdb.from("ticket_deps").select("depends_on").where("ticket_id", "=", t.id).execute();
    const resolved = await p.pdb.from("events").select("at").where("type", "in", ["merged", "ticket_dropped", "duplicate_dropped"]).where("ticket_id", "in", deps.length ? deps.map((d) => d.depends_on) : [-1]).execute();
    const planned = await p.pdb.from("events").select("at").where("type", "=", "ticket_planned").where("ticket_id", "=", t.id).execute();
    const since = Math.max(0, ...[m.created_at, ...resolved.map((e) => e.at), ...planned.map((e) => e.at)].map((a) => Date.parse(a) || 0));
    if (now - since < stuckMs) continue;
    if ((seatFree ??= await devSeatFree(p)) === false) continue;
    const behind = new Set<number>();
    const queue = [t.id];
    while (queue.length) {
      const id = queue.shift()!;
      for (const [w, ws] of waits) if (ws.includes(id) && !behind.has(w)) (behind.add(w), queue.push(w));
    }
    const mins = Math.floor((now - since) / 60_000);
    out.push({
      key: `idle-head:${t.number}`,
      kind: "idle-head",
      tickets: [t.number, ...nums([...behind])],
      reason: `#${t.number} は待つものが無く、開発の席も空いているのに、${mins} 分以上誰にも取られていません${m.to_member_id !== null ? "(担当を名指ししてあります)" : ""}${behind.size ? `。これを待っている ${label([...behind])} も動けません` : ""}`,
    });
  }
  return out.sort((a, b) => a.tickets[0]! - b.tickets[0]! || a.key.localeCompare(b.key));
}

/** 見せたデッドロックの印と、見せた時刻(まだ続いているものを、間を空けて見せ直すのに使う)。 */
function deadlockSeen(p: Project): Record<string, string> {
  const v = p.setting("patrol_deadlock_seen");
  return v ? (JSON.parse(v) as Record<string, string>) : {};
}

/**
 * 今見せるべきデッドロック。前の見回りで見せたものは、続いていても見せない(同じ止まりで毎回チケットを作らないため)。
 * 見せてから設定 patrol_deadlock_recheck_min(既定 60 分、0 で見せ直さない)が過ぎても続いていれば、もう一度見せる。
 */
export async function deadlockSignals(p: Project): Promise<Deadlock[]> {
  const seen = deadlockSeen(p);
  const again = p.settingNumber("patrol_deadlock_recheck_min", 60) * 60_000;
  const now = p.clock.now().getTime();
  return (await detectDeadlocks(p)).filter((d) => {
    const at = seen[d.key];
    return !at || (again > 0 && now - Date.parse(at) >= again);
  });
}

/** 前回の見回りのあとに入ったチケット(重複が増えていないかを見る)。交通整理がまだのものは、交通整理が先に見るので数えない。 */
async function newTickets(p: Project): Promise<TicketRow[]> {
  const after = p.settingNumber("patrol_last_ticket", 0);
  return (await openTickets(p).where("number", ">", after).where("triaged", "=", 1).execute()) as TicketRow[];
}

async function openCount(p: Project): Promise<number> {
  const row = await p.pdb.from("tickets").clearSelect().select((eb) => eb.fn.countAll<number>().as("n")).where("stage", "not in", ["done", "dropped"]).executeTakeFirst();
  return Number(row?.n ?? 0);
}

/** 見回りの依頼(受信箱)が、まだ取られていない・取られて動いているか。 */
async function patrolPending(p: Project): Promise<boolean> {
  return !!(await p.pdb.from("messages").select("id").where("kind", "=", "patrol").where("status", "in", ["pending", "claimed"]).limit(1).executeTakeFirst());
}

/** 見回りの間隔(分)。0 なら見回らない。 */
export function patrolMinutes(p: Project): number {
  return Math.max(0, p.settingNumber("patrol_min", 5));
}

/** 見回りの間隔を決める(分。0 で止める)。 */
export function setPatrolMinutes(p: Project, min: number): void {
  if (!Number.isInteger(min) || min < 0) throw new Error("見回りの間隔は 0 以上の整数(分)にしてください");
  p.setSetting("patrol_min", String(min));
}

/** 始業したとき。見るものがあってもなくても、必ず 1 回見回る(見回りを止めていなければ)。 */
export async function startPatrol(p: Project): Promise<boolean> {
  if (patrolMinutes(p) <= 0) return false;
  p.setSetting("patrol_last_at", iso(p.clock.now()));
  if (await patrolPending(p)) return false;
  send(p, { ticketId: null, toRole: "lead", kind: "patrol", payload: { start: true } });
  return true;
}

/**
 * 間隔が過ぎていて、見るもの(回っていそうなチケット・待ちが解けずに止まっているもの・前回の後に入ったチケット)があれば、リーダーに見回りを頼む。
 * 何も無ければ起こさない(トークンを使わない)。
 */
export async function requestPatrol(p: Project): Promise<boolean> {
  const min = patrolMinutes(p);
  if (min <= 0) return false;
  const last = p.setting("patrol_last_at");
  // 始業を通らずに動き出した(サーバーを起動し直した)なら、ここから間隔を数え始める
  if (!last) {
    p.setSetting("patrol_last_at", iso(p.clock.now()));
    return false;
  }
  if (p.clock.now().getTime() - new Date(last).getTime() < min * 60_000) return false;
  if (await patrolPending(p)) return false;
  const fresh = await newTickets(p);
  // 重複は 2 枚以上ないと起きない。回っているものが無く、新しいチケットも無ければ見回らない
  if (!(await loopSignals(p)).length && !(await deadlockSignals(p)).length && !(fresh.length && (await openCount(p)) >= 2)) return false;
  p.setSetting("patrol_last_at", iso(p.clock.now()));
  send(p, { ticketId: null, toRole: "lead", kind: "patrol", payload: {} });
  return true;
}

/**
 * 見回りを終えた。見せたチケットは見たことにして、同じものを次の見回りで繰り返し見せない。
 * 見せたデッドロックも覚える。もう止まっていないものは忘れる(あとで同じ止まりが起きたら、新しく見せる)。
 */
export async function finishPatrol(p: Project, shown: LoopSignal[], deadlocks: Deadlock[] = []): Promise<void> {
  for (const s of shown) await markSeen(p, s.ticket.id);
  const max = await maxOf(p, "tickets", "number");
  p.setSetting("patrol_last_ticket", String(max));
  const before = deadlockSeen(p);
  const now = iso(p.clock.now());
  const next: Record<string, string> = {};
  for (const d of await detectDeadlocks(p)) {
    const wasShown = deadlocks.some((x) => x.key === d.key);
    const at = wasShown ? now : before[d.key];
    if (at) next[d.key] = at;
  }
  p.setSetting("patrol_deadlock_seen", JSON.stringify(next));
}

function stageText(t: { stage: TicketRow["stage"] }): string {
  return { dev: "開発", review: "レビュー", sec: "セキュリティ", qa: "QA", decision: "判断待ち", merge: "merge 待ち", done: "完了", dropped: "取りやめ" }[t.stage];
}

/** チケットごとの、開いている PR の番号(まとめて 1 回で引く。無ければ入らない)。 */
async function openPrNumbers(p: Project, ticketIds: number[]): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  if (!ticketIds.length) return out;
  const rows = await p.pdb.from("pull_requests").select(["ticket_id", "number", "gh_state"]).where("ticket_id", "in", ticketIds).orderBy("id").execute();
  for (const r of rows) if ((r.gh_state ?? "OPEN") === "OPEN" && !out.has(r.ticket_id)) out.set(r.ticket_id, r.number);
  return out;
}

const DEADLOCK_LABEL: Record<Deadlock["kind"], string> = { cycle: "待ちの循環", "merged-wait": "merge 済みなのに done でない待ち先", "dropped-wait": "取りやめた待ち先", "idle-head": "手すきがいるのに取られない先頭" };

/** デッドロックの解消の手順(プロンプトに入れる)。 */
const DEADLOCK_STEPS = `- デッドロック(上の「デッドロック」の節): 見つかったものを 1 件ずつ、原因を見立てて解消します。自分で直せるものは plan_work、仕組みの不具合は create_ticket で使い分けます。
  - 自分で直せるもの(待ちの付け直し・担当の割り当て)は plan_work で直します。plan_work は、書いたチケットの after を書いたものに置き換えるので、残したい待ちも after にすべて書きます(areas は省けば変わりません)。
    - 待ちの循環: どちらが先かを決め、輪を切る方の after から外します。
    - 取りやめた待ち先: after から外すか、代わりに待つべきチケットに付け直します。
    - 手すきがいるのに取られない先頭: assignee に手すきのメンバーか島の名前を書いて割り当て直します。それでも取られないなら、仕組みの不具合を疑います。
  - 仕組み側の不具合が原因のもの(merge 済みなのにボードで done にならない・待ち先が進んでいるのに待ちが解けない・席が空いて待ちも無いのに取られない理由が分からない、など)は、plan_work では根本が直りません。create_ticket で「解消するチケット」(kind は bugfix。見つけた事実・どのチケットが止まっているか・直すべきところの見立てを本文に書く)を作ります。同じ原因のチケットがボードに(開いたまま)既にあれば、作りません。待たされているチケットは、plan_work で待ちを外して先に進めて構いません。
  - 解消したものも、様子を見るものも、報告に書きます。一度見せたデッドロックは、続いていても次の見回りでは(しばらく)見せません。`;

export async function patrolPrompt(p: Project, signals: LoopSignal[], opts: { start?: boolean; deadlocks?: Deadlock[] } = {}): Promise<string> {
  const open = (await openTickets(p).execute()) as TicketRow[];
  const fresh = new Set((await newTickets(p)).map((t) => t.id));
  const prs = await openPrNumbers(p, open.map((t) => t.id));
  const listLines: string[] = [];
  for (const t of open) {
    const owner = t.owner_member_id ? p.member(t.owner_member_id).name : "未着手";
    const after = await dependsOn(p, t.id);
    const areas = await areasOf(p, t.id);
    const pr = prs.get(t.id);
    const body = t.body.trim().replace(/\s+/g, " ").slice(0, 160);
    listLines.push(`- #${t.number}${fresh.has(t.id) ? "(新)" : ""} ${t.title} [${stageText(t)}] 担当: ${owner}${pr ? ` / PR #${pr}` : ""}${after.length ? ` / 先に: #${after.join(", #")}` : ""}${areas.length ? ` / 触る場所: ${areas.join(", ")}` : ""}${body ? `\n  ${body}` : ""}`);
  }
  const list = listLines.join("\n");
  const loopBlocks: string[] = [];
  for (const s of signals) {
      const t = s.ticket;
      const recent = await p.pdb.from("runs").select(["role", "outcome", "error", "summary"]).where("ticket_id", "=", t.id).orderBy("id", "desc").limit(6).execute();
      const spent = await ticketSpentUsd(p, t.id);
      const findings = (await Promise.all((["review", "sec", "qa"] as const).map(async (r) => (await mustResolve(p, t.id, r)).map((f) => `  - [${ROLE_LABEL[r]}] 指摘 ${f.id}(${f.status}): ${f.body.slice(0, 200)}`)))).flat();
      const notes = p.notes(t.id).slice(-3);
      loopBlocks.push(`### #${t.number} ${t.title} [${stageText(t)}]
- 引っかかったところ: ${s.reasons.join("、")}
- 使った額: $${spent.toFixed(2)} / 差し戻しの往復(通算): ${t.rounds} 回
- 最近の起動(新しい順):
${recent.map((r) => `  - ${ROLE_LABEL[r.role as Role] ?? r.role}: ${r.outcome ?? "?"}${r.error ? ` / ${r.error.slice(0, 200)}` : ""}${r.summary ? ` / ${r.summary.slice(0, 160)}` : ""}`).join("\n") || "  (なし)"}
${findings.length ? `- 残っている指摘:\n${findings.join("\n")}` : "- 残っている指摘: なし"}
${lastCiFailure(p, t.id, 1500)}
${lastTeamCi(p, t.id, 1500)}
${notes.length ? `- 最近のメモ:\n${notes.map((n) => `  - ${n.who === "lead" ? "リーダー" : "責任者"}: ${n.body.slice(0, 200)}`).join("\n")}` : ""}`);
  }
  const loops = loopBlocks.join("\n\n");
  const status = await teamStatus(p);
  const deadlocks = opts.deadlocks ?? [];
  const deadlockText = deadlocks.map((d) => `- [${DEADLOCK_LABEL[d.kind]}] ${d.reason}`).join("\n");
  return `${opts.start ? "始業したので、最初の見回りです" : "定期の見回りです"}。ボードを見て、重複しているチケット・いらなくなったチケットと、同じところを回り続けているチケット、待ちが解けずに止まっているチケット(デッドロック)に手を打ってください。

## 開いているチケット
${list || "(なし)"}

## 回っていそうなチケット(Kuramoto が数えたもの)
${loops || "(なし)"}

## デッドロック(待ちが解けずに止まっているもの。Kuramoto が見つけたもの)
${deadlockText || "(なし)"}

## チームの今
${status}

## 進め方
- 重複: 同じことを扱うチケットが 2 枚以上あれば、drop_duplicate で 1 枚にまとめます。残す方は、進んでいる方(merge 待ち・PR がある・担当がいる)にします。片付ける方の中身は残す方のメモに移り、開いている PR は閉じます。似ているだけで別のこと(画面と API など)は重複にしません。
- いらなくなったもの: 仕様が変わってやらなくてよくなった・ほかのチケットで済んでいる(main に入った変更で満たされている)・責任者がチャットでいらないと言ったチケットは、drop_ticket で理由を書いて取りやめます。迷うものは取りやめず、報告に書いて責任者に任せます。
- 回っているもの: 最近の起動・指摘・メモを読んで、なぜ回っているかを見立て、1 枚につき 1 つ手を打ちます。
  - 担当とレビュアーが同じ指摘で行き来している・指摘が受け入れ条件やセキュリティ・この差分の不具合ではない(ADR-0021)なら、pass_as_is で残りの指摘を直さずに通します。
  - 直し方が分かっていない・同じエラーで止まっているなら、advise で原因の見立てと直し方をメモに書きます(担当が次の起動で読みます)。
  - チケットが大きすぎて終わらないなら、split で残りを別チケットに切り出し、今のチケットの範囲を絞ります。
  - 責任者にしかできないこと(秘密情報・権限・契約)が無いと進まないときだけ、hold で止めて責任者に頼みます。
  - 見た上で、順調に進んでいて手を打たなくてよいなら、何もしません(次の見回りでは、ここから先の回数だけを数えます)。
${teamCiEnabled(p) ? "- CI はチームの CI(Kuramoto が手元で流す確認)を使っています。GitHub Actions は止めてあり、merge にも使いません。GitHub の CI の失敗を理由に手を打たず、そのためだけのチケットは drop_ticket で取りやめます。" : "- CI が絡むものは、ci_status・ci_run・ci_settings で Kuramoto に GitHub を見てもらえます(あなたの作業場所からは見えません)。ci_rerun で落ちたジョブをやり直せます。"}
${DEADLOCK_STEPS}
- 動いている最中のチケット(起動中)には手を打てません。道具が断ったら、次の見回りに回します。
- 最後のテキストは、責任者への短い報告にします(片付けた重複・取りやめたチケット・手を打ったチケットとその理由。デッドロックは、何が原因で、plan_work で何を直したか・create_ticket でどのチケットを作ったかも書く)。何もしなかったなら「見回りました。手を打つものはありませんでした」とだけ書きます。`;
}

/** 起動中なら手を打てない(リーダー自身がそのチケットを調べている起動は数えない)。 */
async function runningNow(p: Project, ticketId: number): Promise<boolean> {
  return !!(await p.pdb.from("runs").select("id").where("ticket_id", "=", ticketId).where("ended_at", "is", null).where("role", "<>", "lead").limit(1).executeTakeFirst());
}

async function byNumber(p: Project, n: number): Promise<TicketRow | undefined> {
  return (await p.pdb.from("tickets").where("number", "=", n).executeTakeFirst()) as TicketRow | undefined;
}

/** 責任者の対応を待つ判断があるか。 */
async function waitingOwner(p: Project, ticketId: number): Promise<boolean> {
  return !!(await p.pdb.from("decisions").select("id").where("ticket_id", "=", ticketId).where("escalated", "=", 1).where("decided_at", "is", null).limit(1).executeTakeFirst());
}

/** 待っている仕事(取り出していないメッセージ)のうち、最後のもの。止めたあとに続きから再開するのに使う。 */
async function pendingWork(p: Project, ticketId: number): Promise<ResumeMessage | undefined> {
  const m = await p.pdb.from("messages").select(["to_role", "to_member_id", "kind", "payload"]).where("ticket_id", "=", ticketId).where("status", "=", "pending").orderBy("id", "desc").limit(1).executeTakeFirst();
  return m ? { toRole: m.to_role as Role, toMemberId: m.to_member_id, kind: m.kind as ResumeMessage["kind"], payload: JSON.parse(m.payload) as Record<string, unknown> } : undefined;
}

/**
 * 取りかかった後のチケットも含めて、重複として片付ける。起動中のもの・merge 待ちのものは片付けない(merge 待ちは残す方にする)。
 * 取りかかる前のものは交通整理と同じ片付け方(dropAsDuplicate)。後のものは、待っている仕事と判断も閉じ、開いている PR を閉じる。
 */
export async function dropDuplicate(
  p: Project,
  number: number,
  sameAs: number,
  closePrs: (t: TicketRow, reason: string) => Promise<void> = async () => {},
): Promise<string> {
  const t = await byNumber(p, number);
  const keep = await byNumber(p, sameAs);
  if (!t || !keep) return `#${!t ? number : sameAs} はありません`;
  if (t.id === keep.id) return "同じチケットです";
  if (t.stage === "done" || t.stage === "dropped") return `#${number} はもう終わっています`;
  if (keep.stage === "dropped") return `#${sameAs} は取りやめになっています。残す方には、開いているチケットを選んでください`;
  if (t.stage === "merge") return `#${number} は merge 待ちです。こちらを残す方にしてください`;
  if (await runningNow(p, t.id)) return `#${number} は今動いています。次の見回りで片付けてください`;
  if (!(await p.pdb.from("runs").select("id").where("ticket_id", "=", t.id).where("role", "=", "dev").limit(1).executeTakeFirst())) {
    const r = await dropAsDuplicate(p, number, sameAs);
    await touch(p, t.id);
    return r;
  }
  await p.pdb.transaction(async () => {
    p.addNote(keep.id, `【重複していた #${number} から(取りかかった後に片付け)】${t.title}\n${t.body.trim().slice(0, 1500)}`, "lead");
    await dropTicket(p, t.id, { by: "lead", reason: `#${sameAs}「${keep.title}」と重複していたため`, sameAs: keep });
  });
  await touch(p, t.id);
  await closePrs(t, `#${sameAs}「${keep.title}」と重複していたため、リーダーがこちらを片付けました。`);
  return `#${number} を #${sameAs} の重複として片付けました(開いていた PR は閉じます)。`;
}

/**
 * いらなくなったチケットを、リーダーが取りやめる(仕様が変わった・ほかのチケットで済んだ・責任者に頼まれた など)。
 * 記録は消さず、取りやめた理由をボードとチケットに残す。開いている PR は閉じる。起動中のものは取りやめない。
 */
export async function dropUnneeded(p: Project, number: number, reason: string, closePrs: (t: TicketRow, reason: string) => Promise<void> = async () => {}): Promise<string> {
  const t = await byNumber(p, number);
  if (!t) return `#${number} はありません`;
  if (t.stage === "done") return `#${number} はもう merge されています。取りやめられません(戻すなら、元に戻すチケットを作ってください)`;
  if (t.stage === "dropped") return `#${number} はもう取りやめになっています`;
  if (!reason.trim()) return "取りやめる理由を書いてください";
  if (await runningNow(p, t.id)) return `#${number} は今動いています。起動が終わってから取りやめてください(見回りなら次の見回りで)`;
  await dropTicket(p, t.id, { by: "lead", reason: reason.trim() });
  await closePrs(t, `リーダーがこのチケットを取りやめました: ${reason.trim()}`);
  return `#${number} を取りやめました(ボードの「取りやめ」に理由つきで残ります)。`;
}

/** リーダーがチケットを取りやめる道具(見回りとチャットで使う)。 */
export function dropTicketTool(p: Project, closePrs?: (t: TicketRow, reason: string) => Promise<void>): KuramotoTool {
  return defineTool({
    name: "drop_ticket",
    description:
      "いらなくなったチケットを取りやめる(仕様が変わってやらなくてよくなった・ほかのチケットで済んだ・責任者にいらないと言われた)。記録は消さず、理由はボードとチケットに残り、責任者が戻せる。待っている仕事と判断を閉じ、開いている PR を閉じ、このチケットを待っていたチケットは待つのをやめる。重複なら drop_duplicate(見回り)か drop_as_duplicate(交通整理)を使う。",
    input: {
      number: z.number().int().describe("取りやめるチケットの番号"),
      reason: z.string().min(1).describe("なぜいらなくなったか(責任者が読む。根拠になったチケット番号や会話があれば書く)"),
    },
    handler: (a) => dropUnneeded(p, a.number, a.reason, closePrs),
  });
}

/**
 * 差し戻しの往復を止める。最後に差し戻した工程の、残っている指摘を直さずに通し(リーダーの裁定)、次の工程へ進める。
 */
export async function passAsIs(p: Project, number: number, reason: string): Promise<string> {
  const t = await byNumber(p, number);
  if (!t) return `#${number} はありません`;
  if (t.stage === "done" || t.stage === "dropped" || t.stage === "merge") return `#${number} は${stageText(t)}です。通すものがありません`;
  if (await runningNow(p, t.id)) return `#${number} は今動いています。次の見回りで手を打ってください`;
  if (await waitingOwner(p, t.id)) return `#${number} は責任者の対応を待っています`;
  const last = (await p.pdb.from("reviews").select("role").where("ticket_id", "=", t.id).where("verdict", "=", "changes").orderBy("id", "desc").limit(1).executeTakeFirst()) as { role: WorkRole } | undefined;
  if (!last) return `#${number} には差し戻しがありません。advise か split を使ってください`;
  const from = last.role;
  const lead = p.fixedMember("lead");
  await p.pdb.transaction(async () => {
    await p.pdb.update("messages", { status: "done" }).where("ticket_id", "=", t.id).where("status", "=", "pending").execute();
    await p.pdb.update("decisions", { decided_by: "lead", decided_at: p.now() }).where("ticket_id", "=", t.id).where("decided_at", "is", null).execute();
    for (const f of await mustResolve(p, t.id, from)) {
      await setStatus(p, f.id, "wontfix");
      await comment(p, f.id, { memberId: lead.id, role: "lead" }, "ruled", `見回りで裁定: 直さずに通す。${reason}`);
    }
    p.addNote(t.id, `【見回り・往復を止めました】${ROLE_LABEL[from]}の残りの指摘を直さずに通します。${reason}`, "lead");
    p.event(lead.name, "loop_passed", t.id, { from, reason });
    await advance(p, p.ticket(t.id), from);
  });
  await touch(p, t.id);
  return `#${number} の${ROLE_LABEL[from]}の残りの指摘を通し、次の工程へ進めました。`;
}

/** 手を打ったので、ここから数え直す。 */
const touch = markSeen;

export function patrolTools(p: Project, ws: { closePrs?: (t: TicketRow, reason: string) => Promise<void> } = {}): KuramotoTool[] {
  return [
    defineTool({
      name: "drop_duplicate",
      description:
        "ほかのチケットと同じことを扱う(重複している)チケットを片付ける。取りかかった後のものも片付けられる(待っている仕事・判断を閉じ、開いている PR を閉じる)。中身は残す方のメモに移り、待っていたチケットは残す方を待つ。起動中・merge 待ちのものは片付けない。",
      input: {
        number: z.number().int().describe("片付けるチケットの番号"),
        same_as: z.number().int().describe("残す方のチケットの番号(進んでいる方)"),
      },
      handler: (a) => dropDuplicate(p, a.number, a.same_as, ws.closePrs),
    }),
    dropTicketTool(p, ws.closePrs),
    defineTool({
      name: "pass_as_is",
      description:
        "差し戻しの往復で回っているチケットの、最後に差し戻した工程の残りの指摘を、直さずに通して次の工程へ進める(リーダーの裁定)。受け入れ条件・セキュリティ・この差分の不具合の指摘が残っているなら使わない。",
      input: {
        number: z.number().int().describe("チケット番号"),
        reason: z.string().min(1).describe("通してよいと判断した理由(指摘のスレッドとメモに残る)"),
      },
      handler: (a) => passAsIs(p, a.number, a.reason),
    }),
    defineTool({
      name: "advise",
      description: "回っているチケットに、原因の見立てと直し方をメモで渡す。担当とレビュアーが次の起動で読む。仕事の流れは変えない。",
      input: {
        number: z.number().int().describe("チケット番号"),
        advice: z.string().min(1).describe("なぜ回っているかの見立てと、どこをどう直すか・何をやめるか"),
      },
      handler: async (a) => {
        const t = await byNumber(p, a.number);
        if (!t || t.stage === "done" || t.stage === "dropped") return `#${a.number} は開いていません`;
        p.addNote(t.id, `【見回り】${a.advice}`, "lead");
        p.event(p.fixedMember("lead").name, "loop_advised", t.id, {});
        await touch(p, t.id);
        return `#${a.number} にメモを書きました。`;
      },
    }),
    defineTool({
      name: "split",
      description: "大きすぎて終わらないチケットの残りを別チケットに切り出し、今のチケットの範囲を絞る。切り出したチケットは交通整理で順番と担当が決まる。",
      input: {
        number: z.number().int().describe("チケット番号"),
        tickets: z.array(z.object({ title: z.string().min(1), body: z.string().describe("やること・受け入れ条件・なぜ切り出したか") })).min(1),
        advice: z.string().min(1).describe("今のチケットでどこまでをやるか(担当とレビュアーが読む)"),
      },
      handler: async (a) => {
        const t = await byNumber(p, a.number);
        if (!t || t.stage === "done" || t.stage === "dropped") return `#${a.number} は開いていません`;
        const refs = JSON.parse((await p.pdb.from("tickets").select("plan_refs").where("id", "=", t.id).executeTakeFirst())?.plan_refs ?? "{}") as { repo?: string };
        const made: TicketRow[] = [];
        for (const x of a.tickets) {
          made.push(
            await createTicket(p, {
              title: x.title,
              body: `${x.body}\n\n---\n#${t.number}「${t.title}」が回り続けていたため、リーダーが見回りで切り出しました。`,
              planRefs: { splitFrom: t.number, ...(refs.repo ? { repo: refs.repo } : {}) },
            }),
          );
        }
        p.addNote(t.id, `【見回り・切り出し】#${made.map((m) => m.number).join("・#")} に切り出しました。このチケットでは: ${a.advice}`, "lead");
        p.event(p.fixedMember("lead").name, "loop_split", t.id, { into: made.map((m) => m.number) });
        await touch(p, t.id);
        return `#${made.map((m) => m.number).join("・#")} に切り出しました。`;
      },
    }),
    defineTool({
      name: "hold",
      description: "責任者にしかできないこと(秘密情報・権限・契約)が無いと進まないときだけ、チケットを止めて責任者に頼む。仕様の判断は理由にしない(仮に決めて advise で伝える)。",
      input: {
        number: z.number().int().describe("チケット番号"),
        reason: z.string().min(1).describe("何が原因で回っているか"),
        owner_action: z.string().min(1).describe("責任者にしてほしいこと(具体的に)"),
      },
      handler: async (a) => {
        const t = await byNumber(p, a.number);
        if (!t || t.stage === "done" || t.stage === "dropped") return `#${a.number} は開いていません`;
        if (await runningNow(p, t.id)) return `#${a.number} は今動いています。次の見回りで手を打ってください`;
        const resume: ResumeMessage = (await pendingWork(p, t.id)) ?? {
          toRole: "dev",
          toMemberId: t.owner_member_id,
          kind: t.owner_member_id ? "fix" : "implement",
          payload: {},
        };
        await p.pdb.transaction(async () => {
          await p.pdb.update("messages", { status: "done" }).where("ticket_id", "=", t.id).where("status", "=", "pending").execute();
          await holdTicket(p, t.id, { reason: a.reason, ownerAction: a.owner_action, resume });
        });
        await touch(p, t.id);
        return `#${a.number} を保留して、責任者に対応を頼みました。`;
      },
    }),
    defineTool({
      name: "team_status",
      description: "島ごとのメンバー・作業中のチケット・空き席・待ちの件数を見る。",
      input: {},
      handler: () => teamStatus(p),
    }),
  ];
}
