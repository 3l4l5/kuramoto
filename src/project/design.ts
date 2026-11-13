import type { Role } from "../domain/roles.js";
import { designSystem, designSystemCss, requirements, screens, type DesignSystem } from "./planning.js";
import type { Project, TicketRow } from "./project.js";

/**
 * デザインを合わせる(ADR-0033)。企画スタジオで決めた画面の試作(HTML)を、作る人と確かめる人に渡す。
 * - 渡すのは、チケットにひも付けた画面と、チケットの要件をひも付けた画面。案が複数あれば選んだ案(無ければ最初の案)
 * - 試作は作業場所の .kuramoto/design/<画面>.html に置く(git には入れない)。担当は開いて見比べられる
 * - 開発は試作に合わせて作り、QA は実装した画面と試作のスクリーンショットを見比べ、レビューは差分を試作と照らす
 */

export const DESIGN_DIR = ".kuramoto/design";

export type DesignFile = { key: string; name: string; device: "phone" | "desktop"; file: string; html: string; requirements: string[]; note?: string };

/** チケットに関わる画面の試作。 */
export function designFor(p: Project, ticket: TicketRow): DesignFile[] {
  const refs = JSON.parse(ticket.plan_refs || "{}") as { screens?: string[]; requirement?: string | null };
  const req = refs.requirement ?? requirements(p).find((r) => r.id === (ticket as TicketRow & { requirement_item_id?: number | null }).requirement_item_id)?.code;
  const linked = new Set(refs.screens ?? []);
  // デザインシステムの土台のチケットは、カタログに全部の画面を並べるので、全部の試作を渡す
  const all = isDesignSystemTicket(p, ticket);
  const out: DesignFile[] = [];
  for (const [key, s] of screens(p)) {
    if (!all && !linked.has(key) && !(req && s.requirements.includes(req))) continue;
    const v = s.variants.find((x) => x.id === s.chosen) ?? s.variants[0];
    if (!v) continue;
    const safe = key.replace(/[^A-Za-z0-9_-]/g, "_");
    out.push({ key, name: s.name, device: s.device, file: `${DESIGN_DIR}/${safe}.html`, html: v.html, requirements: s.requirements, ...(v.note ? { note: v.note } : {}) });
  }
  return out;
}

export function isDesignSystemTicket(p: Project, ticket: TicketRow): boolean {
  return !!(JSON.parse(ticket.plan_refs || "{}") as { designSystem?: boolean }).designSystem;
}

/** デザインシステムの見本(トークンの CSS・部品を並べた HTML・元の JSON)。 */
export function designSystemFiles(ds: DesignSystem): { file: string; data: string }[] {
  const css = designSystemCss(ds);
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const swatches = ds.tokens
    .map((t) => `<tr><td><code>${esc(t.name)}</code></td><td><code>${esc(t.value)}</code></td><td>${t.group === "color" ? `<span style="display:inline-block;width:40px;height:20px;border:1px solid #ccc;background:var(${t.name})"></span>` : ""}</td><td>${esc(t.use)}</td></tr>`)
    .join("");
  const parts = ds.components.map((c) => `<section><h2>${esc(c.name)}</h2><p>${esc(c.use)}(状態: ${esc(c.states.join("・"))})</p><div class="sample">${c.html}</div></section>`).join("");
  const page = `<!doctype html><meta charset="utf-8"><title>デザインシステム</title><style>${css}body{font-family:system-ui,sans-serif;margin:24px;}section{margin:24px 0;}.sample{padding:16px;border:1px dashed #bbb;}table{border-collapse:collapse}td{padding:4px 8px;border-bottom:1px solid #eee}</style><h1>デザインシステム</h1><ul>${ds.principles.map((x) => `<li>${esc(x)}</li>`).join("")}</ul><h2>トークン</h2><table>${swatches}</table>${parts}`;
  return [
    { file: `${DESIGN_DIR}/design-system.json`, data: JSON.stringify(ds, null, 2) },
    { file: `${DESIGN_DIR}/tokens.css`, data: css },
    { file: `${DESIGN_DIR}/components.html`, data: page },
  ];
}

