# ADR-0041: MySQL のアダプタ(mysql2・TLS・受信箱の取り出し・切れたときの待ち)

- 状態: 提案
- 日付: 2026-11-13

## 背景

ADR-0036〜0040 で、Kysely・スコープつきの口・MySQL の最初の版が揃った。ここに、実際に MySQL へ繋ぐ部分を足す(チケット #21)。

## 決定

- **開き方**。`config.yaml` が mysql(または `KURAMOTO_DATABASE_URL` が mysql://)のとき、`src/db/mysql.ts` が mysql2 のプールと Kysely の `MysqlDialect` で開く。起動時に繋いで `migrateMysql` で版を最新にする(`connectMysql`)。
- **TLS**。外の DB は `tls.ca` 必須(CA で証明書を確かめる)。ループバック(127.0.0.1・localhost・::1)だけは省ける。外の DB で無いときは繋ぎに行かず起動しない。
- **起動時に届かないとき**。`DatabaseConnectError`(接続を断られた・名前を引けない・時間切れ・パスワード違い・database が無い・証明書を確かめられない)を理由つきで出し、起動しない。SQLite には黙って戻さない。理由の文にパスワードは含めない。
- **口(Conn)の方言**。`Conn` は SQLite(DatabaseSync)か MySQL(プールの上の Kysely)のどちらの上にも作れ、方言(`conn.dialect`)を持つ。受信箱のクエリは `p.pdb.dialect` を通す。`dialect`(index.ts)は、Conn を通らない SQLite 専用の書き方のための既定として残す。
- **トランザクションは専用の接続**。Kysely の MysqlDriver は、`transaction()` のたびにプールから接続を 1 本取り、終わるまで持つ。SQLite のような順番待ちは MySQL では要らない(接続が複数ある)。入れ子は今までどおり AsyncLocalStorage で外側にまとめる。
- **受信箱の取り出し**(`mysqlDialect.claimMessage`)。トランザクションの中で、候補の SELECT に `FOR UPDATE SKIP LOCKED` を付けて 1 行ロックして取る → `UPDATE ... WHERE id = ? AND project_id = ? AND status = 'pending'` → 更新した件数が 1 のときだけ、その行を SELECT して返す。ほかの取り出しがロックしている行は飛ばし、同じ 1 通を 2 度取らない。すでにトランザクションの中なら、その上で流す。
- **挿入した id** は `insertId`(MySQL に RETURNING は無い)。
- **切れたときの待ち**(`src/db/mysql-health.ts` の `DbHealth`)。一定の間隔(5 秒)で ping し、返らなければ「切れた」、返れば「繋がった」にする。クエリが接続のエラー(`isConnectionError`)で落ちたときも、すぐ「切れた」にできる(`reportFailure`。サーバーの `tick`・自動 merge の catch が呼ぶ)。切れている間は、サーバーが受信箱の見回り(`tick`)と自動 merge を止め、ディスパッチャ(`dbUp`)は受信箱から取らずエージェントを起動しない(動いている起動の終わりだけ待つ)。繋がり直したら、サーバーが全プロジェクトの受信箱をすぐ見直す。画面は、プロジェクトの上の警告に「DB に繋がらない(いつから・エラー)」を出す(`projectView().dbDown`)。
- **初めて繋いだとき**。`schema_version` が無かった(=その database に初めて繋いだ)うえで、本部の SQLite(hq.sqlite。読むだけ)にプロジェクトが残っていれば、「SQLite のプロジェクトは MySQL には移りません。企画は設計書(書き出し)で移せます」を 1 行出す。
- **閉じ込め**。`KURAMOTO_DATABASE_URL` は、シェルに渡さない環境変数(`HIDDEN_ENV`)に入れ、SDK に渡す環境変数からも外す。チームの CI も `hiddenEnv` を外して流すので、渡らない。

## 起動の配線(チケット #65 で止めを外した)

アダプタ・見張り・受信箱の取り出しを入れた時点(#21)では、`Project`・`Hq`・ディスパッチャの本体がまだ SQLite の上でしか動かなかったので、`loadStartupConfig` は `type: mysql` を ConfigError で止めていた(MySQL に繋いだと表示しながら、SQLite に書き続けることにならないように)。本体が Kysely の口(`Conn`)に移ったので(ADR-0039。#45 の D1・D2)、#65 で次のようにつないだ。

- **止めを外した**。`loadStartupConfig` は mysql でも設定を確かめて 1 行出すだけ(繋がない)。
- **入口が繋ぐ**。サーバー(`server.ts` の直接起動)と CLI(`cli.ts`)は、`loadStartupConfig` のあとに `startDatabase`(`db/startup.ts`)を呼ぶ。届かなければ `DatabaseConnectError` の理由を出して起動しない。返った `mysql`(プールと Kysely)を `new Hq(home, clock, workspaceId, mysql)` に渡し、`health` を `KuramotoServer` の `dbHealth` に渡す。終わるときは `startDatabase` の `close()` でプールを閉じる(`Hq.close()` と `Project.close()` は、MySQL では何も閉じない)。
- **Hq・Project の開き方**。`Hq` は `mysql` を渡されると、`hq.sqlite` を開かず、その Kysely の上に `HqDb` を作る。`Hq.openProject` は `Project.open(path, clock, id, mysql)` を呼び、`project.sqlite` を開かず、同じ database の `project_id = id` の行を開く(`ProjectDb`)。`Hq.db`・`Project.db`(SQLite の接続)は MySQL では投げる。挿入した id・JSON の取り出し・UPSERT は、既定の方言ではなく、接続の方言(`pdb.dialect`・`hqdb.dialect`)を通す。
- **切れたとき**。サーバーとディスパッチャが待つ受け口は #21 で入っていた。#65 で、CLI の `run` も `dbUp` を渡して同じように待つ。画面は、プロジェクトの上の警告(`dbDown`)に加えて、どの画面でも一番上に「DB に繋がらない」を出す(`GET /api/db` は DB を読まないので、切れている間も返る。画面が読めなくなっても、理由が見える)。API が接続のエラーで落ちたときも、見張りにすぐ知らせる。
- **SQLite からの移行**。`kuramoto db transfer`(ADR-0038。`db/transfer-cmd.ts`)が、本部と全プロジェクトを 1 つのトランザクションで移し、プロジェクトごとに `backfillDevDone` で `dev_done` を埋める(SQLite の版 19 と同じ結果になることを `sqlite-to-mysql.test.ts` が確かめる)。初めて繋いだときの 1 行は、この道具を案内する。
- **流れ全体の試験**。`src/flow-e2e.test.ts` が、フェイクのハーネスで チケット → 起動 → merge 待ち → merge を、SQLite の回と MySQL の回(mysql-test。`startDatabase` と `Hq` の入口どおり)で同じように流す。merge で done になったときの作業場所の片付け(`sessions.worktree_path` を外す。#61)・DB の切断と復帰の表示・開き直しても残ることも、MySQL で確かめる。

## 結果

- できたのは、繋ぐ・版を流す・受信箱の取り出しと状態遷移・切断の見張りと、サーバー・ディスパッチャ側の「待つ・再開する」の受け口まで。チケット #21 の受け入れ条件は、アダプタ単体の試験(受信箱の取り出し・失敗・やり直し・完了・同時取り出しで二重に取らないこと・切断と再接続・起動時に届かないとき理由を出して止まること・初めて繋いだとき SQLite のプロジェクトについて 1 行出すこと・TLS 必須)が mysql-test の上で通ること、に書き直した(`startDatabase` は入口から呼ばれなくてよい)。「mysql-test で流れ全体(フェイクのハーネス)が動く」と、`loadStartupConfig` の止めを外す・`startDatabase` を server・cli の入口から呼ぶ・画面に出す・README と docs/mysql.md の直しは、#65 で行った(上の「起動の配線」)。いまの実機の試験(`src/db/mysql-adapter.test.ts`)は、受信箱の流れ(取り出す・失敗・やり直し・完了・取りこぼしの回復・同時取り出し)と切断・再接続までを MySQL の上で流す。
- `src/db/mysql-adapter.test.ts` は mysql-test(`KURAMOTO_MYSQL_TEST_URL`、既定は 127.0.0.1:3307)に繋がるときだけ動く。mysql-test を使う試験ファイルは並列に動くので、名前つきのロック(`mysql-test-support.ts`)で順番にする。
