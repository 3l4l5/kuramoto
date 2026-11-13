#!/bin/sh
# 手元の MySQL(コンテナ kuramoto-mysql)の Kuramoto の database を、1 つの gz に書き出す。
# launchd から 1 日 1 回呼ぶ(docs/mysql.md)。パスワードはコンテナの環境変数から読み、コマンドラインに出さない。
#
# 環境変数: KURAMOTO_BACKUP_DIR(既定 ~/.kuramoto/backups/mysql)/ KURAMOTO_BACKUP_KEEP_DAYS(既定 14)
#          KURAMOTO_MYSQL_CONTAINER(既定 kuramoto-mysql)
set -eu
umask 077

# launchd の PATH は短いので、docker の置き場所を足しておく。
PATH="$PATH:/usr/local/bin:/opt/homebrew/bin:/Applications/Docker.app/Contents/Resources/bin"

container="${KURAMOTO_MYSQL_CONTAINER:-kuramoto-mysql}"
dir="${KURAMOTO_BACKUP_DIR:-$HOME/.kuramoto/backups/mysql}"
keep_days="${KURAMOTO_BACKUP_KEEP_DAYS:-14}"

mkdir -p "$dir"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
out="$dir/kuramoto-$stamp.sql.gz"
tmp="$out.partial"
# pipefail が無い sh でも失敗を拾えるよう、dump はいったんファイルに書いてから圧縮する。
raw="$out.partial.sql"
trap 'rm -f "$tmp" "$raw"' EXIT
docker exec "$container" sh -c 'MYSQL_PWD="$MYSQL_PASSWORD" exec mysqldump \
  --single-transaction --no-tablespaces --routines --triggers --hex-blob \
  --default-character-set=utf8mb4 -u"$MYSQL_USER" "$MYSQL_DATABASE"' > "$raw"
[ -s "$raw" ] || { echo "dump が空でした" >&2; exit 1; }
gzip -c "$raw" > "$tmp"
mv "$tmp" "$out"

# 古いものを消す(完成したファイルだけ。.partial は対象にしない)。
find "$dir" -maxdepth 1 -name 'kuramoto-*.sql.gz' -mtime "+$keep_days" -exec rm -f {} +
echo "$out"
