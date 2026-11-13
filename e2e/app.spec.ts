import { expect, test, type Page } from "@playwright/test";

/**
 * 画面の作りに依らないよう、ボタンの名前や見える文言で操作する。
 * 担当はフェイク(e2e/server.ts)で、本物の Claude と GitHub は使わない。
 */

async function createProject(page: Page, name: string, repo: string) {
  await page.goto("/#/");
  await page.getByRole("button", { name: "+ プロジェクトを作る" }).click();
  await page.getByLabel("名前").fill(name);
  await page.getByLabel("リポジトリ 1").fill(repo);
  await page.getByRole("button", { name: "次へ: 企画スタジオ" }).click();
  await expect(page.getByText(`${name} · 企画スタジオ`)).toBeVisible();
}

/** E2E_SHOTS にフォルダを指定したときだけ、見た目の確認用にスクリーンショットを撮る。 */
async function shot(page: Page, name: string) {
  if (process.env.E2E_SHOTS) await page.screenshot({ path: `${process.env.E2E_SHOTS}/${name}.png`, fullPage: true });
}

const gate = (page: Page, label: string) => page.getByRole("navigation", { name: "段階" }).getByRole("button", { name: new RegExp(label) });
const work = (page: Page) => page.getByRole("region", { name: "作業の場" });
const chat = (page: Page) => page.getByRole("region", { name: "企画の 3 人との会話" });

