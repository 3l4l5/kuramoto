import { existsSync } from "node:fs";
import { join } from "node:path";
import { describeConfig, loadConfig, type KuramotoConfig } from "../config.js";
import { kuramotoHome } from "../hq.js";
import { connectMysql } from "./mysql.js";
import { HQ_MIGRATIONS, PROJECT_MIGRATIONS } from "./schema.js";
import { transferSqliteToMysql, type TransferResult } from "./sqlite-to-mysql.js";
import { openDb } from "./sqlite.js";

/**
 * `kuramoto db transfer`: SQLite(本部 hq.sqlite と各プロジェクトの project.sqlite)から、config.yaml の MySQL へ全部を移す(ADR-0038)。
 *
 * 流れ:
 *  1. config.yaml(と KURAMOTO_DATABASE_URL)の接続先を読む。MySQL でなければ止める。
 *     (loadStartupConfig は MySQL を起動の段階で止めるので、ここでは使わず loadConfig で読む)
 *  2. MySQL に繋いで最新の版まで流す(connectMysql が migrateMysql を流す)。届かなければ理由を出して止める。
 *  3. hq.sqlite と、本部に載っている各プロジェクトの project.sqlite を openDb で開く(最新の版まで流れる)。
 *     ファイルが無いときは、空の DB を作ってしまわないように、開く前に止める。
 *  4. transferSqliteToMysql で移す(全部が 1 つのトランザクション。失敗したら MySQL には何も残らない)。
 * 移し先にプロジェクトがすでに入っているときは、移さずに止める。SQLite のファイルは消さない(版が最新になるだけ)。
 */

export type TransferCommandOptions = {
  config: KuramotoConfig;
  home?: string;
  log?: (line: string) => void;
};

export async function runTransfer(opts: TransferCommandOptions): Promise<TransferResult> {
  const { config, home = kuramotoHome(), log = console.log } = opts;
  if (config.database.type !== "mysql") {
    throw new Error("移し先の MySQL が設定されていません。config.yaml の database を type: mysql にするか、KURAMOTO_DATABASE_URL に mysql:// の接続先を入れてください(docs/mysql.md)");
  }
  const hqPath = join(home, "hq.sqlite");
  if (!existsSync(hqPath)) throw new Error(`移し元の本部の DB がありません: ${hqPath}`);

  const { url, tls } = config.database;
  const { handle, version } = await connectMysql({ url, ...(tls ? { tls } : {}) });
  const conn = await handle.pool.promise().getConnection();
  log(`MySQL に繋ぎました(スキーマの版 ${version})`);
  const hq = openDb(hqPath, HQ_MIGRATIONS);
  try {
    return await transferSqliteToMysql(conn, hq, (p) => {
      const path = join(p.data_dir, "project.sqlite");
      if (!existsSync(path)) throw new Error(`プロジェクト ${p.id}(${p.name})の DB がありません: ${path}`);
      return openDb(path, PROJECT_MIGRATIONS, { projectId: p.id });
    });
  } finally {
    hq.close();
    conn.release();
    await handle.close();
  }
}

/** 結果の表示(プロジェクトごとのチケット数と、dev_done を埋めた件数) */
export function formatTransferResult(r: TransferResult): string[] {
  if (r.projects.length === 0) return ["移しました(プロジェクトは 0 件でした)"];
  return [
    `移しました(プロジェクト ${r.projects.length} 件)`,
    ...r.projects.map((p) => `  ${p.id}\t${p.name}\tチケット ${p.tickets} 件 / dev_done を埋めた ${p.devDone} 件`),
  ];
}

/** CLI の入口。設定を読み、移し、結果を出す。 */
export async function transferCommand(log: (line: string) => void = console.log, errLog: (line: string) => void = console.error): Promise<void> {
  const config = loadConfig();
  errLog(describeConfig(config));
  for (const line of formatTransferResult(await runTransfer({ config, log: errLog }))) log(line);
}
