import { sql } from "kysely";
import { inScope, scopeIds } from "../db/count.js";
import type { Role } from "../domain/roles.js";
import { send } from "./inbox.js";
import type { Project } from "./project.js";
import { planningWork } from "./progress.js";
import { existingHandoffText, existingKickoff, fromExisting, snapshotText } from "./onboard.js";

/**
 * 企画スタジオ(docs/design.md 5.1・6.2、ADR-0008・0009・0015)。
 * 要件 → ユーザーフロー → 画面デザイン → インフラ → アーキテクチャとデータ を段階ごとに版で残し、
 * すべての段階が「合意済み / お任せ / 省略」になったらチームに渡す。
 */
export const STAGES = ["req", "flow", "screen", "infra", "model"] as const;
export type Stage = (typeof STAGES)[number];
export type Mode = "agree" | "delegate" | "skip";

export const STAGE_LABEL: Record<Stage, string> = { req: "要件", infra: "インフラ", flow: "ユーザーフロー", screen: "画面デザイン", model: "アーキテクチャとデータ" };

/** 段階ごとの担当。 */
export const STAGE_ROLE: Record<Stage, Role> = { req: "planner", infra: "architect", flow: "designer", screen: "designer", model: "architect" };

export type StageRow = { stage: Stage; mode: Mode; version: number; agreed_version: number | null };

// ---- 中身の形(plan_artifacts.body に JSON で置く) ----

export type Brief = { purpose: string; users: string[]; outOfScope: string[] };

export type FlowNode = { id: string; label: string; sub?: string; col: number; row: number; kind?: "screen" | "question" | "error" };
export type FlowEdge = { from: string; to: string; label?: string; alt?: boolean };
export type Flow = { nodes: FlowNode[]; edges: FlowEdge[] };

export type ScreenVariant = { id: string; html: string; note?: string };
export type Screen = { name: string; device: "phone" | "desktop"; requirements: string[]; variants: ScreenVariant[]; chosen: string | null; agreed: boolean };

export type Domain = {
  terms: string[];
  aggregates: string[];
  rules: string[];
  states: string[];
  boundaries: string[];
  build: { feature: string; decision: "build" | "reuse" | "skip"; note: string }[];
  entities: { name: string; isNew: boolean; fields: string[] }[];
  relations: { from: string; to: string; label: string }[];
};
/** アーキテクチャスタイル(ADR-0016)。アーキテクチャとデータの段階の最初に決める。 */
export type Architecture = {
  style: { name: string; why: string; alternatives: { name: string; whyNot: string }[] };
  modules: { name: string; responsibility: string; repo: string }[];
  principles: string[];
  api: { style: string; notes: string };
  frontend: { rendering: string; state: string };
  stack: { area: string; choice: string; why: string }[];
  /** 技術選定(新しく技術を選ぶ必要がある領域だけ)。既にあるもので決まっている領域は書かない。 */
  selections?: TechSelection[];
};

export type TechSelection = {
  area: string;
  /** なぜ選ぶ必要があるか */
  need: string;
  /** 評価軸 */
  criteria: string[];
  candidates: { name: string; pros: string; cons: string }[];
  choice: string;
  why: string;
  reversible: boolean;
};

/** インフラ(ADR-0015)。どこで・どう動かし、どう届け、どう運用し、いくらかかるか。 */
export type Infra = {
  hosting: { summary: string; reuse: string[] };
  components: { name: string; kind: string; service: string; purpose: string; isNew: boolean }[];
  links: { from: string; to: string; label: string }[];
  environments: { name: string; purpose: string }[];
  deploy: { ci: string; steps: string[]; migrations: string; secrets: string };
  operations: { monitoring: string; logging: string; backup: string; rollback: string };
  cost: { assumptions: string[]; monthly: { item: string; usd: number }[] };
};

/**
 * デザインシステム(ADR-0034)。合意した試作から起こす、画面に共通の決まり。開発チームとの共通言語になる。
 * - tokens: 色・文字・余白・角丸・影を名前付きの値にしたもの(CSS 変数の名前と値)
 * - components: ボタン・入力欄・カード・一覧の行などの部品。見た目(HTML。トークンの CSS 変数を使う)と状態
 */
export type DesignSystem = {
  principles: string[];
  tokens: { group: "color" | "font" | "space" | "radius" | "shadow" | "other"; name: string; value: string; use: string }[];
  components: { name: string; use: string; states: string[]; html: string }[];
};

/** トークンを CSS 変数にしたもの(:root)。試作・部品の見本・開発の土台で同じものを使う。 */
export function designSystemCss(ds: DesignSystem): string {
  const v = (n: string) => (n.startsWith("--") ? n : `--${n}`);
  return `:root {\n${ds.tokens.map((t) => `  ${v(t.name)}: ${t.value}; /* ${t.use.replace(/\*\//g, "")} */`).join("\n")}\n}\n`;
}

export async function designSystem(p: Project): Promise<DesignSystem | null> {
  return artifact<DesignSystem>(p, "screen", "designsystem", "main");
}

export type DataDesign = { tables: { name: string; change: "new" | "alter" | "none"; columns: string[]; note: string; reversible: boolean }[] };

