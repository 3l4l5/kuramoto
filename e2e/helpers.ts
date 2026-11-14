import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";

/**
 * E2E の共通の道具。どのテストも、ここの「プロジェクトを作る」「画面の幅」「引き出し・下のタブの場所」を使う
 * (同じ手順を spec ごとに書き写さない)。足し方は docs/e2e.md。
 * 場所の指定は、見た目のクラス名ではなく role と名前(ボタンの字・aria-label)で書く。作りが変わっても壊れにくくするため。
 */

/** パソコンとスマホの幅(#93)。 */
export const PC = { width: 1280, height: 800 };
export const PHONE = { width: 390, height: 844 };

/** 書き込みの API に付ける印(ブラウザ以外からの書き込みを断る仕組みの通り道)。 */
export const WRITE = { "x-kuramoto": "1" };

/** 本部からプロジェクトを作り、企画スタジオが開くまで進む。 */
export async function createProject(page: Page, name: string, repo: string) {
  await page.goto("/#/");
  await page.getByRole("button", { name: "+ プロジェクトを作る" }).click();
  await page.getByLabel("名前").fill(name);
  await page.getByLabel("リポジトリ 1").fill(repo);
  await page.getByRole("button", { name: "次へ: 企画スタジオ" }).click();
  await expect(page.getByText(`${name} · 企画スタジオ`)).toBeVisible();
}

/**
 * 企画スタジオのチャットで、担当に「直してほしい・相談する」を送る(中身に反映してもらう)。
 * 送り方の既定は「質問する(中身は変えない)」で、送るボタンの名前も「質問する」になる(10569ca)。企画の中身を書かせたいときは、送り方を切り替えてから送る。
 */
export async function sendToPlanner(page: Page, text: string) {
  await page.getByRole("radiogroup", { name: "送り方" }).getByRole("radio", { name: "直してほしい・相談する" }).check();
  await page.getByLabel("メッセージ").fill(text);
  await page.getByRole("button", { name: "送る", exact: true }).click();
}

/**
 * 設計書(Markdown)のエクスポートのリンクが、ダウンロードの印(download)つきで、名前と中身の正しいファイルを返すことを確かめて、名前と中身を返す。
 * ブラウザの「ダウンロード」の動き(ファイルに書く)は通さず、リンクの宛先を page.request(Authorization つき)で取る。
 * 理由: 閉じ込めの中のブラウザは、ダウンロードのファイルを書くときに、書ける場所の外(ユーザーの一時ディレクトリ /private/var/folders/…/T/.org.chromium.Chromium.*)へ
 * 書こうとして sandbox に断られ、ダウンロードが canceled で失敗する(run 43609097616)。この許可は足さない(閉じ込めを広げない)。
 */
export async function fetchExport(page: Page, name: string): Promise<{ filename: string; body: Buffer }> {
  const link = page.getByRole("link", { name: "設計書をエクスポート(Markdown)" });
  expect(await link.evaluate((a) => a.hasAttribute("download")), "リンクに download の印がある").toBe(true);
  const res = await page.request.get((await link.getAttribute("href"))!);
  expect(res.status()).toBe(200);
  const disposition = res.headers()["content-disposition"] ?? "";
  expect(disposition).toMatch(/^attachment;/);
  const m = /filename\*=UTF-8''([^;]+)/.exec(disposition);
  const filename = m ? decodeURIComponent(m[1]!) : "";
  expect(filename).toBe(`${name}-設計書.md`);
  return { filename, body: await res.body() };
}

/**
 * 長いテストの手順(test.step)を、始まった時刻(テストの始めからの秒)つきで標準出力に残す。確かめの CI(閉じ込めの中のブラウザ)で、
 * 90 秒の時間切れが「止まった手順があった」のか「全体が遅かった」のかを、ログから見分けるため(scripts/ci-confinement-lib.sh が [e2e-time] の行を注釈に出す)。
 */
export function timedSteps() {
  const t0 = Date.now();
  return <T>(title: string, body: () => Promise<T>) => {
    console.log(`[e2e-time] ${Math.round((Date.now() - t0) / 1000)}s ▶ ${title.slice(0, 24)}`);
    return test.step(title, body);
  };
}

