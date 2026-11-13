import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { beforeEach, describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
// コメントは除いて見る(「0.0.0.0 には出さない」と書いてあるため)
const compose = readFileSync(join(root, "compose.yaml"), "utf8").replace(/^\s*#.*$/gm, "");

// compose.yaml をサービスごとに分ける(YAML パーサを足さず、インデントで切る)
function service(name: string): string {
  const m = compose.match(new RegExp(`^  ${name}:\\n((?:    .*\\n|\\n)+)`, "m"));
  if (!m) throw new Error(`service ${name} not found`);
  return m[1]!;
}

describe("compose.yaml", () => {
  it("ポートはすべて 127.0.0.1 にだけ公開する", () => {
    const ports = [...compose.matchAll(/^\s+- "([^"]*:\d+:\d+)"$/gm)].map((m) => m[1]);
    expect(ports.sort()).toEqual(["127.0.0.1:3306:3306", "127.0.0.1:3307:3306"]);
    expect(compose).not.toContain("0.0.0.0");
    // 公開の書き方が ports の 1 行以外(ホスト IP なしの "3306:3306" など)に無いこと
    expect([...compose.matchAll(/^\s+- "?(\d+:\d+)"?$/gm)]).toEqual([]);
  });

  it("mysql: 8.4・外部ボリューム・env_file・utf8mb4_bin・UTC・restart。パスワードは書かない", () => {
    const s = service("mysql");
    expect(s).toContain("image: mysql:8.4");
    expect(s).toContain("restart: unless-stopped");
    expect(s).toContain("${HOME}/.kuramoto/mysql.env");
    // mysql.env が無い環境(CI)でも、mysql-test だけ立てられる(プロジェクトの読み込みで失敗しない)
    expect(s).toMatch(/env_file:\n\s+- path: \$\{HOME\}\/\.kuramoto\/mysql\.env\n\s+required: false/);
    expect(s).toContain("--character-set-server=utf8mb4");
    expect(s).toContain("--collation-server=utf8mb4_bin");
    expect(s).toContain("--default-time-zone=+00:00");
    expect(s).toContain("kuramoto-mysql:/var/lib/mysql");
    expect(s).not.toMatch(/PASSWORD:\s*\S/);
    expect(compose).toMatch(/^volumes:\n(?:\s*\n)* {2}kuramoto-mysql:\n(?: {4}.*\n)*? {4}external: true/m);
  });

  it("mysql-test: tmpfs・3307・テスト専用のパスワード", () => {
    const s = service("mysql-test");
    expect(s).toContain("tmpfs:\n      - /var/lib/mysql");
    expect(s).toContain("127.0.0.1:3307:3306");
    expect(s).toContain("MYSQL_PASSWORD: kuramoto-test");
    expect(s).toContain("--collation-server=utf8mb4_bin");
    expect(s).not.toContain("volumes:");
  });
});

describe("mysql-backup.sh / mysql-restore.sh", () => {
  let work: string;
  let bin: string;
  let backups: string;
  let env: NodeJS.ProcessEnv;

  // 偽の docker: 引数を記録し、exec -i のときは標準入力を保存し、dump のときは FAKE_DUMP を出す
  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), "kuramoto-mysql-"));
    bin = join(work, "bin");
    backups = join(work, "backups");
    execFileSync("mkdir", ["-p", bin]);
    writeFileSync(
      join(bin, "docker"),
      `#!/bin/sh
echo "$@" >> "$FAKE_LOG"
case "$*" in
  *mysqldump*) [ "\${FAKE_FAIL:-}" = 1 ] && { echo boom >&2; exit 1; }; printf '%s' "$FAKE_DUMP" ;;
  *"exec -i"*) cat > "$FAKE_STDIN" ;;
esac
`,
    );
    chmodSync(join(bin, "docker"), 0o755);
    env = {
      PATH: `${bin}:${process.env.PATH}`,
      HOME: work,
      KURAMOTO_BACKUP_DIR: backups,
      FAKE_LOG: join(work, "docker.log"),
      FAKE_STDIN: join(work, "stdin.sql"),
      FAKE_DUMP: "CREATE TABLE t (id int);\n",
    };
  });

  const run = (script: string, args: string[] = [], extra: NodeJS.ProcessEnv = {}) =>
    spawnSync("sh", [join(root, "scripts", script), ...args], { env: { ...env, ...extra }, encoding: "utf8" });

  it("バックアップは --single-transaction で dump し、gz を 0600 で置き、パスワードを引数に出さない", () => {
    const r = run("mysql-backup.sh");
    expect(r.status).toBe(0);
    const files = readdirSync(backups);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^kuramoto-\d{8}T\d{6}Z\.sql\.gz$/);
    const path = join(backups, files[0]!);
    expect(gunzipSync(readFileSync(path)).toString()).toBe("CREATE TABLE t (id int);\n");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const log = readFileSync(env.FAKE_LOG!, "utf8");
    expect(log).toContain("--single-transaction");
    expect(log).toContain("kuramoto-mysql");
    expect(log).toContain('MYSQL_PWD="$MYSQL_PASSWORD"'); // 値ではなく、コンテナ内の変数を参照する
  });

  it("dump に失敗したら、できかけも残さず、古いバックアップも消さない", () => {
    execFileSync("mkdir", ["-p", backups]);
    const old = join(backups, "kuramoto-20200101T000000Z.sql.gz");
    writeFileSync(old, gzipSync("old"));
    const past = new Date(Date.now() - 100 * 86400_000);
    utimesSync(old, past, past);
    const r = run("mysql-backup.sh", [], { FAKE_FAIL: "1" });
    expect(r.status).not.toBe(0);
    expect(readdirSync(backups)).toEqual(["kuramoto-20200101T000000Z.sql.gz"]);
  });

  it("dump が空なら失敗にする", () => {
    const r = run("mysql-backup.sh", [], { FAKE_DUMP: "" });
    expect(r.status).not.toBe(0);
    expect(readdirSync(backups)).toEqual([]);
  });

  it("保持日数より古い完成ファイルだけ消す", () => {
    execFileSync("mkdir", ["-p", backups]);
    const old = join(backups, "kuramoto-20200101T000000Z.sql.gz");
    const recent = join(backups, "kuramoto-20991231T000000Z.sql.gz");
    const other = join(backups, "memo.txt");
    for (const f of [old, recent, other]) writeFileSync(f, "x");
    const past = new Date(Date.now() - 30 * 86400_000);
    for (const f of [old, other]) utimesSync(f, past, past);
    expect(run("mysql-backup.sh").status).toBe(0);
    const left = readdirSync(backups);
    expect(left).not.toContain("kuramoto-20200101T000000Z.sql.gz");
    expect(left).toContain("kuramoto-20991231T000000Z.sql.gz");
    expect(left).toContain("memo.txt");
  });

  it("戻しは gz を展開して mysql に流し込む。バックアップと戻しで中身が往復する", () => {
    expect(run("mysql-backup.sh").status).toBe(0);
    const file = join(backups, readdirSync(backups)[0]!);
    const r = run("mysql-restore.sh", [file]);
    expect(r.status).toBe(0);
    expect(readFileSync(env.FAKE_STDIN!, "utf8")).toBe("CREATE TABLE t (id int);\n");
    expect(readFileSync(env.FAKE_LOG!, "utf8")).toMatch(/exec -i kuramoto-mysql sh -c .*mysql/);
  });

  it("戻しは、壊れた gz なら docker を呼ばずに失敗する", () => {
    const good = gzipSync("CREATE TABLE t (id int);\n".repeat(200));
    const broken = join(work, "trunc.sql.gz");
    writeFileSync(broken, good.subarray(0, 20));
    const r = run("mysql-restore.sh", [broken]);
    expect(r.status).toBe(2);
    expect(r.stdout).not.toContain("戻しました");
    expect(() => readFileSync(env.FAKE_LOG!)).toThrow();
  });

  it("戻しは、流し込む前に database を作り直して空にする", () => {
    expect(run("mysql-backup.sh").status).toBe(0);
    const file = join(backups, readdirSync(backups)[0]!);
    expect(run("mysql-restore.sh", [file]).status).toBe(0);
    const log = readFileSync(env.FAKE_LOG!, "utf8");
    const drop = log.indexOf("DROP DATABASE");
    expect(drop).toBeGreaterThanOrEqual(0);
    expect(log).toContain("CREATE DATABASE");
    expect(log.indexOf("exec -i")).toBeGreaterThan(drop);
  });

  it("戻しは、引数が無い・ファイルが読めないときは何もせず失敗する", () => {
    expect(run("mysql-restore.sh").status).toBe(2);
    expect(run("mysql-restore.sh", [join(work, "none.sql.gz")]).status).toBe(2);
    expect(() => readFileSync(env.FAKE_LOG!)).toThrow();
  });
});
