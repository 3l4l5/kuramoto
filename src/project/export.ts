import type { Project } from "./project.js";
import { collectTransfer, embedTransfer } from "./transfer.js";
import {
  artifact,
  comments,
  openItems,
  requirements,
  screens,
  stageRow,
  STAGE_LABEL,
  STAGES,
  type Architecture,
  type Brief,
  type DataDesign,
  type Domain,
  type Flow,
  type Infra,
  type Stage,
} from "./planning.js";

/**
 * 企画スタジオで決めた要件と技術的な設計を、1 つの Markdown にまとめる。
 * 図は Mermaid で書くので、GitHub などではそのまま図として表示される(ADR-0014 の docs/ に置ける形)。
 */
export function exportDesignDoc(p: Project, projectName: string): string {
  const out: string[] = [];
  const h = (level: number, text: string) => out.push("", `${"#".repeat(level)} ${text}`, "");
  const list = (xs: string[]) => xs.forEach((x) => out.push(`- ${x}`));

  out.push(`# ${projectName} 設計書`, "");
  out.push(`- 書き出した日時: ${p.now()}`);
  out.push(`- リポジトリ: ${p.repos().map((r) => `${r.full_name}(${r.role})`).join("、") || "なし"}`);
  out.push("", "| 段階 | 版 | 状態 |", "|---|---|---|");
  for (const s of STAGES) out.push(`| ${STAGE_LABEL[s]} | v${stageRow(p, s).version} | ${statusOf(p, s)} |`);

  // ---- 要件 ----
  h(2, "1. 要件");
  const brief = artifact<Brief>(p, "req", "brief", "main");
  if (brief) {
    out.push(`- 目的: ${brief.purpose}`, `- 使う人: ${brief.users.join("、")}`, `- やらないこと: ${brief.outOfScope.join("、") || "なし"}`);
  }
  const reqs = requirements(p);
  if (reqs.length) {
    out.push("", "| 番号 | 機能 | 受け入れ条件 |", "|---|---|---|");
    for (const r of reqs) out.push(`| ${r.code} | ${cell(r.name)} | ${cell(r.acceptance)} |`);
  } else out.push("(まだありません)");

  // ---- 決まったこと・未決 ----
  const items = openItems(p);
  const decided = items.filter((o) => o.answer !== null);
  const open = items.filter((o) => o.answer === null);
  if (decided.length) {
    h(3, "決まったこと");
    list(decided.map((o) => `[${STAGE_LABEL[o.stage]}] ${o.question} → **${o.answer}**${o.decided_by === "ai" ? "(お任せで決定)" : ""}`));
  }
  if (open.length) {
    h(3, "未決");
    list(open.map((o) => `[${STAGE_LABEL[o.stage]}] ${o.question}(選択肢: ${(JSON.parse(o.options) as string[]).join(" / ")}${o.reversible ? "" : "、戻せない"})`));
  }

  // ---- ユーザーフロー ----
  h(2, "2. ユーザーフロー");
  const flow = artifact<Flow>(p, "flow", "flow", "main");
  if (skipped(p, "flow")) out.push("この段階は省きました(実装中に決める)。");
  else if (flow) out.push("```mermaid", ...flowMermaid(flow), "```", "", "実線は通常の流れ、点線は分岐と例外です。");
  else out.push("(まだありません)");

  // ---- 画面 ----
  h(2, "3. 画面デザイン");
  const scr = [...screens(p)];
  if (skipped(p, "screen")) out.push("この段階は省きました(開発が要件から直接作る)。");
  else if (!scr.length) out.push("(まだありません)");
  for (const [key, s] of scr) {
    h(3, `${s.name}(${key})`);
    const chosen = s.variants.find((v) => v.id === s.chosen) ?? (s.variants.length === 1 ? s.variants[0] : undefined);
    out.push(`- 要件: ${s.requirements.join("、") || "なし"}`, `- 向き: ${s.device === "phone" ? "スマホ" : "デスクトップ"}`, `- 案: ${s.variants.map((v) => v.id).join("・")}(選んだ案: ${chosen?.id ?? "未選択"})${s.agreed ? "、合意済み" : ""}`);
    if (chosen?.note) out.push(`- 案のメモ: ${chosen.note}`);
    const cs = comments(p, key);
    if (cs.length) out.push(`- コメント: ${cs.map((c) => `${c.body}${c.resolved_in !== null ? "(対応済み)" : "(対応待ち)"}`).join(" / ")}`);
    if (chosen) out.push("", "<details><summary>試作の HTML</summary>", "", "```html", chosen.html, "```", "", "</details>");
  }

  // ---- インフラ ----
  h(2, "4. インフラ");
  const infra = artifact<Infra>(p, "infra", "infra", "main");
  if (skipped(p, "infra")) out.push("この段階は省きました(実装中に決める)。");
  else if (!infra) out.push("(まだありません)");
  else {
    out.push(infra.hosting.summary);
    if (infra.hosting.reuse.length) out.push("", `既にあって使うもの: ${infra.hosting.reuse.join("、")}`);
    out.push("", "```mermaid", ...infraMermaid(infra), "```", "");
    out.push("| 名前 | 種類 | サービス | 役目 | 新規 / 既存 |", "|---|---|---|---|---|");
    for (const c of infra.components) out.push(`| ${cell(c.name)} | ${cell(c.kind)} | ${cell(c.service)} | ${cell(c.purpose)} | ${c.isNew ? "新規" : "既存"} |`);
    h(3, "環境とデプロイ");
    list(infra.environments.map((e) => `${e.name}: ${e.purpose}`));
    out.push("", `- CI/CD: ${infra.deploy.ci}`, `- マイグレーション: ${infra.deploy.migrations}`, `- 秘密情報: ${infra.deploy.secrets}`);
    infra.deploy.steps.forEach((s, i) => out.push(`${i + 1}. ${s}`));
    h(3, "運用");
    out.push(`- 監視: ${infra.operations.monitoring}`, `- ログ: ${infra.operations.logging}`, `- バックアップ: ${infra.operations.backup}`, `- 障害時の戻し方: ${infra.operations.rollback}`);
    h(3, "費用と規模(月額の見積もり)");
    list(infra.cost.assumptions.map((a) => `前提: ${a}`));
    out.push("", "| 項目 | 月額 |", "|---|---:|");
    for (const m of infra.cost.monthly) out.push(`| ${cell(m.item)} | $${m.usd.toLocaleString()} |`);
    out.push(`| **合計** | **$${infra.cost.monthly.reduce((s, m) => s + m.usd, 0).toLocaleString()}** |`);
  }

  // ---- アーキテクチャとデータ ----
  h(2, "5. アーキテクチャとデータ");
  const arch = artifact<Architecture>(p, "model", "architecture", "main");
  const domain = artifact<Domain>(p, "model", "domain", "main");
  const data = artifact<DataDesign>(p, "model", "data", "main");
  if (skipped(p, "model")) out.push("この段階は省きました(実装中に決める)。");
  if (arch) {
    h(3, `アーキテクチャスタイル: ${arch.style.name}`);
    out.push(arch.style.why);
    if (arch.style.alternatives.length) {
      out.push("", "検討して選ばなかった案:");
      list(arch.style.alternatives.map((a) => `${a.name} — ${a.whyNot}`));
    }
    if (arch.modules.length) {
      out.push("", "| モジュール | 責務 | リポジトリ |", "|---|---|---|");
      for (const m of arch.modules) out.push(`| ${cell(m.name)} | ${cell(m.responsibility)} | ${cell(m.repo)} |`);
    }
    if (arch.principles.length) {
      out.push("", "守る原則:");
      list(arch.principles);
    }
    out.push("", `- API: ${arch.api.style}${arch.api.notes ? `(${arch.api.notes})` : ""}`, `- フロント: ${arch.frontend.rendering} / 状態: ${arch.frontend.state}`);
    if (arch.stack.length) {
      out.push("", "| 領域 | 技術 | 理由 |", "|---|---|---|");
      for (const s of arch.stack) out.push(`| ${cell(s.area)} | ${cell(s.choice)} | ${cell(s.why)} |`);
    }
    for (const sel of arch.selections ?? []) {
      h(4, `技術選定: ${sel.area}`);
      out.push(`- 選ぶ必要: ${sel.need}`, `- 評価軸: ${sel.criteria.join("、")}`, "");
      out.push("| 候補 | よい点 | 気になる点 |", "|---|---|---|");
      for (const c of sel.candidates) out.push(`| ${c.name === sel.choice ? `**${cell(c.name)}(選択)**` : cell(c.name)} | ${cell(c.pros)} | ${cell(c.cons)} |`);
      out.push("", `**${sel.choice}** を選んだ理由: ${sel.why}${sel.reversible ? "" : "(後から替えにくい)"}`);
    }
  }
  if (domain) {
    h(3, "ドメインモデル");
    if (domain.entities.length) out.push("```mermaid", ...domainMermaid(domain), "```", "");
    const sec = (title: string, xs: string[]) => {
      if (!xs.length) return;
      out.push(`**${title}**`, "");
      list(xs);
      out.push("");
    };
    sec("用語", domain.terms);
    sec("集約", domain.aggregates);
    sec("守るルール", domain.rules);
    sec("状態の移り変わり", domain.states);
    sec("境界", domain.boundaries);
    h(3, "作る / 既存を使う / 作らない");
    const label = { build: "作る", reuse: "既存を使う", skip: "作らない" } as const;
    list(domain.build.map((b) => `**${label[b.decision]}**: ${b.feature}${b.note ? ` — ${b.note}` : ""}`));
  }
  if (data) {
    h(3, "データ設計");
    out.push("| 表 | 変更 | 列 | 戻せるか | メモ |", "|---|---|---|---|---|");
    const change = { new: "新規", alter: "変更", none: "変更なし" } as const;
    for (const t of data.tables) out.push(`| ${cell(t.name)} | ${change[t.change]} | ${cell(t.columns.join(", "))} | ${t.reversible ? "戻せる" : "**戻せない**"} | ${cell(t.note)} |`);
  }
  if (!arch && !domain && !data && !skipped(p, "model")) out.push("(まだありません)");

  // ---- チケット ----
  const tickets = p.tickets().filter((t) => (JSON.parse(t.plan_refs || "{}") as { fromPlan?: boolean }).fromPlan);
  if (tickets.length) {
    h(2, "6. チケット");
    out.push("| 番号 | 内容 | 状態 |", "|---|---|---|");
    for (const t of tickets) out.push(`| #${t.number} | ${cell(t.title)} | ${t.stage} |`);
  }
  return out.join("\n") + "\n" + embedTransfer(collectTransfer(p, projectName));
}