const REMOVED = "__removed__";

// ---- 段階 ----

export async function stageRow(p: Project, s: Stage): Promise<StageRow> {
  const r = await inScope(p.pdb, "plan_stages").where("stage", "=", s).executeTakeFirst();
  if (!r) throw new Error(`段階 ${s} がありません`);
  return r as unknown as StageRow;
}

/**
 * 書き込む版。合意済みの版を直すときは、版を 1 つ上げて新しい下書きにする(合意した版は残る)。
 * 読んでから書くので、トランザクションの中で行う(呼ぶ側が張っていればそこにまとまる)。
 */
export async function draftVersion(p: Project, s: Stage): Promise<number> {
  return p.pdb.transaction(async () => {
    const r = await stageRow(p, s);
    if (r.agreed_version !== null && r.agreed_version === r.version) {
      await p.pdb.update("plan_stages", { version: sql`version + 1` }).where("stage", "=", s).execute();
      if (s === "req") await p.pdb.insert("requirements", { version: r.version + 1, created_at: p.now() }).execute();
      return r.version + 1;
    }
    return r.version;
  });
}

export async function setMode(p: Project, s: Stage, mode: Mode): Promise<void> {
  if (s === "req" && mode === "skip") throw new Error("要件は省けません");
  await p.pdb.transaction(async () => {
    const before = await stageRow(p, s);
    await p.pdb.update("plan_stages", { mode }).where("stage", "=", s).execute();
    // お任せから自分で確かめるに戻したら、合意し直す
    if (before.mode === "delegate" && mode === "agree") await p.pdb.update("plan_stages", { agreed_version: null }).where("stage", "=", s).execute();
    if (mode === "skip") await say(p, s, "me", "この段階は省いて進めます");
    if (mode === "delegate") {
      await say(p, s, "me", "この段階はお任せします");
      await sendPlan(p, s, { type: "delegate", text: "この段階はお任せになりました。未決は推奨で決め、版を仕上げて、決めた内容を報告してください。戻せない判断だけは未決に残してください。" });
    }
    if (before.mode === "skip" && mode === "agree") await say(p, s, "me", "省くのをやめて、この段階を作ります");
    await advance(p);
  });
}

/** 合意できない理由。無ければ合意できる。 */
export async function agreeBlocker(p: Project, s: Stage): Promise<string | null> {
  const r = await stageRow(p, s);
  if (r.mode === "skip") return "この段階は省いています";
  if (r.agreed_version === r.version) return "この版は合意済みです";
  if (!(await hasContent(p, s))) return "まだ中身がありません";
  const open = (await openItems(p, s)).filter((o) => o.answer === null);
  if (open.length) return `未決が ${open.length} 件あります`;
  if (s === "screen") {
    // 画面があるなら、デザインシステムも要る(開発チームとの共通の決まり。ADR-0034)
    const scr = await screens(p);
    if (scr.size && !(await designSystem(p))) return "デザインシステムがまだありません";
    const cs = await commentsByScreen(p);
    for (const [key, sc] of scr) {
      if (sc.variants.length > 1 && !sc.chosen) return `「${sc.name}」の案を選んでください`;
      if ((cs.get(key) ?? []).some((c) => c.resolved_in === null)) return `「${sc.name}」に対応待ちのコメントがあります`;
      if (!sc.agreed) return `「${sc.name}」がまだ合意されていません`;
    }
  }
  return null;
}

export async function agree(p: Project, s: Stage): Promise<void> {
  await p.pdb.transaction(async () => {
    const why = await agreeBlocker(p, s);
    if (why) throw new Error(why);
    const r = await stageRow(p, s);
    // 合意するのは、いま読んだ版(同じトランザクションの中)
    await p.pdb.update("plan_stages", { agreed_version: r.version }).where("stage", "=", s).execute();
    await say(p, s, "planner", `${STAGE_LABEL[s]} v${r.version} に合意をもらいました。`);
    await p.event("owner", "plan_agreed", null, { stage: s, version: r.version });
    await advance(p);
  });
}

export async function hasContent(p: Project, s: Stage): Promise<boolean> {
  switch (s) {
    case "req":
      return (await requirements(p)).length > 0;
    case "infra":
      return (await artifact<Infra>(p, "infra", "infra", "main")) !== null;
    case "flow":
      return (await artifact<Flow>(p, "flow", "flow", "main")) !== null;
    case "screen":
      return (await screens(p)).size > 0;
    case "model":
      return (await artifact<Architecture>(p, "model", "architecture", "main")) !== null || (await artifact<Domain>(p, "model", "domain", "main")) !== null;
  }
}

/** 段階が終わっているか(合意済み・お任せで仕上がった・省略)。 */
export async function stageDone(p: Project, s: Stage): Promise<boolean> {
  const r = await stageRow(p, s);
  if (r.mode === "skip") return true;
  if (r.agreed_version !== null && r.agreed_version === r.version) return true;
  if (r.mode === "delegate") {
    if (!(await hasContent(p, s))) return false;
    if ((await openItems(p, s)).some((o) => o.answer === null)) return false; // 戻せない判断が残っている
    if (s === "screen") {
      const cs = await commentsByScreen(p);
      return [...(await screens(p)).keys()].every((k) => (cs.get(k) ?? []).every((c) => c.resolved_in !== null));
    }
    return true;
  }
  return false;
}

