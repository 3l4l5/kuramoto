# 閉じ込めの確かめの実機のログ(#100)

チームの CI の閉じ込めの中でブラウザ E2E が起動・通過すること、閉じ込めの制限が効いていること、localhost の「断るポート」(ADR-0059・ADR-0060)が効いていることを、**Kuramoto のサーバー(Chrome が動く Mac)で実際に流した**出力の全文を置く場所です。表は [../e2e.md の「確かめの記録」](../e2e.md) にあります。

**いまは、ログがありません。** 実機で流す作業(下の手順)は未実施です。ログは、#114 の CI(GitHub Actions の macOS ランナー)で (a)〜(e) と `e2e/auth.spec.ts` を流して artifact に残し、そこから取ります(別チケット)。取れたら、ここに置いて表を埋め、既定を設定ありにするかを決めます。#100 は、その手順と、手順が使う道具(`scripts/check-denied-ports.ts` と、その試験)までです。作業場所(閉じ込めの中)では Chrome も入れ子の閉じ込めも動かせないので、ログを自分では取れません。

ログは流した出力をそのまま置きます(手で書き換えない・想像で補わない)。

## ログのファイル名

`<日付>` は手順の `D`(`date +%F`。例: `2026-11-20`)。どのログも `2>&1 | tee` で、出力の全文をそのまま残します。

| 手順 | ファイル | 中身 |
|---|---|---|
| 環境 | `<日付>-env.log` | 日時・コミット・OS・Chrome の版・node・playwright の版・E2E の試験ファイルの一覧 |
| (a) | `<日付>-a-confined.log` | 設定あり (i)(iii)。E2E 全件(`e2e/auth.spec.ts` を含む)と、(iii) のシンボリックリンク経由の読み取り |
| (b) | `<日付>-b-break.log` | 設定あり (ii)(`--break`) |
| (c) | `<日付>-c-no-browser-server.log` | 設定なし(既定の振る舞い) |
| (d) | `<日付>-d-denied-ports.log` | 断るポートの確かめ(`--denied-port` を含む) |
| (d) | `<日付>-d-team-ci-test.log` | `team-ci.test.ts` の「断るポート」の試験 |
| (e) | `<日付>-e-mysql-rounds.log` | mysql-test(127.0.0.1:3307)に届いて、MySQL の回が通ったことの抜き出し |

## 実行手順(実機でそのまま貼って流す)

閉じ込めの外(ふつうのターミナル)で、Kuramoto の main の最新を取り出したディレクトリで流します。入れ子の閉じ込めの中(担当・レビューの作業場所)では、Chrome も閉じ込めも重ねられないので流せません。所要は全体で 30〜40 分ほどです(E2E を 2 回流すため)。

