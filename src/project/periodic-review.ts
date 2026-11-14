import { z } from "zod";
import { iso } from "../clock.js";
import { KIND_LABEL, TICKET_KINDS } from "../domain/flow.js";
import { ROLE_LABEL, type Role } from "../domain/roles.js";
import { defineTool, type KuramotoTool } from "../harness/types.js";
import { send } from "./inbox.js";
import { screens } from "./planning.js";
import type { Project, TicketRow } from "./project.js";
import { createTicket } from "./workflow.js";

/**
 * 定期レビュー(#89、docs/periodic-review.md)。観点(レビューで見ること)・頻度・担当・対象を持つ定義を作り、
 * 決まった頻度で Kuramoto が起動して、見つけたものを種類を付けてチケットに切る。
 * - 頻度は every_hours(毎日 = 24、毎週 = 168)。次の起動は (last_run_at ?? created_at) + every_hours。起動するたびに last_run_at を進める。
 * - 起動は始業中の housekeep(見回りと同じところ)から。メッセージ kind = periodic_review を、担当の役割に送る(チケットは持たない)。
 * - 実行の記録は periodic_review_runs(いつ・何を見て・何件切ったか・重複で何件切らなかったか)。
 * - 重複: 開いているチケットと題名が似ているもの(findDuplicate)は切らず、skipped_duplicates に数える。
 */

export const REVIEW_ROLES = ["designer", "qa", "review", "sec", "lead"] as const satisfies readonly Role[];
export type ReviewRole = (typeof REVIEW_ROLES)[number];
export const TARGET_KINDS = ["all_screens", "screens", "repo"] as const;
export type TargetKind = (typeof TARGET_KINDS)[number];
export const TARGET_LABEL: Record<TargetKind, string> = { all_screens: "全画面", screens: "選んだ画面", repo: "リポジトリ全体" };
/** 頻度の上限(1 年)と下限(1 時間)。 */
export const MAX_EVERY_HOURS = 24 * 365;

export type ReviewTemplate = { key: string; name: string; viewpoint: string; everyHours: number; role: ReviewRole; targetKind: TargetKind };
/** 最初の観点。ひな形から作ると、template にこの key が残る。 */
export const REVIEW_TEMPLATES: ReviewTemplate[] = [
  {
    key: "designer_screens",
    name: "デザイナーによる画面レビュー",
    viewpoint: [
      "企画で合意した試作(画面ごとの HTML とお手本の画像)と、今の描画(アプリを動かして 1280px と 390px で撮ったもの)を見比べ、ずれを洗い出す。",
      "- 並び・入っている要素・文言・色・余白・大きさが試作と違うところ",
      "- デザインシステムのトークン(CSS 変数)を使わず、独自の色・文字・余白・角丸・影を置いているところ",
      "- 共通の部品(ボタン・入力欄など)を使わず、画面ごとに作っているところ",
      "見つけたものは 1 件ごとに、どの画面のどこが・試作とどう違うかを書いて、バグ修正のチケットにする。",
    ].join("\n"),
    everyHours: 168,
    role: "designer",
    targetKind: "all_screens",
  },
];

export type PeriodicReview = {
  id: number;
  name: string;
  viewpoint: string;
  template: string | null;
  everyHours: number;
  role: ReviewRole;
  targetKind: TargetKind;
  targetScreens: string[];
  enabled: boolean;
  lastRunAt: string | null;
  createdAt: string;
  /** 次の起動の予定(無効のときは null) */
  nextRunAt: string | null;
};
export type PeriodicReviewRun = {
  id: number;
  reviewId: number;
  origin: "schedule" | "manual";
  status: "queued" | "running" | "done" | "error";
  lookedAt: string;
  createdTickets: number[];
  skippedDuplicates: number;
  summary: string | null;
  error: string | null;
  createdAt: string;
  endedAt: string | null;
};

