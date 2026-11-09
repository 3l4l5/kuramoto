# ADR-0020: エージェントを作業場所に閉じ込め、push と PR は Kuramoto が外で行う

- 状態: 提案
- 日付: 2026-11-09

## 背景

エージェントに渡す情報は、Kuramoto が役割と仕事の種類ごとに選んでプロンプトに組み立てている([ADR-0002](0002-message-driven.md))。ところが、起動の作業場所(worktree)の外には何の制限も無かった。シェルを持つ役割(開発・レビュー・セキュリティ・QA)は、Kuramoto の DB(`~/.kuramoto/.../project.sqlite`)、ほかのチケットの worktree、責任者の認証情報(`~/.ssh`、`gh` のトークン)を読めた。「選んだ情報だけを渡す」が、指示文のお願いでしか守られていなかった。

## 決定

- **ファイルの道具**(Read・Grep・Glob・Edit・Write): 作業場所の外を読み書きさせない(SDK の `blockReadsOutsideWorkingDirectories` / `blockWritesOutsideWorkingDirectories`)。
- **シェル**: SDK のサンドボックスの中だけで動かす。外で動かす抜け道(`dangerouslyDisableSandbox`)は塞ぎ、サンドボックスを用意できなければ起動しない。
  - 読ませない: Kuramoto のデータの置き場所全体、`~/.ssh`・`~/.config/gh`・`~/.aws`・`~/.claude` などの認証情報。
  - 作業場所(clone と worktree)は、データの置き場所(`~/.kuramoto`)の外の `~/.kuramoto-work/<owner>/<repo>/` に置く(`KURAMOTO_WORK_HOME` で変えられる)。サンドボックスは読ませない場所の中を開け直せないため、同じ場所に置くと作業場所まで読めなくなる。
  - 書けるのは作業場所と、開発のときだけ git の本体(`repos/<repo>/.git`)。
  - 通信: 許可したドメインだけ。既定は GitHub(認証なしで読むだけ)と主なパッケージの取得先(npm・PyPI・Go・crates・RubyGems)。プロジェクトの設定 `sandbox_allowed_domains` で足せる。
  - 環境変数のトークン(`GH_TOKEN` など)と、抜け道になる `SSH_AUTH_SOCK`・`DOCKER_HOST` はシェルに渡さない。`~/.docker`(Docker のソケットを含む)も読ませない。
  - テストを確かめられるように、ホームの下のツールの置き場所(`~/.npm`・`~/.cache`・`~/Library/Caches`・mise の状態と取り込み先など)には書ける。プロジェクトの設定 `sandbox_allow_write` で足せる。
  - テスト用のブラウザと e2e のために、Unix ソケットと localhost での待ち受けを許す(Chrome は起動のたびにプロファイルにソケットを作る)。設定 `sandbox_strict_sockets` を `1` にすると閉じる。
  - mise は知らない場所の設定ファイルを信用しないので、`MISE_TRUSTED_CONFIG_PATHS` で作業場所の設定を信用させる。
- **push と PR**: エージェントはコミットまで。`submit_pr` を受けたら Kuramoto が外で確かめ(コミットし忘れ・コミットが無い)、push(`--force-with-lease`)して、PR が無ければ作る。エージェントは PR のタイトルと本文を渡せる。
- **レビュー**: `gh pr diff` をやめ、Kuramoto が取り出したブランチを `git diff origin/<既定のブランチ>...HEAD` で見る。
- **衝突の直し**: Kuramoto が起動の前に fetch しておき、エージェントは `git merge origin/<既定のブランチ>` で解く。

## 結果

- エージェントが見られるのは、渡したプロンプト・道具の返事・自分の作業場所・同じリポジトリの git の履歴だけになる。
- エージェントに GitHub への書き込みの手段が無くなる。PR を出すのは常に Kuramoto(責任者の `gh` の認証)。
- 許可していないサイトから依存を取るテストは落ちる。そのときは `sandbox_allowed_domains` に足す。
- 最初の版では作業場所をデータの置き場所の中に置き、`allowRead` で開け直していた。実機で試すと、作業場所のファイルも `~/.npm` も mise の node も読めなかった(`allowRead` を渡すと読める場所がそこだけに絞られ、書ける場所の中の値は外される)。置き場所を分けた。さらに、ファイルの道具に効かせた「作業場所の外を読ませない」設定はシェルの読み込みにも効き、ホームの下は作業場所しか読めなかった(`~/.npm` に書けても読めない、mise の node が起動できない)。git の本体・ツールチェーン(mise・nix・PATH のうちホームの下の場所)・git の設定・書ける場所を `allowRead` で名指しして開ける形にした。隠す場所の中は開けない。前の worktree(`~/.kuramoto/.../worktrees`)は使われなくなるので、消してよい。
- 最初の版ではツールの置き場所に書けず、ソケットも閉じていたため、QA が node(mise)もブラウザも動かせなかった(#10 で、確かめられないまま指摘が増えた)。置き場所とソケットを開けて直した。
- ソケットを開けると、ローカルで動いている別のサービスのソケットにつながる余地が残る。SSH エージェントと Docker は環境変数と置き場所を隠して塞いだ。もっと強く閉じたいプロジェクトは `sandbox_strict_sockets` を使う。
- サンドボックスが使えない環境(macOS・Linux 以外、Linux で bubblewrap が無いなど)では、どの起動もエラーで止まる。

## 検討した別案

- **シェルを持つ役割を絞る**: レビューや QA はテストを動かして確かめたい。シェルを取り上げると確かめ方が弱くなる。
- **HTTPS と `GH_TOKEN` で、エージェントに push させる**: 今の流れのまま閉じ込められるが、トークンを持たせるので GitHub への書き込みが残る。Kuramoto が外で push するほうが閉じ込めが強い。
- **ホーム全体を読ませない**: いちばん強いが、`mise` などホームの下に入れたツールチェーンが動かなくなる。読ませない場所を名指しする形にした。
