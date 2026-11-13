import { all, get, run, tx } from "../db/sqlite.js";
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

export function designSystem(p: Project): DesignSystem | null {
  return artifact<DesignSystem>(p, "screen", "designsystem", "main");
}

export type DataDesign = { tables: { name: string; change: "new" | "alter" | "none"; columns: string[]; note: string; reversible: boolean }[] };

const REMOVED = "__removed__";

// ---- 段階 ----

export function stageRow(p: Project, s: Stage): StageRow {
  const r = get<StageRow>(p.db, "SELECT * FROM plan_stages WHERE stage = ?", [s]);
  if (!r) throw new Error(`段階 ${s} がありません`);
  return r;
}

/**
 * 書き込む版。合意済みの版を直すときは、版を 1 つ上げて新しい下書きにする(合意した版は残る)。
 */
export function draftVersion(p: Project, s: Stage): number {
  const r = stageRow(p, s);
  if (r.agreed_version !== null && r.agreed_version === r.version) {
    run(p.db, "UPDATE plan_stages SET version = version + 1 WHERE stage = ?", [s]);
    if (s === "req") run(p.db, "INSERT INTO requirements (version, created_at) VALUES (?, ?)", [r.version + 1, p.now()]);
    return r.version + 1;
  }
  return r.version;
}

export async function setMode(p: Project, s: Stage, mode: Mode): Promise<void> {
  if (s === "req" && mode === "skip") throw new Error("要件は省けません");
  await p.pdb.transaction(async () => {
    const before = stageRow(p, s);
    run(p.db, "UPDATE plan_stages SET mode = ? WHERE stage = ?", [mode, s]);
    // お任せから自分で確かめるに戻したら、合意し直す
    if (before.mode === "delegate" && mode === "agree") run(p.db, "UPDATE plan_stages SET agreed_version = NULL WHERE stage = ?", [s]);
    if (mode === "skip") say(p, s, "me", "この段階は省いて進めます");
    if (mode === "delegate") {
      say(p, s, "me", "この段階はお任せします");
      sendPlan(p, s, { type: "delegate", text: "この段階はお任せになりました。未決は推奨で決め、版を仕上げて、決めた内容を報告してください。戻せない判断だけは未決に残してください。" });
    }
    if (before.mode === "skip" && mode === "agree") say(p, s, "me", "省くのをやめて、この段階を作ります");
    await advance(p);
  });
}

/** 合意できない理由。無ければ合意できる。 */
export function agreeBlocker(p: Project, s: Stage): string | null {
  const r = stageRow(p, s);
  if (r.mode === "skip") return "この段階は省いています";
  if (r.agreed_version === r.version) return "この版は合意済みです";
  if (!hasContent(p, s)) return "まだ中身がありません";
  const open = openItems(p, s).filter((o) => o.answer === null);
  if (open.length) return `未決が ${open.length} 件あります`;
  if (s === "screen") {
    // 画面があるなら、デザインシステムも要る(開発チームとの共通の決まり。ADR-0034)
    if (screens(p).size && !designSystem(p)) return "デザインシステムがまだありません";
    for (const [key, sc] of screens(p)) {
      if (sc.variants.length > 1 && !sc.chosen) return `「${sc.name}」の案を選んでください`;
      if (comments(p, key).some((c) => c.resolved_in === null)) return `「${sc.name}」に対応待ちのコメントがあります`;
      if (!sc.agreed) return `「${sc.name}」がまだ合意されていません`;
    }
  }
  return null;
}

export async function agree(p: Project, s: Stage): Promise<void> {
  await p.pdb.transaction(async () => {
    const why = agreeBlocker(p, s);
    if (why) throw new Error(why);
    const r = stageRow(p, s);
    run(p.db, "UPDATE plan_stages SET agreed_version = version WHERE stage = ?", [s]);
    say(p, s, "planner", `${STAGE_LABEL[s]} v${r.version} に合意をもらいました。`);
    p.event("owner", "plan_agreed", null, { stage: s, version: r.version });
    await advance(p);
  });
}

