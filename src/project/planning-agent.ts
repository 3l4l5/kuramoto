import { speechNote } from "../domain/cast.js";
import { z } from "zod";
import { get } from "../db/sqlite.js";
import type { Role } from "../domain/roles.js";
import { castName } from "../domain/cast.js";
import { defineTool, type KuramotoTool } from "../harness/types.js";
import type { MessageRow } from "./inbox.js";
import {
  addOpenItem,
  advance,
  aiAnswerOpenItem,
  artifact,
  comments,
  openItems,
  putArtifact,
  putScreen,
  removeRequirement,
  requirements,
  resolveComment,
  say,
  screens,
  stageRow,
  STAGE_LABEL,
  STAGES,
  upsertRequirement,
  withdrawOpenItem,
  type Brief,
  type DataDesign,
  type Domain,
  type Flow,
  type Architecture,
  type Infra,
  type Stage,
} from "./planning.js";
import type { Project } from "./project.js";
import { createTicket } from "./workflow.js";

export type PlanPayload = { stage: Stage | "handoff"; events: { type: string; text: string }[] };

/** 会話の記録に出すときの話し手。 */
export const SPEAKER: Partial<Record<Role, string>> = { planner: "plan", designer: "design", architect: "arch", lead: "lead" };

const BASE: Partial<Record<Role, string>> = {
  planner: `あなたは Kuramoto の企画担当${castName("planner")}です。責任者(人間)と対話して、このプロダクトの要件をまとめます。
- 一度にたくさん聞かず、1 回に 1〜2 個だけ質問します。答えやすいように選択肢を添えます。
- 目的・使う人・やらないことは set_brief に、機能は upsert_requirement に書きます。
- 要件の項目には必ず「受け入れ条件」を書きます。QA がそのまま確認に使える、観察できる書き方にします(「〜すると〜が表示される」)。
- 責任者に決めてほしいことは add_open_item で未決にします。推奨と理由を必ず付けます。
- 返事(最後のテキスト)は、責任者へのチャットとしてそのまま表示されます。短く、日本語で。`,
  designer: `あなたは Kuramoto のデザイナー${castName("designer")}です。要件をもとに、ユーザーフローの図と、画面の触れる試作を作ります。
- フローは set_flow で、画面を箱(node)、遷移を矢印(edge)で描きます。通常の流れは実線、分岐や例外は alt: true(点線)。
  箱は col(0〜3)と row(0〜3)の格子に置き、重ならないようにします。決まっていない分岐は kind: "question" の「?」の箱にし、add_open_item で未決にします。
- 試作は upsert_screen で、1 画面ずつ自己完結した HTML(<style> を含めてよい。外部ファイル・外部の画像は使わない)で作ります。
  スマホ向けなら幅 230px・高さ 424px ほど、デスクトップ向けなら 960×600px ほどに収まるようにします。迷う画面は 2 案(A・B)にします。
- コメントが付いたら試作を直して upsert_screen し、resolve_comment で対応済みにします。
- 返事(最後のテキスト)は、責任者へのチャットとしてそのまま表示されます。短く、日本語で。`,
  architect: `あなたは Kuramoto のアーキテクト${castName("architect")}です。慎重さを優先します。インフラの段階と、アーキテクチャとデータの段階を受け持ちます。
## インフラの段階(画面デザインの後)
- 要件・フロー・画面が求めるもの(画像のアップロード、オフラインでの保存、通知など)を確かめてから決めます。
- 動かす場所と構成 → 環境とデプロイ → 運用 → 費用と規模 の順に決め、set_infra で書きます。
- まず登録されたリポジトリを読み、既にある環境・IaC・Dockerfile・CI を確かめます。既にあるものは使い、新しいクラウドの契約やサービスは安易に増やしません。
- 費用は前提(利用者数・データ量)を書いたうえで月額を見積もります。分からない前提は未決にして聞きます。
- 戻せない選択(データの置き場所の国・解約しにくい契約など)と大きな費用がかかる選択は、必ず add_open_item で責任者の未決にします(reversible: false)。
## アーキテクチャとデータの段階
- インフラの段階で決めたこと(DB の種類など)を前提にします。
- 最初に set_architecture でアーキテクチャスタイルを決めます: スタイル(モノリス・モジュラーモノリス・サービス分割・レイヤード・ヘキサゴナルなど)と選んだ理由・選ばなかった案、モジュールの分け方と責務、守る原則(依存の向きなど)、API の形、フロントの作り(描画方法・状態の持ち方)、使う技術。既にあるコードがあれば、その作り方に合わせます。
- 新しく技術を選ぶ必要がある領域(言語・フレームワーク・DB・主要なライブラリ・ランタイムなど)は技術選定をします。既にあるコードやインフラの段階で決まっている領域は選定せず、stack に「既存に合わせる」と書きます。
  - 候補を 2〜3 個挙げ、評価軸(既存との相性・チームの慣れ・運用のしやすさ・費用・成熟度とライセンス・性能など、その領域で効くもの)で比べ、選んだものと理由を set_architecture の selections に書きます。選んだものは stack にも書きます。
  - 後から戻しにくい選択(言語・DB・フレームワークなど)は、推奨を添えて add_open_item で責任者の未決にします(reversible: false)。
- サービスを分ける・新しい言語やフレームワークを入れるなど、後から戻しにくい選択は add_open_item で責任者の未決にします(reversible: false)。
- 続く順番は ドメインモデル(用語・集約・守るルール・状態の移り変わり・境界)→ 機能ごとの「作る / 既存を使う / 作らない」→ データ設計(表・列・マイグレーションが戻せるか)。
- まず作業場所のリポジトリのコードを読み、既にあるものを確かめます。新しいサービスや表は安易に作りません。作らない選択肢は代わりの手段と一緒に示します。
- 戻せない変更と「作らない」提案は、必ず add_open_item で責任者の未決にします(reversible: false)。判断の結果、聞く意味がなくなった未決は withdraw_open_item で理由を添えて取り下げます。
- set_domain_model と set_data_design で書きます。
- 返事(最後のテキスト)は、責任者へのチャットとしてそのまま表示されます。短く、日本語で。`,
  lead: `あなたは Kuramoto のリーダー${castName("lead")}です。企画スタジオで合意した版から、実装のチケットを作ります。
- 1 チケットは、1 人の開発者が 1 本の PR で終えられる大きさにします。データの変更(マイグレーション)は単独のチケットにします。
- 各チケットに、要件の項目(code)・画面(key)・設計の節をひも付け、本文に受け入れ条件を書きます。省略・お任せで決まった段階があれば、それも本文に書きます。
- インフラの段階で新しく用意するもの(環境・CI/CD・監視など)も、リポジトリに書けるもの(IaC・設定ファイル・ワークフロー)はチケットにします。クラウドの契約やアカウント作成など人が行うことは、チケットにせず finish_handoff の前の返事で責任者に伝えます。
- 作り終えたら finish_handoff を呼びます。`,
};

