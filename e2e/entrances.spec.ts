import { expect, test, type Page } from "@playwright/test";
import { createProject, formationDrawer, headerDrawer, openDrawer, PC, PHONE, phoneMenu, phoneTabs, projectId, screens, seedKindTickets, views } from "./helpers.js";

/**
 * 画面の入口(#93)。「押しても何も出ない」のような壊れを見逃さないよう、主な行き先と引き出しを、パソコン(1280px)とスマホ(390px)で押して通す。
 * 「チームの方針」の入口と開発ルールは policy.spec.ts、スマホの全画面のはみ出しは phone.spec.ts、業務の流れは app.spec.ts。
 */

const region = (page: Page, name: string) => page.getByRole("region", { name, exact: true });

test("1280px: 共通ヘッダーの行き先(オフィス/ボード/ツリー・企画スタジオ・生産性・設定・本部)へ移れる", async ({ page }) => {
  await page.setViewportSize(PC);
  await createProject(page, "入口パソコン", "acme/entrance-pc");

  // 企画スタジオ: 切り替えスイッチはどの画面でも同じ形で、いまの画面(企画スタジオ)が選ばれ、見方(オフィス/ボード/ツリー)は選ばれない。引き出しのボタンは出ない
  await expect(screens(page).getByRole("button", { name: "企画スタジオ" })).toHaveAttribute("aria-current", "page");
  for (const v of ["オフィス", "ボード", "ツリー"]) await expect(views(page).getByRole("button", { name: v })).toHaveAttribute("aria-pressed", "false");
  await expect(headerDrawer(page, "編成")).toHaveCount(0);

  await views(page).getByRole("button", { name: "オフィス" }).click();
  await expect(region(page, "オフィスの床")).toBeVisible();
  // オフィスでは、見方の「オフィス」が選ばれ、編成・チームの方針・リーダーのボタンが出る
  await expect(views(page).getByRole("button", { name: "オフィス" })).toHaveAttribute("aria-pressed", "true");
  await expect(screens(page).getByRole("button", { name: "企画スタジオ" })).not.toHaveAttribute("aria-current", "page");
  for (const name of ["編成", "チームの方針", "リーダーと話す"] as const) await expect(headerDrawer(page, name)).toBeVisible();

  await views(page).getByRole("button", { name: "ボード" }).click();
  await expect(region(page, "ボード")).toBeVisible();
  await expect(views(page).getByRole("button", { name: "ボード" })).toHaveAttribute("aria-pressed", "true");
  await expect(views(page).getByRole("button", { name: "オフィス" })).toHaveAttribute("aria-pressed", "false");

  await views(page).getByRole("button", { name: "ツリー" }).click();
  await expect(region(page, "ツリー")).toBeVisible();
  await expect(views(page).getByRole("button", { name: "ツリー" })).toHaveAttribute("aria-pressed", "true");

  await screens(page).getByRole("button", { name: "生産性" }).click();
  await expect(region(page, "生産性")).toBeVisible();
  await expect(screens(page).getByRole("button", { name: "生産性" })).toHaveAttribute("aria-current", "page");
  // 生産性にいるあいだは、見方は選ばれない
  await expect(views(page).getByRole("button", { name: "ツリー" })).toHaveAttribute("aria-pressed", "false");

  await screens(page).getByRole("button", { name: "設定" }).click();
  await expect(region(page, "プロジェクトの設定")).toBeVisible();
  await expect(screens(page).getByRole("button", { name: "設定" })).toHaveAttribute("aria-current", "page");

  await screens(page).getByRole("button", { name: "企画スタジオ" }).click();
  await expect(page.getByText("入口パソコン · 企画スタジオ")).toBeVisible();

  await page.getByRole("navigation", { name: "場所" }).getByRole("button", { name: "本部" }).click();
  await expect(page.getByRole("button", { name: "+ プロジェクトを作る" })).toBeVisible();
});

