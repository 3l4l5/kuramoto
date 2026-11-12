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
