#!/bin/sh
# mysql-backup.sh が作った gz を、手元の MySQL(コンテナ kuramoto-mysql)に戻す。
# 使い方: scripts/mysql-restore.sh ~/.kuramoto/backups/mysql/kuramoto-<日時>.sql.gz
# dump のテーブルは DROP して作り直すので、いまの中身は上書きされる。Kuramoto を止めてから呼ぶこと。
set -eu

PATH="$PATH:/usr/local/bin:/opt/homebrew/bin:/Applications/Docker.app/Contents/Resources/bin"

[ "$#" -eq 1 ] || { echo "使い方: $0 <dump.sql.gz>" >&2; exit 2; }
file="$1"
[ -r "$file" ] || { echo "読めません: $file" >&2; exit 2; }
container="${KURAMOTO_MYSQL_CONTAINER:-kuramoto-mysql}"

gzip -dc "$file" | docker exec -i "$container" sh -c 'MYSQL_PWD="$MYSQL_PASSWORD" exec mysql \
  --default-character-set=utf8mb4 -u"$MYSQL_USER" "$MYSQL_DATABASE"'
echo "戻しました: $file"