export async function stageStatus(p: Project, s: Stage): Promise<string> {
  const r = await stageRow(p, s);
  if (r.mode === "skip") return "省略";
  if (r.agreed_version !== null && r.agreed_version === r.version) return `合意済み v${r.version}`;
  const open = (await openItems(p, s)).filter((o) => o.answer === null).length;
  if (r.mode === "delegate") return (await stageDone(p, s)) ? `お任せ v${r.version}` : open ? `お任せ(あなたに 未決 ${open})` : "お任せで作成中";
  if (!(await hasContent(p, s))) return await stageStarted(p, s) ? "作成中" : "前の段階を待っています";
  if (open) return `未決 ${open}`;
  if (s === "screen") {
    const waiting = [...(await screens(p)).values()].filter((x) => !x.agreed).length;
    if (waiting) return `${waiting} 画面が合意待ち`;
  }
  return `下書き v${r.version}`;
}

async function stageStarted(p: Project, s: Stage): Promise<boolean> {
  return !!await p.setting(`plan_started:${s}`);
}

/**
 * 段階が終わったら次の段階の担当を起こす(前の段階を終えてから次へ。ADR-0008)。
 * 省いた段階は飛ばす。
 */
export async function advance(p: Project): Promise<void> {
  for (const s of STAGES) {
    if (!await stageStarted(p, s)) {
      if ((await stageRow(p, s)).mode === "skip") continue;
      await kickoff(p, s);
      return;
    }
    // 一度終えた段階は、後から直されて下書きに戻っても、次の段階を止めない(引き渡しの前には合意し直しが要る)
    if (!(await stageDone(p, s)) && !(await onceDone(p, s))) return;
  }
}

async function onceDone(p: Project, s: Stage): Promise<boolean> {
  return (await stageRow(p, s)).agreed_version !== null;
}

async function kickoff(p: Project, s: Stage): Promise<void> {
  await p.setSetting(`plan_started:${s}`, p.now());
  // 既存のリポジトリの続きから: 聞き取りから作らず、リポジトリを読んで現状を下書きに起こす(ADR-0030)
  if (await fromExisting(p)) {
    const delegatedNote = (await stageRow(p, s)).mode === "delegate" ? " この段階はお任せです。未決は推奨で決め(answer_open_item)、版を仕上げて、決めた内容を報告してください。戻せない判断だけは未決に残してください。" : "";
    await sendPlan(p, s, { type: "kickoff", text: await existingKickoff(p, s) + delegatedNote });
    return;
  }
  const text: Record<Stage, string> = {
    req: "新しいプロジェクトです。責任者に挨拶し、何のためのものか(目的)から聞き始めてください。",
    infra: "画面が決まりました。要件・フロー・画面(画像のアップロード、オフラインでの保存など、画面が求めるもの)をもとに、このプロダクトをどこで・どう動かすかを決めてください。まず登録されたリポジトリ(特にインフラの役割のもの)を読み、既にある環境・IaC・CI を確かめ、使えるものは使ってください。動かす場所と構成 → 環境とデプロイ → 運用 → 費用と規模 の順に set_infra で書きます。",
    flow: "要件が決まりました。要件をもとに、画面と遷移のユーザーフローを描いてください。決まっていない分岐は「?」の箱と未決にしてください。",
    screen: "ユーザーフローが決まりました。まず set_design_system でデザインシステム(色・文字・余白・角丸・影のトークンと、ボタン・入力欄・カード・一覧の行などの部品)を作り、フローの各画面の触れる試作(HTML)を、そのトークン(CSS 変数)と部品で組み立ててください。迷う画面は 2 案にしてください。",
    model: "インフラが決まりました。インフラで決めたこと(DB の種類など)を前提に、アーキテクチャスタイル → ドメインモデル → 作る / 既存を使う / 作らない → データ設計 の順に書いてください。既存のリポジトリのコードを読んで、既にある作り方に合わせ、新しい表やサービスは安易に作らないでください。",
  };
  const delegated =
    (await stageRow(p, s)).mode === "delegate"
      ? " この段階はお任せです。未決は推奨で決め(answer_open_item)、版を仕上げて、決めた内容を報告してください。戻せない判断だけは未決に残してください。"
      : "";
  await sendPlan(p, s, { type: "kickoff", text: text[s] + delegated });
}

/** 企画の担当にメッセージを送る。まだ取り出されていないものがあれば、そこにまとめる(読んでから書くので tx の中で)。 */
export async function sendPlan(p: Project, s: Stage | "handoff", event: { type: string; text: string }): Promise<void> {
  const role: Role = s === "handoff" ? "lead" : STAGE_ROLE[s];
  await p.pdb.transaction(async () => {
    const pending = await p.pdb.k
      .selectFrom("messages")
      .select(["id", "payload"])
      .where("project_id", "in", scopeIds(p.pdb))
      .where("kind", "=", "plan")
      .where("status", "=", "pending")
      .where("to_role", "=", role)
      .where(p.pdb.dialect.jsonExtract("payload", "stage"), "=", s)
      .executeTakeFirst();
    if (pending) {
      const payload = JSON.parse(pending.payload) as { stage: string; events: unknown[] };
      payload.events.push(event);
      await p.pdb.update("messages", { payload: JSON.stringify(payload) }).where("id", "=", pending.id).execute();
      return;
    }
    await send(p, { ticketId: null, toRole: role, kind: "plan", payload: { stage: s, events: [event] } });
  });
}