/** 画面から受け取る定義(作る・直す)。 */
export const reviewInput = z.object({
  name: z.string().trim().min(1, "名前がありません").max(80, "名前は 80 字までです"),
  viewpoint: z.string().trim().min(1, "観点がありません").max(8000, "観点は 8000 字までです"),
  everyHours: z.number().int("頻度は整数(時間)で入れてください").min(1, "頻度は 1 時間以上にしてください").max(MAX_EVERY_HOURS, "頻度は 1 年以内にしてください"),
  role: z.enum(REVIEW_ROLES),
  targetKind: z.enum(TARGET_KINDS),
  targetScreens: z.array(z.string()).default([]),
});
export type ReviewInput = z.infer<typeof reviewInput>;

type Row = {
  id: number; name: string; viewpoint: string; template: string | null; every_hours: number; role: string; target_kind: TargetKind;
  target_screens: string; enabled: number; last_run_at: string | null; created_at: string;
};

function nextOf(r: Row): string | null {
  if (!r.enabled) return null;
  return iso(new Date(Date.parse(r.last_run_at ?? r.created_at) + r.every_hours * 3_600_000));
}

function viewOf(r: Row): PeriodicReview {
  return {
    id: r.id, name: r.name, viewpoint: r.viewpoint, template: r.template, everyHours: r.every_hours, role: r.role as ReviewRole, targetKind: r.target_kind,
    targetScreens: JSON.parse(r.target_screens) as string[], enabled: !!r.enabled, lastRunAt: r.last_run_at, createdAt: r.created_at, nextRunAt: nextOf(r),
  };
}

async function rowOf(p: Project, id: number): Promise<Row> {
  const r = (await p.pdb.from("periodic_reviews").selectAll().where("id", "=", id).executeTakeFirst()) as Row | undefined;
  if (!r) throw new Error(`定期レビュー ${id} はありません`);
  return r;
}

export async function listPeriodicReviews(p: Project): Promise<PeriodicReview[]> {
  return ((await p.pdb.from("periodic_reviews").selectAll().orderBy("id").execute()) as Row[]).map(viewOf);
}

/** 直近の実行の記録(新しい順)。reviewId があればその定義のもの。 */
export async function listPeriodicRuns(p: Project, reviewId?: number, limit = 20): Promise<PeriodicReviewRun[]> {
  let q = p.pdb.from("periodic_review_runs").selectAll();
  if (reviewId !== undefined) q = q.where("review_id", "=", reviewId);
  const rows = await q.orderBy("id", "desc").limit(limit).execute();
  return rows.map((r) => ({
    id: r.id, reviewId: r.review_id, origin: r.origin, status: r.status, lookedAt: r.looked_at, createdTickets: JSON.parse(r.created_tickets) as number[],
    skippedDuplicates: r.skipped_duplicates, summary: r.summary, error: r.error, createdAt: r.created_at, endedAt: r.ended_at,
  }));
}

/** 画面の一覧と、ひな形(すでにあるかの印つき)。 */
export async function periodicReviewsView(p: Project) {
  const reviews = await listPeriodicReviews(p);
  const screenList = [...(await screens(p))].map(([key, s]) => ({ key, name: s.name, device: s.device }));
  return {
    reviews,
    runs: await listPeriodicRuns(p),
    screens: screenList,
    templates: REVIEW_TEMPLATES.map((t) => ({ ...t, added: reviews.some((r) => r.template === t.key) })),
  };
}

async function checkScreens(p: Project, input: ReviewInput): Promise<string> {
  if (input.targetKind !== "screens") return "[]";
  const known = new Set((await screens(p)).keys());
  const bad = input.targetScreens.filter((k) => !known.has(k));
  if (bad.length) throw new Error(`画面 ${bad.join("・")} は企画にありません`);
  if (!input.targetScreens.length) throw new Error("見る画面を 1 つ以上選んでください");
  return JSON.stringify([...new Set(input.targetScreens)]);
}

