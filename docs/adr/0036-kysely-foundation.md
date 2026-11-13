# ADR-0036: DB の口を Kysely にする土台

- 状態: 提案
- 日付: 2026-11-13

## 背景

DB の読み書きは、`src/db/sqlite.ts` の `all` / `get` / `run` に SQL の文字列を渡す書き方で、表の列の型はクエリごとに手で書いていた。SQLite 以外の DB に移れる形にしたいが、いきなり project / hq の全クエリを書き換えると大きすぎる。先に土台を入れ、動きは変えない(未決 #23・#24 の答え)。

## 決定

- Kysely を入れる。`src/db/kysely.ts` に、node:sqlite(`DatabaseSync`)を Kysely の `SqliteDialect` に渡す薄いドライバを置く。開いてある接続を共有し(`createKysely(db)`)、閉じるのは接続の持ち主。Kysely が張るトランザクションは `BEGIN IMMEDIATE` にする(`tx()` と同じ)。
- 表の型は `src/db/tables.ts` に手で書く。`tables.test.ts` が、全マイグレーションを流した実際の表(列の並び・型・null・既定値・CHECK)と突き合わせる。マイグレーションを足したら型も直す。
- 方言ごとに書き方が変わるところ(JSON の取り出し・UPSERT・挿入した id・受信箱の取り出し・id の列と索引できる文字列の型・部分索引)は `src/db/dialect` に集める。クエリを書く側は方言の名前を直接書かず、ここを通す。いまの実装は SQLite だけ。
- マイグレーションの実行器(`src/db/migrate.ts`)は自前にする。版は SQLite の `PRAGMA user_version` のまま、1 版ごとに 1 トランザクション。これまでの版(SQL の文字列)はそのまま流れ、以後の版は Kysely のスキーマビルダを返す関数でも書ける。Kysely の Migrator は使わない(版の置き場所が別の表になり、同期で動かせないため)。

## 結果

- 既存の DB はそのまま開ける。project / hq はまだ書き換えない(`openDb` は同期のまま)。
- 関数の版は、ビルダを返すだけにする(中で `execute()` を呼ばない)。データを読んでから書くような版は、SQL の文字列で書く。
- Kysely 自身の `transaction()` と `tx()` を入れ子にはできない(SQLite は入れ子のトランザクションを持たない)。書き換えを進めるときに、どちらかに寄せる(ADR-0038: 移した範囲は `Conn.transaction()` に寄せ、同期の `tx()` は移していない書き方のためだけに残す)。
