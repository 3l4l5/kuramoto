import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { KuramotoConfig } from "../config.js";
import { connectTest, MYSQL_TEST_URL, resetDatabase } from "./mysql-test-support.js";
import { HQ_MIGRATIONS, PROJECT_MIGRATIONS } from "./schema.js";
import { openDb, run } from "./sqlite.js";
import { formatTransferResult, runTransfer } from "./transfer-cmd.js";

/** `kuramoto db transfer` の試験。SQLite の回でも流れる部分と、mysql-test の実機を使う部分に分ける。 */
const SQLITE_CONFIG: KuramotoConfig = { file: undefined, database: { type: "sqlite" }, databaseUrlFromEnv: false };
const MYSQL_CONFIG: KuramotoConfig = { file: undefined, database: { type: "mysql", url: MYSQL_TEST_URL }, databaseUrlFromEnv: false };

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "kuramoto-transfer-"));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

/** 本部と 1 つのプロジェクトを、home の下に作る。プロジェクトの DB は版 18(最新より古い)で止めておき、移す道具が最新まで流すことを確かめる。 */
function seed(opts: { projectFile?: boolean } = {}): void {
  const hq = openDb(join(home, "hq.sqlite"), HQ_MIGRATIONS);
  const dataDir = join(home, "acme", "shop");
  run(hq, "INSERT INTO projects (id, name, data_dir, status, created_at) VALUES (1, 'shop', ?, 'running', '')", [dataDir]);
  hq.close();
  if (opts.projectFile === false) return;
  mkdirSync(dataDir, { recursive: true });
  const p = openDb(join(dataDir, "project.sqlite"), PROJECT_MIGRATIONS.slice(0, 18));
  run(p, "INSERT INTO tickets (id, number, title, stage, created_at) VALUES (1, 1, 'a', 'done', '')");
  run(p, "INSERT INTO tickets (id, number, title, stage, created_at) VALUES (2, 2, 'b', 'dev', '')");
  p.close();
}

describe("結果の表示", () => {
  it("プロジェクトごとに、チケット数と dev_done を埋めた件数を出す", () => {
    const lines = formatTransferResult({ projects: [{ id: 1, name: "shop", tickets: 12, devDone: 5 }] });
    expect(lines[0]).toContain("1 件");
    expect(lines[1]).toContain("shop");
    expect(lines[1]).toContain("チケット 12 件");
    expect(lines[1]).toContain("dev_done を埋めた 5 件");
  });
  it("プロジェクトが無いときもそう出す", () => {
    expect(formatTransferResult({ projects: [] })[0]).toContain("0 件");
  });
});

describe("移す前の確かめ", () => {
  it("接続先が MySQL でないときは、何もせずに止める", async () => {
    seed();
    await expect(runTransfer({ config: SQLITE_CONFIG, home, log: () => {} })).rejects.toThrow(/MySQL が設定されていません/);
  });

  it("本部の DB が無いときは、空の DB を作らずに止める", async () => {
    await expect(runTransfer({ config: MYSQL_CONFIG, home, log: () => {} })).rejects.toThrow(/本部の DB がありません/);
    expect(spawnSync("test", ["-e", join(home, "hq.sqlite")]).status).not.toBe(0);
  });

  it("サブコマンドから呼べる(MySQL でない設定なら理由を出して 1 で終わる)", () => {
    const r = spawnSync(process.execPath, ["--import", "tsx", resolve(import.meta.dirname, "../cli.ts"), "db", "transfer"], {
      env: { ...process.env, KURAMOTO_HOME: home, KURAMOTO_DATABASE_URL: "" },
      encoding: "utf8",
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("MySQL が設定されていません");
  });
});

const admin = await connectTest();
afterAll(async () => {
  await admin?.end();
});

describe.skipIf(!admin)("kuramoto db transfer(mysql-test の実機)", () => {
  beforeEach(async () => {
    await resetDatabase(admin!);
  });

  it("最新の版まで流してから移し、プロジェクトごとの件数を返す", async () => {
    seed();
    const logs: string[] = [];
    const result = await runTransfer({ config: MYSQL_CONFIG, home, log: (l) => logs.push(l) });
    expect(result.projects).toEqual([expect.objectContaining({ id: 1, name: "shop", tickets: 2 })]);
    expect(logs.join("\n")).toContain("MySQL に繋ぎました");
    const [rows] = await admin!.query<any[]>("SELECT number, dev_done FROM tickets WHERE project_id = 1 ORDER BY number");
    expect(rows.map((r) => [Number(r.number), Number(r.dev_done)])).toEqual([[1, 1], [2, 0]]);
    const [projects] = await admin!.query<any[]>("SELECT name FROM projects");
    expect(projects.map((r) => r.name)).toEqual(["shop"]);
  });

  it("プロジェクトの DB が無いときは、何も入れずに止める(空の DB も作らない)", async () => {
    seed({ projectFile: false });
    await expect(runTransfer({ config: MYSQL_CONFIG, home, log: () => {} })).rejects.toThrow(/プロジェクト 1\(shop\)の DB がありません/);
    const [rows] = await admin!.query<any[]>("SELECT COUNT(*) AS n FROM projects");
    expect(Number(rows[0].n)).toBe(0);
  });

  it("2 回目は、すでにプロジェクトが入っているので止まる", async () => {
    seed();
    await runTransfer({ config: MYSQL_CONFIG, home, log: () => {} });
    await expect(runTransfer({ config: MYSQL_CONFIG, home, log: () => {} })).rejects.toThrow(/すでにプロジェクトが入っています/);
  });
});