// ---- 会話 ----

export type PlanMessage = { id: number; stage: string; who: string; body: string; at: string };

export async function say(p: Project, stage: Stage | "handoff", who: string, body: string): Promise<void> {
  await p.pdb.insert("plan_messages", { stage, who, body, at: p.now() }).execute();
}

/**
 * 責任者が担当に話す。question なら、中身は変えずに答えだけを返してもらう(書き換えの道具を渡さない)。
 * そうでなければ、頼まれたことを企画の中身に反映して返事をする。
 */
export async function chat(p: Project, stage: Stage | "handoff", text: string, kind: "chat" | "question" = "chat"): Promise<void> {
  await p.pdb.transaction(async () => {
    await say(p, stage, "me", kind === "question" ? `(質問)${text}` : text);
    await sendPlan(p, stage, { type: kind, text });
  });
}

/** 依頼が質問だけか(書き換えの道具を渡さず、答えだけを返してもらう)。 */
export function onlyQuestions(events: { type: string }[]): boolean {
  return events.length > 0 && events.every((e) => e.type === "question");
}

export async function messages(p: Project, stage?: string): Promise<PlanMessage[]> {
  let q = inScope(p.pdb, "plan_messages").orderBy("id");
  if (stage) q = q.where("stage", "=", stage);
  return (await q.execute()) as unknown as PlanMessage[];
}

// ---- 作ったもの(版つき) ----

type ArtifactRow = { id: number; key: string; version: number; body: string };

/** ある段階の kind の行を全部(id 順)。画面のように、キーごとの最新を 1 文でまとめて取るのに使う。 */
async function artifactRows(p: Project, stage: Stage, kind: string, key?: string): Promise<ArtifactRow[]> {
  let q = inScope(p.pdb, "plan_artifacts").where("stage", "=", stage).where("kind", "=", kind).orderBy("id");
  if (key !== undefined) q = q.where("key", "=", key);
  return (await q.execute()) as unknown as ArtifactRow[];
}

/** 版 v までのうち、いちばん新しい行(版 → id の大きい方)。 */
const latestUpTo = (rows: ArtifactRow[], v: number): ArtifactRow | undefined =>
  rows.filter((r) => r.version <= v).reduce<ArtifactRow | undefined>((best, r) => (!best || r.version > best.version || (r.version === best.version && r.id > best.id) ? r : best), undefined);

export async function artifact<T>(p: Project, stage: Stage, kind: string, key: string): Promise<T | null> {
  const v = (await stageRow(p, stage)).version;
  const r = latestUpTo(await artifactRows(p, stage, kind, key), v);
  if (!r || r.body === REMOVED) return null;
  return JSON.parse(r.body) as T;
}

async function artifactRowId(p: Project, stage: Stage, kind: string, key: string): Promise<number | undefined> {
  const v = (await stageRow(p, stage)).version;
  return latestUpTo(await artifactRows(p, stage, kind, key), v)?.id;
}

export async function putArtifact(p: Project, stage: Stage, kind: string, key: string, body: unknown): Promise<number> {
  return p.pdb.transaction(async () => {
    const v = await draftVersion(p, stage);
    const text = body === null ? REMOVED : JSON.stringify(body);
    const same = await inScope(p.pdb, "plan_artifacts").where("stage", "=", stage).where("kind", "=", kind).where("key", "=", key).where("version", "=", v).executeTakeFirst();
    if (same) {
      await p.pdb.update("plan_artifacts", { body: text }).where("id", "=", same.id).execute();
      return same.id;
    }
    return p.pdb.dialect.insertedId(p.pdb.insert("plan_artifacts", { stage, version: v, kind, key, body: text }));
  });
}

export async function screens(p: Project): Promise<Map<string, Screen>> {
  // 画面ごとに引かず、段階の版と画面の全部の行を 1 回ずつ取って、キーごとの最新を JS で選ぶ
  const v = (await stageRow(p, "screen")).version;
  const rows = await artifactRows(p, "screen", "screen");
  const byKey = new Map<string, ArtifactRow[]>();
  for (const r of rows) byKey.set(r.key, [...(byKey.get(r.key) ?? []), r]); // 最初に現れた行(id 順)の順に並ぶ
  const out = new Map<string, Screen>();
  for (const [k, rs] of byKey) {
    const r = latestUpTo(rs, v);
    if (r && r.body !== REMOVED) out.set(k, JSON.parse(r.body) as Screen);
  }
  return out;
}

export async function putScreen(p: Project, key: string, s: Screen | null): Promise<void> {
  await putArtifact(p, "screen", "screen", key, s);
}

