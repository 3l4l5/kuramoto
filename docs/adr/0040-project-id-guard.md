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

- 見張りは土台のみ。#17 は土台で閉じ、async 化は NOT_MIGRATED の一覧を減らす単位で別チケットに分けた(いずれも「対象を async + Kysely に移し、一覧から外し、npm test・e2e が通る」が受け入れ条件。「読んでから書く」は tx か 1 文に、画面の取得は IN (…) でまとめる):
  - A. 工程・交通整理・見回り(workflow・progress・unstick・patrol・triage・dispatcher の残り)
  - B. レビュー・merge・チームの CI(review・merge・ci-tools・outage・budget)
  - C. 企画スタジオ・生産性・R15〜R17(planning・planning-agent・design・design-visual・productivity・metrics・ticket・transfer・questions・member-chat・leadchat ほか)
  - D. server・Project 本体(最後。「project / hq が node:sqlite を直接 import しない」を満たし、同期の run() の見張りを本番でも有効にする、または同期の書き込みを無くす。#16 レビューの「同期の書き込みが他の流れの非同期トランザクションに混ざる」はここで閉じる)
- **同じ database に 2 つのプロジェクトを置くとき**、版 21 は前の版の UNIQUE(tickets.number・settings.key など)を残している。SQLite のままでは、別のプロジェクトでも同じ number・key は入らない。MySQL の最初の版で project_id 込みの UNIQUE だけにするか、SQLite 側で前の UNIQUE を外すかは、同じ database に置く段で決める。

## C(#44)の途中経過

- 移した: metrics・productivity・formation-marks・transfer(と export の async 化)・design・planning-agent・design-visual・ticket(ticketView)。
- **読むときの project_id は「自分の id と 0」(`src/db/count.ts` の `inScope` / `countFrom`)**。Project 本体・workflow・planning などの同期の INSERT は project_id を書かず、開き直すまで 0 のまま。`= 自分の id` だけで読むと、開いている間の画面から、その間に入った行(チケット・出来事・設定など)が欠ける。同期の書き込みが無くなったら(D)、`= 自分の id` に戻す。
- まだ移していない(C の残り): planning・questions・leadchat・member-chat・dev-rules・office・people・onboard・prompts・team。leadchat の `leadReply`・`sayToLead` を async にすると outage(B)・dispatcher(A)・server へ await が広がるため、A・B と足並みを揃えて移す。