/** いま開いているプロジェクトの番号(アドレスの #/p/<番号> から)。 */
export function projectId(page: Page): string {
  const m = page.url().match(/#\/p\/(\d+)/);
  if (!m) throw new Error(`プロジェクトの画面ではありません: ${page.url()}`);
  return m[1]!;
}

/**
 * バグ修正は「QA → 開発」の流れ(ほかは既定の流れ)にして、バグ修正 1 件と機能 1 件のチケットを API で作る。
 * ボードの種類の絞り込み・チケットの詳細の入口を確かめるためのデータ。
 */
export async function seedKindTickets(page: Page, id: string) {
  const f = await page.request.post(`/api/projects/${id}/formation`, {
    headers: WRITE,
    data: { pull: "down", units: [{ name: "開発", roles: ["dev"], maxMembers: 2, summonAt: 2, idleSec: 300 }, { name: "QA", roles: ["qa"], maxMembers: 2, summonAt: 2, idleSec: 300 }], flows: { bugfix: ["qa", "dev"] } },
  });
  expect(f.ok()).toBe(true);
  expect((await page.request.post(`/api/projects/${id}/tickets`, { headers: WRITE, data: { title: "落ちるのを直す", kind: "bugfix" } })).ok()).toBe(true);
  expect((await page.request.post(`/api/projects/${id}/tickets`, { headers: WRITE, data: { title: "新しい画面を足す" } })).ok()).toBe(true);
}

/** E2E_SHOTS にフォルダを指定したときだけ、見た目の確認用にスクリーンショットを撮る。 */
export async function shot(page: Page, name: string) {
  if (!process.env.E2E_SHOTS) return;
  mkdirSync(process.env.E2E_SHOTS, { recursive: true });
  await page.screenshot({ path: join(process.env.E2E_SHOTS, `${name}.png`), fullPage: true });
}

// ---- 場所(パソコン) ----

/**
 * 共通ヘッダーの行き先の切り替えスイッチ(#88)。「オフィス / ボード / ツリー」と「企画スタジオ / 生産性 / 設定」が、どの画面でも同じ形で並ぶ。
 * 選ばれている行き先は、見方は aria-pressed、いまの画面は aria-current="page"。
 */
export const screens = (page: Page) => page.getByRole("group", { name: "プロジェクトの画面" });
/** そのうちの「オフィス / ボード / ツリー」(見方)。スマホの幅では共通ヘッダーが隠れるので、パソコン用。 */
export const views = (page: Page) => screens(page).getByRole("group", { name: "オフィスの見方" });
/** 共通ヘッダーの「編成 / チームの方針 / リーダーと話す」(オフィスとチケットの画面にだけ出る)。 */
export const headerDrawer = (page: Page, name: "編成" | "チームの方針" | "リーダーと話す") => page.getByRole("button", { name, exact: true });

// ---- 場所(スマホ) ----

/** 下のタブ「対応 / オフィス / リーダー / メニュー」。 */
export const phoneTabs = (page: Page) => page.getByRole("navigation", { name: "スマホの下のタブ" });
/** メニューのシートを開いて、行き先を押す(本部・企画スタジオ・ボード・ツリー・編成・チームの方針・生産性・設定)。 */
export async function phoneMenu(page: Page, name: string) {
  await phoneTabs(page).getByRole("button", { name: "メニュー" }).click();
  await page.getByRole("dialog", { name: "メニュー" }).getByRole("button", { name, exact: true }).click();
}

// ---- 場所(引き出し) ----

export const formationDrawer = (page: Page) => page.getByRole("complementary", { name: "編成" });
export const policyDrawer = (page: Page) => page.getByRole("complementary", { name: "チームの方針" });

/** パソコンならヘッダーの、スマホなら下のタブのメニューの、どちらからでも引き出しを開く。 */
export async function openDrawer(page: Page, device: "pc" | "phone", name: "編成" | "チームの方針") {
  if (device === "pc") await headerDrawer(page, name).click();
  else await phoneMenu(page, name);
}