export async function createPeriodicReview(p: Project, raw: unknown, template?: string): Promise<PeriodicReview> {
  let input: ReviewInput;
  if (template !== undefined) {
    const t = REVIEW_TEMPLATES.find((x) => x.key === template);
    if (!t) throw new Error(`ひな形 ${template} はありません`);
    input = reviewInput.parse({ name: t.name, viewpoint: t.viewpoint, everyHours: t.everyHours, role: t.role, targetKind: t.targetKind });
  } else input = reviewInput.parse(raw);
  const id = await p.pdb.dialect.insertedId(
    p.pdb.insert("periodic_reviews", {
      name: input.name, viewpoint: input.viewpoint, template: template ?? null, every_hours: input.everyHours, role: input.role, target_kind: input.targetKind,
      target_screens: await checkScreens(p, input), enabled: 1, created_at: p.now(),
    }),
  );
  return viewOf(await rowOf(p, id));
}

export async function updatePeriodicReview(p: Project, id: number, raw: unknown): Promise<PeriodicReview> {
  await rowOf(p, id);
  const input = reviewInput.parse(raw);
  await p.pdb
    .update("periodic_reviews", { name: input.name, viewpoint: input.viewpoint, every_hours: input.everyHours, role: input.role, target_kind: input.targetKind, target_screens: await checkScreens(p, input) })
    .where("id", "=", id)
    .execute();
  return viewOf(await rowOf(p, id));
}

export async function setPeriodicReviewEnabled(p: Project, id: number, enabled: boolean): Promise<PeriodicReview> {
  const r = await rowOf(p, id);
  // 無効から有効に戻すときは、そこから 1 頻度ぶん待つ(溜まっていた分を一度に回さない)
  await p.pdb.update("periodic_reviews", { enabled: enabled ? 1 : 0, ...(enabled && !r.enabled ? { last_run_at: p.now() } : {}) }).where("id", "=", id).execute();
  return viewOf(await rowOf(p, id));
}

export async function deletePeriodicReview(p: Project, id: number): Promise<void> {
  await rowOf(p, id);
  await p.pdb.transaction(async () => {
    // 待っているメッセージは、payload を読んで、この定義のものだけを消す(payload の文字列の並びには頼らない)
    const waiting = await p.pdb.from("messages").select(["id", "payload"]).where("kind", "=", "periodic_review").where("status", "=", "pending").execute();
    const mine = waiting.filter((m) => (JSON.parse(m.payload) as { reviewId?: number }).reviewId === id).map((m) => m.id);
    if (mine.length) await p.pdb.deleteFrom("messages").where("id", "in", mine).execute();
    await p.pdb.deleteFrom("periodic_review_runs").where("review_id", "=", id).execute();
    await p.pdb.deleteFrom("periodic_reviews").where("id", "=", id).execute();
  });
}

/** 何を見るか(実行の記録の「見たもの」)。 */
export async function describeTarget(p: Project, r: { targetKind: TargetKind; targetScreens: string[] }): Promise<string> {
  if (r.targetKind === "repo") return "リポジトリ全体";
  const all = await screens(p);
  const keys = r.targetKind === "all_screens" ? [...all.keys()] : r.targetScreens;
  return `${keys.length ? keys.map((k) => all.get(k)?.name ?? k).join("・") : "(画面なし)"}(1280px・390px)`;
}

/**
 * 待ち・実行中のまま取り残された回を、error で閉じる。ひも付くメッセージが、もう待っても動いてもいない(再試行が尽きて failed・done になった、消えた)回のこと。
 * 閉じておかないと、activeRun に数えられ続けて、その定義が定期でも手動でも二度と起動しなくなる。
 */
export async function closeStaleRuns(p: Project, reviewId: number): Promise<number> {
  const active = await p.pdb.from("periodic_review_runs").select("id").where("review_id", "=", reviewId).where("status", "in", ["queued", "running"]).execute();
  if (!active.length) return 0;
  const live = new Set(
    (await p.pdb.from("messages").select("payload").where("kind", "=", "periodic_review").where("status", "in", ["pending", "claimed"]).execute()).map((m) => (JSON.parse(m.payload) as { runId?: number }).runId),
  );
  const stale = active.filter((r) => !live.has(r.id));
  for (const r of stale) await finishPeriodicRun(p, r.id, { error: "起動が失敗して取り残されていたので閉じました" });
  return stale.length;
}

