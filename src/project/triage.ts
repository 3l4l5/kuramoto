import { z } from "zod";
import { ROLE_LABEL, type WorkRole } from "../domain/roles.js";
import { defineTool, type KuramotoTool } from "../harness/types.js";
import { send } from "./inbox.js";
import type { Project, TicketRow } from "./project.js";
import { ticketRepo } from "./dispatcher.js";
import { dropTicket } from "./workflow.js";

/**
 * リーダーの交通整理。新しいチケットが入ると、リーダーが「どの順で・誰が」やるかを決める。
 * - 先に終わらせるべきチケット(土台・同じファイルを触るもの)を after に書くと、それが merge されるまで着手しない。
 * - 触りそうな場所(areas)が同じチケットは同時に開発しない。先に取りかかった方が merge されてから次が始まる(ADR-0024)。
 * - 担当を名指しすると、その人がfreeになったときに取る。名指ししなければfreeの人が取る(島のメンバーは最大人数ぶんずっといる)。
 * 交通整理が済むまで、そのチケットの実装は始めない。
 */

export async function untriaged(p: Project): Promise<TicketRow[]> {
  return (await p.pdb.from("tickets").where("triaged", "=", 0).where("stage", "not in", ["done", "dropped"]).orderBy("number").execute()) as TicketRow[];
}

/** チケットが待っているチケット(先に終わらせるもの)を、条件つきで選ぶ(番号順)。複数のチケットぶんを 1 文で引く(チケット → 番号)。 */
async function depNumbersOf(p: Project, ticketIds: number[], stage?: { in?: TicketRow["stage"][]; notIn?: TicketRow["stage"][] }): Promise<Map<number, number[]>> {
  const out = new Map<number, number[]>();
  const ids = [...new Set(ticketIds)];
  if (!ids.length) return out;
  let q = p.pdb.k
    .selectFrom("ticket_deps as d")
    .innerJoin("tickets as t", "t.id", "d.depends_on")
    .select(["d.ticket_id", "t.number"])
    .where("d.project_id", "=", p.pdb.projectId)
    .where("d.ticket_id", "in", ids);
  if (stage?.in) q = q.where("t.stage", "in", stage.in);
  if (stage?.notIn) q = q.where("t.stage", "not in", stage.notIn);
  for (const r of await q.orderBy("t.number").execute()) out.set(r.ticket_id, [...(out.get(r.ticket_id) ?? []), r.number]);
  return out;
}

async function depNumbers(p: Project, ticketId: number, stage?: { in?: TicketRow["stage"][]; notIn?: TicketRow["stage"][] }): Promise<number[]> {
  return (await depNumbersOf(p, [ticketId], stage)).get(ticketId) ?? [];
}

export function dependsOn(p: Project, ticketId: number): Promise<number[]> {
  return depNumbers(p, ticketId);
}

/** 先に終わらせるチケットのうち、まだ merge されていないもの。 */
export function blockers(p: Project, ticketId: number): Promise<number[]> {
  return depNumbers(p, ticketId, { notIn: ["done", "dropped"] });
}

/** blockers を複数のチケットぶん 1 文で引く(ボード用。チケット → 番号。待つものが無いチケットは入らない)。 */
export function blockersOf(p: Project, ticketIds: number[]): Promise<Map<number, number[]>> {
  return depNumbersOf(p, ticketIds, { notIn: ["done", "dropped"] });
}

/**
 * 触る場所を正規化する。大文字小文字・前後の空白・先頭の ./ と末尾の / をそろえる。
 */