test("プロジェクトを作り、企画スタジオで 5 段階を決めてチームに渡し、オフィスで merge まで進む", async ({ page }) => {
  await test.step("本部からプロジェクトを作ると、企画スタジオが開き、企画担当が聞き始める", async () => {
    await createProject(page, "予約サイト", "acme/reserve");
    await expect(chat(page).getByText("企画担当の咲季です。何のためのものですか?")).toBeVisible();
  });

  await test.step("要件: 話しかけると作業中の様子が見え、終わると要件が書かれる", async () => {
    await page.getByLabel("メッセージ").fill("店舗の予約サイトを作りたい");
    await page.getByRole("button", { name: "送る", exact: true }).click();
    await expect(chat(page).getByText("店舗の予約サイトを作りたい")).toBeVisible();
    await expect(chat(page).getByText("咲季が作業中")).toBeVisible();
    await expect(chat(page).getByText("README.md を読んでいます")).toBeVisible();
    await expect(chat(page).getByText("要件を書きました。未決が 1 件あります。")).toBeVisible();
    await expect(chat(page).getByText("咲季が作業中")).toBeHidden();
    await expect(work(page).getByText("R1 空き枠を探す")).toBeVisible();
    await expect(work(page).getByText("店舗と日付を選ぶと、残りのある枠が時間順に並ぶ")).toBeVisible();
    await expect(work(page).getByRole("tablist")).toHaveCount(0);
  });

  await test.step("要件: 未決が残るうちは合意できず、答えると合意できる", async () => {
    await expect(page.getByRole("button", { name: "この版に合意する", exact: true })).toBeDisabled();
    await page.getByRole("button", { name: "作らない(推奨)", exact: true }).click();
    await expect(page.getByRole("button", { name: "この版に合意する", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "この版に合意する", exact: true }).click();
    await expect(gate(page, "要件")).toContainText("合意済み v1");
  });

  await test.step("ユーザーフロー: 未決に自由な答えを書き、図に反映されたら合意する", async () => {
    await gate(page, "ユーザーフロー").click();
    await expect(work(page).getByText("満席になったらどこへ戻すか")).toBeVisible();
    await page.getByLabel("別の答え").fill("近い枠を 3 つ出して戻す");
    await page.getByRole("button", { name: "答える", exact: true }).click();
    await expect(work(page).getByText("満席のお知らせ")).toBeVisible();
    await page.getByRole("button", { name: "この版に合意する", exact: true }).click();
    await expect(gate(page, "ユーザーフロー")).toContainText("合意済み");
  });

  await test.step("画面デザイン: 案を選び、試作の上にコメントを付けると直ってくる。全画面に合意する", async () => {
    await gate(page, "画面デザイン").click();
    await expect(work(page).getByRole("button", { name: "この案にする", exact: true }).first()).toBeVisible();
    await work(page).getByRole("button", { name: "この案にする", exact: true }).first().click();
    await expect(work(page).getByRole("button", { name: "この案に決定", exact: true })).toBeVisible();
    await work(page).getByRole("button", { name: "コメントを付ける", exact: true }).click();
    await work(page).getByRole("button", { name: "案 A の上にコメントを付ける" }).click({ position: { x: 100, y: 60 } });
    await page.getByLabel("コメント", { exact: true }).fill("残りが 1 の枠を目立たせて");
    await page.getByRole("button", { name: "付ける", exact: true }).click();
    await expect(work(page).getByText("残りが 1 の枠を目立たせて")).toBeVisible();
    await expect(work(page).getByText(/v\d+ で対応済み/)).toBeVisible();
    await work(page).getByRole("button", { name: "この画面に合意する", exact: true }).click();
    await work(page).getByRole("button", { name: /予約の確認/ }).click();
    await work(page).getByRole("button", { name: "この画面に合意する", exact: true }).click();
    await page.getByRole("button", { name: "この版に合意する", exact: true }).click();
    await expect(gate(page, "画面デザイン")).toContainText("合意済み");
  });

  await test.step("インフラ: 構成と見積もりが出て、戻せない未決に答えて合意する", async () => {
    await gate(page, "インフラ").click();
    await expect(work(page).getByText("既存の AWS に載せる")).toBeVisible();
    await expect(work(page).getByText("戻せない")).toBeVisible();
    await page.getByRole("button", { name: "東京(推奨)", exact: true }).click();
    await page.getByRole("button", { name: "この版に合意する", exact: true }).click();
    await expect(gate(page, "インフラ")).toContainText("合意済み");
  });

  await test.step("アーキテクチャとデータ: アーキテクチャスタイルとデータ設計が出て、合意するとチームに渡せる", async () => {
    await gate(page, "アーキテクチャとデータ").click();
    // 中身がアーキテクチャだけのうちは、タブを出さずにそのまま見せる
    await expect(work(page).getByText("モジュラーモノリス")).toBeVisible();
    await expect(work(page).getByText("ドメイン層はインフラに依存しない")).toBeVisible();
    await expect(work(page).getByRole("tablist")).toHaveCount(0);
    await page.getByRole("button", { name: "1 つで作る(推奨)", exact: true }).click();
    // ドメインとテーブル設計が書かれると、タブに分かれる
    const tabs = work(page).getByRole("tablist", { name: "アーキテクチャとデータの中身" });
    await expect(tabs.getByRole("tab")).toHaveText(["アーキテクチャ", "技術選定1", "ドメインモデル", "テーブル設計2"]);
    await expect(tabs.getByRole("tab", { name: "アーキテクチャ" })).toHaveAttribute("aria-selected", "true");
    await expect(work(page).getByText("reservations")).toBeHidden();
    await shot(page, "architecture");
    await tabs.getByRole("tab", { name: /テーブル設計/ }).click();
    await expect(work(page).getByRole("region", { name: "表 reservations" })).toContainText("どの枠か");
    await expect(work(page).getByRole("region", { name: "表 slots" })).toContainText("定員");
    await expect(work(page).getByText("モジュラーモノリス")).toBeHidden();
    await shot(page, "tables");
    await tabs.getByRole("tab", { name: "ドメインモデル" }).click();
    await expect(work(page).getByText("定員を超えない")).toBeVisible();
    await tabs.getByRole("tab", { name: /技術選定/ }).click();
    const sel = work(page).getByRole("region", { name: "技術選定 API のフレームワーク" });
    await expect(sel).toContainText("後から替えにくい");
    await expect(sel.getByRole("row", { name: /Hono 選択/ })).toContainText("情報が少なめ");
    await expect(sel).toContainText("軽く、型が効く");
    await shot(page, "techsel");
    await page.getByRole("button", { name: "この版に合意する", exact: true }).click();
    await page.getByRole("button", { name: "チームに渡す", exact: true }).click();
    await expect(work(page).getByText("チームに渡しました")).toBeVisible();
    await expect(work(page).getByText("予約の表を足す")).toBeVisible();
    await expect(work(page).getByText("空き枠を探す画面")).toBeVisible();
  });

  await test.step("エクスポート: 要件と技術的な設計を Markdown でダウンロードできる", async () => {
    const download = page.waitForEvent("download");
    await page.getByRole("link", { name: "設計書をエクスポート(Markdown)" }).click();
    const file = await download;
    expect(file.suggestedFilename()).toBe("予約サイト-設計書.md");
    const md = await new Promise<string>((resolve, reject) => {
      void file.createReadStream().then((s) => {
        let text = "";
        s.on("data", (c: Buffer) => (text += c.toString("utf8")));
        s.on("end", () => resolve(text));
        s.on("error", reject);
      });
    });
    expect(md).toContain("# 予約サイト 設計書");
    expect(md).toContain("| R1 | 空き枠を探す |");
    expect(md).toContain("```mermaid");
    expect(md).toContain("アーキテクチャスタイル: モジュラーモノリス");
    expect(md).toContain("| reservations | 新規 |");
    expect(md).toContain("| slots | 新規 |");
  });

  await test.step("オフィス: 始業するとチケットが merge 待ちまで進み、merge すると完了する", async () => {
    await page.getByRole("group", { name: "プロジェクトの画面" }).getByRole("button", { name: "オフィス" }).click();
    const inbox = page.getByRole("region", { name: "あなたの対応", exact: true });
    await expect(inbox.getByText("今あなたが対応することはありません。")).toBeVisible();
    // オフィスの床: 始業すると、開発の島のメンバーが席で実装を始め、吹き出しで今していることを話す
    const floor = page.getByRole("region", { name: "オフィスの床" });
    await expect(floor.getByRole("region", { name: "島 開発の島" })).toBeVisible();
    // 終業中は居眠り、始業すると起きて仕事を待つ(リーダーも)。キャラクターの下は名前だけで、状態はボタンの名前(読み上げ・ツールチップ)で伝える
    // 島のメンバーは最大人数ぶんずっといる(レビューの島は 3 人。ADR-0023)
    await expect(floor.getByRole("region", { name: "島 レビューの島" }).getByRole("button", { name: /終業中/ })).toHaveCount(3);
    await expect(floor.getByRole("region", { name: "リーダーの机" }).getByRole("button", { name: /終業中/ })).toHaveCount(1);
    await expect(floor.getByRole("region", { name: "島 レビューの島" })).not.toContainText("終業中");
    await page.getByRole("banner").getByRole("switch", { name: "稼働" }).click();
    await expect(page.getByRole("banner").getByRole("switch", { name: "稼働" })).toHaveAttribute("aria-checked", "true");
    await expect(floor.getByRole("region", { name: "リーダーの机" }).getByRole("button", { name: /判断・チャットを待っています/ })).toHaveCount(1);
    const devIsland = floor.getByRole("region", { name: "島 開発の島" });
    // 島のメンバーが全員いるので、#1 と #2 を同時に実装することがある
    await expect(devIsland.getByRole("button", { name: /#\d 実装中/ }).first()).toBeVisible();
    await expect(devIsland).toContainText("src/export.ts を書いています");
    await shot(page, "office-working");
    await expect(page.getByRole("banner").getByText("稼働中")).toBeVisible();
    // merge 待ちの棚に並ぶ。自動 merge なので、あなたの対応には merge の依頼を出さず、チームが merge すると案内する(ADR-0022)
    const shelf = floor.getByRole("region", { name: "merge 待ちの棚" });
    await expect(shelf.getByRole("button", { name: /を merge$/ })).toHaveCount(2, { timeout: 30_000 });
    await expect(shelf).toContainText("チームが merge します");
    await expect(inbox.getByRole("button", { name: "merge する", exact: true })).toHaveCount(0);
    await expect(inbox).toContainText("チームが merge します。あなたの対応は要りません");
    await shot(page, "office-merge");
    // キャラクターを押すと、その人の様子(今の仕事・受け持ち・これまでの仕事)がモーダルで開く
    await devIsland.getByRole("button", { name: /押すと様子を見る/ }).first().click();
    const memberDialog = page.getByRole("dialog", { name: /の様子$/ });
    await expect(memberDialog).toContainText("今していること");
    await expect(memberDialog.getByRole("list", { name: "これまでの仕事" })).toContainText("実装");
    await memberDialog.getByRole("button", { name: "閉じる" }).click();
    await expect(memberDialog).toHaveCount(0);
    // 島の名前を押すと、島の様子(メンバー・待ち・予算・最近の仕事)が開き、そこから設定にも行ける
    await devIsland.getByRole("button", { name: "開発の島 の様子" }).click();
    const unitDialog = page.getByRole("dialog", { name: "開発の島 の様子" });
    await expect(unitDialog).toContainText("すぐ取れる仕事");
    await expect(unitDialog).toContainText("順番待ち");
    await expect(unitDialog.getByRole("list", { name: "これまでの仕事" })).toContainText("実装");
    await shot(page, "office-island");
    await unitDialog.getByRole("button", { name: "島の設定を変える" }).click();
    await expect(page.getByRole("dialog", { name: "開発の島 の設定" })).toBeVisible();
    await page.getByRole("dialog", { name: "開発の島 の設定" }).getByRole("button", { name: "閉じる" }).click();
    // チケットを開くと、中身とやりとり(実装・PR・レビューの結果)が見られ、メモを残せる
    await floor.getByRole("region", { name: "merge 待ちの棚" }).getByRole("button", { name: /空き枠を探す画面/ }).click();
    const dialog = page.getByRole("dialog", { name: /チケット #\d/ });
    const timeline = dialog.getByRole("region", { name: "やりとり" });
    await expect(timeline).toContainText("が実装をしました");
    await expect(timeline).toContainText("が PR acme/reserve#");
    // レビューの往復: 必須の指摘と提案 → 開発が直したと返事 → 同じレビュアーが解決を確認して承認
    await expect(timeline).toContainText("のレビュー(1 回目): 差し戻し");
    await expect(timeline).toContainText("必須・重い");
    await expect(timeline).toContainText("提案");
    await expect(timeline.getByRole("list", { name: /指摘 \d+ のやりとり/ })).toContainText("(直した): 直した");
    await expect(timeline.getByRole("list", { name: /指摘 \d+ のやりとり/ })).toContainText("(解決を確認)");
    await expect(timeline).toContainText("のレビュー(2 回目): 承認");
    await expect(dialog.getByRole("region", { name: "チケットの中身" })).toContainText("R1 空き枠を探す");
    await dialog.getByLabel("メモを残す").fill("合意した画面の案 A に合わせて");
    await dialog.getByRole("button", { name: "メモを残す" }).click();
    await expect(timeline).toContainText("合意した画面の案 A に合わせて");
    // チケットごとの予算: 既定から変え、既定に戻せる
    const details = dialog.getByRole("region", { name: "チケットの中身" });
    await expect(details).toContainText("無制限(既定)");
    await details.getByRole("button", { name: "予算を変える" }).click();
    await details.getByRole("checkbox", { name: "このチケットの予算を無制限にする" }).uncheck();
    await details.getByLabel("このチケットの予算(ドル)").fill("7.5");
    await details.getByRole("button", { name: "決める" }).click();
    await expect(page.getByRole("status", { name: "お知らせ" })).toHaveText("予算を変えました");
    await expect(details).toContainText("$7.50");
    await expect(details).toContainText("(このチケットだけ)");
    await details.getByRole("button", { name: "予算を変える" }).click();
    await details.getByRole("button", { name: "既定(無制限)に戻す" }).click();
    await expect(details).toContainText("(既定)");
    await shot(page, "ticket");
    await dialog.getByRole("button", { name: "閉じる" }).click();
    await expect(dialog).toHaveCount(0);
    // 待たずに今 merge したいときは、棚から押せる
    await shelf.getByRole("button", { name: /を merge$/ }).first().click();
    await expect(page.getByRole("status", { name: "お知らせ" })).toHaveText("merge しました");
    await expect(shelf.getByRole("button", { name: /を merge$/ })).toHaveCount(1);
  });

  await test.step("リーダーと話す: 書いておくと、手すきのときに返事が来る", async () => {
    await page.getByRole("button", { name: "リーダーと話す", exact: true }).click();
    const chat = page.getByRole("complementary", { name: "リーダーと話す" });
    await chat.getByLabel("リーダーへのメッセージ").fill("進み具合はどう?");
    await chat.getByRole("button", { name: "送る" }).click();
    const log = chat.getByRole("list", { name: "リーダーとの会話" });
    await expect(log).toContainText("進み具合はどう?");
    // 始業したとき、リーダーが交通整理をして報告している
    await expect(log).toContainText(/【交通整理 #1, #2】/);
    await expect(log).toContainText("並列に進めるわ");
    await expect(log).toContainText(/#\d は今動いています/, { timeout: 20_000 });
    await shot(page, "leadchat");
  });

  await test.step("本部: 稼働中のプロジェクトとして出て、merge 待ちが「あなたの対応」に並ぶ", async () => {
    await page.getByRole("button", { name: "本部", exact: true }).click();
    const card = page.locator("article", { hasText: "予約サイト" });
    await expect(card.getByText("稼働中")).toBeVisible();
    await expect(page.getByRole("region", { name: "全プロジェクトのあなたの対応" })).toContainText("を merge できます");
  });
});

test("プロジェクトを作る画面: リポジトリの書式をその場で確かめ、名前が無ければ作らない", async ({ page }) => {
  await page.goto("/#/new");
  await page.getByLabel("リポジトリ 1").fill("not a repo");
  await expect(page.getByText("owner/repo の形で入力してください")).toBeVisible();
  await page.getByLabel("リポジトリ 1").fill("acme/valid");
  await expect(page.getByText("書式 OK")).toBeVisible();
  await page.getByRole("button", { name: "次へ: 企画スタジオ" }).click();
  await expect(page.getByText("名前を入れてください")).toBeVisible();
  await page.getByRole("button", { name: "やめる", exact: true }).click();
  await expect(page.getByRole("heading", { name: "本部", exact: true })).toBeVisible();
});

test("段階を省く・お任せにするときは、何が起きるかを見せてから選ばせる。要件は省けない", async ({ page }) => {
  await createProject(page, "省くテスト", "acme/skip");
  await expect(work(page).getByText("(要件は省けません)")).toBeVisible();
  await expect(work(page).getByRole("button", { name: "この段階を省く", exact: true })).toHaveCount(0);

  await gate(page, "インフラ").click();
  await work(page).getByRole("button", { name: "この段階を省く", exact: true }).click();
  await expect(work(page).getByText("インフラを省くと")).toBeVisible();
  await work(page).getByRole("button", { name: "やめる", exact: true }).click();
  await expect(work(page).getByText("インフラを省くと")).toBeHidden();
  await work(page).getByRole("button", { name: "この段階を省く", exact: true }).click();
  await work(page).getByRole("button", { name: "省いて進める", exact: true }).click();
  await expect(work(page).getByText("この段階は省いています")).toBeVisible();
  await expect(gate(page, "インフラ")).toContainText("省略");

  await gate(page, "アーキテクチャとデータ").click();
  await work(page).getByRole("button", { name: "お任せにする", exact: true }).click();
  await expect(work(page).getByText("アーキテクチャとデータをお任せにすると")).toBeVisible();
  await work(page).getByRole("button", { name: "お任せにする", exact: true }).click();
  await expect(work(page).getByText("お任せ中")).toBeVisible();
});

test("エクスポートした設計書を本部で読み込むと、新しいプロジェクトとして企画の中身が戻る", async ({ page }) => {
  await createProject(page, "復元テスト", "acme/restore");
  await page.getByLabel("メッセージ").fill("店舗の予約サイトを作りたい");
  await page.getByRole("button", { name: "送る", exact: true }).click();
  await expect(work(page).getByText("R1 空き枠を探す")).toBeVisible();
  await page.getByRole("button", { name: "作らない(推奨)", exact: true }).click();
  await page.getByRole("button", { name: "この版に合意する", exact: true }).click();
  await expect(gate(page, "要件")).toContainText("合意済み v1");
  await gate(page, "インフラ").click();
  await work(page).getByRole("button", { name: "この段階を省く", exact: true }).click();
  await work(page).getByRole("button", { name: "省いて進める", exact: true }).click();
  await expect(gate(page, "インフラ")).toContainText("省略");

  const download = page.waitForEvent("download");
  await page.getByRole("link", { name: "設計書をエクスポート(Markdown)" }).click();
  const file = await (await download).path();

  await page.getByRole("button", { name: "本部", exact: true }).click();
  await shot(page, "home");
  await page.getByLabel("設計書から復元").setInputFiles(file);
  await expect(page.getByRole("status", { name: "お知らせ" })).toHaveText("設計書からプロジェクトを復元しました");
  // 新しいプロジェクトの企画スタジオが開き、要件・未決の答え・進め方が戻っている
  await expect(page).toHaveURL(/#\/p\/\d+\/studio$/);
  await expect(page.getByText("復元テスト · 企画スタジオ")).toBeVisible();
  await expect(gate(page, "要件")).toContainText("合意済み v1");
  await expect(gate(page, "インフラ")).toContainText("省略");
  await gate(page, "要件").click();
  await expect(work(page).getByText("R1 空き枠を探す")).toBeVisible();
  await work(page).getByText("決まったこと(1)").click();
  await expect(work(page).getByText("予約の変更を作るか → 作らない")).toBeVisible();
  await expect(chat(page).getByText(/から復元しました/)).toBeVisible();

  // 本部には 2 つ並ぶ(元のプロジェクトはそのまま)
  await page.getByRole("button", { name: "本部", exact: true }).click();
  await expect(page.locator("article", { hasText: "復元テスト" })).toHaveCount(2);

  // Kuramoto の設計書でないファイルは断る
  await page.getByLabel("設計書から復元").setInputFiles({ name: "memo.md", mimeType: "text/markdown", buffer: Buffer.from("# ただのメモ") });
  await expect(page.getByRole("status", { name: "お知らせ" })).toContainText("Kuramoto が書き出した設計書ではありません");
});

test("編成と方針を変えると版が上がり、その版で動いたことが分かる。生産性の指標が見られる", async ({ page }) => {
  await createProject(page, "実験", "acme/experiment");
  await page.getByRole("group", { name: "プロジェクトの画面" }).getByRole("button", { name: "オフィス" }).click();

  await test.step("編成: レビューの島にセキュリティを足すと工程が変わり、適用すると v2 になる", async () => {
    await page.getByRole("button", { name: "編成", exact: true }).click();
    const drawer = page.getByRole("complementary", { name: "編成" });
    await expect(drawer.locator(".preview")).toHaveText("工程: 開発 → レビュー → merge 待ち");
    await drawer.getByRole("group", { name: "島 2 の役割" }).getByText("セキュリティ").click();
    await expect(drawer.locator(".preview")).toHaveText("工程: 開発 → レビュー → セキュリティ → merge 待ち");
    await shot(page, "team-formation");
    // 開発を外すと、理由が出て適用できない
    await drawer.getByRole("group", { name: "島 1 の役割" }).getByText("開発").click();
    await expect(drawer.getByRole("list", { name: "編成の問題" })).toContainText("開発の役割は必須です");
    await expect(drawer.getByRole("button", { name: "編成 v2 を適用" })).toBeDisabled();
    await drawer.getByRole("group", { name: "島 1 の役割" }).getByText("開発").click();
    // 3 つ目の島を足し、同じ開発の役割を持たせる
    await drawer.getByRole("button", { name: "+ 島を足す(6 つまで)" }).click();
    await expect(drawer.getByRole("list", { name: "編成の問題" })).toContainText("島 3: 役割がありません");
    await drawer.getByRole("group", { name: "島 3 の役割" }).getByText("開発").click();
    // 島 3 だけ Haiku 5.5 / low で動かす(ほかの島は役割の方針どおり)
    await drawer.getByLabel("モデル").nth(2).selectOption({ label: "Haiku 5.5" });
    await drawer.getByLabel("考える深さ").nth(2).selectOption("low");
    await drawer.getByLabel("この島で重視すること").nth(2).fill("小さく速く");
    await drawer.getByRole("button", { name: "編成 v2 を適用" }).click();
    await expect(page.getByRole("status", { name: "お知らせ" })).toHaveText("編成 v2 を適用しました");
    await page.getByRole("group", { name: "オフィスの見方" }).getByRole("button", { name: "ボード" }).click();
    await expect(page.getByRole("region", { name: "ボード" }).getByRole("heading", { name: /セキュリティ/ })).toBeVisible();
    // 開発は「未着手」と「開発中」に分かれている
    await expect(page.getByRole("region", { name: "ボード" }).getByRole("heading", { name: /^未着手/ })).toBeVisible();
    await expect(page.getByRole("region", { name: "ボード" }).getByRole("heading", { name: /^開発中/ })).toBeVisible();
    // ツリー: 待ちのつながりと、ほかのチケットが出る
    await page.getByRole("group", { name: "オフィスの見方" }).getByRole("button", { name: "ツリー" }).click();
    await expect(page.getByRole("region", { name: "ツリー" }).getByRole("region", { name: "ほかのチケット" })).toBeVisible();
    await page.getByRole("group", { name: "オフィスの見方" }).getByRole("button", { name: "オフィス" }).click();
    // 床にも島が 3 つ並ぶ
    await expect(page.getByRole("region", { name: "オフィスの床" }).getByRole("region", { name: /^島 / })).toHaveCount(3);
    await expect(page.getByRole("region", { name: "編成", exact: true })).toContainText("編成 v2");
    await expect(page.getByRole("region", { name: "編成", exact: true })).toContainText("島 3 開発 · 3/3 人 · Haiku 5.5 / low");
  });

  await test.step("方針: 開発を Sonnet 5.5 にして保存すると、次の実装はそのモデルで動く", async () => {
    await page.getByRole("button", { name: "チームの方針", exact: true }).click();
    const drawer = page.getByRole("complementary", { name: "チームの方針" });
    await expect(drawer.getByRole("tab", { name: "開発", exact: true })).toHaveAttribute("aria-selected", "true");
    await drawer.getByLabel("モデル").selectOption({ label: "Sonnet 5.5" });
    await drawer.getByLabel("重視すること").fill("既存の書き方に合わせる");
    await shot(page, "team-policy");
    await drawer.getByRole("button", { name: "v2 として保存" }).click();
    await expect(page.getByRole("status", { name: "お知らせ" })).toContainText("開発の方針を v2 として保存しました");
    await expect(drawer.getByRole("button", { name: "v3 として保存" })).toBeDisabled();

    await page.getByLabel("タイトル").fill("CSV を書き出す");
    await page.getByRole("button", { name: "足す", exact: true }).click();
    await page.getByRole("banner").getByRole("switch", { name: "稼働" }).click();
    await expect(page.getByRole("region", { name: "出来事" })).toContainText("が実装を始めました(Sonnet 5.5)", { timeout: 20_000 });
  });

  await test.step("生産性: トークン・金額・PR・手戻り・助けを求めた数が出て、日ごとの推移も見られる", async () => {
    await expect(page.getByRole("region", { name: "出来事" })).toContainText("PR #", { timeout: 20_000 });
    await page.getByRole("group", { name: "プロジェクトの画面" }).getByRole("button", { name: "生産性" }).click();
    const tiles = page.getByRole("list", { name: "合計" });
    await expect(tiles.getByRole("listitem", { name: "PR" })).toContainText(/^PR1/);
    await expect(tiles.getByRole("listitem", { name: "消費トークン" })).not.toContainText(/^消費トークン0/);
    await expect(tiles.getByRole("listitem", { name: "人間に助けを求めた" })).toBeVisible();
    await expect(tiles.getByRole("listitem", { name: "手戻り" })).toBeVisible();
    // 日ごとの推移: グラフと表を切り替えられる
    await expect(page.getByRole("tab", { name: "日ごとの推移" })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("figure", { name: "使った金額の日ごとの推移" })).toBeVisible();
    await expect(page.getByRole("figure", { name: "出した PRの日ごとの推移" })).toBeVisible();
    await page.getByRole("group", { name: "表示" }).getByRole("button", { name: "表" }).click();
    await expect(page.getByRole("table", { name: "日ごとの推移の表" }).getByRole("row")).toHaveCount(2);
    await expect(page.getByRole("figure", { name: "使った金額の日ごとの推移" })).toHaveCount(0);
    // 金額の内訳: 何の仕事に・どのモデルに・誰に(表 → グラフ)
    await page.getByRole("tab", { name: "金額の内訳" }).click();
    await expect(page.getByRole("table", { name: "何の仕事にかかったか" })).toContainText("実装");
    await page.getByRole("group", { name: "表示" }).getByRole("button", { name: "グラフ" }).click();
    await expect(page.getByRole("list", { name: "何の仕事にかかったか" }).getByRole("listitem", { name: "実装" })).toContainText("$");
    await expect(page.getByRole("list", { name: "どのモデルにかかったか" }).getByRole("listitem", { name: "Sonnet 5.5" })).toBeVisible();
    await expect(page.getByRole("list", { name: "どの役割にかかったか" }).getByRole("listitem", { name: "開発" })).toBeVisible();
    await shot(page, "productivity-cost");
    // チケットごと
    await page.getByRole("tab", { name: "チケットごと" }).click();
    await expect(page.getByRole("list", { name: "チケットごとの金額" })).toContainText("CSV を書き出す");
    await page.getByRole("group", { name: "表示" }).getByRole("button", { name: "表" }).click();
    await expect(page.getByRole("table", { name: "チケットごとの指標" })).toContainText("CSV を書き出す");
    await shot(page, "productivity");
  });
});

test("チームの方針の開発ルール: ひな形から足す・空のルールを足す・無効にする。生産性にルール違反が出る", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await createProject(page, "ルール", "acme/rules");
  await page.getByRole("group", { name: "プロジェクトの画面" }).getByRole("button", { name: "オフィス" }).click();
  await page.getByRole("button", { name: "チームの方針", exact: true }).click();
  const drawer = page.getByRole("complementary", { name: "チームの方針" });
  await drawer.getByRole("tab", { name: "開発ルール" }).click();
  const list = drawer.getByRole("list", { name: "ルール" });
  await expect(drawer.getByText("ルール(有効 0 / 0)")).toBeVisible();

  await test.step("ひな形から足すと、一覧に有効で入り、ひな形は押せなくなる", async () => {
    await drawer.getByRole("button", { name: "+ Jira 番号をそろえる" }).click();
    await expect(page.getByRole("status", { name: "お知らせ" })).toContainText("「Jira 番号をそろえる」を足しました");
    await expect(list.getByRole("listitem")).toHaveCount(1);
    await expect(list.getByRole("switch", { name: "Jira 番号をそろえるを有効にする" })).toHaveAttribute("aria-checked", "true");
    await expect(drawer.getByRole("button", { name: "✓ Jira 番号をそろえる" })).toBeDisabled();
    await expect(drawer.getByText("ルール(有効 1 / 1)")).toBeVisible();
    await expect(drawer.getByRole("group", { name: "どこに効くか" }).getByRole("button", { name: "✓ ブランチ名" })).toBeVisible();
  });

  await test.step("空のルールは、名前・どこに効くか・確かめ方がそろうまで足せない", async () => {
    await drawer.getByRole("button", { name: "+ 空のルールを足す" }).click();
    const add = drawer.getByRole("button", { name: "このルールを足す" });
    await expect(add).toBeDisabled();
    await drawer.getByLabel("名前").fill("README を更新する");
    await drawer.getByLabel("何を守るか").fill("機能を足したら README の使い方も直す。");
    await drawer.getByRole("group", { name: "どこに効くか" }).getByRole("button", { name: "変更したファイル" }).click();
    await drawer.getByRole("radiogroup", { name: "確かめ方" }).getByRole("radio", { name: "AI が読む" }).click();
    await drawer.getByRole("radiogroup", { name: "違反したとき" }).getByRole("radio", { name: "レビューで指摘" }).click();
    await expect(drawer.getByRole("tab", { name: /開発ルール/ })).toContainText("1");
    await shot(page, "dev-rules");
    await add.click();
    await expect(list.getByRole("listitem")).toHaveCount(2);
    await expect(list).toContainText("README を更新する");
    await expect(drawer.getByText("ルール(有効 2 / 2)")).toBeVisible();
  });

  await test.step("無効にすると押せない見た目になり、有効の数が減る。もう一度押すと戻る", async () => {
    const sw = list.getByRole("switch", { name: "Jira 番号をそろえるを有効にする" });
    await sw.click();
    await expect(sw).toHaveAttribute("aria-checked", "false");
    await expect(list.getByRole("listitem").first()).toHaveAttribute("aria-disabled", "true");
    await expect(drawer.getByText("ルール(有効 1 / 2)")).toBeVisible();
    await sw.click();
    await expect(sw).toHaveAttribute("aria-checked", "true");
  });

  await test.step("生産性に「ルール違反 / うち自動で直した」が出る", async () => {
    await page.getByRole("group", { name: "プロジェクトの画面" }).getByRole("button", { name: "生産性" }).click();
    const tile = page.getByRole("list", { name: "合計" }).getByRole("listitem").filter({ hasText: "ルール違反" });
    await expect(tile).toContainText("0");
    await expect(tile).toContainText("うち自動で直した 0");
  });
});

test("プロジェクトの設定で、名前とリポジトリを変えられる", async ({ page }) => {
  await createProject(page, "設定テスト", "acme/settings-web");
  await page.getByRole("group", { name: "プロジェクトの画面" }).getByRole("button", { name: "設定" }).click();
  await expect(page.getByLabel("名前")).toHaveValue("設定テスト");
  await expect(page.getByRole("button", { name: "保存する" })).toBeDisabled();
  await page.getByLabel("名前").fill("設定テスト 2");
  await page.getByRole("button", { name: "+ リポジトリを足す" }).click();
  await page.getByLabel("リポジトリ 2", { exact: true }).fill("bad repo");
  await expect(page.getByText("owner/repo の形で入力してください")).toBeVisible();
  await expect(page.getByRole("button", { name: "保存する" })).toBeDisabled();
  await page.getByLabel("リポジトリ 2", { exact: true }).fill("acme/settings-api");
  await page.getByLabel("リポジトリ 2 の役割").selectOption("API");
  // 新しいプロジェクトは、ノンストップ・自動 merge・チケットの予算は無制限から始まる(ADR-0022)
  await expect(page.getByRole("checkbox", { name: /ノンストップで進める/ })).toBeChecked();
  await expect(page.getByRole("checkbox", { name: /チームが自動で merge する/ })).toBeChecked();
  await expect(page.getByRole("checkbox", { name: "チケット 1 枚の予算を無制限にする" })).toBeChecked();
  await page.getByRole("checkbox", { name: "チケット 1 枚の予算を無制限にする" }).uncheck();
  await page.getByLabel("チケット 1 枚の予算(ドル)").fill("0");
  await expect(page.getByText("0 より大きい金額を入れるか、無制限にしてください")).toBeVisible();
  await expect(page.getByRole("button", { name: "保存する" })).toBeDisabled();
  await page.getByLabel("チケット 1 枚の予算(ドル)").fill("8");
  // 全体の予算は既定で無制限。金額を決められる
  await expect(page.getByRole("checkbox", { name: "全体の予算を無制限にする" })).toBeChecked();
  await page.getByRole("checkbox", { name: "全体の予算を無制限にする" }).uncheck();
  await page.getByLabel("全体の予算(ドル)").fill("200");
  await page.getByRole("button", { name: "保存する" }).click();
  await expect(page.getByRole("status", { name: "お知らせ" })).toHaveText("プロジェクトの設定を保存しました");
  await expect(page.getByLabel("全体の予算(ドル)")).toHaveValue("200");
  await expect(page.getByLabel("チケット 1 枚の予算(ドル)")).toHaveValue("8");
  // チケット 1 枚の予算を無制限にする
  await page.getByRole("checkbox", { name: "チケット 1 枚の予算を無制限にする" }).check();
  await page.getByRole("button", { name: "保存する" }).click();
  await expect(page.getByRole("checkbox", { name: "チケット 1 枚の予算を無制限にする" })).toBeChecked();
  await expect(page.getByRole("navigation", { name: "場所" })).toContainText("設定テスト 2");

  await page.getByRole("button", { name: "本部", exact: true }).click();
  const card = page.locator("article", { hasText: "設定テスト 2" });
  await expect(card).toContainText("acme/settings-web");
  await expect(card).toContainText("acme/settings-apiAPI");
});

test("オフィスの床から島を足し、設定を変え、外せる。キャラクターが座っている", async ({ page }) => {
  await createProject(page, "島", "acme/island");
  await page.getByRole("group", { name: "プロジェクトの画面" }).getByRole("button", { name: "オフィス" }).click();
    const floor = page.getByRole("region", { name: "オフィスの床" });
    await floor.getByRole("button", { name: /島を足す/ }).click();
    const dlg = page.getByRole("dialog", { name: "島を足す" });
    await expect(dlg.getByRole("list", { name: "編成の問題" })).toContainText("役割がありません");
    await expect(dlg.getByRole("button", { name: "この島を足す" })).toBeDisabled();
    await dlg.getByLabel(/の名前$/).fill("QA の島");
    await dlg.getByText("QA", { exact: true }).click();
    await expect(dlg.locator(".preview")).toHaveText("工程: 開発 → レビュー → QA → merge 待ち");
    await shot(page, "island-add");
    await dlg.getByRole("button", { name: "この島を足す" }).click();
    await expect(page.getByRole("status", { name: "お知らせ" })).toContainText("編成 v2 を適用しました");
    await expect(floor.getByRole("region", { name: "島 QA の島" })).toBeVisible();
    await shot(page, "office-cute");
    // 開発の島は外せない(開発の役割は必須)
    await floor.getByRole("button", { name: "開発の島 の設定" }).click();
    const dev = page.getByRole("dialog", { name: "開発の島 の設定" });
    await expect(dev.getByRole("button", { name: "この島を外す" })).toBeDisabled();
    await dev.getByRole("button", { name: "閉じる" }).click();
    await floor.getByRole("button", { name: "QA の島 の設定" }).click();
    await page.getByRole("dialog", { name: "QA の島 の設定" }).getByRole("button", { name: "この島を外す" }).click();
    await expect(floor.getByRole("region", { name: "島 QA の島" })).toHaveCount(0);
});
