import { z } from "zod";
import { all, get, run, tx } from "../db/sqlite.js";
import { ROLE_LABEL, type WorkRole } from "../domain/roles.js";
import { defineTool, type KuramotoTool } from "../harness/types.js";
import { send } from "./inbox.js";
import type { Project, TicketRow } from "./project.js";
import { ticketRepo } from "./dispatcher.js";

/**
 * リーダーの交通整理。新しいチケットが入ると、リーダーが「どの順で・誰が」やるかを決める。
 * - 先に終わらせるべきチケット(土台・同じファイルを触るもの)を after に書くと、それが merge されるまで着手しない。
 * - 触りそうな場所(areas)が同じチケットは同時に開発しない。先に取りかかった方が merge されてから次が始まる(ADR-0024)。
 * - 担当を名指しすると、その人が手すきになったときに取る。名指ししなければ手すきの人が取る(島のメンバーは最大人数ぶんずっといる)。
 * 交通整理が済むまで、そのチケットの実装は始めない。
 */

export function untriaged(p: Project): TicketRow[] {
  return all<TicketRow>(p.db, "SELECT * FROM tickets WHERE triaged = 0 AND stage NOT IN ('done','dropped') ORDER BY number");
}

export function dependsOn(p: Project, ticketId: number): number[] {
  return all<{ number: number }>(p.db, "SELECT t.number FROM ticket_deps d JOIN tickets t ON t.id = d.depends_on WHERE d.ticket_id = ? ORDER BY t.number", [ticketId]).map((r) => r.number);
}

/** 先に終わらせるチケットのうち、まだ merge されていないもの。 */
export function blockers(p: Project, ticketId: number): number[] {
  return all<{ number: number }>(
    p.db,
    "SELECT t.number FROM ticket_deps d JOIN tickets t ON t.id = d.depends_on WHERE d.ticket_id = ? AND t.stage NOT IN ('done','dropped') ORDER BY t.number",
    [ticketId],
  ).map((r) => r.number);
}

/**
 * 触る場所を正規化する。大文字小文字・前後の空白・先頭の ./ と末尾の / をそろえる。
 */
