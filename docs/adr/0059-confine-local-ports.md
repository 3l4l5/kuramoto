# ADR-0059: チームの CI の閉じ込めから、Kuramoto 本体のポートには届かせない

- 状態: 提案
- 日付: 2026-11-14
- チケット: #98(#93 のレビューで見つかった、今からある穴)

## 背景

`sandbox_strict_sockets` は既定が 0 で、閉じ込め(ADR-0020)は `allowLocalBinding` を許している。sandbox-runtime は、macOS では localhost の「どのポートにも」接続してよい規則を書くので、チームの CI(ADR-0028)の閉じ込めの中の `npm test` など(と、#93 のブラウザ専用の閉じ込め)から、Kuramoto 本体の API(既定 4300)に届く。
本体は、localhost からは合言葉なしで、`x-kuramoto: 1` のヘッダーだけで書き込める(他のサイトからの書き込みを防ぐためのもので、閉じ込めの中のコードには意味が無い)。つまり PR のコードが、チケットの操作・merge などを本体の API 経由で行えてしまう。

## 決めたこと

**localhost は許したまま、Kuramoto 本体のポートだけ(と、プロジェクトの設定で足したポート)を断る。**

- 断るポート: `KURAMOTO_PORT`(既定 4300)と、プロジェクトの設定 `sandbox_deny_local_ports`(ポート番号を、改行・カンマ・空白で区切る。例: 本番の DB のポート)。
- 断り方: sandbox-runtime が書く `(allow network-outbound (remote ip "localhost:*"))` のすぐあとに、`(deny network-outbound (remote ip "localhost:<port>"))` を足す(Seatbelt はあとの規則が勝つ)。`wrapWithSandbox` が返すコマンドの中の規則を書き換える(`src/project/local-ports.ts`)。許可の規則が見つからなければ(sandbox-runtime の版で書き方が変わったとき)、緩めたまま流さずに止める。`@anthropic-ai/sandbox-runtime` は版を固定してあるので、上げるときはこの試験(`team-ci.test.ts`)が教える。
- 効く場所: チームの CI の閉じ込め(SandboxRunner)と、その中のブラウザサーバー(confined-browser.ts)。
- Linux の閉じ込めは、ネットワークの名前空間が別でホストの localhost には元から届かないので、何もしない。

## 選ばなかったこと

- **届いてよいポートだけに絞る(許可リスト)**: sandbox-runtime は、localhost を「全部許す」か「全部閉じる」かの 2 つしか選べない。ポートごとの許可は、規則を書き換えて足すことになるが、テストが自分で立てるサーバー(`listen(0)` で毎回ポートが変わる。Kuramoto 自身の `server.test.ts`・`flow-e2e.test.ts` など)・E2E・mysql-test(3307)に届かなくなる。ポートが前もって分からないので、許可リストは成り立たない。
- **本体の API に、閉じ込めから使えない認証を掛ける**: 閉じ込めの中のコードと、責任者のブラウザは、どちらも localhost の HTTP で来るだけなので、本体に渡す合言葉を、閉じ込めの中から見えない形で、責任者のブラウザにだけ渡す仕組み(起動のたびの URL・ログインなど)が要る。「この PC 自身(localhost)からは合言葉なしで使える」という今の使い心地を変える大きな変更で、本体のほかのポート(DB など)や、他のローカルのサービスも守れない。
- **`sandbox_strict_sockets` を既定で 1 にする**: Chrome・E2E・mysql-test が動かなくなる(ADR-0042)。

## 残ること

- 断るのは名指ししたポートだけ。ほかのローカルのサービス(開発中のサーバー・DB など)は、`sandbox_deny_local_ports` に足さない限り、今までどおり届く。もっと強く閉じたいプロジェクトは `sandbox_strict_sockets` を 1 にする。
- **担当(エージェント)のシェル**は、Claude Code の閉じ込め(`@anthropic-ai/claude-agent-sdk` の `sandbox` 設定)で、ポートを選べない(`allowLocalBinding` の真偽だけ)ので、この断りは効かず、本体の API には届いたまま。担当のシェルを直すには、SDK 側にポートの指定が入るのを待つか、本体の認証を別に決める(別のチケット)。
- macOS の Seatbelt の規則の書き換えは、実機(nested でない Kuramoto のサーバー)で `team-ci.test.ts` の「断るポート」の試験を流して確かめる(閉じ込めの中からは閉じ込めを重ねられないので、開発の閉じ込めの中では流れない)。
