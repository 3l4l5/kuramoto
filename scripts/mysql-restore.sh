#!/bin/sh
# mysql-backup.sh が作った gz を、手元の MySQL(コンテナ kuramoto-mysql)に戻す。
# 使い方: scripts/mysql-restore.sh ~/.kuramoto/backups/mysql/kuramoto-<日時>.sql.gz
# 戻す前に Kuramoto の database を作り直して空にする(dump のあとに増えたテーブルを残さないため)。
# いまの中身は消えるので、Kuramoto を止めてから呼ぶこと。壊れた gz のときは何もせず失敗する。
set -eu

PATH="$PATH:/usr/local/bin:/opt/homebrew/bin:/Applications/Docker.app/Contents/Resources/bin"

[ "$#" -eq 1 ] || { echo "使い方: $0 <dump.sql.gz>" >&2; exit 2; }
file="$1"
[ -r "$file" ] || { echo "読めません: $file" >&2; exit 2; }
container="${KURAMOTO_MYSQL_CONTAINER:-kuramoto-mysql}"

# sh には pipefail が無く、途中で切れた gz も流し込まれて成功に見えてしまうので、先に gz を検査する。
gzip -t "$file" || { echo "壊れています: $file" >&2; exit 2; }

docker exec "$container" sh -c 'MYSQL_PWD="$MYSQL_PASSWORD" exec mysql -u"$MYSQL_USER" -e \
  "DROP DATABASE IF EXISTS \`$MYSQL_DATABASE\`; CREATE DATABASE \`$MYSQL_DATABASE\` CHARACTER SET utf8mb4 COLLATE utf8mb4_bin"'
gzip -dc "$file" | docker exec -i "$container" sh -c 'MYSQL_PWD="$MYSQL_PASSWORD" exec mysql \
  --default-character-set=utf8mb4 -u"$MYSQL_USER" "$MYSQL_DATABASE"'
echo "戻しました: $file"
