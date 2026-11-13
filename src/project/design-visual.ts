import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";
import { inScope } from "../db/count.js";
import type { Project } from "./project.js";

/**
 * 画面を画像で見比べる(ADR-0034)。
 * - 合意した試作を、実際の端末の幅でブラウザに描いて「お手本」の画像にする
 * - 担当が撮った実装のスクリーンショットとお手本を比べ、違う画素の割合と、違うところを色付けした画像を作る
 * 画像は DesignStore に置き(既定はデータの置き場所のファイル。S3 などに替えられる)、DB には置き場所だけを残す。
 */

/** 画像の置き場所。既定はファイル。S3(FastFS など)に替えるときは、これを実装する。 */
export interface DesignStore {
  put(key: string, data: Buffer): Promise<void>;
  get(key: string): Promise<Buffer | null>;
}

export class FileDesignStore implements DesignStore {
  constructor(private readonly dir: string) {}
  async put(key: string, data: Buffer): Promise<void> {
    const to = join(this.dir, key);
    mkdirSync(dirname(to), { recursive: true });
    writeFileSync(to, data);
  }
  async get(key: string): Promise<Buffer | null> {
    const from = join(this.dir, key);
    return existsSync(from) ? readFileSync(from) : null;
  }
}

/** HTML を、決まった幅のブラウザで描いた画像(ページ全体)。 */
export type Renderer = (html: string, width: number) => Promise<Buffer>;

export const DEVICE_WIDTH = { phone: 390, desktop: 1280 } as const;
const DEVICE_HEIGHT = { phone: 844, desktop: 800 } as const;

type Page = import("@playwright/test").Page;

/** この機械の中への通信か(ページが読みに行ってよい先)。 */
function allowedRequest(raw: string): boolean {
  return raw.startsWith("data:") || raw.startsWith("blob:") || raw === "about:blank" || renderableUrl(raw);
}

/**
 * ブラウザを開き、決まった幅でページ全体を撮る。手元の Chrome(無ければ Playwright の Chromium)を使う。
 * local のときは、ページの通信をこの機械の中(と data:・blob:)だけにする。担当が書いた HTML や、担当が動かしたアプリは、
 * サンドボックスの外のサーバのブラウザで動くので、外へ送らせない。
 * - 要求(http・https)は page.route で、WebSocket は routeWebSocket で、外の宛先を止める
 * - ブラウザ自体にも、届かないプロキシを指定する(ループバックだけがプロキシを通らず届く)。止め漏れがあっても外へは出ない
 */
async function shoot(width: number, open: (page: Page) => Promise<void>, local = false): Promise<Buffer> {
  const { chromium } = await import("@playwright/test");
  const options = local ? { proxy: { server: "http://127.0.0.1:9" } } : {};
  const browser = await chromium.launch({ channel: "chrome", ...options }).catch(() => chromium.launch(options));
  try {
    const context = await browser.newContext({ viewport: { width, height: width === DEVICE_WIDTH.phone ? DEVICE_HEIGHT.phone : DEVICE_HEIGHT.desktop }, deviceScaleFactor: 1 });
    if (local) {
      await context.route("**/*", (route) => (allowedRequest(route.request().url()) ? route.continue() : route.abort()));
      await context.routeWebSocket(/.*/, (ws) => {
        if (renderableUrl(ws.url().replace(/^ws/, "http"))) ws.connectToServer();
        else void ws.close();
      });
    }
    const page = await context.newPage();
    await open(page);
    return await page.screenshot({ fullPage: true });
  } finally {
    await browser.close();
  }
}

/** 手元の Chrome(無ければ Playwright の Chromium)で描く。お手本の画像用。外のフォントなども読む。 */
export const playwrightRenderer: Renderer = (html, width) => shoot(width, (page) => page.setContent(html, { waitUntil: "load" }));

/** 担当が書いた HTML を描く。ページの通信はこの機械の中だけ(render_page 用)。 */
export const playwrightLocalHtmlRenderer: Renderer = (html, width) => shoot(width, (page) => page.setContent(html, { waitUntil: "load" }), true);

/** URL を、決まった幅のブラウザで描いた画像(ページ全体)。担当の作業場所では描けないので、サーバの側で描く(ADR-0034)。 */
export type UrlRenderer = (url: string, width: number) => Promise<Buffer>;

