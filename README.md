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
npm test             # サーバー側のテスト(フェイクのハーネスで流れ全体を確かめる)。SQLite の回と MySQL の回を流す(要 docker compose up -d mysql-test。飛ばすなら KURAMOTO_SKIP_MYSQL_TESTS=1。docs/mysql.md)
npm run e2e          # 画面の E2E テスト(手元の Google Chrome を使う。本物の Claude と GitHub は使わない)
npm run dev:ui       # 画面を作るとき: Vite の開発サーバー(http://localhost:5173)。/api は npm start のサーバーへ回す
```

1. 本部の「+ プロジェクトを作る」で名前とリポジトリを登録すると、企画スタジオが開き、企画の咲季が要件を聞き始めます。
2. 要件 → ユーザーフロー → 画面デザイン → インフラ → アーキテクチャとデータ を、段階ごとに合意(またはお任せ・省略)して進めます。
3. 「チームに渡す」でリーダーの星南がチケットを作ります。オフィスの「始業」で開発が始まります(「終業」で止まります)。判断カードと merge は「あなたの対応」に出ます。データは `~/.kuramoto/`(`KURAMOTO_HOME` で変更可)に置きます。同じ操作は CLI(`npm run dev -- --help` 相当、`src/cli.ts`)でもできます。

## 設定ファイル(~/.kuramoto/config.yaml)

サーバーと CLI は、起動時に `~/.kuramoto/config.yaml`(`KURAMOTO_HOME` を変えたときはその下)を読みます。無ければ今までどおり SQLite を使います。起動時に、読んだ設定と DB の種類(MySQL ならホストと database 名)を 1 行出します。パスワードは出しません。

```yaml
# ~/.kuramoto/config.yaml(chmod 600 にしてください。本人以外が読めると注意が出ます)
database:
  type: mysql                # sqlite(既定)か mysql
  url: mysql://kuramoto@db.example.com:3306/kuramoto   # パスワードはここに書かず、passwordFile か KURAMOTO_DATABASE_URL で渡す
  passwordFile: ~/.kuramoto/mysql.env                  # 読むのは MYSQL_PASSWORD の 1 行だけ(root のパスワードは読まない。任意)
  tls:
    ca: /etc/ssl/certs/db-ca.pem                       # TLS の CA のファイル(外の DB では必須。手元 127.0.0.1 だけは省ける)
```

- 環境変数 `KURAMOTO_DATABASE_URL`(`mysql://ユーザー:パスワード@ホスト/データベース名`)があれば、ファイルの `database.url` と `type` より優先して MySQL を使います。
- 読めない・知らない `type`・知らない項目・MySQL なのに接続先が無い、というときは、どの項目(何行目)がおかしいかを出して起動しません。SQLite に黙って戻すことはしません。
- `type: mysql`(または `KURAMOTO_DATABASE_URL`)にすると、起動時に MySQL に繋いで版を最新にし、本部もプロジェクトもその上で動きます(`src/db/startup.ts` の `startDatabase` を、サーバーと CLI の入口が呼びます)。立て方・バックアップ・SQLite からの移し方は [docs/mysql.md](docs/mysql.md) です。
- MySQL のときの決まり: 外の DB は TLS 必須(`tls.ca`)。届かなければ理由を出して起動しない(SQLite に黙って戻らない)。動いている間に切れたら、受信箱の見回りとエージェントの起動を止めて待ち、画面の一番上に出して、繋がり直したら自動で再開する。初めて繋いだときに SQLite のプロジェクトが残っていれば、`kuramoto db transfer` で移せることを 1 行出す。SQLite の中身は自動では移らないので、先に `kuramoto db transfer` を流す。`KURAMOTO_DATABASE_URL` は閉じ込めの中には渡さない。

## コードの地図

| 場所 | 中身 |
|---|---|
| `src/db/` | SQLite(`node:sqlite`)・MySQL(mysql2 + Kysely)とスキーマ(設計書 9 章)。起動時の DB の用意(`startup.ts`)・切断の見張り・SQLite から MySQL へ移す道具 |
| `src/domain/` | 役割・モデル・既定の方針、編成の決まりと工程の組み立て |
| `src/server.ts` | ローカルサーバー(API・画面の配信・受信箱の見回り)。画面に渡す型(`HqView` など)もここから出す |
| `ui/` | 画面(React + TypeScript + TanStack Query、Vite でビルド)。見た目はデジタル庁デザインシステムのトークンに合わせた自前の部品(`ui/src/ds/`) |
| `e2e/` | 画面の E2E テスト(Playwright)と、フェイクの担当で動くテスト用サーバー |
| `src/project/planning.ts` / `planning-agent.ts` | 企画スタジオ(段階・版・未決・コメント・引き渡し)と、企画の担当に渡す道具 |
| `src/config.ts` | 起動の設定ファイル(`~/.kuramoto/config.yaml`)の読み込み |
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
| [docs/mysql.md](docs/mysql.md) | 手元の MySQL(`compose.yaml`)の立て方・バックアップ・戻し方・DB の切り替え |
| [docs/mock.md](docs/mock.md) | mock の動かし方と、シミュレーションに置いた仮の値 |
| [mock/index.html](mock/index.html) | mock 本体。ブラウザで開けば動く |
