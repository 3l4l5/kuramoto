import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ManualClock } from "../clock.js";
import { complete, claimNext, fail, pendingCount, recoverStale, release, send } from "./inbox.js";
import { Project } from "./project.js";

const clock = () => new ManualClock();

describe("受信箱(Kysely・スコープつきの口)", () => {
  it("同時に取り出しても、同じ 1 通を二重に取らない(同じ接続でも、同じファイルを開いた別の接続でも)", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "kuramoto-inbox-")), "project.sqlite");
    const a = await Project.open(path, clock(), 7);
    const b = await Project.open(path, a.clock, 7);
    for (let i = 0; i < 6; i++) await send(a, { ticketId: null, toRole: "lead", kind: "chat", payload: { i } });
    const got = await Promise.all([...Array.from({ length: 5 }, () => claimNext(a)), ...Array.from({ length: 5 }, () => claimNext(b))]);
    const claimed = got.filter((m) => m !== undefined);
    expect(claimed).toHaveLength(6); // 6 通を 6 通とも取れて、残りの取り出しは空振り
    expect(new Set(claimed.map((m) => m!.id)).size).toBe(6);
    expect(claimed.every((m) => m!.status === "claimed" && m!.attempts === 1)).toBe(true);
    expect(await pendingCount(a, ["chat"])).toBe(0);
  });

  it("send は project_id を書き、取り出しは自分のプロジェクトの行だけを見る", async () => {
    const p = await Project.open(":memory:", clock(), 3);
    const id = await send(p, { ticketId: null, toRole: "lead", kind: "chat" });
    expect(await p.pdb.from("messages").where("id", "=", id).executeTakeFirstOrThrow()).toMatchObject({ project_id: 3 });
    // 別のプロジェクトの行は取らない
    await p.pdb.k.updateTable("messages").set({ project_id: 4 }).execute();
    expect(await claimNext(p)).toBeUndefined();
    expect(await pendingCount(p, ["chat"])).toBe(0);
  });

  it("complete / release / fail / recoverStale", async () => {
    const c = clock();
    const p = await Project.open(":memory:", c, 1);
    const status = async (id: number) => (await p.pdb.from("messages").where("id", "=", id).executeTakeFirstOrThrow()).status;
    const id = await send(p, { ticketId: null, toRole: "lead", kind: "chat" });
    const m = (await claimNext(p))!;
    expect(m.attempts).toBe(1);
    await release(p, id, 1000);
    expect(await status(id)).toBe("pending");
    expect(await claimNext(p)).toBeUndefined(); // 1 秒後まで取れない
    c.advance(2000);
    const again = (await claimNext(p))!;
    expect(again.attempts).toBe(1); // release が試行回数を戻した
    expect(await fail(p, again, "x")).toBe(false);
    expect(await status(id)).toBe("pending");
    expect(await fail(p, { ...again, attempts: 3 }, "x")).toBe(true);
    expect(await status(id)).toBe("failed");
    await complete(p, id);
    expect(await status(id)).toBe("done");
    await send(p, { ticketId: null, toRole: "lead", kind: "chat" });
    await claimNext(p);
    expect(await recoverStale(p)).toBe(1);
  });
});

describe("project_id の埋め直し", () => {
  it("開くとき、残っている 0 の行をそのファイルのプロジェクトの id で埋める(seed の行・同期の書き込みの行)", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "kuramoto-fill-")), "project.sqlite");
    const first = await Project.open(path, clock()); // id を渡さない → 0 のまま
    expect(first.db.prepare("SELECT COUNT(*) AS n FROM members WHERE project_id = 0").get()).not.toMatchObject({ n: 0 });
    first.close();
    const p = await Project.open(path, clock(), 5);
    expect(p.db.prepare("SELECT COUNT(*) AS n FROM members WHERE project_id <> 5").get()).toEqual({ n: 0 });
    expect(p.db.prepare("SELECT COUNT(*) AS n FROM settings WHERE project_id = 5").get()).not.toEqual({ n: 0 });
  });

  it("まだ同期の書き方で入る行(project_id を書かない INSERT)も、次に開くときに埋まる。ほかのプロジェクトの行は触らない", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "kuramoto-fill-")), "project.sqlite");
    const first = await Project.open(path, clock(), 5);
    // 同期の書き込み(版 21 のあとも、project_id を書かない)。DEFAULT 0 で入るが、この接続の間は、入れた行をすぐこのプロジェクトの id に直す(移した側が見失わないため)
    first.db.prepare("INSERT INTO lead_messages (who, body, at) VALUES ('owner', 'hi', '')").run();
    first.db.prepare("INSERT INTO lead_messages (who, body, at, project_id) VALUES ('owner', 'other', '', 9)").run();
    expect(first.db.prepare("SELECT COUNT(*) AS n FROM lead_messages WHERE project_id = 0").get()).toEqual({ n: 0 });
    expect(first.db.prepare("SELECT body FROM lead_messages WHERE project_id = 5").all()).toEqual([{ body: "hi" }]);
    first.close();
    const p = await Project.open(path, clock(), 5);
    expect(p.db.prepare("SELECT body FROM lead_messages WHERE project_id = 5").all()).toEqual([{ body: "hi" }]);
    expect(p.db.prepare("SELECT COUNT(*) AS n FROM lead_messages WHERE project_id = 0").get()).toEqual({ n: 0 });
    expect(p.db.prepare("SELECT COUNT(*) AS n FROM lead_messages WHERE project_id = 9").get()).toEqual({ n: 1 });
  });
});