function statusOf(p: Project, s: Stage): string {
  const r = stageRow(p, s);
  if (r.mode === "skip") return "省略";
  if (r.agreed_version === r.version) return "合意済み";
  if (r.mode === "delegate") return "お任せ";
  return r.agreed_version !== null ? `v${r.agreed_version} に合意済み・変更あり` : "下書き";
}

const skipped = (p: Project, s: Stage) => stageRow(p, s).mode === "skip";

/** 表のセルに入れる文字(改行と | を逃がす)。 */
const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>");

/** Mermaid のラベル(" を逃がす)。 */
const lbl = (s: string) => `"${s.replace(/"/g, "#quot;")}"`;
const mid = (s: string, i: number) => `n${i}_${s.replace(/[^A-Za-z0-9_]/g, "")}`;

function flowMermaid(f: Flow): string[] {
  const ids = new Map(f.nodes.map((n, i) => [n.id, mid(n.id, i)]));
  const lines = ["flowchart LR"];
  for (const n of f.nodes) {
    const text = n.sub ? `${n.label}<br>${n.sub}` : n.label;
    lines.push(`  ${ids.get(n.id)}${n.kind === "question" ? `{${lbl(text)}}` : `[${lbl(text)}]`}`);
  }
  for (const e of f.edges) {
    const a = ids.get(e.from), b = ids.get(e.to);
    if (!a || !b) continue;
    const arrow = e.alt ? "-.->" : "-->";
    lines.push(`  ${a} ${arrow}${e.label ? `|${lbl(e.label)}|` : ""} ${b}`);
  }
  return lines;
}

