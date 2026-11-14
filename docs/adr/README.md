# ADR(判断の記録)

Kuramoto の設計で下した判断を 1 件ずつ残します。状態は「承認」(責任者が決めた)と「提案」(推奨のまま、まだ確認していない)の 2 つです。

| 番号 | 判断 | 状態 |
|---|---|---|
| [0001](0001-orchestrator-not-harness.md) | エージェントの実行環境は作らず、その上で動く交通整理の層として作る | 承認 |
| [0002](0002-message-driven.md) | エージェント同士はメッセージで動かし、待っている間はトークンを使わない | 承認 |
| [0003](0003-local-sqlite-source-of-truth.md) | データの元はローカルの SQLite に置き、GitHub には結果を書く | 承認 |
| [0004](0004-hq-and-per-project-db.md) | 本部とプロジェクトの 2 層に分け、DB をプロジェクトごとに持つ | 承認 |
| [0005](0005-owner-fixes-own-pr.md) | 実装と修正を分けず、PR の持ち主が自分で直す | 承認 |
| [0006](0006-escalate-only-heavy-decisions.md) | 責任者には重い判断と merge だけを上げる | 承認 |
| [0007](0007-formation-and-flow-efficiency.md) | 役割と編成を分け、編成ごとのフロー効率で比べる | 承認 |
| [0008](0008-planning-studio-gates.md) | 企画を段階に分け、段階ごとに合意・お任せ・省くを選べるようにする | 承認 |
| [0009](0009-architect-and-domain-first.md) | アーキテクトを置き、ドメインモデルから設計する | 承認 |
| [0010](0010-role-policies-versioned.md) | 方針とモデルは役割ごとに版で管理し、作業場リポジトリには書かない | 承認 |
| [0011](0011-dev-rules-pattern-first.md) | 開発ルールは形式で確かめられるものを優先する | 承認 |
| [0012](0012-pluggable-harness.md) | ハーネスは差し替え口を作り、最初は Claude Agent SDK だけ載せる | 承認 |
| [0013](0013-owner-presses-merge.md) | merge は責任者が画面から押し、押した瞬間と押した後に確かめ直す | 承認 |
| [0014](0014-design-docs-in-workspace-repo.md) | 設計書は作業場のリポジトリの docs/ に PR で置く | 提案 |
| [0015](0015-infra-stage.md) | 企画スタジオの画面デザインの次にインフラの段階を置き、アーキテクトが受け持つ | 承認 |
| [0016](0016-architecture-style-in-model-stage.md) | アーキテクチャスタイルは「アーキテクチャとデータ」の段階の最初に決める | 承認 |
| [0017](0017-restore-from-exported-design-doc.md) | 書き出した設計書に復元用のデータを埋め込み、本部で読み込んでプロジェクトを戻す | 承認 |
| [0018](0018-digital-agency-design-system.md) | 画面の見た目をデジタル庁デザインシステムに合わせる | 承認 |
| [0019](0019-more-units-and-split-roles.md) | 島を 6 つまで置き、同じ役割を複数の島に持たせ、島ごとに受け持つリポジトリとモデルを決められるようにする | 承認 |
| [0020](0020-confine-agents-to-worktree.md) | エージェントを作業場所に閉じ込め、push と PR は Kuramoto が外で行う | 提案 |
| [0021](0021-review-blocks-only-on-acceptance-security-regression.md) | レビューで止めてよいのは、受け入れ条件・セキュリティ・この差分の不具合だけにする | 提案 |
| [0022](0022-nonstop-team-takes-responsibility.md) | ノンストップで進め、チームで責任を持つ(merge もチームが行う) | 提案 |
| [0023](0023-members-stay-at-max.md) | 島のメンバーは最大人数ぶんずっといる(応援を呼ばない・帰さない) | 提案 |
| [0024](0024-serialize-tickets-touching-same-area.md) | 同じ場所を触るチケットは同時に開発しない | 提案 |
| [0025](0025-recheck-only-changes-after-approval.md) | 承認のあとに戻ってきたら、その後の変更だけを確かめる。範囲外の指摘は merge のときに 1 回だけチケットにする | 提案 |
| [0026](0026-lead-patrols-board.md) | リーダーが定期的にボードを見回り、重複・いらなくなったチケットと回り続けているチケットに手を打つ | 提案 |
| [0027](0027-github-outage-and-ci-logs.md) | GitHub に入れないときはチームで待って自動で再開し、CI が落ちたら Kuramoto がログを取ってきて渡す | 提案 |
| [0028](0028-team-ci.md) | チームの CI を持ち、使うときは GitHub Actions を止める | 提案 |
| [0029](0029-flow-dashboard.md) | 生産性の画面に「流れ」と「メンバー」を足す | 提案 |
| [0030](0030-continue-existing-repo.md) | 既存のリポジトリの続きから始められるようにする | 提案 |
| [0031](0031-pause-studio-and-show-progress.md) | 企画スタジオを止められるようにし、段階ごとの進み具合を見せる | 提案 |
| [0032](0032-cap-session-resume.md) | 担当の会話を引き継ぐ回数に上限を設ける | 提案 |
| [0033](0033-match-screen-design.md) | 企画で合意した画面の試作を、作る人と確かめる人に渡して見比べる | 提案 |
| [0034](0034-design-system-and-visual-compare.md) | デザインシステムを企画の成果物にし、画面を画像で見比べる | 提案 |
| [0035](0035-studio-web-access.md) | 企画スタジオの担当が、外のサイトを検索して読めるようにする | 提案 |
| [0036](0036-kysely-foundation.md) | DB の口を Kysely にする土台(ドライバ・表の型・方言の助け・マイグレーションの実行器) | 提案 |
| [0037](0037-workspace-and-project-scope.md) | ワークスペースと project_id のスコープを足す | 提案 |
| [0038](0038-mysql-first-migration.md) | MySQL の最初の版と schema_version | 提案 |
| [0039](0039-async-scoped-db.md) | 本部・入口・受信箱・ディスパッチャを、Kysely とスコープつきの口に移す | 提案 |
| [0040](0040-project-id-guard.md) | project_id の見張りと、同期の書き込みの見張り | 提案 |
| [0041](0041-mysql-adapter.md) | MySQL のアダプタ(mysql2・TLS・受信箱の取り出し・切れたときの待ち) | 提案 |
| [0042](0042-test-sqlite-and-mysql.md) | npm test は SQLite と MySQL の両方を流し、チームの CI で止める | 提案 |
| [0043](0043-island-routes-and-ask.md) | 連絡経路を編成に持ち、島への質問・相談は経路があるときだけ届け、無ければリーダーに回す | 提案 |
| [0044](0044-ticket-kind-flows.md) | チケットに種類(feature/bugfix/refactor/docs)を持たせ、種類ごとの流れで進め、開発より前の確認は申し送りにする | 提案 |
| [0045](0045-member-chat.md) | メンバーとの会話は member_chat で起こし、今のチケットのセッションで答え、担当・工程は変えない | 提案 |
| [0046](0046-chat-about-finished-ticket.md) | 終わったチケット(done・dropped)に話しかけられたら、メモを書かず既定のブランチの読むだけの場所で答える | 提案 |
| [0047](0047-startup-config-file.md) | 起動の設定は ~/.kuramoto/config.yaml に書き、読めないときは黙って SQLite に戻さず起動しない | 提案 |
| [0048](0048-lead-reads-github.md) | リーダーは GitHub の PR・CI・merge の状態を「読むだけ」の道具で見る | 提案 |
| [0049](0049-release-finished-worktrees.md) | 終わったチケット(merge・すでに main に入っていた・取りやめ)の作業場所は、片付けた印を付けて消す | 提案 |
| [0050](0050-delete-project.md) | プロジェクトは名前を打たせて削除でき、DB・作業場所・データの置き場所を消す(GitHub には触れない) | 提案 |
| [0051](0051-patrol-picks-up-github-issues.md) | 見回りで GitHub の新しい Issue を拾い、リーダーが振り分ける | 提案 |
| [0052](0052-periodic-review.md) | 定期レビューは「観点」を作って、何時間ごとに回し、見つけたものをチケットにする | 提案 |
| [0053](0053-browser-e2e-in-team-ci.md) | 画面のブラウザ E2E をチームの CI で回す形 — 閉じ込めは広げず、外のブラウザに connect し、確かめるまでは既定で動かさない | 提案 |
| [0054](0054-dev-rule-versions-and-drafts.md) | 開発ルールは版を持ち、編集中の下書きは「別のルールを選ぶ・閉じる」では確かめ、別の画面へ移っても残す | 提案 |
| [0055](0055-office-as-route-map.md) | オフィスは「駅」と「路線」の路線図にして、種類ごとの流れ・連絡経路・答え待ちの質問を 1 枚に見せる | 提案 |
| [0056](0056-phone-layout.md) | スマホ(390px)は CSS のメディアクエリで組み替え、下のタブ・全画面の引き出し・1 列の画面にする | 提案 |
| [0057](0057-screens-follow-mockups.md) | 画面は試作と描画で見比べて合わせ、試作が見本用・実装と食い違うところは理由を書いて変える | 提案 |
| [0058](0058-wording-free-and-skip.md) | 言葉の決め — 「手すき」は「free」、「通過」は「省略」にそろえる | 提案 |
| [0059](0059-confine-local-ports.md) | チームの CI の閉じ込めから、Kuramoto 本体のポート(と設定で足したポート)にだけは届かせない。担当のシェルからは、本体の API に合言葉を掛けて守る | 提案 |
