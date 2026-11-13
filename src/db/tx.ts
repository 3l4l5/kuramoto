import type { AsyncLocalStorage } from "node:async_hooks";
import type { DatabaseSync } from "node:sqlite";

/**
 * 非同期のトランザクション(conn.ts の Conn.transaction)を持っている接続の記録。
 * 同期の tx() が、他の流れの非同期トランザクションに黙って相乗りしてしまうのを防ぐために使う。
 */
type AsyncOwner = { als: AsyncLocalStorage<unknown>; open: boolean };
const asyncOwners = new WeakMap<DatabaseSync, AsyncOwner>();

export function registerAsyncOwner(db: DatabaseSync, als: AsyncLocalStorage<unknown>): AsyncOwner {
  const owner = { als, open: false };
  asyncOwners.set(db, owner);
  return owner;
}

/**
 * 書き込みのトランザクション(同期)。入れ子にしたときは外側にまとめる。
 * まだ非同期に移していない書き方のためのもの。移したものは Conn.transaction() を使う(トランザクションの口はそちらに寄せていく)。
 * 他の流れが開いている非同期トランザクションの最中に呼ばれたら、混ざらないよう投げる。
 * その非同期トランザクションの中(その流れ)から呼ぶのは、これまでどおり外側に相乗りする。
 */
export function tx<T>(db: DatabaseSync, fn: () => T): T {
  if (db.isTransaction) {
    const owner = asyncOwners.get(db);
    if (owner?.open && owner.als.getStore() === undefined) throw new Error("別の処理のトランザクションの途中なので、ここでは書き込めません(非同期のトランザクションを await している間に同期の tx() が呼ばれました)");
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
