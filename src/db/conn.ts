import { AsyncLocalStorage } from "node:async_hooks";
import type { DatabaseSync } from "node:sqlite";
import type { DeleteQueryBuilder, DeleteResult, InsertQueryBuilder, Kysely, KyselyPlugin, Selectable, SelectQueryBuilder, Transaction, UpdateQueryBuilder, UpdateResult } from "kysely";
import { projectIdGuardPlugins } from "./guard.js";
import { mysqlDialect, sqliteDialect, type DialectHelpers } from "./dialect/index.js";
import { createKysely } from "./kysely.js";
import { registerAsyncOwner } from "./tx.js";
import type { HqDatabase, ProjectDatabase } from "./tables.js";

/** 接続の元。SQLite は開いてある DatabaseSync、MySQL は mysql2 のプールの上の Kysely(mysql.ts の MysqlHandle.kysely)。 */
export type ConnSource<DB = any> = DatabaseSync | Kysely<DB>;

function isKysely(source: ConnSource): source is Kysely<any> {
  return !("exec" in source);
}

/**
 * 接続の上の Kysely と、非同期のトランザクションの口(ADR-0039)。
 *  - SQLite: 接続は 1 本。トランザクションの間はほかのクエリを待たせる(Kysely の接続が 1 本のため)。
 *  - MySQL: プールの上。transaction() はプールから専用の接続を 1 本取り、終わるまで持つ(ADR-0041)。
 *  - 入れ子は AsyncLocalStorage で外側にまとめる。transaction() の中で k を使うと、いまのトランザクションの上で動く。
 */
export class Conn<DB> {
  private readonly als = new AsyncLocalStorage<Transaction<DB>>();
  private readonly owner: { open: boolean } | undefined;
  private readonly base: Kysely<DB>;
  /** SQLite のときの接続。MySQL では無い。 */
  readonly raw: DatabaseSync | undefined;
  /** この接続の方言。クエリを書く側は、方言の名前を直接書かずここを通す。 */
  readonly dialect: DialectHelpers;

  constructor(source: ConnSource, plugins: KyselyPlugin[] = []) {
    if (isKysely(source)) {
      this.dialect = mysqlDialect;
      this.base = plugins.reduce<Kysely<any>>((k, plugin) => k.withPlugin(plugin), source) as Kysely<DB>;
    } else {
      this.raw = source;
      this.dialect = sqliteDialect;
      this.base = createKysely<DB>(source, plugins);
      this.owner = registerAsyncOwner(source, this.als as AsyncLocalStorage<unknown>);
    }
  }

  /** いまのトランザクションの中ならその上、そうでなければ接続の上の Kysely。クエリはここから作る。 */
  get k(): Kysely<DB> {
    return this.als.getStore() ?? this.base;
  }

  /** fn を 1 つのトランザクションで流す。すでに中なら外側にまとめる(投げたら全部巻き戻る)。 */
  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    if (this.als.getStore()) return fn();
    try {
      return await this.base.transaction().execute((trx) => {
        if (this.owner) this.owner.open = true;
        return this.als.run(trx, fn);
      });
    } finally {
      if (this.owner) this.owner.open = false;
    }
  }
}

/** 表の行を、スコープの列(project_id・workspace_id)で絞る・書くときに値を入れる口。 */
export class ScopedConn<DB, Col extends string> extends Conn<DB> {
  constructor(source: ConnSource, readonly scopeColumn: Col, readonly scopeId: number, plugins: KyselyPlugin[] = []) {
    super(source, plugins);
  }

  // 表の名前が総称(T)なので、Kysely の型は any で受け、返すときに型を付ける
  private get any(): any {
    return this.k;
  }

  /** 表の行のうち、スコープの中のものを選ぶ(全部の列)。 */
  from<T extends keyof DB & string>(table: T): SelectQueryBuilder<DB, T, Selectable<DB[T]>> {
    return this.any.selectFrom(table).selectAll().where(`${table}.${this.scopeColumn}`, "=", this.scopeId) as never;
  }

  /** スコープの値を入れて挿入する。 */
  insert<T extends keyof DB & string>(table: T, values: Record<string, unknown> | Record<string, unknown>[]): InsertQueryBuilder<DB, T, unknown> {
    const add = (v: Record<string, unknown>) => ({ ...v, [this.scopeColumn]: this.scopeId });
    return this.any.insertInto(table).values(Array.isArray(values) ? values.map(add) : add(values)) as never;
  }

  /** スコープの中の行だけを更新する。 */
  update<T extends keyof DB & string>(table: T, set: Record<string, unknown>): UpdateQueryBuilder<DB, T, T, UpdateResult> {
    return this.any.updateTable(table).set(set).where(`${table}.${this.scopeColumn}`, "=", this.scopeId) as never;
  }

  /** スコープの中の行だけを消す。 */
  deleteFrom<T extends keyof DB & string>(table: T): DeleteQueryBuilder<DB, T, DeleteResult> {
    return this.any.deleteFrom(table).where(`${table}.${this.scopeColumn}`, "=", this.scopeId) as never;
  }
}

/** プロジェクト DB の口。このファイルのプロジェクトの行(project_id)だけを見る・書く。 */
export class ProjectDb extends ScopedConn<ProjectDatabase, "project_id"> {
  constructor(source: ConnSource, projectId: number) {
    super(source, "project_id", projectId, projectIdGuardPlugins());
  }
  get projectId(): number {
    return this.scopeId;
  }
}

/** 本部 DB の口。いまのワークスペース(workspace_id)の行だけを見る・書く。 */
export class HqDb extends ScopedConn<HqDatabase, "workspace_id"> {
  constructor(source: ConnSource, workspaceId: number) {
    super(source, "workspace_id", workspaceId);
  }
  get workspaceId(): number {
    return this.scopeId;
  }
}