function openItemTools(p: Project, stage: Stage): KuramotoTool[] {
  return [
    defineTool({
      name: "add_open_item",
      description: "責任者に決めてほしいことを未決に入れる。推奨と理由を必ず付ける。",
      input: {
        question: z.string().describe("何を決めるか。1 文で"),
        options: z.array(z.string()).min(2).max(4),
        recommended: z.number().int().min(0).describe("options の何番目を推奨するか(0 始まり)"),
        why: z.string().describe("推奨の理由と、間違えると何が起きるか"),
        reversible: z.boolean().describe("後から戻せるか"),
      },
      handler: (a) => `未決 #${addOpenItem(p, stage, a)} に入れました。`,
    }),
    defineTool({
      name: "answer_open_item",
      description: "お任せの段階で、未決を推奨などで決める。戻せない判断は決められない(責任者に残す)。",
      input: { id: z.number().int(), answer: z.string() },
      handler: (a) => aiAnswerOpenItem(p, a.id, a.answer) ?? "決めました。決めた内容を返事で責任者に報告してください。",
    }),
    defineTool({
      name: "withdraw_open_item",
      description: "聞く意味がなくなった未決を、理由を添えて取り下げる。",
      input: { id: z.number().int(), reason: z.string() },
      handler: (a) => {
        withdrawOpenItem(p, a.id, a.reason);
        return "取り下げました。";
      },
    }),
  ];
}