export function hasContent(p: Project, s: Stage): boolean {
  switch (s) {
    case "req":
      return requirements(p).length > 0;
    case "infra":
      return artifact<Infra>(p, "infra", "infra", "main") !== null;
    case "flow":
      return artifact<Flow>(p, "flow", "flow", "main") !== null;
    case "screen":
      return screens(p).size > 0;
    case "model":
      return artifact<Architecture>(p, "model", "architecture", "main") !== null || artifact<Domain>(p, "model", "domain", "main") !== null;
  }
}

/** 段階が終わっているか(合意済み・お任せで仕上がった・省略)。 */
export function stageDone(p: Project, s: Stage): boolean {
  const r = stageRow(p, s);
  if (r.mode === "skip") return true;
  if (r.agreed_version !== null && r.agreed_version === r.version) return true;
  if (r.mode === "delegate") {
    if (!hasContent(p, s)) return false;
    if (openItems(p, s).some((o) => o.answer === null)) return false; // 戻せない判断が残っている
    if (s === "screen") return [...screens(p).keys()].every((k) => comments(p, k).every((c) => c.resolved_in !== null));
    return true;
  }
  return false;
}

export function stageStatus(p: Project, s: Stage): string {
  const r = stageRow(p, s);
  if (r.mode === "skip") return "省略";
  if (r.agreed_version !== null && r.agreed_version === r.version) return `合意済み v${r.version}`;
  const open = openItems(p, s).filter((o) => o.answer === null).length;
  if (r.mode === "delegate") return stageDone(p, s) ? `お任せ v${r.version}` : open ? `お任せ(あなたに 未決 ${open})` : "お任せで作成中";
  if (!hasContent(p, s)) return stageStarted(p, s) ? "作成中" : "前の段階を待っています";
  if (open) return `未決 ${open}`;
  if (s === "screen") {
    const waiting = [...screens(p).values()].filter((x) => !x.agreed).length;
    if (waiting) return `${waiting} 画面が合意待ち`;
  }
  return `下書き v${r.version}`;
}

function stageStarted(p: Project, s: Stage): boolean {
  return !!p.setting(`plan_started:${s}`);
}

/**
 * 段階が終わったら次の段階の担当を起こす(前の段階を終えてから次へ。ADR-0008)。
 * 省いた段階は飛ばす。
 */
export async function advance(p: Project): Promise<void> {
  for (const s of STAGES) {
    if (!stageStarted(p, s)) {
      if (stageRow(p, s).mode === "skip") continue;
      kickoff(p, s);
      return;
    }
    // 一度終えた段階は、後から直されて下書きに戻っても、次の段階を止めない(引き渡しの前には合意し直しが要る)
    if (!stageDone(p, s) && !onceDone(p, s)) return;
  }
}

function onceDone(p: Project, s: Stage): boolean {
  return stageRow(p, s).agreed_version !== null;
}

