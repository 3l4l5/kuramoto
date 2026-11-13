import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 検査: 本部・プロジェクトの層が DB へ触る道を、Kysely(と dialect)に寄せていく(ADR-0040)。
 *  - node:sqlite を直接 import しない(db/ の下だけ)。
 *  - 同期の all / get / run / tx(生 SQL)を import するのは、まだ移していないファイルだけ。移したらこの一覧から外す
 *    (一覧に残ったまま使っていないファイルは、このテストが落とす。一覧は増やさない)。
 *  - 方言に依る生 SQL(INSERT OR・ON CONFLICT・json_extract・datetime())は、移したファイルでは書かない。
 */
const ROOT = join(import.meta.dirname, "..");
const files = [join(ROOT, "hq.ts"), join(ROOT, "server.ts"), ...readdirSync(join(ROOT, "project")).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts")).map((f) => join(ROOT, "project", f))];

/** 同期の生 SQL をまだ使っているファイル(src からの相対)。移したら消す。移す単位は ADR-0040 の A〜D(別チケット)。D が済んだら空にする。 */
const NOT_MIGRATED = new Set([
  "server.ts",
  "project/budget.ts",
  "project/ci-tools.ts",
  "project/dev-rules.ts", // C2(#44 の後続): workflow・outage が async になってから移す(ADR-0040)
  "project/inbox.ts",
  "project/leadchat.ts", // C2(#44 の後続): workflow・outage が async になってから移す(ADR-0040)
  "project/member-chat.ts", // C2(#44 の後続): workflow・outage が async になってから移す(ADR-0040)
  "project/merge.ts",
  "project/outage.ts",
  "project/planning.ts", // C2(#44 の後続): workflow・outage が async になってから移す(ADR-0040)
  "project/project.ts",
  "project/prompts.ts", // C2(#44 の後続): workflow・outage が async になってから移す(ADR-0040)
  "project/questions.ts", // C2(#44 の後続): workflow・outage が async になってから移す(ADR-0040)
  "project/review.ts",
]);

const rel = (f: string) => f.slice(ROOT.length + 1);
const SYNC_IMPORT = /import \{[^}]*\b(all|get|run|tx)\b[^}]*\} from "(\.\.\/db|\.\/db)\/sqlite\.js"/;
const DIALECT_SQL = /INSERT OR |ON CONFLICT|json_extract|datetime\(|strftime\(|\bGLOB\b|AUTOINCREMENT/;

describe("DB への道の検査", () => {
  it("node:sqlite を直接 import しない", () => {
    expect(files.filter((f) => /from "node:sqlite"/.test(readFileSync(f, "utf8"))).map(rel)).toEqual([]);
  });

  it("同期の生 SQL を import するのは、一覧(まだ移していないファイル)だけ。移したものが一覧に残っていない", () => {
    const using = new Set(files.filter((f) => SYNC_IMPORT.test(readFileSync(f, "utf8"))).map(rel));
    expect([...using].filter((f) => !NOT_MIGRATED.has(f))).toEqual([]);
    expect([...NOT_MIGRATED].filter((f) => !using.has(f))).toEqual([]);
  });

  it("移したファイルに、方言に依る生 SQL が無い", () => {
    const bad = files.filter((f) => !NOT_MIGRATED.has(rel(f))).filter((f) => DIALECT_SQL.test(readFileSync(f, "utf8"))).map(rel);
    expect(bad).toEqual([]);
  });
});
