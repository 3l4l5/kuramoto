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
