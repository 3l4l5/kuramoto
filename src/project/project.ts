import { iso, systemClock, type Clock } from "../clock.js";
import { sql } from "kysely";
import { openDb, type Db } from "../db/sqlite.js";
import { PROJECT_MIGRATIONS } from "../db/schema.js";
import { ProjectDb } from "../db/conn.js";
import type { MysqlHandle } from "../db/mysql.js";
import { isTicketKind, parseFlows, type FlowsSpec, type TicketKind } from "../domain/flow.js";
import { parseRoutes, normalizeRoutes, routesAmong, type RouteSpec } from "../domain/route.js";
import { covers, DEFAULT_FORMATION, validateFormation, type FormationSpec, type Pull, type UnitSpec } from "../domain/formation.js";
import { DEFAULT_POLICIES, type Effort, type Role, type WorkRole } from "../domain/roles.js";
import { isRepoFullName } from "../domain/repo-name.js";
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
  /** チケットの種類(R17)。種類ごとの流れで工程を進める */
  kind: TicketKind;
  /** 開発を一度でも通ったか。通ったら開発より前の工程には戻らない */
  dev_done: number;
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

export type FormationRow = { id: number; version: number; pull: Pull; units: UnitRow[]; flows: FlowsSpec; routes: RouteSpec[] };

/** 1 つのプロジェクトの DB(ADR-0004)。 */
/** 1 つのプロジェクトの DB(ADR-0004)。開くのは Project.open(seed と席埋めがあるので非同期)。 */
export class Project {
  private readonly sqlite: Db | undefined;
  /** スコープつきの口(このファイルのプロジェクトの project_id の行だけを見る・書く)。 */
  readonly pdb: ProjectDb;
  /** この MySQL が、このマシン(ループバック)で待ち受けているポート。閉じ込めの中から断るポートに入れる(ADR-0060)。SQLite・外の DB では無い */
  readonly mysqlLocalPort: number | undefined;

  /** 直接 new せず Project.open を使う(開いたあとの seed・席埋めが非同期のため)。 */
  private constructor(path: string, readonly clock: Clock, projectId?: number, mysql?: MysqlHandle) {
    if (mysql) {
      if (projectId === undefined) throw new Error("MySQL でプロジェクトを開くには、プロジェクトの id が要ります");
      this.pdb = new ProjectDb(mysql.kysely, projectId);
      this.mysqlLocalPort = mysql.localPort;
    } else {
      this.sqlite = openDb(path, PROJECT_MIGRATIONS, { projectId });
      this.pdb = new ProjectDb(this.sqlite, projectId ?? 0);
    }
  }

  /**
   * projectId: 本部でのこのプロジェクトの id。マイグレーションが各表の project_id を埋めるのに使う。渡されなければ 0。
   * mysql を渡すと path は使わず、その MySQL の上でこのプロジェクトの行(project_id)を開く(プールは持ち主が閉じる)。
   */
  static async open(path: string, clock: Clock = systemClock, projectId?: number, mysql?: MysqlHandle): Promise<Project> {
    const p = new Project(path, clock, projectId, mysql);
    await p.seed();
    await p.fillSeats();
    return p;
  }

  /** SQLite のプロジェクト DB(試験が直に見るため)。MySQL のときは使えない。 */
  get db(): Db {
    if (!this.sqlite) throw new Error("プロジェクトの DB は MySQL です(SQLite の接続はありません)");
    return this.sqlite;
  }

  close(): void {
    this.sqlite?.close();
  }

  now(): string {
    return iso(this.clock.now());
  }

  get projectId(): number {
    return this.pdb.projectId;
  }

