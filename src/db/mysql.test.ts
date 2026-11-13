import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Kysely, MysqlAdapter, MysqlIntrospector, MysqlQueryCompiler, type DatabaseConnection, type Driver, type QueryResult } from "kysely";
import { describe, expect, it } from "vitest";
import { mysqlDialect } from "./dialect/mysql.js";
import { connectMysql, DatabaseConnectError, describeConnectError, isLoopbackHost, poolOptions } from "./mysql.js";
import { DbHealth, isConnectionError } from "./mysql-health.js";
import { sqliteHasProjects, startDatabase, SQLITE_NOT_MIGRATED } from "./startup.js";
import { openDb } from "./sqlite.js";
import { HQ_MIGRATIONS } from "./schema.js";
import { DATABASE_URL_ENV } from "./env.js";
import { confineOptions } from "../harness/claude-agent-sdk.js";
import { confinementFor } from "../project/confine.js";

/** MySQL が無くても流せる試験(実機に繋ぐ試験は mysql-adapter.test.ts) */

describe("プールの設定と TLS", () => {
  it("url から接続の設定を作る(ユーザー・パスワードは % を戻す)。手元(ループバック)は TLS なしでよい", () => {
    const o = poolOptions({ url: "mysql://kura%40moto:p%40ss%3A@127.0.0.1:3307/kuramoto%5Ftest" });
    expect(o).toMatchObject({ host: "127.0.0.1", port: 3307, user: "kura@moto", password: "p@ss:", database: "kuramoto_test", charset: "utf8mb4", timezone: "Z" });
    expect(o.ssl).toBeUndefined();
    expect(poolOptions({ url: "mysql://u@localhost/db" }).port).toBe(3306);
  });

  it("外の DB は tls.ca が無いと開かない。ある外の DB は、CA で証明書を確かめる", () => {
    expect(() => poolOptions({ url: "mysql://u:pw@db.example.com/db" })).toThrow(/TLS が必要です/);
    const o = poolOptions({ url: "mysql://u:pw@db.example.com/db", tls: { ca: "/ca.pem" } }, () => Buffer.from("PEM"));
    expect(o.ssl).toEqual({ ca: Buffer.from("PEM"), rejectUnauthorized: true });
    expect(() => poolOptions({ url: "mysql://u:pw@db.example.com/db", tls: { ca: "/nope.pem" } }, () => { throw new Error("ENOENT"); })).toThrow(/CA 証明書 \/nope\.pem を読めません/);
  });

  it("ループバックの判定", () => {
    for (const h of ["localhost", "127.0.0.1", "127.1.2.3", "::1", "[::1]"]) expect(isLoopbackHost(h)).toBe(true);
    for (const h of ["db.example.com", "10.0.0.5", "127.0.0.1.evil.com"]) expect(isLoopbackHost(h)).toBe(false);
  });

  it("接続できなかったときの理由には、パスワードを含めない", () => {
    const msg = describeConnectError(Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:3306"), { code: "ECONNREFUSED" }), "127.0.0.1");
    expect(msg).toContain("接続を断られました");
    expect(describeConnectError(Object.assign(new Error("Access denied for user 'u'@'h'"), { code: "ER_ACCESS_DENIED_ERROR" }), "h")).toContain("ユーザー名かパスワードが違います");
  });
});

describe("起動時に届かないときは、理由を出して起動しない", () => {
  it("閉じているポートへは DatabaseConnectError(理由つき)で落ち、パスワードは出ない", async () => {
    const err = await connectMysql({ url: "mysql://kuramoto:s3cret-pw@127.0.0.1:1/kuramoto" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DatabaseConnectError);
    expect((err as Error).message).toContain("MySQL(127.0.0.1)に繋げません");
    expect((err as Error).message).toContain("ECONNREFUSED");
    expect((err as Error).message).not.toContain("s3cret-pw");
  });

  it("startDatabase も、届かなければ理由つきで落ちる(入口はこれを出して起動しない)", async () => {
    const lines: string[] = [];
    const err = await startDatabase({ file: undefined, database: { type: "mysql", url: "mysql://kuramoto:s3cret-pw@127.0.0.1:1/kuramoto" }, databaseUrlFromEnv: false }, (l) => lines.push(l)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DatabaseConnectError);
    expect((err as Error).message).toContain("ECONNREFUSED");
    expect((err as Error).message).not.toContain("s3cret-pw");
    expect(lines).toEqual([]);
  });

  it("外の DB で tls.ca が無いと、繋ぎにも行かずに落ちる", async () => {
    await expect(startDatabase({ file: undefined, database: { type: "mysql", url: "mysql://u:pw@db.example.com/db" }, databaseUrlFromEnv: false }, () => {})).rejects.toThrow(/TLS が必要です/);
  });

  it("SQLite のときは何もしない", async () => {
    const lines: string[] = [];
    const d = await startDatabase({ file: undefined, database: { type: "sqlite" }, databaseUrlFromEnv: false }, (l) => lines.push(l));
    expect(d.mysql).toBeUndefined();
    expect(lines).toEqual([]);
  });
});

describe("SQLite に残っているプロジェクトの検出(初めて MySQL に繋いだときの 1 行)", () => {
  it("hq.sqlite にプロジェクトがあれば true。無い・ファイルが無いなら false。開いても書き換えない", () => {
    const home = mkdtempSync(join(tmpdir(), "kuramoto-home-"));
    expect(sqliteHasProjects(home)).toBe(false);
    const db = openDb(join(home, "hq.sqlite"), HQ_MIGRATIONS);
    expect(sqliteHasProjects(home)).toBe(false);
    db.exec("INSERT INTO projects (name, data_dir, status, created_at) VALUES ('p', '/d', 'planning', '2026-01-01')");
    db.close();
    expect(sqliteHasProjects(home)).toBe(true);
    writeFileSync(join(home, "hq.sqlite"), "壊れたファイル");
    expect(sqliteHasProjects(home)).toBe(false);
    expect(SQLITE_NOT_MIGRATED).toContain("移りません");
    expect(SQLITE_NOT_MIGRATED).toContain("設計書");
  });
});

describe("DbHealth(切れたかの見張り)", () => {
  it("ping が落ちたら切れた、返ったら繋がった。変わったときだけ知らせる", async () => {
    let alive = true;
    const events: boolean[] = [];
    const h = new DbHealth(async () => {
      if (!alive) throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    }, { now: () => new Date("2026-11-13T00:00:00Z") });
    h.onChange((s) => events.push(s.up));
    await h.check();
    expect(h.isUp()).toBe(true);
    alive = false;
    await h.check();
    await h.check();
    expect(h.current()).toEqual({ up: false, since: "2026-11-13T00:00:00.000Z", error: "connect ECONNREFUSED" });
    alive = true;
    await h.check();
    expect(h.isUp()).toBe(true);
    expect(events).toEqual([false, true]);
  });

  it("間隔ごとに自分で確かめ、切れても止まらず、繋がり直したら戻る。stop で止まる", async () => {
    let alive = true;
    let pings = 0;
    const h = new DbHealth(async () => {
      pings++;
      if (!alive) throw new Error("down");
    }, { intervalMs: 5 });
    h.start();
    alive = false;
    await new Promise((r) => setTimeout(r, 40));
    expect(h.isUp()).toBe(false);
    alive = true;
    await new Promise((r) => setTimeout(r, 40));
    expect(h.isUp()).toBe(true);
    h.stop();
    const n = pings;
    await new Promise((r) => setTimeout(r, 30));
    expect(pings).toBe(n);
  });

  it("クエリのエラーは、接続のエラーのときだけ切れた扱いにする(SQL の間違いでは切れない)", () => {
    const h = new DbHealth(async () => {});
    h.reportFailure(Object.assign(new Error("Unknown column"), { code: "ER_BAD_FIELD_ERROR" }));
    expect(h.isUp()).toBe(true);
    h.reportFailure(Object.assign(new Error("lost"), { code: "PROTOCOL_CONNECTION_LOST", fatal: true }));
    expect(h.isUp()).toBe(false);
    expect(isConnectionError(Object.assign(new Error(), { code: "ECONNRESET" }))).toBe(true);
    expect(isConnectionError(new Error("x"))).toBe(false);
  });
});

/** 流れた文を記録するだけの Kysely(MySQL の文の形を見る) */
function recording(respond: (sql: string) => Partial<QueryResult<any>>) {
  const log: string[] = [];
  const conn: DatabaseConnection = {
    async executeQuery(q) {
      log.push(q.sql);
      return { rows: [], ...respond(q.sql) } as QueryResult<any>;
    },
    async *streamQuery() {},
  };
  const driver: Driver = {
    async init() {},
    async acquireConnection() {
      return conn;
    },
    async beginTransaction() {
      log.push("BEGIN");
    },
    async commitTransaction() {
      log.push("COMMIT");
    },
    async rollbackTransaction() {
      log.push("ROLLBACK");
    },
    async releaseConnection() {},
    async destroy() {},
  };
  const k = new Kysely<any>({ dialect: { createAdapter: () => new MysqlAdapter(), createDriver: () => driver, createIntrospector: (d) => new MysqlIntrospector(d), createQueryCompiler: () => new MysqlQueryCompiler() } });
  return { k, log };
}

describe("MySQL の方言の文の形", () => {
  const candidate = (k: Kysely<any>) => k.selectFrom("messages as m").select("m.id").where("m.status", "=", "pending").orderBy("m.id").limit(1);

  it("受信箱の取り出し: トランザクションの中で SELECT … FOR UPDATE SKIP LOCKED → UPDATE(status = 'pending' も見る)→ SELECT", async () => {
    const { k, log } = recording((s) => (/^select .* for update/.test(s) ? { rows: [{ id: 7, project_id: 3 }] } : /^update/.test(s) ? { numAffectedRows: 1n, numChangedRows: 1n } : /^select/.test(s) ? { rows: [{ id: 7, status: "claimed" }] } : {}));
    const row = await mysqlDialect.claimMessage(k, candidate(k), "2026-11-13");
    expect(row).toEqual({ id: 7, status: "claimed" });
    expect(log[0]).toBe("BEGIN");
    expect(log[1]).toMatch(/^select `m`\.`id`, `m`\.`project_id` from `messages` as `m` where .* limit \? for update skip locked$/);
    expect(log[2]).toMatch(/^update `messages` set `status` = \?, `claimed_at` = \?, `attempts` = attempts \+ 1 where `id` = \? and `project_id` = \? and `status` = \?$/);
    expect(log[4]).toBe("COMMIT");
  });

  it("更新できた件数が 1 でなければ(ほかに取られた)取れなかったことにする", async () => {
    const { k } = recording((s) => (/^select .* for update/.test(s) ? { rows: [{ id: 7, project_id: 3 }] } : /^update/.test(s) ? { numAffectedRows: 0n, numChangedRows: 0n } : {}));
    expect(await mysqlDialect.claimMessage(k, candidate(k), "now")).toBeUndefined();
  });

  it("候補が無ければ UPDATE せずに undefined", async () => {
    const { k, log } = recording(() => ({}));
    expect(await mysqlDialect.claimMessage(k, candidate(k), "now")).toBeUndefined();
    expect(log.some((s) => /^update/.test(s))).toBe(false);
  });

  it("すでにトランザクションの中なら、その上で流す(入れ子にしない)", async () => {
    const { k, log } = recording((s) => (/for update/.test(s) ? { rows: [{ id: 1, project_id: 1 }] } : /^update/.test(s) ? { numAffectedRows: 1n } : { rows: [{ id: 1 }] }));
    await k.transaction().execute((trx) => mysqlDialect.claimMessage(trx, candidate(trx), "now"));
    expect(log.filter((s) => s === "BEGIN")).toHaveLength(1);
  });

  it("挿入した id は insertId", async () => {
    const { k } = recording(() => ({ insertId: 42n, numAffectedRows: 1n }));
    expect(await mysqlDialect.insertedId(k.insertInto("runs").values({ role: "dev" }))).toBe(42);
  });

  it("upsert は ON DUPLICATE KEY UPDATE", async () => {
    const { k, log } = recording(() => ({}));
    await mysqlDialect.upsert(k.insertInto("settings").values({ key: "a", value: "1" }), ["key"], ["value"]).execute();
    expect(log[0]).toMatch(/on duplicate key update `value` = values\(`value`\)/);
  });
});

describe("KURAMOTO_DATABASE_URL は閉じ込めの中へ渡さない", () => {
  it("シェルに渡さない環境変数に入り、SDK に渡す環境変数にも入らない", async () => {
    process.env[DATABASE_URL_ENV] = "mysql://u:secret@h/db";
    try {
      const o = confineOptions("/w", { readable: [], writable: [], hidden: [], allowedDomains: [], hiddenEnv: ["GH_TOKEN"], allowLocalSockets: false, env: {} });
      expect(o.env[DATABASE_URL_ENV]).toBeUndefined();
      expect(o.env.PATH).toBe(process.env.PATH);
      const p = { setting: () => undefined, settingNumber: () => 0 } as never;
      const conf = await confinementFor(p, { gitDir: "/g", path: "/w" } as never, "dev");
      expect(conf.hiddenEnv).toContain(DATABASE_URL_ENV);
    } finally {
      delete process.env[DATABASE_URL_ENV];
    }
  });
});
