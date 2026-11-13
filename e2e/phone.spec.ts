import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";

/**
 * スマホの幅(390px)。全画面が横にはみ出さず、操作できることを確かめる(未決 #21)。
 * E2E_SHOTS にフォルダを指定すると、画面ごとのスクリーンショットを残す(Kuramoto の compare_screen でお手本と見比べるため)。
 */
test.use({ viewport: { width: 390, height: 844 } });

async function createProject(page: Page, name: string, repo: string) {
  await page.goto("/#/");
  await page.getByRole("button", { name: "+ プロジェクトを作る" }).click();
  await page.getByLabel("名前").fill(name);
  await page.getByLabel("リポジトリ 1").fill(repo);
  await page.getByRole("button", { name: "次へ: 企画スタジオ" }).click();
  await expect(page.getByText(`${name} · 企画スタジオ`)).toBeVisible();
}

/**
 * ページ全体が画面の幅に収まる(横にスクロールしない)。はみ出した要素の名前をメッセージに出す。
 * 引き出し・シートは position: fixed で自分の中でスクロールするので、ページの幅には出ない。開いているものは、それぞれの中身の幅も確かめる。
 */
async function fits(page: Page, name: string) {
  const over = await page.evaluate(() => {
    const w = document.documentElement.clientWidth;
    const bad: string[] = [];
    for (const el of document.body.querySelectorAll<HTMLElement>("*")) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.right > w + 1 && !el.closest(".tablewrap, .board-wrap, .ds-seg, .ds-drawer__tabs")) bad.push(`${el.tagName.toLowerCase()}.${String(el.className).slice(0, 30)}`);
    }
    const inner: string[] = [];
    for (const el of document.querySelectorAll<HTMLElement>("aside.drawer, .of-drawer, .of-drawer-body, .rules__sheet")) {
      if (el.scrollWidth > el.clientWidth) inner.push(`${el.tagName.toLowerCase()}.${String(el.className).slice(0, 30)}(${el.scrollWidth}>${el.clientWidth})`);
    }
    return { scroll: document.documentElement.scrollWidth, w, bad: [...new Set(bad)].slice(0, 6), inner };
  });
  expect.soft(over.scroll, `${name}: ページが横にはみ出している(${over.bad.join(" / ")})`).toBeLessThanOrEqual(over.w);
  expect.soft(over.inner, `${name}: 引き出し・シートの中が横にはみ出している`).toEqual([]);
  if (process.env.E2E_SHOTS) {
    mkdirSync(process.env.E2E_SHOTS, { recursive: true });
    await page.screenshot({ path: join(process.env.E2E_SHOTS, `${name}.png`), fullPage: true });
  }
}

const screens = (page: Page) => page.getByRole("group", { name: "プロジェクトの画面" });

test("幅 390px: 全画面が横にはみ出さず、引き出しも全画面で開く", async ({ page }) => {
  await createProject(page, "スマホ", "acme/phone");
  await fits(page, "studio");

  await screens(page).getByRole("button", { name: "オフィス" }).click();
  const floor = page.getByRole("region", { name: "オフィスの床" });
  await expect(floor.getByRole("region", { name: /^島 / }).first()).toBeVisible();
  await fits(page, "office");
  // 停車の番号は受け口を 0 として数える(受け口に丸は無く、受け口の次の駅が 1)
  await expect(floor.locator(".of-stopnum").first()).toHaveText("1");

  // メンバーを押すと、下からシートが出る(今のチケット・直近の手順・話す欄)
  await floor.getByRole("region", { name: /^島 / }).first().getByRole("button", { name: /押すと様子を見る/ }).first().click();
  const sheet = floor.getByLabel(/の様子と会話$/);
  await expect(sheet).toBeVisible();
  await fits(page, "office-sheet");
  const box = (await sheet.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  expect(box.y + box.height).toBeGreaterThan(800);
  await sheet.getByRole("button", { name: "閉じる" }).click();

  // 編成の 3 タブは、全画面の引き出し
  await page.getByRole("button", { name: "編成", exact: true }).click();
  const formation = page.getByRole("complementary", { name: "編成" });
  await expect(formation).toBeVisible();
  for (const [tab, name] of [["島", "formation-islands"], ["連絡経路", "formation-routes"], ["流れ", "formation-flow"]] as const) {
    await formation.getByRole("tab", { name: new RegExp(`^${tab}`) }).click();
    await fits(page, name);
  }
  await formation.getByRole("button", { name: "閉じる" }).click();

  // 開発ルール
  await page.getByRole("button", { name: "チームの方針", exact: true }).click();
  const policy = page.getByRole("complementary", { name: "チームの方針" });
  await policy.getByRole("tab", { name: "開発ルール" }).click();
  await fits(page, "dev-rules");
  // ひな形は、一覧の下の固定の帯から、下からのシートで選ぶ
  await policy.getByRole("button", { name: "ひな形から足す" }).click();
  const tpl = page.getByRole("dialog", { name: "ひな形から足す" });
  await expect(tpl).toBeVisible();
  await fits(page, "dev-rules-templates");
  await tpl.getByRole("button", { name: "ひな形のシートを閉じる" }).click();
  // ひな形を選ぶと、そのルールの編集の画面が開く。名前を直して一覧へ戻り「+ ルールを足す」を押すと、捨ててよいかの確かめが出る
  await policy.getByRole("button", { name: "ひな形から足す" }).click();
  await tpl.getByRole("button", { name: "+ Jira 番号をそろえる" }).click();
  await expect(policy.getByLabel("名前")).toBeVisible();
  await policy.getByLabel("名前").fill("直している途中");
  await policy.getByRole("button", { name: "← ルールの一覧" }).click();
  await expect(policy.getByLabel("名前")).toBeHidden();
  await policy.getByRole("button", { name: "+ ルールを足す" }).click();
  await expect(policy.getByRole("alert")).toContainText("保存していない変更があります");
  await policy.getByRole("button", { name: "捨てて移る" }).click();
  await expect(policy.getByLabel("名前")).toHaveValue("");
  await policy.getByRole("button", { name: "← ルールの一覧" }).click();
  // 空のルールを足している途中で一覧へ戻っても、「+ ルールを足す」で、その下書きのフォームに戻れる
  await policy.getByRole("button", { name: "+ ルールを足す" }).click();
  await policy.getByLabel("名前").fill("途中のルール");
  await fits(page, "dev-rules-edit");
  await policy.getByRole("button", { name: "← ルールの一覧" }).click();
  await expect(policy.getByLabel("名前")).toBeHidden();
  await policy.getByRole("button", { name: "+ ルールを足す" }).click();
  await expect(policy.getByLabel("名前")).toHaveValue("途中のルール");
  // 「やめる」で一覧へ戻る
  await policy.getByRole("button", { name: "やめる" }).click();
  await expect(policy.getByLabel("名前")).toBeHidden();
  await policy.getByRole("button", { name: "閉じる" }).click();

  // ボード・ツリー
  await page.getByRole("group", { name: "オフィスの見方" }).getByRole("button", { name: "ボード" }).click();
  await fits(page, "board");
  await page.getByRole("group", { name: "オフィスの見方" }).getByRole("button", { name: "ツリー" }).click();
  await fits(page, "tree");

  await screens(page).getByRole("button", { name: "生産性" }).click();
  await expect(page.getByRole("heading", { name: /生産性/ }).first()).toBeVisible();
  await fits(page, "productivity");
  await screens(page).getByRole("button", { name: "設定" }).click();
  await expect(page.getByRole("heading", { name: /設定/ }).first()).toBeVisible();
  await fits(page, "settings");
});