  private async seed(): Promise<void> {
    await this.pdb.transaction(async () => {
      // 企画の最初の行は、編成の有無とは別に確かめる(MySQL で、これを入れる前に作ったプロジェクトも、開き直せば埋まる)
      await this.seedPlan();
      if (await this.pdb.from("formations").limit(1).executeTakeFirst()) return;
      await this.saveFormation(DEFAULT_FORMATION);
      for (const [role, p] of Object.entries(DEFAULT_POLICIES)) {
        await this.savePolicy(role as Role, p);
      }
      for (const m of FIXED_CAST) {
        await this.pdb.insert("members", { unit_id: null, name: m.name, look: m.role, is_base: 1, joined_at: this.now() }).execute();
      }
      // ノンストップで進めるため、チケット 1 枚の予算は無制限から始める(歯止めは全体の予算・島の予算で掛ける。ADR-0022)
      await this.setSetting("ticket_budget_usd", "unlimited");
      await this.setSetting("run_budget_usd", "2");
      await this.setSetting("max_attempts", "3");
      await this.setSetting("decision_timeout_sec", "3600");
    });
  }

  /**
   * 企画の最初の行(段階 5 つ・要件の版 1・開発ルールの版 1)。SQLite のプロジェクト DB は最初のマイグレーションが入れるが、
   * MySQL は 1 つの database に複数のプロジェクトが入り、マイグレーションはプロジェクトの行を作れないので、プロジェクトを開くときに入れる。
   * SQLite では入っているので何もしない。
   */
  private async seedPlan(): Promise<void> {
    if (await this.pdb.from("plan_stages").limit(1).executeTakeFirst()) return;
    for (const stage of ["req", "infra", "flow", "screen", "model"]) await this.pdb.insert("plan_stages", { stage, mode: "agree", version: 1 }).execute();
    await this.pdb.insert("requirements", { version: 1, created_at: "" }).execute();
    await this.pdb.insert("dev_rule_versions", { version: 1, rules: "[]", created_at: "" }).execute();
  }

  // ---- 設定 ----

  async setting(key: string): Promise<string | undefined> {
    return (await this.pdb.from("settings").where("key", "=", key).executeTakeFirst())?.value;
  }

  async settingNumber(key: string, fallback: number): Promise<number> {
    const v = Number(await this.setting(key));
    return Number.isFinite(v) ? v : fallback;
  }

  async setSetting(key: string, value: string): Promise<void> {
    // 版 22 で settings の主キーは (project_id, key)。project_id は pdb.insert が入れる
    await this.pdb.dialect.upsert(this.pdb.insert("settings", { key, value }), ["project_id", "key"], ["value"]).execute();
  }

  /**
   * 設定を、読んだ値(expected。まだ無ければ undefined)のままのときだけ value に書き換える(条件つき更新)。
   * 読んで・書くまでの間にほかの処理が書き換えていたら false を返し、何も書かない。同時に走る処理のうち 1 つだけが true を受ける(取り合いに使う)。
   * 前提: value は expected と違う値にする(MySQL は値が変わらない更新を 0 件と数える)。
   */
  async claimSetting(key: string, expected: string | undefined, value: string): Promise<boolean> {
    if (expected === undefined) {
      // まだ行が無い: 主キー(project_id, key)の衝突で、先に入れた 1 つだけが勝つ
      try {
        await this.pdb.insert("settings", { key, value }).execute();
        return true;
      } catch (e) {
        if ((await this.setting(key)) !== undefined) return false;
        throw e;
      }
    }
    const r = await this.pdb.update("settings", { value }).where("key", "=", key).where("value", "=", expected).executeTakeFirst();
    return Number(r.numUpdatedRows) === 1;
  }

  async addRepo(fullName: string, role: string): Promise<number> {
    if (!isRepoFullName(fullName)) throw new Error(`owner/repo の形ではありません: ${fullName}`);
    return this.pdb.dialect.insertedId(this.pdb.insert("repos", { full_name: fullName, role }));
  }

  async setRepoRole(fullName: string, role: string): Promise<void> {
    await this.pdb.update("repos", { role }).where("full_name", "=", fullName).execute();
  }

