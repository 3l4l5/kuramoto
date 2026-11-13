import { createServer, connect, type Server, type Socket } from "node:net";
import type { Connection } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { iso, type Clock } from "../clock.js";
import { claimNext, complete, fail, pendingCount, recoverStale, release, type InboxScope } from "../project/inbox.js";
import { ProjectDb } from "./conn.js";
import { mysqlDialect } from "./dialect/mysql.js";
import { connectMysql, type MysqlHandle } from "./mysql.js";
import { DbHealth, isConnectionError } from "./mysql-health.js";
import { connectTest, MYSQL_TEST_URL, resetDatabase } from "./mysql-test-support.js";

/**
 * MySQL のアダプタを、mysql-test(127.0.0.1:3307)の実機で確かめる試験。繋がらないときは飛ばす。
 * 受信箱(取り出し・完了・失敗・やり直し・取りこぼしの回復)を MySQL の上で流し、切断と再接続を確かめる。
 * (ディスパッチャとエージェントの起動は、まだ SQLite の Project の上でしか動かない。移し終えたら、ここに足す)
 */
const admin: Connection | undefined = await connectTest();
afterAll(async () => {
  await admin?.end();
});

const config = { url: MYSQL_TEST_URL };
let handle: MysqlHandle;
let pdb: ProjectDb;
let scope: InboxScope;
let projectId: number;
const clock: Clock = { now: () => new Date("2026-11-13T00:00:00Z") };

async function addMessage(kind: string, over: Record<string, unknown> = {}): Promise<number> {
  return mysqlDialect.insertedId(
    pdb.insert("messages", { ticket_id: null, to_role: "lead", kind, payload: "{}", available_at: "2026-11-12T00:00:00.000Z", created_at: "2026-11-12T00:00:00.000Z", ...over }) as never,
  );
}
const row = (id: number) => pdb.from("messages").where("id", "=", id).executeTakeFirstOrThrow();

describe.skipIf(!admin)("MySQL のアダプタ(mysql-test の実機)", () => {
  beforeAll(async () => {
    await resetDatabase(admin!);
    const started = await connectMysql(config);
    handle = started.handle;
    expect(started.firstConnection).toBe(true);
    expect(started.version).toBe(21);
    projectId = await mysqlDialect.insertedId(handle.kysely.insertInto("projects").values({ name: "p", data_dir: "/d", status: "planning", created_at: "2026-11-12", workspace_id: 1 }));
    pdb = new ProjectDb(handle.kysely, projectId);
    scope = { pdb, projectId, now: () => iso(clock.now()), clock, currentFormation: () => ({ pull: "down" }) as never, settingNumber: (_k: string, d: number) => d } as unknown as InboxScope;
  });
  afterAll(async () => {
    await handle?.close();
  });

  it("2 回目の接続は初めてではない(版も変わらない)", async () => {
    const again = await connectMysql(config);
    expect(again.firstConnection).toBe(false);
    expect(again.version).toBe(21);
    await again.handle.close();
  });

  it("挿入した id は insertId で返る。トランザクションは投げると全部巻き戻る", async () => {
    const id = await addMessage("chat");
    expect(id).toBeGreaterThan(0);
    await expect(
      pdb.transaction(async () => {
        await addMessage("chat");
        throw new Error("途中で失敗");
      }),
    ).rejects.toThrow("途中で失敗");
    expect((await pdb.from("messages").execute()).map((r) => r.id)).toEqual([id]);
    await pdb.update("messages", { status: "done" }).where("id", "=", id).execute();
  });

  it("受信箱の流れ: 取り出す → 失敗で間を空けて戻す → 取り直す → 完了。取りこぼしは起動時に戻る", async () => {
    const a = await addMessage("chat", { available_at: "2026-11-12T00:00:00.000Z" });
    const b = await addMessage("triage", { available_at: "2026-11-12T00:00:01.000Z" });
    expect(await pendingCount(scope, ["chat", "triage"])).toBe(2);

    // 並びは種類の順(chat → triage)。取り出すと claimed・試行 1・取り出した時刻が入る
    const first = await claimNext(scope);
    expect(first).toMatchObject({ id: a, status: "claimed", attempts: 1, claimed_at: "2026-11-13T00:00:00.000Z" });

    // 失敗: 再試行できる間は、間を空けて pending に戻す(今は取れない)
    expect(await fail(scope, first!, "一時的なエラー")).toBe(false);
    expect(await row(a)).toMatchObject({ status: "pending", claimed_at: null, last_error: "一時的なエラー" });
    const second = await claimNext(scope);
    expect(second).toMatchObject({ id: b, status: "claimed" });

    // 人手が足りなくて起動できなかった: 試行回数を戻して後で取り直す
    await release(scope, b, 60_000);
    expect(await row(b)).toMatchObject({ status: "pending", attempts: 0 });
    expect(await claimNext(scope)).toBeUndefined();

    // 待ち時間が過ぎたあとなら取れる。試行が上限に達した失敗は failed になる
    const later: InboxScope = { ...scope, now: () => "2026-11-14T00:00:00.000Z", clock: { now: () => new Date("2026-11-14T00:00:00Z") } };
    const again = await claimNext(later);
    expect(again).toMatchObject({ id: a, attempts: 2 });
    expect(await fail(later, { ...again!, attempts: 3 }, "もうだめ")).toBe(true);
    expect(await row(a)).toMatchObject({ status: "failed", last_error: "もうだめ" });

    const taken = await claimNext(later);
    expect(taken).toMatchObject({ id: b, status: "claimed" });
    await complete(later, b);
    expect(await row(b)).toMatchObject({ status: "done" });

    // 起動中に落ちたときの取りこぼし: claimed のままの仕事を pending に戻す
    const c = await addMessage("chat");
    await claimNext(later);
    expect(await recoverStale(scope)).toBe(1);
    expect(await row(c)).toMatchObject({ status: "pending", claimed_at: null });
    await complete(scope, c);
  });

  it("同時に取り出しても、同じ 1 通を 2 度取らない(SKIP LOCKED)", async () => {
    const ids = await Promise.all(Array.from({ length: 6 }, () => addMessage("chat")));
    const taken = await Promise.all(ids.map(() => claimNext(scope)));
    expect(taken.every(Boolean)).toBe(true);
    expect(new Set(taken.map((m) => m!.id)).size).toBe(6);
    expect(taken.every((m) => m!.attempts === 1)).toBe(true);
    expect(await claimNext(scope)).toBeUndefined();
    for (const id of ids) await complete(scope, id);
  });

  it("他のプロジェクトの仕事は取り出さない", async () => {
    const other = await mysqlDialect.insertedId(handle.kysely.insertInto("projects").values({ name: "q", data_dir: "/e", status: "planning", created_at: "2026-11-12", workspace_id: 1 }));
    const otherDb = new ProjectDb(handle.kysely, other);
    await mysqlDialect.insertedId(otherDb.insert("messages", { ticket_id: null, to_role: "lead", kind: "chat", payload: "{}", available_at: "2026-01-01", created_at: "" }) as never);
    expect(await claimNext(scope)).toBeUndefined();
    expect(await pendingCount({ ...scope, pdb: otherDb, projectId: other } as InboxScope, ["chat"])).toBe(1);
  });
});

