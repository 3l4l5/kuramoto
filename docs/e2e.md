# 画面の E2E テスト

ブラウザ(Google Chrome)で画面を操作して、主な操作が通ることを確かめるテストです(Playwright)。「押しても何も出ない」のような画面の壊れを、merge の前に見つけるためにあります。サーバー側の流れの確かめは `src/flow-e2e.test.ts` です。

## 流し方

```sh
npm run test:e2e                          # 画面を作り直して、全部流す(手元の Google Chrome を使う)
E2E_PORT=4493 npm run test:e2e            # ポートを変える(既定 4390。ほかの作業場所と重なるとき)
npx playwright test e2e/policy.spec.ts    # 1 つのファイルだけ(画面は先に npm run build:ui で作る)
npx playwright test -g "編成"             # 名前で絞る
E2E_SHOTS=/tmp/shots npm run test:e2e     # 画面ごとのスクリーンショットを残す(お手本との見比べ用)
```

- テスト用のサーバー(`e2e/server.ts`)は、本物の Claude と GitHub を使わず、台本どおりに動くフェイクの担当で動きます。データは回ごとの空の置き場所で、プロジェクトはテストの中で作ります。
- 落ちたときの画面・手順は `test-results/` に残ります(git には入りません)。

## チームの CI

`npm test` の最後の回が E2E です(SQLite の回 → MySQL の回 → E2E の回)。チームの CI は `npm test` を閉じ込め(sandbox-runtime)の中で流します。閉じ込めの中では Chrome は起動できない(プロファイル・ソケット・Crashpad の置き場所が書けない)ので、**ブラウザはブラウザ専用の狭い閉じ込めの中で別に立てて、`npm test` の側からは繋ぐだけ**にしています。`npm test` の閉じ込め(`src/project/confine.ts`)は広げていません。

1. チームの CI の runner(`src/project/team-ci.ts` の `SandboxRunner`)が、playwright の設定(`playwright.config.*`)があるリポジトリのテストのコマンド(`npm test`・`npm run test:e2e`)の前に、Playwright のブラウザサーバー(`chromium.launchServer()`、Google Chrome)を、**ブラウザ専用の狭い閉じ込め**の中で立てる(`src/project/confined-browser.ts`)。リポジトリの `@playwright/test` で立てるので、繋ぐ側と版が必ずそろう。
   - 書ける: Chrome のプロファイル用の一時ディレクトリ(`/tmp/kuramoto-pw-…`)だけ。リポジトリにも書けない
   - 読める: ホームの下は、node のツールチェーン・リポジトリの `node_modules` と `package.json`・Playwright のブラウザの置き場所だけ。ホーム(`~/.kuramoto`・`~/.ssh` など)は読めない
   - つながる: localhost だけ(許すドメインは無く、プロキシの環境変数も外す)
2. その `wsEndpoint` を環境変数 `KURAMOTO_E2E_WS_ENDPOINT` で、中の `npm test` に渡す。コマンドが終わったら(落ちても時間切れでも)必ずブラウザサーバーを閉じ、一時ディレクトリを消す。
3. 中では、`playwright.config.ts` が `connectOptions` で、渡された宛先に connect する(Chrome は起動しない)。画面を配るサーバー(`e2e/server.ts`)は `npm test` の側で立て、ブラウザが `localhost` で開く。
4. `KURAMOTO_E2E_WS_ENDPOINT` が渡されたときは、ブラウザに繋がらないことも**失敗**にする(「確かめていない」で通さない)。
5. **狭い閉じ込めの中でブラウザが立たなかったときは、閉じ込めの無いブラウザには切り替えない。** 宛先を渡さずに `npm test` を流し(出力の末尾に「⚠ チームの CI: ブラウザ専用の狭い閉じ込めの中でブラウザを起動できなかった…」と理由が付く)、E2E の回は手元の閉じ込めの中と同じ「⚠ ブラウザを起動できなかったので、画面の確かめは流していません」で通る。このときは画面の E2E は流れていないので、出力の知らせを見落とさないこと。

### 閉じ込めの確かめ

Kuramoto のサーバー(Chrome が動く場所)で、次を流します。閉じ込めの中(agent の作業場所など)からは閉じ込めを重ねられないので流せません。

```sh
npx tsx scripts/check-confined-browser.ts [リポジトリのパス]          # チームの CI と同じ実行で E2E が通る + 接続した側からの攻撃がどれも失敗する
npx tsx scripts/check-confined-browser.ts [リポジトリのパス] --break  # わざと入口を壊すと落ちる
```

接続した側からの確かめは、`file://` で `~/.kuramoto` の中のファイル(`access-token`)と `~/.ssh` の鍵を開く・`newContext({ proxy })` で外へ出る・`newRequest`(ローカルの playwright と、ブラウザ側の `context.request`)で外の URL を取る、がどれも失敗することと、対照として `package.json` と localhost には繋がることを見ます。終了コードは 0 = 通った / 1 = 落ちた / 2 = 確かめられなかった(ブラウザが起動できなかった)。