  /** リポジトリを外す。PR や作業場所がある・編成の島が受け持っているときは、記録が壊れるので外さない。 */
  async removeRepo(fullName: string): Promise<void> {
    await this.pdb.transaction(async () => {
      const r = await this.pdb.from("repos").where("full_name", "=", fullName).executeTakeFirst();
      if (!r) throw new Error(`${fullName} は登録されていません`);
      if ((await this.repos()).length <= 1) throw new Error("リポジトリは 1 つ以上必要です");
      const k = this.pdb.k;
      const prs = await k.selectFrom("pull_requests").select((eb) => eb.fn.countAll<number>().as("n")).where("project_id", "=", this.projectId).where("repo_id", "=", r.id).executeTakeFirst();
      const sess = await k.selectFrom("sessions").select((eb) => eb.fn.countAll<number>().as("n")).where("project_id", "=", this.projectId).where("repo_id", "=", r.id).executeTakeFirst();
      if (Number(prs?.n ?? 0) + Number(sess?.n ?? 0) > 0) throw new Error(`${fullName} には PR や作業の記録があるので外せません`);
      const unit = (await this.currentFormation()).units.find((u) => u.repos.includes(fullName));
      if (unit) throw new Error(`${fullName} は編成の「${unit.name}」が受け持っています。先に編成から外してください`);
      await this.pdb.deleteFrom("repos").where("id", "=", r.id).execute();
    });
  }

  async repos(): Promise<{ id: number; full_name: string; role: string }[]> {
    return this.pdb.k.selectFrom("repos").select(["id", "full_name", "role"]).where("project_id", "=", this.projectId).orderBy("id").execute();
  }

  // ---- 編成(版で管理。上書きしない) ----

  async saveFormation(spec: FormationSpec): Promise<FormationRow> {
    const errors = validateFormation(spec, (await this.repos()).map((r) => r.full_name));
    if (errors.length) throw new Error(`編成が正しくありません: ${errors.join(" / ")}`);
    return this.pdb.transaction(async () => {
      const prev = await this.currentFormationOrNull();
      const version = (prev?.version ?? 0) + 1;
      // 流れを渡さなければ前の版の流れを引き継ぐ(編成だけを変える保存で、種類ごとの流れが消えないように)
      const flows = spec.flows ?? prev?.flows ?? {};
      // 経路も同じ。渡さなければ前の版の経路を引き継ぎ、島が無くなったものは外す。渡したものはそのとおりに保存する(「連絡しない」は持たない)
      const routes = spec.routes ? normalizeRoutes(spec.routes) : routesAmong(prev?.routes ?? [], spec.units.map((u) => u.name));
      const fid = await this.pdb.dialect.insertedId(
        this.pdb.insert("formations", { version, pull: spec.pull, flows: JSON.stringify(flows), routes: JSON.stringify(routes), created_at: this.now() }),
      );
      for (const u of spec.units) await this.insertUnit(fid, u);
      await this.carryOverMembers(prev);
      await this.event(prev ? "owner" : "system", "formation_saved", null, { version });
      return this.currentFormation();
    });
  }

  private async insertUnit(fid: number, u: UnitSpec): Promise<void> {
    await this.pdb
      .insert("units", {
        formation_id: fid,
        name: u.name,
        roles: JSON.stringify(u.roles),
        max_members: u.maxMembers,
        summon_at: u.summonAt,
        idle_sec: u.idleSec,
        repos: JSON.stringify(u.repos ?? []),
        model: u.model || null,
        effort: u.effort || null,
        focus: u.focus?.trim() || null,
        budget_usd: u.budgetUsd ?? null,
      })
      .execute();
  }

