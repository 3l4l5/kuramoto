import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { currentWorkspaceId, Hq } from "./hq.js";
import { createTicket } from "./project/workflow.js";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

describe("本部", () => {
  it("プロジェクトを作ると、データは <home>/<owner>/<repo>/ に分かれて置かれる", async () => {
    const home = mkdtempSync(join(tmpdir(), "kuramoto-"));
    dirs.push(home);
    const hq = new Hq(home);
    const rec = await hq.createProject("acme ショップ", [
      { fullName: "acme/shop-api", role: "API" },
      { fullName: "acme/shop-web", role: "フロント" },
    ]);
    expect(rec.data_dir).toBe(join(home, "acme", "shop-api"));

    const p = await hq.openProject(rec.id);
    expect((await p.repos()).map((r) => r.full_name)).toEqual(["acme/shop-api", "acme/shop-web"]);
    await createTicket(p, { title: "x" });
    p.close();

    expect((await hq.ownerQueue())).toEqual([{ project: rec, decisions: 0, merges: 0 }]);
    await expect(hq.createProject("x", [{ fullName: "not a repo", role: "API" }])).rejects.toThrow(/owner\/repo/);
    hq.close();
  });
});

describe("本部のスコープ(ワークスペース)", () => {
  it("今のワークスペースは 1 つの関数で決まる(今は常に 1)。プロジェクトは workspace_id 付きで入る", async () => {
    expect(currentWorkspaceId()).toBe(1);
    const home = mkdtempSync(join(tmpdir(), "kuramoto-"));
    dirs.push(home);
    const hq = new Hq(home);
    const rec = await hq.createProject("a", [{ fullName: "acme/a", role: "API" }]);
    expect(hq.db.prepare("SELECT workspace_id FROM projects WHERE id = ?").get(rec.id)).toEqual({ workspace_id: 1 });
    hq.close();
  });

  it("ワークスペースの外のプロジェクトは、見えず・開けず・変えられない", async () => {
    const home = mkdtempSync(join(tmpdir(), "kuramoto-"));
    dirs.push(home);
    const hq = new Hq(home);
    const rec = await hq.createProject("a", [{ fullName: "acme/a", role: "API" }]);
    hq.db.exec("INSERT INTO workspaces (id, name) VALUES (2, 'other')");
    hq.db.prepare("UPDATE projects SET workspace_id = 2 WHERE id = ?").run(rec.id);
    await expect(hq.project(rec.id)).rejects.toThrow(/がありません/);
    await expect(hq.openProject(rec.id)).rejects.toThrow(/がありません/);
    expect(await hq.projects()).toEqual([]);
    await expect(hq.setStatus(rec.id, "running")).resolves.toBeUndefined();
    expect(hq.db.prepare("SELECT status FROM projects WHERE id = ?").get(rec.id)).toEqual({ status: "planning" }); // 外のプロジェクトの状態は変わらない
    const other = new Hq(home, undefined, 2);
    expect((await other.project(rec.id)).name).toBe("a");
    other.close();
    hq.close();
  });

  it("リポジトリは、プロジェクトの repos だけに書く(本部の repos には書かない)", async () => {
    const home = mkdtempSync(join(tmpdir(), "kuramoto-"));
    dirs.push(home);
    const hq = new Hq(home);
    const rec = await hq.createProject("a", [{ fullName: "acme/a", role: "API" }]);
    const p = await hq.openProject(rec.id);
    await hq.updateProject(p, rec.id, { name: "a", repos: [{ fullName: "acme/a", role: "API" }, { fullName: "acme/b", role: "フロント" }] });
    expect((await p.repos()).map((r) => r.full_name)).toEqual(["acme/a", "acme/b"]);
    expect(hq.db.prepare("SELECT COUNT(*) AS n FROM repos").get()).toEqual({ n: 0 });
    p.close();
    hq.close();
  });
});

describe("プロジェクトの編集", () => {
  it("名前とリポジトリ(足す・外す・役割を変える)を変えられる。PR のあるリポジトリは外さず、何も変えずに止める", async () => {
    const { run } = await import("./db/sqlite.js");
    const home = mkdtempSync(join(tmpdir(), "kuramoto-"));
    dirs.push(home);
    const hq = new Hq(home);
    const rec = await hq.createProject("お試し", [
      { fullName: "acme/web", role: "フロント" },
      { fullName: "acme/old", role: "その他" },
    ]);
    const p = await hq.openProject(rec.id);

    const after = await hq.updateProject(p, rec.id, {
      name: "お試し 2",
      repos: [
        { fullName: "acme/web", role: "API" },
        { fullName: "acme/new", role: "インフラ" },
      ],
    });
    expect(after.name).toBe("お試し 2");
    expect(after.data_dir).toBe(rec.data_dir); // 置き場所は変えない
    expect((await p.repos()).map((r) => [r.full_name, r.role])).toEqual([
      ["acme/web", "API"],
      ["acme/new", "インフラ"],
    ]);
    expect((await hq.ownerQueue())[0]!.project.name).toBe("お試し 2");

    // PR のあるリポジトリは外さない(何も変えずに止める)
    const t = await createTicket(p, { title: "x" });
    run(p.db, "INSERT INTO pull_requests (ticket_id, repo_id, number, head, project_id) VALUES (?, ?, 1, 'b', ?)", [t.id, (await p.repos())[1]!.id, rec.id]);
    await expect(hq.updateProject(p, rec.id, { name: "変える", repos: [{ fullName: "acme/web", role: "API" }] })).rejects.toThrow(/acme\/new には PR や作業の記録があるので外せません/);
    expect((await hq.project(rec.id)).name).toBe("お試し 2");
    expect(await p.repos()).toHaveLength(2);
    await expect(hq.updateProject(p, rec.id, { name: "x", repos: [{ fullName: "bad", role: "API" }] })).rejects.toThrow(/owner\/repo/);
    p.close();
    hq.close();
  });

  it("'.' や '..' だけの owner・repo は断る(置き場所が home の外や owner ディレクトリを指さない)", async () => {
    const home = mkdtempSync(join(tmpdir(), "kuramoto-"));
    dirs.push(home);
    const hq = new Hq(home);
    for (const bad of ["acme/.", "acme/..", "./acme", "../acme", "../..", "./.", ".././.."]) {
      await expect(hq.createProject("x", [{ fullName: bad, role: "API" }])).rejects.toThrow(/owner\/repo/);
    }
    expect(await hq.projects()).toEqual([]);

    // '.' を含んでいても、'.' や '..' だけでなければ通り、置き場所は home/<owner>/<repo> のまま
    const ok = await hq.createProject("ok", [{ fullName: "acme/.github", role: "API" }, { fullName: "a.b/c..d", role: "API" }]);
    expect(ok.data_dir).toBe(join(home, "acme", ".github"));

    // 更新でも同じ(2 つ目以降のリポジトリも含めて)
    const p = await hq.openProject(ok.id);
    for (const bad of ["acme/.", "acme/..", "./acme", "../.."]) {
      await expect(hq.updateProject(p, ok.id, { name: "ok", repos: [{ fullName: "acme/.github", role: "API" }, { fullName: bad, role: "API" }] })).rejects.toThrow(/owner\/repo/);
      await expect(p.addRepo(bad, "API")).rejects.toThrow(/owner\/repo/);
    }
    expect((await p.repos()).map((r) => r.full_name)).toEqual(["acme/.github", "a.b/c..d"]);
    p.close();
    hq.close();
  });
});