test("390px: 下のタブとメニューの行き先(対応・オフィス・ボード・ツリー・企画スタジオ・生産性・設定・本部)へ移れる", async ({ page }) => {
  await page.setViewportSize(PHONE);
  await createProject(page, "入口スマホ", "acme/entrance-phone");
  const tabs = phoneTabs(page);

  await tabs.getByRole("button", { name: /^対応/ }).click();
  await expect(region(page, "あなたの対応")).toBeVisible();
  await expect(tabs.getByRole("button", { name: /^対応/ })).toHaveAttribute("aria-current", "page");

  await tabs.getByRole("button", { name: "オフィス" }).click();
  await expect(region(page, "オフィスの床")).toBeVisible();
  await expect(tabs.getByRole("button", { name: "オフィス" })).toHaveAttribute("aria-current", "page");

  await phoneMenu(page, "ボード");
  await expect(region(page, "ボード")).toBeVisible();
  await phoneMenu(page, "ツリー");
  await expect(region(page, "ツリー")).toBeVisible();
  await phoneMenu(page, "生産性");
  await expect(region(page, "生産性")).toBeVisible();
  await phoneMenu(page, "設定");
  await expect(region(page, "プロジェクトの設定")).toBeVisible();
  await phoneMenu(page, "企画スタジオ");
  await expect(page.getByText("入口スマホ · 企画スタジオ")).toBeVisible();

  // メニューは、外(暗い部分)を押すと閉じる
  await tabs.getByRole("button", { name: "メニュー" }).click();
  await expect(page.getByRole("dialog", { name: "メニュー" })).toBeVisible();
  await page.getByRole("button", { name: "メニューを閉じる" }).click({ position: { x: 5, y: 5 } });
  await expect(page.getByRole("dialog", { name: "メニュー" })).toHaveCount(0);

  await phoneMenu(page, "本部");
  await expect(page.getByRole("button", { name: "+ プロジェクトを作る" })).toBeVisible();
});

for (const [device, viewport, label] of [["pc", PC, "1280px"], ["phone", PHONE, "390px"]] as const) {
  test(`${label}: 編成の引き出しが開き、島・連絡経路・流れのタブを切り替えられる`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await createProject(page, `編成${label}`, `acme/formation-${device}`);
    if (device === "pc") await screens(page).getByRole("button", { name: "オフィス" }).click();
    await openDrawer(page, device, "編成");
    const drawer = formationDrawer(page);
    await expect(drawer).toBeVisible();
    const tab = (name: string) => drawer.getByRole("tab", { name: new RegExp(`^${name}`) });

    // 開いたときは「島」。タブごとに、そのタブの一覧が出る
    await expect(tab("島")).toHaveAttribute("aria-selected", "true");
    await expect(drawer.getByRole("list", { name: "島の一覧" })).toBeVisible();
    await tab("連絡経路").click();
    await expect(tab("連絡経路")).toHaveAttribute("aria-selected", "true");
    await expect(tab("島")).toHaveAttribute("aria-selected", "false");
    await expect(drawer.getByRole("list", { name: "リーダー・アーキテクトとの連絡経路" })).toBeVisible();
    await tab("流れ").click();
    await expect(tab("流れ")).toHaveAttribute("aria-selected", "true");
    await expect(drawer.getByRole("list", { name: "チケットの種類" })).toBeVisible();
    await tab("島").click();
    await expect(tab("島")).toHaveAttribute("aria-selected", "true");
    await expect(drawer.getByRole("list", { name: "島の一覧" })).toBeVisible();

    await drawer.getByRole("button", { name: "閉じる", exact: true }).click();
    await expect(drawer).toHaveCount(0);
  });
}

test("1280px: ボードで種類の絞り込みが効き、チケットを開くと詳細が出て、ボードへ戻れる", async ({ page }) => {
  await page.setViewportSize(PC);
  await createProject(page, "入口ボード", "acme/entrance-board");
  await seedKindTickets(page, projectId(page));
  await page.goto(`/#/p/${projectId(page)}`);
  await views(page).getByRole("button", { name: "ボード" }).click();
  const board = region(page, "ボード");
  await expect(board.getByRole("button", { name: "落ちるのを直す" })).toBeVisible();
  await expect(board.getByRole("button", { name: "新しい画面を足す" })).toBeVisible();

  await board.getByRole("radiogroup", { name: "種類で絞り込み" }).getByRole("radio", { name: "バグ修正" }).click();
  await expect(board.getByRole("button", { name: "落ちるのを直す" })).toBeVisible();
  await expect(board.getByRole("button", { name: "新しい画面を足す" })).toHaveCount(0);

  await board.getByRole("button", { name: "落ちるのを直す" }).click();
  const ticket = page.getByRole("region", { name: /^チケット #\d/ });
  await expect(ticket).toBeVisible();
  await expect(ticket).toContainText("落ちるのを直す");
  await expect(ticket.getByRole("radiogroup", { name: "チケットの種類" }).getByRole("radio", { name: "バグ修正" })).toHaveAttribute("aria-checked", "true");

  await ticket.getByRole("button", { name: "← ボードに戻る" }).click();
  await expect(region(page, "ボード")).toBeVisible();
});