  /**
   * 席替え(ADR-0007)。前の版のメンバーは、同じ役割を持ち、まだ席の空いている新しい島へ名前ごと移す。
   * 行き先が無い・あふれた人は帰る(セッションは残るので持ち主として呼び戻せる)。
   * そのあと、どの島も最大人数ぶんの席を埋める(メンバーは増えたり減ったりせず、ずっといる。ADR-0023)。
   */
  private async carryOverMembers(prev: FormationRow | null): Promise<void> {
    const next = await this.currentFormation();
    const placed = new Map<number, number>();
    if (prev) {
      for (const m of await this.activeMembers()) {
        if (m.unit_id === null) continue;
        const oldUnit = prev.units.find((u) => u.id === m.unit_id);
        // 同じ名前の島を先に、次に役割が重なって席の空いている島を探す
        const fits = (u: UnitRow) => (placed.get(u.id) ?? 0) < u.max_members;
        const target =
          next.units.find((u) => u.name === oldUnit?.name && fits(u) && oldUnit.roles.some((r) => u.roles.includes(r))) ??
          next.units.find((u) => fits(u) && oldUnit?.roles.some((r) => u.roles.includes(r)));
        const count = target ? (placed.get(target.id) ?? 0) : 0;
        if (target) {
          await this.pdb.update("members", { unit_id: target.id, is_base: 1 }).where("id", "=", m.id).execute();
          placed.set(target.id, count + 1);
        } else {
          await this.pdb.update("members", { left_at: this.now() }).where("id", "=", m.id).execute();
        }
      }
    }
    await this.fillSeats();
  }

  /**
   * どの島も、最大人数ぶんのメンバーが席にいるようにする(ADR-0023)。応援を呼んだり帰したりはしない。
   * 前にいた応援は、ずっといるメンバーとして扱う。足りない席は、前に帰ったメンバー(受け持ちのチケットがある人から)を呼び戻し、
   * それでも足りなければ新しいメンバーで埋める。最大人数を超えている島からは、作業中でない人を帰す。
   */
  async fillSeats(): Promise<void> {
    await this.pdb.transaction(async () => {
      const f = await this.currentFormationOrNull();
      if (!f) return;
      await this.pdb.update("members", { is_base: 1 }).where("unit_id", "is not", null).where("left_at", "is", null).where("is_base", "=", 0).execute();
      for (const u of f.units) {
        // 最大人数を超えていたら(前の版で呼び戻された人など)、作業中でない人から、後から来た順に帰す
        const seated = await this.membersOfUnit(u.id);
        const running = new Set((await this.pdb.from("runs").where("ended_at", "is", null).execute()).map((r) => r.member_id));
        const extra = seated
          .filter((m) => !running.has(m.id))
          .sort((a, b) => b.joined_at.localeCompare(a.joined_at) || b.id - a.id)
          .slice(0, Math.max(0, seated.length - u.max_members));
        for (const m of extra) {
          await this.pdb.update("members", { left_at: this.now() }).where("id", "=", m.id).execute();
          await this.event(m.name, "left", null, {});
        }
        let n = (await this.membersOfUnit(u.id)).length;
        while (n < u.max_members) {
          const back = await this.pdb.k
            .selectFrom("members as m")
            .select("m.id")
            .where("m.project_id", "=", this.projectId)
            .where("m.left_at", "is not", null)
            .where("m.look", "=", "default")
            .orderBy(sql`(SELECT COUNT(*) FROM tickets t WHERE t.project_id = ${this.projectId} AND t.owner_member_id = m.id AND t.stage NOT IN ('done','dropped')) DESC`)
            .orderBy("m.id")
            .limit(1)
            .executeTakeFirst();
          if (back) await this.pdb.update("members", { left_at: null, unit_id: u.id, is_base: 1, joined_at: this.now() }).where("id", "=", back.id).execute();
          else await this.addMember(u.id, true);
          n++;
        }
      }
    });
  }

