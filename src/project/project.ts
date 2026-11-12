import { iso, systemClock, type Clock } from "../clock.js";
import { all, get, openDb, run, tx, type Db } from "../db/sqlite.js";
import { PROJECT_MIGRATIONS } from "../db/schema.js";
import { covers, DEFAULT_FORMATION, validateFormation, type FormationSpec, type Pull, type UnitSpec } from "../domain/formation.js";
import { DEFAULT_POLICIES, type Effort, type Role, type WorkRole } from "../domain/roles.js";
import { FIXED_CAST, MEMBER_POOL } from "../domain/cast.js";

export type TicketStage = "dev" | "review" | "sec" | "qa" | "decision" | "merge" | "done" | "dropped";

export type TicketRow = {
  id: number;
  number: number;
  jira_key: string | null;
  title: string;
  body: string;
  stage: TicketStage;
  owner_member_id: number | null;
  rounds: number;
  plan_refs: string;
  created_at: string;
  done_at: string | null;
  active_ms: number;
  /** 取りやめたとき: 誰が(lead・owner)・なぜ・いつ */
  dropped_by?: string | null;
  dropped_reason?: string | null;
  dropped_at?: string | null;
};

export type MemberRow = {
  id: number;
  unit_id: number | null;
  name: string;
  look: string;
  is_base: number;
  joined_at: string;
  left_at: string | null;
};

export type PolicyRow = {
  id: number;
  role: Role;
  version: number;
  model: string;
  effort: Effort;
  focus: string;
  options: string;
  harness: string;
};

export type UnitRow = {
  id: number;
  formation_id: number;
  name: string;
  roles: WorkRole[];
  max_members: number;
  summon_at: number;
  /** 受け持つリポジトリ。空ならすべて */
  repos: string[];
  /** この島のモデル・考える深さ。null なら役割の方針どおり */
  model: string | null;
  effort: Effort | null;
  focus: string | null;
  idle_sec: number;
  /** この島の予算(USD)。null なら無制限 */
  budget_usd: number | null;
};

export type FormationRow = { id: number; version: number; pull: Pull; units: UnitRow[] };

/** 1 つのプロジェクトの DB(ADR-0004)。 */
export class Project {
  readonly db: Db;

  constructor(path: string, readonly clock: Clock = systemClock) {
    this.db = openDb(path, PROJECT_MIGRATIONS);
    this.seed();
    this.fillSeats();
  }

  close(): void {
    this.db.close();
  }

  now(): string {
    return iso(this.clock.now());
  }

  private seed(): void {
    if (get(this.db, "SELECT 1 AS x FROM formations LIMIT 1")) return;
    tx(this.db, () => {
      this.saveFormation(DEFAULT_FORMATION);
      for (const [role, p] of Object.entries(DEFAULT_POLICIES)) {
        this.savePolicy(role as Role, p);
      }
      for (const m of FIXED_CAST) {
        run(this.db, "INSERT INTO members (unit_id, name, look, is_base, joined_at) VALUES (NULL, ?, ?, 1, ?)", [m.name, m.role, this.now()]);
      }
      // ノンストップで進めるため、チケット 1 枚の予算は無制限から始める(歯止めは全体の予算・島の予算で掛ける。ADR-0022)
      this.setSetting("ticket_budget_usd", "unlimited");
      this.setSetting("run_budget_usd", "2");
      this.setSetting("max_attempts", "3");
      this.setSetting("decision_timeout_sec", "3600");
    });
  }

  // ---- 設定 ----

  setting(key: string): string | undefined {
    return get<{ value: string }>(this.db, "SELECT value FROM settings WHERE key = ?", [key])?.value;
  }

  settingNumber(key: string, fallback: number): number {
    const v = Number(this.setting(key));
    return Number.isFinite(v) ? v : fallback;
  }

