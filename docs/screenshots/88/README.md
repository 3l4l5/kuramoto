# #88 の描画確認(試作 / 直す前 / 直した後 × 1280・390px × オフィス・ボード・ツリー・企画スタジオ・生産性・設定)

画面はフェイクの担当で動かしたアプリ(`E2E_SCREENS=1 npx tsx e2e/server.ts`)を `render_page` で撮った。ボード・ツリーは `?tab=office&view=board|tree#/p/1`。
試作は `.kuramoto/design/` の画像。**企画スタジオ・設定には試作が無い**(どちらも「共通ヘッダー+ページの地」だけを合わせた)。ツリーの 390px にも専用の試作は無い(phone-board の上の切り替えで開く)。

| 画面 | 幅 | 試作 | 直す前 | 直した後 |
|---|---|---|---|---|
| オフィス | 1280px | ![](proto-office-1280.png) | ![](office-before-1280.png) | ![](office-after-1280.png) |
| オフィス | 390px | ![](proto-office-390.png) | ![](office-before-390.png) | ![](office-after-390.png) |
| ボード | 1280px | ![](proto-board-1280.png) | ![](board-before-1280.png) | ![](board-after-1280.png) |
| ボード | 390px | ![](proto-board-390.png) | ![](board-before-390.png) | ![](board-after-390.png) |
| ツリー | 1280px | ![](proto-tree-1280.png) | ![](tree-before-1280.png) | ![](tree-after-1280.png) |
| ツリー | 390px | (なし) | ![](tree-before-390.png) | ![](tree-after-390.png) |
| 企画スタジオ | 1280px | (なし) | ![](studio-before-1280.png) | ![](studio-after-1280.png) |
| 企画スタジオ | 390px | (なし) | ![](studio-before-390.png) | ![](studio-after-390.png) |
| 生産性 | 1280px | ![](proto-metrics-1280.png) | ![](metrics-before-1280.png) | ![](metrics-after-1280.png) |
| 生産性 | 390px | (なし) | ![](metrics-before-390.png) | ![](metrics-after-390.png) |
| 設定 | 1280px | (なし) | ![](settings-before-1280.png) | ![](settings-after-1280.png) |
| 設定 | 390px | (なし) | ![](settings-before-390.png) | ![](settings-after-390.png) |

## 試作を見て書き出した違い(1280px)

| | 試作 | 直す前 | 直した後 |
|---|---|---|---|
| ヘッダーの行き先 | 切り替えスイッチ(office / board / tree / ticket) | 文字だけのボタン(オフィス以外の画面は枠つきボタン→文字) | 切り替えスイッチ。全画面で同じ形・同じ位置 |
| スイッチの色 | 外枠が白(--surface)、選んでいるのが灰(--bg)+影 | — | 同じ(`.ds-seg--raised`) |
| ページの背景 | 灰(--bg) | 白(--surface) | 灰(--bg) |
| ヘッダーの帯 | 帯なし(灰の地の上にそのまま) | 白い帯+下線 | 帯なし |
| 部品(カード・パネル・引き出し) | 白 | 白(地も白で見分けが付かない) | 白(地が灰になり見分けが付く) |

## 試作で実際にそうなっていない点(作らなかったところ)

- **ヘッダーの帯は白ではない(デスクトップ)**: office.html / board.html / tree.html / ticket.html / dev-rules.html / formation-*.html の `.top` は `background` を持たず、灰色の `body{background:var(--bg)}` の上にそのまま置かれている(白いのはスイッチの外枠とボタン)。白い帯なのは metrics.html(`.top{background:var(--surface);border-bottom}`)とスマホの phone-home / phone-office / phone-board だけ。デスクトップは多数の試作どおり「帯なし」、スマホは試作どおり「白い帯」にした。
- **スイッチの中身は 3 つだけ**: 試作の切り替えは オフィス / ボード / ツリー のみ。企画スタジオ・生産性・設定は試作のヘッダーに無い(metrics.html は文字の並び)。リーダーのメモ「オフィス以外も同じスイッチ形にそろえる」に従い、同じスイッチの右に 3 つ足して 1 つのスイッチにした(ここは試作と違う)。
- **スイッチの外枠の色が試作で揃っていない**: office / board / tree は外枠が白+選択が灰、ticket / dev-rules / formation-* / metrics は外枠が灰+選択が白(白い面の上のスイッチ)。地が灰のヘッダーの上では前者が正で、白い面の上(ds の `Segmented`)は後者のまま。
- 路線図の画面そのもの(オフィスの 1 画面の作り)はこのチケットの範囲外。オフィスの `compare_screen` は 11.5%・高さが違う(お手本 800px・実装 2386px)のは、あなたの対応・チケットを足す・指標などの区画が下に続くため。
