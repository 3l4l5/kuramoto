import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";

/** 合言葉を渡す環境変数。担当(エージェント)の環境からは名指しで隠す(confine.ts)。 */
export const ACCESS_TOKEN_ENV = "KURAMOTO_TOKEN";

/** 合言葉のファイル名(データの置き場所の下)。データの置き場所は担当のシェルから読めない(ADR-0020)。 */
export const ACCESS_TOKEN_FILE = "access-token";

/**
 * Kuramoto 本体の API と画面に入るための合言葉(ADR-0059)。
 * KURAMOTO_TOKEN があればそれ、なければ <データの置き場所>/access-token(既定 ~/.kuramoto/access-token)を読む。無ければ作って使い回す(本人だけが読める)。
 * ハーネスからも読むので、hq.ts には依存しない(置き場所は呼ぶ側が渡す)。
 */
export function accessToken(home: string, env: NodeJS.ProcessEnv = process.env): string {
  if (env[ACCESS_TOKEN_ENV]) return env[ACCESS_TOKEN_ENV];
  const file = join(home, ACCESS_TOKEN_FILE);
  if (existsSync(file)) {
    const t = readFileSync(file, "utf8").trim();
    if (t) return t;
  }
  mkdirSync(home, { recursive: true });
  const t = randomBytes(24).toString("base64url");
  writeFileSync(file, t + "\n", { mode: 0o600 });
  return t;
}
