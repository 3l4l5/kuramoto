import { z } from "zod";
import { ROLE_LABEL, WORK_ROLES, type WorkRole } from "./roles.js";

/**
 * チケットの種類ごとの流れ(R17)。
 * 流れは工程の並び。merge 待ちはいつも最後なので並びには入れない。
 * 並びに無い工程は省略(飛ばす)。開発は省けず、どの位置にも置ける。
 * 開発より前に置いたレビュー・セキュリティ・QA は、コードを見ずにチケットの中身を読んで申し送りを残すだけ。
 */

export const TICKET_KINDS = ["feature", "bugfix", "refactor", "docs"] as const;
export type TicketKind = (typeof TICKET_KINDS)[number];

export const KIND_LABEL: Record<TicketKind, string> = { feature: "機能", bugfix: "バグ修正", refactor: "リファクタ", docs: "ドキュメント" };

export function isTicketKind(s: unknown): s is TicketKind {
  return typeof s === "string" && (TICKET_KINDS as readonly string[]).includes(s);
}

export type Flow = WorkRole[];

/** 種類ごとの流れ。default は種類の流れが無いときの流れ。どれも無ければ DEFAULT_FLOW。 */
export type FlowsSpec = { default?: Flow } & Partial<Record<TicketKind, Flow>>;

/** どの流れも決めていないときの、今までと同じ流れ。 */
export const DEFAULT_FLOW: readonly WorkRole[] = WORK_ROLES;

/** 流れが決まりに反している理由。空なら保存できる。 */
export function flowErrors(flow: readonly string[]): string[] {
  const errors: string[] = [];
  if (flow.length === 0) return ["merge 待ちの前に工程がありません"];
  if (!flow.includes("dev")) errors.push("開発がありません(開発は省けません)");
  const seen = new Set<string>();
  for (const r of flow) {
    if (seen.has(r)) errors.push(`${ROLE_LABEL[r as WorkRole] ?? r}が 2 回あります(同じ工程は 1 回だけです)`);
    seen.add(r);
  }
  return errors;
}

export const flowSchema = z.array(z.enum(WORK_ROLES)).superRefine((flow, ctx) => {
  for (const message of flowErrors(flow)) ctx.addIssue({ code: "custom", message });
});

const flowKeys = ["default", ...TICKET_KINDS] as const;

export const flowsSchema = z
  .object(Object.fromEntries(flowKeys.map((k) => [k, flowSchema.optional()])) as Record<(typeof flowKeys)[number], z.ZodOptional<typeof flowSchema>>)
  .strict();

/** 種類ごとの流れの検証。どの流れが悪いかを、流れの名前つきで返す。 */
export function validateFlows(flows: unknown): string[] {
  const r = flowsSchema.safeParse(flows ?? {});
  if (r.success) return [];
  return [...new Set(r.error.issues.map((i) => {
    const key = i.path[0];
    const name = key === "default" ? "既定の流れ" : isTicketKind(key) ? `${KIND_LABEL[key]}の流れ` : "流れ";
    return `${name}: ${i.message}`;
  }))];
}

/** 保存してある流れ(JSON)を読む。壊れていても止めないよう、決まりに反する流れは捨てる。 */
export function parseFlows(json: string | null | undefined): FlowsSpec {
  let raw: unknown;
  try {
    raw = JSON.parse(json || "{}");
  } catch {
    return {};
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: FlowsSpec = {};
  for (const k of flowKeys) {
    const f = flowSchema.safeParse((raw as Record<string, unknown>)[k]);
    if (f.success) out[k] = f.data;
  }
  return out;
}

/** その種類の流れ。種類の流れが無ければ既定、既定も無ければ今までと同じ流れ。 */
export function flowFor(flows: FlowsSpec | undefined, kind?: string | null): Flow {
  const own = isTicketKind(kind) ? flows?.[kind] : undefined;
  return [...(own ?? flows?.default ?? DEFAULT_FLOW)];
}
