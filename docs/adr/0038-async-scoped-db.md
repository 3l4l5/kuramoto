# ADR-0038: 本部・入口・受信箱・ディスパッチャを、Kysely とスコープつきの口に移す

- 状態: 提案
- 日付: 2026-11-13

## 背景

ADR-0036 の土台と ADR-0037 のスコープ(workspace_id・project_id)の上で、まず本部・入口・受信箱・ディスパッチャ(起動の記録)を Kysely に移す(未決 #23 の 1/2)。残り(Project の各メソッド・workflow など)は 2/2。

## 決定

- **スコープつきの口**。`src/db/conn.ts` に `Conn`(接続 1 本の上の Kysely とトランザクション)・`ProjectDb`(project_id)・`HqDb`(workspace_id)を置く。`from / insert / update / deleteFrom` は、スコープの列で絞る・値を入れる。本部は `Hq.hqdb`、プロジェクトは `Project.pdb` で、下へはこの口を渡す。
- **入口**。いまのワークスペースは `currentWorkspaceId()`(今は常に 1)で決め、server / cli の入口で `Hq` に渡す。プロジェクトの id がワークスペースの中にあるかは `Hq.project(id)` / `Hq.openProject(id)` が確かめる(外・無い id は投げる)。server は、リクエストの入口(`open(id)`)でこれを通し、以後は開いたものを同期で引く。
- **トランザクションの口は `Conn.transaction()` に寄せる**。接続ごとの順番待ち(Kysely の接続は 1 本で、トランザクションの間はほかのクエリを待たせる)と、入れ子の相乗り(`AsyncLocalStorage`)を持つ。移した範囲(inbox・dispatcher・hq)の書き込みはこれだけを通る。
- **同期の `tx()` は、まだ移していない書き方のためだけに残す**(2/2 で無くす)。非同期トランザクションの中(同じ流れ)から呼ぶのは外側に相乗りする。他の流れが開いている非同期トランザクションの最中に呼ばれたら、黙って混ざらないよう投げる。ディスパッチャの `housekeep()` のように、同期の書き込みを並列の起動と同じ接続で流すところは、`transaction()` の中で呼んで順番待ちにする。
- **受信箱の取り出し**は `dialect.claimMessage`(SQLite は 1 文の UPDATE ... WHERE id = (候補) RETURNING)。`claimNext` は候補の SELECT を Kysely で組み、project_id で絞る。
- **repos**。本部の `repos` には書かない。プロジェクトの `repos` だけを正にする(本部の表は残す。読む側はもともと無い)。
- **project_id の埋め直し**(ADR-0037 の「結果」の続き)。移した書き込み(messages・runs)は project_id を書く。そのほかで 0 のまま入った行(seed・まだ同期の書き込み)は、`Project` を開くたびに、全部の表の project_id=0 の行をそのファイルのプロジェクトの id で埋める。

## 結果

- `Hq` のメソッド(`createProject / projects / project / openProject / updateProject / setStatus / ownerQueue`)・`claimNext / complete / release / fail / recoverStale / pendingCount`・`Dispatcher.next()`・`KuramotoServer` の `resume / start / stop` と各ビューは async。
- `send()`(受信箱へ入れる側)は同期のまま。呼び出し元の workflow などが、まだ同期の書き込みの途中から呼ぶため。project_id は書く。2/2 で async にする。
- 同期の書き込みで project_id=0 のまま入った行は、次に開くまで 0 のまま。移した範囲のクエリは messages・runs だけを project_id で絞り、ほかの表は id で引くので、見え方は変わらない。
