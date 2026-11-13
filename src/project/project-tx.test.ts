import { describe, expect, it } from "vitest";
import { ManualClock } from "../clock.js";
import { send } from "./inbox.js";
import { Project } from "./project.js";

/** Project の書き込み(send・event・addNote など)は、呼び出し側のトランザクションに入る(#16 の「同期の書き込みが混ざる」の解消)。 */
describe("Project の書き込みは呼び出し側のトランザクションに入る", () => {
  it("tx の中の send・event・addTicket・addNote は、tx が投げたら全部巻き戻る", async () => {
    const p = await Project.open(":memory:", new ManualClock());
    await p.addRepo("acme/shop", "API");
    const events = (await p.events(1000)).length;
    await expect(
      p.pdb.transaction(async () => {
        const t = await p.addTicket({ title: "巻き戻る" });
        await send(p, { ticketId: t.id, toRole: "dev", kind: "implement" });
        await p.addNote(t.id, "メモ");
        await p.event("lead", "x", t.id, {});
        throw new Error("途中で失敗");
      }),
    ).rejects.toThrow("途中で失敗");
    expect(await p.tickets()).toEqual([]);
    expect((await p.events(1000)).length).toBe(events);
    expect(await p.pdb.from("messages").execute()).toEqual([]);
    expect(await p.pdb.from("ticket_notes").execute()).toEqual([]);
  });

  it("tx が成功すれば、send・event も一緒に残る", async () => {
    const p = await Project.open(":memory:", new ManualClock());
    await p.addRepo("acme/shop", "API");
    const t = await p.pdb.transaction(async () => {
      const t = await p.addTicket({ title: "残る" });
      await send(p, { ticketId: t.id, toRole: "dev", kind: "implement" });
      return t;
    });
    expect((await p.tickets()).map((x) => x.id)).toEqual([t.id]);
    expect(await p.pdb.from("messages").execute()).toHaveLength(1);
    expect((await p.events(1000)).some((e) => e.type === "ticket_created")).toBe(true);
  });

  it("MAX(number) を読んで書くチケット番号は、同時に作っても重ならない", async () => {
    const p = await Project.open(":memory:", new ManualClock());
    await p.addRepo("acme/shop", "API");
    const made = await Promise.all([1, 2, 3, 4].map((i) => p.addTicket({ title: `t${i}` })));
    expect(made.map((t) => t.number).sort()).toEqual([1, 2, 3, 4]);
  });
});