export async function pickVariant(p: Project, key: string, variant: string): Promise<void> {
  const s = (await screens(p)).get(key);
  if (!s) throw new Error("その画面はありません");
  if (!s.variants.some((v) => v.id === variant)) throw new Error("その案はありません");
  await p.pdb.transaction(async () => {
    await putScreen(p, key, { ...s, chosen: variant });
    await say(p, "screen", "me", `${s.name}は案 ${variant} で`);
  });
}

export async function agreeScreen(p: Project, key: string): Promise<void> {
  const s = (await screens(p)).get(key);
  if (!s) throw new Error("その画面はありません");
  if (s.variants.length > 1 && !s.chosen) throw new Error("案を 1 つ選んでください");
  if ((await comments(p, key)).some((c) => c.resolved_in === null)) throw new Error("対応待ちのコメントがあります");
  await putScreen(p, key, { ...s, agreed: true });
}

// ---- 要件 ----

export type RequirementItem = { id: number; code: string; name: string; acceptance: string; added_in: number };

/** 要件の番号(R12 の 12)。数としての並びに使う。 */
const codeNo = (code: string) => Number(code.slice(1)) || 0;

export async function requirements(p: Project): Promise<RequirementItem[]> {
  const rows = await inScope(p.pdb, "requirement_items").where("removed_in", "is", null).execute();
  return rows
    .map((r) => ({ id: r.id, code: r.code, name: r.name, acceptance: r.acceptance, added_in: r.added_in }))
    .sort((a, b) => codeNo(a.code) - codeNo(b.code) || a.id - b.id);
}

/** 要件の項目を足す・直す。合意済みの版の項目を直すときは、古い行を残して新しい版の行を足す。 */
export async function upsertRequirement(p: Project, item: { code?: string; name: string; acceptance: string }, from?: Stage): Promise<string> {
  return p.pdb.transaction(async () => {
    const before = await stageRow(p, "req");
    const wasAgreed = before.agreed_version !== null && before.agreed_version === before.version;
    const v = await draftVersion(p, "req");
    let code = item.code;
    if (code === undefined) {
      const all = await inScope(p.pdb, "requirement_items").execute();
      code = `R${all.reduce((m, r) => Math.max(m, codeNo(r.code)), 0) + 1}`;
    }
    const cur = await inScope(p.pdb, "requirement_items").where("code", "=", code).where("removed_in", "is", null).executeTakeFirst();
    if (cur && cur.added_in === v) {
      await p.pdb.update("requirement_items", { name: item.name, acceptance: item.acceptance }).where("id", "=", cur.id).execute();
    } else {
      if (cur) await p.pdb.update("requirement_items", { removed_in: v }).where("id", "=", cur.id).execute();
      await p.pdb.insert("requirement_items", { code, name: item.name, acceptance: item.acceptance, added_in: v }).execute();
    }
    // 後の段階で責任者が未決に答え、その答えを受け入れ条件に書き足すときは、責任者が決めたことなので合意済みのまま版を上げる
    if (from && from !== "req" && wasAgreed) {
      await p.pdb.update("plan_stages", { agreed_version: v }).where("stage", "=", "req").execute();
      await say(p, "req", "plan", `${STAGE_LABEL[from]}で決まったことを受けて、${code}「${item.name}」の受け入れ条件を書き足しました(要件 v${v})。`);
    }
    return code;
  });
}

export async function removeRequirement(p: Project, code: string): Promise<void> {
  await p.pdb.transaction(async () => {
    const v = await draftVersion(p, "req");
    const cur = await inScope(p.pdb, "requirement_items").where("code", "=", code).where("removed_in", "is", null).executeTakeFirst();
    if (!cur) throw new Error(`要件 ${code} はありません`);
    if (cur.added_in === v && v === 1) await p.pdb.deleteFrom("requirement_items").where("id", "=", cur.id).execute();
    else await p.pdb.update("requirement_items", { removed_in: v }).where("id", "=", cur.id).execute();
  });
}

// ---- 未決 ----

export type OpenItem = {
  id: number;
  stage: Stage;
  question: string;
  options: string;
  recommended: number;
  why: string;
  reversible: number;
  answer: string | null;
  decided_by: string | null;
  withdrawn: string | null;
};

export async function openItems(p: Project, stage?: Stage): Promise<OpenItem[]> {
  let q = inScope(p.pdb, "plan_open_items").where("withdrawn", "is", null).orderBy("id");
  if (stage) q = q.where("stage", "=", stage);
  return (await q.execute()) as unknown as OpenItem[];
}

export async function addOpenItem(p: Project, stage: Stage, q: { question: string; options: string[]; recommended: number; why: string; reversible: boolean }): Promise<number> {
  if (q.recommended < 0 || q.recommended >= q.options.length) throw new Error("recommended が選択肢の範囲外です");
  return p.pdb.transaction(async () => {
    await draftVersion(p, stage); // 合意済みの段階に未決が増えたら下書きに戻す
    return p.pdb.dialect.insertedId(
      p.pdb.insert("plan_open_items", { stage, question: q.question, options: JSON.stringify(q.options), recommended: q.recommended, why: q.why, reversible: q.reversible ? 1 : 0, created_at: p.now() }),
    );
  });
}

