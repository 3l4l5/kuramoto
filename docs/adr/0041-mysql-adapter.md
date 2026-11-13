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
- **切れたときの待ち**(`src/db/mysql-health.ts` の `DbHealth`)。一定の間隔(5 秒)で ping し、返らなければ「切れた」、返れば「繋がった」にする。クエリが接続のエラー(`isConnectionError`)で落ちたときも、すぐ「切れた」にできる(`reportFailure`)。切れている間は、サーバーが受信箱の見回り(`tick`)と自動 merge を止め、ディスパッチャ(`dbUp`)は受信箱から取らずエージェントを起動しない(動いている起動の終わりだけ待つ)。繋がり直したら、サーバーが全プロジェクトの受信箱をすぐ見直す。画面は、プロジェクトの上の警告に「DB に繋がらない(いつから・エラー)」を出す(`projectView().dbDown`)。
- **初めて繋いだとき**。`schema_version` が無かった(=その database に初めて繋いだ)うえで、本部の SQLite(hq.sqlite。読むだけ)にプロジェクトが残っていれば、「SQLite のプロジェクトは MySQL には移りません。企画は設計書(書き出し)で移せます」を 1 行出す。
- **閉じ込め**。`KURAMOTO_DATABASE_URL` は、シェルに渡さない環境変数(`HIDDEN_ENV`)に入れ、SDK に渡す環境変数からも外す。チームの CI も `hiddenEnv` を外して流すので、渡らない。

## 結果

- できたのは、繋ぐ・版を流す・受信箱の取り出しと状態遷移・切断の見張りまで。`Project`(同期の node:sqlite)・workflow・`Hq`・ディスパッチャの本体は、まだ SQLite の上でしか動かない。したがって、MySQL の上でフェイクのハーネスを使った「流れ全体」を通すのは、残りの async 化(ADR-0039 の 2/2)のあと。いまの実機の試験(`src/db/mysql-adapter.test.ts`)は、受信箱の流れ(取り出す・失敗・やり直し・完了・取りこぼしの回復・同時取り出し)と切断・再接続までを MySQL の上で流す。
- サーバーと CLI は、MySQL のとき繋いで版を流し、見張りを付ける。読み書きの本体はまだ SQLite。
- `src/db/mysql-adapter.test.ts` は mysql-test(`KURAMOTO_MYSQL_TEST_URL`、既定は 127.0.0.1:3307)に繋がるときだけ動く。mysql-test を使う試験ファイルは並列に動くので、名前つきのロック(`mysql-test-support.ts`)で順番にする。
