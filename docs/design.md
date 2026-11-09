# Kuramoto 設計書

- 状態: 実装中(DB・受信箱・ディスパッチャ・工程・merge、画面は本部・企画スタジオ・プロジェクト(ボード)。オフィスの俯瞰の絵は未着手)
- 最終更新: 2026-11-07
- mock: [`mock/index.html`](../mock/index.html)(動かし方と仮の値は [`docs/mock.md`](mock.md))
- 個々の判断の理由: [`docs/adr/`](adr/)

## 1. Kuramoto は何か

Kuramoto は AI のエージェントたちを開発チームとして動かし、その働きぶりをオフィスの様子として見せるツールです。

- 責任者(人間)が GitHub のリポジトリを登録すると、AI のチームが要件定義から実装・レビュー・merge 待ちまでを進めます。
- 責任者が対応するのは、チームの中で片付かない判断と merge だけです。
- チームの編成やモデル、方針を「つまみ」として調整し、完成 1 件あたりのトークン・責任者の判断回数・フロー効率を上げていきます。Factorio のように、パラメータを調整して生産効率を最適化する遊び方を想定しています。

名前は「蔵元」(職人が分業して酒を仕込む作業場)と「蔵本モデル」(ばらばらに動く振動子が結合で同期していく理論)に由来します。

### 1.1 しないこと

- エージェントの実行環境(ハーネス)は作りません。 1 体のエージェントが考えてツールを使うループは、Claude Agent SDK などの既存のハーネスに任せます。Kuramoto は「いつ・誰を・何の情報を持たせて起こすか」を決める層です([ADR-0001](adr/0001-orchestrator-not-harness.md))。
- 常駐するエージェントを置きません。 メッセージが届いたときだけ起こし、待っている間はトークンを使いません([ADR-0002](adr/0002-message-driven.md))。
- merge を AI に押させません。 押すのは責任者です([ADR-0013](adr/0013-owner-presses-merge.md))。

## 2. 用語

| 用語 | 意味 |
|---|---|
| 責任者 | Kuramoto を使う人間。判断カードに答え、merge を押す。画面上には人物として登場しない |
| 本部 | プロジェクトを作り、リポジトリを登録し、全プロジェクトを見渡す層 |
| プロジェクト | 1 つのプロダクト。1 つのチームが面倒を見る。リポジトリを複数持てる |
| 企画スタジオ | 要件 → ユーザーフロー → 画面デザイン → インフラ → アーキテクチャとデータ を決める場 |
| オフィス | チームが実装・レビュー・merge 待ちまでを進める様子を見せる場 |
| 役割 | 開発・レビュー・セキュリティ・QA(実装側)、企画・デザイナー・アーキテクト・リーダー(固定) |
| 島 | オフィスの机のまとまり。どの役割を持つか・最大何人かを編成で決める |
| 編成 | 島ごとの役割と人数、仕事の取り方の組み合わせ。版で管理する |
| 応援 | 待ちが溜まったときに呼ばれ、手が空くと帰るメンバー |
| 持ち主 | PR を実装したメンバー。レビューで差し戻されたら自分で直す |
| 判断カード | 責任者に上げる判断。決めるのに要る情報を 1 枚に載せる |
| 方針 | 役割ごとの「重視すること」とモデル・考える深さ。版で管理する |
| 開発ルール | プロジェクトごとの小さな決まりごと(Jira 番号をそろえる など) |
| 完成 | レビュー(とセキュリティ・QA)を通って merge 待ちに着いたもの |
| フロー効率 | 作業された時間 ÷ 着手から完成までの時間 |

## 3. 全体の構成

```
本部(1 つ)
 ├ プロジェクトの一覧・作成・リポジトリ登録
 ├ 全プロジェクトの「あなたの対応」
 └ プロジェクトを開く
      ├ 企画スタジオ … 企画 咲季・デザイナー 清夏・アーキテクト 広
      │    要件 → ユーザーフロー → 画面デザイン → インフラ → アーキテクチャとデータ → チームに渡す
      └ オフィス … リーダー 星南・アーキテクト 広・編成で決まる島(開発・レビュー・…)
           チケット → 実装 → レビュー → (セキュリティ) → (QA) → merge 待ち → 責任者が merge
```

- 2 層に分けるのは、プロジェクトごとにチームと文脈を閉じ、別のプロダクトの話が混ざらないようにするためです([ADR-0004](adr/0004-hq-and-per-project-db.md))。
- プロジェクトとリポジトリは 1 対多です。API とフロントが別リポジトリのプロダクトを、1 つのチームが一緒に扱えます。

### 3.1 実行時の部品

```
ブラウザ(localhost)
   │
ローカルサーバー(Kuramoto)
 ├ 本部 DB(SQLite 1 つ)
 ├ プロジェクト DB(SQLite、プロジェクトごとに 1 つ)
 ├ ウォッチャー(コード): GitHub の外部イベント(人のコメント・CI・merge)をメッセージに変える。トークン 0
 ├ ディスパッチャ(コード): 受信箱からメッセージを 1 通取り出し、宛先のエージェントを 1 回起動する
 └ ハーネスの差し替え口: 最初は Claude Agent SDK だけ
```

