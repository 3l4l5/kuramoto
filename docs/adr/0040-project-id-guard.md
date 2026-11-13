# ADR-0040: project_id の見張りと、同期の書き込みの見張り(DB の非同期化 2/2 の土台)

- 状態: 提案
- 日付: 2026-11-13

## 背景

ADR-0039(1/2)の続き。残りの src/project・server を async + Kysely に移す前に、移す途中で取りこぼしを落とす見張りを先に入れる。

## 決定

- **project_id の見張り**(`src/db/guard.ts`)。Kysely のプラグインで、project_id の表を触る SELECT / UPDATE / DELETE が project_id を参照していない、INSERT の列に project_id が無い、生 SQL(RawNode)のときに投げる。テストでは vitest の setup(`src/db/vitest-setup.ts`)で有効にし、`ProjectDb` に付く。本番の ProjectDb には付けない(`ProjectDb.from / insert / update / deleteFrom` が必ず付けるので、見張りが落とすのは口を通さない書き方)。
- **同期の書き込みの見張り**。`tx()` が持っていた「他の流れの非同期トランザクションの最中なら投げる」を、`run()` にも掛ける(ただしテストでだけ。移し終えるまでの本番では、トランザクションの中で外部 I/O を await する流れがあると、画面操作が時々例外になるため。`tx()` の見張りは本番でも有効)。`p.event`・`run(p.db, ...)` が、並列の起動の `Conn.transaction()` に黙って混ざるのを防ぐ。1 本の接続に `Conn` が複数かぶっても(同じ接続に 2 つのプロジェクトの口を置くとき)見張れるよう、接続ごとに全部の `Conn` を持つ。同期の書き込み自体を無くすのは、移し終えたとき(各ファイルの移行)。
- **検査**(`src/db/no-raw-sql.test.ts`)。node:sqlite を直接 import しない。同期の `all / get / run / tx` を import できるのは、一覧(まだ移していないファイル)だけ。一覧は増やさず、移したら外す。移したファイルに方言に依る生 SQL を書かない。
- **project_id=0 の埋め直し**。版 20 のあとに 0 で入った行は、`Project` を開くたびに埋める(ADR-0039)。ここで足すものは無い。

## 結果

- 見張りは土台のみ。工程・レビュー・merge・企画スタジオ・生産性などの async 化は、一覧のファイルを 1 つずつ移して外していく。
- **同じ database に 2 つのプロジェクトを置くとき**、版 21 は前の版の UNIQUE(tickets.number・settings.key など)を残している。SQLite のままでは、別のプロジェクトでも同じ number・key は入らない。MySQL の最初の版で project_id 込みの UNIQUE だけにするか、SQLite 側で前の UNIQUE を外すかは、同じ database に置く段で決める。