  async currentFormationOrNull(): Promise<FormationRow | null> {
    const f = await this.pdb.from("formations").orderBy("version", "desc").limit(1).executeTakeFirst();
    if (!f) return null;
    const units = (await this.pdb.from("units").where("formation_id", "=", f.id).orderBy("id").execute()).map(
      (u) => ({ ...u, roles: JSON.parse(u.roles) as WorkRole[], repos: JSON.parse(u.repos) as string[] }) as unknown as UnitRow,
    );
    return { id: f.id, version: f.version, pull: f.pull as Pull, units, flows: parseFlows(f.flows), routes: parseRoutes(f.routes) };
  }

  async currentFormation(): Promise<FormationRow> {
    const f = await this.currentFormationOrNull();
    if (!f) throw new Error("編成がありません");
    return f;
  }

  /**
   * その役割を持ち、そのリポジトリを受け持つ島(ADR-0019)。同じ役割の島が複数あることもある。
   * 受け持つ島が無いとき(編成を変える前のチケットなど)は、役割だけで探す。
   */
  async unitsForRole(role: WorkRole, repo?: string): Promise<UnitRow[]> {
    const withRole = (await this.currentFormation()).units.filter((u) => u.roles.includes(role));
    if (!repo) return withRole;
    const covering = withRole.filter((u) => covers(u, repo));
    return covering.length ? covering : withRole;
  }

  /** メンバーが使うモデル・考える深さ。島に設定があればそれ、無ければ役割の方針。 */
  async modelFor(member: MemberRow, policy: PolicyRow): Promise<{ model: string; effort: Effort; from: "unit" | "policy"; unitFocus: string | null; unitName: string | null }> {
    const unit = member.unit_id === null ? undefined : (await this.currentFormation()).units.find((u) => u.id === member.unit_id);
    const extra = { unitFocus: unit?.focus ?? null, unitName: unit?.name ?? null };
    if (unit?.model || unit?.effort) return { model: unit.model ?? policy.model, effort: unit.effort ?? policy.effort, from: "unit", ...extra };
    return { model: policy.model, effort: policy.effort, from: "policy", ...extra };
  }

  // ---- チケットへの責任者のメモ ----

  /** kind: 'note'(責任者・リーダーのメモ)/ 'member'(メンバーと話して伝えたこと)。 */
  async addNote(ticketId: number, body: string, who = "owner", kind: "note" | "member" = "note"): Promise<void> {
    const text = body.trim();
    if (!text) throw new Error("メモがありません");
    await this.ticket(ticketId);
    await this.pdb.transaction(async () => {
      await this.pdb.insert("ticket_notes", { ticket_id: ticketId, who, body: text, at: this.now(), kind }).execute();
      await this.event(who, "note_added", ticketId, kind === "member" ? { kind } : {});
    });
  }

  /** 責任者・リーダー・メンバーとの会話のメモ。開発より前の申し送り(kind='handoff')は handoffs() で読む。 */
  async notes(ticketId: number): Promise<{ id: number; who: string; body: string; at: string; kind: string }[]> {
    return this.pdb.k
      .selectFrom("ticket_notes")
      .select(["id", "who", "body", "at", "kind"])
      .where("project_id", "=", this.projectId)
      .where("ticket_id", "=", ticketId)
      .where("kind", "<>", "handoff")
      .orderBy("id")
      .execute();
  }

  /** 開発より前の工程(R17)が残した申し送り。who は残した工程の役割。 */
  async addHandoff(ticketId: number, role: Role, body: string): Promise<void> {
    const text = body.trim();
    if (!text) throw new Error("申し送りがありません");
    await this.ticket(ticketId);
    await this.pdb.transaction(async () => {
      await this.pdb.insert("ticket_notes", { ticket_id: ticketId, who: role, body: text, at: this.now(), kind: "handoff" }).execute();
      await this.event(role, "handoff_left", ticketId, { role });
    });
  }

