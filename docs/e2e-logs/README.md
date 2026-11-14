# 閉じ込めの確かめの実機のログ(#100)

チームの CI の閉じ込めの中でブラウザ E2E が起動・通過すること、閉じ込めの制限が効いていること、localhost の「断るポート」(ADR-0059・ADR-0060)が効いていることを、**Kuramoto のサーバー(Chrome が動く Mac)で実際に流した**出力の全文を置く場所です。表は [../e2e.md の「確かめの記録」](../e2e.md) にあります。

**いまは、ログがありません。** 実機で流す作業(下の手順)は未実施で、別チケット(実機で (a)〜(e) と `e2e/auth.spec.ts` を流してログを置き、表を埋め、既定を設定ありにするかを決める)に引き継いでいます。#100 は、その手順と、手順が使う道具(`scripts/check-denied-ports.ts` と、その試験)までです。作業場所(閉じ込めの中)では Chrome も入れ子の閉じ込めも動かせないので、ログを自分では取れません。

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

## 実行手順(責任者がそのまま貼って流す)

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
| (a) | `--- npm test の終了コード: 0`・E2E が通った行(`○ E2E 15 件が通った`)・(iii) の行がすべて `○`(`~/.kuramoto`・`~/.ssh` へのシンボリックリンク経由の読み取りが断られる行を含む)。終了コード 0。`e2e/auth.spec.ts` の行が `✓` で出ている。**`e2e/auth.spec.ts` が main に入っていて E2E の件数が 15 件より増えているときは、`△ npm test は通ったが「15 passed」が…` になる**(`scripts/check-confined-browser.ts` が件数 15 を決め打ちしているため)。そのときは出力の「N passed」と `npm test` の終了コード 0 を見て、件数の決め打ちを直すのを、実機の流しのチケットの中でやる |
| (b) | `○ 入口を壊すと落ちた`。`git status --short` に差分が出ない |
| (c) | `△ 設定なし: …(知らせて通った)` か `○ 設定なし: …` |
| (d) | `○ 断るポート…: BLOCKED`(`--denied-port` を渡したポートも BLOCKED)・`○ ほかのポート…: REACHED`・`○ mysql-test…: REACHED`・`○ 対照…: REACHED`・最後が `○ 断るポートだけが BLOCKED になった`(終了コード 0)。`? 閉じ込めを使えなかった`(終了コード 2)なら、閉じ込めの外から流せていない。vitest の「断るポート」の試験が `✓`(`↓` = スキップならやり直し) |
| (e) | npm test の MySQL の回が通っている(落ちていたら `docker compose ps` で mysql-test が healthy か見る) |

想定と違う結果は、原因を書いて直すか、別のチケットにします。ログが揃うまで、既定(`confinedBrowserEnabled` は設定なし)は動かしません。

## 道具の試験(作業場所で流せる範囲)

`scripts/check-denied-ports.ts` は、引数の読み取り・nc の出力の読み取り・確かめの流れ(想定どおり 0 / 想定と違う 1 / 閉じ込めを使えない 2)を、`scripts/check-denied-ports.test.ts` で、閉じ込めを台本に置き換えて試験しています(`npm test` で流れる)。本物の閉じ込めと nc を使う試験は、入れ子の閉じ込めの中ではスキップされます(上の (d) の実機の流しで確かめる)。