/** 描いてよい URL(http か https で、この機械の中。担当の作業場所で動かした開発サーバーだけを想定する)。 */
export function isLocalUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  return (u.protocol === "http:" || u.protocol === "https:") && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
}

/** URL のポート(省略なら既定のポート)。 */
export function portOf(raw: string): number {
  const u = new URL(raw);
  return Number(u.port || (u.protocol === "https:" ? 443 : 80));
}

/**
 * ローカルの URL を描く。ページの通信もこの機械の中だけにする(外へは出さない)。
 * 画面が落ち着く(通信が止まる)まで少し待つ。待ちきれなくても、その時点の画面を撮る。
 */
export const playwrightUrlRenderer: UrlRenderer = (url, width) =>
  shoot(
    width,
    async (page) => {
      await page.goto(url, { waitUntil: "load", timeout: 30_000 });
      await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => undefined);
    },
    true,
  );

/**
 * 描かせないポート。Kuramoto 自身のポートを入れる(ローカルからは合言葉なしで入れるので、別のプロジェクトの中身まで画像で読めてしまう)。
 * URL の描画でも、描いている間のページの通信でも、ここに入れたポートへは行かない。
 */
const blockedPorts = new Set<number>();
export function blockRenderPort(port: number): void {
  blockedPorts.add(port);
}

/** 描いてよい URL か(この機械の中で、描かせないポートでない)。 */
export function renderableUrl(raw: string): boolean {
  return isLocalUrl(raw) && !blockedPorts.has(portOf(raw));
}

export type DesignImage = { id: number; ticket_id: number | null; screen_key: string; kind: "reference" | "actual" | "diff"; store_key: string; width: number; height: number; diff_ratio: number | null; created_at: string };

function size(png: Buffer): { width: number; height: number } {
  const p = PNG.sync.read(png);
  return { width: p.width, height: p.height };
}

async function record(p: Project, r: Omit<DesignImage, "id" | "created_at">): Promise<number> {
  return p.pdb.dialect.insertedId(p.pdb.insert("design_images", { ticket_id: r.ticket_id, screen_key: r.screen_key, kind: r.kind, store_key: r.store_key, width: r.width, height: r.height, diff_ratio: r.diff_ratio, created_at: p.now() }));
}

/** 試作のお手本の画像。同じ試作(HTML と端末)なら、前に描いたものを使う。 */
export async function referenceImage(p: Project, store: DesignStore, render: Renderer, s: { key: string; html: string; device: "phone" | "desktop" }): Promise<{ id: number; png: Buffer } | null> {
  const hash = createHash("sha1").update(`${s.device}|${s.html}`).digest("hex").slice(0, 12);
  const key = `reference/${s.key}-${hash}.png`;
  const known = await inScope(p.pdb, "design_images").where("kind", "=", "reference").where("store_key", "=", key).executeTakeFirst();
  const cached = await store.get(key);
  if (known && cached) return { id: known.id, png: cached };
  let png: Buffer;
  try {
    png = await render(s.html, DEVICE_WIDTH[s.device]);
  } catch (e) {
    await p.event("system", "design_render_failed", null, { screen: s.key, error: (e instanceof Error ? e.message : String(e)).slice(0, 300) });
    return null;
  }
  await store.put(key, png);
  const id = known?.id ?? (await record(p, { ticket_id: null, screen_key: s.key, kind: "reference", store_key: key, ...size(png), diff_ratio: null }));
  return { id, png };
}

export type Comparison = {
  /** 違う画素の割合(0〜1)。重なる範囲で数える */
  ratio: number;
  /** 大きさの違い(幅・高さ)の注意。同じなら空 */
  sizeNote: string;
  diff: Buffer;
};