async function openItem(p: Project, id: number): Promise<OpenItem> {
  const o = await inScope(p.pdb, "plan_open_items").where("id", "=", id).executeTakeFirst();
  if (!o) throw new Error(`未決 ${id} はありません`);
  return o as unknown as OpenItem;
}

/** 責任者が未決に答えた。担当に伝えて、図や要件に反映してもらう。 */
export async function answerOpenItem(p: Project, id: number, answer: string): Promise<void> {
  await p.pdb.transaction(async () => {
    const o = await openItem(p, id);
    if (o.answer !== null || o.withdrawn) throw new Error("この未決はもう閉じています");
    await p.pdb.update("plan_open_items", { answer, decided_by: "owner", answered_at: p.now() }).where("id", "=", id).execute();
    await say(p, o.stage, "me", `「${o.question}」は「${answer}」で`);
    await sendPlan(p, o.stage, { type: "answer", text: `未決 #${id}「${o.question}」に責任者が「${answer}」と答えました。図・要件・設計に反映して版を上げてください。この答えで聞く意味がなくなった未決があれば、理由を添えて取り下げてください。` });
    await advance(p);
  });
}

/** 担当が未決を決めた(お任せのときだけ。戻せない判断は決められない)。 */
export async function aiAnswerOpenItem(p: Project, id: number, answer: string): Promise<string | null> {
  const o = await openItem(p, id);
  if (o.answer !== null || o.withdrawn) return "この未決はもう閉じています";
  if ((await stageRow(p, o.stage)).mode !== "delegate") return "この段階はお任せではありません。責任者の答えを待ってください";
  if (!o.reversible) return "戻せない判断は、お任せでも責任者に聞きます";
  await p.pdb.update("plan_open_items", { answer, decided_by: "ai", answered_at: p.now() }).where("id", "=", id).execute();
  return null;
}

export async function withdrawOpenItem(p: Project, id: number, reason: string): Promise<void> {
  const o = await openItem(p, id);
  if (o.answer !== null) throw new Error("答えの出た未決は取り下げられません");
  await p.pdb.update("plan_open_items", { withdrawn: reason }).where("id", "=", id).execute();
}

// ---- 画面へのコメント ----

export type Comment = { id: number; x: number | null; y: number | null; body: string; variant: string | null; resolved_in: number | null };

/** 画面のキーごとのコメント(id 順)。画面が何枚あっても 1 文で取る。 */
export async function commentsByScreen(p: Project): Promise<Map<string, Comment[]>> {
  const rows = await p.pdb.k
    .selectFrom("plan_comments as c")
    .innerJoin("plan_artifacts as a", "a.id", "c.artifact_id")
    .select(["c.id", "c.x", "c.y", "c.body", "c.variant", "c.resolved_in", "a.key as screen_key"])
    .where("c.project_id", "in", scopeIds(p.pdb))
    .where("a.stage", "=", "screen")
    .where("a.kind", "=", "screen")
    .orderBy("c.id")
    .execute();
  const out = new Map<string, Comment[]>();
  for (const { screen_key, ...c } of rows) out.set(screen_key, [...(out.get(screen_key) ?? []), c as Comment]);
  return out;
}

export async function comments(p: Project, screenKey: string): Promise<Comment[]> {
  return (await commentsByScreen(p)).get(screenKey) ?? [];
}

export async function addComment(p: Project, screenKey: string, c: { variant: string; x: number; y: number; body: string }): Promise<number> {
  return p.pdb.transaction(async () => {
    const s = (await screens(p)).get(screenKey);
    if (!s) throw new Error("その画面はありません");
    if (s.agreed) await putScreen(p, screenKey, { ...s, agreed: false });
    const aid = (await artifactRowId(p, "screen", "screen", screenKey))!;
    const id = await p.pdb.dialect.insertedId(p.pdb.insert("plan_comments", { artifact_id: aid, x: c.x, y: c.y, body: c.body, variant: c.variant, created_at: p.now() }));
    const n = (await comments(p, screenKey)).length;
    await say(p, "screen", "me", `${s.name}(案 ${c.variant})${n} 番: ${c.body}`);
    await sendPlan(p, "screen", { type: "comment", text: `画面「${s.name}」(key: ${screenKey})の案 ${c.variant} の位置 (${Math.round(c.x)}%, ${Math.round(c.y)}%) にコメント #${id}「${c.body}」が付きました。試作を直して upsert_screen で版を上げ、resolve_comment で対応済みにしてください。` });
    return id;
  });
}

export async function resolveComment(p: Project, id: number): Promise<void> {
  const v = (await stageRow(p, "screen")).version;
  const r = await p.pdb.update("plan_comments", { resolved_in: v }).where("id", "=", id).where("resolved_in", "is", null).executeTakeFirst();
  if (!Number(r.numUpdatedRows)) throw new Error(`コメント ${id} は無いか、もう対応済みです`);
}

// ---- チームに渡す ----

export async function handoffBlocker(p: Project): Promise<string | null> {
  if (await p.setting("plan_handed_at")) return "もう渡しています";
  const notDone: Stage[] = [];
  for (const s of STAGES) if (!(await stageDone(p, s))) notDone.push(s);
  return notDone.length ? `終わっていない段階があります: ${notDone.map((s) => STAGE_LABEL[s]).join("・")}` : null;
}