export function normalizeArea(a: string): string {
  return a.trim().toLowerCase().replace(/^\.\//, "").replace(/\/+$/, "");
}

export function areasOf(p: Project, ticketId: number): string[] {
  return all<{ area: string }>(p.db, "SELECT area FROM ticket_areas WHERE ticket_id = ? ORDER BY area", [ticketId]).map((r) => r.area);
}

/** 同じ場所を触っていて、先に進んでいるチケット(番号と、重なっている場所)。 */
export function areaBlockers(p: Project, ticketId: number): { number: number; areas: string[] }[] {
  const rows = all<{ number: number; area: string }>(
    p.db,
    `SELECT o.number, a.area FROM ticket_areas a JOIN ticket_areas b ON b.area = a.area AND b.ticket_id <> a.ticket_id
     JOIN tickets o ON o.id = b.ticket_id
     WHERE a.ticket_id = ? AND o.stage NOT IN ('done','dropped')
       AND (EXISTS (SELECT 1 FROM runs r WHERE r.ticket_id = o.id AND r.role = 'dev')
         OR EXISTS (SELECT 1 FROM messages mm WHERE mm.ticket_id = o.id AND mm.kind = 'implement' AND mm.status = 'claimed'))
     ORDER BY o.number, a.area`,
    [ticketId],
  );
  const by = new Map<number, string[]>();
  for (const r of rows) by.set(r.number, [...(by.get(r.number) ?? []), r.area]);
  return [...by].map(([number, areas]) => ({ number, areas }));
}

/** まだ開発に取りかかっていないチケットが、同じ場所を触るチケットを待っているか(取りかかった後は待たない)。 */
export function areaWait(p: Project, ticketId: number): { number: number; areas: string[] }[] {
  if (get(p.db, "SELECT 1 AS x FROM runs WHERE ticket_id = ? AND role = 'dev'", [ticketId])) return [];
  return areaBlockers(p, ticketId);
}

/** 先に終わらせるチケットのうち、merge 待ちの棚にあるもの(責任者が merge を押せば外れる)。 */
export function mergeBlockers(p: Project, ticketId: number): number[] {
  return all<{ number: number }>(
    p.db,
    "SELECT t.number FROM ticket_deps d JOIN tickets t ON t.id = d.depends_on WHERE d.ticket_id = ? AND t.stage = 'merge' ORDER BY t.number",
    [ticketId],
  ).map((r) => r.number);
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
export function mergeUnblocks(p: Project): Map<number, Unblocks> {
  const open = all<{ id: number; number: number; stage: string }>(p.db, "SELECT id, number, stage FROM tickets WHERE stage NOT IN ('done','dropped')");
  const byId = new Map(open.map((t) => [t.id, t]));
  // 待っている側 → 待たれている側(どちらも終わっていないもの)
  const waits = new Map<number, number[]>();
  const waitedBy = new Map<number, number[]>();
  for (const d of all<{ ticket_id: number; depends_on: number }>(p.db, "SELECT ticket_id, depends_on FROM ticket_deps")) {
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
export function requestTriage(p: Project): boolean {
  if (!untriaged(p).length) return false;
  const open = get<{ n: number }>(p.db, "SELECT COUNT(*) AS n FROM messages WHERE kind = 'triage' AND status IN ('pending','claimed')")?.n ?? 0;
  if (open) return false;
  send(p, { ticketId: null, toRole: "lead", kind: "triage", payload: {} });
  return true;
}

/** 交通整理を終えた(または諦めた)チケットを、着手できる状態にする。 */
export function markTriaged(p: Project, ticketIds: number[]): void {
  for (const id of ticketIds) run(p.db, "UPDATE tickets SET triaged = 1 WHERE id = ?", [id]);
}

export function triagePrompt(p: Project, targets: TicketRow[]): string {
  const repoOf = (t: TicketRow) => ticketRepo(p, t)?.full_name ?? "";
  const list = targets
    .map((t) => `### #${t.number} ${t.title}\nリポジトリ: ${repoOf(t)}\n${t.body.trim().slice(0, 800) || "(中身なし)"}`)
    .join("\n\n");
  const inflight = all<TicketRow>(p.db, "SELECT * FROM tickets WHERE triaged = 1 AND stage NOT IN ('done','dropped') ORDER BY number")
    .map((t) => {
      const owner = t.owner_member_id ? p.member(t.owner_member_id).name : "未着手";
      const after = dependsOn(p, t.id);
      const areas = areasOf(p, t.id);
      return `- #${t.number} ${t.title} [${t.stage}] 担当: ${owner}${after.length ? ` / 先に: #${after.join(", #")}` : ""}${areas.length ? ` / 触る場所: ${areas.join(", ")}` : ""}`;
    })
    .join("\n");
  const islands = teamStatus(p);
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
- 担当(assignee)には、メンバーの名前か島の名前を書けます。島の名前を書くと、その島の手すきの人に割り当てます。メンバーを名指しすると、その人が手すきになるまで待ちます。省くと、受け持つ島の手すきの人が取ります。
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
            assignee: z.string().optional().describe("担当にしたい人の名前、または島の名前(島なら手すきの人に割り当てる)。省くと手すきの人が取る"),
            note: z.string().optional().describe("担当への申し送り"),
          }),
        ),
      },
      handler: (a) => planWork(p, a.items),
    }),
    defineTool({
      name: "team_status",
      description: "島ごとのメンバー・作業中のチケット・空き席・待ちの件数を見る。",
      input: {},
      handler: () => teamStatus(p),
    }),
  ];
}

