import type { AsyncLocalStorage } from "node:async_hooks";
import type { DatabaseSync } from "node:sqlite";

/**
 * 非同期のトランザクション(conn.ts の Conn.transaction)を持っている接続の記録。
 * 同期の tx() が、他の流れの非同期トランザクションに黙って相乗りしてしまうのを防ぐために使う。
 */
type AsyncOwner = { als: AsyncLocalStorage<unknown>; open: boolean };
// 1 本の接続に Conn が複数かぶることがある(同じ接続に別のプロジェクトの口を置くとき)ので、配列で持つ
const asyncOwners = new WeakMap<DatabaseSync, AsyncOwner[]>();

export function registerAsyncOwner(db: DatabaseSync, als: AsyncLocalStorage<unknown>): AsyncOwner {
  const owner = { als, open: false };
  asyncOwners.set(db, [...(asyncOwners.get(db) ?? []), owner]);
  return owner;
}

/**
 * 他の流れが開いている非同期トランザクションの最中なら投げる(同期の書き込みが、そのトランザクションに黙って混ざるのを防ぐ)。
 * tx() と、トランザクションを張らない同期の書き込み(sqlite.ts の run)が使う。
 */
export function assertNotForeignAsyncTx(db: DatabaseSync, what: string): void {
  if (db.isTransaction && asyncOwners.get(db)?.some((o) => o.open && o.als.getStore() === undefined)) {
    throw new Error(`別の処理のトランザクションの途中なので、ここでは書き込めません(非同期のトランザクションを await している間に同期の ${what} が呼ばれました)`);
  }
}

/**
 * 書き込みのトランザクション(同期)。入れ子にしたときは外側にまとめる。
 * まだ非同期に移していない書き方のためのもの。移したものは Conn.transaction() を使う(トランザクションの口はそちらに寄せていく)。
 * 他の流れが開いている非同期トランザクションの最中に呼ばれたら、混ざらないよう投げる。
 * その非同期トランザクションの中(その流れ)から呼ぶのは、これまでどおり外側に相乗りする。
 */
export function tx<T>(db: DatabaseSync, fn: () => T): T {
  if (db.isTransaction) {
    assertNotForeignAsyncTx(db, "tx()");
    return fn();
  }
  db.exec("BEGIN IMMEDIATE");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