function kickoff(p: Project, s: Stage): void {
  p.setSetting(`plan_started:${s}`, p.now());
  // 既存のリポジトリの続きから: 聞き取りから作らず、リポジトリを読んで現状を下書きに起こす(ADR-0030)
  if (fromExisting(p)) {
    const delegatedNote = stageRow(p, s).mode === "delegate" ? " この段階はお任せです。未決は推奨で決め(answer_open_item)、版を仕上げて、決めた内容を報告してください。戻せない判断だけは未決に残してください。" : "";
    sendPlan(p, s, { type: "kickoff", text: existingKickoff(p, s) + delegatedNote });
    return;
  }
  const text: Record<Stage, string> = {
    req: "新しいプロジェクトです。責任者に挨拶し、何のためのものか(目的)から聞き始めてください。",
    infra: "画面が決まりました。要件・フロー・画面(画像のアップロード、オフラインでの保存など、画面が求めるもの)をもとに、このプロダクトをどこで・どう動かすかを決めてください。まず登録されたリポジトリ(特にインフラの役割のもの)を読み、既にある環境・IaC・CI を確かめ、使えるものは使ってください。動かす場所と構成 → 環境とデプロイ → 運用 → 費用と規模 の順に set_infra で書きます。",
    flow: "要件が決まりました。要件をもとに、画面と遷移のユーザーフローを描いてください。決まっていない分岐は「?」の箱と未決にしてください。",
    screen: "ユーザーフローが決まりました。まず set_design_system でデザインシステム(色・文字・余白・角丸・影のトークンと、ボタン・入力欄・カード・一覧の行などの部品)を作り、フローの各画面の触れる試作(HTML)を、そのトークン(CSS 変数)と部品で組み立ててください。迷う画面は 2 案にしてください。",
    model: "インフラが決まりました。インフラで決めたこと(DB の種類など)を前提に、アーキテクチャスタイル → ドメインモデル → 作る / 既存を使う / 作らない → データ設計 の順に書いてください。既存のリポジトリのコードを読んで、既にある作り方に合わせ、新しい表やサービスは安易に作らないでください。",
  };
  const delegated = stageRow(p, s).mode === "delegate"
    ? " この段階はお任せです。未決は推奨で決め(answer_open_item)、版を仕上げて、決めた内容を報告してください。戻せない判断だけは未決に残してください。"
    : "";
  sendPlan(p, s, { type: "kickoff", text: text[s] + delegated });
}

/** 企画の担当にメッセージを送る。まだ取り出されていないものがあれば、そこにまとめる。 */
export function sendPlan(p: Project, s: Stage | "handoff", event: { type: string; text: string }): void {
  const role: Role = s === "handoff" ? "lead" : STAGE_ROLE[s];
  const pending = get<{ id: number; payload: string }>(
    p.db,
    "SELECT id, payload FROM messages WHERE kind = 'plan' AND status = 'pending' AND to_role = ? AND json_extract(payload, '$.stage') = ?",
    [role, s],
  );
  if (pending) {
    const payload = JSON.parse(pending.payload) as { stage: string; events: unknown[] };
    payload.events.push(event);
    run(p.db, "UPDATE messages SET payload = ? WHERE id = ?", [JSON.stringify(payload), pending.id]);
    return;
  }
  send(p, { ticketId: null, toRole: role, kind: "plan", payload: { stage: s, events: [event] } });
}

// ---- 会話 ----

export type PlanMessage = { id: number; stage: string; who: string; body: string; at: string };

export function say(p: Project, stage: Stage | "handoff", who: string, body: string): void {
  run(p.db, "INSERT INTO plan_messages (stage, who, body, at) VALUES (?, ?, ?, ?)", [stage, who, body, p.now()]);
}

/**
 * 責任者が担当に話す。question なら、中身は変えずに答えだけを返してもらう(書き換えの道具を渡さない)。
 * そうでなければ、頼まれたことを企画の中身に反映して返事をする。
 */
export function chat(p: Project, stage: Stage | "handoff", text: string, kind: "chat" | "question" = "chat"): void {
  tx(p.db, () => {
    say(p, stage, "me", kind === "question" ? `(質問)${text}` : text);
    sendPlan(p, stage, { type: kind, text });
  });
}

/** 依頼が質問だけか(書き換えの道具を渡さず、答えだけを返してもらう)。 */
export function onlyQuestions(events: { type: string }[]): boolean {
  return events.length > 0 && events.every((e) => e.type === "question");
}

export function messages(p: Project, stage?: string): PlanMessage[] {
  return stage ? all(p.db, "SELECT * FROM plan_messages WHERE stage = ? ORDER BY id", [stage]) : all(p.db, "SELECT * FROM plan_messages ORDER BY id");
}

// ---- 作ったもの(版つき) ----