  setSetting(key: string, value: string): void {
    run(this.db, "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [key, value]);
  }

  addRepo(fullName: string, role: string): number {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(fullName)) throw new Error(`owner/repo の形ではありません: ${fullName}`);
    return run(this.db, "INSERT INTO repos (full_name, role) VALUES (?, ?)", [fullName, role]).lastId;
  }

  setRepoRole(fullName: string, role: string): void {
    run(this.db, "UPDATE repos SET role = ? WHERE full_name = ?", [role, fullName]);
  }

  /** リポジトリを外す。PR や作業場所がある・編成の島が受け持っているときは、記録が壊れるので外さない。 */
  removeRepo(fullName: string): void {
    const r = get<{ id: number }>(this.db, "SELECT id FROM repos WHERE full_name = ?", [fullName]);
    if (!r) throw new Error(`${fullName} は登録されていません`);
    if (this.repos().length <= 1) throw new Error("リポジトリは 1 つ以上必要です");
    const used = (get<{ n: number }>(this.db, "SELECT (SELECT COUNT(*) FROM pull_requests WHERE repo_id = ?) + (SELECT COUNT(*) FROM sessions WHERE repo_id = ?) AS n", [r.id, r.id])?.n ?? 0) > 0;
    if (used) throw new Error(`${fullName} には PR や作業の記録があるので外せません`);
    const unit = this.currentFormation().units.find((u) => u.repos.includes(fullName));
    if (unit) throw new Error(`${fullName} は編成の「${unit.name}」が受け持っています。先に編成から外してください`);
    run(this.db, "DELETE FROM repos WHERE id = ?", [r.id]);
  }

  repos(): { id: number; full_name: string; role: string }[] {
    return all(this.db, "SELECT id, full_name, role FROM repos ORDER BY id");
  }

  // ---- 編成(版で管理。上書きしない) ----

  saveFormation(spec: FormationSpec): FormationRow {
    const errors = validateFormation(spec, this.repos().map((r) => r.full_name));
    if (errors.length) throw new Error(`編成が正しくありません: ${errors.join(" / ")}`);
    return tx(this.db, () => {
      const prev = this.currentFormationOrNull();
      const version = (prev?.version ?? 0) + 1;
      const fid = run(this.db, "INSERT INTO formations (version, pull, created_at) VALUES (?, ?, ?)", [version, spec.pull, this.now()]).lastId;
      for (const u of spec.units) this.insertUnit(fid, u);
      this.carryOverMembers(prev);
      this.event(prev ? "owner" : "system", "formation_saved", null, { version });
      return this.currentFormation();
    });
  }

