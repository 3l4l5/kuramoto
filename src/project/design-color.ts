import { PNG } from "pngjs";

/**
 * 画面の見比べの「色の差分」(#95)。
 * 形の差分(pixelmatch・threshold 0.1)は色の小さなずれを同じとみなすので、別に、画素ごとの色の差(ΔE)を測る。
 * ΔE は CIE76(sRGB → D65 の CIELAB 上の距離)。目で分かる最小の差(JND)の目安は 2.3(この目安は CIE76 の値)。
 * CIEDE2000 でなく CIE76 にしたのは、2.3 の目安がそのまま使え(CIEDE2000 では同じ見え方の差が小さく出て、#FFFFFF と #F5F5F5 でも約 2.0 になり、目安が ~1 になる)、
 * 背景 #FFFFFF と #F5F5F5 のような、無彩色のずれがはっきり出るため。彩度の高い色では実際より大きめに出る。
 */

/** 目で分かる差の目安(CIE76 の JND)。これを超える画素を「色が違う」と数える。 */
export const DELTA_E_NOTICEABLE = 2.3;

type Lab = [number, number, number];

function srgbToLinear(v: number): number {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** sRGB(0〜255)→ CIELAB(D65)。 */
export function rgbToLab(r: number, g: number, b: number): Lab {
  const lr = srgbToLinear(r);
  const lg = srgbToLinear(g);
  const lb = srgbToLinear(b);
  const x = (0.4124564 * lr + 0.3575761 * lg + 0.1804375 * lb) / 0.95047;
  const y = 0.2126729 * lr + 0.7151522 * lg + 0.072175 * lb;
  const z = (0.0176339 * lr + 0.1191920 * lg + 0.9503041 * lb) / 1.08883;
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  const fx = f(x);
  const fy = f(y);
  const fz = f(z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** CIE76 の色差(CIELAB 上のユークリッド距離)。 */
export function deltaE76(l1: Lab, l2: Lab): number {
  return Math.hypot(l1[0] - l2[0], l1[1] - l2[1], l1[2] - l2[2]);
}

/** 2 つの色(0xRRGGBB)の ΔE。 */
export function colorDistance(a: number, b: number): number {
  return deltaE76(labOf(a), labOf(b));
}

// ---- 色の変換の覚え(同じ色は何度も計算しない) ----
const labCache = new Map<number, Lab>();
function labOf(rgb: number): Lab {
  let lab = labCache.get(rgb);
  if (!lab) {
    lab = rgbToLab((rgb >> 16) & 255, (rgb >> 8) & 255, rgb & 255);
    if (labCache.size > 400_000) labCache.clear();
    labCache.set(rgb, lab);
  }
  return lab;
}

const hex = (rgb: number) => `#${rgb.toString(16).padStart(6, "0").toUpperCase()}`;

/** "#RGB"・"#RRGGBB" を 0xRRGGBB に。読めなければ null。 */
export function parseHex(value: string): number | null {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value.trim());
  if (!m) return null;
  const h = m[1]!.length === 3 ? [...m[1]!].map((c) => c + c).join("") : m[1]!;
  return parseInt(h, 16);
}

export type ColorToken = { name: string; value: string };
export type TokenMatch = { name: string; value: string; deltaE: number };

export type PaletteColor = {
  hex: string;
  /** 画面に占める割合(0〜1) */
  share: number;
  /** 近いデザインシステムのトークン(色のトークンのうち、ΔE が目安以内で最も近いもの) */
  token: TokenMatch | null;
};

export type ColorComparison = {
  /** 色の差の測り方 */
  method: "CIE76";
  /** 色が違う(ΔE > threshold)とみなす境 */
  threshold: number;
  /** ΔE > threshold の画素の割合(0〜1)。重なる範囲で数える */
  ratio: number;
  meanDeltaE: number;
  maxDeltaE: number;
  /** お手本の主な色(多い順) */
  referenceColors: PaletteColor[];
  /** 実装の主な色(多い順) */
  actualColors: PaletteColor[];
  /** お手本の主な色のうち、実装に近い色が無いもの */
  referenceOnly: PaletteColor[];
  /** 実装の主な色のうち、お手本に近い色が無いもの */
  actualOnly: PaletteColor[];
};

/** 色の差分を重ねた画像(違う画素だけ、差の大きさで色付け。残りは薄く)。 */
export type ColorDiff = { stats: ColorComparison; image: Buffer };

/** 主な色として数える上限と、ここに満たない色は「主な色」に入れない割合。 */
const TOP_COLORS = 8;
const MIN_SHARE = 0.002;
/** 色を数える画素の数の上限(大きな画面は間引いて数える。差の測定は全画素)。 */
const PALETTE_SAMPLE = 1_500_000;

type RGBA = { data: Buffer | Uint8Array };

function packAt(data: Buffer | Uint8Array, i: number): number {
  const a = data[i + 3]! / 255;
  // 透ける画素は白の上に重ねたものとして見る
  const mix = (v: number) => Math.round(v * a + 255 * (1 - a));
  return (mix(data[i]!) << 16) | (mix(data[i + 1]!) << 8) | mix(data[i + 2]!);
}

/** 色を数えて、ΔE が目安以内の色を 1 つにまとめたパレット(多い順)。 */
function palette(img: RGBA, w: number, h: number): { colors: { rgb: number; share: number }[] } {
  const total = w * h;
  const step = Math.max(1, Math.ceil(total / PALETTE_SAMPLE));
  const hist = new Map<number, number>();
  let n = 0;
  for (let px = 0; px < total; px += step) {
    const c = packAt(img.data, px * 4);
    hist.set(c, (hist.get(c) ?? 0) + 1);
    n++;
  }
  // 多い色から、近い色(ΔE が目安以内)を先にできた色にまとめる。文字の縁などの細かな色で、主な色が分かれないようにする
  const sorted = [...hist.entries()].sort((x, y) => y[1] - x[1]).slice(0, 1500);
  const clusters: { rgb: number; count: number }[] = [];
  for (const [rgb, count] of sorted) {
    const hit = clusters.find((c) => colorDistance(c.rgb, rgb) <= DELTA_E_NOTICEABLE);
    if (hit) hit.count += count;
    else clusters.push({ rgb, count });
  }
  return { colors: clusters.sort((x, y) => y.count - x.count).map((c) => ({ rgb: c.rgb, share: n ? c.count / n : 0 })) };
}

/** 色のトークンのうち、いちばん近いもの(ΔE が maxDeltaE 以内のときだけ)。 */
function nearestToken(rgb: number, tokens: { name: string; value: string; rgb: number }[], maxDeltaE: number): TokenMatch | null {
  let best: TokenMatch | null = null;
  for (const t of tokens) {
    const d = colorDistance(rgb, t.rgb);
    if (d <= maxDeltaE && (!best || d < best.deltaE)) best = { name: t.name, value: t.value, deltaE: Math.round(d * 100) / 100 };
  }
  return best;
}

/** トークンに「近い」とみなす ΔE。これ以内なら、トークン名を添える。 */
export const TOKEN_NEAR_DELTA_E = 6;

/** 差の大きさで塗る色(目で分かる程度 = 黄 → はっきり = 橙 → 大きい = 赤紫)。 */
function tint(d: number): [number, number, number] {
  if (d < 5) return [255, 214, 0];
  if (d < 12) return [255, 128, 0];
  return [214, 0, 140];
}

/**
 * 2 枚の画像(同じ大きさの RGBA)の色の差分を測る。形の差分は pixelmatch が見るので、ここは画素ごとの色の差だけ。
 * 大きさが違うときは、呼ぶ側が重なる範囲に切ってから渡す。
 */
export function compareColors(a: { data: Buffer | Uint8Array; width: number; height: number }, b: { data: Buffer | Uint8Array; width: number; height: number }, w: number, h: number, tokens: ColorToken[] = []): ColorDiff {
  const out = new PNG({ width: w, height: h });
  const total = w * h;
  const pairCache = new Map<number, number>();
  let over = 0;
  let sum = 0;
  let max = 0;
  for (let px = 0; px < total; px++) {
    const i = px * 4;
    const ca = packAt(a.data, i);
    const cb = packAt(b.data, i);
    let d = 0;
    if (ca !== cb) {
      const key = ca * 16_777_216 + cb;
      const known = pairCache.get(key);
      if (known === undefined) {
        d = colorDistance(ca, cb);
        if (pairCache.size > 400_000) pairCache.clear();
        pairCache.set(key, d);
      } else d = known;
    }
    sum += d;
    if (d > max) max = d;
    if (d > DELTA_E_NOTICEABLE) {
      over++;
      const [r, g, bl] = tint(d);
      out.data[i] = r;
      out.data[i + 1] = g;
      out.data[i + 2] = bl;
    } else {
      // 違わない所は、お手本を薄く(白に 80% 寄せて)見せて、どこの色が違うかの位置が分かるようにする
      out.data[i] = Math.round((ca >> 16) * 0.2 + 255 * 0.8);
      out.data[i + 1] = Math.round(((ca >> 8) & 255) * 0.2 + 255 * 0.8);
      out.data[i + 2] = Math.round((ca & 255) * 0.2 + 255 * 0.8);
    }
    out.data[i + 3] = 255;
  }

  const tokenColors = tokens.flatMap((t) => {
    const rgb = parseHex(t.value);
    return rgb === null ? [] : [{ name: t.name, value: t.value, rgb }];
  });
  const named = (c: { rgb: number; share: number }): PaletteColor => ({ hex: hex(c.rgb), share: round(c.share, 4), token: nearestToken(c.rgb, tokenColors, TOKEN_NEAR_DELTA_E) });
  const pa = palette(a, w, h).colors.filter((c) => c.share >= MIN_SHARE);
  const pb = palette(b, w, h).colors.filter((c) => c.share >= MIN_SHARE);
  const onlyIn = (from: typeof pa, other: typeof pa) => from.slice(0, TOP_COLORS).filter((c) => !other.some((o) => colorDistance(c.rgb, o.rgb) <= DELTA_E_NOTICEABLE));

  return {
    image: PNG.sync.write(out),
    stats: {
      method: "CIE76",
      threshold: DELTA_E_NOTICEABLE,
      ratio: total ? over / total : 0,
      meanDeltaE: total ? round(sum / total, 3) : 0,
      maxDeltaE: round(max, 2),
      referenceColors: pa.slice(0, TOP_COLORS).map(named),
      actualColors: pb.slice(0, TOP_COLORS).map(named),
      referenceOnly: onlyIn(pa, pb).map(named),
      actualOnly: onlyIn(pb, pa).map(named),
    },
  };
}

function round(v: number, digits: number): number {
  const m = 10 ** digits;
  return Math.round(v * m) / m;
}

/** 担当・レビューする人に返す、色の差分の説明(数行)。 */
export function describeColorComparison(c: ColorComparison, diffFile: string): string {
  const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
  const show = (x: PaletteColor) => `${x.hex}(${pct(x.share)}${x.token ? `・トークン ${x.token.name} ${x.token.value}${x.token.deltaE > 0.5 ? ` に近いが少し違う(ΔE ${x.token.deltaE})` : " と同じ"}` : ""})`;
  const lines = [
    `色の差分(${c.method}・ΔE > ${c.threshold} を「色が違う」とする): 違う画素 ${(c.ratio * 100).toFixed(2)}%・平均 ΔE ${c.meanDeltaE}・最大 ΔE ${c.maxDeltaE}。形の差分とは別に見ます(背景が #FFFFFF か #F5F5F5 か、といった色のずれは、形の差分には出ません)。`,
    `色の差分の画像(違う画素を黄→橙→赤紫で塗る。違うほど濃い色): ${diffFile}`,
    `お手本の主な色: ${c.referenceColors.map(show).join("、") || "—"}`,
    `実装の主な色: ${c.actualColors.map(show).join("、") || "—"}`,
  ];
  if (c.referenceOnly.length) lines.push(`お手本にあって実装に無い色: ${c.referenceOnly.map(show).join("、")}`);
  if (c.actualOnly.length) lines.push(`実装にだけある色: ${c.actualOnly.map(show).join("、")}`);
  if (c.referenceOnly.length || c.actualOnly.length) lines.push("色が違うところは、デザインシステムのトークンの色に合わせてください。");
  return lines.join("\n");
}
