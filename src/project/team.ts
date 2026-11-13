import { z } from "zod";
import { inScope } from "../db/count.js";
import { flowsSchema, parseFlows } from "../domain/flow.js";
import type { FormationSpec } from "../domain/formation.js";
import { parseRoutes, routesSchema } from "../domain/route.js";
import { EFFORTS, MODELS, ROLE_LABEL, type Role, type WorkRole } from "../domain/roles.js";
import type { Project } from "./project.js";

/**
 * チームの編成と方針(ADR-0007・0010)。どう協業させるとうまくいくかを試すための入口なので、
 * 変えるたびに版を残し、版ごとの結果を並べて比べられるようにする。
 */

/** 方針を変えられる役割。オフィスの役割と、企画スタジオの担当。 */
export const POLICY_ROLES: Role[] = ["dev", "review", "sec", "qa", "lead", "planner", "designer", "architect"];

/** 役割ごとに変えられる細かい設定。無い役割は「重視すること」だけ。 */
const ROLE_OPTIONS: Partial<Record<Role, z.ZodType>> = {
  dev: z.object({ requireTests: z.boolean(), smallPr: z.boolean() }).strict(),
  review: z.object({ strictness: z.enum(["important", "standard", "detailed"]), escalateAfterRounds: z.number().int().min(1).max(5) }).strict(),
  lead: z.object({ askOwner: z.enum(["heavy", "medium", "all"]) }).strict(),
};

const policyInput = z.object({
  model: z.string().refine((m) => m in MODELS, "知らないモデルです"),
  effort: z.enum(EFFORTS),
  focus: z.string().max(4000),
  options: z.record(z.string(), z.unknown()).default({}),
});

export function savePolicyInput(p: Project, role: string, input: unknown) {
  if (!POLICY_ROLES.includes(role as Role)) throw new Error(`役割 ${role} の方針は変えられません`);
  const r = policyInput.safeParse(input);
  if (!r.success) throw new Error(`方針が正しくありません: ${r.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join(" / ")}`);
  const schema = ROLE_OPTIONS[role as Role];
  const options = schema ? schema.safeParse(r.data.options) : { success: Object.keys(r.data.options).length === 0, data: {} };
  if (!options.success) throw new Error(`${ROLE_LABEL[role as Role]}の設定が正しくありません`);
  const saved = p.savePolicy(role as Role, { model: r.data.model, effort: r.data.effort, focus: r.data.focus.trim(), options: options.data as Record<string, unknown> });
  p.event("owner", "policy_saved", null, { role, version: saved.version, model: saved.model, effort: saved.effort });
  return saved;
}

const formationInput = z.object({
  pull: z.enum(["down", "start"]),
  /** 種類ごとの流れ(R17)。省くと前の版の流れを引き継ぐ */
  flows: flowsSchema.optional(),
  /** 島どうしの連絡経路(R16)。省くと前の版の経路を引き継ぐ。「連絡しない」の組み合わせは持たない */
  routes: routesSchema.optional(),
  units: z.array(
    z.object({
      name: z.string().trim().min(1, "島の名前がありません"),
      roles: z.array(z.enum(["dev", "review", "sec", "qa"])),
      maxMembers: z.number().int(),
      summonAt: z.number().int(),
      idleSec: z.number().int().min(60).max(3600),
      repos: z.array(z.string()).optional(),
      model: z.string().nullable().optional(),
      effort: z.enum(EFFORTS).nullable().optional(),
      focus: z.string().max(4000).nullable().optional(),
      budgetUsd: z.number().nullable().optional(),
    }),
  ),
});

export function saveFormationInput(p: Project, input: unknown) {
  const r = formationInput.safeParse(input);
  if (!r.success) throw new Error(`編成が正しくありません: ${r.error.issues.map((i) => i.message).join(" / ")}`);
  return p.saveFormation(r.data as FormationSpec);
}

// ---- 画面に出す: 今の設定と、版の歴史 ----

export async function teamView(p: Project) {
  for (const role of POLICY_ROLES) p.policy(role); // 後から足した役割は既定の方針を置く(読む前に)
  const [formationRows, policyRows] = await Promise.all([inScope(p.pdb, "formations").orderBy("version").execute(), inScope(p.pdb, "policies").orderBy("version").execute()]);
  // 島は、版ごとに引かず 1 文でまとめて取る
  const unitRows = formationRows.length ? await inScope(p.pdb, "units").where("formation_id", "in", formationRows.map((f) => f.id)).orderBy("id").execute() : [];
  const formations = formationRows.map((f) => {
    const units = unitRows.filter((u) => u.formation_id === f.id).map((u) => ({
      name: u.name,
      roles: JSON.parse(u.roles) as WorkRole[],
      maxMembers: u.max_members,
      summonAt: u.summon_at,
      idleSec: u.idle_sec,
      repos: JSON.parse(u.repos ?? "[]") as string[],
      model: u.model,
      effort: u.effort as (typeof EFFORTS)[number] | null,
      focus: u.focus,
      budgetUsd: u.budget_usd,
    }));
    return { id: f.id, version: f.version, pull: f.pull as "down" | "start", flows: parseFlows(f.flows), routes: parseRoutes(f.routes), createdAt: f.created_at, units };
  });
  const current = p.currentFormation();
  const policies = POLICY_ROLES.map((role) => {
    const versions = policyRows
      .filter((v) => v.role === role)
      .map((v) => ({ id: v.id, version: v.version, model: v.model, effort: v.effort, focus: v.focus, options: JSON.parse(v.options) as Record<string, unknown>, createdAt: v.created_at }));
    return { role, label: ROLE_LABEL[role], versions };
  });
  return {
    repos: p.repos().map((r) => r.full_name),
    formation: {
      current: current.version,
      members: Object.fromEntries(current.units.map((u) => [u.name, p.membersOfUnit(u.id).map((m) => ({ name: m.name, helper: !m.is_base }))])),
      versions: formations,
    },
    policies,
  };
}
