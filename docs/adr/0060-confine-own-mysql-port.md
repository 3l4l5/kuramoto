# ADR-0060: Kuramoto 自身の MySQL のポートも、閉じ込めから断る既定に入れる

- 状態: 提案
- 日付: 2026-11-14
- チケット: #103(#87 のレビューで見つかった。ADR-0059 の続き)

## 背景

ADR-0059 で、チームの CI の閉じ込めから断る既定のポートは `KURAMOTO_PORT`(Kuramoto 本体の API)だけになった。Kuramoto が使う本番の MySQL(`config.yaml` の `database.url`。手元なら `127.0.0.1:3306`)は、設定 `sandbox_deny_local_ports` に足さない限り、閉じ込めの中から接続だけは届く。接続先の URL(パスワードを含む)は、環境変数 `KURAMOTO_DATABASE_URL` を隠している(ADR-0041)ので、パスワードを知らなければ入れないが、届かせる理由が無い。

## 決めたこと

**Kuramoto 自身の MySQL が、このマシン(ループバック)にあるときは、そのポートも既定で断る。**

- `openMysql`(`src/db/mysql.ts`)が、接続先のホストがループバックのとき、プールに渡したポートを `MysqlHandle.localPort` に持たせる(省略時は 3306)。外の DB(`db.example.com` など)では持たない。外の DB には、ドメインの許可リスト(`allowedDomains`)で、許していない限り届かない。
- `startDatabase` が返した `mysql` が `Hq` → `Project` に渡るので、`Project.mysqlLocalPort` で読める。`confinementFor` が、`deniedLocalPorts` に `KURAMOTO_PORT`・`mysqlLocalPort`・設定 `sandbox_deny_local_ports` を重ならないように入れる。
- 効く場所は ADR-0059 と同じ(チームの CI の閉じ込めと、その中のブラウザサーバー)。

## 選ばなかったこと

- **設定ファイルの URL を `confinementFor` が読み直す**: `config.yaml` の読み直しは、`passwordFile` を読むなど副作用があり、起動で使ったものと食い違いうる。実際に繋いだプールのポートを使うほうが、断るべきポートと必ず一致する。
- **mysql-test(3307)も断る**: 試験の MySQL は、チームの CI の `npm test`(ADR-0042)が届く必要がある。断らない。Kuramoto 自身を mysql-test に向けて動かすと、そのポートも断るので、CI の MySQL の回は届かなくなる(本番の 3306 と試験の 3307 は別なので、通常は起きない)。

## 残ること

- SQLite のとき・外の DB のときは、足すポートが無い(今までどおり)。
- ほかのローカルのサービスは、ADR-0059 のとおり `sandbox_deny_local_ports` で足す。
- 担当(エージェント)のシェルは、ADR-0059 のとおり、SDK がポートを選べないので、この断りは効かない。
