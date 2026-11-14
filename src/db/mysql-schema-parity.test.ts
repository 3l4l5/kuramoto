import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { migrate } from "./migrate.js";
import { MYSQL_MIGRATIONS } from "./mysql-schema.js";
import { HQ_MIGRATIONS, PROJECT_MIGRATIONS } from "./schema.js";

/**
 * MySQL の表が、SQLite の表と同じ形(列・NOT NULL・既定値)であることを、MySQL に繋がずに確かめる。
 * 既定値が違うと、SQLite では通る INSERT(列を省く)が、MySQL では `Field '…' doesn't have a default value` で落ちる(#116)。
 * MySQL の列は、mysql-schema.ts の CREATE TABLE の文から読む(列の行は「名前 型 …」の形)。
 */
function mysqlColumns(): Map<string, Map<string, string>> {
  const tables = new Map<string, Map<string, string>>();
  for (const m of MYSQL_MIGRATIONS)
    for (const stmt of m.statements) {
      const name = /^CREATE TABLE IF NOT EXISTS `(\w+)`/.exec(stmt)?.[1];
      if (!name) continue;
      const cols = new Map<string, string>();
      for (const line of stmt.split("\n").slice(1)) {
        const def = line.trim().replace(/,$/, "");
        if (/^(UNIQUE|KEY|PRIMARY|FOREIGN|CONSTRAINT|\))/.test(def)) continue;
        const c = /^`?(\w+)`?\s+(.*)$/.exec(def);
        if (c) cols.set(c[1]!, c[2]!);
      }
      tables.set(name, cols);
    }
  return tables;
}

describe("MySQL の表は、SQLite の表と、列・NOT NULL・既定値が同じ", () => {
  const mysql = mysqlColumns();
  for (const [kind, migrations] of [["本部", HQ_MIGRATIONS], ["プロジェクト", PROJECT_MIGRATIONS]] as const) {
    it(`${kind}の表`, () => {
      const db = new DatabaseSync(":memory:");
      migrate(db, migrations, { projectId: 1 });
      const diffs: string[] = [];
      for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]) {
        const mine = mysql.get(name);
        if (!mine) continue; // マイグレーションの記録の表など、MySQL に無いもの(下の「表が足りている」で数える)
        for (const c of db.prepare(`PRAGMA table_info(${name})`).all() as { name: string; notnull: number; dflt_value: string | null; pk: number }[]) {
          if (c.name === "project_id") continue; // SQLite の既定値 0 は「どのプロジェクトでもない」印。MySQL は既定値なし(mysql-schema.ts の冒頭)
          const def = mine.get(c.name);
          if (def === undefined) diffs.push(`${name}.${c.name}: MySQL に無い`);
          else if ((c.dflt_value !== null) !== /\bDEFAULT\b/.test(def)) diffs.push(`${name}.${c.name}: 既定値が違う(SQLite ${c.dflt_value ?? "なし"} / MySQL ${def})`);
          else if (!c.pk && Boolean(c.notnull) !== /\bNOT NULL\b/.test(def)) diffs.push(`${name}.${c.name}: NOT NULL が違う(MySQL ${def})`);
        }
      }
      expect(diffs).toEqual([]);
      db.close();
    });
  }

  it("SQLite のプロジェクトの表は、全部 MySQL にもある", () => {
    const db = new DatabaseSync(":memory:");
    migrate(db, PROJECT_MIGRATIONS, { projectId: 1 });
    const names = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]).map((t) => t.name);
    expect(names.filter((n) => !mysql.has(n) && !n.startsWith("_"))).toEqual([]);
    db.close();
  });
});
