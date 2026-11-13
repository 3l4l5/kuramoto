import { sqliteDialect } from "./sqlite.js";

export type { DialectHelpers } from "./types.js";
export { sqliteDialect };

/** いま使う方言。方言を増やすときは、ここで選ぶ。 */
export const dialect = sqliteDialect;
