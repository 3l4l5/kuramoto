import { describe, expect, it } from "vitest";
import { ManualClock } from "../clock.js";
import { exportDesignDoc } from "./export.js";
import { addOpenItem, answerOpenItem, putArtifact, putScreen, setMode, upsertRequirement } from "./planning.js";
import { Project } from "./project.js";

describe("設計書のエクスポート", () => {
  it("要件・フロー・画面・インフラ・アーキテクチャ・ドメイン・データを 1 つの Markdown にまとめ、図は Mermaid で書く", async () => {
    const p = new Project(":memory:", new ManualClock());
    p.addRepo("acme/shop", "API");
    putArtifact(p, "req", "brief", "main", { purpose: "予約を 1 分で", users: ["会員"], outOfScope: ["決済"] });
    upsertRequirement(p, { name: "空き枠を探す", acceptance: "残りのある枠が | 時間順に並ぶ\n満席は出さない" });
    const q = addOpenItem(p, "req", { question: "変更を作るか", options: ["作らない", "作る"], recommended: 0, why: "", reversible: true });
    answerOpenItem(p, q, "作らない");
    putArtifact(p, "flow", "flow", "main", {
      nodes: [{ id: "S1", label: "探す", col: 0, row: 0 }, { id: "Q", label: "?", sub: "満席なら", col: 1, row: 0, kind: "question" }],
      edges: [{ from: "S1", to: "Q", label: "確定の直前に \"満席\"", alt: true }],
    });
    putScreen(p, "search", { name: "空き枠を探す", device: "phone", requirements: ["R1"], variants: [{ id: "A", html: "<p>A</p>" }, { id: "B", html: "<p>B</p>" }], chosen: "B", agreed: true });
    setMode(p, "infra", "skip");
    putArtifact(p, "model", "architecture", "main", {
      style: { name: "モジュラーモノリス", why: "小さいチームで速く", alternatives: [{ name: "サービス分割", whyNot: "運用が重い" }] },
      modules: [{ name: "予約", responsibility: "枠と予約", repo: "acme/shop" }],
      principles: ["ドメイン層はインフラに依存しない"],
      api: { style: "REST", notes: "" },
      frontend: { rendering: "SPA", state: "サーバーの状態はキャッシュ" },
      stack: [{ area: "API", choice: "Hono", why: "軽い" }],
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
    });
    putArtifact(p, "model", "domain", "main", {
      terms: ["枠 = 時間帯"], aggregates: ["予約"], rules: ["定員を超えない"], states: [], boundaries: [],
      build: [{ feature: "変更", decision: "skip", note: "キャンセルで代える" }],
      entities: [{ name: "予約", isNew: true, fields: ["id", "slot_id"] }, { name: "枠", isNew: true, fields: ["id"] }],
      relations: [{ from: "枠", to: "予約", label: "1 — n" }],
    });
    putArtifact(p, "model", "data", "main", { tables: [{ name: "reservations", change: "new", columns: ["id", "slot_id"], note: "", reversible: false }] });

    const md = exportDesignDoc(p, "予約サイト");
    expect(md).toContain("# 予約サイト 設計書");
    expect(md).toContain("| 要件 | v1 | 下書き |");
    expect(md).toContain("| インフラ | v1 | 省略 |");
    // 表のセルは | と改行を逃がす
    expect(md).toContain("| R1 | 空き枠を探す | 残りのある枠が \\| 時間順に並ぶ<br>満席は出さない |");
    expect(md).toContain("[要件] 変更を作るか → **作らない**");
    // フローは Mermaid。分岐は点線、未決は菱形、" は逃がす
    expect(md).toContain("```mermaid\nflowchart LR");
    expect(md).toMatch(/n1_Q\{"\?<br>満席なら"\}/);
    expect(md).toContain('-.->|"確定の直前に #quot;満席#quot;"|');
    // 画面は選んだ案の HTML を添える
    expect(md).toContain("選んだ案: B");
    expect(md).toContain("```html\n<p>B</p>\n```");
    expect(md).toContain("この段階は省きました(実装中に決める)。");
    expect(md).toContain("### アーキテクチャスタイル: モジュラーモノリス");
    expect(md).toContain("サービス分割 — 運用が重い");
    expect(md).toContain("| API | Hono | 軽い |");
    expect(md).toContain("#### 技術選定: API のフレームワーク");
    expect(md).toContain("| **Hono(選択)** | 軽い | 情報が少なめ |");
    expect(md).toContain("**Hono** を選んだ理由: 軽く、型が効く(後から替えにくい)");
    expect(md).toContain("classDiagram");
    expect(md).toContain("**作らない**: 変更 — キャンセルで代える");
    expect(md).toContain("| reservations | 新規 | id, slot_id | **戻せない** |  |");
  });
});