const requirementTool = (p: Project, stage: Stage) =>
  defineTool({
    name: "upsert_requirement",
    description: "要件の項目を足す、または直す。code を省くと新しい番号(R1, R2 …)が付く。",
    input: {
      code: z.string().regex(/^R\d+$/).optional(),
      name: z.string().describe("機能の名前(例: 空き枠を探す)"),
      acceptance: z.string().describe("受け入れ条件。QA がそのまま確かめられる書き方で"),
    },
    handler: (a) => `${upsertRequirement(p, a, stage)} を書きました。`,
  });

export function planningTools(p: Project, stage: Stage | "handoff"): KuramotoTool[] {
  switch (stage) {
    case "req":
      return [
        defineTool({
          name: "set_brief",
          description: "目的・使う人・やらないことを書く(全体を置き換える)。",
          input: { purpose: z.string(), users: z.array(z.string()), out_of_scope: z.array(z.string()) },
          handler: (a) => {
            putArtifact(p, "req", "brief", "main", { purpose: a.purpose, users: a.users, outOfScope: a.out_of_scope } satisfies Brief);
            return "書きました。";
          },
        }),
        requirementTool(p, "req"),
        defineTool({
          name: "remove_requirement",
          description: "要件の項目を外す。",
          input: { code: z.string() },
          handler: (a) => {
            removeRequirement(p, a.code);
            return "外しました。";
          },
        }),
        ...openItemTools(p, "req"),
      ];
    case "infra":
      return [
        defineTool({
          name: "set_infra",
          description: "インフラ(動かす場所と構成・環境とデプロイ・運用・費用と規模)を書く(全体を置き換える)。",
          input: {
            hosting: z.object({ summary: z.string().describe("どこでどう動かすかの要約"), reuse: z.array(z.string()).describe("既にあって使うもの") }),
            components: z.array(
              z.object({
                name: z.string().describe("構成要素の名前(例: API)"),
                kind: z.string().describe("種類(web / api / db / storage / auth / queue / cdn / other など)"),
                service: z.string().describe("使うサービス(例: Cloud Run、RDS PostgreSQL)"),
                purpose: z.string(),
                isNew: z.boolean().describe("新しく用意するか(既存を使うなら false)"),
              }),
            ),
            links: z.array(z.object({ from: z.string(), to: z.string(), label: z.string() })).describe("構成要素どうしのつながり(name で指す)"),
            environments: z.array(z.object({ name: z.string(), purpose: z.string() })),
            deploy: z.object({ ci: z.string(), steps: z.array(z.string()), migrations: z.string().describe("マイグレーションの流し方"), secrets: z.string().describe("秘密情報の置き場所") }),
            operations: z.object({ monitoring: z.string(), logging: z.string(), backup: z.string(), rollback: z.string().describe("障害時の戻し方") }),
            cost: z.object({ assumptions: z.array(z.string()).describe("見積もりの前提"), monthly: z.array(z.object({ item: z.string(), usd: z.number() })) }),
          },
          handler: (a) => {
            const names = new Set(a.components.map((c) => c.name));
            const bad = a.links.filter((l) => !names.has(l.from) || !names.has(l.to));
            if (bad.length) return `存在しない構成要素へのつながりがあります: ${bad.map((l) => `${l.from}→${l.to}`).join(", ")}`;
            putArtifact(p, "infra", "infra", "main", a as Infra);
            return `インフラ v${stageRow(p, "infra").version} を書きました。`;
          },
        }),
        ...openItemTools(p, "infra"),
      ];
    case "flow":
      return [
        defineTool({
          name: "set_flow",
          description: "ユーザーフローの図を書く(全体を置き換える)。",
          input: {
            nodes: z.array(
              z.object({
                id: z.string(),
                label: z.string(),
                sub: z.string().optional().describe("要件の code や補足(例: R1)"),
                col: z.number().int().min(0).max(5),
                row: z.number().int().min(0).max(5),
                kind: z.enum(["screen", "question", "error"]).optional(),
              }),
            ),
            edges: z.array(z.object({ from: z.string(), to: z.string(), label: z.string().optional(), alt: z.boolean().optional() })),
          },
          handler: (a) => {
            const ids = new Set(a.nodes.map((n) => n.id));
            const bad = a.edges.filter((e) => !ids.has(e.from) || !ids.has(e.to));
            if (bad.length) return `存在しない箱への矢印があります: ${bad.map((e) => `${e.from}→${e.to}`).join(", ")}`;
            putArtifact(p, "flow", "flow", "main", a as Flow);
            return `フロー v${stageRow(p, "flow").version} を書きました。`;
          },
        }),
        requirementTool(p, "flow"),
        ...openItemTools(p, "flow"),
      ];
    case "screen":
      return [
        defineTool({
          name: "upsert_screen",
          description: "画面の試作を足す、または直す。案(variants)は 1〜2 個。直すと合意は外れる。",
          input: {
            key: z.string().regex(/^[a-z0-9-]+$/).describe("画面の識別子(英小文字。例: search)"),
            name: z.string(),
            device: z.enum(["phone", "desktop"]),
            requirements: z.array(z.string()).describe("この画面が満たす要件の code"),
            variants: z.array(z.object({ id: z.string().regex(/^[A-Z]$/), html: z.string(), note: z.string().optional() })).min(1).max(2),
          },
          handler: (a) => {
            const prev = screens(p).get(a.key);
            const chosen = prev?.chosen && a.variants.some((v) => v.id === prev.chosen) ? prev.chosen : a.variants.length === 1 ? a.variants[0]!.id : null;
            putScreen(p, a.key, { name: a.name, device: a.device, requirements: a.requirements, variants: a.variants, chosen, agreed: false });
            return `画面「${a.name}」を v${stageRow(p, "screen").version} に書きました。`;
          },
        }),
        defineTool({
          name: "get_screen",
          description: "今の試作の HTML とコメントを読む。",
          input: { key: z.string() },
          handler: (a) => JSON.stringify({ screen: screens(p).get(a.key) ?? null, comments: comments(p, a.key) }),
        }),
        defineTool({
          name: "remove_screen",
          description: "画面を外す。",
          input: { key: z.string() },
          handler: (a) => {
            putScreen(p, a.key, null);
            return "外しました。";
          },
        }),
        defineTool({
          name: "resolve_comment",
          description: "直したコメントを対応済みにする。",
          input: { id: z.number().int() },
          handler: (a) => {
            resolveComment(p, a.id);
            return "対応済みにしました。";
          },
        }),
        ...openItemTools(p, "screen"),
      ];
    case "model":
      return [
        defineTool({
          name: "set_architecture",
          description: "アーキテクチャスタイル(スタイル・モジュール・原則・API・フロント・技術)を書く(全体を置き換える)。この段階で最初に書く。",
          input: {
            style: z.object({
              name: z.string().describe("スタイルの名前(例: モジュラーモノリス + ヘキサゴナル)"),
              why: z.string().describe("選んだ理由"),
              alternatives: z.array(z.object({ name: z.string(), whyNot: z.string() })).describe("検討して選ばなかった案と理由"),
            }),
            modules: z.array(z.object({ name: z.string(), responsibility: z.string(), repo: z.string().describe("置くリポジトリ(owner/repo)") })),
            principles: z.array(z.string()).describe("守る原則(例: ドメイン層はインフラに依存しない)"),
            api: z.object({ style: z.string().describe("REST / GraphQL / RPC など"), notes: z.string() }),
            frontend: z.object({ rendering: z.string().describe("SPA / SSR / SSG など"), state: z.string().describe("状態の持ち方") }),
            stack: z.array(z.object({ area: z.string(), choice: z.string(), why: z.string() })).describe("使う技術(言語・フレームワーク・ライブラリ)"),
            selections: z
              .array(
                z.object({
                  area: z.string().describe("選ぶ領域(例: API のフレームワーク)"),
                  need: z.string().describe("なぜ選ぶ必要があるか(既存で決まっていない理由)"),
                  criteria: z.array(z.string()).describe("評価軸"),
                  candidates: z.array(z.object({ name: z.string(), pros: z.string(), cons: z.string() })).min(2).max(4),
                  choice: z.string().describe("選んだ候補の name"),
                  why: z.string().describe("選んだ理由(評価軸に沿って)"),
                  reversible: z.boolean().describe("後から替えやすいか"),
                }),
              )
              .optional()
              .describe("技術選定。新しく技術を選ぶ必要がある領域だけ書く"),
          },
          handler: (a) => {
            const bad = (a.selections ?? []).filter((x) => !x.candidates.some((c) => c.name === x.choice));
            if (bad.length) return `選んだものが候補にありません: ${bad.map((x) => `${x.area}(${x.choice})`).join(", ")}`;
            putArtifact(p, "model", "architecture", "main", a as Architecture);
            return `アーキテクチャ v${stageRow(p, "model").version} を書きました。`;
          },
        }),
        defineTool({
          name: "set_domain_model",
          description: "ドメインモデルと「作る / 既存を使う / 作らない」を書く(全体を置き換える)。",
          input: {
            terms: z.array(z.string()).describe("用語(例: 枠 = 店舗が予約を受け付ける時間帯)"),
            aggregates: z.array(z.string()),
            rules: z.array(z.string()).describe("守るルール"),
            states: z.array(z.string()).describe("状態の移り変わり"),
            boundaries: z.array(z.string()).describe("境界(どのリポジトリ・サービスが何を持つか)"),
            build: z.array(z.object({ feature: z.string(), decision: z.enum(["build", "reuse", "skip"]), note: z.string() })),
            entities: z.array(z.object({ name: z.string(), isNew: z.boolean(), fields: z.array(z.string()) })),
            relations: z.array(z.object({ from: z.string(), to: z.string(), label: z.string() })),
          },
          handler: (a) => {
            putArtifact(p, "model", "domain", "main", a as Domain);
            return `ドメインモデル v${stageRow(p, "model").version} を書きました。`;
          },
        }),
        defineTool({
          name: "set_data_design",
          description: "データ設計(表・列・マイグレーションが戻せるか)を書く(全体を置き換える)。",
          input: {
            tables: z.array(
              z.object({ name: z.string(), change: z.enum(["new", "alter", "none"]), columns: z.array(z.string()), note: z.string(), reversible: z.boolean() }),
            ),
          },
          handler: (a) => {
            putArtifact(p, "model", "data", "main", a as DataDesign);
            return "データ設計を書きました。";
          },
        }),
        ...openItemTools(p, "model"),
      ];
    case "handoff":
      return [
        defineTool({
          name: "create_ticket",
          description: "実装のチケットを 1 件作る。",
          input: {
            title: z.string(),
            body: z.string().describe("やること・受け入れ条件・注意点"),
            requirement: z.string().optional().describe("ひも付ける要件の code(例: R1)"),
            screens: z.array(z.string()).describe("ひも付ける画面の key"),
            design: z.array(z.string()).describe("ひも付ける設計の節(例: ルール 1、reservations 表)"),
            repo: z.string().optional().describe("対象のリポジトリ(owner/repo)。省くと最初に登録したもの"),
          },
          handler: (a) => {
            const repos = p.repos().map((r) => r.full_name);
            if (a.repo && !repos.includes(a.repo)) return `登録されていないリポジトリです。使えるのは ${repos.join(", ")}`;
            const item = a.requirement ? requirements(p).find((r) => r.code === a.requirement) : undefined;
            if (a.requirement && !item) return `要件 ${a.requirement} はありません`;
            const modes = Object.fromEntries(STAGES.map((s) => [s, stageRow(p, s).mode]));
            const versions = Object.fromEntries(STAGES.map((s) => [s, stageRow(p, s).version]));
            const t = createTicket(p, {
              title: a.title,
              body: a.body,
              ...(item ? { requirementItemId: item.id } : {}),
              planRefs: { fromPlan: true, requirement: a.requirement ?? null, screens: a.screens, design: a.design, modes, versions, ...(a.repo ? { repo: a.repo } : {}) },
            });
            return `#${t.number} を作りました。`;
          },
        }),
        defineTool({
          name: "finish_handoff",
          description: "チケットを作り終えたら呼ぶ。",
          input: {},
          handler: () => {
            const n = p.tickets().length;
            if (n === 0) return "チケットが 1 件もありません。create_ticket で作ってください。";
            p.setSetting("plan_handed_at", p.now());
            p.event("lead", "plan_handed", null, { tickets: n });
            return "受け付けました。";
          },
        }),
      ];
  }
}

