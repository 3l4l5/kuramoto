# MySQL の運用手順

手元の Mac で Kuramoto の DB を MySQL にするときの手順です。立て方・`config.yaml`・バックアップ(launchd)・戻し方・DB の切り替えを書きます。構成は [compose.yaml](../compose.yaml) にあります。

| 名前 | 用途 | 公開 | データ |
|---|---|---|---|
| `mysql`(コンテナ `kuramoto-mysql`) | 手元で使う本番用。MySQL 8.4 | `127.0.0.1:3306` だけ | 外部の名前付きボリューム `kuramoto-mysql` |
| `mysql-test`(コンテナ `kuramoto-mysql-test`) | テスト用 | `127.0.0.1:3307` だけ | tmpfs(止めると消える) |

文字コードは `utf8mb4`、照合順序は `utf8mb4_bin`、時刻は UTC です。`restart: unless-stopped` なので、Docker が起動していれば Mac の再起動後も立ち上がります。

## 1. 立て方

パスワードは `~/.kuramoto/mysql.env` に書きます。`compose.yaml` やリポジトリの `.env` には置きません。

```sh
mkdir -p ~/.kuramoto && chmod 700 ~/.kuramoto
umask 077
cat > ~/.kuramoto/mysql.env <<ENV
MYSQL_ROOT_PASSWORD=$(openssl rand -hex 24)
MYSQL_DATABASE=kuramoto
MYSQL_USER=kuramoto
MYSQL_PASSWORD=$(openssl rand -hex 24)
ENV
chmod 600 ~/.kuramoto/mysql.env
```

- `MYSQL_USER` は、公式イメージが `MYSQL_DATABASE` にだけ全権限を与えて作ります。他の database は読めません。Kuramoto はこのユーザーで繋ぎます(root では繋がない)。
- `mysql.env` は初回の起動のときだけ効きます(データのボリュームが空のときに、database とユーザーを作るため)。あとからパスワードを変えるときは MySQL の中で `ALTER USER` をしたうえで、`mysql.env` も合わせます。

ボリュームを作ってから起動します。ボリュームは `external: true` なので、先に作っておかないと `up` が失敗します(`docker compose down -v` でも消えないようにするためです)。

```sh
docker volume create kuramoto-mysql
docker compose up -d
docker compose ps          # 2 つとも healthy になれば OK
```

公開が `127.0.0.1` だけであることは、次で確かめられます。

```sh
docker compose ps --format '{{.Name}} {{.Ports}}'
# kuramoto-mysql 127.0.0.1:3306->3306/tcp
# kuramoto-mysql-test 127.0.0.1:3307->3306/tcp
```

`0.0.0.0` や `:::` が見えたら、`compose.yaml` の `ports` が書き換わっています。

## 2. config.yaml の書き方

Kuramoto が使う DB は `config.yaml` で選びます。パスワードは `config.yaml` に書かず、`mysql.env` のファイルを指します。

```yaml
database:
  type: mysql
  host: 127.0.0.1
  port: 3306
  name: kuramoto              # mysql.env の MYSQL_DATABASE
  user: kuramoto              # mysql.env の MYSQL_USER
  passwordFile: ~/.kuramoto/mysql.env   # MYSQL_PASSWORD を読む
```

テスト用は同じ書き方で、`port: 3307`・`name: kuramoto_test`・`user: kuramoto_test` にします(パスワードは `compose.yaml` の `mysql-test` に書いてあるテスト専用のものです)。

> この節のキー名は、`config.yaml` を読む側の実装と合わせてください。この手順書の範囲は、MySQL を立てて、バックアップを取り、戻すところまでです。

## 3. バックアップ(1 日 1 回、launchd)

[scripts/mysql-backup.sh](../scripts/mysql-backup.sh) が、`mysqldump --single-transaction` で Kuramoto の database を `~/.kuramoto/backups/mysql/kuramoto-<UTC の日時>.sql.gz` に書き出し、14 日より古いものを消します(`KURAMOTO_BACKUP_KEEP_DAYS` で変更)。

