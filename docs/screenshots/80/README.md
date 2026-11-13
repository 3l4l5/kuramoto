# #80 の描画確認(全画面 × 試作 / 直す前 / 直した後)

試作(`<key>.html`)は全 15 画面が届いた。試作は画面ごとに 1 つの幅でしか無い(パソコン 9 画面は 1280px、スマホ 6 画面は 390px)ので、
各画面を試作の幅で試作 / 直す前 / 直した後の 3 枚ずつ撮った。さらに、試作の幅と反対の幅も、直す前 / 直した後を撮った
(生産性・ツリー・編成の連絡経路の 390px)。生産性の 390px には試作が無い(下の表の「試作」は「なし」)。
オフィス・ボード・チケット・開発ルール・編成の流れの 390px は、スマホの試作(phone-*)が受け持つ。

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
| スマホ: 開発ルール | 390px | ![](phone-dev-rules-mock-390.png) | ![](phone-dev-rules-before-390.png) | ![](phone-dev-rules-after-390.png) | 14.3% → 9.5% |
| オフィス「ツリー」(スマホ) | 390px | ![](phone-board-mock-390.png)(phone-board の試作。ツリーはパソコンと同じ入れ子を字下げ 1 段ずつ) | ![](tree-before-390.png) | ![](tree-after-390.png) | 試作は画面全体の絵が無く未計測 |
| 生産性(スマホ) | 390px | なし(試作は 1280px のみ) | ![](metrics-before-390.png) | ![](metrics-after-390.png) | 試作が無く未計測 |
| 編成「連絡経路」(スマホ) | 390px | ![](phone-formation-flow-mock-390.png)(phone-formation-flow の試作。連絡経路は「組み合わせの一覧」と決めてある) | ![](formation-route-before-390.png) | ![](formation-route-after-390.png) | 試作の画像が流れのタブのみで未計測 |

## 直したもの(描画しないと見えなかったずれ)

- **スマホ: チームの方針(開発ルール)が全画面にならない** — 部品 `ds/Drawer` は `<section>` を出すのに、全画面にする CSS は `aside.drawer` だけに効いていて、受信箱のカードの下に流れて出ていた。`section.drawer` も全画面・枠なしにし、「ひな形から足す / ルールを足す」の帯を下に固定した(14.3% → 9.5%)。
- **スマホ: 引き出しの下のボタンが下のタブに隠れる** — 引き出しを下のタブ(高さ 57px)の上までにした(編成の「保存して vN にする」も隠れなくなった)。
- **スマホ: オフィスの種類の切り替えが右端で切れる** — 「ドキュメント」が見えなかった。横にすべらせず折り返して、全部見せる(16.2% → 14.0%)。
- **スマホ: 対応タブの件数の札の色** — 企画の色(--design)になっていたのを、試作どおりリーダー側(--lead)にした。
- **編成の引き出しの下の帯** — 狭い幅で「保存してない変更はありません」が 1 文字幅の縦書きになっていた。帯を折り返し、メッセージが 1 行目を使うようにした。

## 試作との違い(直していない・別チケットに回す)

- **編成「島」タブ(59.4%)**: 試作は「左に島の一覧・右に編集」の中央の窓で、タブに保存していない件数の札、下の帯に「島 1 · 連絡経路 2」を出す。実装は右の細い引き出しに島を縦に並べる作り。構造から作り直すので別チケット。
- **高さ**: 試作は 1 画面(800px)に収めた絵で、実装はページ全体を撮るので、引き出しの下にオフィスなどが続いて高くなる。引き出しは窓(モーダル)でなく、画面の右の列に出ている。
- **データ**: 試作の見本データ(カード 3 枚・メンバーの名前など)とフェイクデータが違うぶんの違いが残る(スマホの対応・オフィス、編成の流れ)。
- 試作の「種類の切り替え」は短い字(全部 / ● 機能 / ▲ バグ / ■ リファ / ◆ 文書)で 1 行に収めているが、実装は「すべて / ● 機能 / ▲ バグ修正 / ■ リファクタ / ◆ ドキュメント」の正式名のままで、狭いと 2 行に折り返す。種類の名前はボード・ツリー・チケット・生産性で同じ字を使っているので、ここだけ別名を作らず、折り返して全部見せることにした。
- スマホの開発ルールの一覧: 試作の行末の「›」と、一覧の下の「違反の数」の札は無い(違反の数は別の画面の要素で、このチケットの範囲外)。一覧の先頭が選ばれた色になっているのも試作と違う。
- 生産性 390px の「フロー効率の推移」の枠は、フェイクデータに履歴が無いので空で出る。
- 直す前の編成・開発ルールは、`?drawer=` を足した同じビルドで撮った(この URL 指定は見た目を変えない)。

- 開発ルールの撮影用データ(試作と同じ 4 件。4 つ目は無効)を `e2e/screens.ts` に足した。直す前・直した後の開発ルールは、このデータで撮り直した(一覧が空だと行の見た目を見比べられないため)。
- `?drawer=` の指定は、引き出しを開け閉めしたら捨てる(閉じて開き直しても、同じタブから始まらない。読み込み直すと、URL がまた使われる)。
