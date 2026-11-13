# #76 の描画確認(全画面 × 1280/390px × 直す前/直した後)

試作(.kuramoto/design)はこのチケットに届いていないため(plan_refs が無い)、試作との見比べは別チケット。ここは直す前/直した後だけ。

画面はフェイクの担当で動かしたアプリ(`e2e/server.ts`)を `render_page` で撮った。ツリー/ボードの切り替えは URL に無いので、ツリーは実際の `style.css` と `Tree.tsx` と同じ class の 5 状態(作業中・あなたの番・止まっている・待ち・手すき)を並べたページ(`tree`)で撮った。

| 画面 | 幅 | 直す前 | 直した後 |
|---|---|---|---|
| 本部 `#/` | 1280px | ![](home-before-1280.png) | ![](home-after-1280.png) |
| 本部 `#/` | 390px | ![](home-before-390.png) | ![](home-after-390.png) |
| オフィス `#/p/1` | 1280px | ![](office-before-1280.png) | ![](office-after-1280.png) |
| オフィス `#/p/1` | 390px | ![](office-before-390.png) | ![](office-after-390.png) |
| 企画スタジオ `#/p/1/studio` | 1280px | ![](studio-before-1280.png) | ![](studio-after-1280.png) |
| 企画スタジオ `#/p/1/studio` | 390px | ![](studio-before-390.png) | ![](studio-after-390.png) |
| 生産性 `#/p/1/metrics` | 1280px | ![](metrics-before-1280.png) | ![](metrics-after-1280.png) |
| 生産性 `#/p/1/metrics` | 390px | ![](metrics-before-390.png) | ![](metrics-after-390.png) |
| 設定 `#/p/1/settings` | 1280px | ![](settings-before-1280.png) | ![](settings-after-1280.png) |
| 設定 `#/p/1/settings` | 390px | ![](settings-before-390.png) | ![](settings-after-390.png) |
| チケット `#/p/1/t/1` | 1280px | ![](ticket-before-1280.png) | ![](ticket-after-1280.png) |
| チケット `#/p/1/t/1` | 390px | ![](ticket-before-390.png) | ![](ticket-after-390.png) |
| ツリー(5 状態の確認用ページ) | 1280px | ![](tree-before-1280.png) | ![](tree-after-1280.png) |
| ツリー(5 状態の確認用ページ) | 390px | ![](tree-before-390.png) | ![](tree-after-390.png) |