export function artifact<T>(p: Project, stage: Stage, kind: string, key: string): T | null {
  const v = stageRow(p, stage).version;
  const r = get<{ body: string }>(p.db, "SELECT body FROM plan_artifacts WHERE stage = ? AND kind = ? AND key = ? AND version <= ? ORDER BY version DESC, id DESC LIMIT 1", [
    stage,
    kind,
    key,
    v,
  ]);
  if (!r || r.body === REMOVED) return null;
  return JSON.parse(r.body) as T;
}

function artifactRowId(p: Project, stage: Stage, kind: string, key: string): number | undefined {
  const v = stageRow(p, stage).version;
  return get<{ id: number }>(p.db, "SELECT id FROM plan_artifacts WHERE stage = ? AND kind = ? AND key = ? AND version <= ? ORDER BY version DESC, id DESC LIMIT 1", [
    stage,
    kind,
    key,
    v,
  ])?.id;
}

export function putArtifact(p: Project, stage: Stage, kind: string, key: string, body: unknown): number {
  return tx(p.db, () => {
    const v = draftVersion(p, stage);
    const text = body === null ? REMOVED : JSON.stringify(body);
    const same = get<{ id: number }>(p.db, "SELECT id FROM plan_artifacts WHERE stage = ? AND kind = ? AND key = ? AND version = ?", [stage, kind, key, v]);
    if (same) {
      run(p.db, "UPDATE plan_artifacts SET body = ? WHERE id = ?", [text, same.id]);
      return same.id;
    }
    return run(p.db, "INSERT INTO plan_artifacts (stage, version, kind, key, body) VALUES (?, ?, ?, ?, ?)", [stage, v, kind, key, text]).lastId;
  });
}

function keysOf(p: Project, stage: Stage, kind: string): string[] {
  return all<{ key: string }>(p.db, "SELECT DISTINCT key FROM plan_artifacts WHERE stage = ? AND kind = ? ORDER BY id", [stage, kind]).map((r) => r.key);
}

export function screens(p: Project): Map<string, Screen> {
  const out = new Map<string, Screen>();
  for (const k of keysOf(p, "screen", "screen")) {
    const s = artifact<Screen>(p, "screen", "screen", k);
    if (s) out.set(k, s);
  }
  return out;
}

export function putScreen(p: Project, key: string, s: Screen | null): void {
  putArtifact(p, "screen", "screen", key, s);
}

export function pickVariant(p: Project, key: string, variant: string): void {
  const s = screens(p).get(key);
  if (!s) throw new Error("その画面はありません");
  if (!s.variants.some((v) => v.id === variant)) throw new Error("その案はありません");
  tx(p.db, () => {
    putScreen(p, key, { ...s, chosen: variant });
    say(p, "screen", "me", `${s.name}は案 ${variant} で`);
  });
}

export function agreeScreen(p: Project, key: string): void {
  const s = screens(p).get(key);
  if (!s) throw new Error("その画面はありません");
  if (s.variants.length > 1 && !s.chosen) throw new Error("案を 1 つ選んでください");
  if (comments(p, key).some((c) => c.resolved_in === null)) throw new Error("対応待ちのコメントがあります");
  putScreen(p, key, { ...s, agreed: true });
}

// ---- 要件 ----

export type RequirementItem = { id: number; code: string; name: string; acceptance: string; added_in: number };

export function requirements(p: Project): RequirementItem[] {
  return all(p.db, "SELECT id, code, name, acceptance, added_in FROM requirement_items WHERE removed_in IS NULL ORDER BY CAST(SUBSTR(code, 2) AS INTEGER), id");
}