/** 通り道に置く TCP の中継。cut() で全部の接続を切って受け付けをやめ、resume() で同じポートに戻す。 */
async function relay(targetHost: string, targetPort: number) {
  const sockets = new Set<Socket>();
  const server: Server = createServer((client) => {
    const up = connect(targetPort, targetHost);
    for (const s of [client, up]) {
      sockets.add(s);
      s.on("error", () => s.destroy());
      s.on("close", () => sockets.delete(s));
    }
    client.pipe(up);
    up.pipe(client);
  });
  const listen = (port: number) => new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
  await listen(0);
  const port = (server.address() as { port: number }).port;
  return {
    port,
    cut: async () => {
      for (const s of sockets) s.destroy();
      await new Promise<void>((r) => server.close(() => r()));
    },
    resume: () => listen(port),
    end: async () => {
      for (const s of sockets) s.destroy();
      if (server.listening) await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

const until = async (cond: () => boolean, ms = 8_000) => {
  for (const start = Date.now(); !cond(); ) {
    if (Date.now() - start > ms) throw new Error("待っても、そうなりませんでした");
    await new Promise((r) => setTimeout(r, 20));
  }
};

describe.skipIf(!admin)("切断と再接続(mysql-test の実機)", () => {
  it("切れると見張りが検知し、クエリは接続のエラーで落ちる。繋がり直したら戻り、同じプールでまた使える", async () => {
    const target = new URL(MYSQL_TEST_URL);
    const r = await relay(target.hostname, Number(target.port || 3306));
    const url = new URL(MYSQL_TEST_URL);
    url.port = String(r.port);
    const { handle: h } = await connectMysql({ url: url.toString() });
    const health = new DbHealth(() => h.ping(1_000), { intervalMs: 30 });
    const changes: boolean[] = [];
    health.onChange((s) => changes.push(s.up));
    health.start();
    try {
      await h.ping();
      expect(health.isUp()).toBe(true);

      await r.cut();
      await until(() => !health.isUp());
      const down = health.current();
      expect(down.up).toBe(false);
      // 切れている間のクエリは、接続のエラーで落ちる(見張りが「切れた」と受け取れる)
      const err = await h.ping(1_000).catch((e: unknown) => e);
      expect(isConnectionError(err)).toBe(true);

      await r.resume();
      await until(() => health.isUp());
      await h.ping();
      expect(changes).toEqual([false, true]);
      // 繋がり直したあとは、トランザクションも使える(専用の接続を新しく取れる)
      expect(await h.kysely.transaction().execute(async (trx) => (await trx.selectFrom("workspaces").select("id").execute()).length)).toBe(1);
    } finally {
      health.stop();
      await h.close();
      await r.end();
    }
  });
});
