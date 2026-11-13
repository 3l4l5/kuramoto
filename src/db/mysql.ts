import { readFileSync } from "node:fs";
import { createPool, type Pool, type PoolOptions } from "mysql2";
import type { PoolConnection } from "mysql2/promise";
import { Kysely, MysqlDialect, sql } from "kysely";
import { migrateMysql, mysqlVersion } from "./mysql-migrate.js";
import { MYSQL_MIGRATIONS } from "./mysql-schema.js";

/**
 * MySQL のアダプタ(ADR-0041)。mysql2 のプールと、Kysely の MysqlDialect で開く。
 *  - 外の DB は TLS 必須(tls.ca)。手元(ループバック)だけは TLS なしでよい。
 *  - Kysely のトランザクションは、プールから専用の接続を 1 本取って、終わるまで持つ。
 *  - 切れたかどうかの見張りは mysql-health.ts。
 */
export type MysqlConfig = { url: string; tls?: { ca: string } };

/** 接続できなかった・TLS の条件を満たさない、など。理由を人が読める形で持つ(パスワードは含めない)。 */
export class DatabaseConnectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DatabaseConnectError";
  }
}

export function isLoopbackHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  return h === "localhost" || h === "::1" || h === "127.0.0.1" || /^127\.\d+\.\d+\.\d+$/.test(h);
}

/** 接続先(config の url と tls)から mysql2 のプールの設定を作る。外の DB で tls.ca が無ければ投げる。 */
export function poolOptions(cfg: MysqlConfig, readFile: (path: string) => Buffer = readFileSync): PoolOptions {
  const url = new URL(cfg.url);
  const host = url.hostname;
  if (!cfg.tls && !isLoopbackHost(host)) {
    throw new DatabaseConnectError(`外の DB(${host})には TLS が必要です。config.yaml の database.tls.ca に CA 証明書のファイルを書いてください`);
  }
  let ca: Buffer | undefined;
  if (cfg.tls) {
    try {
      ca = readFile(cfg.tls.ca);
    } catch (e) {
      throw new DatabaseConnectError(`TLS の CA 証明書 ${cfg.tls.ca} を読めません: ${(e as Error).message}`);
    }
  }
  return {
    host,
    port: url.port ? Number(url.port) : 3306,
    user: decodeURIComponent(url.username),
    ...(url.password ? { password: decodeURIComponent(url.password) } : {}),
    database: decodeURIComponent(url.pathname.replace(/^\//, "")),
    ...(ca ? { ssl: { ca, rejectUnauthorized: true } } : {}),
    charset: "utf8mb4",
    timezone: "Z",
    dateStrings: true,
    supportBigNumbers: true,
    connectionLimit: 10,
    connectTimeout: 5_000,
    waitForConnections: true,
    enableKeepAlive: true,
  };
}

export type MysqlHandle = {
  pool: Pool;
  /** プールの上の Kysely(トランザクションは専用の接続) */
  kysely: Kysely<any>;
  /** 1 往復して生きていることを確かめる。timeoutMs で返らなければ投げる。 */
  ping(timeoutMs?: number): Promise<void>;
  close(): Promise<void>;
};

export function openMysql(cfg: MysqlConfig, opts: { readFile?: (path: string) => Buffer } = {}): MysqlHandle {
  const pool = createPool(poolOptions(cfg, opts.readFile));
  // 接続が切れたときに、プールが未処理の 'error' で落ちないようにする(切れたかどうかは見張りが ping で見る)
  pool.on("error", () => {});
  const kysely = new Kysely<any>({ dialect: new MysqlDialect({ pool }) });
  return {
    pool,
    kysely,
    async ping(timeoutMs = 3_000) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          sql`SELECT 1`.execute(kysely),
          new Promise<never>((_, rej) => {
            timer = setTimeout(() => rej(Object.assign(new Error(`${timeoutMs}ms 待っても返事がありません`), { code: "ETIMEDOUT" })), timeoutMs);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    },
    async close() {
      await kysely.destroy();
    },
  };
}

/** 接続のエラーを、何をすればよいかが分かる 1 文にする。パスワードは含めない。 */
export function describeConnectError(e: unknown, host: string): string {
  const err = e as { code?: string; message?: string };
  const code = err.code ?? "";
  const detail = (err.message ?? String(e)).split("\n")[0]!;
  const why: Record<string, string> = {
    ECONNREFUSED: "接続を断られました(MySQL が起動していない、ポートが違う)",
    ENOTFOUND: "ホスト名を引けません",
    EAI_AGAIN: "ホスト名を引けません",
    ETIMEDOUT: "時間内に返事がありません(ホスト・ポート・ファイアウォールを確かめてください)",
    ECONNRESET: "接続を切られました(TLS の設定が合っていない可能性があります)",
    ER_ACCESS_DENIED_ERROR: "ユーザー名かパスワードが違います",
    ER_DBACCESS_DENIED_ERROR: "このユーザーはその database に入れません",
    ER_BAD_DB_ERROR: "その名前の database がありません",
    DEPTH_ZERO_SELF_SIGNED_CERT: "サーバーの証明書を tls.ca で確かめられません",
    SELF_SIGNED_CERT_IN_CHAIN: "サーバーの証明書を tls.ca で確かめられません",
    UNABLE_TO_VERIFY_LEAF_SIGNATURE: "サーバーの証明書を tls.ca で確かめられません",
    ERR_TLS_CERT_ALTNAME_INVALID: "サーバーの証明書がこのホスト名のものではありません",
  };
  return `MySQL(${host})に繋げません: ${why[code] ?? "繋げませんでした"}(${code ? `${code}: ` : ""}${detail})`;
}

export type StartupResult = {
  handle: MysqlHandle;
  /** schema_version が無かった(この database に初めて繋いだ) */
  firstConnection: boolean;
  version: number;
};

/**
 * 起動時: 繋ぎ、版を最新にする。届かなければ理由を付けて DatabaseConnectError を投げる(起動しない)。
 * 失敗したときはプールを閉じる。
 */
export async function connectMysql(cfg: MysqlConfig, opts: { readFile?: (path: string) => Buffer } = {}): Promise<StartupResult> {
  const host = new URL(cfg.url).hostname;
  const handle = openMysql(cfg, opts);
  let conn: PoolConnection | undefined;
  try {
    try {
      conn = await handle.pool.promise().getConnection();
    } catch (e) {
      throw new DatabaseConnectError(describeConnectError(e, host));
    }
    const before = await mysqlVersion(conn);
    await migrateMysql(conn, MYSQL_MIGRATIONS);
    return { handle, firstConnection: before === 0, version: await mysqlVersion(conn) };
  } catch (e) {
    await handle.close().catch(() => {});
    if (e instanceof DatabaseConnectError) throw e;
    throw new DatabaseConnectError(describeConnectError(e, host));
  } finally {
    conn?.release();
  }
}
