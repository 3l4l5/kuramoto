import { flowFor, validateFlows, type FlowsSpec, type TicketKind } from "./flow.js";
import { EFFORTS, MODELS, ROLE_LABEL, WORK_ROLES, type Effort, type WorkRole } from "./roles.js";

export type Pull = "down" | "start";

export type UnitSpec = {
  name: string;
  roles: WorkRole[];
  maxMembers: number;
  /** 待ちがこの件数以上で応援を呼ぶ。 */
  summonAt: number;
  /** 手すきがこの秒数続くと応援は帰る。 */
  idleSec: number;
  /** 受け持つリポジトリ(owner/repo)。空ならすべて(ADR-0019)。 */
  repos?: string[];
  /** この島のメンバーが使うモデル・考える深さ。空なら役割の方針どおり。 */
  model?: string | null;
  effort?: Effort | null;
  /** この島で重視すること。役割の方針の「重視すること」に足して使う。 */
  focus?: string | null;
  /** この島で使ってよい金額(USD、これまでの合計)。null・省略は無制限。 */
  budgetUsd?: number | null;
};

/** flows: 種類ごとの流れ(R17)。省くと、前の版の流れを引き継ぐ。 */
export type FormationSpec = { pull: Pull; units: UnitSpec[]; flows?: FlowsSpec };

/** 島の数と、島ごとの最大人数の上限(ADR-0019)。 */
export const MAX_UNITS = 6;
export const MAX_MEMBERS_PER_UNIT = 10;

/** 既定の編成(docs/design.md 7 章): 開発 4 人 / レビュー 3 人、下流優先。 */
export const DEFAULT_FORMATION: FormationSpec = {
  pull: "down",
  units: [
    { name: "開発の島", roles: ["dev"], maxMembers: 4, summonAt: 2, idleSec: 300 },
    { name: "レビューの島", roles: ["review"], maxMembers: 3, summonAt: 2, idleSec: 300 },
  ],
};

/** 島がそのリポジトリを受け持つか。受け持つリポジトリを決めていない島は、すべてを受け持つ。 */
export function covers(u: Pick<UnitSpec, "repos">, repo: string): boolean {
  return !u.repos || u.repos.length === 0 || u.repos.includes(repo);
}

/**
 * 編成の決まり(docs/design.md 7 章、ADR-0007・0019)を確かめ、破っていればその理由を返す。
 * repos を渡すと、どのリポジトリも各工程の役割を持つ島に受け持たれているかまで確かめる。
 */
export function validateFormation(f: FormationSpec, repos?: string[]): string[] {
  const errors: string[] = [];
  if (f.units.length < 1 || f.units.length > MAX_UNITS) errors.push(`島の数は 1〜${MAX_UNITS} です`);
  const names = new Set<string>();
  for (const u of f.units) {
    if (names.has(u.name)) errors.push(`島の名前「${u.name}」が重なっています`);
    names.add(u.name);
    if (u.roles.length === 0) errors.push(`${u.name}: 役割がありません`);
    for (const r of u.roles) if (!WORK_ROLES.includes(r)) errors.push(`${u.name}: 知らない役割 ${r}`);
    if (u.summonAt < 1 || u.summonAt > 6) errors.push(`${u.name}: 応援を呼ぶ待ち件数は 1〜6 です`);
    if (u.maxMembers < 1 || u.maxMembers > MAX_MEMBERS_PER_UNIT) errors.push(`${u.name}: 最大人数は 1〜${MAX_MEMBERS_PER_UNIT} 人です`);
    // 自分の PR は自分で確かめないので、開発と確認を兼ねる島には 2 人以上が要る。
    if (u.roles.includes("dev") && u.roles.length > 1 && u.maxMembers < 2) errors.push(`${u.name}: 開発と確認を兼ねる島の最大人数は 2 以上です`);
    if (repos) for (const r of u.repos ?? []) if (!repos.includes(r)) errors.push(`${u.name}: 登録されていないリポジトリ ${r} を受け持っています`);
    if (u.model && !(u.model in MODELS)) errors.push(`${u.name}: 知らないモデル ${u.model}`);
    if (u.effort && !EFFORTS.includes(u.effort)) errors.push(`${u.name}: 知らない考える深さ ${u.effort}`);
    if (u.budgetUsd !== undefined && u.budgetUsd !== null && !(Number.isFinite(u.budgetUsd) && u.budgetUsd > 0)) errors.push(`${u.name}: 予算は 0 より大きい金額か、無制限にしてください`);
  }
  const pipeline = pipelineOf(f);
  if (!pipeline.includes("dev")) errors.push("開発の役割は必須です");
  // 流れが決まりに反していないか(開発が無い・merge 待ちの前に工程が無い・同じ工程が 2 回)。島が無い工程は飛ばすだけなので、ここでは確かめない
  errors.push(...validateFlows(f.flows));
  // 各工程は、どのリポジトリのチケットでも、受け持つ島がある
  if (repos) {
    for (const role of pipeline) {
      for (const repo of repos) {
        if (!f.units.some((u) => u.roles.includes(role) && covers(u, repo))) errors.push(`${repo} の${ROLE_LABEL[role]}を受け持つ島がありません`);
      }
    }
  }
  return [...new Set(errors)];
}

/**
 * 工程を組み立てる。チケットの種類の流れ(無ければ既定の流れ、それも無ければ 開発 → レビュー → セキュリティ → QA)から、
 * 誰も持っていない役割の工程(島が無い工程)を飛ばす。流れに無い工程は省略されている。
 * devDone: 開発を通ったチケット。開発より前の工程には戻らないので、開発より前を落とす。
 */
export function pipelineOf(f: { units: { roles: WorkRole[] }[]; flows?: FlowsSpec }, kind?: TicketKind | string | null, opts: { devDone?: boolean } = {}): WorkRole[] {
  const have = new Set(f.units.flatMap((u) => u.roles));
  const stages = [...new Set(flowFor(f.flows, kind))].filter((r) => have.has(r));
  const dev = stages.indexOf("dev");
  return opts.devDone && dev > 0 ? stages.slice(dev) : stages;
}

/** 開発より前の工程か(コードを見ずに申し送りだけを残す工程)。 */
export function isPreDev(pipeline: WorkRole[], stage: WorkRole): boolean {
  const i = pipeline.indexOf(stage);
  const dev = pipeline.indexOf("dev");
  return i >= 0 && dev >= 0 && i < dev;
}

/**
 * ある工程を通ったあとの行き先。最後の工程の次は merge 待ち。
 * preDev: 開発より前の工程として動いていた。流れが途中で変わって、今の流れでは開発より後ろにあっても、開発を飛ばさず開発へ行く。
 */
export function nextStage(pipeline: WorkRole[], from: WorkRole, opts: { preDev?: boolean } = {}): WorkRole | "merge" {
  const i = pipeline.indexOf(from);
  if (i < 0) throw new Error(`工程 ${from} は今の編成にありません`);
  if (opts.preDev && from !== "dev" && pipeline.indexOf("dev") >= 0 && pipeline.indexOf("dev") < i) return "dev";
  return pipeline[i + 1] ?? "merge";
}