export async function handoff(p: Project): Promise<void> {
  await p.pdb.transaction(async () => {
    const why = await handoffBlocker(p);
    if (why) throw new Error(why);
    await p.setSetting("plan_handoff_requested_at", p.now());
    await say(p, "handoff", "me", "チームに渡します");
    await sendPlan(p, "handoff", {
      type: "handoff",
      text:
        "企画のすべての段階が終わりました。合意した版から、実装のチケットを create_ticket で作ってください。各チケットには、要件の項目(code)・画面(key)・設計の節をひも付け、受け入れ条件を本文に書いてください。作り終えたら finish_handoff を呼んでください。" +
        (await fromExisting(p) ? `${existingHandoffText()}\n\n## GitHub の途中の仕事(Kuramoto が取ってきたもの)\n${await snapshotText(p, { bodies: true })}` : ""),
    });
  });
}

export async function handedOff(p: Project): Promise<boolean> {
  return !!await p.setting("plan_handed_at");
}

/** 責任者の対応として本部に出す、企画の確認待ち。 */
export async function ownerPlanItems(p: Project): Promise<{ stage: Stage; text: string }[]> {
  if (await handedOff(p)) return [];
  const out: { stage: Stage; text: string }[] = [];
  for (const s of STAGES) {
    const open = (await openItems(p, s)).filter((o) => o.answer === null);
    if (open.length) out.push({ stage: s, text: `${STAGE_LABEL[s]}: 未決 ${open.length} 件があなたの答えを待っています` });
    else {
      const r = await stageRow(p, s);
      if (r.mode === "agree" && !(await agreeBlocker(p, s))) out.push({ stage: s, text: `${STAGE_LABEL[s]} v${r.version} があなたの合意を待っています` });
    }
  }
  if (!(await handoffBlocker(p)) && !await p.setting("plan_handoff_requested_at")) out.push({ stage: "model", text: "すべての段階が終わりました。チームに渡せます" });
  return out;
}

// ---- 止める・回り続けていないか ----

/** 企画スタジオを止めているか。止めている間は、企画の担当を起こさない(オフィスとは別)。 */
export async function studioPaused(p: Project): Promise<{ at: string; reason: string } | null> {
  const v = await p.setting("plan_paused");
  return v ? (JSON.parse(v) as { at: string; reason: string }) : null;
}

/** 企画スタジオを止める・再開する。再開すると、止めたところ(待っている依頼)から続ける。 */
export async function setStudioPaused(p: Project, paused: boolean, reason = "あなたが止めました"): Promise<void> {
  if (paused) {
    if (await studioPaused(p)) return;
    await p.setSetting("plan_paused", JSON.stringify({ at: p.now(), reason }));
    await p.event("owner", "studio_paused", null, { reason });
    await say(p, await currentStage(p), "system", `企画スタジオを止めました(${reason})。「再開する」で続きから動きます。`);
  } else {
    if (!await studioPaused(p)) return;
    await p.setSetting("plan_paused", "");
    await p.event("owner", "studio_resumed", null, {});
    await say(p, await currentStage(p), "system", "企画スタジオを再開しました。止めたところから続けます。");
  }
}

/** 今動いている(か、次に動く)段階。会話の知らせを置く場所。 */
async function currentStage(p: Project): Promise<Stage | "handoff"> {
  if (await p.setting("plan_handoff_requested_at")) return "handoff";
  for (const s of STAGES) if (await stageStarted(p, s) && !(await stageDone(p, s))) return s;
  return "req";
}

/**
 * 回り続けていないか。同じ段階で、直近 1 時間に担当を plan_loop_runs 回(既定 10)より多く起こしていたら、
 * 企画スタジオを止めて知らせる(トークンを使い続けないように)。
 * @returns 止めたら、その段階
 */
export async function checkStudioLoop(p: Project): Promise<string | null> {
  if (await studioPaused(p)) return null;
  const limit = await p.settingNumber("plan_loop_runs", 10);
  const since = new Date(p.clock.now().getTime() - 3_600_000).toISOString();
  const rows = await p.pdb.k
    .selectFrom("runs as r")
    .innerJoin("messages as m", "m.id", "r.message_id")
    .select(p.pdb.dialect.jsonExtract<string>("m.payload", "stage").as("stage"))
    .where("r.project_id", "in", scopeIds(p.pdb))
    .where("m.kind", "=", "plan")
    .where("r.started_at", ">=", since)
    .execute();
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.stage, (counts.get(r.stage) ?? 0) + 1);
  const hot = [...counts].sort((a, b) => b[1] - a[1])[0];
  if (!hot || hot[1] <= limit) return null;
  const [stage, n] = hot;
  const label = stage === "handoff" ? "チームへの引き渡し" : (STAGE_LABEL[stage as Stage] ?? stage);
  await setStudioPaused(p, true, `「${label}」で、この 1 時間に担当を ${n} 回起こしていて、同じところを回っているようです。会話と途中経過を見て、指示を足してから再開してください`);
  return stage;
}

