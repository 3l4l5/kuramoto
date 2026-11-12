import { get } from "../db/sqlite.js";
import type { Role } from "../domain/roles.js";
import { requirements, screens } from "./planning.js";
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
  const refs = JSON.parse(get<{ plan_refs: string }>(p.db, "SELECT plan_refs FROM tickets WHERE id = ?", [ticket.id])?.plan_refs || "{}") as { screens?: string[]; requirement?: string | null };
  const req = refs.requirement ?? requirements(p).find((r) => r.id === get<{ requirement_item_id: number | null }>(p.db, "SELECT requirement_item_id FROM tickets WHERE id = ?", [ticket.id])?.requirement_item_id)?.code;
  const linked = new Set(refs.screens ?? []);
  const out: DesignFile[] = [];
  for (const [key, s] of screens(p)) {
    if (!linked.has(key) && !(req && s.requirements.includes(req))) continue;
    const v = s.variants.find((x) => x.id === s.chosen) ?? s.variants[0];
    if (!v) continue;
    const safe = key.replace(/[^A-Za-z0-9_-]/g, "_");
    out.push({ key, name: s.name, device: s.device, file: `${DESIGN_DIR}/${safe}.html`, html: v.html, requirements: s.requirements, ...(v.note ? { note: v.note } : {}) });
  }
  return out;
}

/** 担当への指示に足す、デザインの節。役割ごとに、試作をどう使うかを書く。 */
export function designPrompt(files: DesignFile[], role: Role): string {
  if (!files.length) return "";
  const size = (d: DesignFile) => (d.device === "phone" ? "スマホ(幅 390px ほど)" : "パソコン(幅 1280px ほど)");
  const list = files.map((d) => `- ${d.name}(${size(d)}、要件 ${d.requirements.join("・") || "—"}): \`${d.file}\`${d.note ? ` — ${d.note}` : ""}`).join("\n");
  const how: Partial<Record<Role, string>> = {
    dev: `- 画面は、この試作に合わせて作ります。並び・入っている要素・文言・色・余白・大きさを合わせます。リポジトリに既にあるデザインの決まり(CSS 変数・共通の部品)があれば、それを使って試作の見た目を出します。
- 試作は見た目の約束です。試作の HTML や CSS をそのまま貼り付ける必要はありません。
- 作ったら、作った画面をブラウザで開いてスクリーンショットを撮り、試作(ファイルをブラウザで開く)と見比べてから報告します。
- 理由があって試作と違えたところは、PR の本文に「試作との違い」として、どこをなぜ変えたかを書きます。`,
    qa: `- 実装した画面と試作を、同じ大きさ(${files.map(size).filter((x, i, a) => a.indexOf(x) === i).join("・")})でブラウザに開いてスクリーンショットを撮り、見比べます。試作はファイルをそのまま開けます。
- 並び・入っている要素・文言・色・余白が試作と違えば、受け入れ条件の指摘(basis: acceptance)にします。どこがどう違うかを具体的に書きます。PR の本文に理由が書かれている違いは、理由が通っていれば指摘にしません。
- 細かな 1〜2px のずれや、フォントの描画の違いは指摘にしません。`,
    review: `- 差分の画面のコードが、試作と食い違っていないか(要素の抜け・文言の違い・並びの違い)を見ます。食い違いは受け入れ条件の指摘(basis: acceptance)にします。PR の本文に理由が書かれている違いは除きます。`,
  };
  const text = how[role];
  if (!text) return "";
  return `\n\n## 画面のデザイン(企画スタジオで合意した試作)\n作業場所に、このチケットに関わる画面の試作を置きました(git には入りません)。\n${list}\n\n${text}`;
}
