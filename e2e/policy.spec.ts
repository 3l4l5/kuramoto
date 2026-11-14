import { expect, test, type Page } from "@playwright/test";
import { createProject, formationDrawer, headerDrawer, openDrawer, PC, PHONE, phoneMenu, policyDrawer, projectId, screens, seedKindTickets, views } from "./helpers.js";

/**
 * 「チームの方針」の入口と、開発ルールの下書き(#92・#93)。
 * 入口ごと(オフィスのヘッダー・チケット詳細のヘッダー・スマホの下のタブのメニュー)に、押して引き出し(役割ごとのモデル・開発ルールのタブ)が見えるまでを確かめる。
 * 引き出しはオフィスとチケット詳細の画面にだけ描かれるので、企画スタジオ・生産性・設定のメニューから開いても、オフィスへ移って見える。
 * そのうえで、パソコンとスマホの両方で、開発ルールを選べる・下書きを捨てるときに確かめが出る・直している最中に別の引き出しへ移るときも確かめが出るを通す。
 */

async function expectOpen(page: Page) {
  await expect(policyDrawer(page)).toBeVisible();
  await expect(policyDrawer(page).getByRole("tab", { name: "役割ごとのモデル" })).toBeVisible();
  await expect(policyDrawer(page).getByRole("tab", { name: "開発ルール" })).toBeVisible();
}

async function closeDrawer(page: Page) {
  await policyDrawer(page).getByRole("button", { name: "閉じる", exact: true }).click();
  await expect(policyDrawer(page)).toHaveCount(0);
}

