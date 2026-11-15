#!/usr/bin/env bash
# confinement-check の logs ジョブの最後の手順(#126)。artifact e2e-logs のログを、中身を変えずに docs/e2e-logs/run-<run_id>/ に置き、
# ブランチ e2e-logs/run-<run_id> に commit して push し、main への PR を開く。#115 は、この PR が main に入ったあと main から読む。
#
# 使い方: publish-e2e-logs.sh <ログのディレクトリ(*.log が入っている)>
# 環境変数:
#   RUN_ID        (必須)実行の ID(github.run_id)
#   RUN_URL       (必須)実行の URL(PR の本文に書く)
#   BASE_BRANCH   PR の宛先(既定 main)
#   REMOTE        push 先の remote(既定 origin)
#   DRY_RUN=1     PR を開かず、commit までで止める(試験用。push もしない)
# push 先は e2e-logs/run-<数字> のブランチだけ(それ以外の名前になる入力は、push の前に断る)。
set -euo pipefail

src="${1:?使い方: publish-e2e-logs.sh <ログのディレクトリ>}"
: "${RUN_ID:?RUN_ID が要る}"
: "${RUN_URL:?RUN_URL が要る}"
base="${BASE_BRANCH:-main}"
remote="${REMOTE:-origin}"

[[ "$RUN_ID" =~ ^[0-9]+$ ]] || { echo "::error::RUN_ID は数字だけ: $RUN_ID"; exit 1; }
branch="e2e-logs/run-${RUN_ID}"
dest="docs/e2e-logs/run-${RUN_ID}"

shopt -s nullglob
logs=("$src"/*.log)
[ "${#logs[@]}" -gt 0 ] || { echo "::error::$src に .log が無い。出すものが無い"; exit 1; }

# main(宛先)の最新から切る。PR の差分はログだけになる
git fetch --no-tags --depth=1 "$remote" "$base"
git checkout -q -B "$branch" FETCH_HEAD

mkdir -p "$dest"
# 中身は加工しない(cp のまま)。ファイル名も artifact のとおり
cp -p "${logs[@]}" "$dest"/
git add -- "$dest"
if git diff --cached --quiet; then
  echo "変更が無い(同じログがすでに main にある)。PR は開かない"
  exit 0
fi

# 一覧(ファイル名と行数)。PR の本文に使う
list=""
for f in "$dest"/*.log; do
  list+="| \`$(basename "$f")\` | $(wc -l < "$f" | tr -d ' ') |"$'\n'
done

git -c user.name="github-actions[bot]" -c user.email="41898282+github-actions[bot]@users.noreply.github.com" \
  commit -q -m "[docs] e2e-logs: confinement-check の実行 ${RUN_ID} のログ" -m "実行: ${RUN_URL}"

body="$(cat <<EOF
confinement-check の実行 ${RUN_ID} のログ(artifact \`e2e-logs\`)を、中身を変えずに \`${dest}/\` に置く PR です(#126。ワークフローが自動で開いた)。

- 実行: ${RUN_URL}
- ログは artifact と同じ(加工していない)。読み方・照合の手順は docs/e2e-logs/README.md
- merge すると、#115 が main からこのログを読んで docs/e2e.md の「確かめの記録」を埋める

| ログ | 行数 |
|---|---|
${list}
EOF
)"

if [ -n "${DRY_RUN:-}" ]; then
  echo "DRY_RUN: push も PR もしない(ブランチ $branch に commit した)"
  printf '%s\n' "$body"
  exit 0
fi

# 同じ run の再実行ではブランチがすでにある。このブランチは自動で作ったものだけなので、上書きしてよい
git push --force "$remote" "HEAD:refs/heads/${branch}"

if [ -n "$(gh pr list --head "$branch" --base "$base" --state open --json number --jq '.[].number')" ]; then
  echo "この実行の PR はすでに開いている(ブランチを更新した)"
  exit 0
fi
gh pr create --base "$base" --head "$branch" --title "[docs] e2e-logs: confinement-check の実行 ${RUN_ID} のログ" --body "$body"