/** 担当への指示に足す、デザインの節。役割ごとに、試作をどう使うかを書く。 */
export function designPrompt(files: DesignFile[], role: Role, opts: { hasSystem?: boolean; systemTicket?: boolean; references?: Set<string> } = {}): string {
  if (!files.length && !opts.hasSystem) return "";
  const system = opts.hasSystem
    ? `\n### デザインシステム(開発チームとの共通の決まり)\n- \`${DESIGN_DIR}/design-system.json\`(方針・トークン・部品の定義)、\`${DESIGN_DIR}/tokens.css\`(トークンの CSS 変数)、\`${DESIGN_DIR}/components.html\`(部品の見本。ブラウザで開ける)\n- 色・文字・余白・角丸・影は、トークン(CSS 変数)だけを使います。画面ごとに新しい値を作りません。ボタンや入力欄などは、プロダクトに作った共通の部品を使います。\n`
    : "";
  const ds = opts.systemTicket
    ? `\n### このチケットはデザインシステムの土台です\n- トークンを、プロダクト全体で読み込む CSS(CSS 変数)にします。値は \`tokens.css\` と同じにします。\n- 部品を、画面のコードから呼べる共通の部品(関数やテンプレート)にします。見た目は \`components.html\` と同じにし、状態(押せない・エラーなど)も作ります。\n- 開発のときだけ開けるカタログのページ \`/_design\` を作ります。トークン(色は色見本)・すべての部品とその状態・各画面を並べます。本番では開けないようにします。\n- カタログを開いてスクリーンショットを撮り、\`components.html\` と見比べてから報告します。\n`
    : "";
  const refs = opts.references ?? new Set<string>();
  const size = (d: DesignFile) => (d.device === "phone" ? "スマホ(幅 390px)" : "パソコン(幅 1280px)");
  const list = files
    .map((d) => `- ${d.name}(${size(d)}、要件 ${d.requirements.join("・") || "—"}): 試作 \`${d.file}\`${refs.has(d.key) ? `・お手本の画像 \`${d.file.replace(/\.html$/, ".png")}\`` : ""}(画面の key: ${d.key})${d.note ? ` — ${d.note}` : ""}`)
    .join("\n");
  const how: Partial<Record<Role, string>> = {
    dev: `- 作った画面は、同じ幅でブラウザに開いてページ全体のスクリーンショットを撮り、作業場所に保存して compare_screen で Kuramoto に渡します。お手本との違いの割合と、違うところを色付けした画像が返ります。違いが大きいところを直してから報告します。
- 画面は、この試作とお手本の画像に合わせて作ります。並び・入っている要素・文言・色・余白・大きさを合わせます。デザインシステムのトークンと共通の部品で組み立てます。
- 試作は見た目の約束です。試作の HTML や CSS をそのまま貼り付ける必要はありません。
- 理由があって試作と違えたところは、PR の本文に「試作との違い」として、どこをなぜ変えたかを書きます。`,
    qa: `- 実装した画面を、同じ幅(${files.map(size).filter((x, i, a) => a.indexOf(x) === i).join("・")})でブラウザに開いてページ全体のスクリーンショットを撮り、作業場所に保存して compare_screen で Kuramoto に渡します。お手本との違いの割合と、違うところを色付けした画像(作業場所に置かれます)が返ります。画像を開いて、どこが違うかを確かめます。
- 違いの割合が ${Math.round(DIFF_WARN * 100)}% を超えるか、並び・入っている要素・文言・色・余白が試作と違えば、受け入れ条件の指摘にします。
- 並び・入っている要素・文言・色・余白が試作と違えば、受け入れ条件の指摘(basis: acceptance)にします。どこがどう違うかを具体的に書きます。PR の本文に理由が書かれている違いは、理由が通っていれば指摘にしません。
- 細かな 1〜2px のずれや、フォントの描画の違いは指摘にしません。`,
    review: `- 差分の画面のコードが、試作と食い違っていないか(要素の抜け・文言の違い・並びの違い)を見ます。食い違いは受け入れ条件の指摘(basis: acceptance)にします。PR の本文に理由が書かれている違いは除きます。`,
  };
  const text = how[role];
  if (!text) return "";
  return `\n\n## 画面のデザイン(企画スタジオで合意したもの)\n作業場所の \`${DESIGN_DIR}/\` に置きました(git には入りません)。${system}${ds}${list ? `\n### このチケットに関わる画面\n${list}\n` : ""}\n${text}`;
}

/** QA が指摘にする、違いの割合の目安。 */
export const DIFF_WARN = 0.1;

export function hasSystem(p: Project): DesignSystem | null {
  return designSystem(p);
}
