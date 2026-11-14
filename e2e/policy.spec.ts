import { expect, test, type Page } from "@playwright/test";

/**
 * 「チームの方針」の入口(#92)。押して、引き出し(役割ごとのモデル・開発ルールのタブ)が見えるまでを確かめる。
 * 引き出しはオフィスの画面にだけ描かれるので、企画スタジオ・生産性・設定のメニューから開いても、オフィスへ移って見える。
 */
async function createProject(page: Page, name: string, repo: string) {
  await page.goto("/#/");
  await page.getByRole("button", { name: "+ プロジェクトを作る" }).click();
  await page.getByLabel("名前").fill(name);
  await page.getByLabel("リポジトリ 1").fill(repo);
  await page.getByRole("button", { name: "次へ: 企画スタジオ" }).click();
  await expect(page.getByText(`${name} · 企画スタジオ`)).toBeVisible();
}

const policy = (page: Page) => page.getByRole("complementary", { name: "チームの方針" });

async function expectOpen(page: Page) {
  await expect(policy(page)).toBeVisible();
  await expect(policy(page).getByRole("tab", { name: "役割ごとのモデル" })).toBeVisible();
  await expect(policy(page).getByRole("tab", { name: "開発ルール" })).toBeVisible();
}

test("1280px: オフィスの共通ヘッダーの「チームの方針」で開き、閉じられる", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await createProject(page, "方針パソコン", "acme/policy-pc");
  await page.getByRole("group", { name: "プロジェクトの画面" }).getByRole("button", { name: "オフィス" }).click();
  await page.getByRole("button", { name: "チームの方針", exact: true }).click();
  await expectOpen(page);
  await policy(page).getByRole("button", { name: "閉じる" }).click();
  await expect(policy(page)).toHaveCount(0);
});

test("390px: どの画面のメニューからでも「チームの方針」が開く", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await createProject(page, "方針スマホ", "acme/policy-phone");
  const open = async () => {
    await page.getByRole("navigation", { name: "スマホの下のタブ" }).getByRole("button", { name: "メニュー" }).click();
    await page.getByRole("dialog", { name: "メニュー" }).getByRole("button", { name: "チームの方針", exact: true }).click();
    await expectOpen(page);
  };
  const menuTo = async (name: string) => {
    await page.getByRole("navigation", { name: "スマホの下のタブ" }).getByRole("button", { name: "メニュー" }).click();
    await page.getByRole("dialog", { name: "メニュー" }).getByRole("button", { name, exact: true }).click();
  };

  // 企画スタジオ(いまの画面)から
  await open();
  await policy(page).getByRole("button", { name: "閉じる" }).click();
  await expect(policy(page)).toHaveCount(0);

  for (const screen of ["生産性", "設定"]) {
    await menuTo(screen);
    await open();
    await policy(page).getByRole("button", { name: "閉じる" }).click();
    await expect(policy(page)).toHaveCount(0);
  }
});