```sh
cd <Kuramoto のリポジトリ>        # main の最新(#98・#103 の merge 後)
git checkout main && git pull
npm ci
docker compose up -d mysql-test && docker compose ps   # mysql-test が healthy になるまで待つ(MySQL の回と (d) が使う)
export L=docs/e2e-logs D=$(date +%F)
mkdir -p $L

# 環境(コミット・OS・Chrome の版・node・E2E の試験ファイル)。e2e.md の表に写す
{ date; git rev-parse HEAD; git log -1 --format=%s; sw_vers; uname -a; node -v
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --version
  npx playwright --version
  ls e2e/*.spec.ts; } 2>&1 | tee $L/$D-env.log

# (a) 設定あり (i)(iii): E2E が通る/(iii) のシンボリックリンク経由の読み取りが断られる行が出る
npx tsx scripts/check-confined-browser.ts . 2>&1 | tee $L/$D-a-confined.log
#     e2e/auth.spec.ts(合言葉の案内)も、この E2E の回で流れる。ログに出ていること(無ければ、その試験が main に入っていない)
grep -n "auth.spec" $L/$D-a-confined.log

# (b) 設定あり (ii): 入口を壊すと落ちる(終わったら PhoneBar.tsx は元に戻る。git status で差分が無いことを見る)
npx tsx scripts/check-confined-browser.ts . --break 2>&1 | tee $L/$D-b-break.log
git status --short

# (c) 設定なし(既定の振る舞い)
npx tsx scripts/check-confined-browser.ts . --no-browser-server 2>&1 | tee $L/$D-c-no-browser-server.log

# (d) 断るポート(閉じ込めの外から流す)。断るポートは BLOCKED、ほかのポート(mysql-test の 3307 など)は REACHED
#     main の #103(ADR-0060)で、Kuramoto 自身の MySQL(手元にあれば 127.0.0.1:3306 など)も断る既定に入った。Kuramoto が使っている MySQL のポートを --denied-port に渡すと、そこが BLOCKED になることも見る(mysql-test の 3307 は REACHED のまま)
npx tsx scripts/check-denied-ports.ts --denied-port 3306 2>&1 | tee $L/$D-d-denied-ports.log
#     team-ci.test.ts の「断るポート」の試験も、スキップされずに通ること("skipped" ではなく "passed")
npx vitest run src/project/team-ci.test.ts --reporter=verbose 2>&1 | tee $L/$D-d-team-ci-test.log

# (e) mysql-test: (a)〜(c) は閉じ込めの中で npm test(SQLite の回・MySQL の回・E2E の回)を流すので、
#     MySQL の回が mysql-test(127.0.0.1:3307)に届いて通ったことは (a)(c) のログに出る。そこを抜き出す
grep -n -i "mysql\|KURAMOTO_TEST_DB\|Tests " $L/$D-a-confined.log $L/$D-c-no-browser-server.log 2>&1 | tee $L/$D-e-mysql-rounds.log
```

## 受け取ったログの見方

| ログ | 想定 |
|---|---|
| (a) | `--- E2E の試験の件数(playwright test --list): N`・`--- npm test の終了コード: 0`・E2E が通った行(`○ E2E N 件が通った(playwright test --list の件数と一致)`。お手本の画像(`KURAMOTO_DESIGN_DIR/office.png`)が無い環境では、`app.spec.ts` のオフィスの床の 1 件が飛ぶので `○ E2E N-1 件が通った・1 件は飛ばした(…一致)` になる。passed + skipped が `--list` の N と合っていれば `○`)・(iii) の行がすべて `○`(`~/.kuramoto`・`~/.ssh` へのシンボリックリンク経由の読み取りが断られる行を含む)。終了コード 0。`e2e/auth.spec.ts` の行が `✓` で出ている。件数は決め打ちではなく、流す前に `playwright test --list` で数える。`△ …件数…が合わない` なら一部が流れていないので、出力の「N passed」「N skipped」と `npm test` の終了コードを見る。`--- playwright test --list が失敗した` が出ていたら、件数の突き合わせは効いていない(理由はその行) |
| (b) | `○ 入口を壊すと落ちた`。`git status --short` に差分が出ない |
| (c) | `△ 設定なし: …(知らせて通った)` か `○ 設定なし: …` |
| (d) | `○ 断るポート…: BLOCKED`(`--denied-port` を渡したポートも BLOCKED)・`○ ほかのポート…: REACHED`・`○ mysql-test…: REACHED`・`○ 対照…: REACHED`・最後が `○ 断るポートだけが BLOCKED になった`(終了コード 0)。`? 閉じ込めを使えなかった`(終了コード 2)なら、閉じ込めの外から流せていない。vitest の「断るポート」の試験が `✓`(`↓` = スキップならやり直し) |
| (e) | npm test の MySQL の回が通っている(落ちていたら `docker compose ps` で mysql-test が healthy か見る) |

想定と違う結果は、原因を書いて直すか、別のチケットにします。ログが揃うまで、既定(`confinedBrowserEnabled` は設定なし)は動かしません。

## 照合の手順(ログを置くときに、1 ファイルずつ見る)

期待の文言は、`scripts/check-confined-browser.ts`・`scripts/check-denied-ports.ts`・`scripts/e2e-count.ts`・`e2e/auth.spec.ts` が実際に出す文字列です。期待と違った行は、直さず・隠さず、そのまま表と PR 本文に書きます。ログが足りないときは補わず、取り直してもらいます。

