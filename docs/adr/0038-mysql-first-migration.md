# ADR-0038: MySQL の最初の版と schema_version

- 状態: 提案
- 日付: 2026-11-13

## 背景

DB を MySQL にも置けるようにする(docs/mysql.md、ADR-0036・0037)。SQLite は版 1〜21 を順に流して今の形になるが、MySQL に同じ道をたどらせる必要は無い。

## 決定

- MySQL の最初の版は、SQLite の本部の版 2 とプロジェクトの版 21(R15〜R17・メンバーとの会話・`project_id` まで)を合わせた形を丸ごと作る。版の番号は SQLite のプロジェクト DB と同じ 21。以後の版(22〜)は同じ番号で SQLite にも MySQL にも流す。
- 版は `schema_version` 表(`version`, `applied_at`)に持つ。実行器(`src/db/mysql-migrate.ts`)は、最大の版より後の版だけを昇順に流し、流し終えたら 1 行を足す。`GET_LOCK` で同時の実行を待たせる。
- 1 版 = 1 つの DDL(`statements` を順に流す)。MySQL の DDL は巻き戻せないので、途中で止まっても流し直せるよう `CREATE TABLE IF NOT EXISTS` / `INSERT IGNORE` で書き、索引は CREATE TABLE の中に書く。版の行は最後に足すので、止まった版は次に最初から流れる。
- 型: id は `BIGINT AUTO_INCREMENT`(他の表を指す列も BIGINT)、索引・UNIQUE・主キーに入る文字列は `VARCHAR(191)`(他は `TEXT`)、REAL は `DOUBLE`。InnoDB・utf8mb4_bin。
- `one_run_per_ticket` は部分索引が無いので、生成列 `active_ticket_id`(`ended_at IS NULL` のときだけ `ticket_id`)の UNIQUE にする。
- 全部のプロジェクトの表の `project_id` は `projects(id)` への外部キー。既定値は無い。1 つの database に複数のプロジェクトが入るので、UNIQUE・主キー(`tickets.number` など)は project_id 込みだけにし、SQLite の「前の UNIQUE も残す」はしない。
- 本部と同じ database に入れるので、`repos` は 1 つ(本部の列とプロジェクトの列は同じ)。最初の行は `workspaces` の id=1「既定」だけで、`plan_stages` などの最初の行はプロジェクトを作るときに入れる。
- 既存のチケットの `dev_done` を埋める決まりは、SQLite の版 19 と同じ(`src/domain/dev-done.ts`): 工程が review / sec / qa / decision / merge / done のどれか、または開発(`role = 'dev'`)の起動があれば 1、そうでなければ 0。この版は空の database に流すだけなので入れず、データを移すときに入れる。
  - SQLite から MySQL へ移す道具(`src/db/sqlite-to-mysql.ts` の `transferSqliteToMysql`)は、プロジェクトごとに `tickets` と `runs` を入れ終えてから `backfillDevDone`(`src/db/mysql-backfill.ts`)を呼ぶ。0 から 1 にするだけで、1 のものは触らない。何度呼んでも同じ。
  - 移すときの id: 最初のプロジェクトは id のまま、2 つ目からは「移し先のその表の最大の id + 元の id」に付け替える(他の表を指す列と、受信箱の payload・events の data の中の id も。付け替えるキーは decision_id・toMemberId・memberId・runId・run_id・unit_id・questionId に限る。events の data の `id`・`reference`・`actual`・`diff` のように別の意味にも使う名前や、履歴だけに使うものは付け替えない)。workspaces は元の名前で上書きする。移し先にプロジェクトがすでにあるときは止め、全部を 1 つのトランザクションで入れる。
  - 設計書の書き出しから戻すとき(`restoreTransfer`)は、`devDone` が書いてある書き出しはそのとおりに戻す。`devDone` の無い古い書き出しは、工程だけで決める(書き出しに起動の記録が無いので、開発の起動の有無は見られない)。

## 結果

- `src/db/mysql-migrate.test.ts` が mysql-test(`KURAMOTO_MYSQL_TEST_URL`、既定は 127.0.0.1:3307)に流し、表・列が SQLite と一致すること、版が 21 であること、2 回流しても変わらないことを確かめる。繋がらないときは飛ばす。
- `src/db/dev-done.test.ts` が、SQLite の版 18 のデータに版 19 を流した結果と、`inferDevDone`・MySQL の `backfillDevDone` の結果がそろうことを、工程 8 通り × 起動の有無で確かめる(MySQL は繋がらないときは飛ばす)。
- `src/db/sqlite-to-mysql.test.ts` が、移したあとの `dev_done` が SQLite の版 19 の結果とそろうこと(プロジェクトごとに `backfillDevDone` を呼ぶこと・id の付け替え)を確かめる(MySQL は繋がらないときは飛ばす。呼ぶ順序だけは MySQL が無くても確かめる)。
- 実行の入口は `kuramoto db transfer`(`src/db/transfer-cmd.ts`、手順は [docs/mysql.md](../mysql.md) の 6)。`config.ts` の MySQL の接続先を `loadConfig` で読み(移す道具は起動ではないので、`startDatabase` を通さず、自分で繋ぐ)、`connectMysql` で最新の版まで流してから、`openDb` で最新の版まで流した本部・プロジェクトの SQLite を `transferSqliteToMysql` に渡す。結果はプロジェクトごとのチケット数と、`dev_done` を埋めた件数で出す。`src/db/transfer-cmd.test.ts` が確かめる(MySQL の部分は繋がらないときは飛ばす)。
- サーバー・`Project` の読み書きの本体は、#65 で MySQL に繋いだ(ADR-0041)。移したあとは、`config.yaml` を `type: mysql` にして起動する。
