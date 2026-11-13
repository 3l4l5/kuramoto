# Kuramoto

AI のエージェントたちを開発チームとして動かし、その働きぶりをオフィスの様子として見せるツールです。

- 責任者が GitHub のリポジトリを登録すると、AI のチームが要件定義から実装・レビュー・merge 待ちまでを進めます。
- 責任者が対応するのは、チームの中で片付かない判断と merge だけです。
- チームの編成・モデル・方針をつまみとして調整し、完成 1 件あたりのトークン・責任者の判断回数・フロー効率を上げていきます。

動く mock に加えて、土台の実装(DB・受信箱・ディスパッチャ・工程の流れ・merge・CLI)を始めています。画面はまだです。

## 動かし方(開発中)

Node 24 以上が要ります。エージェントを実際に動かすには `claude`(Claude Agent SDK が使う)と `gh` にログインしておきます。

```sh
npm install
npm start            # 画面をビルドして起動。http://localhost:4300 を開く(KURAMOTO_PORT で変更可)
npm run start:public # 他の PC からも開けるように起動。ターミナルに出る「合言葉つきの URL」を開く(合言葉は ~/.kuramoto/access-token。KURAMOTO_TOKEN で指定も可)
                     # PC を守るため、同時に動く担当は全体で 3 人まで(KURAMOTO_MAX_RUNS)。ディスクの空きが 15GB を切ると
                     # 新しいチケットの仕事を止める(KURAMOTO_MIN_FREE_GB。0 で見張らない)。終わったチケットの作業場所は自動で消す(ADR-0036)
npm test             # サーバー側のテスト(フェイクのハーネスで流れ全体を確かめる)
npm run e2e          # 画面の E2E テスト(手元の Google Chrome を使う。本物の Claude と GitHub は使わない)
npm run dev:ui       # 画面を作るとき: Vite の開発サーバー(http://localhost:5173)。/api は npm start のサーバーへ回す
```

1. 本部の「+ プロジェクトを作る」で名前とリポジトリを登録すると、企画スタジオが開き、企画の咲季が要件を聞き始めます。
2. 要件 → ユーザーフロー → 画面デザイン → インフラ → アーキテクチャとデータ を、段階ごとに合意(またはお任せ・省略)して進めます。
3. 「チームに渡す」でリーダーの星南がチケットを作ります。オフィスの「始業」で開発が始まります(「終業」で止まります)。判断カードと merge は「あなたの対応」に出ます。データは `~/.kuramoto/`(`KURAMOTO_HOME` で変更可)に置きます。同じ操作は CLI(`npm run dev -- --help` 相当、`src/cli.ts`)でもできます。

## コードの地図

| 場所 | 中身 |
|---|---|
| `src/db/` | SQLite(`node:sqlite`)とスキーマ(設計書 9 章) |
| `src/domain/` | 役割・モデル・既定の方針、編成の決まりと工程の組み立て |
| `src/server.ts` | ローカルサーバー(API・画面の配信・受信箱の見回り)。画面に渡す型(`HqView` など)もここから出す |
| `ui/` | 画面(React + TypeScript + TanStack Query、Vite でビルド)。見た目はデジタル庁デザインシステム(`ui/src/dads/` は公式コードスニペットの写し) |
| `e2e/` | 画面の E2E テスト(Playwright)と、フェイクの担当で動くテスト用サーバー |
| `src/project/planning.ts` / `planning-agent.ts` | 企画スタジオ(段階・版・未決・コメント・引き渡し)と、企画の担当に渡す道具 |
| `src/hq.ts` | 本部(プロジェクトの作成・全体の「あなたの対応」) |
| `src/project/inbox.ts` | 受信箱(取り出し・再試行・仕事の取り方の順番) |
| `src/project/dispatcher.ts` | ディスパッチャ(担当決め・応援・1 チケット 1 起動・予算) |
| `src/project/workflow.ts` | 報告を工程に反映(差し戻し・往復の上限・判断カード) |
| `src/project/merge.ts` | 責任者の merge と衝突の確かめ直し |
| `src/harness/` | ハーネスの差し替え口と Claude Agent SDK の実装 |

## 文書

| 文書 | 中身 |
|---|---|
| [docs/design.md](docs/design.md) | 設計書。全体構成・役割・仕事の流れ・画面・つまみ・指標・データ設計 |
| [docs/adr/](docs/adr/) | 判断の記録(1 件ずつ、背景・決定・結果・検討した別案) |
| [docs/mock.md](docs/mock.md) | mock の動かし方と、シミュレーションに置いた仮の値 |
| [mock/index.html](mock/index.html) | mock 本体。ブラウザで開けば動く |