export function normalizeArea(a: string): string {
  return a.trim().toLowerCase().replace(/^\.\//, "").replace(/\/+$/, "");
}

export async function areasOf(p: Project, ticketId: number): Promise<string[]> {
  return (await p.pdb.from("ticket_areas").select("area").where("ticket_id", "=", ticketId).orderBy("area").execute()).map((r) => r.area);
}

/** 同じ場所を触っていて、先に進んでいるチケット(番号と、重なっている場所)を、複数のチケットぶん 1 文で引く(チケット → 一覧)。 */
async function areaBlockersOf(p: Project, ticketIds: number[]): Promise<Map<number, { number: number; areas: string[] }[]>> {
  const out = new Map<number, { number: number; areas: string[] }[]>();
  const ids = [...new Set(ticketIds)];
  if (!ids.length) return out;
  const rows = await p.pdb.k
    .selectFrom("ticket_areas as a")
    .innerJoin("ticket_areas as b", (j) => j.onRef("b.area", "=", "a.area").onRef("b.ticket_id", "<>", "a.ticket_id").onRef("b.project_id", "=", "a.project_id"))
    .innerJoin("tickets as o", "o.id", "b.ticket_id")
    .select(["a.ticket_id as ticket_id", "o.number", "a.area"])
    .where("a.project_id", "=", p.pdb.projectId)
    .where("a.ticket_id", "in", ids)
    .where("o.stage", "not in", ["done", "dropped"])
    .where((eb) =>
      eb.or([
        eb.exists(eb.selectFrom("runs as r").select("r.id").whereRef("r.ticket_id", "=", "o.id").where("r.role", "=", "dev")),
        eb.exists(eb.selectFrom("messages as mm").select("mm.id").whereRef("mm.ticket_id", "=", "o.id").where("mm.kind", "=", "implement").where("mm.status", "=", "claimed")),
      ]),
    )
    .orderBy("o.number")
    .orderBy("a.area")
    .execute();
  const by = new Map<number, Map<number, string[]>>();
  for (const r of rows) {
    const m = by.get(r.ticket_id) ?? new Map<number, string[]>();
    m.set(r.number, [...(m.get(r.number) ?? []), r.area]);
    by.set(r.ticket_id, m);
  }
  for (const [tid, m] of by) out.set(tid, [...m].map(([number, areas]) => ({ number, areas })));
  return out;
}

export async function areaBlockers(p: Project, ticketId: number): Promise<{ number: number; areas: string[] }[]> {
  return (await areaBlockersOf(p, [ticketId])).get(ticketId) ?? [];
}

/** まだ開発に取りかかっていないチケットが、同じ場所を触るチケットを待っているか(取りかかった後は待たない)。 */
export async function areaWait(p: Project, ticketId: number): Promise<{ number: number; areas: string[] }[]> {
  return (await areaWaitOf(p, [ticketId])).get(ticketId) ?? [];
}

/** areaWait を複数のチケットぶんまとめて引く(ボード用。チケット → 待っている相手。待たないチケットは入らない)。 */
export async function areaWaitOf(p: Project, ticketIds: number[]): Promise<Map<number, { number: number; areas: string[] }[]>> {
  const ids = [...new Set(ticketIds)];
  if (!ids.length) return new Map();
  const started = new Set((await p.pdb.from("runs").select("ticket_id").where("ticket_id", "in", ids).where("role", "=", "dev").execute()).map((r) => r.ticket_id));
  return areaBlockersOf(p, ids.filter((id) => !started.has(id)));
}

/** 先に終わらせるチケットのうち、merge 待ちの棚にあるもの(責任者が merge を押せば外れる)。 */
export function mergeBlockers(p: Project, ticketId: number): Promise<number[]> {
  return depNumbers(p, ticketId, { in: ["merge"] });
}

/** mergeBlockers を複数のチケットぶん 1 文で引く(ボード用)。 */
export function mergeBlockersOf(p: Project, ticketIds: number[]): Promise<Map<number, number[]>> {
  return depNumbersOf(p, ticketIds, { in: ["merge"] });
}

export type Unblocks = {
  /** merge すると、待つものが無くなってすぐ着手できるチケット。 */
  now: number[];
  /** その先で、まだ別のチケットも待っているもの(順番に動き出す)。 */
  later: number[];
};

/**
 * merge 待ちのチケットごとに、merge すると動き出すチケット。責任者に「何を押せば進むか」を見せるのに使う。
 * 終わっていない(done・dropped でない)チケットだけを数える。止めているものが無ければ載せない。
 */
export async function mergeUnblocks(p: Project): Promise<Map<number, Unblocks>> {
  const open = await p.pdb.from("tickets").select(["id", "number", "stage"]).where("stage", "not in", ["done", "dropped"]).execute();
  const byId = new Map(open.map((t) => [t.id, t]));
  // 待っている側 → 待たれている側(どちらも終わっていないもの)
  const waits = new Map<number, number[]>();
  const waitedBy = new Map<number, number[]>();
  for (const d of await p.pdb.from("ticket_deps").select(["ticket_id", "depends_on"]).execute()) {
    if (!byId.has(d.ticket_id) || !byId.has(d.depends_on)) continue;
    waits.set(d.ticket_id, [...(waits.get(d.ticket_id) ?? []), d.depends_on]);
    waitedBy.set(d.depends_on, [...(waitedBy.get(d.depends_on) ?? []), d.ticket_id]);
  }
  const out = new Map<number, Unblocks>();
  for (const m of open.filter((t) => t.stage === "merge")) {
    const direct = waitedBy.get(m.id) ?? [];
    const now = direct.filter((id) => (waits.get(id) ?? []).every((b) => b === m.id));
    const seen = new Set<number>([m.id, ...now]);
    const later: number[] = [];
    const queue = [...direct];
    while (queue.length) {
      const id = queue.shift()!;
      if (!seen.has(id)) {
        seen.add(id);
        later.push(id);
      }
      for (const next of waitedBy.get(id) ?? []) if (!seen.has(next) && !queue.includes(next)) queue.push(next);
    }
    if (!now.length && !later.length) continue;
    const num = (ids: number[]) => ids.map((id) => byId.get(id)!.number).sort((a, b) => a - b);
    out.set(m.id, { now: num(now), later: num(later) });
  }
  return out;
}

/** 交通整理を待っているチケットがあり、まだ頼んでいなければリーダーに頼む。 */
export async function requestTriage(p: Project): Promise<boolean> {
  if (!(await untriaged(p)).length) return false;
  const open = await p.pdb.from("messages").select("id").where("kind", "=", "triage").where("status", "in", ["pending", "claimed"]).limit(1).executeTakeFirst();
  if (open) return false;
  await send(p, { ticketId: null, toRole: "lead", kind: "triage", payload: {} });
  return true;
}

/** 交通整理を終えた(または諦めた)チケットを、着手できる状態にする。 */
export async function markTriaged(p: Project, ticketIds: number[]): Promise<void> {
  if (!ticketIds.length) return;
  await p.pdb.update("tickets", { triaged: 1 }).where("id", "in", ticketIds).execute();
}

export async function triagePrompt(p: Project, targets: TicketRow[]): Promise<string> {
  const blocks: string[] = [];
  for (const t of targets) {
    const repo = (await ticketRepo(p, t))?.full_name ?? "";
    blocks.push(`### #${t.number} ${t.title}\nリポジトリ: ${repo}\n${t.body.trim().slice(0, 800) || "(中身なし)"}`);
  }
  const list = blocks.join("\n\n");
  const running = (await p.pdb.from("tickets").where("triaged", "=", 1).where("stage", "not in", ["done", "dropped"]).orderBy("number").execute()) as TicketRow[];
  const lines: string[] = [];
  for (const t of running) {
    const owner = t.owner_member_id ? (await p.member(t.owner_member_id)).name : "未着手";
    const after = await dependsOn(p, t.id);
    const areas = await areasOf(p, t.id);
    lines.push(`- #${t.number} ${t.title} [${t.stage}] 担当: ${owner}${after.length ? ` / 先に: #${after.join(", #")}` : ""}${areas.length ? ` / 触る場所: ${areas.join(", ")}` : ""}`);
  }
  const inflight = lines.join("\n");
  const islands = await teamStatus(p);
  return `新しいチケットが入りました。誰がどの順で取りかかるか、交通整理をしてください。

## 交通整理するチケット
${list}

## 進行中・着手待ちのチケット
${inflight || "(なし)"}

## チームの今(島・メンバー・空き)
${islands}

## 決め方
- できるだけ並列に進めます。島には最大人数ぶんのメンバーがずっといて、同時に実装できます。
- 同時に進めると衝突するもの(土台・共通の設定・同じファイルや同じ表を触るもの)は、先に終わらせるチケットを after に書きます。after のチケットが merge されるまで、そのチケットには着手しません。並べすぎると遅くなるので、本当に必要なものだけにします。
- 触りそうな場所を areas に書きます。ファイルのパス(例: scripts/ci-screenshots.mjs)か、機能のまとまり(例: 認証、メモ一覧)です。同じ場所を書いたチケットどうしは同時に開発せず、先に取りかかった方が merge されてから次が始まります(順番は自動で決まるので、after に書かなくて構いません)。迷ったら、主に書き換えるファイルを 1〜3 個書きます。package.json のような、どのチケットも少し触る共通のファイルは書きません(全部が一列に並んでしまうため)。
- 担当(assignee)には、メンバーの名前か島の名前を書けます。島の名前を書くと、その島のfreeの人に割り当てます。メンバーを名指しすると、その人がfreeになるまで待ちます。省くと、受け持つ島のfreeの人が取ります。
- 交通整理するチケットが、ほかのチケット(交通整理するものどうしも含む)と同じことを扱っていたら、drop_as_duplicate で重複として片付けます。中身は残す方のメモに移ります。片付けたチケットは plan_work に含めません。
- 担当への申し送りがあれば note に書きます(チケットのメモになり、担当が読みます)。
- 全部のチケットについて plan_work を 1 回で呼んでください。最後のテキストは、責任者への短い報告(並列に進めるもの・順番待ちにしたものとその理由)にします。`;
}

export function triageTools(p: Project): KuramotoTool[] {
  return [
    defineTool({
      name: "plan_work",
      description: "チケットの順番(先に終わらせるチケット)と担当を決める。既に決めたものを変えるのにも使う。",
      input: {
        items: z.array(
          z.object({
            number: z.number().int().describe("チケット番号"),
            after: z.array(z.number().int()).default([]).describe("先に merge されている必要があるチケット番号"),
            areas: z.array(z.string()).default([]).describe("触りそうな場所(ファイルのパスか機能のまとまり)。同じ場所を書いたチケットは同時に開発しない"),
            assignee: z.string().optional().describe("担当にしたい人の名前、または島の名前(島ならfreeの人に割り当てる)。省くとfreeの人が取る"),
            note: z.string().optional().describe("担当への申し送り"),
          }),
        ),
      },
      handler: (a) => planWork(p, a.items),
    }),
    defineTool({
      name: "drop_as_duplicate",
      description: "ほかのチケットと同じことを扱う(重複している)チケットを、重複として片付ける。中身は残す方のチケットにメモとして移す。まだ誰も取りかかっていないチケットだけに使える。",
      input: {
        number: z.number().int().describe("片付けるチケットの番号"),
        same_as: z.number().int().describe("残す方のチケットの番号"),
      },
      handler: (a) => dropAsDuplicate(p, a.number, a.same_as),
    }),
    defineTool({
      name: "team_status",
      description: "島ごとのメンバー・作業中のチケット・空き席・待ちの件数を見る。",
      input: {},
      handler: () => teamStatus(p),
    }),
  ];
}

/** 重複したチケットを片付ける。まだ開発に取りかかっていないものだけ。中身は残す方のメモに移す。 */
export async function dropAsDuplicate(p: Project, number: number, sameAs: number): Promise<string> {
  const t = (await p.pdb.from("tickets").where("number", "=", number).executeTakeFirst()) as TicketRow | undefined;
  const keep = (await p.pdb.from("tickets").where("number", "=", sameAs).executeTakeFirst()) as TicketRow | undefined;
  if (!t || !keep) return `#${!t ? number : sameAs} はありません`;
  if (t.id === keep.id) return "同じチケットです";
  if (t.stage === "done" || t.stage === "dropped") return `#${number} はもう終わっています`;
  if (keep.stage === "dropped") return `#${sameAs} は取りやめになっています。残す方には、開いているチケットを選んでください`;
  if (await p.pdb.from("runs").select("id").where("ticket_id", "=", t.id).where("role", "=", "dev").limit(1).executeTakeFirst()) return `#${number} はもう開発に取りかかっているので、重複として片付けられません`;
  await p.pdb.transaction(async () => {
    await p.addNote(keep.id, `【重複していた #${number} から】${t.title}\n${t.body.trim().slice(0, 1500)}`, "lead");
    // 片付けたチケットを待っていたものは、残す方を待つ
    await dropTicket(p, t.id, { by: "lead", reason: `#${sameAs}「${keep.title}」と重複していたため`, sameAs: keep });
  });
  return `#${number} を #${sameAs} の重複として片付けました。`;
}

export async function planWork(p: Project, items: { number: number; after?: number[]; areas?: string[]; assignee?: string; note?: string }[]): Promise<string> {
  const byNumber = new Map((await p.tickets()).map((t) => [t.number, t]));
  const problems: string[] = [];
  for (const it of items) {
    if (!byNumber.has(it.number)) problems.push(`#${it.number} はありません`);
    for (const n of it.after ?? []) {
      if (!byNumber.has(n)) problems.push(`#${it.number} の after にある #${n} はありません`);
      if (n === it.number) problems.push(`#${it.number} が自分を待っています`);
    }
  }
  if (problems.length) return `直してください: ${problems.join(" / ")}`;
  // 新しい順番で循環しないか確かめる
  const edges = new Map<number, number[]>();
  const numberOf = new Map((await p.tickets()).map((t) => [t.id, t.number]));
  const deps = await p.pdb.from("ticket_deps").select(["ticket_id", "depends_on"]).execute();
  for (const t of byNumber.values()) edges.set(t.number, deps.filter((d) => d.ticket_id === t.id).map((d) => numberOf.get(d.depends_on)!).sort((x, y) => x - y));
  for (const it of items) edges.set(it.number, it.after ?? []);
  const state = new Map<number, number>();
  const cyclic = (n: number): boolean => {
    if (state.get(n) === 1) return true;
    if (state.get(n) === 2) return false;
    state.set(n, 1);
    const r = (edges.get(n) ?? []).some(cyclic);
    state.set(n, 2);
    return r;
  };
  if ([...edges.keys()].some(cyclic)) return "順番が循環しています(A は B を待ち、B は A を待つ)。after を見直してください。";

  const out: string[] = [];
  await p.pdb.transaction(async () => {
    for (const it of items) {
      const t = byNumber.get(it.number)!;
      await p.pdb.deleteFrom("ticket_deps").where("ticket_id", "=", t.id).execute();
      const after = [...new Set(it.after ?? [])];
      if (after.length) await p.pdb.insert("ticket_deps", after.map((n) => ({ ticket_id: t.id, depends_on: byNumber.get(n)!.id }))).execute();
      if (it.areas) {
        await p.pdb.deleteFrom("ticket_areas").where("ticket_id", "=", t.id).execute();
        const areas = [...new Set(it.areas.map(normalizeArea).filter(Boolean))];
        if (areas.length) await p.pdb.insert("ticket_areas", areas.map((area) => ({ ticket_id: t.id, area }))).execute();
      }
      let who = "freeの人";
      if (it.assignee) {
        const devUnits = (await p.currentFormation()).units.filter((u) => u.roles.includes("dev" as WorkRole));
        const island = devUnits.find((u) => u.name === it.assignee);
        let m = (await Promise.all(devUnits.map((u) => p.membersOfUnit(u.id)))).flat().find((x) => x.name === it.assignee);
        if (island) {
          // 島を指定: free(まだ割り当てのない人)がいればその人。いなければ、島の誰かが空いたら取る
          const runningNow = await p.pdb.from("runs").select("member_id").where("ended_at", "is", null).execute();
          const queued = await p.pdb.from("messages").select("to_member_id").where("status", "=", "pending").where("kind", "=", "implement").where("to_member_id", "is not", null).execute();
          const busy = new Set<number>([...runningNow.map((r) => r.member_id), ...queued.map((r) => r.to_member_id!)]);
          m = (await p.membersOfUnit(island.id)).find((x) => !busy.has(x.id));
          if (!m) out.push(`${island.name} にfreeの人がいないので、#${it.number} は ${island.name} の誰かが空いたら取ります`);
        }
        if (m) {
          await p.pdb.update("messages", { to_member_id: m.id }).where("ticket_id", "=", t.id).where("kind", "=", "implement").where("status", "=", "pending").execute();
          who = m.name;
        } else if (!island) out.push(`${it.assignee} は開発の島にいません。#${it.number} はfreeの人が取ります`);
      }
      if (it.note?.trim()) await p.addNote(t.id, it.note, "lead");
      await p.event((await p.fixedMember("lead")).name, "ticket_planned", t.id, { after: it.after ?? [], areas: await areasOf(p, t.id), assignee: who });
    }
  });
  return [`${items.length} 件を決めました。`, ...out].join("\n");
}

/** リーダーに渡す、チームの今。島ごとの役割・受け持ち・最大人数・メンバー(作業中のチケット / 割り当て待ち / free)・待ちの件数。 */
export async function teamStatus(p: Project): Promise<string> {
  const runningRows = await p.pdb.k
    .selectFrom("runs as r")
    .innerJoin("messages as m", "m.id", "r.message_id")
    .leftJoin("tickets as t", "t.id", "r.ticket_id")
    .select(["r.member_id", "t.number", "m.kind"])
    .where("r.project_id", "=", p.pdb.projectId)
    .where("r.ended_at", "is", null)
    .execute();
  const running = new Map(runningRows.map((r) => [r.member_id, r]));
  const assigned = (
    await p.pdb.k
      .selectFrom("messages as m")
      .innerJoin("tickets as t", "t.id", "m.ticket_id")
      .select(["m.to_member_id", "t.number"])
      .where("m.project_id", "=", p.pdb.projectId)
      .where("m.status", "=", "pending")
      .where("m.to_member_id", "is not", null)
      .execute()
  ).map((r) => ({ to_member_id: r.to_member_id!, number: r.number }));
  // 待ち(宛先の人が決まっていない・取り出していない仕事)の宛先の役割ごとの件数。島ごとの合計は下で出す
  const waitingRows = await p.pdb.from("messages").select("to_role").where("status", "=", "pending").where("to_member_id", "is", null).execute();
  const waitingBy = new Map<string, number>();
  for (const w of waitingRows) waitingBy.set(w.to_role, (waitingBy.get(w.to_role) ?? 0) + 1);
  const lines = await Promise.all((await p.currentFormation()).units.map(async (u) => {
      const members = await p.membersOfUnit(u.id);
      const ms = members.map((m) => {
        const r = running.get(m.id);
        const queue = assigned.filter((a) => a.to_member_id === m.id).map((a) => `#${a.number}`);
        const state = r ? `#${r.number ?? "?"} の${r.kind}中` : "free";
        return `${m.name}: ${state}${queue.length ? ` / 次に ${queue.join("・")}` : ""}`;
      });
      const waiting = u.roles.reduce((n, r) => n + (waitingBy.get(r) ?? 0), 0);
      return `- ${u.name}(${u.roles.map((r) => ROLE_LABEL[r]).join("・")}): ${members.length}/${u.max_members} 人${u.repos.length ? ` / 受け持ち ${u.repos.join("・")}` : ""}${u.focus ? ` / 重視: ${u.focus}` : ""} / 待ち ${waiting} 件\n  ${ms.join("\n  ") || "(まだ誰もいません)"}`;
  }));
  return lines.join("\n");
}

/** 交通整理の起動に失敗し続けたら、止めずに流す(freeの人が番号順に取る)。 */
export async function giveUpTriage(p: Project): Promise<void> {
  await p.pdb.transaction(async () => markTriaged(p, (await untriaged(p)).map((t) => t.id)));
}
