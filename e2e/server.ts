/**
 * E2E テスト用のサーバー。本物の Claude と GitHub は使わず、台本どおりに動くフェイクの担当で動かす。
 * E2E_WEB_DIR で配る画面の置き場所を変えられる(既定は ui/dist)。
 */
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { GitHub, PrStatus } from "../src/github/github.js";
import { FakeHarness, fixedAll, withResolutions } from "../src/harness/fake.js";
import { Hq } from "../src/hq.js";
import { StaticWorkspace } from "../src/project/workspace.js";
import { KuramotoServer } from "../src/server.js";

const port = Number(process.env.E2E_PORT ?? 4390);
const webDir = resolve(process.env.E2E_WEB_DIR ?? "ui/dist");
const home = mkdtempSync(join(tmpdir(), "kuramoto-e2e-"));
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const phone = (body: string) =>
  `<!doctype html><style>body{margin:0;font:13px system-ui}header{background:#2F67D4;color:#fff;padding:12px;font-weight:700}.r{padding:12px;border-bottom:1px solid #eee}</style>${body}`;

const agents = new FakeHarness(async (req, call) => {
  const has = (n: string) => req.tools.some((t) => t.name === n);
  const ev = req.prompt;
  const step = (text: string) => req.onProgress?.({ type: "step", kind: "tool", text });

  // 企画: 会話から要件を書く。作業中の様子が見えるよう、少し時間をかける
  if (has("set_brief")) {
    if (ev.includes("責任者:")) {
      step("README.md を読んでいます");
      req.onProgress?.({ type: "step", kind: "thinking", text: "目的と使う人から整理する" });
      await wait(2500);
      await call("set_brief", { purpose: "スマホから予約を 1 分で終える", users: ["会員"], out_of_scope: ["決済"] });
      await call("upsert_requirement", { name: "空き枠を探す", acceptance: "店舗と日付を選ぶと、残りのある枠が時間順に並ぶ" });
      await call("upsert_requirement", { name: "予約する", acceptance: "枠を選んで確定すると予約が確定する" });
      await call("add_open_item", { question: "予約の変更を作るか", options: ["作らない", "作る"], recommended: 0, why: "キャンセルと予約し直しで足りる", reversible: true });
      return { finalText: "要件を書きました。未決が 1 件あります。" };
    }
    if (ev.includes("[answer]")) return { finalText: "反映しました。" };
    return { finalText: "企画担当の咲季です。何のためのものですか?" };
  }
  if (has("set_flow")) {
    const answered = ev.includes("[answer]");
    await call("set_flow", {
      nodes: [
        { id: "S1", label: "空き枠を探す", sub: "R1", col: 0, row: 0 },
        { id: "S2", label: "予約の確認", sub: "R2", col: 1, row: 0 },
        answered ? { id: "E1", label: "満席のお知らせ", col: 1, row: 1, kind: "error" } : { id: "Q", label: "?", sub: "満席になったら", col: 1, row: 1, kind: "question" },
      ],
      edges: [
        { from: "S1", to: "S2", label: "枠を選ぶ" },
        { from: "S2", to: answered ? "E1" : "Q", label: "確定の直前に満席", alt: true },
      ],
    });
    if (!answered) await call("add_open_item", { question: "満席になったらどこへ戻すか", options: ["近い枠を出して戻す", "お知らせを出す"], recommended: 0, why: "予約できたと思い込むのを防ぐ", reversible: true });
    return { finalText: answered ? "図に足しました。" : "フローを描きました。" };
  }
  if (has("upsert_screen")) {
    const screens = async (a: string) => {
      await call("upsert_screen", {
        key: "search",
        name: "空き枠を探す",
        device: "phone",
        requirements: ["R1"],
        variants: [
          { id: "A", html: phone(`<header>空き枠を探す</header><div class="r">${a}</div>`), note: "リスト" },
          { id: "B", html: phone("<header>空き枠を探す</header><div class=r>カレンダー</div>"), note: "カレンダー" },
        ],
      });
    };
    if (ev.includes("[comment]")) {
      await screens("10:00 残り 1(目立たせた)");
      await call("resolve_comment", { id: Number(ev.match(/コメント #(\d+)/)![1]) });
      return { finalText: "直しました。" };
    }
    if (ev.includes("[kickoff]")) {
      await screens("10:00 残り 1");
      await call("upsert_screen", { key: "confirm", name: "予約の確認", device: "phone", requirements: ["R2"], variants: [{ id: "A", html: phone("<header>予約の確認</header>") }] });
      return { finalText: "試作を作りました。" };
    }
    return { finalText: "承知しました。" };
  }
  if (has("set_infra")) {
    if (ev.includes("[answer]")) return { finalText: "反映しました。" };
    await call("set_infra", {
      hosting: { summary: "既存の AWS に載せる", reuse: ["acme の AWS アカウント"] },
      components: [
        { name: "Web", kind: "web", service: "CloudFront + S3", purpose: "画面を配る", isNew: true },
        { name: "DB", kind: "db", service: "RDS PostgreSQL", purpose: "予約を保存", isNew: false },
      ],
      links: [{ from: "Web", to: "DB", label: "SQL" }],
      environments: [{ name: "staging", purpose: "確認用" }],
      deploy: { ci: "GitHub Actions", steps: ["merge で staging へ"], migrations: "デプロイ前に流す", secrets: "Secrets Manager" },
      operations: { monitoring: "CloudWatch", logging: "CloudWatch Logs", backup: "7 日", rollback: "前の版に戻す" },
      cost: { assumptions: ["月 1 万予約"], monthly: [{ item: "CloudFront + S3", usd: 8 }] },
    });
    await call("add_open_item", { question: "データを東京に置くか", options: ["東京", "米国"], recommended: 0, why: "後から移すのは難しい", reversible: false });
    return { finalText: "既存の AWS に載せる構成にしました。" };
  }
  if (has("set_domain_model")) {
    await call("set_architecture", {
      style: { name: "モジュラーモノリス", why: "小さいチームで速く作れる", alternatives: [{ name: "サービス分割", whyNot: "運用が重い" }] },
      modules: [{ name: "予約", responsibility: "枠と予約", repo: "acme/shop" }],
      principles: ["ドメイン層はインフラに依存しない"],
      api: { style: "REST", notes: "" },
      frontend: { rendering: "SPA", state: "サーバーの状態はキャッシュする" },
      stack: [{ area: "API", choice: "Hono", why: "軽い" }],
      // 技術選定は、未決に答えたあとに書く(最初はアーキテクチャだけ)
      ...(ev.includes("[answer]")
        ? {
            selections: [
              {
                area: "API のフレームワーク",
                need: "API のリポジトリが空で、決まっていない",
                criteria: ["既存との相性", "運用のしやすさ"],
                candidates: [
                  { name: "Hono", pros: "軽い", cons: "情報が少なめ" },
                  { name: "Express", pros: "情報が多い", cons: "型が弱い" },
                ],
                choice: "Hono",
                why: "軽く、型が効く",
                reversible: false,
              },
            ],
          }
        : {}),
    });
    // 最初はアーキテクチャスタイルだけを書いて、戻しにくい選択を聞く。答えが出たらドメインとテーブル設計を書く
    if (!ev.includes("[answer]")) {
      await call("add_open_item", { question: "サービスを分けずに 1 つで作るか", options: ["1 つで作る", "分ける"], recommended: 0, why: "分けると運用が重く、後から 1 つに戻しにくい", reversible: false });
      return { finalText: "アーキテクチャスタイルを書きました。1 点だけ決めてください。" };
    }
    await call("set_domain_model", {
      terms: ["枠 = 予約を受け付ける時間帯"], aggregates: ["予約"], rules: ["定員を超えない"], states: ["確定 → キャンセル"], boundaries: ["acme/shop が持つ"],
      build: [{ feature: "空き枠を探す", decision: "build", note: "" }],
      entities: [{ name: "予約", isNew: true, fields: ["id", "slot_id"] }], relations: [],
    });
    await call("set_data_design", {
      tables: [
        { name: "reservations", change: "new", columns: ["id uuid — 予約の ID", "slot_id uuid — どの枠か"], note: "予約を持つ", reversible: true },
        { name: "slots", change: "new", columns: ["id uuid", "capacity int — 定員"], note: "", reversible: true },
      ],
    });
    return { finalText: "設計を書きました。" };
  }
  // リーダーの交通整理: ぶつからないので全部並列にする(順番待ちの動きは単体テストで確かめる)
  if (has("plan_work") && !has("add_ticket_note")) {
    const ns = [...ev.matchAll(/### #(\d+) /g)].map((m) => Number(m[1]));
    await call("plan_work", { items: ns.map((n) => ({ number: n, after: [] })) });
    return { finalText: `#${ns.join("・#")} はぶつからないから、並列に進めるわ。` };
  }
  // リーダーとのチャット
  if (has("add_ticket_note")) {
    const n = ev.match(/- #(\d+) /)?.[1];
    return { finalText: n ? `#${n} は今動いています。ほかに気になることがあれば書いてください。` : "まだチケットはありません。" };
  }
  if (has("create_ticket")) {
    await call("create_ticket", { title: "予約の表を足す", body: "マイグレーション", requirement: "R2", screens: [], design: ["reservations 表"] });
    await call("create_ticket", { title: "空き枠を探す画面", body: "R1", requirement: "R1", screens: ["search"], design: [] });
    await call("finish_handoff", {});
    return { finalText: "" };
  }
  // オフィス: 開発は PR を出し、レビューは通す
  if (has("submit_pr")) {
    // 作業中の様子がオフィスに見えるよう、少し時間をかける
    step("src/export.ts を書いています");
    await wait(1500);
    const repo = ev.match(/リポジトリは (\S+?)、/)?.[1] ?? "";
    const n = Number(ev.match(/チケット (?:\S+\(#)?#?(\d+)/)?.[1] ?? 1);
    await call("submit_pr", { repo, number: 100 + n, head: `kuramoto/${n}`, summary: "実装した" , responses: fixedAll(req.prompt) });
    return { finalText: "" };
  }
  if (has("submit_review")) {
    // 「空き枠を探す画面」の最初のレビューだけ、必須の指摘と提案を出して差し戻す(往復の様子を見せる)
    if (ev.includes("空き枠を探す画面") && !ev.includes("再レビュー")) {
      await call("submit_review", {
        findings: [
          { category: "correctness", severity: "high", basis: "acceptance", path: "src/search.ts", line: 12, body: "残り 0 の枠も並んでいる" },
          { category: "style", severity: "low", body: "関数名をもう少し具体的に" },
        ],
      });
      return { finalText: "" };
    }
    await call("submit_review", withResolutions(req.prompt, { findings: [] }));
    return { finalText: "" };
  }
  return { finalText: "" };
});

const github: GitHub = {
  prStatus: async (): Promise<PrStatus> => ({ state: "OPEN", mergeable: "MERGEABLE", ci: "success" }),
  merge: async () => {},
  comment: async () => "",
};

const app = new KuramotoServer({ hq: new Hq(home), webDir, harnesses: { "claude-agent-sdk": agents }, github, workspaceFor: () => new StaticWorkspace(home),
  // 画面から merge を押す流れを確かめるので、自動 merge はテストの間に動かないようにする(自動 merge は単体テストで確かめる)
  mergePollMs: 3_600_000,
});
await app.resume();
createServer((req, res) => void app.handle(req, res)).listen(port, "127.0.0.1", () => console.log(`e2e server: http://localhost:${port} (${webDir})`));
