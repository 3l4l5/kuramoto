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

- 本体は localhost からも合言葉を求める(ADR-0059)ので、テスト用のサーバーには固定の合言葉(`e2e/token.ts`)を渡し、`playwright.config.ts` が `Authorization: Bearer` で渡す。合言葉なしの確かめは `e2e/auth.spec.ts`(その中だけ渡さない)。撮り直しのときにブラウザで開くなら、サーバーが出す `?token=` つきの URL を使う。
- テスト用のサーバー(`e2e/server.ts`)は、本物の Claude と GitHub を使わず、台本どおりに動くフェイクの担当で動きます。データは回ごとの空の置き場所で、プロジェクトはテストの中で作ります。
- 落ちたときの画面・手順は `test-results/` に残ります(git には入りません)。

## チームの CI

`npm test` の最後の回が E2E です(SQLite の回 → MySQL の回 → E2E の回)。チームの CI は `npm test` を閉じ込め(sandbox-runtime)の中で流します。閉じ込めの中では Chrome は起動できない(プロファイル・ソケット・Crashpad の置き場所が書けない)ので、`npm test` の閉じ込め(`src/project/confine.ts`)は広げず、ブラウザは別に立てて繋ぐ作りにしています。

**ただし、そのブラウザサーバーを立てる経路は、既定では動きません**(環境変数 `KURAMOTO_E2E_CONFINED_BROWSER=1` のときだけ動く)。狭い閉じ込めの中で Chrome が実際に起動するかを、CI の macOS ランナー(Chrome が動く場所)で流した記録がまだ表に無いためです(下の「閉じ込めの確かめ」)。**既定を「設定なし」のままにする判断(#96)**: CI の macOS ランナーで、狭い閉じ込めの中の Chrome の起動と、閉じ込めの制限(下の (iii))を確かめた記録が、まだありません(下の「確かめの記録」)。閉じ込めの制限が効いている確かめが無いまま、PR のコードが動く場所の近くでブラウザサーバーを既定で立てるのは、隠しているファイルを読まれる・外へ送られる危険の方が大きいので、既定は動かさないままにします。記録で (i)(ii)(iii) がすべて通ったら、`confinedBrowserEnabled`(`src/project/confined-browser.ts`)の既定を反転し、この段落を書き換えます。

- **既定(設定が無い)**: ブラウザサーバーは立てず、`KURAMOTO_E2E_WS_ENDPOINT` も渡さない。E2E の回は、手元の閉じ込めの中と同じに、先に Chrome を 1 回起動できるか確かめる。起動できなければ「⚠ ブラウザを起動できなかったので、画面の確かめは流していません」と出して**通す**(チームの CI では今は、画面の E2E は流れない)。閉じ込めの無いブラウザが動く経路は無い。
- **`KURAMOTO_E2E_CONFINED_BROWSER=1`(Kuramoto のサーバーの環境変数)**: チームの CI の runner(`src/project/team-ci.ts` の `SandboxRunner`)が、playwright の設定(`playwright.config.*`)があるリポジトリのテストのコマンド(`npm test`・`npm run test:e2e`)の前に、Playwright のブラウザサーバー(`chromium.launchServer()`、Google Chrome)を**ブラウザ専用の狭い閉じ込め**の中で立てる(`src/project/confined-browser.ts`)。リポジトリの `@playwright/test` で立てるので、繋ぐ側と版が必ずそろう。
  - 書ける: Chrome のプロファイル用の一時ディレクトリ(`/tmp/kuramoto-pw-…`)だけ。リポジトリにも書けない
  - 読める: ホームの下は、node のツールチェーン・リポジトリの `node_modules` と `package.json`・Playwright のブラウザの置き場所だけ。ホーム(`~/.kuramoto`・`~/.ssh` など)は読めない
  - つながる: localhost だけ(許すドメインは無く、プロキシの環境変数も外す)
  - その `wsEndpoint` を `KURAMOTO_E2E_WS_ENDPOINT` で `npm test` に渡し、コマンドが終わったら(落ちても時間切れでも)必ずブラウザサーバーを閉じ、一時ディレクトリを消す。
  - 中では、`playwright.config.ts` が `connectOptions` で、渡された宛先に connect する(Chrome は起動しない)。画面を配るサーバー(`e2e/server.ts`)は `npm test` の側で立てる。宛先が渡されたときは、ブラウザに繋がらないことも**失敗**にする(「確かめていない」で通さない)。
  - **狭い閉じ込めの中でブラウザが立たなかったときも、閉じ込めの無いブラウザには切り替えない。** 宛先を渡さずに `npm test` を流し(出力の末尾に「⚠ チームの CI: ブラウザ専用の狭い閉じ込めの中でブラウザを起動できなかった…」と理由が付く)、既定と同じ「確かめていない」で通る。

### 閉じ込めの確かめ(CI の macOS ランナーで流す)

閉じ込めの中(担当・レビューの作業場所など)からは閉じ込めを重ねられないので、そこでは流せません。**実機のログは、GitHub Actions のワークフロー `confinement-check`(`.github/workflows/confinement-check.yml`)が macOS のランナー(`macos-latest`。`sandbox-exec` と Google Chrome がある)で流し、artifact `e2e-logs` に残します。責任者が手で流す手順はありません。** このスクリプトは `KURAMOTO_E2E_CONFINED_BROWSER=1` を自分で付けて、チームの CI と同じ実行(`SandboxRunner`)をします。

ワークフローが流すもの(手元の Mac でも、同じコマンドを流せます):

```sh
npx tsx scripts/check-confined-browser.ts [リポジトリのパス]          # (i) と (iii)
npx tsx scripts/check-confined-browser.ts [リポジトリのパス] --break  # (ii)
npx tsx scripts/check-confined-browser.ts [リポジトリのパス] --no-browser-server  # 設定なしの回(既定の振る舞いのログ)
```

`--no-browser-server` は `KURAMOTO_E2E_CONFINED_BROWSER` を付けずに、同じ実行(`SandboxRunner`)で `npm test` を流します。Chrome が閉じ込めの中で起動できなければ `△ 設定なし: …(知らせて通った)`、起動できて E2E が流れれば `○ 設定なし: …`(終了コード 0 で、知らせが無く、E2E の「N passed」が出力にあり、飛ばした件数を足して、事前に `playwright test --list` で数えた件数と合うときだけ)、それ以外は `? 設定なし: E2E が流れたか分からない` と出ます。終了コードは `npm test` が通れば 0、落ちたら 1。

読み方(3 つとも通れば、チームの CI で `KURAMOTO_E2E_CONFINED_BROWSER=1` を有効にしてよい):

1. **(i) E2E が通る**: 出力の末尾に `--- npm test の終了コード: 0` と `○ E2E N 件が通った` が出る(N は `playwright test --list` で数えた件数で、スクリプトが流す前に出す。試験を足しても決め打ちは直さなくてよい)。出力に Playwright の「N passed」が無い、または通った件数に飛ばした件数(`N skipped`。お手本の画像が無い環境では、`app.spec.ts` のオフィスの床の 1 件が飛ぶ)と flaky を足しても数えた件数と合わないと `△`(E2E が流れていない・一部が流れていない)。飛ばした件数は `○ E2E 16 件が通った・1 件は飛ばした(…一致)` のように出る。
2. **(ii) 入口を壊すと落ちる**(`--break`): `ui/src/PhoneBar.tsx` の `drawerTo("policy")` を `drawerTo(null)` にして同じ実行をし、`○ 入口を壊すと落ちた` が出る(終わったら元に戻す)。`✗ 入口を壊したのに通った` なら、E2E が画面を確かめていない。
3. **(iii) 接続した側からの攻撃がどれも失敗する**: 次の行がすべて `○` になる。
   - `file://` で `~/.kuramoto` の確かめ用ファイルと `~/.kuramoto/access-token`、`~/.ssh` の鍵を開けない
   - 読める場所(リポジトリの `node_modules`)の中に置いた、`~/.kuramoto`・`~/.ssh` へのシンボリックリンク(ファイルへのリンクと、ディレクトリへのリンク)経由でも、同じファイルを開けない(許した場所がリンクで広がらない)。対照として、許した場所(`package.json`)を指すリンクは開ける。リンクは確かめの間だけ `node_modules/.kuramoto-probe-links/` に置き、終わったら消す
   - `newContext({ proxy })` で外のプロキシ経由の通信ができない
   - `newRequest`(ローカルの playwright の `request.newContext` と、ブラウザ側の `context.request`)で外の URL を取れない
   - 対照として、リポジトリの `package.json` と localhost の確かめ用サーバーには繋がる(ブラウザそのものが壊れて「失敗」しているのではないことを見る)。`✗` が 1 つでもあれば閉じ込めに穴がある。

終了コード: **0** = 通った / **1** = 落ちた(E2E の失敗、`--break` で落ちなかった、閉じ込めの穴) / **2** = 確かめられなかった(狭い閉じ込めの中でブラウザを起動できなかった・確かめが動かなかった。出力の理由を見る)。2 のときは有効にせず、別の形を考える。

- 閉じ込めの中から `127.0.0.1` に届かない設定(プロジェクトの設定 `sandbox_strict_sockets` = 1)では、E2E そのものが動かないので、ブラウザサーバーは立てません(手元と同じ「確かめていない」の知らせになります)。
- 手元の実行(`KURAMOTO_E2E_WS_ENDPOINT` が無い): E2E の回は、先に Chrome を 1 回起動できるか確かめます。起動できれば流し、落ちたら画面の壊れとして失敗にします(`test-results/` に落ちた画面と手順が残ります)。起動できないとき(手元の閉じ込めの中など)は、画面が壊れたのではないので、失敗にせず「⚠ ブラウザを起動できなかったので、画面の確かめは流していません」と出して通します。起動できないことも失敗にするには `KURAMOTO_E2E_REQUIRE_BROWSER=1`。
- E2E の回は、MySQL の使い捨ての database を消したあとに、空いているポートを選んで、画面を作り直してから流します。全体で 12 分(`playwright.config.ts` の `globalTimeout`)を超えたら止めます。チームの CI の時間切れ(既定 20 分)に収まらないときは、E2E を `npm test` から外して、プロジェクトの設定の CI コマンドに `npm run test:e2e` を別に足します。
- 試験のファイルを絞って流すとき(`npm test src/foo.test.ts`)は E2E の回を流しません。回ごと飛ばすと決めているときだけ、`KURAMOTO_SKIP_E2E_TESTS=1 npm test` と明示します(黙って飛ばしません)。

### 確かめの記録

流した出力の全文は [`docs/e2e-logs/`](e2e-logs/README.md) に置き、流した日・環境(OS・Chrome の版・Kuramoto のコミット)・流した場所(CI)とログのファイルを、ここの表に書きます。**ログは、ワークフロー `confinement-check` の artifact `e2e-logs`(7 本の `.log`)から取ります**(責任者が実機で流す形ではありません。Actions の画面の実行ページの「Artifacts」から落とすか、`gh run download <run-id> -n e2e-logs`)。取れたら表を埋めて、既定を設定ありにするかを決めます(#96・#98・#101 から引き継いだ確かめを含む)。実行手順・ログのファイル名・ログを見るときの照合の手順は [`docs/e2e-logs/README.md`](e2e-logs/README.md) にあります。

#### ワークフロー `confinement-check`

- **起動のきっかけ**: `workflow_dispatch`(Actions の画面・`gh workflow run confinement-check` から手動で)と、閉じ込め・認証まわり(`src/project/confine*`・`team-ci*`・`confined-browser*`・`local-ports*`・`src/server.ts`・`src/access-token*`・`src/sessions*`・認証の案内を出す `ui/src/App.tsx`・`SessionPanel.tsx`・`api.ts`・`e2e/**`・`playwright.config.ts`・`scripts/check-*`・`scripts/e2e-count*`・`scripts/run-tests*`・このワークフロー)を触る PR。
- **流す順**: 環境(env)→ (a) → (b) → (c) → (d) → (e)。ログのファイル名と中身は [`docs/e2e-logs/README.md`](e2e-logs/README.md) の表のとおり(`<日付>-env` / `a-confined` / `b-break` / `c-no-browser-server` / `d-denied-ports` / `d-team-ci-test` / `e-mysql-rounds` の `.log`)。どれかが落ちても、あとの手順は流し、ログは artifact に上げる。
- **期待どおりでなければジョブを落とす**: 各手順が、終了コードと、README の「照合の手順」の行(`○ E2E N 件が通った`・`○ 入口を壊すと落ちた`・`○ 断るポートだけが BLOCKED になった` など)を見て、`✗`・`△`・`?`・「見ていない」(`- …`)・スキップが 1 つでもあれば落とす(`scripts/ci-confinement-lib.sh`)。ログが 7 本揃っていなければ落とす。
- **ホームのダミー**: ランナーのホームはまっさらなので、(a) (iii) の「`~/.kuramoto`・`~/.ssh` へのシンボリックリンク経由の読み取りが断られる」確かめのために、ダミーの `~/.kuramoto/access-token` と `~/.ssh/id_dummy` を作ってから流す。
- **`e2e/auth.spec.ts`**: (a) の E2E の回で流れる。`check-confined-browser.ts` は `npm test` の出力の最後の 60 行だけを出すので、行が切れないよう、閉じ込めの外で `auth.spec.ts` だけを直に流した出力を、見出しつきで (a) のログの末尾に足す(✓ が 4 本あることを見る)。
- **(c) 設定なし**: 起動できて E2E が流れた(`○`)か、起動できず知らせて通った(`△`)かの、どちらでも終了コード 0 なら既定の振る舞いのとおり。どちらだったかはログの行で分かる。
- **(d)**: `--denied-port 3306` の BLOCKED を見るため、3306 で待ち受けるだけのプロセスを立ててから流す(立っていないと、そのポートは「見ていない」になる)。
- **(e) MySQL の回は、macOS のランナーの上で、brew の mysql で立てる**(ubuntu のジョブには分けていない)。理由: (a)(c) は閉じ込めの中で `npm test`(SQLite の回 → MySQL の回 → E2E の回)を流すので、MySQL の回が mysql-test(127.0.0.1:3307)に届くのは、閉じ込め(`sandbox-exec`)が動く macOS のジョブの中でなければならない。macOS のランナー(Apple シリコン)には docker(Docker Desktop・colima)が入っておらず、`docker compose up -d mysql-test` が使えないので、`brew install mysql@8.4` で、`compose.yaml` の mysql-test と同じ設定(127.0.0.1:3307・utf8mb4_bin・UTC・テスト専用の資格情報)で立てる。(e) のログには、(a)(c) のログの抜き出し(README の手順どおり)に加えて、E2E の回を飛ばした `npm test` を閉じ込めの外で全文流した MySQL の回の出力を足す(`check-confined-browser.ts` が出すのは `npm test` の最後の 60 行だけで、MySQL の回が切れることがあるため)。
  - brew の mysql が立たないなど、macOS のランナーで MySQL を使えなくなったときだけ、(e) を ubuntu のジョブ(`services: mysql`)に分ける。分けたら、(a)(c) の `npm test` は `KURAMOTO_SKIP_MYSQL_TESTS=1` で MySQL の回を飛ばし、(e) の ubuntu のジョブの `npm test` の MySQL の回を `e-mysql-rounds.log` にして、その理由をここに書き直す。

| 回 | コマンド | 結果 | 日 | 流した場所(CI) | OS | Chrome の版 | コミット | ログのファイル | 流すチケット |
|---|---|---|---|---|---|---|---|---|---|
| 設定あり (i)(iii) | `check-confined-browser.ts <repo>`(E2E 全件・`e2e/auth.spec.ts` を含む) | 未実施 | | | | | | | #115(`confinement-check` の artifact から) |
| 設定あり (ii) | `check-confined-browser.ts <repo> --break` | 未実施 | | | | | | | #115(`confinement-check` の artifact から) |
| 設定なし | `check-confined-browser.ts <repo> --no-browser-server` | 未実施 | | | | | | | #115(`confinement-check` の artifact から) |
| 断るポート(ADR-0059・0060) | `check-denied-ports.ts --denied-port <Kuramoto 自身の MySQL のポート>` と、`team-ci.test.ts` の「断るポート」の試験 | 未実施 | | | | | | | #115(`confinement-check` の artifact から) |
| mysql-test | (a)(c) のログの、MySQL の回(127.0.0.1:3307) | 未実施 | | | | | | | #115(`confinement-check` の artifact から) |

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