データの置き場所は作業場のリポジトリの外です(`~/.kuramoto/<owner>/<repo>/` に DB・worktree・セッションを置く)。エージェントには責任者個人の Claude の設定やメモリを読ませません。

## 4. 役割

| 役割 | 名前 | 仕事 | 既定のモデル / 考える深さ |
|---|---|---|---|
| 責任者 | — | 判断カードに答える、merge を押す、つまみを回す | — |
| 企画 | 咲季 | 責任者と対話して要件(受け入れ条件付き)をまとめる | — |
| デザイナー | 清夏 | ユーザーフローの図と画面の試作(触れる HTML)を作り、コメントで直す | — |
| アーキテクト | 広 | インフラ(動かす場所・環境とデプロイ・運用・費用)。アーキテクチャスタイル → ドメインモデル → 作る/既存を使う/作らない → データ設計。着手前の設計確認 | Opus 5.5 / xhigh |
| リーダー | 星南 | 要件をチケットに分ける。軽い判断は推奨で決めて報告、重い判断だけ責任者に上げる。merge の順番を案内 | Opus 5.5 / medium |
| 開発 | 手毬・ことね・… | 実装して PR を出す。差し戻されたら持ち主として自分で直す。衝突も持ち主が解く | Opus 5.5 / high |
| レビュー | ケイ・ユウ・… | 差分とチケットだけを見てレビューする(実装者の言い分は見ない) | Opus 5.5 / high |
| セキュリティ | (編成で追加) | 認証・認可・入力・秘密情報を見る | Opus 5.5 / high |
| QA | (編成で追加) | 受け入れ条件どおりに動くかを確かめる | Sonnet 5.5 / medium |

- 名前は学園アイドルマスターの登場人物から取り、足りないときはアイドルマスターシリーズ全体から取ります(`src/domain/cast.ts`。mock は前の名前のまま)。
- メンバーの実体は、チケットごとのエージェントのセッションです。応援が画面から帰ってもセッションは残るので、持ち主を呼び戻して続きから直せます([ADR-0005](adr/0005-owner-fixes-own-pr.md))。
- 兼任していても、自分が実装した PR は自分でレビュー・QA しません。

## 5. 仕事の流れ

### 5.1 企画(企画スタジオ)

段階は 5 つで、前の段階を終えてから次へ進みます([ADR-0008](adr/0008-planning-studio-gates.md))。一度合意した段階が後から直されて下書きに戻っても、次の段階は止めません(チームに渡す前には合意し直しが要る)。後の段階で責任者が未決に答え、その答えを要件の受け入れ条件に書き足すときは、責任者が決めたことなので要件は合意済みのまま版を上げます。

1. **要件**: 項目ごとに「受け入れ条件」を書く。QA がそのまま確認に使える書き方にする。省けない。
2. **ユーザーフロー**: 画面と遷移の図。通常の流れ(実線)と分岐・例外(点線)。決まっていない分岐は「?」で示す。
3. **画面デザイン**: 画面ごとに触れる試作を 1〜複数案。案を選び、画面上を指してコメントする。
4. **インフラ**: アーキテクトが、要件・フロー・画面が求めるもの(画像のアップロード、オフラインでの保存など)をもとに、動かす場所と構成(既にある環境を使うか・使うサービス・構成図)→ 環境とデプロイ(環境・CI/CD・マイグレーションの流し方・秘密情報の置き場所)→ 運用(監視・ログ・バックアップ・障害時の戻し方)→ 費用と規模(前提と月額の見積もり)の順に書く。戻せない選択と大きな費用がかかる選択は責任者の未決に入れる([ADR-0015](adr/0015-infra-stage.md))。
5. **アーキテクチャとデータ**: インフラで決めたこと(DB の種類など)を前提に、アーキテクトがアーキテクチャスタイル(スタイルと選ばなかった案・モジュールと責務・守る原則・API とフロントの作り・使う技術)→ 必要なら技術選定(新しく技術を選ぶ領域だけ。候補を評価軸で比べ、選んだものと理由を書く。戻しにくい選択は責任者の未決)→ ドメインモデル(用語・集約・ルール・状態・境界)→ 作る/既存を使う/作らない → データ設計(表・列・マイグレーションが戻せるか)の順に書く([ADR-0009](adr/0009-architect-and-domain-first.md))。

各段階の進め方は 3 つから選べます。

| 進め方 | 動き |
|---|---|
| 合意する(既定) | 責任者が版を見て合意するまで渡さない |
| お任せ | 担当の AI が決めて版を作り、報告だけする。**戻せない変更だけはお任せでも責任者に聞く**。後から合意する進め方に戻せる |
| 省く | その段階を作らず、実装中に決める(要件は省けない) |

すべての段階が「合意済み / お任せ / 省略」になると「チームに渡す」が押せます。リーダーがチケットを作り、各チケットに要件の項目・画面(選んだ案)・設計の節をひも付けます。チケットにはどの進め方で決まったか(「お任せ」「省略」)も残します。

途中で機能を足すときは、要件の版を上げて差分を作ります。今の要件の範囲に収まる修正(バグ修正・文言の調整)はチケットだけで足ります。

### 5.2 実装(オフィス)

```
チケット → 開発 → レビュー → セキュリティ → QA → merge 待ち → 責任者が merge → 完了
             ↑      │           │           │       │
             └──────┴── 差し戻し(持ち主へ) ─┴───────┘
                     └─ 往復が上限に達したら → リーダー → 責任者の判断
```