export function planWork(p: Project, items: { number: number; after?: number[]; areas?: string[]; assignee?: string; note?: string }[]): string {
  const byNumber = new Map(p.tickets().map((t) => [t.number, t]));
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
  for (const t of byNumber.values()) edges.set(t.number, dependsOn(p, t.id));
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
  tx(p.db, () => {
    for (const it of items) {
      const t = byNumber.get(it.number)!;
      run(p.db, "DELETE FROM ticket_deps WHERE ticket_id = ?", [t.id]);
      for (const n of it.after ?? []) run(p.db, "INSERT INTO ticket_deps (ticket_id, depends_on) VALUES (?, ?)", [t.id, byNumber.get(n)!.id]);
      if (it.areas) {
        run(p.db, "DELETE FROM ticket_areas WHERE ticket_id = ?", [t.id]);
        for (const a of new Set(it.areas.map(normalizeArea).filter(Boolean))) run(p.db, "INSERT INTO ticket_areas (ticket_id, area) VALUES (?, ?)", [t.id, a]);
      }
      let who = "手すきの人";
      if (it.assignee) {
        const devUnits = p.currentFormation().units.filter((u) => u.roles.includes("dev" as WorkRole));
        const island = devUnits.find((u) => u.name === it.assignee);
        let m = devUnits.flatMap((u) => p.membersOfUnit(u.id)).find((x) => x.name === it.assignee);
        if (island) {
          // 島を指定: 手すき(まだ割り当てのない人)がいればその人。いなければ、島の誰かが空いたら取る
          const busy = new Set(
            all<{ id: number }>(p.db, "SELECT member_id AS id FROM runs WHERE ended_at IS NULL UNION SELECT to_member_id AS id FROM messages WHERE status = 'pending' AND kind = 'implement' AND to_member_id IS NOT NULL").map((r) => r.id),
          );
          m = p.membersOfUnit(island.id).find((x) => !busy.has(x.id));
          if (!m) out.push(`${island.name} に手すきの人がいないので、#${it.number} は ${island.name} の誰かが空いたら取ります`);
        }
        if (m) {
          run(p.db, "UPDATE messages SET to_member_id = ? WHERE ticket_id = ? AND kind = 'implement' AND status = 'pending'", [m.id, t.id]);
          who = m.name;
        } else if (!island) out.push(`${it.assignee} は開発の島にいません。#${it.number} は手すきの人が取ります`);
      }
      if (it.note?.trim()) p.addNote(t.id, it.note, "lead");
      p.event(p.fixedMember("lead").name, "ticket_planned", t.id, { after: it.after ?? [], areas: areasOf(p, t.id), assignee: who });
    }
  });
  return [`${items.length} 件を決めました。`, ...out].join("\n");
}

/** リーダーに渡す、チームの今。島ごとの役割・受け持ち・最大人数・メンバー(作業中のチケット / 割り当て待ち / 手すき)・待ちの件数。 */
export function teamStatus(p: Project): string {
  const running = new Map(
    all<{ member_id: number; number: number | null; kind: string }>(
      p.db,
      "SELECT r.member_id, t.number, m.kind FROM runs r JOIN messages m ON m.id = r.message_id LEFT JOIN tickets t ON t.id = r.ticket_id WHERE r.ended_at IS NULL",
    ).map((r) => [r.member_id, r]),
  );
  const assigned = all<{ to_member_id: number; number: number }>(
    p.db,
    "SELECT m.to_member_id, t.number FROM messages m JOIN tickets t ON t.id = m.ticket_id WHERE m.status = 'pending' AND m.to_member_id IS NOT NULL",
  );
  return p
    .currentFormation()
    .units.map((u) => {
      const ms = p.membersOfUnit(u.id).map((m) => {
        const r = running.get(m.id);
        const queue = assigned.filter((a) => a.to_member_id === m.id).map((a) => `#${a.number}`);
        const state = r ? `#${r.number ?? "?"} の${r.kind}中` : "手すき";
        return `${m.name}: ${state}${queue.length ? ` / 次に ${queue.join("・")}` : ""}`;
      });
      const waiting = get<{ n: number }>(
        p.db,
        `SELECT COUNT(*) AS n FROM messages WHERE status = 'pending' AND to_member_id IS NULL AND to_role IN (${u.roles.map(() => "?").join(",") || "''"})`,
        [...u.roles],
      )?.n ?? 0;
      return `- ${u.name}(${u.roles.map((r) => ROLE_LABEL[r]).join("・")}): ${p.membersOfUnit(u.id).length}/${u.max_members} 人${u.repos.length ? ` / 受け持ち ${u.repos.join("・")}` : ""}${u.focus ? ` / 重視: ${u.focus}` : ""} / 待ち ${waiting} 件\n  ${ms.join("\n  ") || "(まだ誰もいません)"}`;
    })
    .join("\n");
}

/** 交通整理の起動に失敗し続けたら、止めずに流す(手すきの人が番号順に取る)。 */
export function giveUpTriage(p: Project): void {
  tx(p.db, () => markTriaged(p, untriaged(p).map((t) => t.id)));
}