- Kuramoto を止めずに取れます(`--single-transaction` は InnoDB を一貫した状態で読みます)。
- パスワードはコンテナの環境変数から読み、コマンドラインにもログにも出しません。
- 書き出しの途中で失敗したときは、できかけのファイルを残さず、古いバックアップも消しません。
- ファイルは本人だけが読める権限(0600)で作ります。

まず手で 1 回動かして確かめます。

```sh
scripts/mysql-backup.sh
ls -l ~/.kuramoto/backups/mysql
```

launchd に登録します。次をそのまま貼れば、`~/Library/LaunchAgents/com.kuramoto.mysql-backup.plist` ができます(毎日 03:00 に実行。Mac が寝ていた場合は、起きたあとに実行されます)。

```sh
mkdir -p ~/.kuramoto/backups/mysql ~/.kuramoto/logs
cat > ~/Library/LaunchAgents/com.kuramoto.mysql-backup.plist <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.kuramoto.mysql-backup</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(pwd)/scripts/mysql-backup.sh</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key><integer>3</integer>
    <key>Minute</key><integer>0</integer>
  </dict>
  <key>StandardOutPath</key><string>$HOME/.kuramoto/logs/mysql-backup.log</string>
  <key>StandardErrorPath</key><string>$HOME/.kuramoto/logs/mysql-backup.log</string>
</dict>
</plist>
PLIST
launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/com.kuramoto.mysql-backup.plist
launchctl kickstart "gui/$(id -u)/com.kuramoto.mysql-backup"   # 今すぐ 1 回動かす
```

`$(pwd)` はこのリポジトリの場所です(リポジトリを動かしたら plist を作り直します)。止めるときは `launchctl bootout "gui/$(id -u)/com.kuramoto.mysql-backup"` です。ログは `~/.kuramoto/logs/mysql-backup.log` に出ます。Docker Desktop が起動していないと失敗するので、ログイン時に起動する設定にしておきます。

バックアップは同じ Mac の中にあります。Mac ごと失う場合に備えて、`~/.kuramoto/backups/mysql` を Time Machine などの別の場所にも写してください。

## 4. 戻し方

Kuramoto を止めてから戻します。dump にはテーブルを作り直す文が入っているので、いまの中身は上書きされます。

```sh
scripts/mysql-restore.sh ~/.kuramoto/backups/mysql/kuramoto-20261113T030000Z.sql.gz
```

`mysql` コンテナの Kuramoto ユーザーで、`MYSQL_DATABASE` に流し込みます。次のように、戻しが通ったか確かめます。

```sh
docker exec kuramoto-mysql sh -c 'MYSQL_PWD="$MYSQL_PASSWORD" mysql -u"$MYSQL_USER" "$MYSQL_DATABASE" -e "SHOW TABLES"'
```

ボリュームごと失った場合は、`docker volume create kuramoto-mysql` と `docker compose up -d` で空の database を作ってから、上の戻しをします。

## 5. DB を切り替えるとき

SQLite と MySQL のあいだは、DB のファイルやダンプをそのまま移さず、設計書のエクスポートと読み込みで移します([ADR-0017](adr/0017-restore-from-exported-design-doc.md))。DB の種類が違うので、dump は使えません。

1. いまの Kuramoto で、プロジェクトごとに「設計書をエクスポート(Markdown)」を書き出す。
2. `config.yaml` の `database` を切り替えて、Kuramoto を起動し直す。
3. 本部の「設計書から復元」で、書き出した設計書を読み込む。

戻るのは、要件・フロー・画面・インフラ・アーキテクチャ・ドメイン・データ設計・未決と答え・会話・チケットです。担当の会話の続き(セッション)、途中の版の履歴、起動の記録と指標、PR の写しは戻りません。作業中だったチケットの依頼も持ち越されません。切り替えの前に、オフィスを「終業」にして、作業中のものを片付けておくと安心です。

元の DB は、切り替えたあとも消さずに残しておき、読み込んだ内容を確かめてから片付けます。
