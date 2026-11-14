# 閉じ込めの確かめの実機のログ(#100)

チームの CI の閉じ込めの中でブラウザ E2E が起動・通過すること、閉じ込めの制限が効いていること、localhost の「断るポート」(ADR-0059)が効いていることを、**Kuramoto のサーバー(Chrome が動く Mac)で実際に流した**出力の全文を置く場所です。表は [../e2e.md の「確かめの記録」](../e2e.md) にあります。

ログは流した出力をそのまま置きます(手で書き換えない・想像で補わない)。ファイル名は `<日付>-<名前>.log`(例: `2026-11-20-a-confined.log`)。

## 実行手順(責任者がそのまま貼って流す)

閉じ込めの外(ふつうのターミナル)で、Kuramoto の main の最新を取り出したディレクトリで流します。入れ子の閉じ込めの中(担当・レビューの作業場所)では、Chrome も閉じ込めも重ねられないので流せません。所要は全体で 30〜40 分ほどです(E2E を 2 回流すため)。

```sh
cd <Kuramoto のリポジトリ>        # main の最新(#98 の merge 後)
git checkout main && git pull
npm ci
docker compose up -d mysql-test && docker compose ps   # mysql-test が healthy になるまで待つ(MySQL の回と (d) が使う)
export L=docs/e2e-logs D=$(date +%F)
mkdir -p $L

# 環境(コミット・OS・Chrome の版・node)。e2e.md の表に写す
{ date; git rev-parse HEAD; git log -1 --format=%s; sw_vers; uname -a; node -v
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --version
  npx playwright --version; } 2>&1 | tee $L/$D-env.log

# (a) 設定あり (i)(iii): 15 件の E2E が通る/(iii) のシンボリックリンク経由の読み取りが断られる行が出る
npx tsx scripts/check-confined-browser.ts . 2>&1 | tee $L/$D-a-confined.log

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
| (a) | `--- npm test の終了コード: 0`・`○ E2E 15 件が通った`・(iii) の行がすべて `○`(`~/.kuramoto`・`~/.ssh` へのシンボリックリンク経由の読み取りが断られる行を含む)。終了コード 0 |
| (b) | `○ 入口を壊すと落ちた`。`git status --short` に差分が出ない |
| (c) | `△ 設定なし: …(知らせて通った)` か `○ 設定なし: …` |
| (d) | `○ 断るポート…: BLOCKED`(`--denied-port` を渡したポートも BLOCKED)・`○ ほかのポート…: REACHED`・`○ mysql-test…: REACHED`・`○ 対照…: REACHED`。vitest の「断るポート」の試験が `✓`(`↓` = スキップならやり直し) |
| (e) | npm test の MySQL の回が通っている(落ちていたら `docker compose ps` で mysql-test が healthy か見る) |

想定と違う結果は、原因を書いて直すか、別のチケットにします。ログが揃うまで、既定(`confinedBrowserEnabled` は設定なし)は動かしません。
