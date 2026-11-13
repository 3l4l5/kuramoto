# #80 の描画確認(全画面 × 試作 / 直す前 / 直した後)

試作(`<key>.html`)は全 15 画面が届いた。試作は画面ごとに 1 つの幅でしか無い(パソコン 9 画面は 1280px、スマホ 6 画面は 390px)ので、
各画面を試作の幅で、試作 / 直す前 / 直した後の 3 枚ずつ残した(15 画面 × 3 種 = 45 枚)。
同じ画面の反対の幅は、スマホの試作(phone-office・phone-board・phone-ticket・phone-dev-rules・phone-formation-flow)が受け持つ。
試作の無い組み合わせ(生産性・ツリー・編成の連絡経路/島の 390px、対応の 1280px)は撮っていない(生産性・ツリーの 390px は [#78](../78/README.md) にある)。

直す前 = #78 を含む main(この PR の変更前)。直した後 = この PR。違いの割合は `compare_screen` の値(目安は 10% 以下)。

## 撮り方(撮り直せる)

```sh
npm run build:ui
E2E_SCREENS=1 E2E_PORT=4478 E2E_WEB_DIR=ui/dist npx tsx e2e/server.ts
```

URL は #78 と同じ(`?tab=office&view=floor|board|tree`)。このチケットで、編成と開発ルールの引き出しも URL で開けるようにした:
`?drawer=formation&dtab=islands|routes|flows`・`?drawer=policy&dtab=rules`(`?drawer=lead` も)。生産性は `#/p/1/metrics`、チケットは `#/p/1/t/5`、スマホの対応は 390px で `#/p/1`。
試作は `render_page` に `.kuramoto/design/<key>.html` を渡して同じ幅で撮った。ボード・ツリーは、オフィスの「ボード」「ツリー」に切り替えた本物の画面で撮っている。

| 画面 | 幅 | 試作 | 直す前 | 直した後 | 違い(前→後) |
|---|---|---|---|---|---|
| 編成「連絡経路」 | 1280px | ![](formation-route-mock-1280.png) | ![](formation-route-before-1280.png) | ![](formation-route-after-1280.png) | 9.1% → 9.1% |
| 編成「流れ」 | 1280px | ![](formation-flow-mock-1280.png) | ![](formation-flow-before-1280.png) | ![](formation-flow-after-1280.png) | 8.8% → 8.8% |
| 編成「島」 | 1280px | ![](formation-islands-mock-1280.png) | ![](formation-islands-before-1280.png) | ![](formation-islands-after-1280.png) | 59.4% → 59.4% |
| 開発ルール | 1280px | ![](dev-rules-mock-1280.png) | ![](dev-rules-before-1280.png) | ![](dev-rules-after-1280.png) | 8.0% → 8.0% |
| オフィス(路線図) | 1280px | ![](office-mock-1280.png) | ![](office-before-1280.png) | ![](office-after-1280.png) | 11.4% → 11.4% |
| オフィス「ボード」 | 1280px | ![](board-mock-1280.png) | ![](board-before-1280.png) | ![](board-after-1280.png) | 6.4% → 6.4% |
| オフィス「ツリー」 | 1280px | ![](tree-mock-1280.png) | ![](tree-before-1280.png) | ![](tree-after-1280.png) | 7.2% → 7.2% |
| チケットの詳細 | 1280px | ![](ticket-mock-1280.png) | ![](ticket-before-1280.png) | ![](ticket-after-1280.png) | 6.0% → 6.0% |
| 生産性 | 1280px | ![](metrics-mock-1280.png) | ![](metrics-before-1280.png) | ![](metrics-after-1280.png) | 6.5% → 6.5% |
| スマホ: 対応 | 390px | ![](phone-home-mock-390.png) | ![](phone-home-before-390.png) | ![](phone-home-after-390.png) | 14.0% → 14.0% |
| スマホ: オフィス | 390px | ![](phone-office-mock-390.png) | ![](phone-office-before-390.png) | ![](phone-office-after-390.png) | 16.2% → 14.0% |
| スマホ: 編成「流れ」 | 390px | ![](phone-formation-flow-mock-390.png) | ![](phone-formation-flow-before-390.png) | ![](phone-formation-flow-after-390.png) | 11.8% → 11.6% |
| スマホ: ボード | 390px | ![](phone-board-mock-390.png) | ![](phone-board-before-390.png) | ![](phone-board-after-390.png) | 7.5% → 7.5% |
| スマホ: チケット | 390px | ![](phone-ticket-mock-390.png) | ![](phone-ticket-before-390.png) | ![](phone-ticket-after-390.png) | 5.1% → 5.1% |
| スマホ: 開発ルール | 390px | ![](phone-dev-rules-mock-390.png) | ![](phone-dev-rules-before-390.png) | ![](phone-dev-rules-after-390.png) | 14.3% → 7.9% |

## 直したもの(描画しないと見えなかったずれ)

- **スマホ: チームの方針(開発ルール)が全画面にならない** — 部品 `ds/Drawer` は `<section>` を出すのに、全画面にする CSS は `aside.drawer` だけに効いていて、受信箱のカードの下に流れて出ていた。`section.drawer` も全画面・枠なしにし、「ひな形から足す / ルールを足す」の帯を下に固定した(14.3% → 7.9%)。
- **スマホ: 引き出しの下のボタンが下のタブに隠れる** — 引き出しを下のタブ(高さ 57px)の上までにした(編成の「保存して vN にする」も隠れなくなった)。
- **スマホ: オフィスの種類の切り替えが右端で切れる** — 「ドキュメント」が見えなかった。横にすべらせず折り返して、全部見せる(16.2% → 14.0%)。
- **スマホ: 対応タブの件数の札の色** — 企画の色(--design)になっていたのを、試作どおりリーダー側(--lead)にした。
- **編成の引き出しの下の帯** — 狭い幅で「保存してない変更はありません」が 1 文字幅の縦書きになっていた。帯を折り返し、メッセージが 1 行目を使うようにした。

## 試作との違い(直していない・別チケットに回す)

- **編成「島」タブ(59.4%)**: 試作は「左に島の一覧・右に編集」の中央の窓で、タブに保存していない件数の札、下の帯に「島 1 · 連絡経路 2」を出す。実装は右の細い引き出しに島を縦に並べる作り。構造から作り直すので別チケット。
- **高さ**: 試作は 1 画面(800px)に収めた絵で、実装はページ全体を撮るので、引き出しの下にオフィスなどが続いて高くなる。引き出しは窓(モーダル)でなく、画面の右の列に出ている。
- **データ**: 試作の見本データ(カード 3 枚・メンバーの名前など)とフェイクデータが違うぶんの違いが残る(スマホの対応・オフィス、編成の流れ)。
- 直す前の編成・開発ルールは、`?drawer=` を足した同じビルドで撮った(この URL 指定は見た目を変えない)。
