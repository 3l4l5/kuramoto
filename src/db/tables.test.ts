import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import ts from "typescript";
import { HQ_MIGRATIONS, PROJECT_MIGRATIONS } from "./schema.js";
import { all, get, openDb, type Db, type Migration } from "./sqlite.js";

/** tables.ts の中の型の書き方を読む(型の検査はしない。書いてある文字をそのまま見る) */
type Prop = { generated: boolean; nullable: boolean; literals: string[] | null; base: string };

const source = ts.createSourceFile(
  "tables.ts",
  readFileSync(fileURLToPath(new URL("./tables.ts", import.meta.url)), "utf8"),
  ts.ScriptTarget.ES2023,
  true,
);

function interfaces(): Map<string, ts.InterfaceDeclaration> {
  const m = new Map<string, ts.InterfaceDeclaration>();
  for (const st of source.statements) if (ts.isInterfaceDeclaration(st)) m.set(st.name.text, st);
  return m;
}

function parseProp(typeText: string): Prop {
  let t = typeText.replace(/\s+/g, "");
  const generated = /^Generated<.*>$/.test(t);
  if (generated) t = t.slice("Generated<".length, -1);
  const nullable = /\|null$/.test(t);
  if (nullable) t = t.slice(0, -"|null".length);
  const parts = t.split("|");
  const literals = parts.every((p) => /^"[^"]*"$/.test(p)) ? parts.map((p) => p.slice(1, -1)) : null;
  return { generated, nullable, literals, base: literals ? "string" : t };
}

/** Database の型(表の名前 → 行の型)から、表ごとの列を取り出す */
function declared(dbName: string): Map<string, Map<string, Prop>> {
  const ifs = interfaces();
  const root = ifs.get(dbName);
  if (!root) throw new Error(`${dbName} が tables.ts に無い`);
  const out = new Map<string, Map<string, Prop>>();
  for (const member of root.members) {
    if (!ts.isPropertySignature(member) || !member.type) throw new Error("Database の形が想定と違う");
    const table = member.name.getText(source);
    const rowName = member.type.getText(source);
    const row = ifs.get(rowName);
    if (!row) throw new Error(`${rowName} が tables.ts に無い`);
    const cols = new Map<string, Prop>();
    for (const p of row.members) {
      if (!ts.isPropertySignature(p) || !p.type) throw new Error(`${rowName} の形が想定と違う`);
      cols.set(p.name.getText(source), parseProp(p.type.getText(source)));
    }
    out.set(table, cols);
  }
  return out;
}

type Info = { name: string; type: string; notnull: number; dflt_value: string | null; pk: number };

function actualChecks(createSql: string, col: string): string[] | null {
  const m = createSql.match(new RegExp(`\\b${col}\\b[^,]*?CHECK \\(${col} IN \\(([^)]*)\\)\\)`));
  return m ? m[1]!.split(",").map((s) => s.trim().replace(/^'|'$/g, "")) : null;
}

function checkAgainst(dbName: string, migrations: Migration[]): void {
  const db: Db = openDb(":memory:", migrations);
  const want = declared(dbName);
  const tables = all<{ name: string; sql: string }>(db, "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'");
  expect([...want.keys()].sort()).toEqual(tables.map((t) => t.name).sort());
  for (const t of tables) {
    const cols = all<Info>(db, `PRAGMA table_info(${t.name})`);
    const got = want.get(t.name)!;
    expect([...got.keys()], `${t.name} の列(名前と並び順)`).toEqual(cols.map((c) => c.name));
    for (const c of cols) {
      const p = got.get(c.name)!;
      const where = `${t.name}.${c.name}`;
      const rowid = c.pk === 1 && /^INTEGER$/i.test(c.type) && cols.filter((x) => x.pk).length === 1;
      const expectBase = /INT|REAL/i.test(c.type) ? "number" : "string";
      expect(p.base, `${where} の型`).toBe(expectBase);
      expect(p.nullable, `${where} の null`).toBe(c.notnull === 0 && c.pk === 0);
      expect(p.generated, `${where} の Generated`).toBe(rowid || c.dflt_value !== null);
      expect(p.literals, `${where} の CHECK`).toEqual(actualChecks(t.sql, c.name));
    }
  }
  db.close();
}

describe("tables.ts は実際の表と合っている", () => {
  it("プロジェクト DB(全マイグレーションを流した結果)", () => checkAgainst("ProjectDatabase", PROJECT_MIGRATIONS));
  it("本部 DB", () => checkAgainst("HqDatabase", HQ_MIGRATIONS));

  it("食い違えば検出できる(列の型・null・Generated・CHECK)", () => {
    const db = openDb(":memory:", PROJECT_MIGRATIONS);
    expect(get<{ n: number }>(db, "SELECT COUNT(*) AS n FROM pragma_table_info('tickets') WHERE name = 'dev_done'")!.n).toBe(1);
    expect(parseProp("Generated<number>")).toMatchObject({ generated: true, nullable: false, base: "number" });
    expect(parseProp('"a" | "b" | null')).toMatchObject({ nullable: true, literals: ["a", "b"] });
    expect(parseProp("string | null")).toMatchObject({ nullable: true, literals: null, base: "string" });
    expect(actualChecks("x TEXT NOT NULL CHECK (x IN ('a','b'))", "x")).toEqual(["a", "b"]);
    expect(actualChecks("x TEXT NOT NULL", "x")).toBeNull();
    db.close();
  });
});