async function activeRun(p: Project, reviewId: number) {
  await closeStaleRuns(p, reviewId);
  return p.pdb.from("periodic_review_runs").select("id").where("review_id", "=", reviewId).where("status", "in", ["queued", "running"]).limit(1).executeTakeFirst();
}

/** 定期レビューを 1 回起動する(記録を作り、担当の役割に頼む)。もう待っている・動いている回があれば起動しない(null)。 */
export async function startPeriodicRun(p: Project, reviewId: number, origin: "schedule" | "manual"): Promise<number | null> {
  const r = viewOf(await rowOf(p, reviewId));
  return await p.pdb.transaction(async () => {
    if (await activeRun(p, reviewId)) return null;
    const runId = await p.pdb.dialect.insertedId(
      p.pdb.insert("periodic_review_runs", { review_id: reviewId, origin, status: "queued", looked_at: await describeTarget(p, r), created_at: p.now() }),
    );
    await p.pdb.update("periodic_reviews", { last_run_at: p.now() }).where("id", "=", reviewId).execute();
    await send(p, { ticketId: null, toRole: r.role, kind: "periodic_review", payload: { reviewId, runId } });
    await p.event("system", "periodic_review_queued", null, { review: r.name, origin });
    return runId;
  });
}

/** 頻度が来た定期レビューを起動する(始業中の housekeep から呼ぶ)。起動した数を返す。 */
export async function requestPeriodicReviews(p: Project): Promise<number> {
  const now = p.clock.now().getTime();
  let n = 0;
  for (const r of await listPeriodicReviews(p)) {
    if (!r.enabled || !r.nextRunAt || Date.parse(r.nextRunAt) > now) continue;
    if ((await startPeriodicRun(p, r.id, "schedule")) !== null) n++;
  }
  return n;
}

// ---- 実行 ----

/** 1 回の実行の途中経過(切ったチケットと重複で切らなかった数)を、記録に書き足す。 */
async function addToRun(p: Project, runId: number, d: { ticket?: number; skipped?: number }): Promise<void> {
  const row = await p.pdb.from("periodic_review_runs").select(["created_tickets", "skipped_duplicates"]).where("id", "=", runId).executeTakeFirst();
  if (!row) return;
  const tickets = JSON.parse(row.created_tickets) as number[];
  if (d.ticket !== undefined) tickets.push(d.ticket);
  await p.pdb.update("periodic_review_runs", { created_tickets: JSON.stringify(tickets), skipped_duplicates: row.skipped_duplicates + (d.skipped ?? 0) }).where("id", "=", runId).execute();
}

export async function markPeriodicRunStarted(p: Project, runId: number): Promise<void> {
  await p.pdb.update("periodic_review_runs", { status: "running", started_at: p.now() }).where("id", "=", runId).execute();
}

export async function finishPeriodicRun(p: Project, runId: number, r: { error?: string; summary?: string }): Promise<void> {
  await p.pdb.update("periodic_review_runs", { status: r.error ? "error" : "done", error: r.error ?? null, summary: r.summary?.trim() || null, ended_at: p.now() }).where("id", "=", runId).execute();
}

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
function bigrams(s: string): Map<string, number> {
  const m = new Map<string, number>();
  for (let i = 0; i < s.length - 1; i++) m.set(s.slice(i, i + 2), (m.get(s.slice(i, i + 2)) ?? 0) + 1);
  return m;
}
/** 題名の近さ(0〜1。2 文字ずつの重なり)。 */
export function similarity(a: string, b: string): number {
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  const bx = bigrams(x);
  const by = bigrams(y);
  let common = 0;
  for (const [g, n] of bx) common += Math.min(n, by.get(g) ?? 0);
  const total = x.length - 1 + (y.length - 1);
  return total > 0 ? (2 * common) / total : 0;
}
export const DUPLICATE_SIMILARITY = 0.7;

