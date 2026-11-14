import { expect, test } from "@playwright/test";
import { E2E_TOKEN } from "./token.js";

/**
 * 合言葉(ADR-0059)。Kuramoto 本体は、localhost からも合言葉(Cookie か ?token=)が無いと、API も画面も 401 にする。
 * ほかのテストは playwright.config.ts が Authorization: Bearer を渡す。ここでは渡さずに、人が使う道(端末に出た URL を開く)を確かめる。
 */
test.use({ extraHTTPHeaders: {} });

test("合言葉が無いと、画面は案内だけを出し、API は 401。合言葉つきの URL を一度開けば、以後は合言葉なしで入れる", async ({ page }) => {
  // 合言葉なし: 画面の代わりに案内。API も 401
  const res = await page.goto("/");
  expect(res?.status()).toBe(401);
  await expect(page.getByText("合言葉つきの URL")).toBeVisible();
  expect((await page.request.get("/api/hq")).status()).toBe(401);

  // 端末に出た URL(?token=)を開く: 合言葉が URL から外れて、画面が開く
  await page.goto(`/?token=${E2E_TOKEN}`);
  await expect(page.getByRole("button", { name: "+ プロジェクトを作る" })).toBeVisible();
  expect(page.url()).not.toContain("token=");

  // Cookie に入ったので、合言葉なしで API も通る。入ったのは合言葉ではなくセッション ID(ADR-0061)
  expect((await page.request.get("/api/hq")).status()).toBe(200);
  const cookies = await page.context().cookies();
  expect(cookies.map((c) => c.name)).toEqual(["kuramoto_session"]);
  expect(cookies[0]?.value).not.toContain(E2E_TOKEN);
});

test("画面を開いたあとで合言葉が通らなくなったら(401)、端末の URL を開くよう案内を出す", async ({ page }) => {
  await page.goto(`/?token=${E2E_TOKEN}`);
  await expect(page.getByRole("button", { name: "+ プロジェクトを作る" })).toBeVisible();
  await expect(page.getByRole("alert").filter({ hasText: "合言葉が通りません" })).toHaveCount(0);

  // Cookie の期限切れ・合言葉の作り直しを真似る
  await page.context().clearCookies();
  await expect(page.getByRole("alert").filter({ hasText: "合言葉が通りません" })).toBeVisible();
  await expect(page.getByText("端末に出ている「合言葉つきの URL」を開いてください")).toBeVisible();

  // 合言葉つきの URL を開き直せば、案内は消える
  await page.goto(`/?token=${E2E_TOKEN}`);
  await expect(page.getByRole("button", { name: "+ プロジェクトを作る" })).toBeVisible();
  await expect(page.getByRole("alert").filter({ hasText: "合言葉が通りません" })).toHaveCount(0);
});

test("本部の「ログアウト」で、このブラウザのセッションが止まり、案内が出る。合言葉つきの URL を開き直せば入れる", async ({ page }) => {
  await page.goto(`/?token=${E2E_TOKEN}`);
  await expect(page.getByRole("button", { name: "+ プロジェクトを作る" })).toBeVisible();
  const panel = page.getByRole("region", { name: "アクセスの管理" });
  await panel.getByRole("button", { name: "ログアウト", exact: true }).click();

  await expect(page.getByRole("alert").filter({ hasText: "ログアウトしました" })).toBeVisible();
  // セッションは失効し、Cookie も消えている
  expect(await page.context().cookies()).toEqual([]);
  expect((await page.request.get("/api/hq")).status()).toBe(401);

  await page.goto(`/?token=${E2E_TOKEN}`);
  await expect(page.getByRole("button", { name: "+ プロジェクトを作る" })).toBeVisible();
  await expect(page.getByRole("alert").filter({ hasText: "ログアウトしました" })).toHaveCount(0);
});

test("本部の「すべてのセッションを失効」は、確認のあとに、ほかのセッションも含めて止める", async ({ page, browser }) => {
  await page.goto(`/?token=${E2E_TOKEN}`);
  await expect(page.getByRole("button", { name: "+ プロジェクトを作る" })).toBeVisible();

  // もう 1 つ、別のブラウザのセッションを作る
  const other = await browser.newContext({ baseURL: test.info().project.use.baseURL });
  const otherPage = await other.newPage();
  await otherPage.goto(`/?token=${E2E_TOKEN}`);
  expect((await other.request.get("/api/hq")).status()).toBe(200);

  await page.getByRole("button", { name: "すべてのセッションを失効" }).click();
  const dialog = page.getByRole("dialog", { name: "すべてのセッションを失効" });
  await expect(dialog.getByText("このブラウザも入れなくなります")).toBeVisible();

  // やめるなら何も止まらない
  await dialog.getByRole("button", { name: "やめる" }).click();
  await expect(dialog).toBeHidden();
  expect((await page.request.get("/api/hq")).status()).toBe(200);

  await page.getByRole("button", { name: "すべてのセッションを失効" }).click();
  await dialog.getByRole("button", { name: "失効する" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "ログアウトしました" })).toBeVisible();
  expect((await page.request.get("/api/hq")).status()).toBe(401);
  expect((await other.request.get("/api/hq")).status()).toBe(401);
  await other.close();
});