/** 2 枚の画像を比べる。大きさが違えば、重なる範囲(左上から)で比べ、大きさの違いも知らせる。 */
export function compareImages(reference: Buffer, actual: Buffer): Comparison {
  const a = PNG.sync.read(reference);
  const b = PNG.sync.read(actual);
  const w = Math.min(a.width, b.width);
  const h = Math.min(a.height, b.height);
  const crop = (img: PNG) => {
    if (img.width === w && img.height === h) return img.data;
    const out = Buffer.alloc(w * h * 4);
    for (let y = 0; y < h; y++) img.data.copy(out, y * w * 4, y * img.width * 4, y * img.width * 4 + w * 4);
    return out;
  };
  const diff = new PNG({ width: w, height: h });
  const n = pixelmatch(crop(a), crop(b), diff.data, w, h, { threshold: 0.1, includeAA: false });
  const notes: string[] = [];
  if (a.width !== b.width) notes.push(`幅が違います(お手本 ${a.width}px・実装 ${b.width}px)。同じ幅で撮り直してください`);
  if (Math.abs(a.height - b.height) > Math.max(a.height, b.height) * 0.1) notes.push(`高さが大きく違います(お手本 ${a.height}px・実装 ${b.height}px)。要素の抜けや余白の違いを確かめてください`);
  return { ratio: w * h ? n / (w * h) : 1, sizeNote: notes.join("。"), diff: PNG.sync.write(diff) };
}

/** 実装のスクリーンショットを受け取り、お手本と比べて残す。 */
export async function recordComparison(
  p: Project,
  store: DesignStore,
  a: { ticketId: number; screenKey: string; reference: { id: number; png: Buffer }; actual: Buffer },
): Promise<Comparison & { actualId: number; diffId: number }> {
  const c = compareImages(a.reference.png, a.actual);
  const stamp = p.now().replace(/[:.]/g, "-");
  const actualKey = `tickets/${a.ticketId}/${a.screenKey}-${stamp}-actual.png`;
  const diffKey = `tickets/${a.ticketId}/${a.screenKey}-${stamp}-diff.png`;
  await store.put(actualKey, a.actual);
  await store.put(diffKey, c.diff);
  const actualId = await record(p, { ticket_id: a.ticketId, screen_key: a.screenKey, kind: "actual", store_key: actualKey, ...size(a.actual), diff_ratio: c.ratio });
  const diffId = await record(p, { ticket_id: a.ticketId, screen_key: a.screenKey, kind: "diff", store_key: diffKey, ...size(c.diff), diff_ratio: c.ratio });
  await p.event("system", "design_compared", a.ticketId, { screen: a.screenKey, ratio: c.ratio, reference: a.reference.id, actual: actualId, diff: diffId });
  return { ...c, actualId, diffId };
}

/** チケットの画面ごとの、最新の見比べ(お手本・実装・違い)。 */
export async function latestComparisons(p: Project, ticketId: number): Promise<{ screen: string; ratio: number; at: string; reference: number | null; actual: number; diff: number }[]> {
  // 画像と、見比べたときの出来事を、それぞれ 1 文で取って突き合わせる
  const [images, events] = await Promise.all([
    inScope(p.pdb, "design_images").where("ticket_id", "=", ticketId).where("kind", "=", "actual").orderBy("id", "desc").execute(),
    inScope(p.pdb, "events").where("ticket_id", "=", ticketId).where("type", "=", "design_compared").orderBy("id").execute(),
  ]);
  const dataOf = new Map<number, string>();
  for (const e of events) {
    const actual = (JSON.parse(e.data || "{}") as { actual?: number }).actual;
    if (actual !== undefined && !dataOf.has(actual)) dataOf.set(actual, e.data);
  }
  const rows = images.map((d) => ({ screen_key: d.screen_key, diff_ratio: d.diff_ratio as number, created_at: d.created_at, data: dataOf.get(d.id) ?? "" }));
  const seen = new Set<string>();
  const out: { screen: string; ratio: number; at: string; reference: number | null; actual: number; diff: number }[] = [];
  for (const r of rows) {
    if (seen.has(r.screen_key) || !r.data) continue;
    seen.add(r.screen_key);
    const d = JSON.parse(r.data) as { reference: number; actual: number; diff: number };
    out.push({ screen: r.screen_key, ratio: r.diff_ratio, at: r.created_at, reference: d.reference ?? null, actual: d.actual, diff: d.diff });
  }
  return out;
}

export async function imageRow(p: Project, id: number): Promise<DesignImage | undefined> {
  return (await inScope(p.pdb, "design_images").where("id", "=", id).executeTakeFirst()) as DesignImage | undefined;
}
