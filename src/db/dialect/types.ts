import type {
  ColumnDataType,
  ColumnDefinitionBuilder,
  CreateIndexBuilder,
  Expression,
  InsertQueryBuilder,
  Kysely,
  RawBuilder,
  SqlBool,
  SelectQueryBuilder,
} from "kysely";

/**
 * DB の方言ごとに書き方が変わるところを 1 か所に集める。
 * クエリを書く側は、方言の名前(json_extract・ON CONFLICT・RETURNING など)を直接書かず、ここを通す。
 * いまの実装は SQLite だけ(./sqlite.ts)。
 */
export interface DialectHelpers {
  readonly name: "sqlite";

  /** JSON を入れた列から値を取り出す。path は "baseCi" や "a.b" のようにドット区切り(先頭の $ は付けない)。 */
  jsonExtract<T = unknown>(column: Expression<unknown> | string, path: string): RawBuilder<T>;

  /** 衝突したとき、衝突の列を除く updateColumns を、挿入しようとした値で更新する(UPSERT)。 */
  upsert<DB, TB extends keyof DB, O>(
    query: InsertQueryBuilder<DB, TB, O>,
    conflictColumns: string[],
    updateColumns: string[],
  ): InsertQueryBuilder<DB, TB, O>;

  /** 挿入して、できた行の id を返す(id 列を持つ表向け)。 */
  insertedId(query: InsertQueryBuilder<any, any, any>): Promise<number>;

  /**
   * 受信箱から 1 通を取り出す。候補(id だけを選ぶ SELECT。並び順と LIMIT 1 を含む)の先頭を、
   * 他の取り出しと重ならないよう 1 文で pending → claimed にして、その行を返す。無ければ undefined。
   */
  claimMessage<DB extends { messages: unknown }>(
    db: Kysely<DB>,
    candidate: SelectQueryBuilder<any, any, { id: number }>,
    claimedAt: string,
  ): Promise<Record<string, unknown> | undefined>;

  /** 主キーの id 列(挿入のとき自動で採番される整数)。 */
  idColumn(column: ColumnDefinitionBuilder): ColumnDefinitionBuilder;

  /** 索引・UNIQUE に使える文字列の列の型。 */
  readonly indexableText: ColumnDataType;

  /** 部分索引(where に当てはまる行だけの索引)。where は SQL の式(sql`ended_at IS NULL` など)で渡す。 */
  createPartialIndex(
    db: Kysely<any>,
    spec: { name: string; table: string; columns: string[]; where: Expression<SqlBool>; unique?: boolean; ifNotExists?: boolean },
  ): CreateIndexBuilder<string>;
}
