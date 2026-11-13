# ADR-0042: npm test は SQLite と MySQL の両方を流し、チームの CI で止める

- 状態: 提案
- 日付: 2026-11-13

## 背景

MySQL への移行(ADR-0038〜0041)で、MySQL の上でだけ起きる不具合が入りうる。mysql-test(`compose.yaml`。127.0.0.1:3307)を使う試験は、繋がらないと黙って飛ばされていたので、CI が通っても MySQL の試験が流れていないことに気づけなかった(チケット #20 の QA の指摘)。複数の worktree から同時に流すと、1 つの database を取り合って混ざる(名前つきのロックで順番にしていただけ)。

## 決定

- `npm test` は `scripts/run-tests.ts` を動かし、**SQLite の回**と **MySQL の回**を 1 回ずつ流す。どちらかが落ちれば、終了コードは 0 にならない。引数は vitest にそのまま渡す。
  - SQLite の回: 全部の試験。mysql-test を使う試験の中身は飛ばす(`KURAMOTO_TEST_DB=sqlite`)。
  - MySQL の回: mysql-test を使う試験(`mysql-test-support` を読み込むファイル)だけを流す(`KURAMOTO_TEST_DB=mysql`)。本体はまだ SQLite の上でしか動かない(ADR-0041)ので、MySQL の上で流せるのはアダプタ・マイグレーションの試験まで。本体が移ったら、MySQL の回に流す試験を増やす。
- MySQL の回は、**回ごとの使い捨ての database**(`kuramoto_test_<時刻>_<乱数>`)を mysql-test に作り、試験のユーザーに全権限を渡し、終わったら(落ちても・中断しても)消す。回ごとに別の database なので、複数の worktree から同時に流しても混ざらない。作るのは mysql-test の root(テスト専用のパスワード。`KURAMOTO_MYSQL_TEST_ADMIN_URL` で変えられる)。
- mysql-test に繋がらなければ、**黙って飛ばさず**「`docker compose up -d mysql-test` が要る」と出して落とす。SQLite の回を流す前に確かめる。MySQL の回の中でも、繋がらなければ飛ばさずに落とす(`describe.skipIf` で飛ばすのは、SQLite の回と、vitest を直に動かしたときだけ)。
- 飛ばすスイッチは `KURAMOTO_SKIP_MYSQL_TESTS=1` だけ。MySQL の回を飛ばしたことを出す。
- チームの CI(ADR-0028)は、package.json から `npm test` を選ぶので、そのまま両方が流れる。MySQL の回が落ちる・mysql-test に繋がらないと `npm test` が落ち、PR は持ち主に戻り、merge 待ちに進まない。閉じ込め(`@anthropic-ai/sandbox-runtime`)は、ソケットを許している間(既定。`sandbox_strict_sockets` が 1 でない)は 127.0.0.1 の任意のポートへ繋げるので、127.0.0.1:3307 に届く(試験で確かめてある)。`sandbox_strict_sockets` が 1 のときは届かず、`npm test` が落ちる。
- `compose.yaml` の `mysql` の `env_file` は `required: false` にする。`~/.kuramoto/mysql.env` が無い環境(CI)でも、`docker compose up -d mysql-test` がプロジェクトの読み込みで失敗しない。

## 結果

- CI で MySQL の試験が流れていないのに通る、ということがなくなる。MySQL だけで落ちる試験を入れると、CI が止まる。
- e2e(`npm run e2e`)は SQLite のまま。
- チームの CI を動かす PC では、`docker compose up -d mysql-test` で mysql-test を立てておく。立っていなければ CI は落ちる(その案内が出力に出る)。
- mysql-test には、使い捨ての database が残ることがある(`kill -9` などで消せなかったとき)。mysql-test は tmpfs なので、止めれば消える。