/** 要件の項目を足す・直す。合意済みの版の項目を直すときは、古い行を残して新しい版の行を足す。 */
export function upsertRequirement(p: Project, item: { code?: string; name: string; acceptance: string }, from?: Stage): string {
  return tx(p.db, () => {
    const before = stageRow(p, "req");
    const wasAgreed = before.agreed_version !== null && before.agreed_version === before.version;
    const v = draftVersion(p, "req");
    const code = item.code ?? `R${(get<{ n: number | null }>(p.db, "SELECT MAX(CAST(SUBSTR(code, 2) AS INTEGER)) AS n FROM requirement_items")?.n ?? 0) + 1}`;
    const cur = get<{ id: number; added_in: number }>(p.db, "SELECT id, added_in FROM requirement_items WHERE code = ? AND removed_in IS NULL", [code]);
    if (cur && cur.added_in === v) {
      run(p.db, "UPDATE requirement_items SET name = ?, acceptance = ? WHERE id = ?", [item.name, item.acceptance, cur.id]);
    } else {
      if (cur) run(p.db, "UPDATE requirement_items SET removed_in = ? WHERE id = ?", [v, cur.id]);
      run(p.db, "INSERT INTO requirement_items (code, name, acceptance, added_in) VALUES (?, ?, ?, ?)", [code, item.name, item.acceptance, v]);
    }
    // 後の段階で責任者が未決に答え、その答えを受け入れ条件に書き足すときは、責任者が決めたことなので合意済みのまま版を上げる
    if (from && from !== "req" && wasAgreed) {
      run(p.db, "UPDATE plan_stages SET agreed_version = version WHERE stage = 'req'");
      say(p, "req", "plan", `${STAGE_LABEL[from]}で決まったことを受けて、${code}「${item.name}」の受け入れ条件を書き足しました(要件 v${v})。`);
    }
    return code;
  });
}