  async handoffs(ticketId: number): Promise<{ id: number; role: Role; body: string; at: string }[]> {
    const rows = await this.pdb.k
      .selectFrom("ticket_notes")
      .select(["id", "who", "body", "at"])
      .where("project_id", "=", this.projectId)
      .where("ticket_id", "=", ticketId)
      .where("kind", "=", "handoff")
      .orderBy("id")
      .execute();
    return rows.map((r) => ({ id: r.id, role: r.who as Role, body: r.body, at: r.at }));
  }

  async editTicket(ticketId: number, input: { title: string; body: string }): Promise<void> {
    if (!input.title.trim()) throw new Error("タイトルがありません");
    await this.pdb.transaction(async () => {
      await this.pdb.update("tickets", { title: input.title.trim(), body: input.body }).where("id", "=", ticketId).execute();
      await this.event("owner", "ticket_edited", ticketId, {});
    });
  }

  // ---- 方針(役割ごとに版で管理。ADR-0010) ----

  async savePolicy(role: Role, p: { model: string; effort: Effort; focus: string; options?: Record<string, unknown>; harness?: string }): Promise<PolicyRow> {
    await this.pdb.transaction(async () => {
      const prev = await this.policyOrNull(role);
      const version = (prev?.version ?? 0) + 1;
      await this.pdb
        .insert("policies", {
          role,
          version,
          model: p.model,
          effort: p.effort,
          focus: p.focus,
          options: JSON.stringify(p.options ?? {}),
          harness: p.harness ?? prev?.harness ?? "claude-agent-sdk",
          created_at: this.now(),
        })
        .execute();
    });
    return this.policy(role);
  }

  async policyOrNull(role: Role): Promise<PolicyRow | null> {
    return ((await this.pdb.from("policies").where("role", "=", role).orderBy("version", "desc").limit(1).executeTakeFirst()) as unknown as PolicyRow | undefined) ?? null;
  }

  async policy(role: Role): Promise<PolicyRow> {
    const p = await this.policyOrNull(role);
    if (p) return p;
    // 後から足した役割(企画・デザイナー)は、前からある DB では初めて使うときに既定の方針を置く。
    const d = DEFAULT_POLICIES[role];
    if (!d) throw new Error(`役割 ${role} の方針がありません`);
    return this.savePolicy(role, d);
  }

  async policyOption<T>(role: Role, key: string, fallback: T): Promise<T> {
    const p = await this.policyOrNull(role);
    if (!p) return fallback;
    const v = (JSON.parse(p.options) as Record<string, unknown>)[key];
    return (v ?? fallback) as T;
  }

  // ---- メンバー ----

  async activeMembers(): Promise<MemberRow[]> {
    return (await this.pdb.from("members").where("left_at", "is", null).orderBy("id").execute()) as unknown as MemberRow[];
  }

  async member(id: number): Promise<MemberRow> {
    const m = (await this.pdb.from("members").where("id", "=", id).executeTakeFirst()) as unknown as MemberRow | undefined;
    if (!m) throw new Error(`メンバー ${id} がいません`);
    return m;
  }

  async fixedMember(role: Role): Promise<MemberRow> {
    return this.pdb.transaction(async () => {
      const m = (await this.pdb.from("members").where("unit_id", "is", null).where("look", "=", role).where("left_at", "is", null).executeTakeFirst()) as unknown as MemberRow | undefined;
      if (m) return m;
      const def = FIXED_CAST.find((x) => x.role === role);
      if (!def) throw new Error(`役割 ${role} の固定メンバーがいません`);
      const id = await this.pdb.dialect.insertedId(this.pdb.insert("members", { unit_id: null, name: def.name, look: def.role, is_base: 1, joined_at: this.now() }));
      return this.member(id);
    });
  }

  async membersOfUnit(unitId: number): Promise<MemberRow[]> {
    return (await this.pdb.from("members").where("unit_id", "=", unitId).where("left_at", "is", null).orderBy("id").execute()) as unknown as MemberRow[];
  }