  private insertUnit(fid: number, u: UnitSpec): void {
    run(this.db, "INSERT INTO units (formation_id, name, roles, max_members, summon_at, idle_sec, repos, model, effort, focus, budget_usd) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [
      fid,
      u.name,
      JSON.stringify(u.roles),
      u.maxMembers,
      u.summonAt,
      u.idleSec,
      JSON.stringify(u.repos ?? []),
      u.model || null,
      u.effort || null,
      u.focus?.trim() || null,
      u.budgetUsd ?? null,
    ]);
  }

  /**
   * 席替え(ADR-0007)。前の版のメンバーは、同じ役割を持ち、まだ席の空いている新しい島へ名前ごと移す。
   * 行き先が無い・あふれた人は帰る(セッションは残るので持ち主として呼び戻せる)。
   * そのあと、どの島も最大人数ぶんの席を埋める(メンバーは増えたり減ったりせず、ずっといる。ADR-0023)。
   */
  private carryOverMembers(prev: FormationRow | null): void {
    const next = this.currentFormation();
    const placed = new Map<number, number>();
    if (prev) {
      for (const m of this.activeMembers()) {
        if (m.unit_id === null) continue;
        const oldUnit = prev.units.find((u) => u.id === m.unit_id);
        // 同じ名前の島を先に、次に役割が重なって席の空いている島を探す
        const fits = (u: UnitRow) => (placed.get(u.id) ?? 0) < u.max_members;
        const target =
          next.units.find((u) => u.name === oldUnit?.name && fits(u) && oldUnit.roles.some((r) => u.roles.includes(r))) ??
          next.units.find((u) => fits(u) && oldUnit?.roles.some((r) => u.roles.includes(r)));
        const count = target ? (placed.get(target.id) ?? 0) : 0;
        if (target) {
          run(this.db, "UPDATE members SET unit_id = ?, is_base = 1 WHERE id = ?", [target.id, m.id]);
          placed.set(target.id, count + 1);
        } else {
          run(this.db, "UPDATE members SET left_at = ? WHERE id = ?", [this.now(), m.id]);
        }
      }
    }
    this.fillSeats();
  }

  /**
   * どの島も、最大人数ぶんのメンバーが席にいるようにする(ADR-0023)。応援を呼んだり帰したりはしない。
   * 前にいた応援は、ずっといるメンバーとして扱う。足りない席は、前に帰ったメンバー(受け持ちのチケットがある人から)を呼び戻し、
   * それでも足りなければ新しいメンバーで埋める。最大人数を超えている島からは、作業中でない人を帰す。
   */
  fillSeats(): void {
    const f = this.currentFormationOrNull();
    if (!f) return;
    tx(this.db, () => {
      run(this.db, "UPDATE members SET is_base = 1 WHERE unit_id IS NOT NULL AND left_at IS NULL AND is_base = 0");
      for (const u of f.units) {
        // 最大人数を超えていたら(前の版で呼び戻された人など)、作業中でない人から、後から来た順に帰す
        const seated = this.membersOfUnit(u.id);
        const running = new Set(all<{ member_id: number }>(this.db, "SELECT member_id FROM runs WHERE ended_at IS NULL").map((r) => r.member_id));
        const extra = seated
          .filter((m) => !running.has(m.id))
          .sort((a, b) => b.joined_at.localeCompare(a.joined_at) || b.id - a.id)
          .slice(0, Math.max(0, seated.length - u.max_members));
        for (const m of extra) {
          run(this.db, "UPDATE members SET left_at = ? WHERE id = ?", [this.now(), m.id]);
          this.event(m.name, "left", null, {});
        }
        let n = this.membersOfUnit(u.id).length;
        while (n < u.max_members) {
          const back = get<{ id: number }>(
            this.db,
            `SELECT m.id FROM members m WHERE m.left_at IS NOT NULL AND m.look = 'default'
             ORDER BY (SELECT COUNT(*) FROM tickets t WHERE t.owner_member_id = m.id AND t.stage NOT IN ('done','dropped')) DESC, m.id LIMIT 1`,
          );
          if (back) run(this.db, "UPDATE members SET left_at = NULL, unit_id = ?, is_base = 1, joined_at = ? WHERE id = ?", [u.id, this.now(), back.id]);
          else this.addMember(u.id, true);
          n++;
        }
      }
    });
  }

  currentFormationOrNull(): FormationRow | null {
    const f = get<{ id: number; version: number; pull: Pull }>(this.db, "SELECT id, version, pull FROM formations ORDER BY version DESC LIMIT 1");
    if (!f) return null;
    const units = all<Omit<UnitRow, "roles" | "repos"> & { roles: string; repos: string }>(this.db, "SELECT * FROM units WHERE formation_id = ? ORDER BY id", [f.id]).map(
      (u) => ({ ...u, roles: JSON.parse(u.roles) as WorkRole[], repos: JSON.parse(u.repos) as string[] }),
    );
    return { ...f, units };
  }

  currentFormation(): FormationRow {
    const f = this.currentFormationOrNull();
    if (!f) throw new Error("編成がありません");
    return f;
  }

  /**
   * その役割を持ち、そのリポジトリを受け持つ島(ADR-0019)。同じ役割の島が複数あることもある。
   * 受け持つ島が無いとき(編成を変える前のチケットなど)は、役割だけで探す。
   */
  unitsForRole(role: WorkRole, repo?: string): UnitRow[] {
    const withRole = this.currentFormation().units.filter((u) => u.roles.includes(role));
    if (!repo) return withRole;
    const covering = withRole.filter((u) => covers(u, repo));
    return covering.length ? covering : withRole;
  }

  /** メンバーが使うモデル・考える深さ。島に設定があればそれ、無ければ役割の方針。 */
  modelFor(member: MemberRow, policy: PolicyRow): { model: string; effort: Effort; from: "unit" | "policy"; unitFocus: string | null; unitName: string | null } {
    const unit = member.unit_id === null ? undefined : this.currentFormation().units.find((u) => u.id === member.unit_id);
    const extra = { unitFocus: unit?.focus ?? null, unitName: unit?.name ?? null };
    if (unit?.model || unit?.effort) return { model: unit.model ?? policy.model, effort: unit.effort ?? policy.effort, from: "unit", ...extra };
    return { model: policy.model, effort: policy.effort, from: "policy", ...extra };
  }

  // ---- チケットへの責任者のメモ ----

  addNote(ticketId: number, body: string, who = "owner"): void {
    const text = body.trim();
    if (!text) throw new Error("メモがありません");
    this.ticket(ticketId);
    run(this.db, "INSERT INTO ticket_notes (ticket_id, who, body, at) VALUES (?, ?, ?, ?)", [ticketId, who, text, this.now()]);
    this.event(who, "note_added", ticketId, {});
  }

  notes(ticketId: number): { id: number; who: string; body: string; at: string }[] {
    return all(this.db, "SELECT id, who, body, at FROM ticket_notes WHERE ticket_id = ? ORDER BY id", [ticketId]);
  }

  editTicket(ticketId: number, input: { title: string; body: string }): void {
    if (!input.title.trim()) throw new Error("タイトルがありません");
    run(this.db, "UPDATE tickets SET title = ?, body = ? WHERE id = ?", [input.title.trim(), input.body, ticketId]);
    this.event("owner", "ticket_edited", ticketId, {});
  }

  // ---- 方針(役割ごとに版で管理。ADR-0010) ----

  savePolicy(role: Role, p: { model: string; effort: Effort; focus: string; options?: Record<string, unknown>; harness?: string }): PolicyRow {
    const prev = this.policyOrNull(role);
    const version = (prev?.version ?? 0) + 1;
    run(
      this.db,
      "INSERT INTO policies (role, version, model, effort, focus, options, harness, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [role, version, p.model, p.effort, p.focus, JSON.stringify(p.options ?? {}), p.harness ?? prev?.harness ?? "claude-agent-sdk", this.now()],
    );
    return this.policy(role);
  }

  policyOrNull(role: Role): PolicyRow | null {
    return get<PolicyRow>(this.db, "SELECT * FROM policies WHERE role = ? ORDER BY version DESC LIMIT 1", [role]) ?? null;
  }

  policy(role: Role): PolicyRow {
    const p = this.policyOrNull(role);
    if (p) return p;
    // 後から足した役割(企画・デザイナー)は、前からある DB では初めて使うときに既定の方針を置く。
    const d = DEFAULT_POLICIES[role];
    if (!d) throw new Error(`役割 ${role} の方針がありません`);
    return this.savePolicy(role, d);
  }

  policyOption<T>(role: Role, key: string, fallback: T): T {
    const p = this.policyOrNull(role);
    if (!p) return fallback;
    const v = (JSON.parse(p.options) as Record<string, unknown>)[key];
    return (v ?? fallback) as T;
  }

  // ---- メンバー ----

  activeMembers(): MemberRow[] {
    return all(this.db, "SELECT * FROM members WHERE left_at IS NULL ORDER BY id");
  }

  member(id: number): MemberRow {
    const m = get<MemberRow>(this.db, "SELECT * FROM members WHERE id = ?", [id]);
    if (!m) throw new Error(`メンバー ${id} がいません`);
    return m;
  }

  fixedMember(role: Role): MemberRow {
    const m = get<MemberRow>(this.db, "SELECT * FROM members WHERE unit_id IS NULL AND look = ? AND left_at IS NULL", [role]);
    if (m) return m;
    const def = FIXED_CAST.find((x) => x.role === role);
    if (!def) throw new Error(`役割 ${role} の固定メンバーがいません`);
    const id = run(this.db, "INSERT INTO members (unit_id, name, look, is_base, joined_at) VALUES (NULL, ?, ?, 1, ?)", [def.name, def.role, this.now()]).lastId;
    return this.member(id);
  }

  membersOfUnit(unitId: number): MemberRow[] {
    return all(this.db, "SELECT * FROM members WHERE unit_id = ? AND left_at IS NULL ORDER BY id", [unitId]);
  }

  addMember(unitId: number, isBase: boolean): MemberRow {
    const used = new Set(all<{ name: string }>(this.db, "SELECT name FROM members").map((r) => r.name));
    const name = MEMBER_POOL.find((n) => !used.has(n)) ?? `メンバー${used.size + 1}`;
    const id = run(this.db, "INSERT INTO members (unit_id, name, look, is_base, joined_at) VALUES (?, ?, ?, ?, ?)", [
      unitId,
      name,
      "default",
      isBase ? 1 : 0,
      this.now(),
    ]).lastId;
    if (!isBase) this.event(name, "summoned", null, { unit_id: unitId });
    return this.member(id);
  }

  /** 去った応援を呼び戻す(持ち主として直しに来るとき。ADR-0005)。 */
  recallMember(id: number, unitId: number): void {
    run(this.db, "UPDATE members SET left_at = NULL, unit_id = ? WHERE id = ?", [unitId, id]);
    this.event(this.member(id).name, "recalled", null, {});
  }

  // ---- チケット ----

  addTicket(t: { title: string; body?: string; requirementItemId?: number; planRefs?: Record<string, unknown> }): TicketRow {
    return tx(this.db, () => {
      const number = (get<{ n: number | null }>(this.db, "SELECT MAX(number) AS n FROM tickets")?.n ?? 0) + 1;
      const jiraPrefix = this.setting("jira_key");
      const id = run(
        this.db,
        "INSERT INTO tickets (number, jira_key, title, body, stage, requirement_item_id, plan_refs, created_at) VALUES (?, ?, ?, ?, 'dev', ?, ?, ?)",
        [number, jiraPrefix ? `${jiraPrefix}-${number}` : null, t.title, t.body ?? "", t.requirementItemId ?? null, JSON.stringify(t.planRefs ?? {}), this.now()],
      ).lastId;
      this.event("lead", "ticket_created", id, { number, title: t.title });
      return this.ticket(id);
    });
  }

  ticket(id: number): TicketRow {
    const t = get<TicketRow>(this.db, "SELECT * FROM tickets WHERE id = ?", [id]);
    if (!t) throw new Error(`チケット ${id} がありません`);
    return t;
  }

  tickets(): TicketRow[] {
    return all(this.db, "SELECT * FROM tickets ORDER BY number");
  }

  setStage(ticketId: number, stage: TicketStage): void {
    run(this.db, "UPDATE tickets SET stage = ?, done_at = CASE WHEN ? = 'merge' AND done_at IS NULL THEN ? ELSE done_at END WHERE id = ?", [
      stage,
      stage,
      this.now(),
      ticketId,
    ]);
  }

  // ---- 出来事(追記だけ) ----

  event(actor: string, type: string, ticketId: number | null, data: Record<string, unknown> = {}): void {
    run(this.db, "INSERT INTO events (at, actor, type, ticket_id, data) VALUES (?, ?, ?, ?, ?)", [this.now(), actor, type, ticketId, JSON.stringify(data)]);
  }

  events(limit = 50): { id: number; at: string; actor: string; type: string; ticket_id: number | null; data: string }[] {
    return all(this.db, "SELECT * FROM events ORDER BY id DESC LIMIT ?", [limit]);
  }
}
