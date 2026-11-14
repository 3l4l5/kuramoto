# 定期レビュー(#89)

デザイナーによる画面レビューなど、「観点」を自分で作って、決まった頻度で回す仕組み。見つけたものはチケットに切る。

## 定義(`periodic_reviews`)

| 項目 | 内容 |
| --- | --- |
| name | 名前 |
| viewpoint | 観点。レビューで見ること(プロンプトの本文) |
| every_hours | 頻度(時間)。毎日 = 24、毎週 = 168、N 時間ごと = N(1 〜 8760) |
| role | 担当の役割: designer / qa / review / sec / lead。その役割の方針(モデル・深さ・重視すること)と、その役割の島(designer・lead は島に属さない固定のメンバー)のメンバーが動く |
| target_kind / target_screens | 対象: all_screens(企画の全画面)/ screens(選んだ画面の key)/ repo(リポジトリ全体) |
| enabled | 有効 / 無効 |
| template | ひな形から作ったときの印(`designer_screens`) |
| last_run_at | 前回の起動。次の起動は `(last_run_at ?? created_at) + every_hours` |

- 頻度を「cron 式」ではなく「何時間ごと」で持つ理由: 始業・休業があるので、決まった時刻に回すより、前回から一定時間たったら回すほうが取りこぼしても溜まらない。毎日・毎週は 24・168 の呼び名。
- 無効 → 有効に戻すと、そこから 1 頻度ぶん待つ(止めていた分を一度に回さない)。
- すべて `project_id` を持つ(SQLite 版 24・MySQL 版 24 の両方で足した。削除・SQLite → MySQL の移行にも入れてある)。

## 初期の観点: デザイナーによる画面レビュー

ひな形 `designer_screens`(毎週・デザイナー・全画面)。企画の試作とお手本の画像・デザインシステムを作業場所に置き、今の描画を 1280px・390px で撮る道具(render_page 系)を渡して、ずれ・デザインシステム外の色や部品を洗い出す。

## 起動(見回りから)

1. 始業中の `housekeep`(見回りと同じところ)が `requestPeriodicReviews` を呼ぶ。頻度が来た有効な定義ごとに `startPeriodicRun`。
2. `startPeriodicRun` は実行の記録(`periodic_review_runs`、status = queued)を作り、`last_run_at` を進め、メッセージ `kind = periodic_review`(担当の役割宛て、チケット無し)を受信箱に入れる。同じ定義の待ち・実行中の回があれば起動しない。
3. 受信箱から担当が取り、`Dispatcher.executePeriodicReview` が動く。受け持つ島が(編成の変更で)無くなっていたら、記録を error で閉じる。
4. 手動の「今すぐ実行」も同じ `startPeriodicRun`(origin = manual)。始業していなければ、始業したときに動く。手動でも `last_run_at` を進めるので、次の定期の起動はそこから 1 頻度ぶん後ろになる(意図した動き。画面のヒントにも書いてある)。
   取り残された回(ひも付くメッセージが再試行を尽くして failed になった・消えた)は、次の起動のときに error で閉じるので、定義が二度と起動しなくなることはない。ハーネス・リポジトリが無くて再試行が尽きたときも、記録を error で閉じる。

## 切る・重複の判定

担当の道具 `create_review_ticket`(題名・本文・種類・画面)でチケットにする。種類は必ず付け、ずれ・不具合は bugfix が既定。
重複: 開いている(done・dropped でない)チケットの題名と、記号・空白を除いた 2 文字ずつの重なり(Dice 係数)が 0.7 以上なら、切らずに `skipped_duplicates` を増やし、担当に「重複」と返す。同じ回の中で切ったものも開いているので、同じ回の重複も防ぐ。

## 実行の記録(`periodic_review_runs`)

origin(schedule / manual)・status(queued / running / done / error)・looked_at(見たもの。例「ホーム・設定(1280px・390px)」)・created_tickets(切ったチケットの番号)・skipped_duplicates・summary(担当の最後の文)・error・時刻。

## 画面・API

設定の「定期レビュー」で、一覧・作成・編集・有効 / 無効・削除・今すぐ実行と、直近の実行の記録を見られる。
`GET|POST /api/projects/:id/periodic-reviews`、`POST .../:rid`(直す)・`.../:rid/enabled`・`.../:rid/delete`・`.../:rid/run`。

## 決めたこと(責任者への確認の候補)

- 頻度の持ち方は「何時間ごと」。
- 担当は「役割」で指定する(特定のメンバーではなく、その役割の手すきの人)。
- 重複は題名の近さで判定する(本文・画面は見ない)。LLM に判定させると費用が増えるため。足りなければ後で強められる。
- 見つけたものを切る前に責任者の確認は挟まない(チケットは交通整理を通って進む)。
