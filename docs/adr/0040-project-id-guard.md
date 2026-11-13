# ADR-0040: project_id の見張りと、同期の書き込みの見張り(DB の非同期化 2/2 の土台)

- 状態: 提案
- 日付: 2026-11-13

## 背景

ADR-0039(1/2)の続き。残りの src/project・server を async + Kysely に移す前に、移す途中で取りこぼしを落とす見張りを先に入れる。

## 決定

- **project_id の見張り**(`src/db/guard.ts`)。Kysely のプラグインで、project_id の表を触る SELECT / UPDATE / DELETE が project_id を参照していない、INSERT の列に project_id が無い、生 SQL(RawNode)のときに投げる。テストでは vitest の setup(`src/db/vitest-setup.ts`)で有効にし、`ProjectDb` に付く。本番の ProjectDb には付けない(`ProjectDb.from / insert / update / deleteFrom` が必ず付けるので、見張りが落とすのは口を通さない書き方)。
- **同期の書き込みの見張り**。`tx()` が持っていた「他の流れの非同期トランザクションの最中なら投げる」を、`run()` にも掛ける。D2(#64)で同期の書き込みが本番の道から無くなった(`run()` を呼ぶのは試験の下ごしらえだけ)ので、掛けるのはテストだけという切り替え(`syncWriteGuardOn`)は外し、`tx()` と同じく常に有効にした。`p.event`・`run(p.db, ...)` が、並列の起動の `Conn.transaction()` に黙って混ざるのを防ぐ。1 本の接続に `Conn` が複数かぶっても(同じ接続に 2 つのプロジェクトの口を置くとき)見張れるよう、接続ごとに全部の `Conn` を持つ。同期の書き込み自体を無くすのは、移し終えたとき(各ファイルの移行)。
- **検査**(`src/db/no-raw-sql.test.ts`)。node:sqlite を直接 import しない。同期の `all / get / run / tx` を import できるのは、一覧(まだ移していないファイル)だけ。一覧は増やさず、移したら外す。移したファイルに方言に依る生 SQL を書かない。
- **project_id=0 の埋め直し**。版 20 のあとに 0 で入った行は、`Project` を開くたびに埋めていた(ADR-0039)。D2(#64)で同期の書き込みが無くなったので、埋め直し(`backfillProjectId`)と、開いている間の TEMP トリガは外した。

## 結果

- 見張りは土台のみ。#17 は土台で閉じ、async 化は NOT_MIGRATED の一覧を減らす単位で別チケットに分けた(いずれも「対象を async + Kysely に移し、一覧から外し、npm test・e2e が通る」が受け入れ条件。「読んでから書く」は tx か 1 文に、画面の取得は IN (…) でまとめる):
  - A. 工程・交通整理・見回り(workflow・progress・unstick・patrol・triage・dispatcher の残り)
  - B. レビュー・merge・チームの CI(review・merge・ci-tools・outage・budget)
  - C. 企画スタジオ・生産性・R15〜R17(planning・planning-agent・design・design-visual・productivity・metrics・ticket・transfer・questions・member-chat・leadchat ほか)
  - D. server・Project 本体(最後。「project / hq が node:sqlite を直接 import しない」を満たし、同期の run() の見張りを本番でも有効にする、または同期の書き込みを無くす。#16 レビューの「同期の書き込みが他の流れの非同期トランザクションに混ざる」はここで閉じる)
- **同じ database に 2 つのプロジェクトを置くとき**(#41 で解決): 版 21 は前の版の UNIQUE(tickets.number・settings.key など)を残していたので、SQLite のままでは別のプロジェクトでも同じ number・key は入らなかった。SQLite の版 22 で、次の表を作り直して UNIQUE を (project_id, …) だけにした(MySQL の最初の版は最初からこの形。MySQL の版 22 は流すものの無い印)。
  - 外した前の UNIQUE → 付けた UNIQUE: `tickets(number)` → `(project_id, number)`、`repos(full_name)` → `(project_id, full_name)`、`formations(version)` → `(project_id, version)`、`policies(role, version)` → `(project_id, role, version)`、`requirements(version)` → `(project_id, version)`、`settings(key)`(主キー)→ 主キー `(project_id, key)`、`plan_stages(stage)`(主キー)→ 主キー `(project_id, stage)`、`dev_rule_versions(version)`(主キー)→ 主キー `(project_id, version)`。
  - 変えないもの: `sessions(member_id, ticket_id, repo_id)`・`pull_requests(ticket_id, repo_id)`・`ticket_deps`・`ticket_areas` の主キー・`one_run_per_ticket(ticket_id)` は id だけでできていて、id は全プロジェクトで重ならないので project_id は要らない(MySQL も同じ)。
  - SQLite は表の UNIQUE・主キーを外せないので、対象の表を作り直す(行・id・列の並びは同じ。外部キーの検査はトランザクションの最後まで遅らせる)。
  - `ON CONFLICT(key)` のような、前の UNIQUE の列だけを指す書き方は通らなくなる。`Project.setSetting` は `ON CONFLICT(project_id, key)` に替えた。ほかのクエリは、A〜C の async 化で ProjectDb を通るときに project_id を書く。

## C(#44)の途中経過

- 移した: metrics・productivity・formation-marks・transfer(と export の async 化)・design・planning-agent・design-visual・ticket(ticketView)・office・people・team・onboard、C2(#57)で planning・questions・leadchat・member-chat・dev-rules・prompts。planning は 段階・版・要件・未決・コメント・画面の取得。画面ごとの取得は 1 文にまとめ、版を上げる・未決に答える・企画の担当への送信は tx の中で読んでから書く。要件の番号の最大・並びは JS で数え、方言に依る SQL は dialect を通す。dev-rules の版を上げる(版を読んで +1 して書く)・ルールを足す(同じひな形の有無を読んでから書く)・違反を残す・member-chat の返事を残す・leadchat のチャットの受信箱への送りまとめは、tx の中で読んでから書く。ルールごとの違反の数・手順・トークンの合計は、SUM(...) や相関サブクエリでなく、行を IN / JOIN で 1 文で取って JS で数える。
- **読むときの project_id は、C の間だけ「自分の id と 0」だった(`src/db/count.ts` の `inScope` / `countFrom`)**。同期の INSERT が project_id を書かず 0 のまま残るため、`= 自分の id` だけだと開いている間の画面から行が欠けた。D2(#64)で同期の書き込みが無くなり、`= 自分の id` に戻した(`scopeIds` は消した)。
- dev_rule_versions は、版の番号をプロジェクトごとの MAX で決め、project_id を書いて残すようにした(同期のまま。#41 の QA)。
- **#45 の D1 で Project 本体(project/project.ts)と inbox の send を async + Kysely に移した**。開くのは `Project.open()`(seed・席埋めが非同期のため。コンストラクタは private)。Project のメソッド(setting・ticket・event・send など)はすべて Promise を返し、呼び出し元とテストに await を足した。tx の中の send・p.event・addTicket などは、await すれば同じ tx(`p.pdb.transaction`)に入る(project-tx.test.ts)。await の付け忘れは `npm run lint`(@typescript-eslint の no-floating-promises・no-misused-promises・await-thenable。eslint.config.mjs)で見つける。まだ移していないのは **server.ts だけ**(D2)。MySQL の配線・流れ全体の e2e・移す道具は D3。
- **#64 の D2 で server.ts を async + Kysely に移し、NOT_MIGRATED を空にした**。ボードの `projectView` がチケットごとに投げていた runWork・blockers・areaWait・mergeBlockers・droppedInfo・openViolations(と、triaged・conflict の 1 件ずつの SELECT)は、チケット全部ぶんを `IN (…)` でまとめて 1 文ずつ引く(`runWorks`・`blockersOf`・`areaWaitOf`・`mergeBlockersOf`・`droppedInfos`・`openViolationsOf`。1 枚ずつ引く版は、まとめ引きを 1 件で呼ぶ形に寄せた)。外したもの: Project の TEMP トリガと `backfillProjectId`(project_id = 0 の埋め直し)、`syncWriteGuardOn`、count.ts の `IN (自分, 0)`。同期の `run()` は試験の下ごしらえにだけ残り、他の流れの非同期トランザクションの最中なら常に投げる。以降、project_id を書かずに入れた行は、見えない。
