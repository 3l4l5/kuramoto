# ADR-0047: 起動の設定は ~/.kuramoto/config.yaml に書き、読めないときは黙って SQLite に戻さず起動しない

- 状態: 提案
- 日付: 2026-11-14
- チケット: #18(設定ファイルを読む)・#23(database のキーを docs/mysql.md と合わせる)

## 背景

DB を SQLite のほかに MySQL にも置けるようにする(ADR-0036〜0041)と、サーバーと CLI が「どの DB に繋ぐか」を起動のたびに知る必要がある。パスワードを設定ファイルや環境変数に直に書くと、バックアップ・画面共有・ログで漏れる。書き間違いのまま SQLite に戻って起動すると、気づかないうちに別の DB(空の DB)にデータを書いてしまう。

## 決定

- サーバーと CLI は、同じ設定ファイル `~/.kuramoto/config.yaml`(`kuramotoHome()` の下)を読む(`src/config.ts` の `loadConfig`)。ファイルが無ければ既定(SQLite)。
- 項目は `database`(`type`: sqlite | mysql・`url`・`passwordFile`・`tls.ca`)。未知のキー・書き方の違いは zod の `strict` で断り、**どこがおかしいか(ファイルのパスとキー)を出して起動しない**。SQLite に黙って戻さない。
- **パスワードは `config.yaml` に書かない**。`passwordFile`(`mysql.env` の形式)の `MYSQL_PASSWORD` の 1 行だけを読み、接続先に足す。`MYSQL_ROOT_PASSWORD` など、ほかの行は読まない。`url` にもパスワードがあると、どちらを使うか決められないので起動しない。行が無い・空のときも起動しない。値は URL に入れるとき `encodeURIComponent` し、値の後ろのコメントは docker compose の `env_file` と同じ規則で外す。
- 環境変数 `KURAMOTO_DATABASE_URL` は、`mysql://` の形のときだけ MySQL の接続先として使い、`type` より優先する。形が違えば起動しない。
- キー名・書き方は docs/mysql.md の手順と、実装(`type` / `url` / `passwordFile` / `tls`)でそろえる(#23)。

## 結果

- 書き間違いが、空の DB への書き込みにならず、起動時に見つかる。
- パスワードは別ファイル(`mysql.env`)に分かれ、root のパスワードは Kuramoto から読めない。
- 設定の項目を増やすときも、同じ `strict` の枠で足せる。

## 検討した別案

- **環境変数だけで設定する**: 手元で起動するたびに指定が要る。環境変数は残すが、接続先の上書き(`KURAMOTO_DATABASE_URL`)に絞った。
- **パスワードも `config.yaml` に書く**: 設定ファイルの取り扱いが重くなる。専用の `mysql.env` に分け、読む行も 1 行に絞った。
- **書き間違いのときは既定(SQLite)で起動する**: 気づかないまま別の DB に書く。止めて知らせるほうが、取り返しが付く。
