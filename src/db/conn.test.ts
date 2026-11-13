import { DatabaseSync } from "node:sqlite";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { Conn } from "./conn.js";
import { tx } from "./tx.js";

type T = { t: { v: string } };

function conn() {
  const raw = new DatabaseSync(":memory:");
  raw.exec("CREATE TABLE t (v TEXT NOT NULL)");
  const c = new Conn<T>(raw);
  const values = async () => (await c.k.selectFrom("t").select("v").orderBy("v").execute()).map((r) => r.v);
  const add = (v: string) => c.k.insertInto("t").values({ v }).execute();
  return { raw, c, values, add };
}

describe("Conn.transaction: 接続ごとの順番待ちと入れ子", () => {
  it("入れ子は外側にまとめる。内側が投げて外側が通すと、全部巻き戻る", async () => {
    const { c, values, add } = conn();
    await expect(
      c.transaction(async () => {
        await add("outer");
        await c.transaction(async () => {
          await add("inner");
          throw new Error("内側で失敗");
        });
      }),
    ).rejects.toThrow("内側で失敗");
    expect(await values()).toEqual([]);
    await c.transaction(async () => {
      await add("a");
      await c.transaction(async () => add("b"));
    });
    expect(await values()).toEqual(["a", "b"]);
  });

  it("同時に始めたトランザクションは順番待ちをする(一方の巻き戻しに、もう一方が巻き込まれない)", async () => {
    const { c, values, add } = conn();
    const first = c.transaction(async () => {
      await add("a");
      await sleep(10); // 待っている間に、もう一方が始まる
      throw new Error("失敗");
    });
    const second = c.transaction(async () => add("b"));
    await expect(first).rejects.toThrow("失敗");
    await second;
    expect(await values()).toEqual(["b"]);
  });

  it("トランザクションの外のクエリも、トランザクションが終わるまで待つ", async () => {
    const { c, values, add } = conn();
    const slow = c.transaction(async () => {
      await add("a");
      await sleep(10);
      throw new Error("失敗");
    });
    // 外から読む。巻き戻る前の "a" は見えない
    const seen = values();
    await expect(slow).rejects.toThrow();
    expect(await seen).toEqual([]);
  });

  it("同期の tx(): 非同期トランザクションの中からは外側に相乗りし、他の流れから await の最中に呼ぶと投げる", async () => {
    const { raw, c, values } = conn();
    const write = (v: string) => raw.prepare("INSERT INTO t (v) VALUES (?)").run(v);
    let foreign: unknown;
    await c.transaction(async () => {
      tx(raw, () => write("inside")); // 同じ流れ
      await sleep(1);
    });
    const open = c.transaction(async () => {
      await sleep(10);
    });
    await sleep(2);
    try {
      tx(raw, () => write("foreign"));
    } catch (e) {
      foreign = e;
    }
    await open;
    expect(String(foreign)).toMatch(/トランザクションの途中/);
    expect(await values()).toEqual(["inside"]);
    // 終わったあとは、同期の tx() が普通に使える
    tx(raw, () => write("after"));
    expect(await values()).toEqual(["after", "inside"]);
  });
});
