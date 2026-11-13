import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { isMap, LineCounter, parseDocument, type Document } from "yaml";
import { z } from "zod";
import { kuramotoHome } from "./hq.js";

/**
 * 起動の設定ファイル(~/.kuramoto/config.yaml)。サーバーと CLI が同じものを読む。
 * 読めない・書き方が違うときは、SQLite に黙って戻さず、どこがおかしいかを出して起動しない。
 */

export type DatabaseConfig =
  | { type: "sqlite" }
  | { type: "mysql"; url: string; tls?: { ca: string } };

export type KuramotoConfig = {
  /** 読んだ設定ファイルのパス。無かったときは undefined */
  file: string | undefined;
  database: DatabaseConfig;
  /** KURAMOTO_DATABASE_URL を使ったか */
  databaseUrlFromEnv: boolean;
};

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export const DATABASE_URL_ENV = "KURAMOTO_DATABASE_URL";

export function configPath(home: string = kuramotoHome()): string {
  return join(home, "config.yaml");
}

const mysqlUrl = z
  .string()
  .min(1, "接続先がありません")
  .refine((u) => isMysqlUrl(u), "mysql://ユーザー@ホスト/データベース名 の形で書いてください");

const fileSchema = z
  .object({
    database: z
      .object({
        type: z.enum(["sqlite", "mysql"], { error: (i) => `知らない type です: ${JSON.stringify(i.input)}(sqlite か mysql)` }).optional(),
        url: z.string().optional(),
        tls: z.object({ ca: z.string().min(1, "CA のファイルのパスがありません") }).strict().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

type FileConfig = z.infer<typeof fileSchema>;

/**
 * 設定を読む。ファイルが無ければ既定(SQLite)。env は KURAMOTO_DATABASE_URL を見るためだけに使う。
 * テストではファイルの中身(text)を直接渡す loadConfigText を使う。
 */
export function loadConfig(path: string = configPath(), env: NodeJS.ProcessEnv = process.env): KuramotoConfig {
  let text: string | undefined;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new ConfigError(`${path} を読めません: ${(e as Error).message}`);
    }
  }
  return loadConfigText(text, path, env);
}

/** 設定ファイルの中身から設定を組み立てる。text が undefined ならファイルが無いとみなす。 */
export function loadConfigText(text: string | undefined, path: string, env: NodeJS.ProcessEnv = {}): KuramotoConfig {
  const file = text === undefined ? {} : parseFile(text, path);
  const envUrl = env[DATABASE_URL_ENV]?.trim() || undefined;
  const db = file.database ?? {};
  const url = envUrl ?? db.url;
  // 環境変数で接続先が来たら、それが mysql:// なら MySQL を使う(type より優先)
  const type = envUrl ? (isMysqlUrl(envUrl) ? "mysql" : undefined) : (db.type ?? "sqlite");
  if (envUrl && !type) throw new ConfigError(`${DATABASE_URL_ENV} が mysql://ユーザー@ホスト/データベース名 の形ではありません`);
  const where = (key: string) => (envUrl && key === "url" ? DATABASE_URL_ENV : `${path} の database.${key}`);

  if (type === "sqlite") {
    if (db.url !== undefined) throw new ConfigError(`${where("url")}: SQLite では url は使いません(MySQL なら type: mysql にしてください)`);
    if (db.tls !== undefined) throw new ConfigError(`${where("tls")}: SQLite では tls は使いません`);
    return { file: text === undefined ? undefined : path, database: { type: "sqlite" }, databaseUrlFromEnv: false };
  }
  const checked = mysqlUrl.safeParse(url ?? "");
  if (!checked.success) {
    const msg = url === undefined ? `MySQL の接続先がありません(database.url か ${DATABASE_URL_ENV} に書いてください)` : checked.error.issues[0]!.message;
    throw new ConfigError(`${where("url")}: ${msg}`);
  }
  return {
    file: text === undefined ? undefined : path,
    database: { type: "mysql", url: checked.data, ...(db.tls ? { tls: { ca: db.tls.ca } } : {}) },
    databaseUrlFromEnv: Boolean(envUrl),
  };
}

function parseFile(text: string, path: string): FileConfig {
  const lines = new LineCounter();
  const doc = parseDocument(text, { lineCounter: lines, prettyErrors: false });
  if (doc.errors.length > 0) {
    const err = doc.errors[0]!;
    const line = lines.linePos(err.pos[0]).line;
    throw new ConfigError(`${path} の ${line} 行目: YAML として読めません(${err.message.split("\n")[0]})`);
  }
  const raw: unknown = doc.toJS() ?? {};
  const parsed = fileSchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0]!;
  const keys = issue.code === "unrecognized_keys" ? [...issue.path, issue.keys[0]!] : issue.path;
  const name = keys.length > 0 ? keys.join(".") : "(全体)";
  const line = lineOf(doc, lines, keys.map(String));
  const what = issue.code === "unrecognized_keys" ? "知らない項目です" : issue.message;
  throw new ConfigError(`${path}${line ? ` の ${line} 行目` : ""}(${name}): ${what}`);
}

/** 項目のパスから、その項目が書かれている行(1 始まり)を探す。見つからなければ一番近い親の行。 */
function lineOf(doc: Document, lines: LineCounter, keys: string[]): number | undefined {
  let node: unknown = doc.contents;
  let line: number | undefined;
  for (const key of keys) {
    if (!isMap(node)) break;
    const pair = node.items.find((p) => String((p.key as { value?: unknown } | null)?.value ?? p.key) === key);
    if (!pair) break;
    const range = (pair.key as { range?: [number, number, number] } | null)?.range;
    if (range) line = lines.linePos(range[0]).line;
    node = pair.value;
  }
  return line;
}

function isMysqlUrl(u: string): boolean {
  try {
    const url = new URL(u);
    return url.protocol === "mysql:" && url.hostname !== "" && url.pathname.replace(/^\//, "") !== "";
  } catch {
    return false;
  }
}

/** 起動時に出す 1 行。パスワードは出さない。 */
export function describeConfig(c: KuramotoConfig, home: string = kuramotoHome()): string {
  const src = c.file ? `設定 ${c.file}` : "設定ファイルなし(既定)";
  if (c.database.type === "sqlite") return `${src} / DB: SQLite(${home})`;
  const url = new URL(c.database.url);
  const host = url.port ? `${url.hostname}:${url.port}` : url.hostname;
  const name = decodeURIComponent(url.pathname.replace(/^\//, ""));
  const via = c.databaseUrlFromEnv ? `(${DATABASE_URL_ENV})` : "";
  const tls = c.database.tls ? " TLS あり" : "";
  return `${src} / DB: MySQL ${host} / ${name}${via}${tls}`;
}

/** 設定ファイルが本人以外にも読める(0600 でない)ときの注意。問題なければ undefined。 */
export function permissionWarning(path: string, mode: number | undefined): string | undefined {
  if (mode === undefined || (mode & 0o077) === 0) return undefined;
  return `注意: ${path} が本人以外にも読めます(${(mode & 0o777).toString(8)})。chmod 600 ${path} にしてください`;
}

/**
 * 起動時に設定を読み、1 行(と、必要なら注意を 1 行)出す。おかしければ ConfigError を投げる。
 * サーバーと CLI の入口から呼ぶ。
 */
export function loadStartupConfig(
  log: (line: string) => void = console.log,
  path: string = configPath(),
  env: NodeJS.ProcessEnv = process.env,
): KuramotoConfig {
  const c = loadConfig(path, env);
  log(describeConfig(c));
  if (c.file) {
    const warn = permissionWarning(c.file, statSync(c.file).mode);
    if (warn) log(warn);
  }
  if (c.database.type === "mysql") {
    // MySQL への接続はまだ作っていない。SQLite に黙って戻さず、起動しない
    throw new ConfigError("MySQL への接続はまだ使えません。database.type を sqlite にするか、設定を外してください");
  }
  return c;
}
