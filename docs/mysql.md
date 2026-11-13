# MySQL の運用手順

手元の Mac で Kuramoto の DB を MySQL にするときの手順です。立て方・`config.yaml`・バックアップ(launchd)・戻し方・DB の切り替え・SQLite からの移し方を書きます。構成は [compose.yaml](../compose.yaml) にあります。

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

`~/.kuramoto/mysql.env` が無い環境(CI など)でも、テスト用だけなら `docker compose up -d mysql-test` で立てられます(`mysql` の `env_file` は `required: false`。`mysql.env` が無いまま `mysql` は立てないでください)。

### テスト(npm test)

`npm test` は SQLite の回と MySQL の回を流します(ADR-0042)。MySQL の回は mysql-test に、回ごとの使い捨ての database(`kuramoto_test_…`)を作って流し、終わったら消すので、複数の worktree から同時に流しても混ざりません。

- 先に `docker compose up -d mysql-test` が要ります。繋がらなければ、飛ばさずにそう出して落ちます。
- MySQL の回を飛ばしてよいときだけ、`KURAMOTO_SKIP_MYSQL_TESTS=1 npm test` と明示します。
- database を作るのは mysql-test の root(テスト専用のパスワード)です。別の接続先は `KURAMOTO_MYSQL_TEST_URL`(試験)と `KURAMOTO_MYSQL_TEST_ADMIN_URL`(database を作る側)で変えられます。
- チームの CI も `npm test` を流すので、MySQL の回が落ちる・mysql-test が立っていないと、merge 待ちに進みません。

## 2. config.yaml の書き方

Kuramoto が使う DB は `config.yaml` で選びます。パスワードは `config.yaml` に書かず、`mysql.env` のファイルを指します。

```yaml
database:
  type: mysql
  url: mysql://kuramoto@127.0.0.1:3306/kuramoto   # mysql://ユーザー@ホスト:ポート/database 名(パスワードは書かない)
  passwordFile: ~/.kuramoto/mysql.env             # 読むのは MYSQL_PASSWORD の 1 行だけ
```

- `url` の ユーザーと database 名は、`mysql.env` の `MYSQL_USER` と `MYSQL_DATABASE` と同じにします。
- パスワードは `config.yaml` に書かず、`passwordFile` が指す `mysql.env` の `MYSQL_PASSWORD` の行から読みます。`~/` は家のディレクトリです。`url` にもパスワードを書くと、どちらを使うか決められないので起動しません。`MYSQL_PASSWORD` の行が無い・空のときも起動しません。
- 環境変数 `KURAMOTO_DATABASE_URL` があるときは、`url` の代わりにそちらを使います(`passwordFile` はそのまま効きます)。
- TLS は `tls: { ca: <CA のファイルのパス> }` を足します。手元(`127.0.0.1`・`localhost`)の MySQL では省けますが、外の DB では必須です(無いと起動しません)。証明書は CA で確かめます。
- 注意: 本部とプロジェクトの読み書きの本体がまだ MySQL に移っていないので、いまは `type: mysql` にすると起動を止めます(ADR-0041)。アダプタは用意済みで、本体が移ったら使えるようになります。そのとき、届かなければ理由を出して起動しません。動いている間に切れたら、受信箱の見回りとエージェントの起動を止めて待ち、画面に出し、繋がり直したら自動で再開します。
- ここに書ける項目は `type`・`url`・`passwordFile`・`tls` です。これ以外(`host`・`port`・`name`・`user` など)を書くと、知らない項目として起動しません。

テスト用は同じ書き方で、`url` を `mysql://kuramoto_test@127.0.0.1:3307/kuramoto_test` にします(パスワードは `compose.yaml` の `mysql-test` に書いてあるテスト専用のものです)。

`mysql.env` には `MYSQL_ROOT_PASSWORD` も入っています。Kuramoto は `MYSQL_PASSWORD` の行だけを読み、root のパスワードは読みません(root で繋がない)。root のパスワードまで Kuramoto に見せたくない場合は、`MYSQL_PASSWORD` だけを書いた別のファイル(0600)を作って `passwordFile` で指します。

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

Kuramoto を止めてから戻します。戻す前に Kuramoto の database を `DROP DATABASE` / `CREATE DATABASE`(utf8mb4 / utf8mb4_bin)で作り直して空にするので、いまの中身は消えます。dump のあとにマイグレーションで増えたテーブルも残りません。壊れた gz(`gzip -t` に通らないもの)のときは、何も消さずに失敗します。

```sh
scripts/mysql-restore.sh ~/.kuramoto/backups/mysql/kuramoto-20261113T030000Z.sql.gz
```

`mysql` コンテナの Kuramoto ユーザー(`kuramoto.*` の全権限を持つ)で、`MYSQL_DATABASE` に流し込みます。次のように、戻しが通ったか確かめます。

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

## 6. SQLite から MySQL へ移す(`kuramoto db transfer`)

SQLite の本部(`hq.sqlite`)と全プロジェクトの `project.sqlite` の中身を、まるごと MySQL へ移します(ADR-0038)。設計書のエクスポートと違い、起動の記録・指標・PR の写し・途中の版の履歴まで移ります。

前提:

- MySQL を 1 と 2 のとおり立て、`config.yaml`(または `KURAMOTO_DATABASE_URL`)に `type: mysql` と接続先を書いておく。この入口は、`config.yaml` の MySQL をそのまま移し先にします。
- 移し先の database は、**プロジェクトがまだ 1 つも入っていない**もの(空の database)。入っていれば、何も入れずに止まります(二重に入れない)。
- Kuramoto(サーバーと `kuramoto run`)を止めておく。移している間に SQLite が書き換わらないようにするためです。
- SQLite のバックアップ(`~/.kuramoto` の `hq.sqlite` と各 `project.sqlite`)を取っておく。

```sh
npm run dev -- db transfer      # = tsx src/cli.ts db transfer
```

やること(この順):

1. `config.yaml` の接続先を読む(MySQL でなければ止まる)。接続は TLS・パスワードのファイルも含めて、2 の書き方のとおり。
2. MySQL に繋いで、最新の版まで流す。繋がらなければ、理由を出して止まる。
3. `hq.sqlite` と、本部に載っている各プロジェクトの `project.sqlite` を開き、最新の版まで流す(SQLite のファイルは、この版の更新のほかは変わらず、消えません)。ファイルが無いプロジェクトがあれば、空の DB を作らずに止まる。
4. 全部を 1 つのトランザクションで MySQL に入れる。途中で失敗したら、MySQL には何も残らない。プロジェクトごとに、tickets と runs を入れ終えたあとで、`dev_done` を SQLite の版 19 と同じ決まりで埋める。

結果は、プロジェクトごとのチケット数と、`dev_done` を埋めた件数(MySQL 側で 0 から 1 にした件数)で出ます。

```
MySQL に繋ぎました(スキーマの版 21)
移しました(プロジェクト 1 件)
  1	shop	チケット 12 件 / dev_done を埋めた 0 件
```

「埋めた件数」は、SQLite の版 19 がすでに埋めているデータなら 0 になります(そのまま移るため)。そうなっていないチケットだけが数えられます。

移したあとは、`select` で件数を見るなどして確かめます。注意: サーバー・`kuramoto run` の読み書きの本体は、まだ MySQL に繋がっていません(2 を参照。ADR-0041)。この入口は、データを MySQL に移すだけです。移し終わっても、`config.yaml` を `type: mysql` にした Kuramoto はまだ起動できません。失敗してやり直すときは、MySQL の database を空にしてから(4 の戻しと同じく `DROP DATABASE` / `CREATE DATABASE`)、もう一度流します。
