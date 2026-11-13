import type { KyselyPlugin, PluginTransformQueryArgs, PluginTransformResultArgs, QueryResult, RootOperationNode, UnknownRow } from "kysely";
import { PROJECT_ID_TABLES } from "./schema.js";

/**
 * プロジェクト DB の文に project_id が入っていないと投げる Kysely のプラグイン(テスト用の見張り)。
 * 別のプロジェクトの行を読む・書くのを、書き忘れの段階で落とすためのもの。
 *  - project_id の表を触る SELECT / UPDATE / DELETE は、どこかで project_id を参照していること(WHERE か結合)。
 *  - INSERT は、列に project_id が入っていること。
 * 木を歩いて「project_id という名前の識別子があるか」を見るだけなので、式の意味までは調べない。
 */
const PROJECT_TABLES: ReadonlySet<string> = new Set(PROJECT_ID_TABLES);

type Walk = { tables: Set<string>; hasProjectId: boolean };

function walk(node: unknown, out: Walk): void {
  if (Array.isArray(node)) {
    for (const n of node) walk(n, out);
    return;
  }
  if (node === null || typeof node !== "object") return;
  const o = node as Record<string, unknown>;
  if (o.kind === "TableNode") {
    const name = (o.table as { identifier?: { name?: string } } | undefined)?.identifier?.name;
    if (name) out.tables.add(name);
  }
  if (o.kind === "IdentifierNode" && o.name === "project_id") out.hasProjectId = true;
  for (const v of Object.values(o)) walk(v, out);
}

/** 文が project_id を含まないなら、その理由を返す。 */
export function projectIdViolation(node: RootOperationNode): string | undefined {
  if (node.kind === "RawNode") return "生 SQL は project_id の見張りを通せません(Kysely で書いてください)";
  const out: Walk = { tables: new Set(), hasProjectId: false };
  walk(node, out);
  const touched = [...out.tables].filter((t) => PROJECT_TABLES.has(t));
  if (touched.length === 0 || out.hasProjectId) return undefined;
  return `project_id を含まない文です(${node.kind}: ${touched.join(", ")})`;
}

export const requireProjectIdPlugin: KyselyPlugin = {
  transformQuery({ node }: PluginTransformQueryArgs): RootOperationNode {
    const why = projectIdViolation(node);
    if (why) throw new Error(why);
    return node;
  },
  async transformResult({ result }: PluginTransformResultArgs): Promise<QueryResult<UnknownRow>> {
    return result;
  },
};

let guardOn = false;

/** これ以降に作る ProjectDb に、見張りを付ける(テストの setup から呼ぶ)。 */
export function enableProjectIdGuard(on = true): void {
  guardOn = on;
}

export function projectIdGuardPlugins(): KyselyPlugin[] {
  return guardOn ? [requireProjectIdPlugin] : [];
}
