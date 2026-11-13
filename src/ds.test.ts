import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// デザインシステムの土台(ui/src/ds/)の約束を確かめる。
const read = (p: string) => readFileSync(new URL(`../ui/src/ds/${p}`, import.meta.url), "utf8");
const tokensCss = read("tokens.css");
const tokens = Object.fromEntries(
  [...tokensCss.matchAll(/^\s*(--[\w-]+):\s*([^;]+);/gm)].map((m) => [m[1]!, m[2]!.trim()]),
);

const hex = (v: string) => {
  const m = /^#([0-9a-f]{6})$/i.exec(v);
  if (!m) throw new Error(`色ではない: ${v}`);
  return [0, 2, 4].map((i) => parseInt(m[1]!.slice(i, i + 2), 16) / 255);
};
const luminance = (v: string) => {
  const [r, g, b] = hex(v).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
};
const contrast = (a: string, b: string) => {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x! + 0.05) / (y! + 0.05);
};

describe("トークン", () => {
  it("設計書のトークン表の変数がすべてある", () => {
    const required = [
      "--bg", "--surface", "--ink", "--muted", "--line", "--line-strong", "--floor-line", "--action", "--action-hover",
      "--dev", "--dev-hover", "--dev-soft", "--review", "--review-ink", "--review-soft", "--lead", "--lead-soft",
      "--design", "--design-soft", "--ok", "--ok-soft", "--warn", "--warn-ink", "--warn-soft",
      "--danger", "--danger-ink", "--danger-soft", "--focus",
      "--f-body", "--f-mono", "--fs-xs", "--fs-sm", "--fs-md", "--fs-base", "--fs-lg", "--fs-xl",
      "--fw-regular", "--fw-medium", "--fw-bold", "--lh-body", "--lh-tight",
      "--sp-1", "--sp-2", "--sp-3", "--sp-4", "--sp-5", "--r-sm", "--r-md", "--r-lg", "--r-pill",
      "--shadow", "--shadow-desk", "--h-control", "--h-control-sm", "--h-tab", "--h-chip", "--switch-w", "--switch-h", "--motion",
    ];
    for (const name of required) expect(tokens, name).toHaveProperty([name]);
    expect(Object.keys(tokens).some((n) => n.startsWith("--art-"))).toBe(true);
  });

  it("値は設計書のとおり(代表)", () => {
    expect(tokens["--action"]).toBe("#333333");
    expect(tokens["--dev"]).toBe("#0031d8");
    expect(tokens["--fs-md"]).toBe("13px");
    expect(tokens["--sp-5"]).toBe("24px");
    expect(tokens["--r-lg"]).toBe("12px");
    expect(tokens["--h-control"]).toBe("36px");
  });

  it("淡い地の上の字はコントラスト比 4.5 以上", () => {
    const pairs: [string, string][] = [
      ["--dev", "--dev-soft"], ["--review-ink", "--review-soft"], ["--warn-ink", "--warn-soft"],
      ["--danger-ink", "--danger-soft"], ["--ok", "--ok-soft"], ["--muted", "--bg"], ["--ink", "--surface"],
      ["--surface", "--action"], ["--ink", "--art-note"],
    ];
    for (const [fg, bg] of pairs) expect(contrast(tokens[fg]!, tokens[bg]!), `${fg} / ${bg}`).toBeGreaterThanOrEqual(4.5);
  });

  it("動きを減らす設定で絵の動きを止める", () => {
    expect(tokensCss).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*--motion: 0s[\s\S]*animation: none/);
  });
});

describe("部品", () => {
  const css = read("ds.css");
  const [ui, art] = css.split("---- 絵(art)");
  const sources = { "ds.css": css, "index.tsx": read("index.tsx"), "catalog.css": read("catalog.css") };

  it("直書きの色が無い", () => {
    for (const [file, src] of Object.entries(sources)) expect(src.match(/#[0-9a-f]{3,8}\b/gi), file).toBeNull();
  });

  it("文字の大きさ・角丸・余白はトークンの段だけ(絵の節を除く)", () => {
    expect(art).toBeDefined();
    const decls = [...ui!.matchAll(/(font-size|border-radius|padding|margin|gap)(?:-[a-z]+)?:\s*([^;}]+)/g)];
    expect(decls.length).toBeGreaterThan(20);
    for (const [all, , value] of decls) {
      const rest = value!.replace(/var\(--(fs|r|sp|h)-[\w-]+\)/g, "").replace(/\b(0|auto)\b/g, "").trim();
      expect(rest, all).toBe("");
    }
  });

  it("絵の節でも文字の大きさはトークンだけ", () => {
    for (const [all, value] of art!.matchAll(/font-size:\s*([^;}]+)/g)) expect(value, all).toMatch(/^var\(--fs-/);
  });
});

describe("オフィスの作業中のノート PC", () => {
  const style = readFileSync(new URL("../ui/src/style.css", import.meta.url), "utf8");
  const rules = [...style.matchAll(/^(\.officefloor \.of-working \.of-avatar \.of-laptop)\s*\{([^}]*)\}/gm)];

  it("規則は 1 つで、光の色は --art-laptop-on", () => {
    expect(rules).toHaveLength(1);
    const body = rules[0]![2]!;
    expect(body).toMatch(/fill:\s*var\(--art-laptop-on\)/);
    expect(body).toMatch(/drop-shadow\([^)]*var\(--art-laptop-on\)\)/);
    expect(body).not.toMatch(/--dev\b/);
  });
});
