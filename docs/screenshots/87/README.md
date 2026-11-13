# #87 スマホ幅(390px)の編成の引き出しで、島・連絡経路・流れのタブが見えない

原因: スマホ幅では引き出し(`aside.drawer`)が全画面の縦並び(flex)で、中の `.ds-drawer` が `min-height: 100%` の高さに収まろうとして縮む。
縮むとき、`overflow-x: auto` を持つタブの列は最小の高さが 0 になり、高さ 0 に潰れていた。

直し方: スマホ幅の引き出しでは、`.ds-drawer`・見出し・タブ・下の帯を縮めない(`flex: none`)。編成の引き出しは、パソコンの角丸のための
`overflow: hidden` をスマホでは `auto` にして、長い中身を動かせるようにした。

撮り方は `docs/screenshots/80/README.md` と同じ(`?tab=office&drawer=formation&dtab=islands|routes|flows#/p/1`、390px)。

| タブ | 直す前 | 直した後 |
|---|---|---|
| 島 | ![](formation-islands-before-390.png) | ![](formation-islands-after-390.png) |
| 連絡経路 | なし | ![](formation-routes-after-390.png) |
| 流れ | ![](formation-flow-before-390.png) | ![](formation-flow-after-390.png) |