- 工程は編成にある役割から順に組み立てます。誰も持っていない役割の工程は飛ばします。
- メンバーは、自分の島が持つ役割の工程から仕事を取ります。取る順番は「下流優先(仕掛かりを先に片付ける)」か「着手優先」([ADR-0007](adr/0007-formation-and-flow-efficiency.md))。
- 開発は「自分の PR の直し → 新しいチケット → 持ち主がいない・手が回らないものの引き継ぎ」の順に取ります。
- 開発が PR を出す前に、開発ルールを確かめます([ADR-0011](adr/0011-dev-rules-pattern-first.md))。
- データや約束に触れるチケットは、着手前にアーキテクトが設計を確かめます(範囲はつまみで決める)。

- 並列: 島のメンバーは 1 人 1 件ずつ同時に動く。着手できるチケットが溜まると、島の最大人数まで応援(サブエージェント)を呼んで並列に実装する。同時に動かせる数は「島の最大人数の合計 + 島に属さない 4 人」。設定 concurrency があれば、それを上限にする。
- リーダーの交通整理: 新しいチケットが入ると(始業中)、リーダーが誰がどの順でやるかを決める(plan_work)。
  - 先に終わらせるチケット(after): 土台・共通の設定・同じファイルや表を触るもの。after のチケットが merge されるまで着手しない。
  - 担当(assignee): メンバーの名前か島の名前。島を書くと、その島の手すきの人に、いなければ席が空いていれば応援を呼んで割り当てる。メンバーを名指しすると、その人が手すきになるまで待つ。
  - リーダーは島ごとのメンバー・作業中のチケット・空き席・待ちの件数を見られ(team_status。交通整理とチャットの指示にも入る)、call_helper で島に応援を呼べる(最大人数まで。最大人数を変えるのは責任者)。
  - 申し送り(note): チケットのメモになる。
  - 交通整理が済むまで、そのチケットの実装は始めない。結果はリーダーとのチャットに報告する。再試行が尽きたら止めずに流す(手すきの人が番号順に取る)。順番と担当は、リーダーとのチャットで頼めば決め直す。

- レビューの往復(実際の PR レビューに寄せる):
  - 指摘は必須(blocking)と提案(nit)に分ける。必須が残っていれば差し戻し、提案だけなら承認。
  - 開発は必須の指摘 1 件ずつに「直した(どう直したか)」か「直さない(理由)」で返事をする。返事が漏れていると PR の報告を受け付けない。提案への返事は任意。
  - 再レビューは同じレビュアーが行い、前回の指摘に「解決」「直さないのを了承」「まだ(再オープン)」で答える。前回からの変更を中心に見て、新しい指摘は直しで入った問題か重大な見落としだけにする。
  - 「直さない」をレビュアーが再オープンしたら意見が割れたものとして、リーダーが裁定する(指摘どおり直させる / 開発の言い分を通す)。
  - 後の工程(セキュリティ・QA)で差し戻されたら、直したあとはその工程に戻る(前の工程の承認は生きる)。
  - 指摘ごとのやりとり(スレッド)はチケットの「やりとり」に残る。

### 5.3 判断

- レビューの往復が上限(つまみ。既定 2)に達すると、リーダーに上がります。
- リーダーは、影響が小さい判断は推奨で決めて「推奨で決めた点」として報告します。仕様・契約・セキュリティ・取り消せない操作は責任者に上げます(聞く範囲はつまみ)([ADR-0006](adr/0006-escalate-only-heavy-decisions.md))。
- 責任者への判断カードには必ず次を載せます: 全体のどこの話か / 何を決めるか / 選択肢と推奨・理由 / 間違えると何が起きるか(戻せるか)/ 返事が無いとどうなるか(期限で推奨に進む)/ 証拠(GitHub の PR)へのリンク。
- 画面で答えた内容は、リーダーがその PR にコメントとして書き残します。

### 5.4 merge と衝突

- merge を押すのは責任者です。押した瞬間に「merge できるか・CI が緑か・レビュー済みか」を確かめ直します。
- merge が終わると、それをきっかけに残りの merge 待ちの衝突を確かめ直します。衝突したら merge 待ちから外し、原因になった merge を添えて持ち主に戻します。
- merge 待ちが複数あるとき、リーダーが衝突しにくい順番を案内し、「この順で merge する」で続けて押せます。

### 5.5 止まる条件

外側のループ(ディスパッチャ)は次のどれかで止まり、理由を責任者に出します。

- 人の判断が要る
- レビューの往復が上限に達した
- チケットの予算を使い切った
- 同じエラーで再試行が尽きた

チケットの予算は、プロジェクトの設定で既定の額(最初は $5)を決め、チケットの詳細でチケットごとに変えられます。予算切れで止まると「予算を足して続ける(既定の額を足す)/やめる」を聞きます。チケットの詳細で使った額より多い予算にすると、その判断は「続ける」で閉じ、そのまま続きから動きます。1 回の起動に使える額は、起動 1 回の上限(既定 $2)とチケットの残りの小さいほうです。

## 6. 画面

