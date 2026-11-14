import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigError, describeConfig, loadConfig, loadConfigText, loadStartupConfig, permissionWarning } from "./config.js";

// ~/.kuramoto/config.yaml は読まない。中身を直接渡すか、一時ディレクトリに置いたファイルを読む
const PATH = "/x/config.yaml";
const load = (text: string | undefined, env: NodeJS.ProcessEnv = {}) => loadConfigText(text, PATH, env);
const fail = (text: string | undefined, env: NodeJS.ProcessEnv = {}) => {
  try {
    load(text, env);
  } catch (e) {
    expect(e).toBeInstanceOf(ConfigError);
    return (e as Error).message;
  }
  throw new Error("失敗するはずでした");
};

describe("設定ファイル", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const tmp = () => {
    const d = mkdtempSync(join(tmpdir(), "kuramoto-config-"));
    dirs.push(d);
    return d;
  };

  it("無ければ今の SQLite", async () => {
    const c = loadConfig(join(tmp(), "config.yaml"), {});
    expect(c).toEqual({ file: undefined, database: { type: "sqlite" }, databaseUrlFromEnv: false });
    expect(describeConfig(c, "/h/.kuramoto")).toBe("設定ファイルなし(既定) / DB: SQLite(/h/.kuramoto)");
  });

  it("空のファイルや database の無いファイルも SQLite", async () => {
    expect(load("").database).toEqual({ type: "sqlite" });
    expect(load("# コメントだけ\n").database).toEqual({ type: "sqlite" });
  });

  it("sqlite", async () => {
    const c = load("database:\n  type: sqlite\n");
    expect(c.database).toEqual({ type: "sqlite" });
    expect(c.file).toBe(PATH);
  });

  it("mysql: 接続先・TLS を読み、出す 1 行にパスワードを含めない", async () => {
    const c = load("database:\n  type: mysql\n  url: mysql://kuramoto:s3cret@db.example.com:3306/kuramoto\n  tls:\n    ca: /etc/ssl/ca.pem\n");
    expect(c.database).toEqual({ type: "mysql", url: "mysql://kuramoto:s3cret@db.example.com:3306/kuramoto", tls: { ca: "/etc/ssl/ca.pem" } });
    const line = describeConfig(c);
    expect(line).toBe(`設定 ${PATH} / DB: MySQL db.example.com:3306 / kuramoto TLS あり`);
    expect(line).not.toContain("s3cret");
  });

  it("mysql なのに接続先が無いと起動しない(SQLite に戻さない)", async () => {
    expect(fail("database:\n  type: mysql\n")).toContain("MySQL の接続先がありません");
  });

  it("mysql の接続先の形がおかしいと起動しない", async () => {
    expect(fail("database:\n  type: mysql\n  url: postgres://h/db\n")).toContain("database.url");
    expect(fail("database:\n  type: mysql\n  url: mysql://h\n")).toContain("データベース名");
  });

  it("知らない type は行を出して起動しない", async () => {
    const msg = fail("# 設定\ndatabase:\n  type: postgres\n");
    expect(msg).toContain("3 行目");
    expect(msg).toContain("database.type");
    expect(msg).toContain("postgres");
  });

  it("知らない項目は行を出して起動しない", async () => {
    const msg = fail("database:\n  type: sqlite\n  pasword: x\n");
    expect(msg).toContain("3 行目");
    expect(msg).toContain("database.pasword");
  });

  it("YAML として読めないときは行を出して起動しない", async () => {
    const msg = fail("database:\n  type: mysql\n   url: [\n");
    expect(msg).toMatch(/\d+ 行目: YAML として読めません/);
  });

  it("sqlite に url を書いたら起動しない(黙って無視しない)", async () => {
    expect(fail("database:\n  type: sqlite\n  url: mysql://h/db\n")).toContain("type: mysql");
  });

  it("KURAMOTO_DATABASE_URL があれば設定ファイルより優先", async () => {
    const env = { KURAMOTO_DATABASE_URL: "mysql://u:pw@env-host/envdb" };
    const c = load("database:\n  type: mysql\n  url: mysql://u:pw@file-host/filedb\n", env);
    expect(c.database).toEqual({ type: "mysql", url: "mysql://u:pw@env-host/envdb" });
    expect(describeConfig(c)).toBe(`設定 ${PATH} / DB: MySQL env-host / envdb(KURAMOTO_DATABASE_URL)`);
    // ファイルが無くても、type が sqlite でも、環境変数があれば MySQL
    expect(load(undefined, env).database.type).toBe("mysql");
    expect(load("database:\n  type: sqlite\n", env).database.type).toBe("mysql");
  });

  it("KURAMOTO_DATABASE_URL の形がおかしければ起動しない", async () => {
    expect(fail(undefined, { KURAMOTO_DATABASE_URL: "sqlite:///x" })).toContain("KURAMOTO_DATABASE_URL");
  });

  describe("docs/mysql.md の書き方(url と passwordFile)", () => {
    const ENV_FILE = "MYSQL_ROOT_PASSWORD=rootpw\nMYSQL_DATABASE=kuramoto\nMYSQL_USER=kuramoto\nMYSQL_PASSWORD=kpw\n";
    const doc = "database:\n  type: mysql\n  url: mysql://kuramoto@127.0.0.1:3306/kuramoto\n  passwordFile: /h/.kuramoto/mysql.env\n";
    const loadWith = (text: string, content: string, seen: string[] = []) =>
      loadConfigText(text, PATH, {}, (f) => {
        seen.push(f);
        return content;
      });

    it("手順書の例のとおりに読め、MYSQL_PASSWORD だけを使う(root のパスワードは使わない)", async () => {
      const seen: string[] = [];
      const c = loadWith(doc, ENV_FILE, seen);
      expect(c.database).toEqual({ type: "mysql", url: "mysql://kuramoto:kpw@127.0.0.1:3306/kuramoto" });
      expect(JSON.stringify(c)).not.toContain("rootpw");
      expect(seen).toEqual(["/h/.kuramoto/mysql.env"]);
      const line = describeConfig(c);
      expect(line).toContain("MySQL 127.0.0.1:3306 / kuramoto");
      expect(line).not.toContain("kpw");
      expect(line).not.toContain("rootpw");
    });

    it("MYSQL_PASSWORD の行が無ければ、root のパスワードがあっても起動しない", async () => {
      const msg = fail2(doc, "MYSQL_ROOT_PASSWORD=rootpw\nMYSQL_USER=kuramoto\n");
      expect(msg).toContain("MYSQL_PASSWORD");
      expect(msg).toContain("database.passwordFile");
      expect(msg).not.toContain("rootpw");
      expect(fail2(doc, "MYSQL_PASSWORD=\n")).toContain("MYSQL_PASSWORD");
    });

    it("名前が似ている行・コメントは読まない。引用符・export・特殊文字は扱える", async () => {
      expect(() => loadWith(doc, "# MYSQL_PASSWORD=x\nXMYSQL_PASSWORD=x\nMYSQL_PASSWORD_OLD=x\n")).toThrow(ConfigError);
      expect(loadWith(doc, 'export MYSQL_PASSWORD="a b"\n').database).toMatchObject({ url: "mysql://kuramoto:a%20b@127.0.0.1:3306/kuramoto" });
      expect(loadWith(doc, "MYSQL_PASSWORD=p@ss:/w#rd\r\n").database).toMatchObject({ url: "mysql://kuramoto:p%40ss%3A%2Fw%23rd@127.0.0.1:3306/kuramoto" });
    });

    it("% を含むパスワードは、URL から decodeURIComponent でもとに戻せる", async () => {
      for (const pw of ["a%41b", "x%y", "ab%41 p@:/#", "100%"]) {
        const c = loadWith(doc, `MYSQL_PASSWORD=${pw}\n`);
        if (c.database.type !== "mysql") throw new Error("mysql のはず");
        expect(decodeURIComponent(new URL(c.database.url).password)).toBe(pw);
      }
      expect(loadWith(doc, "MYSQL_PASSWORD=ab%41 p@:/#\n").database).toMatchObject({ url: "mysql://kuramoto:ab%2541%20p%40%3A%2F%23@127.0.0.1:3306/kuramoto" });
    });

    it("値の後ろのコメント(空白 + #)は docker compose と同じく値に含めない", async () => {
      const pw = (content: string) => (loadWith(doc, content).database as { url: string }).url;
      expect(pw("MYSQL_PASSWORD=abc # memo\n")).toBe("mysql://kuramoto:abc@127.0.0.1:3306/kuramoto");
      expect(pw('MYSQL_PASSWORD="a #b" # memo\n')).toBe("mysql://kuramoto:a%20%23b@127.0.0.1:3306/kuramoto");
      expect(pw("MYSQL_PASSWORD='abc'\n")).toBe("mysql://kuramoto:abc@127.0.0.1:3306/kuramoto");
      expect(pw("MYSQL_PASSWORD=ab#c\n")).toBe("mysql://kuramoto:ab%23c@127.0.0.1:3306/kuramoto");
      expect(() => loadWith(doc, "MYSQL_PASSWORD= # memo\n")).toThrow(ConfigError);
    });

    it("url にもパスワードがあるときは、どちらを使うか決められないので起動しない", async () => {
      const both = "database:\n  type: mysql\n  url: mysql://kuramoto:x@127.0.0.1/kuramoto\n  passwordFile: /h/m.env\n";
      expect(fail2(both, ENV_FILE)).toContain("どちらか一方");
    });

    it("KURAMOTO_DATABASE_URL にパスワードが無ければ passwordFile を足す", async () => {
      const c = loadConfigText(doc, PATH, { KURAMOTO_DATABASE_URL: "mysql://kuramoto@envhost/envdb" }, () => ENV_FILE);
      expect(c.database).toEqual({ type: "mysql", url: "mysql://kuramoto:kpw@envhost/envdb" });
    });

    it("ファイルが読めないときは、どの項目か出して起動しない", async () => {
      const msg = (() => {
        try {
          loadConfigText(doc, PATH, {}, () => {
            throw new Error("ENOENT: no such file");
          });
        } catch (e) {
          return (e as Error).message;
        }
        return "";
      })();
      expect(msg).toContain("database.passwordFile");
      expect(msg).toContain("/h/.kuramoto/mysql.env");
    });

    it("sqlite に passwordFile を書いたら起動しない", async () => {
      expect(fail("database:\n  type: sqlite\n  passwordFile: /h/m.env\n")).toContain("passwordFile");
    });

    it("手順書の古い仮のキー(host/port/name/user)は知らない項目として起動しない", async () => {
      for (const key of ["host", "port", "name", "user"]) {
        expect(fail(`database:\n  type: mysql\n  ${key}: x\n`)).toContain(`database.${key}`);
      }
    });

    it("実ファイルの mysql.env から読む(~/ は家のディレクトリ)", async () => {
      const dir = mkdtempSync(join(tmpdir(), "kuramoto-config-"));
      try {
        const file = join(dir, "mysql.env");
        writeFileSync(file, ENV_FILE, { mode: 0o600 });
        const path = join(dir, "config.yaml");
        writeFileSync(path, `database:\n  type: mysql\n  url: mysql://kuramoto@127.0.0.1:3306/kuramoto\n  passwordFile: ${file}\n`, { mode: 0o600 });
        expect(loadConfig(path, {}).database).toEqual({ type: "mysql", url: "mysql://kuramoto:kpw@127.0.0.1:3306/kuramoto" });
        writeFileSync(path, "database:\n  type: mysql\n  url: mysql://kuramoto@127.0.0.1:3306/kuramoto\n  passwordFile: ~/.kuramoto-no-such-dir/mysql.env\n", { mode: 0o600 });
        expect(() => loadConfig(path, {})).toThrow(/\.kuramoto-no-such-dir\/mysql\.env/);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    function fail2(text: string, content: string): string {
      try {
        loadWith(text, content);
      } catch (e) {
        expect(e).toBeInstanceOf(ConfigError);
        return (e as Error).message;
      }
      throw new Error("失敗するはずでした");
    }
  });

  it("本人以外が読めるときは注意を 1 行", async () => {
    expect(permissionWarning(PATH, 0o100600)).toBeUndefined();
    expect(permissionWarning(PATH, 0o100644)).toContain("chmod 600");
  });

  it("起動時: 1 行出し、0600 でなければ注意を出す", async () => {
    const path = join(tmp(), "config.yaml");
    writeFileSync(path, "database:\n  type: sqlite\n");
    chmodSync(path, 0o644);
    const lines: string[] = [];
    loadStartupConfig((l) => lines.push(l), path, {});
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain(`設定 ${path} / DB: SQLite`);
    expect(lines[1]).toContain("chmod 600");

    chmodSync(path, 0o600);
    lines.length = 0;
    loadStartupConfig((l) => lines.push(l), path, {});
    expect(lines).toHaveLength(1);
  });

  it("起動時: mysql も止めずに通し、1 行だけ出す(パスワードは出さない。繋ぐのは入口の startDatabase)", () => {
    const path = join(tmp(), "config.yaml");
    writeFileSync(path, "database:\n  type: mysql\n  url: mysql://u:s3cr3t-kuramoto@h/db\n", { mode: 0o600 });
    const lines: string[] = [];
    const c = loadStartupConfig((l) => lines.push(l), path, {});
    expect(c.database).toMatchObject({ type: "mysql" });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("MySQL h / db");
    // パスワードの目印は、一時ディレクトリの名前(ランダム)に偶然入らない文字列にする("pw" だと、パスに入って落ちることがあった)
    expect(lines[0]).not.toContain("s3cr3t-kuramoto");
  });
});
