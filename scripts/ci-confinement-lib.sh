# 閉じ込めの確かめの CI(.github/workflows/confinement-check.yml)が、各手順のログを読むときの道具。
# source して使う。期待どおりでなければ fail=1 にして、理由を GitHub Actions のエラー注釈に出す(最後に `exit $fail` で落とす)。
# 期待の文言は docs/e2e-logs/README.md の「照合の手順」と同じ(scripts/check-*.ts と e2e/auth.spec.ts が出す文字列)。

fail=0
reasons=""

# 失敗の理由を貯める(注釈は 1 ステップに 10 件までなので、finish で 1 件にまとめて出す)
add_reason() {
  reasons="${reasons}${1}"$'\n'
  echo "FAIL: $1"
  fail=1
}

# annotate <タイトル> [最大の文字数] : 標準入力を、複数行の 1 件のエラー注釈として出す(色の制御文字を除く)。
# ci_status / ci_run は注釈を 1 件 700 文字ほどで切る。読みたいものは、短い注釈に分けて出す(1 ステップ 10 件まで)
annotate() {
  local body
  body="$(perl -pe 's/\e\[[0-9;]*[A-Za-z]//g' | head -c "${2:-30000}")"
  [ -n "$body" ] || return 0
  printf '::error title=%s::' "$1"
  printf '%s\n' "$body" | perl -pe 's/%/%25/g; s/\r/%0D/g; s/\n/%0A/g'
  echo
}

# sandbox_denies: 閉じ込め(seatbelt)が断った操作のログ(macOS の統一ログ)から、ブラウザ・Chrome に関わる行を出す。直近 30 分。
sandbox_denies() {
  [ -z "${SKIP_DENY_LOG:-}" ] || return 0
  { log show --last 30m --style compact --predicate 'eventMessage CONTAINS "deny"' 2>&1 || sudo log show --last 30m --style compact --predicate 'eventMessage CONTAINS "deny"' 2>&1; } \
    | grep -E 'Sandbox: ' | grep -v 'GamePolicyAgent' | sed -E 's/^.*Sandbox: //; s/\([0-9]+\)//' | grep -iE 'chrom|headless|node|playwright' | cut -c1-200 | sort | uniq -c | sort -rn
}

# need <ログ> <拡張正規表現>: その行が 1 つはあること
need() {
  if ! grep -Eq -- "$2" "$1"; then
    add_reason "$(basename "$1") に期待の行が無い: $2"
  fi
}

# forbid <ログ> <拡張正規表現>: その行が 1 つも無いこと
forbid() {
  if grep -Eq -- "$2" "$1"; then
    add_reason "$(basename "$1") に出てはいけない行がある: $2 → $(grep -En -- "$2" "$1" | head -5 | cut -c1-300 | tr '\n' '|')"
  fi
}

# need_code <手順の名前> <終了コード> [期待の終了コード(既定 0)]
need_code() {
  if [ "$2" != "${3:-0}" ]; then
    add_reason "$1 の終了コードが ${3:-0} ではない: $2"
  fi
}

# show_reasons <ログ>: 失敗の理由を、ジョブのログに出す(artifact を開かなくても、注釈とログだけで読めるように)。
# 「---」で始まる行(理由の行)とその前後、末尾の 100 行を、::group:: で囲んで出す。落ちたときだけ呼ぶ。
show_reasons() {
  echo "::group::$(basename "$1"): '---' で始まる行と、その前後"
  grep -n -B5 -A20 -- '^---' "$1" || echo "(「---」で始まる行は無い)"
  echo "::endgroup::"
  # ci_status の注釈は 1 ステップ 10 件まで、1 件 700 文字ほどで切れる。読みたいものを、短い注釈に分けて出す
  local n; n="$(basename "$1")"
  grep -E -- '^(✗|△|\?|---)' "$1" | cut -c1-200 | annotate "1 ✗△?---($n)" 700
  grep -E -- 'FATAL|Check failed|SIGTRAP|Permission denied|crash|did exit|Operation not permitted' "$1" | cut -c1-220 | head -6 | annotate "2 Chrome の落ちた理由($n)" 700
  grep -F -- '[browser-server]' "$1" | cut -c1-200 | head -6 | annotate "3 ブラウザサーバーの先頭($n)" 700
  grep -F -- '[browser-server]' "$1" | cut -c1-200 | tail -6 | annotate "4 ブラウザサーバーの末尾($n)" 700
  grep -E -- '^ +[0-9]+\) |Error:|[0-9]+ (failed|did not run)' "$1" | grep -v 'Test Files' | cut -c1-200 | head -8 | annotate "5 落ちた E2E($n)" 700
  tail -n 10 "$1" | cut -c1-200 | annotate "6 末尾($n)" 700
  # 閉じ込めが断った操作(sandbox の deny)。Chrome のログと突き合わせる。全文はログの末尾に足して artifact に残す
  sandbox_denies > "${RUNNER_TEMP:-/tmp}/deny.out" 2>&1 || true
  { echo; echo "--- sandbox の deny(log show。chrome・node・playwright に関わる行。$(wc -l < "${RUNNER_TEMP:-/tmp}/deny.out" | tr -d ' ') 行)"; head -n 150 "${RUNNER_TEMP:-/tmp}/deny.out"; } >> "$1"
  head -n 12 "${RUNNER_TEMP:-/tmp}/deny.out" | sed -E 's/^ +//' | cut -c1-110 | annotate "7 sandbox の deny($n)" 700
  echo "::group::$(basename "$1"): 末尾の 100 行"
  tail -n 100 "$1"
  echo "::endgroup::"
}

# finish: 貯めた理由を 1 件の注釈として出し、落ちていれば 1 で終わる(各ステップの最後に呼ぶ)
finish() {
  if [ "$fail" != 0 ]; then
    printf '%s' "$reasons" | annotate "期待どおりではない" 3000
    exit 1
  fi
  exit 0
}
