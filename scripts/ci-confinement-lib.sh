# 閉じ込めの確かめの CI(.github/workflows/confinement-check.yml)が、各手順のログを読むときの道具。
# source して使う。期待どおりでなければ fail=1 にして、理由を GitHub Actions のエラー注釈に出す(最後に `exit $fail` で落とす)。
# 期待の文言は docs/e2e-logs/README.md の「照合の手順」と同じ(scripts/check-*.ts と e2e/auth.spec.ts が出す文字列)。

fail=0

# need <ログ> <拡張正規表現>: その行が 1 つはあること
need() {
  if ! grep -Eq -- "$2" "$1"; then
    echo "::error::$(basename "$1") に期待の行が無い: $2"
    fail=1
  fi
}

# forbid <ログ> <拡張正規表現>: その行が 1 つも無いこと
forbid() {
  if grep -Eq -- "$2" "$1"; then
    echo "::error::$(basename "$1") に出てはいけない行がある: $2"
    grep -En -- "$2" "$1" | head -5
    fail=1
  fi
}

# need_code <手順の名前> <終了コード> [期待の終了コード(既定 0)]
need_code() {
  if [ "$2" != "${3:-0}" ]; then
    echo "::error::$1 の終了コードが ${3:-0} ではない: $2"
    fail=1
  fi
}

# show_reasons <ログ>: 失敗の理由を、ジョブのログに出す(artifact を開かなくても、注釈とログだけで読めるように)。
# 「---」で始まる行(理由の行)とその前後、末尾の 100 行を、::group:: で囲んで出す。落ちたときだけ呼ぶ。
show_reasons() {
  echo "::group::$(basename "$1"): '---' で始まる行と、その前後"
  grep -n -B5 -A20 -- '^---' "$1" || echo "(「---」で始まる行は無い)"
  echo "::endgroup::"
  # ci_status の注釈には、::group:: の中のログは出ない。理由の行は、エラー注釈としても出す(1 行 400 文字まで、12 行まで)
  grep -E -- '^---|ブラウザサーバー|理由:|Error|ProcessSingleton|sandbox|Operation not permitted|Executable' "$1" | cut -c1-400 | head -12 | while IFS= read -r l; do echo "::error title=理由($(basename "$1"))::$l"; done
  # E2E の落ちた試験の名前・件数・ブラウザの落ちた理由(Chrome の FATAL など)も、注釈に出す(30 行まで)
  grep -E -- '^ +[0-9]+\) |[0-9]+ (failed|passed|flaky|did not run)|FATAL|Check failed|crash|\[browser-server\]|Timeout|closed' "$1" | cut -c1-300 | head -30 | while IFS= read -r l; do echo "::error title=E2E($(basename "$1"))::$l"; done
  echo "::group::$(basename "$1"): 末尾の 100 行"
  tail -n 100 "$1"
  echo "::endgroup::"
}