export function planningSystemPrompt(p: Project, role: Role, focus: string): string {
  const parts = [BASE[role] ?? ""];
  if (focus.trim()) parts.push(`\n## このプロジェクトで重視すること\n${focus.trim()}`);
  parts.push(speechNote(castName(role)));
  return parts.join("\n");
}

/** 今の企画の中身を、担当に渡す形にまとめる(試作の HTML は大きいので名前と状態だけ)。 */
function snapshot(p: Project, stage: Stage | "handoff"): string {
  const rows = STAGES.map((s) => stageRow(p, s));
  const data: Record<string, unknown> = {
    project: { repos: p.repos().map((r) => `${r.full_name}(${r.role})`) },
    stages: rows.map((r) => ({ stage: r.stage, mode: r.mode, version: r.version, agreed: r.agreed_version === r.version })),
    brief: artifact(p, "req", "brief", "main"),
    requirements: requirements(p).map((r) => ({ code: r.code, name: r.name, acceptance: r.acceptance })),
    openItems: openItems(p).map((o) => ({ id: o.id, stage: o.stage, question: o.question, options: JSON.parse(o.options), answer: o.answer, decidedBy: o.decided_by, reversible: !!o.reversible })),
  };
  if (stage !== "req") data.flow = artifact(p, "flow", "flow", "main");
  if (stage === "infra" || stage === "model" || stage === "handoff") data.infra = artifact(p, "infra", "infra", "main");
  if (stage === "screen" || stage === "infra" || stage === "model" || stage === "handoff") {
    data.screens = [...screens(p)].map(([key, s]) => ({
      key,
      name: s.name,
      requirements: s.requirements,
      variants: s.variants.map((v) => v.id),
      chosen: s.chosen,
      agreed: s.agreed,
      openComments: comments(p, key).filter((c) => c.resolved_in === null),
    }));
  }
  if (stage === "model" || stage === "handoff") {
    data.architecture = artifact(p, "model", "architecture", "main");
    data.domain = artifact(p, "model", "domain", "main");
    data.data = artifact(p, "model", "data", "main");
  }
  return JSON.stringify(data, null, 1);
}