/** 段階ごとの進み具合: 起動の回数(通算・直近 1 時間)・金額・エラー・最近の起動。 */
export async function studioProgress(p: Project) {
  const since = p.clock.now().getTime() - 3_600_000;
  const rows = await p.pdb.k
    .selectFrom("runs as r")
    .innerJoin("messages as m", "m.id", "r.message_id")
    .innerJoin("members as mb", "mb.id", "r.member_id")
    .select([
      p.pdb.dialect.jsonExtract<string>("m.payload", "stage").as("stage"),
      "r.id as id",
      "r.started_at as started_at",
      "r.ended_at as ended_at",
      "r.outcome as outcome",
      "r.error as error",
      "r.cost_usd as cost",
      "mb.name as member",
    ])
    .where("r.project_id", "in", scopeIds(p.pdb))
    .where("m.kind", "=", "plan")
    .orderBy("r.id")
    .execute();
  const out: Record<string, { runs: number; lastHour: number; costUsd: number; errors: number; recent: { at: string; member: string; ms: number | null; outcome: string; error: string | null }[] }> = {};
  for (const r of rows) {
    const o = (out[r.stage] ??= { runs: 0, lastHour: 0, costUsd: 0, errors: 0, recent: [] });
    o.runs++;
    if (Date.parse(r.started_at) >= since) o.lastHour++;
    o.costUsd += r.cost ?? 0;
    if (r.outcome === "error") o.errors++;
    o.recent.push({ at: r.started_at, member: r.member, ms: r.ended_at ? Date.parse(r.ended_at) - Date.parse(r.started_at) : null, outcome: r.ended_at ? (r.outcome ?? "?") : "running", error: r.error ? r.error.slice(0, 200) : null });
  }
  for (const o of Object.values(out)) o.recent = o.recent.slice(-5).reverse();
  return out;
}

// ---- 画面に出す全体 ----

export async function studioView(p: Project) {
  const thinkingRows = await p.pdb.k
    .selectFrom("messages")
    .select(p.pdb.dialect.jsonExtract<string>("payload", "stage").as("stage"))
    .where("project_id", "in", scopeIds(p.pdb))
    .where("kind", "=", "plan")
    .where("status", "in", ["pending", "claimed"])
    .execute();
  const thinking = new Set(thinkingRows.map((r) => r.stage));
  const items = await openItems(p);
  const stages = [];
  for (const s of STAGES) {
    const r = await stageRow(p, s);
    stages.push({
      key: s,
      label: STAGE_LABEL[s],
      mode: r.mode,
      version: r.version,
      agreedVersion: r.agreed_version,
      done: await stageDone(p, s),
      status: await stageStatus(p, s),
      agreeBlocker: await agreeBlocker(p, s),
      started: await stageStarted(p, s),
      thinking: thinking.has(s),
    });
  }
  const cs = await commentsByScreen(p);
  // 企画から作ったチケットの plan_refs を、チケットごとに引かず 1 文(IN)で取る
  const tickets = await p.tickets();
  const refsRows = tickets.length
    ? await inScope(p.pdb, "tickets")
        .where("id", "in", tickets.map((t) => t.id))
        .execute()
    : [];
  const refsOf = new Map(refsRows.map((r) => [r.id, JSON.parse(String(r.plan_refs ?? "{}")) as Record<string, unknown>]));
  return {
    stages,
    handoff: { blocker: await handoffBlocker(p), requested: !!await p.setting("plan_handoff_requested_at"), handed: await handedOff(p), thinking: thinking.has("handoff") },
    work: await planningWork(p),
    /** 止めているか(いつ・なぜ) */
    paused: await studioPaused(p),
    /** 段階ごとの進み具合 */
    progress: await studioProgress(p),
    loopLimit: await p.settingNumber("plan_loop_runs", 10),
    /** 担当の名前(画面はここから受け取る) */
    cast: { planner: (await p.fixedMember("planner")).name, designer: (await p.fixedMember("designer")).name, architect: (await p.fixedMember("architect")).name, lead: (await p.fixedMember("lead")).name },
    brief: await artifact<Brief>(p, "req", "brief", "main"),
    requirements: await requirements(p),
    openItems: items.map((o) => ({ ...o, options: JSON.parse(o.options) as string[], reversible: !!o.reversible })),
    infra: await artifact<Infra>(p, "infra", "infra", "main"),
    flow: await artifact<Flow>(p, "flow", "flow", "main"),
    screens: [...(await screens(p))].map(([key, s]) => ({ key, ...s, comments: cs.get(key) ?? [] })),
    designSystem: await designSystem(p),
    architecture: await artifact<Architecture>(p, "model", "architecture", "main"),
    domain: await artifact<Domain>(p, "model", "domain", "main"),
    data: await artifact<DataDesign>(p, "model", "data", "main"),
    messages: await messages(p),
    tickets: tickets
      .filter((t) => refsOf.get(t.id)?.fromPlan)
      .map((t) => {
        // 引き継いだ PR・Issue のチケットなどは、画面・設計・段階の進め方のひも付けを持たない。画面が落ちないよう空で埋める
        const refs = refsOf.get(t.id) ?? {};
        return { number: t.number, title: t.title, refs: { ...refs, screens: refs.screens ?? [], design: refs.design ?? [], modes: refs.modes ?? {} } };
      }),
  };
}