test.describe("入口", () => {
  test("1280px: オフィスの共通ヘッダーの「チームの方針」で開き、閉じられる", async ({ page }) => {
    await page.setViewportSize(PC);
    await createProject(page, "方針パソコン", "acme/policy-pc");
    await screens(page).getByRole("button", { name: "オフィス" }).click();
    await headerDrawer(page, "チームの方針").click();
    await expectOpen(page);
    await closeDrawer(page);
  });

  test("1280px: チケット詳細の共通ヘッダーの「チームの方針」でも開き、閉じられる", async ({ page }) => {
    await page.setViewportSize(PC);
    await createProject(page, "方針チケット", "acme/policy-ticket");
    await seedKindTickets(page, projectId(page));
    await screens(page).getByRole("button", { name: "オフィス" }).click();
    await views(page).getByRole("button", { name: "ボード" }).click();
    await page.getByRole("region", { name: "ボード", exact: true }).getByRole("button", { name: "新しい画面を足す" }).click();
    await expect(page.getByRole("region", { name: /^チケット #\d/ })).toBeVisible();
    await headerDrawer(page, "チームの方針").click();
    await expectOpen(page);
    await closeDrawer(page);
    // チケットの画面のまま
    await expect(page.getByRole("region", { name: /^チケット #\d/ })).toBeVisible();
  });

  test("390px: どの画面のメニューからでも「チームの方針」が開く", async ({ page }) => {
    await page.setViewportSize(PHONE);
    await createProject(page, "方針スマホ", "acme/policy-phone");
    // 企画スタジオ(いまの画面)から
    await phoneMenu(page, "チームの方針");
    await expectOpen(page);
    await closeDrawer(page);
    for (const screen of ["生産性", "設定"]) {
      await phoneMenu(page, screen);
      await phoneMenu(page, "チームの方針");
      await expectOpen(page);
      await closeDrawer(page);
    }
  });
});

for (const [device, viewport, label] of [["pc", PC, "1280px"], ["phone", PHONE, "390px"]] as const) {
  test.describe(`開発ルール ${label}`, () => {
    /** 開発ルールのタブを開いて、ひな形「Jira 番号をそろえる」を足し、そのルールの編集が出るところまで進む。 */
    async function openRulesWithOneRule(page: Page) {
      await page.setViewportSize(viewport);
      await createProject(page, `ルール${label}`, `acme/rules-${device}`);
      if (device === "pc") await screens(page).getByRole("button", { name: "オフィス" }).click();
      await openDrawer(page, device, "チームの方針");
      const policy = policyDrawer(page);
      await policy.getByRole("tab", { name: "開発ルール" }).click();
      if (device === "pc") {
        await policy.getByRole("button", { name: "+ Jira 番号をそろえる" }).click();
      } else {
        await policy.getByRole("button", { name: "ひな形から足す" }).click();
        await page.getByRole("dialog", { name: "ひな形から足す" }).getByRole("button", { name: "+ Jira 番号をそろえる" }).click();
      }
      await expect(policy.getByLabel("名前")).toHaveValue("Jira 番号をそろえる");
      return policy;
    }

    test("開発ルールを足して選べる", async ({ page }) => {
      const policy = await openRulesWithOneRule(page);
      // スマホは「一覧 → 押すと編集」。パソコンは左の一覧が出たまま
      if (device === "phone") await policy.getByRole("button", { name: "← ルールの一覧" }).click();
      const item = policy.getByRole("list", { name: "ルール" }).getByRole("listitem");
      await expect(item).toHaveCount(1);
      await item.first().click();
      await expect(policy.getByLabel("名前")).toHaveValue("Jira 番号をそろえる");
    });

    test("直している途中で閉じると確かめが出て、「このまま直す」で続け、「捨てて移る」で捨てられる", async ({ page }) => {
      const policy = await openRulesWithOneRule(page);
      await policy.getByLabel("名前").fill("途中の名前");
      await policy.getByRole("button", { name: "閉じる", exact: true }).click();
      // 確かめるあいだは、引き出しも下書きも残る
      await expect(policy.getByRole("alert")).toContainText("保存していない変更があります");
      await expect(policy.getByLabel("名前")).toHaveValue("途中の名前");
      await policy.getByRole("alert").getByRole("button", { name: "このまま直す" }).click();
      await expect(policy.getByRole("alert")).toHaveCount(0);
      await expect(policy.getByLabel("名前")).toHaveValue("途中の名前");
      // 捨てて閉じる
      await policy.getByRole("button", { name: "閉じる", exact: true }).click();
      await policy.getByRole("alert").getByRole("button", { name: "捨てて移る" }).click();
      await expect(policy).toHaveCount(0);
      // 開き直すと、捨てたので元の名前のまま
      await openDrawer(page, device, "チームの方針");
      await policy.getByRole("tab", { name: "開発ルール" }).click();
      await expect(policy.getByLabel("名前")).toHaveValue("Jira 番号をそろえる");
    });

    test("直している最中に別の引き出し(編成)へ移ろうとすると確かめが出て、「このまま直す」で残り、「捨てて移る」で移る", async ({ page }) => {
      const policy = await openRulesWithOneRule(page);
      await policy.getByLabel("名前").fill("途中の名前");
      await openDrawer(page, device, "編成");
      await expect(policy.getByRole("alert")).toContainText("保存していない変更があります");
      await expect(formationDrawer(page)).toHaveCount(0);
      await policy.getByRole("alert").getByRole("button", { name: "このまま直す" }).click();
      await expect(policy.getByLabel("名前")).toHaveValue("途中の名前");
      await openDrawer(page, device, "編成");
      await policy.getByRole("alert").getByRole("button", { name: "捨てて移る" }).click();
      await expect(formationDrawer(page)).toBeVisible();
      await expect(policy).toHaveCount(0);
    });
  });
}

test("1280px: 下書きを直している途中で企画スタジオへ移って戻っても、続きから直せて、そこから編成へ移るときは確かめが出る", async ({ page }) => {
  await page.setViewportSize(PC);
  await createProject(page, "下書きを残す", "acme/policy-draft");
  await screens(page).getByRole("button", { name: "オフィス" }).click();
  await headerDrawer(page, "チームの方針").click();
  const policy = policyDrawer(page);
  await policy.getByRole("tab", { name: "開発ルール" }).click();
  await policy.getByRole("button", { name: "+ 空のルールを足す" }).click();
  await policy.getByLabel("名前").fill("途中のルール");

  // 別の画面(企画スタジオ)へ移って、オフィスへ戻る。引き出しも下書きも残っている
  await screens(page).getByRole("button", { name: "企画スタジオ" }).click();
  await expect(page.getByText("下書きを残す · 企画スタジオ")).toBeVisible();
  await screens(page).getByRole("button", { name: "オフィス" }).click();
  await expect(policy).toBeVisible();
  await expect(policy.getByLabel("名前")).toHaveValue("途中のルール");

  // ここから別の引き出しへ移ろうとすると確かめが出る
  await headerDrawer(page, "編成").click();
  await expect(policy.getByRole("alert")).toContainText("保存していない変更があります");
  await policy.getByRole("alert").getByRole("button", { name: "このまま直す" }).click();
  await expect(policy.getByLabel("名前")).toHaveValue("途中のルール");
  await headerDrawer(page, "編成").click();
  await policy.getByRole("alert").getByRole("button", { name: "捨てて移る" }).click();
  await expect(formationDrawer(page)).toBeVisible();
});