- 閉じ込めの中から `127.0.0.1` に届かない設定(プロジェクトの設定 `sandbox_strict_sockets` = 1)では、E2E そのものが動かないので、ブラウザサーバーは立てません(手元と同じ「確かめていない」の知らせになります)。
- 手元の実行(`KURAMOTO_E2E_WS_ENDPOINT` が無い): E2E の回は、先に Chrome を 1 回起動できるか確かめます。起動できれば流し、落ちたら画面の壊れとして失敗にします(`test-results/` に落ちた画面と手順が残ります)。起動できないとき(手元の閉じ込めの中など)は、画面が壊れたのではないので、失敗にせず「⚠ ブラウザを起動できなかったので、画面の確かめは流していません」と出して通します。起動できないことも失敗にするには `KURAMOTO_E2E_REQUIRE_BROWSER=1`。
- E2E の回は、MySQL の使い捨ての database を消したあとに、空いているポートを選んで、画面を作り直してから流します。全体で 12 分(`playwright.config.ts` の `globalTimeout`)を超えたら止めます。チームの CI の時間切れ(既定 20 分)に収まらないときは、E2E を `npm test` から外して、プロジェクトの設定の CI コマンドに `npm run test:e2e` を別に足します。
- 試験のファイルを絞って流すとき(`npm test src/foo.test.ts`)は E2E の回を流しません。回ごと飛ばすと決めているときだけ、`KURAMOTO_SKIP_E2E_TESTS=1 npm test` と明示します(黙って飛ばしません)。

## ファイルの分け方

| ファイル | 中身 |
|---|---|
| `browser.ts` | E2E が使うブラウザの指定と、ブラウザサーバーの宛先の環境変数(`playwright.config.ts` と、`npm test` の「繋がるか」の確かめで共通) |
| `helpers.ts` | 共通の道具。プロジェクトを作る・種類つきのチケットを用意する・画面の幅(`PC` 1280px・`PHONE` 390px)・ヘッダー/下のタブ/引き出しの場所 |
| `entrances.spec.ts` | 入口。共通ヘッダーと下のタブの行き先、編成の引き出しのタブ、ボードの絞り込みとチケット詳細 |
| `policy.spec.ts` | チームの方針の入口(オフィス・チケット詳細・スマホのメニュー)と、開発ルールの選択・下書きを捨てるときの確かめ |
| `phone.spec.ts` | スマホ(390px)で全画面が横にはみ出さないこと、あなたの対応・ボード・チケット詳細 |
| `app.spec.ts` | 業務の流れ(企画 → チームへ → merge)と、編成・生産性・設定・種類・お手本との見比べ |
| `server.ts` / `screens.ts` | フェイクの担当で動くテスト用サーバーと、撮り直し用のデータ |

## 書き方

- **場所は role と名前で指す**: `getByRole("button", { name: "編成", exact: true })`・`getByRole("complementary", { name: "チームの方針" })`・`getByLabel("名前")`。クラス名・並び順(`nth`)・見た目の文字の一部には頼りません。画面の作りが変わっても壊れにくくするためです。名前が部分一致で重なるときは `exact: true`。
- **共通ヘッダーの場所は `helpers.ts` を通す**: `screens(page)`(切り替えスイッチ全体。企画スタジオ・生産性・設定と、その中の見方)、`views(page)`(オフィス/ボード/ツリー。選ばれているのは `aria-pressed`、いまの画面は `aria-current`)、`headerDrawer(page, "編成")`。ヘッダーの作りが変わったら、`helpers.ts` の 1 か所を直します。
- **幅を決める**: パソコンは `page.setViewportSize(PC)`、スマホは `PHONE`(ファイル全体なら `test.use({ viewport: PHONE })`)。ヘッダーのボタンはスマホでは隠れ、下のタブとメニューが同じ行き先を持ちます。両方の幅で通す操作は、`openDrawer(page, "pc" | "phone", "編成")` のように幅の違いを helpers に閉じ込めて、同じ中身のテストを 2 回回します。
- **待つのは `expect`**: 固定の待ち時間(`waitForTimeout`)は使いません。`expect(...).toBeVisible()` などは自動でやり直して待ちます。
- **データは API で作る**: 画面で作る必要のない前提(チケットなど)は `page.request.post(...)` で作ります(書き込みには `WRITE` の印が要ります)。
- **テストは独立に**: テストごとに `createProject(page, 名前, "acme/…")` で新しいプロジェクトを作ります。ほかのテストの結果に頼りません。

## 入口を足す手順

1. 画面の入口(ボタン・メニューの行き先)を足したら、`entrances.spec.ts` に、パソコンとスマホで「押す → 何かが見える」を 1 つずつ足します(見えるのは、画面の `aria-label` の領域か、引き出しの見出しなど)。
2. 引き出しなら `openDrawer` を使い、閉じるまで確かめます。
3. 足したテストを、**わざと入口を壊して**(たとえばボタンの `onClick` を消して)落ちることを確かめてから、直して通します。

## 入口が壊れたときの確かめ方

テストが本当に壊れを見つけるかは、壊して確かめます。たとえば `ui/src/PhoneBar.tsx` の `drawerTo("policy")` を `drawerTo(null)` にして `npm run test:e2e` を流すと、`policy.spec.ts` の 390px のテストが落ちるはずです。
