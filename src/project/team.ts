import { z } from "zod";
import { all } from "../db/sqlite.js";
import type { FormationSpec } from "../domain/formation.js";
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

export function teamView(p: Project) {
  const formations = all<{ id: number; version: number; pull: "down" | "start"; created_at: string }>(p.db, "SELECT * FROM formations ORDER BY version").map((f) => {
    const units = all<{ id: number; name: string; roles: string; max_members: number; summon_at: number; idle_sec: number; repos: string; model: string | null; effort: string | null; focus: string | null; budget_usd: number | null }>(p.db, "SELECT * FROM units WHERE formation_id = ? ORDER BY id", [f.id]).map((u) => ({
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
    return { id: f.id, version: f.version, pull: f.pull, createdAt: f.created_at, units };
  });
  const current = p.currentFormation();
  const policies = POLICY_ROLES.map((role) => {
    p.policy(role); // 後から足した役割は既定の方針を置く
    const versions = all<{ id: number; version: number; model: string; effort: string; focus: string; options: string; created_at: string }>(
      p.db,
      "SELECT * FROM policies WHERE role = ? ORDER BY version",
      [role],
    ).map((v) => ({ id: v.id, version: v.version, model: v.model, effort: v.effort, focus: v.focus, options: JSON.parse(v.options) as Record<string, unknown>, createdAt: v.created_at }));
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