  async addMember(unitId: number, isBase: boolean): Promise<MemberRow> {
    return this.pdb.transaction(async () => {
      const used = new Set((await this.pdb.k.selectFrom("members").select("name").where("project_id", "=", this.projectId).execute()).map((r) => r.name));
      const name = MEMBER_POOL.find((n) => !used.has(n)) ?? `メンバー${used.size + 1}`;
      const id = await this.pdb.dialect.insertedId(this.pdb.insert("members", { unit_id: unitId, name, look: "default", is_base: isBase ? 1 : 0, joined_at: this.now() }));
      if (!isBase) await this.event(name, "summoned", null, { unit_id: unitId });
      return this.member(id);
    });
  }

  /** 去った応援を呼び戻す(持ち主として直しに来るとき。ADR-0005)。 */
  async recallMember(id: number, unitId: number): Promise<void> {
    await this.pdb.transaction(async () => {
      await this.pdb.update("members", { left_at: null, unit_id: unitId }).where("id", "=", id).execute();
      await this.event((await this.member(id)).name, "recalled", null, {});
    });
  }

  // ---- チケット ----

  async addTicket(t: { title: string; body?: string; kind?: TicketKind; devDone?: boolean; requirementItemId?: number; planRefs?: Record<string, unknown> }): Promise<TicketRow> {
    if (t.kind !== undefined && !isTicketKind(t.kind)) throw new Error(`知らないチケットの種類です: ${String(t.kind)}`);
    return this.pdb.transaction(async () => {
      const max = await this.pdb.k.selectFrom("tickets").select((eb) => eb.fn.max<number>("number").as("n")).where("project_id", "=", this.projectId).executeTakeFirst();
      const number = Number(max?.n ?? 0) + 1;
      const jiraPrefix = await this.setting("jira_key");
      const id = await this.pdb.dialect.insertedId(
        this.pdb.insert("tickets", {
          number,
          jira_key: jiraPrefix ? `${jiraPrefix}-${number}` : null,
          title: t.title,
          body: t.body ?? "",
          kind: t.kind ?? "feature",
          dev_done: t.devDone ? 1 : 0,
          stage: "dev",
          requirement_item_id: t.requirementItemId ?? null,
          plan_refs: JSON.stringify(t.planRefs ?? {}),
          created_at: this.now(),
        }),
      );
      await this.event("lead", "ticket_created", id, { number, title: t.title });
      return this.ticket(id);
    });
  }

  async ticket(id: number): Promise<TicketRow> {
    const t = (await this.pdb.from("tickets").where("id", "=", id).executeTakeFirst()) as unknown as TicketRow | undefined;
    if (!t) throw new Error(`チケット ${id} がありません`);
    return t;
  }

  async tickets(): Promise<TicketRow[]> {
    return (await this.pdb.from("tickets").orderBy("number").execute()) as unknown as TicketRow[];
  }

  async setStage(ticketId: number, stage: TicketStage): Promise<void> {
    // merge に入るとき、まだ done_at が無ければ入れる(あれば残す)
    const set: Record<string, unknown> = { stage };
    if (stage === "merge") set.done_at = sql`COALESCE(done_at, ${this.now()})`;
    await this.pdb.update("tickets", set).where("id", "=", ticketId).execute();
  }

  // ---- 出来事(追記だけ) ----

  async event(actor: string, type: string, ticketId: number | null, data: Record<string, unknown> = {}): Promise<void> {
    await this.pdb.insert("events", { at: this.now(), actor, type, ticket_id: ticketId, data: JSON.stringify(data) }).execute();
  }

  async events(limit = 50): Promise<{ id: number; at: string; actor: string; type: string; ticket_id: number | null; data: string }[]> {
    return this.pdb.from("events").orderBy("id", "desc").limit(limit).execute() as Promise<{ id: number; at: string; actor: string; type: string; ticket_id: number | null; data: string }[]>;
  }
}