/** 開いている(終わっていない・取りやめていない)チケットのうち、題名が同じか似ているもの。 */
export async function findDuplicate(p: Project, title: string): Promise<TicketRow | undefined> {
  return (await p.tickets()).filter((t) => t.stage !== "done" && t.stage !== "dropped").find((t) => similarity(t.title, title) >= DUPLICATE_SIMILARITY);
}

export async function periodicReviewPrompt(p: Project, review: PeriodicReview, run: { id: number; lookedAt: string }): Promise<string> {
  const open = (await p.tickets()).filter((t) => t.stage !== "done" && t.stage !== "dropped");
  const board = open.map((t) => `- #${t.number} ${t.title}`).join("\n") || "(なし)";
  const all = await screens(p);
  const keys = review.targetKind === "all_screens" ? [...all.keys()] : review.targetKind === "screens" ? review.targetScreens : [];
  const list = keys.map((k) => `- ${k}: ${all.get(k)?.name ?? k}(${all.get(k)?.device === "phone" ? "スマホ" : "パソコン"})`).join("\n");
  const target =
    review.targetKind === "repo"
      ? "リポジトリ全体(コードを読んで観点に当てはめる)"
      : `企画の画面。試作の HTML とお手本の画像は .kuramoto/design/ にあります。今の描画は、アプリを動かして render_page 系の道具で 1280px・390px で撮って見比べてください。\n${list || "(画面がありません)"}`;
  return `定期レビュー「${review.name}」の時間です(${ROLE_LABEL[review.role]}として見ます)。

## 観点(見ること)
${review.viewpoint}

## 対象
${target}

## 今開いているチケット(同じことで重ねて切らない)
${board}

見つけたものは 1 件ずつ create_review_ticket でチケットにしてください。種類は必ず選びます(ずれ・不具合は bugfix。${TICKET_KINDS.map((k) => `${k}: ${KIND_LABEL[k]}`).join(" / ")})。題名は「何がどうずれているか」が分かるものにして、本文に場所・どう違うか・直し方の目安を書きます。既に開いているチケットと同じものは、切っても重複として断られます。見つからなければ、チケットは切らずに「問題なし」と書いてください。最後のテキストが、この回の記録の要約になります(見たもの: ${run.lookedAt})。`;
}

export function periodicReviewTools(p: Project, review: PeriodicReview, runId: number): KuramotoTool[] {
  return [
    defineTool({
      name: "create_review_ticket",
      description: "定期レビューで見つけたものを、チケットとして開発の受信箱に入れる(多くはバグ修正)。開いているチケットと題名が似ているものは重複として切らない。",
      input: {
        title: z.string(),
        body: z.string().describe("どこが・どう違うか・直し方の目安・受け入れ条件"),
        kind: z.enum(TICKET_KINDS).default("bugfix").describe(`チケットの種類(${TICKET_KINDS.map((k) => `${k}: ${KIND_LABEL[k]}`).join(" / ")})`),
        screens: z.array(z.string()).optional().describe("ひも付ける企画の画面の key(画面のずれなら必ず付ける。担当に試作とお手本の画像が渡る)"),
      },
      handler: async (a) => {
        const known = new Set((await screens(p)).keys());
        const bad = (a.screens ?? []).filter((k) => !known.has(k));
        if (bad.length) return `画面 ${bad.join("・")} は企画にありません。使えるのは ${[...known].join("・") || "(なし)"}`;
        const dup = await findDuplicate(p, a.title);
        if (dup) {
          await addToRun(p, runId, { skipped: 1 });
          return `重複です(#${dup.number}「${dup.title}」が開いています)。チケットは増やしません。`;
        }
        const t = await createTicket(p, {
          title: a.title,
          body: `${a.body}\n\n(定期レビュー「${review.name}」で見つけました)`,
          kind: a.kind ?? "bugfix",
          planRefs: { ...(a.screens?.length ? { screens: a.screens } : {}) },
        });
        await addToRun(p, runId, { ticket: t.number });
        return `#${t.number} を作りました。`;
      },
    }),
  ];
}
