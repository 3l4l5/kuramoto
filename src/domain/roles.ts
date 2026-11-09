/** 実装側の役割(編成で島に割り当てる)。並びが工程の順番になる(ADR-0007)。 */
export const WORK_ROLES = ["dev", "review", "sec", "qa"] as const;
export type WorkRole = (typeof WORK_ROLES)[number];

/** 島に属さない固定の役割。 */
export const FIXED_ROLES = ["lead", "architect", "planner", "designer"] as const;
export type FixedRole = (typeof FIXED_ROLES)[number];

export type Role = WorkRole | FixedRole;

export const ROLE_LABEL: Record<Role, string> = {
  dev: "開発",
  review: "レビュー",
  sec: "セキュリティ",
  qa: "QA",
  lead: "リーダー",
  architect: "アーキテクト",
  planner: "企画",
  designer: "デザイナー",
};

export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];

/** 100 万トークンあたりの価格(USD)。docs/design.md 7 章(2026-10-06 時点)。 */
export const MODELS = {
  "claude-fable-5-1": { label: "Fable 5.1", input: 10, output: 50 },
  "claude-opus-5-5": { label: "Opus 5.5", input: 4, output: 20 },
  "claude-sonnet-5-5": { label: "Sonnet 5.5", input: 2, output: 10 },
  "claude-haiku-5-5": { label: "Haiku 5.5", input: 0.1, output: 0.5 },
} as const;
export type ModelId = keyof typeof MODELS;

export function isModelId(s: string): s is ModelId {
  return s in MODELS;
}

export type PolicyDefaults = { model: ModelId; effort: Effort; focus: string; options: Record<string, unknown> };

/** 役割ごとの既定の方針(docs/design.md 4 章・7 章、ADR-0010)。 */
export const DEFAULT_POLICIES: Partial<Record<Role, PolicyDefaults>> = {
  dev: { model: "claude-opus-5-5", effort: "high", focus: "", options: { requireTests: true, smallPr: true } },
  review: { model: "claude-opus-5-5", effort: "high", focus: "", options: { strictness: "standard", escalateAfterRounds: 2 } },
  sec: { model: "claude-opus-5-5", effort: "high", focus: "", options: {} },
  qa: { model: "claude-sonnet-5-5", effort: "medium", focus: "", options: {} },
  lead: { model: "claude-opus-5-5", effort: "medium", focus: "", options: { askOwner: "medium" } },
  architect: { model: "claude-opus-5-5", effort: "xhigh", focus: "", options: { designRequired: "medium" } },
  planner: { model: "claude-opus-5-5", effort: "medium", focus: "", options: {} },
  designer: { model: "claude-opus-5-5", effort: "high", focus: "", options: {} },
};