| ログ | 見る行(`grep -n` で探す) | 期待どおり | 違ったら |
|---|---|---|---|
| env | 1 行目が日時、2 行目が `git rev-parse HEAD`、続いて OS・Chrome・node・playwright の版、`e2e/*.spec.ts` の一覧 | 表の「OS」「Chrome の版」「コミット」に写せる値が揃い、一覧に `e2e/auth.spec.ts` がある | 値が欠けていたら取り直す(表を想像で埋めない)。コミットが `7f9eabc`(#110・PR #96)以降であること(これより前だと `auth.spec.ts` が古い流れで、照合点にならない) |
| (a) 件数 | `--- E2E の試験の件数(playwright test --list): N` | N が数字 | `数えられなかった` や `--- playwright test --list が失敗した` なら、件数の突き合わせは効いていない |
| (a) 終了コード | `--- npm test の終了コード: 0` | 0 | 0 以外は、その前の出力(落ちた試験)を見る |
| (a) E2E の行 | `○ E2E N 件が通った(playwright test --list の件数と一致)` | **この行**。お手本の画像が無い環境では `○ E2E N-1 件が通った・1 件は飛ばした(playwright test --list の件数と一致)` でもよい(passed + skipped が上の N と合う)。`・M 件は再試行で通った(flaky)` が付いたら、flaky の件数を表に書く | `△ npm test は通ったが、E2E の「N passed」が出力に見つからない` = E2E が流れていない。`△ … 件数(通った …)が試験の件数(N)と合わない` = 一部が流れていない。`(件数を事前に数えられなかったので、出力の「N passed」だけで見た)` は、突き合わせ無しの `○` なので、件数の突き合わせは未確認と書く |
| (a) 狭い閉じ込めで起動できたか | `--- 確かめられなかった: 狭い閉じ込めの中でブラウザを起動できなかった` | **この行が無い**(終了コード 2 で止まっていない) | 出ていたら (a) は未確認(Chrome が閉じ込めの中で起動していない)。理由は上の出力にある |
| (a) `e2e/auth.spec.ts` | `grep -n "auth.spec"`。#110(PR #96)の新しい流れの 4 本: ①合言葉なしで `/` が 200 で開き、API(`/api/hq`)は 401 で、画面が案内「端末に出ている「合言葉つきの URL」を開いてください」を出す。`?token=` つきで開けば、合言葉が URL から外れ、API が 200 になり、Cookie は `kuramoto_session` だけ(合言葉そのものは入らない)/ ②開いたあとで Cookie を消す(401 になる)と「合言葉が通りません」の案内が出て、つきの URL を開き直すと消える / ③「ログアウト」/ ④「すべてのセッションを失効」 | 4 本とも `✓` | 1 本でも `✘` なら、その行と、その後ろのエラーを書く。**4 本分の行が出ていなければ**、`check-confined-browser.ts` が `npm test` の出力の最後の 60 行だけを出す(`slice(-60)`)ので、出力から切れている可能性がある。`○ E2E N 件が通った(…一致)` が出ていれば `auth.spec.ts` も通った件数に入っているが、行を確かめられたことにはならない。表には「行は出力から切れていた」と書き、行が見える形(出力の全文)で取り直してもらう |
| (a) (iii) | `○`・`✗` で始まる行 | `○ 対照: …`(2 本)・`○ 対照: node_modules の中のリンクが、許した場所(package.json)を指すなら開ける`・`○ file:// で … を開けない`・`○ node_modules 内のシンボリックリンク経由で … を開けない`(`~/.kuramoto` と `~/.ssh` の分。ファイルとディレクトリのリンクの両方)・`○ LAN の IP(localhost の外)へ goto できない`・`○ newContext({proxy}) で外のプロキシ経由の通信ができない`・`○ context.request(ブラウザ側)で外の URL を取れない`・`○ request.newContext(ローカルの playwright)で外の URL を取れない`・最後が `○ 接続した側からの攻撃は、どれも失敗した` | `✗` が 1 本でもあれば `✗ 閉じ込めに穴がある`(終了コード 1)。既定は反転しない。`外への通信を確かめる LAN の IP` の `✗` は、LAN の IP が無い環境(確かめられなかった)なので、穴ではなく取り直し。`--- 接続した側の確かめが動かなかった` は終了コード 2(確かめられなかった) |
| (b) | `--- わざと壊した: ui/src/PhoneBar.tsx の drawerTo("policy") → drawerTo(null)`・`--- npm test の終了コード: 0 以外`・`○ 入口を壊すと落ちた`。そのあとの `git status --short` が空 | 4 つとも | `✗ 入口を壊したのに通った` は、E2E が入口を見ていない(穴)。`git status --short` に `ui/src/PhoneBar.tsx` が出たら、壊したままなので `git checkout ui/src/PhoneBar.tsx` で戻して書く。`--- 確かめられなかった` なら (b) は未確認 |
| (c) | `○ 設定なし: 閉じ込めの中で Chrome が起動でき、E2E N 件が流れた` か `△ 設定なし: Chrome が起動できず、画面の E2E は流れていない(知らせて通った)`。`--- npm test の終了コード: 0` | どちらでも、終了コード 0 なら、既定の振る舞い(通って知らせる)のとおり。**画面の E2E が流れたかは `○` のときだけ言える** | `? 設定なし: E2E が流れたか分からない` は、E2E の回より前で落ちたか、件数が合わない。終了コードが 0 以外なら落ちている |
| (d) 断るポート | `断るポート: <番号>(Kuramoto 本体の API の代わり)` に続く行 | `○ 断るポート(127.0.0.1:<番号>): BLOCKED(想定 BLOCKED)`・`○ ほかのポート(テストが立てるサーバーの代わり)(…): REACHED(想定 REACHED)`・`○ mysql-test(127.0.0.1:3307): REACHED(想定 REACHED)`・`○ 断るポート(--denied-port。Kuramoto 自身が使っているもの)(127.0.0.1:<MySQL のポート>): BLOCKED(想定 BLOCKED)`・`○ 対照: 断るポートを空にした設定の、同じポート(…): REACHED(想定 REACHED)`・最後が `○ 断るポートだけが BLOCKED になった` | `✗ … (想定 …)` は想定と違う(`✗ 想定と違う`、終了コード 1)。**`- mysql-test(127.0.0.1:3307)は立っていないので、見ていない` が出ていたら、3307 の REACHED は確かめていない**(`docker compose up -d mysql-test` のあとで取り直す)。`- ポート <番号> では何も待ち受けていないので、見ていない` が出ていたら、Kuramoto 自身の MySQL の BLOCKED は確かめていない。`? 閉じ込めを使えなかった` は終了コード 2(閉じ込めの外から流せていない) |
| (d) team-ci.test.ts | 「localhost を許していても、断るポート…」の行 | `✓`(`passed`)。この試験は、閉じ込めを使えるときだけ流れる | `↓`・`skipped` は、試験が流れていない(閉じ込めの外から流し直す) |
| (e) | `Tests ` の行、`KURAMOTO_TEST_DB`・`mysql` の行 | (a)(c) の `npm test` の MySQL の回が通っている | 落ちていたら `docker compose ps` で mysql-test が healthy かを見る。`grep` の結果が空なら、(e) は未確認(抜き出し先の出力が切れている) |

**ここまでの照合の結果が、すべて期待どおりになるまで、既定(`confinedBrowserEnabled`)は動かしません。** 期待どおりにそろったかどうかと、反転するかの判断は、ログを置く PR の本文に書いて、責任者に決めてもらいます。

## 道具の試験(作業場所で流せる範囲)

`scripts/check-denied-ports.ts` は、引数の読み取り・nc の出力の読み取り・確かめの流れ(想定どおり 0 / 想定と違う 1 / 閉じ込めを使えない 2)を、`scripts/check-denied-ports.test.ts` で、閉じ込めを台本に置き換えて試験しています(`npm test` で流れる)。本物の閉じ込めと nc を使う試験は、入れ子の閉じ込めの中ではスキップされます(上の (d) の実機の流しで確かめる)。