export function planningPrompt(p: Project, payload: PlanPayload): string {
  const where = payload.stage === "handoff" ? "チームへの引き渡し" : `段階「${STAGE_LABEL[payload.stage]}」(${payload.stage})`;
  const name = get<{ value: string }>(p.db, "SELECT value FROM settings WHERE key = 'project_name'")?.value ?? "";
  const events = payload.events.map((e) => (e.type === "chat" ? `責任者: ${e.text}` : `[${e.type}] ${e.text}`)).join("\n");
  return `プロジェクト「${name}」の企画スタジオ、${where}です。

## 今の企画の中身
${snapshot(p, payload.stage)}

## 起きたこと
${events}

道具で企画の中身を更新し、最後に責任者への返事を短く書いてください。`;
}

/** 起動が終わったあと: 返事を会話に残し、段階が終わっていれば次の段階を起こす。 */
export function afterPlanningRun(p: Project, msg: MessageRow, role: Role, finalText: string): void {
  const payload = JSON.parse(msg.payload) as PlanPayload;
  if (finalText.trim()) say(p, payload.stage, SPEAKER[role] ?? role, finalText.trim());
  if (payload.stage === "handoff" && p.setting("plan_handed_at")) {
    say(p, "handoff", "lead", `チームに渡しました。チケットを ${p.tickets().length} 件作りました。オフィスで「始業」を押すと、開発が始まります。`);
  }
  advance(p);
}
