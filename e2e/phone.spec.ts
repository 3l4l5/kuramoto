import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { createProject, PHONE, phoneMenu, phoneTabs, projectId, seedKindTickets } from "./helpers.js";

/**
 * スマホの幅(390px)。全画面が横にはみ出さず、操作できることを確かめる(未決 #21)。
 * E2E_SHOTS にフォルダを指定すると、画面ごとのスクリーンショットを残す(Kuramoto の compare_screen でお手本と見比べるため)。
 */
test.use({ viewport: PHONE });

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

const bar = phoneTabs;
const menu = phoneMenu;

test("幅 390px: 全画面が横にはみ出さず、引き出しも全画面で開く", async ({ page }) => {
  await createProject(page, "スマホ", "acme/phone");
  await fits(page, "studio");

  await bar(page).getByRole("button", { name: "オフィス" }).click();
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
  await menu(page, "編成");
  const formation = page.getByRole("complementary", { name: "編成" });
  await expect(formation).toBeVisible();
  for (const [tab, name] of [["島", "formation-islands"], ["連絡経路", "formation-routes"], ["流れ", "formation-flow"]] as const) {
    const t = formation.getByRole("tab", { name: new RegExp(`^${tab}`) });
    // タブの列が潰れず、見出しの下に見えている(#87)。押すと、そのタブが選ばれる
    await expect(t).toBeVisible();
    const tb = (await t.boundingBox())!;
    const head = (await formation.getByRole("heading", { name: /^編成/ }).boundingBox())!;
    expect(tb.height, `${tab}のタブの高さ`).toBeGreaterThanOrEqual(36);
    expect(tb.y, `${tab}のタブは見出しより下`).toBeGreaterThanOrEqual(head.y + head.height);
    expect(tb.x + tb.width, `${tab}のタブは画面の中`).toBeLessThanOrEqual(390);
    await t.click();
    await expect(t).toHaveAttribute("aria-selected", "true");
    await fits(page, name);
  }
  await formation.getByRole("button", { name: "閉じる" }).click();

  // 開発ルール
  await menu(page, "チームの方針");
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

  await menu(page, "生産性");
  await expect(page.getByRole("heading", { name: /生産性/ }).first()).toBeVisible();
  await fits(page, "productivity");
  // 中身の無い枠(記録が無いのに残った図の枠)を出さない(#81)
  const emptyPanels = await page.locator(".prod .panel").evaluateAll((els) => els.filter((e) => !(e.textContent ?? "").trim() && !e.querySelector("svg, table, img")).length);
  expect(emptyPanels, "生産性に中身の無い枠が出ている").toBe(0);
  await menu(page, "設定");
  await expect(page.getByRole("heading", { name: /設定/ }).first()).toBeVisible();
  await fits(page, "settings");
});

test("幅 390px: 下のタブで あなたの対応 / オフィスを切り替え、ボードは工程のタブ、チケットは「やりとり / 中身」のタブで操作できる", async ({ page }) => {
  await createProject(page, "スマホの画面", "acme/phone2");
  const id = projectId(page);
  await seedKindTickets(page, id);
  await page.goto(`/#/p/${id}`);

  await test.step("最初は あなたの対応(スマホで開くと最初にこの画面)。上の画面の切り替えは無く、下のタブが出る", async () => {
    await expect(page.getByRole("region", { name: "あなたの対応" })).toBeVisible();
    await expect(page.getByRole("region", { name: "オフィス" })).toBeHidden();
    await expect(page.getByRole("group", { name: "プロジェクトの画面" })).toBeHidden();
    await expect(bar(page).getByRole("button", { name: /^対応/ })).toHaveAttribute("aria-current", "page");
    await fits(page, "phone-home");
  });

  await test.step("ボード: 工程のタブ(件数つき)で 1 列ずつ見る。種類で絞ると、その種類の流れの順にタブが並ぶ", async () => {
    await bar(page).getByRole("button", { name: "オフィス" }).click();
    await page.getByRole("group", { name: "オフィスの見方" }).getByRole("button", { name: "ボード" }).click();
    const board = page.getByRole("region", { name: "ボード" });
    const tabs = board.getByRole("tablist", { name: "工程" });
    await expect(tabs.getByRole("tab")).toHaveText(["未着手1", "開発中(直し含む)0", "QA1", "判断待ち0", "merge 待ち0", "完了0"]);
    // 今の工程の列だけが見える
    await expect(board.locator(".card:visible")).toHaveCount(1);
    await board.getByRole("radiogroup", { name: "種類で絞り込み" }).getByRole("radio", { name: "バグ修正" }).click();
    await expect(tabs.getByRole("tab").first()).toHaveText("QA1");
    await expect(tabs.getByRole("tab").first()).toHaveAttribute("aria-selected", "true");
    await expect(board.locator(".card", { hasText: "落ちるのを直す" })).toBeVisible();
    await fits(page, "phone-board");
  });

  await test.step("チケットの詳細: やりとりが先、「中身」のタブで中身。メモの欄は下に固定され、予算もそこで変えられる", async () => {
    await page.getByRole("button", { name: "落ちるのを直す" }).click();
    const tk = page.getByRole("region", { name: /^チケット #/ });
    await expect(tk.getByRole("tab", { name: "やりとり" })).toHaveAttribute("aria-selected", "true");
    await expect(tk.getByRole("region", { name: "やりとり" })).toBeVisible();
    await expect(tk.getByRole("region", { name: "チケットの中身" })).toBeHidden();
    const memo = tk.getByLabel("メモを残す", { exact: true }).first();
    const box = (await memo.boundingBox())!;
    expect(box.y + box.height).toBeGreaterThan(700);
    await fits(page, "phone-ticket");
    // 帯の種類のチップを押すと、種類を選べる(金額・要件・PR のチップも帯に出る)
    await expect(tk.getByRole("button", { name: /^種類: バグ修正/ })).toBeVisible();
    await expect(tk.locator(".tk-phone")).toContainText("$");
    await tk.getByRole("button", { name: /^種類: バグ修正/ }).click();
    await expect(tk.locator(".tk-kindsheet").getByRole("radiogroup", { name: "チケットの種類" })).toBeVisible();
    await tk.locator(".tk-kindsheet").getByRole("radio", { name: "機能" }).click();
    await expect(tk.locator(".tk-kindsheet")).toBeHidden();
    await expect(tk.getByRole("button", { name: /^種類: 機能/ })).toBeVisible();
    await tk.getByRole("tab", { name: "中身" }).click();
    await expect(tk.getByRole("region", { name: "チケットの中身" })).toBeVisible();
    await expect(tk.getByRole("region", { name: "やりとり" })).toBeHidden();
    await expect(tk.getByRole("radiogroup", { name: "チケットの種類" })).toBeVisible();
    await tk.getByRole("button", { name: "予算を変える" }).click();
    await expect(tk.getByRole("button", { name: "決める" })).toBeVisible();
    await fits(page, "phone-ticket-details");
    // ボードへ戻ると、見ていた工程・オフィスのタブのまま
    await tk.getByRole("button", { name: "‹ ボード" }).click();
    await expect(page.getByRole("region", { name: "ボード" })).toBeVisible();
  });
});
