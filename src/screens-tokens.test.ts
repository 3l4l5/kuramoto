import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// 既存の画面(style.css と各画面の TSX)が、デザインシステムのトークンだけで組まれていることを確かめる(R18)。
const uiDir = new URL("../ui/src/", import.meta.url).pathname;
const read = (p: string) => readFileSync(join(uiDir, p), "utf8");

/** ui/src の下の画面のソース。トークンの定義(ds/tokens.css)・トークンを並べて見せるカタログ・公式の部品を写した dads/ は除く。 */
function sources(dir = ""): string[] {
  return readdirSync(join(uiDir, dir), { withFileTypes: true }).flatMap((e) => {
    const rel = join(dir, e.name);
    if (e.isDirectory()) return e.name === "dads" ? [] : sources(rel);
    return /\.(tsx?|css)$/.test(e.name) && ![join("ds", "tokens.css"), join("ds", "Catalog.tsx")].includes(rel) ? [rel] : [];
  });
}
const files = sources();
const style = read("style.css");
const tokensCss = read("ds/tokens.css");

describe("既存の画面をトークンにそろえる", () => {
  it("直書きの色(#xxxxxx・rgb())が画面のソースに残らない。絵の色は tokens.css の --art-* にある", () => {
    for (const f of files) {
      const src = read(f);
      expect(src.match(/#[0-9a-f]{3,8}\b/gi), f).toBeNull();
      expect(src.match(/\brgba?\(/g), f).toBeNull();
    }
    expect(tokensCss).toMatch(/--art-wood:/);
    expect(tokensCss).toMatch(/--art-hair-seina:/);
  });

  it("文字の大きさは 11/12/13/14/16/22px の段(--fs-*)だけ", () => {
    for (const f of files) {
      const src = read(f);
      for (const [all, v] of src.matchAll(/font-size:\s*([^;}]+)/g)) expect(v!.trim(), `${f}: ${all}`).toMatch(/^var\(--fs-(xs|sm|md|base|lg|xl)\)$/);
      for (const [all, v] of src.matchAll(/\bfontSize[:=]\s*\{?\s*([^,}\s]+)/g)) expect(v, `${f}: ${all}`).toMatch(/^"var\(--fs-(xs|sm|md|base|lg|xl)\)"$/);
    }
    for (const [n, px] of [["xs", 11], ["sm", 12], ["md", 13], ["base", 14], ["lg", 16], ["xl", 22]] as const) expect(tokensCss).toContain(`--fs-${n}: ${px}px;`);
  });

  it("角丸は 6/8/12px かピル(--r-*)だけ。4・7・10・14px などの半端な値は無い", () => {
    for (const f of files) {
      const src = read(f);
      for (const [all, v] of src.matchAll(/border-radius:\s*([^;}]+)/g)) {
        for (const t of v!.trim().split(/\s+/)) expect(t, `${f}: ${all}`).toMatch(/^(0|50%|var\(--r-(sm|md|lg|pill)\))$/);
      }
      for (const [all, v] of src.matchAll(/\bborderRadius:\s*([^,}]+)/g)) expect(v!.trim(), `${f}: ${all}`).toMatch(/^"var\(--r-(sm|md|lg|pill)\)"$/);
    }
    for (const [all, v] of read("studio/diagrams.tsx").matchAll(/\brx=\{(\d+)\}/g)) expect(["6", "8", "12"], all).toContain(v);
    for (const [n, px] of [["sm", 6], ["md", 8], ["lg", 12]] as const) expect(tokensCss).toContain(`--r-${n}: ${px}px;`);
  });

  it("style.css は役割名の変数を決めず(出どころは tokens.css だけ)、デジタル庁の変数(--color-*)も参照しない", () => {
    const rootBlocks = [...style.matchAll(/:root\s*\{([^}]*)\}/g)].map((m) => m[1]!.trim());
    expect(rootBlocks).toEqual(["color-scheme: light;"]);
    expect(style).not.toMatch(/--color-/);
    expect(style).not.toMatch(/var\(--(floor|table|table-edge|laptop|route|f-display)\)/);
  });

  it("どこにも定義が無く、使う要素も無かった .laptop / --glow の規則は消えている(作業中の光は .of-laptop が --art-laptop-on で出す)", () => {
    expect(style).not.toMatch(/--glow/);
    expect(style).not.toMatch(/(^|\n)\.laptop\b/);
    for (const f of files) expect(read(f), f).not.toMatch(/--glow|["'`]laptop["'`]/);
    expect(style).toMatch(/\.of-working \.of-avatar \.of-laptop \{ fill: var\(--art-laptop-on\)/);
  });

  it("ピルだった要素は --r-pill のまま。アーキテクトの服は開発の青と別の色", () => {
    for (const sel of [".pill", ".inbox .cnt", ".eff", ".proj .state", ".sectabs .cnt"]) {
      expect(style, sel).toMatch(new RegExp(`\\n${sel.replace(".", "\\.")} \\{[^}]*border-radius: var\\(--r-pill\\)`));
    }
    expect(style).toMatch(/of-r-arch \.of-body \{ fill: var\(--art-role-arch\)/);
    expect(tokensCss).toMatch(/--art-role-arch: #008da6/);
  });

  it("主ボタンは --action、青(--dev)は地に使わない", () => {
    const ui = read("ui.tsx");
    expect(ui).toMatch(/"solid-fill": "primary"/);
    expect(read("ds/ds.css")).toMatch(/\.ds-btn--primary \{ background: var\(--action\)/);
    expect(style).toMatch(/\.gate\.hand \{[^}]*background: var\(--action\)/);
    expect(style).toMatch(/\.ask \.acts button\.primary \{ background: var\(--action\)/);
  });
});