画面の細かな見た目は mock が基準でしたが、今はデジタル庁デザインシステムに合わせています([ADR-0018](adr/0018-digital-agency-design-system.md))。配置と振る舞いは mock のままです。ここでは、再現に要る要素と振る舞いを書きます。

### 6.1 本部

- あなたの対応(全プロジェクト): 全プロジェクトの判断・merge・企画の確認待ちを 1 つの一覧に。「開く」で該当する画面へ。
- プロジェクトのカード: 状態(稼働中・要件定義中・企画中)、リポジトリと役割、対応件数、1 件あたりのトークン、要件の版、ボトルネック。「オフィスを開く」「企画スタジオを開く」。
- プロジェクトを作る: 名前、リポジトリを複数(`owner/repo` + 役割: フロント・API・インフラ・その他)。書式をその場で確かめる。
- 設計書から復元: 企画スタジオで書き出した設計書(Markdown)を読み込むと、新しいプロジェクトとして企画の中身を戻す([ADR-0017](adr/0017-restore-from-exported-design-doc.md))。

### 6.2 企画スタジオ

- 上部に段階の帯(段階ごとの状態: 合意済み vN / お任せ vN / 省略 / 未決 N / N 画面が合意待ち)と「チームに渡す」。
- 左: 企画・デザイナー・アーキテクトとの会話。段階ごとに話題が変わる。担当が作業している間は、作業中の人・経過時間・最後の動きからの時間・直近の手順(考えたことの要約・読んだファイル・使った道具)を出す。90 秒動きが無ければ知らせる(止まっているのか考えているのかを分かるようにする)。
- 中央: 段階ごとの作業の場(5.1 の 5 つ)。
  - フロー: 箱を押すと選択。未決の分岐は判断カードで選び、選ぶと図に矢印が足され、要件の受け入れ条件にも書き足され、版が上がる。
  - 画面: 画面の一覧(合意済みは緑、待ちは黄)、案を並べて「この案にする」、試作の上を押すとピン付きのコメント。対応済みのピンは緑。対応待ちのコメントがあるうちは合意できない。
  - アーキテクチャとデータ: 中身(アーキテクチャ・技術選定・ドメインモデル・テーブル設計)が 2 つ以上そろったときだけタブに分ける。1 つのうちはタブを出さない。テーブル設計は表ごとに、変更の種類・戻せるか・列を並べる。
  - 各段階の下に「お任せにする」「この段階を省く」。押すと、そうしたときに何が起きるかを見せてから選ばせる。
- 上部の「設計書をエクスポート(Markdown)」で、要件と技術的な設計(フロー・画面・インフラ・アーキテクチャ・ドメイン・データ・決まったこと・未決・チケット)を 1 つの Markdown として書き出せる。図は Mermaid で書くので、作業場のリポジトリの `docs/` に置けばそのまま図として表示される([ADR-0014](adr/0014-design-docs-in-workspace-repo.md))。末尾には、本部で復元するためのデータを HTML コメントで埋め込む。
- 初めてのプロジェクトでは、企画とアーキテクトとの対話で要件の下書きを作る簡易版もある(目的・使う人・必須の機能・ドメインモデル・作る/作らない・データ設計・やらないこと・決まったこと・未決)。未決が残るうちは確定できない。

- 企画スタジオでは、あなたに答えてほしい未決を段階の中身より上に出す(決めたものは下)。

### 6.3 オフィス

登場人物はそれぞれの話し方(一人称・語尾・口調。src/domain/cast.ts の SPEECH)で、返事・作業のまとめ・指摘を書く。コード・コミット・PR の本文・チケットの中身・設計の成果物はふつうの書き方にする。


