# ADR-0037: ワークスペースと project_id のスコープを足す

- 状態: 提案
- 日付: 2026-11-13

## 背景

複数のプロジェクトを 1 つの DB に入れられる形(未決 #22)に向けた、データだけの下ごしらえ。コードの書き換えは別のチケットで行う。

## 決定

- 本部 DB の版 2: `workspaces`(id, name)を作り、id=1「既定」を入れる。`projects`・`limits`・`policy_templates` に `workspace_id INTEGER NOT NULL DEFAULT 1` を足し、`projects(workspace_id)` の索引と `limits(workspace_id, key)` の UNIQUE を足す。
- プロジェクト DB の版 21: 全部の表(R15〜R17 の表も)に `project_id INTEGER NOT NULL DEFAULT 0` を足す。今ある行は、実行器がマイグレーションに渡すプロジェクトの id(`openDb(path, migrations, { projectId })`。`Hq.openProject` が渡す)で埋める。渡されなければ 0 のまま。
- 索引は project_id を先頭にする。前の版の索引にはそれぞれ project_id 先頭のものを足し、無い表には `(project_id)` を足す。`tickets(number)`・`formations(version)`・`policies(role, version)`・`settings(key)`・`plan_stages(stage)`・`requirements(version)`・`repos(full_name)` には project_id 込みの UNIQUE を足す。
- 足すだけにする(RENAME・削除・表の作り直しはしない)。前の版のコードで新しい DB を開けるようにするため。前の UNIQUE・主キー(`settings.key` など)は残るので、project_id 込みの UNIQUE が効くのは、それらを作り直す後の版からになる。
- 版は Kysely のスキーマビルダの関数で書く(ADR-0036)。

## 結果

- 新しい DB でも、今のコードは project_id を書かないので、入る行の project_id は 0 になる。書き込みを project_id 付きにするのは別のチケット。
- 表を足す版は、その版で project_id も足す(`schema.test.ts` の `PROJECT_ID_TABLES` の一致の確認が落ちる)。