function infraMermaid(f: Infra): string[] {
  const ids = new Map(f.components.map((c, i) => [c.name, mid(c.name, i)]));
  const lines = ["flowchart LR"];
  for (const c of f.components) lines.push(`  ${ids.get(c.name)}[${lbl(`${c.name}<br>${c.service}${c.isNew ? "" : "(既存)"}`)}]`);
  for (const l of f.links) {
    const a = ids.get(l.from), b = ids.get(l.to);
    if (a && b) lines.push(`  ${a} -->|${lbl(l.label)}| ${b}`);
  }
  return lines;
}

function domainMermaid(d: Domain): string[] {
  const ids = new Map(d.entities.map((e, i) => [e.name, mid(e.name, i)]));
  const lines = ["classDiagram"];
  for (const e of d.entities) {
    lines.push(`  class ${ids.get(e.name)}[${lbl(`${e.name}${e.isNew ? "(新規)" : "(既存)"}`)}] {`);
    for (const f of e.fields) lines.push(`    ${f.replace(/[{}]/g, "")}`);
    lines.push("  }");
  }
  for (const r of d.relations) {
    const a = ids.get(r.from), b = ids.get(r.to);
    if (a && b) lines.push(`  ${a} -- ${b} : ${r.label.replace(/[:\n]/g, " ")}`);
  }
  return lines;
}