- 上部: 「あなたの対応」(判断カードと merge カード。期限の近い判断 → merge の推奨順。4 件以上は上位 3 件 + 「すべて表示」。何も無ければ「今あなたが対応することはありません」)。
- 中央: 俯瞰したオフィスの床。
  - 島(1〜2 つ。編成から組み立てる)、リーダーの机、アーキテクトの机、merge 待ちの棚(merge ボタン付き)、merge 済みの置き場、出来事のログ(直近 4 件)。
  - 島の机: 名前、役割の札、`人数/最大`、待ちの件数、書類の山(待ちの件数だけ積まれる)、溜まり具合(3 件で「溜まり気味」、5 件で「溜まっています」、いちばん溜まった島に「ボトルネック」)。
  - メンバー: 作業中は名札にチケット番号・今している役割(兼任時)・直しの回数・進み具合。常駐の 1 人目は手が空くと居眠り。応援は現れるときに輪が広がり、帰るときに消える。
  - 仕事を終えると、書類(#番号)が次の工程の島へ飛び、吹き出しで一言しゃべる。
- 床から編成を変えられる: 島の「設定」で名前・役割・リポジトリ・モデル・重視すること・人数を変えたり島を外したりでき、空いた場所の「島を足す」で島を足せる(6 つまで)。保存すると編成の版が上がる。決まりに反するときは理由を出して保存させない。
- 見た目: 木の床と窓のある明るい部屋。登場人物はちびキャラで、髪の色と髪型は人ごと、服の色は今している役割の色。手すきのときは目を閉じてうとうとする。
- 切り替え: オフィス / ボード(ボードは工程ごとの列。カードに Jira 番号・往復回数・作業中の人・持ち主)。
- 引き出し(1 枚ずつ開く): 編成 / チームの方針(開発ルール・役割ごとの方針)/ リーダーと話す。開発ルールはまだ無い。
  - リーダーと話す(非同期のチャット): 書いたメッセージは受信箱を通してリーダーに届き、手が空いたときにまとめて読んで返事をする(オフィスが終業中でも返事はする)。返事を書いている間は経過と今していることを出す。頼まれた作業はチケットにし、既にあるチケットへの指示はそのチケットにメモとして書き足す。
- チケットを開く(ボードのカード・オフィスの棚・判断カードの題から): 中身(書き直せる)、ひも付く要件と受け入れ条件・画面・設計・PR・持ち主・使った金額と、「やりとり」(起動ごとのまとめ・PR・レビューの結果と指摘・判断と答え・衝突・merge・メモ)を時刻順に並べる。メモを残すと、次に仕事を始める担当がチケットの中身と一緒に読む。レビューの結果は Kuramoto の記録に残し、GitHub の PR には書かない。
- プロジェクトの画面のタブ: 企画スタジオ / オフィス / 生産性 / 設定。
  - 生産性: 合計(消費トークン・使った金額・PR・完成・手戻り・人間に助けを求めた数)を上に置き、その下をタブ(日ごとの推移 / 金額の内訳 / チケットごと)に分け、それぞれグラフと表を切り替えられる。金額の内訳は「何の仕事に・どのモデルに・誰(役割)に」の 3 つの見方。
  - 設定: 名前とリポジトリ(足す・外す・役割を変える)。PR や作業の記録があるリポジトリと、編成の島が受け持っているリポジトリは外せない。データの置き場所は変わらない。
- オフィスの右上: 始業 / 終業のスイッチ(入れると始業、切ると終業)と、今の状態(稼働中 / 終業中)。
  - 編成: 島ごとの役割・受け持つリポジトリ・モデルと考える深さ・この島で重視すること(役割の方針に足して、島のメンバーが読む)・最大人数・応援を呼ぶ待ち件数・手すきで帰るまで、仕事の取り方。変えた結果の工程をその場で見せ、決まりに反するときは理由を出して適用させない。前の版を下書きに読み込んで、新しい版として適用し直せる。
  - チームの方針: 役割ごと(オフィスの役割と、企画スタジオの担当)に、モデル・考える深さ・重視すること・役割ごとの設定。保存すると版が上がり、次に仕事を始めたメンバーから使う。
  - 出来事のログには、起動に使ったモデルを出す。
- ヘッダー: 今の編成のフロー効率、完成 1 件あたりのトークン、判断の回数。

## 7. つまみ(調整できるパラメータ)

| 場所 | つまみ | 範囲 / 選択肢 | 既定 |
|---|---|---|---|
| 編成 | 島の数 | 1〜6([ADR-0019](adr/0019-more-units-and-split-roles.md)) | 2 |
| 編成 | 島ごとの役割 | 開発・レビュー・セキュリティ・QA の組み合わせ(同じ役割を複数の島に持たせてよい。開発は必須) | 開発 / レビュー |
| 編成 | 島が受け持つリポジトリ | 登録したリポジトリから選ぶ(選ばなければすべて)。どのリポジトリも各工程を受け持つ島が要る | すべて |
| 編成 | 島のモデル・考える深さ | 役割の方針どおり / モデル・深さを選んで上書き | 役割の方針どおり |
| 編成 | 島の最大人数 | 1〜10 | 4 / 3 |
| 編成 | 応援を呼ぶ待ち件数 | 1〜6 | 2 |
| 編成 | 手すきで帰るまで | 2〜30(mock は秒、実物は分の想定) | 5 |
| 編成 | 仕事の取り方 | 下流優先 / 着手優先 | 下流優先 |
| 方針(役割ごと) | モデル | Fable 5.1 / Opus 5.5 / Sonnet 5.5 / Haiku 5.5 | 4 章の表 |
| 方針(役割ごと) | 考える深さ | low / medium / high / xhigh / max | 4 章の表 |
| 方針(役割ごと) | 重視すること | 自由記述(基本指示は固定) | — |
| 方針(開発) | 守らせること | テスト必須 / 小さな PR | 両方 |
| 方針(レビュー) | 指摘の厳しさ | 重要なものだけ / 標準 / 細かく | 標準 |
| 方針(レビュー) | 責任者に上げるまでの往復 | 1〜5 | 2 |
| 方針(アーキテクト) | 設計を必須にする範囲 | すべて / 複数リポジトリ・約束・データに触れる変更 / 任意 | 中 |
| 方針(リーダー) | 責任者に聞く範囲 | 重いものだけ / 中以上 / なんでも聞く | 中以上 |
| 開発ルール | ルールごとの有効・確かめ方・違反時の扱い | 10 章 | — |
| 企画スタジオ | 段階ごとの進め方 | 合意する / お任せ / 省く | 合意する |

方針・編成は保存するたびに版が上がり、変えた時点が効率のグラフに印として入ります。モデルの価格は 100 万トークンあたり入力 / 出力で Fable 5.1 $10 / $50、Opus 5.5 $4 / $20、Sonnet 5.5 $2 / $10、Haiku 5.5 $0.10 / $0.50(2026-10-06 時点)。

## 8. 指標

| 指標 | 定義 | 良い向き |
|---|---|---|
| トークン / 完成 | 使ったトークン ÷ 完成数 | 少ない |
| 判断 / 完成 | 責任者に上がった判断 ÷ 完成数 | 少ない |
| フロー効率 | 完成したチケットの作業時間の合計 ÷ リードタイムの合計 | 高い |
| リードタイム | 着手(チケットができた時点)から完成まで | 短い |
| 手戻り率 | 直し・衝突解消に使った時間 ÷ 作業時間の全体 | 低い |
| 平均レビュー往復 | レビューを通ったチケットの往復回数の平均 | 少ない |
| 再発 | 直した指摘が後の周回でまた出た件数(指摘の指紋で判定) | 少ない |
| 衝突 | merge 待ちから衝突で戻った件数 | 少ない |
| ルール違反 | 開発ルールに反した件数 / うち自動で直した件数 | 少ない |
| ボトルネック | 待ちがいちばん多い工程(3 件以上のとき) | — |

プロジェクトの「生産性」の画面に、これらの記録を出します: 消費トークン(入力・出力・キャッシュ)、使った金額(企画スタジオの分を含む)、PR の数(出した・merge した)、完成数と 1 件あたり、手戻り(差し戻し・衝突・エラーでのやり直し)、人間に助けを求めた数(判断カード・企画の未決)。日ごとの推移、金額の内訳(何の仕事に・どのモデルに・誰に)、チケットごとの数字も見られる。起動ごとに実際に使ったモデル・考える深さを記録する(島で上書きしたときも正しく数えるため)。将来は、同じ要件の版を編成の違う複数のプロジェクトに配り、同じ指標と「受け入れ条件を満たした割合」で比べるベンチマークを想定しています。

## 9. データ設計

DB は本部に 1 つ + プロジェクトごとに 1 つの SQLite です。GitHub が持っているもの(差分・CI の詳細・PR の本文)は Kuramoto の DB に持たず、番号と取得時刻付きの写しだけを置きます([ADR-0003](adr/0003-local-sqlite-source-of-truth.md))。

### 9.1 本部 DB

```sql
CREATE TABLE projects (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL,
  data_dir TEXT NOT NULL UNIQUE,                      -- ~/.kuramoto/<owner>/<repo>/
  status TEXT NOT NULL CHECK (status IN ('planning','defining','starting','running','archived')),
  created_at TEXT NOT NULL
);
CREATE TABLE repos (
  id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id),
  full_name TEXT NOT NULL, role TEXT NOT NULL,         -- フロント / API / インフラ / その他
  UNIQUE (project_id, full_name)
);
CREATE TABLE policy_templates (id INTEGER PRIMARY KEY, role TEXT NOT NULL, body TEXT NOT NULL);  -- 新しいプロジェクトの方針の初期値
CREATE TABLE limits (key TEXT PRIMARY KEY, value TEXT NOT NULL);                               -- 全体の同時起動数など
```

本部の一覧に出す数字は、本部に写さず、各プロジェクトの DB を読みに行って出します。

### 9.2 プロジェクト DB(主な表)

```sql
-- 設定
CREATE TABLE repos (id INTEGER PRIMARY KEY, full_name TEXT NOT NULL UNIQUE, role TEXT NOT NULL);
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);       -- jira_key など
CREATE TABLE formations (id INTEGER PRIMARY KEY, version INTEGER NOT NULL UNIQUE, pull TEXT NOT NULL CHECK (pull IN ('down','start')), created_at TEXT NOT NULL);
CREATE TABLE units (id INTEGER PRIMARY KEY, formation_id INTEGER NOT NULL REFERENCES formations(id), name TEXT NOT NULL,
  roles TEXT NOT NULL,                                                   -- JSON 配列 ["dev","review"]
  max_members INTEGER NOT NULL, summon_at INTEGER NOT NULL, idle_sec INTEGER NOT NULL);
CREATE TABLE policies (id INTEGER PRIMARY KEY, role TEXT NOT NULL, version INTEGER NOT NULL,
  model TEXT NOT NULL, effort TEXT NOT NULL, focus TEXT NOT NULL, options TEXT NOT NULL DEFAULT '{}',
  harness TEXT NOT NULL DEFAULT 'claude-agent-sdk', created_at TEXT NOT NULL, UNIQUE (role, version));
CREATE TABLE dev_rules (id INTEGER PRIMARY KEY, name TEXT NOT NULL, body TEXT NOT NULL, applies_to TEXT NOT NULL,
  check_kind TEXT NOT NULL CHECK (check_kind IN ('pattern','ai')), pattern TEXT,
  on_fail TEXT NOT NULL CHECK (on_fail IN ('autofix','review','block')), enabled INTEGER NOT NULL DEFAULT 1);

-- 企画
CREATE TABLE plan_stages (stage TEXT PRIMARY KEY CHECK (stage IN ('req','infra','flow','screen','model')),
  mode TEXT NOT NULL CHECK (mode IN ('agree','delegate','skip')), version INTEGER NOT NULL, agreed_version INTEGER);
CREATE TABLE requirements (id INTEGER PRIMARY KEY, version INTEGER NOT NULL UNIQUE, created_at TEXT NOT NULL);
CREATE TABLE requirement_items (id INTEGER PRIMARY KEY, code TEXT NOT NULL,            -- R1, R2 …
  name TEXT NOT NULL, acceptance TEXT NOT NULL, added_in INTEGER NOT NULL, removed_in INTEGER);
CREATE TABLE plan_artifacts (id INTEGER PRIMARY KEY, stage TEXT NOT NULL, version INTEGER NOT NULL,
  kind TEXT NOT NULL,                                                   -- flow_graph / screen_html / domain_model / data_design
  key TEXT NOT NULL, body TEXT NOT NULL, chosen INTEGER NOT NULL DEFAULT 0);
CREATE TABLE plan_comments (id INTEGER PRIMARY KEY, artifact_id INTEGER NOT NULL REFERENCES plan_artifacts(id),
  x REAL, y REAL, body TEXT NOT NULL, resolved_in INTEGER);
CREATE TABLE plan_open_items (id INTEGER PRIMARY KEY, stage TEXT NOT NULL, question TEXT NOT NULL,
  options TEXT NOT NULL, recommended INTEGER NOT NULL, answer TEXT, decided_by TEXT);

-- チームとチケット
CREATE TABLE members (id INTEGER PRIMARY KEY, unit_id INTEGER REFERENCES units(id), name TEXT NOT NULL,
  look TEXT NOT NULL, is_base INTEGER NOT NULL DEFAULT 0, joined_at TEXT NOT NULL, left_at TEXT);
CREATE TABLE tickets (id INTEGER PRIMARY KEY, number INTEGER NOT NULL UNIQUE, jira_key TEXT, title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '',
  stage TEXT NOT NULL CHECK (stage IN ('dev','review','sec','qa','decision','merge','done','dropped')),
  owner_member_id INTEGER REFERENCES members(id), requirement_item_id INTEGER REFERENCES requirement_items(id),
  plan_refs TEXT NOT NULL DEFAULT '{}',                                  -- 画面・設計の節・進め方(お任せ/省略)
  rounds INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, done_at TEXT, active_ms INTEGER NOT NULL DEFAULT 0);
CREATE TABLE sessions (id INTEGER PRIMARY KEY, member_id INTEGER NOT NULL REFERENCES members(id), ticket_id INTEGER NOT NULL REFERENCES tickets(id),
  repo_id INTEGER NOT NULL REFERENCES repos(id), harness TEXT NOT NULL, harness_session_id TEXT NOT NULL,
  worktree_path TEXT, branch TEXT, created_at TEXT NOT NULL, last_used_at TEXT NOT NULL, UNIQUE (member_id, ticket_id, repo_id));
CREATE TABLE pull_requests (id INTEGER PRIMARY KEY, ticket_id INTEGER NOT NULL REFERENCES tickets(id), repo_id INTEGER NOT NULL REFERENCES repos(id),
  number INTEGER NOT NULL, head TEXT NOT NULL, gh_state TEXT, mergeable TEXT, ci TEXT, fetched_at TEXT, UNIQUE (ticket_id, repo_id));

-- 受信箱と起動の記録
CREATE TABLE messages (id INTEGER PRIMARY KEY, ticket_id INTEGER REFERENCES tickets(id),
  to_role TEXT NOT NULL, to_member_id INTEGER REFERENCES members(id), kind TEXT NOT NULL, payload TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','claimed','done','failed')),
  available_at TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
CREATE INDEX messages_pending ON messages(status, available_at);
CREATE TABLE runs (id INTEGER PRIMARY KEY, message_id INTEGER NOT NULL REFERENCES messages(id), ticket_id INTEGER REFERENCES tickets(id),
  member_id INTEGER NOT NULL REFERENCES members(id), role TEXT NOT NULL, session_id INTEGER REFERENCES sessions(id),
  policy_id INTEGER NOT NULL REFERENCES policies(id), formation_id INTEGER NOT NULL REFERENCES formations(id),
  started_at TEXT NOT NULL, ended_at TEXT, input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, cost_usd REAL, outcome TEXT);
CREATE UNIQUE INDEX one_run_per_ticket ON runs(ticket_id) WHERE ended_at IS NULL;   -- 1 チケットを同時に触るのは 1 回の起動だけ

-- レビュー・判断・merge
CREATE TABLE reviews (id INTEGER PRIMARY KEY, ticket_id INTEGER NOT NULL REFERENCES tickets(id), role TEXT NOT NULL, round INTEGER NOT NULL,
  run_id INTEGER NOT NULL REFERENCES runs(id), verdict TEXT NOT NULL CHECK (verdict IN ('approve','changes','escalate')), created_at TEXT NOT NULL);
CREATE TABLE findings (id INTEGER PRIMARY KEY, review_id INTEGER NOT NULL REFERENCES reviews(id), category TEXT NOT NULL, severity TEXT NOT NULL,
  path TEXT, line INTEGER, body TEXT NOT NULL, fingerprint TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','fixed','recurred','wontfix')));
CREATE TABLE rule_violations (id INTEGER PRIMARY KEY, rule_id INTEGER NOT NULL REFERENCES dev_rules(id), ticket_id INTEGER NOT NULL REFERENCES tickets(id),
  handled TEXT NOT NULL CHECK (handled IN ('autofixed','review','blocked')), created_at TEXT NOT NULL);
CREATE TABLE decisions (id INTEGER PRIMARY KEY, ticket_id INTEGER NOT NULL REFERENCES tickets(id), question TEXT NOT NULL, options TEXT NOT NULL,
  recommended INTEGER NOT NULL, why TEXT NOT NULL, impact TEXT NOT NULL, reversible INTEGER NOT NULL, escalated INTEGER NOT NULL,
  deadline_at TEXT, decided_by TEXT CHECK (decided_by IN ('owner','lead','timeout')), choice INTEGER, decided_at TEXT, gh_comment_id TEXT);
CREATE TABLE merges (id INTEGER PRIMARY KEY, pr_id INTEGER NOT NULL REFERENCES pull_requests(id),
  result TEXT NOT NULL CHECK (result IN ('merged','conflict','blocked')), checked TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE conflicts (id INTEGER PRIMARY KEY, pr_id INTEGER NOT NULL REFERENCES pull_requests(id), cause_pr_id INTEGER REFERENCES pull_requests(id),
  detected_at TEXT NOT NULL, resolution TEXT CHECK (resolution IN ('mechanical','logic','decision')), resolved_at TEXT);

-- 出来事(追記だけ。ログとアニメーションの元)
CREATE TABLE events (id INTEGER PRIMARY KEY, at TEXT NOT NULL, actor TEXT NOT NULL, type TEXT NOT NULL, ticket_id INTEGER, data TEXT NOT NULL DEFAULT '{}');
```

- ロックのための表は作りません。終わっていない起動はチケットごとに 1 つまで、という決まりを部分ユニークインデックスで DB に守らせます。
- 方針と編成は上書きせず、版ごとに 1 行で残します。起動には `policy_id` と `formation_id` を必ず記録し、版ごとの効き目を計算できるようにします。
- 集計のための表も作りません。8 章の指標は `runs`・`reviews`・`findings`・`tickets` などから計算します。
- 実装で足した列: `messages.claimed_at`・`messages.last_error`(取りこぼしの回収と再試行の理由)、`runs.error`(失敗した起動の理由)。
- 途中経過のために足したもの: `runs.last_activity_at`・`runs.live`(今の様子。生きている合図で上書き)、`run_steps`(手順の記録)。
- 企画スタジオのために足したもの: `plan_messages`(段階ごとの会話)、`plan_open_items` の `why`・`reversible`・`withdrawn` など(お任せでも戻せない未決は責任者に残す)、`plan_comments.variant`(どの案へのコメントか)。企画の担当への依頼もチケットを持たないメッセージとして受信箱を通し、オフィスを止めていても動く。

## 10. 開発ルール

プロジェクトごとの小さな決まりごとです([ADR-0011](adr/0011-dev-rules-pattern-first.md))。

- 中身: 名前 / 何を守るか / どこに効くか(ブランチ名・コミット・PR タイトル・PR 本文・変更したファイル・コード)/ 確かめ方 / 守れていなかったときの扱い。
- 確かめ方: 「形式で確かめる(トークン 0)」を優先し、読まないと分からないものだけ「AI が読んで確かめる」。
- 守れていなかったら: 持ち主が自動で直す / レビューで指摘する / 直すまで先に進めない。
- Jira のプロジェクトキーを設定すると、チケットが `SHOP-121` のような番号を持つ。
- ひな形: Jira の課題番号をそろえる(`[A-Z]+-[0-9]+`)/ PR 本文の先頭に対象を書く / マイグレーションは単独の PR にする / コミットの 1 行目は 50 字以内。

## 11. ハーネスの差し替え口

役割ごとにハーネス(コーディングエージェント)を選べる作りにします。最初に載せるのは Claude Agent SDK だけです([ADR-0012](adr/0012-pluggable-harness.md))。Kuramoto がハーネスに求めるのは次の 5 つです。

1. 作業場所(worktree)を指定して、人が見ていなくても動かせる
2. セッションを再開できる
3. Kuramoto の道具(メッセージを送る・責任者に聞く・PR を開くなど)を MCP で渡せる
4. 使ったトークンやコストを返せる
5. 予算や時間の上限で止められる

## 12. 未決と今後

| 項目 | 状態 |
|---|---|
| 技術スタック | サーバー: TypeScript + Claude Agent SDK + SQLite(Node 24 の `node:sqlite`)。画面: React + TanStack Query + Vite(ルーターは画面が増えたら入れる)、見た目はデジタル庁デザインシステム(Tailwind CSS v3 + 公式プラグイン + 公式コードスニペット、[ADR-0018](adr/0018-digital-agency-design-system.md))。E2E: Playwright |
| 設計書の置き場所(作業場リポジトリ) | 推奨: 作業場リポジトリの `docs/` に PR で置く(未確認)([ADR-0014](adr/0014-design-docs-in-workspace-repo.md)) |
| Jira との連携 | チケットに番号を持たせるところまで。課題を作るか既存にひも付けるかは未決 |
| ユーザーフローの編集 | 「AI が描く → 責任者が言葉で直す → AI が抜けを指摘する」を先に作る。図を直接いじるエディタは後から |
| ロビーと全体の同時起動上限 | 2 つ目のプロジェクトを同時に動かしたくなってから |
| ベンチマーク(同じ要件を別編成で作らせて比べる) | 設計のみ |
| 責任者が複数いる場合 | 未決(今は 1 人の前提) |