export function removeRequirement(p: Project, code: string): void {
  tx(p.db, () => {
    const v = draftVersion(p, "req");
    const cur = get<{ id: number; added_in: number }>(p.db, "SELECT id, added_in FROM requirement_items WHERE code = ? AND removed_in IS NULL", [code]);
    if (!cur) throw new Error(`要件 ${code} はありません`);
    if (cur.added_in === v && v === 1) run(p.db, "DELETE FROM requirement_items WHERE id = ?", [cur.id]);
    else run(p.db, "UPDATE requirement_items SET removed_in = ? WHERE id = ?", [v, cur.id]);
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

export function openItems(p: Project, stage?: Stage): OpenItem[] {
  return stage
    ? all(p.db, "SELECT * FROM plan_open_items WHERE stage = ? AND withdrawn IS NULL ORDER BY id", [stage])
    : all(p.db, "SELECT * FROM plan_open_items WHERE withdrawn IS NULL ORDER BY id");
}

export function addOpenItem(p: Project, stage: Stage, q: { question: string; options: string[]; recommended: number; why: string; reversible: boolean }): number {
  if (q.recommended < 0 || q.recommended >= q.options.length) throw new Error("recommended が選択肢の範囲外です");
  return tx(p.db, () => {
    draftVersion(p, stage); // 合意済みの段階に未決が増えたら下書きに戻す
    return run(p.db, "INSERT INTO plan_open_items (stage, question, options, recommended, why, reversible, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)", [
      stage,
      q.question,
      JSON.stringify(q.options),
      q.recommended,
      q.why,
      q.reversible ? 1 : 0,
      p.now(),
    ]).lastId;
  });
}

function openItem(p: Project, id: number): OpenItem {
  const o = get<OpenItem>(p.db, "SELECT * FROM plan_open_items WHERE id = ?", [id]);
  if (!o) throw new Error(`未決 ${id} はありません`);
  return o;
}

/** 責任者が未決に答えた。担当に伝えて、図や要件に反映してもらう。 */
export async function answerOpenItem(p: Project, id: number, answer: string): Promise<void> {
  await p.pdb.transaction(async () => {
    const o = openItem(p, id);
    if (o.answer !== null || o.withdrawn) throw new Error("この未決はもう閉じています");
    run(p.db, "UPDATE plan_open_items SET answer = ?, decided_by = 'owner', answered_at = ? WHERE id = ?", [answer, p.now(), id]);
    say(p, o.stage, "me", `「${o.question}」は「${answer}」で`);
    sendPlan(p, o.stage, { type: "answer", text: `未決 #${id}「${o.question}」に責任者が「${answer}」と答えました。図・要件・設計に反映して版を上げてください。この答えで聞く意味がなくなった未決があれば、理由を添えて取り下げてください。` });
    await advance(p);
  });
}

/** 担当が未決を決めた(お任せのときだけ。戻せない判断は決められない)。 */
export function aiAnswerOpenItem(p: Project, id: number, answer: string): string | null {
  const o = openItem(p, id);
  if (o.answer !== null || o.withdrawn) return "この未決はもう閉じています";
  if (stageRow(p, o.stage).mode !== "delegate") return "この段階はお任せではありません。責任者の答えを待ってください";
  if (!o.reversible) return "戻せない判断は、お任せでも責任者に聞きます";
  run(p.db, "UPDATE plan_open_items SET answer = ?, decided_by = 'ai', answered_at = ? WHERE id = ?", [answer, p.now(), id]);
  return null;
}

export function withdrawOpenItem(p: Project, id: number, reason: string): void {
  const o = openItem(p, id);
  if (o.answer !== null) throw new Error("答えの出た未決は取り下げられません");
  run(p.db, "UPDATE plan_open_items SET withdrawn = ? WHERE id = ?", [reason, id]);
}

// ---- 画面へのコメント ----

export type Comment = { id: number; x: number | null; y: number | null; body: string; variant: string | null; resolved_in: number | null };

export function comments(p: Project, screenKey: string): Comment[] {
  return all(
    p.db,
    `SELECT c.id, c.x, c.y, c.body, c.variant, c.resolved_in FROM plan_comments c JOIN plan_artifacts a ON a.id = c.artifact_id
     WHERE a.stage = 'screen' AND a.kind = 'screen' AND a.key = ? ORDER BY c.id`,
    [screenKey],
  );
}

export function addComment(p: Project, screenKey: string, c: { variant: string; x: number; y: number; body: string }): number {
  return tx(p.db, () => {
    const s = screens(p).get(screenKey);
    if (!s) throw new Error("その画面はありません");
    if (s.agreed) putScreen(p, screenKey, { ...s, agreed: false });
    const aid = artifactRowId(p, "screen", "screen", screenKey)!;
    const id = run(p.db, "INSERT INTO plan_comments (artifact_id, x, y, body, variant, created_at) VALUES (?, ?, ?, ?, ?, ?)", [aid, c.x, c.y, c.body, c.variant, p.now()]).lastId;
    const n = comments(p, screenKey).length;
    say(p, "screen", "me", `${s.name}(案 ${c.variant})${n} 番: ${c.body}`);
    sendPlan(p, "screen", { type: "comment", text: `画面「${s.name}」(key: ${screenKey})の案 ${c.variant} の位置 (${Math.round(c.x)}%, ${Math.round(c.y)}%) にコメント #${id}「${c.body}」が付きました。試作を直して upsert_screen で版を上げ、resolve_comment で対応済みにしてください。` });
    return id;
  });
}

export function resolveComment(p: Project, id: number): void {
  const v = stageRow(p, "screen").version;
  const r = run(p.db, "UPDATE plan_comments SET resolved_in = ? WHERE id = ? AND resolved_in IS NULL", [v, id]);
  if (!r.changes) throw new Error(`コメント ${id} は無いか、もう対応済みです`);
}

// ---- チームに渡す ----

export function handoffBlocker(p: Project): string | null {
  if (p.setting("plan_handed_at")) return "もう渡しています";
  const notDone = STAGES.filter((s) => !stageDone(p, s));
  return notDone.length ? `終わっていない段階があります: ${notDone.map((s) => STAGE_LABEL[s]).join("・")}` : null;
}

export function handoff(p: Project): void {
  tx(p.db, () => {
    const why = handoffBlocker(p);
    if (why) throw new Error(why);
    p.setSetting("plan_handoff_requested_at", p.now());
    say(p, "handoff", "me", "チームに渡します");
    sendPlan(p, "handoff", {
      type: "handoff",
      text:
        "企画のすべての段階が終わりました。合意した版から、実装のチケットを create_ticket で作ってください。各チケットには、要件の項目(code)・画面(key)・設計の節をひも付け、受け入れ条件を本文に書いてください。作り終えたら finish_handoff を呼んでください。" +
        (fromExisting(p) ? `${existingHandoffText()}\n\n## GitHub の途中の仕事(Kuramoto が取ってきたもの)\n${snapshotText(p, { bodies: true })}` : ""),
    });
  });
}

export function handedOff(p: Project): boolean {
  return !!p.setting("plan_handed_at");
}

/** 責任者の対応として本部に出す、企画の確認待ち。 */
export function ownerPlanItems(p: Project): { stage: Stage; text: string }[] {
  if (handedOff(p)) return [];
  const out: { stage: Stage; text: string }[] = [];
  for (const s of STAGES) {
    const open = openItems(p, s).filter((o) => o.answer === null);
    if (open.length) out.push({ stage: s, text: `${STAGE_LABEL[s]}: 未決 ${open.length} 件があなたの答えを待っています` });
    else if (stageRow(p, s).mode === "agree" && !agreeBlocker(p, s)) out.push({ stage: s, text: `${STAGE_LABEL[s]} v${stageRow(p, s).version} があなたの合意を待っています` });
  }
  if (!handoffBlocker(p) && !p.setting("plan_handoff_requested_at")) out.push({ stage: "model", text: "すべての段階が終わりました。チームに渡せます" });
  return out;
}

// ---- 止める・回り続けていないか ----

/** 企画スタジオを止めているか。止めている間は、企画の担当を起こさない(オフィスとは別)。 */
export function studioPaused(p: Project): { at: string; reason: string } | null {
  const v = p.setting("plan_paused");
  return v ? (JSON.parse(v) as { at: string; reason: string }) : null;
}

/** 企画スタジオを止める・再開する。再開すると、止めたところ(待っている依頼)から続ける。 */
export function setStudioPaused(p: Project, paused: boolean, reason = "あなたが止めました"): void {
  if (paused) {
    if (studioPaused(p)) return;
    p.setSetting("plan_paused", JSON.stringify({ at: p.now(), reason }));
    p.event("owner", "studio_paused", null, { reason });
    say(p, currentStage(p), "system", `企画スタジオを止めました(${reason})。「再開する」で続きから動きます。`);
  } else {
    if (!studioPaused(p)) return;
    p.setSetting("plan_paused", "");
    p.event("owner", "studio_resumed", null, {});
    say(p, currentStage(p), "system", "企画スタジオを再開しました。止めたところから続けます。");
  }
}

/** 今動いている(か、次に動く)段階。会話の知らせを置く場所。 */
function currentStage(p: Project): Stage | "handoff" {
  if (p.setting("plan_handoff_requested_at")) return "handoff";
  return STAGES.find((s) => stageStarted(p, s) && !stageDone(p, s)) ?? "req";
}

/**
 * 回り続けていないか。同じ段階で、直近 1 時間に担当を plan_loop_runs 回(既定 10)より多く起こしていたら、
 * 企画スタジオを止めて知らせる(トークンを使い続けないように)。
 * @returns 止めたら、その段階
 */
export function checkStudioLoop(p: Project): string | null {
  if (studioPaused(p)) return null;
  const limit = p.settingNumber("plan_loop_runs", 10);
  const since = new Date(p.clock.now().getTime() - 3_600_000).toISOString();
  const hot = get<{ stage: string; n: number }>(
    p.db,
    `SELECT json_extract(m.payload, '$.stage') AS stage, COUNT(*) AS n FROM runs r JOIN messages m ON m.id = r.message_id
     WHERE m.kind = 'plan' AND r.started_at >= ? GROUP BY stage ORDER BY n DESC LIMIT 1`,
    [since],
  );
  if (!hot || hot.n <= limit) return null;
  const label = hot.stage === "handoff" ? "チームへの引き渡し" : (STAGE_LABEL[hot.stage as Stage] ?? hot.stage);
  setStudioPaused(p, true, `「${label}」で、この 1 時間に担当を ${hot.n} 回起こしていて、同じところを回っているようです。会話と途中経過を見て、指示を足してから再開してください`);
  return hot.stage;
}

/** 段階ごとの進み具合: 起動の回数(通算・直近 1 時間)・金額・エラー・最近の起動。 */
export function studioProgress(p: Project) {
  const since = p.clock.now().getTime() - 3_600_000;
  const rows = all<{ stage: string; id: number; started_at: string; ended_at: string | null; outcome: string | null; error: string | null; cost: number | null; member: string; attempts: number }>(
    p.db,
    `SELECT json_extract(m.payload, '$.stage') AS stage, r.id, r.started_at, r.ended_at, r.outcome, r.error, r.cost_usd AS cost, mb.name AS member, m.attempts
     FROM runs r JOIN messages m ON m.id = r.message_id JOIN members mb ON mb.id = r.member_id WHERE m.kind = 'plan' ORDER BY r.id`,
  );
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

export function studioView(p: Project) {
  const thinking = new Set(
    all<{ stage: string }>(p.db, "SELECT json_extract(payload, '$.stage') AS stage FROM messages WHERE kind = 'plan' AND status IN ('pending','claimed')").map((r) => r.stage),
  );
  const items = openItems(p);
  return {
    stages: STAGES.map((s) => {
      const r = stageRow(p, s);
      return {
        key: s,
        label: STAGE_LABEL[s],
        mode: r.mode,
        version: r.version,
        agreedVersion: r.agreed_version,
        done: stageDone(p, s),
        status: stageStatus(p, s),
        agreeBlocker: agreeBlocker(p, s),
        started: stageStarted(p, s),
        thinking: thinking.has(s),
      };
    }),
    handoff: { blocker: handoffBlocker(p), requested: !!p.setting("plan_handoff_requested_at"), handed: handedOff(p), thinking: thinking.has("handoff") },
    work: planningWork(p),
    /** 止めているか(いつ・なぜ) */
    paused: studioPaused(p),
    /** 段階ごとの進み具合 */
    progress: studioProgress(p),
    loopLimit: p.settingNumber("plan_loop_runs", 10),
    /** 担当の名前(画面はここから受け取る) */
    cast: { planner: p.fixedMember("planner").name, designer: p.fixedMember("designer").name, architect: p.fixedMember("architect").name, lead: p.fixedMember("lead").name },
    brief: artifact<Brief>(p, "req", "brief", "main"),
    requirements: requirements(p),
    openItems: items.map((o) => ({ ...o, options: JSON.parse(o.options) as string[], reversible: !!o.reversible })),
    infra: artifact<Infra>(p, "infra", "infra", "main"),
    flow: artifact<Flow>(p, "flow", "flow", "main"),
    screens: [...screens(p)].map(([key, s]) => ({ key, ...s, comments: comments(p, key) })),
    designSystem: designSystem(p),
    architecture: artifact<Architecture>(p, "model", "architecture", "main"),
    domain: artifact<Domain>(p, "model", "domain", "main"),
    data: artifact<DataDesign>(p, "model", "data", "main"),
    messages: messages(p),
    tickets: p
      .tickets()
      .filter((t) => JSON.parse(String(get<{ plan_refs: string }>(p.db, "SELECT plan_refs FROM tickets WHERE id = ?", [t.id])?.plan_refs ?? "{}")).fromPlan)
      .map((t) => {
        // 引き継いだ PR・Issue のチケットなどは、画面・設計・段階の進め方のひも付けを持たない。画面が落ちないよう空で埋める
        const refs = JSON.parse(String(get<{ plan_refs: string }>(p.db, "SELECT plan_refs FROM tickets WHERE id = ?", [t.id])?.plan_refs ?? "{}")) as Record<string, unknown>;
        return { number: t.number, title: t.title, refs: { ...refs, screens: refs.screens ?? [], design: refs.design ?? [], modes: refs.modes ?? {} } };
      }),
  };
}
