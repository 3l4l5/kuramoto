import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Hq } from "./hq.js";
import { createTicket } from "./project/workflow.js";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

describe("本部", () => {
  it("プロジェクトを作ると、データは <home>/<owner>/<repo>/ に分かれて置かれる", () => {
    const home = mkdtempSync(join(tmpdir(), "kuramoto-"));
    dirs.push(home);
    const hq = new Hq(home);
    const rec = hq.createProject("acme ショップ", [
      { fullName: "acme/shop-api", role: "API" },
      { fullName: "acme/shop-web", role: "フロント" },
    ]);
    expect(rec.data_dir).toBe(join(home, "acme", "shop-api"));

    const p = hq.openProject(rec.id);
    expect(p.repos().map((r) => r.full_name)).toEqual(["acme/shop-api", "acme/shop-web"]);
    createTicket(p, { title: "x" });
    p.close();

    expect(hq.ownerQueue()).toEqual([{ project: rec, decisions: 0, merges: 0 }]);
    expect(() => hq.createProject("x", [{ fullName: "not a repo", role: "API" }])).toThrow(/owner\/repo/);
    hq.close();
  });
});

describe("プロジェクトの編集", () => {
  it("名前とリポジトリ(足す・外す・役割を変える)を変えられる。PR のあるリポジトリは外さず、何も変えずに止める", async () => {
    const { run } = await import("./db/sqlite.js");
    const home = mkdtempSync(join(tmpdir(), "kuramoto-"));
    dirs.push(home);
    const hq = new Hq(home);
    const rec = hq.createProject("お試し", [
      { fullName: "acme/web", role: "フロント" },
      { fullName: "acme/old", role: "その他" },
    ]);
    const p = hq.openProject(rec.id);

    const after = hq.updateProject(p, rec.id, {
      name: "お試し 2",
      repos: [
        { fullName: "acme/web", role: "API" },
        { fullName: "acme/new", role: "インフラ" },
      ],
    });
    expect(after.name).toBe("お試し 2");
    expect(after.data_dir).toBe(rec.data_dir); // 置き場所は変えない
    expect(p.repos().map((r) => [r.full_name, r.role])).toEqual([
      ["acme/web", "API"],
      ["acme/new", "インフラ"],
    ]);
    expect(hq.ownerQueue()[0]!.project.name).toBe("お試し 2");

    // PR のあるリポジトリは外さない(何も変えずに止める)
    const t = createTicket(p, { title: "x" });
    run(p.db, "INSERT INTO pull_requests (ticket_id, repo_id, number, head) VALUES (?, ?, 1, 'b')", [t.id, p.repos()[1]!.id]);
    expect(() => hq.updateProject(p, rec.id, { name: "変える", repos: [{ fullName: "acme/web", role: "API" }] })).toThrow(/acme\/new には PR や作業の記録があるので外せません/);
    expect(hq.project(rec.id).name).toBe("お試し 2");
    expect(p.repos()).toHaveLength(2);
    expect(() => hq.updateProject(p, rec.id, { name: "x", repos: [{ fullName: "bad", role: "API" }] })).toThrow(/owner\/repo/);
    p.close();
    hq.close();
  });
});
