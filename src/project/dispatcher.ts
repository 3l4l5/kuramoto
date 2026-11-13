import { FIXED_CAST, speechNote } from "../domain/cast.js";
import { mustAnswer, mustResolve } from "./review.js";
import { all, get, isUniqueViolation, run, tx } from "../db/sqlite.js";
import { WORK_ROLES, type Role, type WorkRole } from "../domain/roles.js";
import type { Harness, HarnessResult } from "../harness/types.js";
import { claimNext, complete, fail, pendingCount, release, send, type MessageKind, type MessageRow } from "./inbox.js";
import type { MemberRow, Project, TicketRow } from "./project.js";
import { PRE_DEV_NOTE, promptFor, systemPromptFor } from "./prompts.js";
import { toolsFor, type RunReport } from "./tools.js";
import { advance, applyReport, decision, expireDecisions, holdTicket, nonstop, raiseToOwner, resumeChecks, ticketBudgetUsd, ticketExhausted, ticketSpentUsd } from "./workflow.js";
import { leftUsd, projectExhausted, projectLeftUsd, unitExhausted, unitLeftUsd } from "./budget.js";
import { askLeadToUnstick, resetUnstick, unstickPrompt, unstickTools, type StuckPayload } from "./unstick.js";
import type { Workspace } from "./workspace.js";
import type { GitHub } from "../github/github.js";
import { ciTools } from "./ci-tools.js";
import { planWebNote, planWebTools } from "./web-access.js";
import { designFor, designPrompt, designSystemFiles, isDesignSystemTicket } from "./design.js";
import { compareScreenTools } from "./design-tools.js";
import { referenceImage, type DesignStore, type Renderer } from "./design-visual.js";
import { designSystem } from "./planning.js";
import { canResume, noteSession } from "./sessions.js";
import { runTeamCi, teamCiEnabled, type CommandRunner } from "./team-ci.js";
import { confinementFor } from "./confine.js";
import { afterPlanningRun, planningPrompt, planningSystemPrompt, planningTools, type PlanPayload } from "./planning-agent.js";
import { checkStudioLoop, onlyQuestions, say, studioPaused } from "./planning.js";
import { progressRecorder } from "./progress.js";
import { giveUpTriage, markTriaged, requestTriage, triagePrompt, triageTools, untriaged } from "./triage.js";
import { LEAD_CHAT_SYSTEM, leadChatPrompt, leadChatTools, leadReply, markOwnerMessagesRead, unreadOwnerMessages } from "./leadchat.js";
import { dropGithubCiTickets, githubCheckDue, githubDown, githubStillDown, isGithubAuthError, markGithubDown, markGithubUp } from "./outage.js";
import { finishPatrol, loopSignals, patrolPrompt, patrolTools, requestPatrol, type LoopSignal } from "./patrol.js";

export type DispatcherDeps = {
  harnesses: Record<string, Harness>;
  workspace: Workspace;
  /** false のあいだはチケットの仕事を取らない(企画スタジオの担当だけ動く)。省略時は常に取る。 */
  ticketsAllowed?: () => boolean;
  /** リーダーの交通整理を使うか。使うと、新しいチケットは交通整理が済むまで、また先に終わらせるチケットが merge されるまで着手しない。 */
  triage?: boolean;
  /** 仕事が動いている間に受信箱を見直す間隔(ミリ秒)。既定は 5 秒。 */
  recheckMs?: number;
  /** CI を調べる道具に使う(エージェントの代わりに Kuramoto が GitHub を見る。ADR-0027)。 */
  github?: GitHub;
  /** チームの CI(ADR-0028)のコマンドを閉じ込めの中で流す。無ければチームの CI は流さない。 */
  checkRunner?: CommandRunner;
  /** 画面の画像(お手本・実装・違い)の置き場所と、試作を画像にする描き手(ADR-0034)。無ければ画像では見比べない。 */
  designStore?: DesignStore;
  renderer?: Renderer;
};

type Job = { msg: MessageRow; member: MemberRow; role: Role; ticket: TicketRow | null };

/** 人手が空くのを待つときの間隔。 */
const WAIT_MS = 5_000;

const KINDS_OF: Record<WorkRole, MessageKind[]> = {
  dev: ["implement", "fix", "answer"],
  review: ["review"],
  sec: ["sec"],
  qa: ["qa"],
};

/**
 * ディスパッチャ(ADR-0002)。受信箱から 1 通取り出し、宛先のエージェントを 1 回だけ起こす。LLM は使わない。
 */
export class Dispatcher {
  constructor(
    private readonly p: Project,
    private readonly deps: DispatcherDeps,
  ) {}

  /** 期限切れの判断を片付け、島の席を最大人数ぶん埋めておく(メンバーはずっといる。ADR-0023)。 */
  housekeep(): void {
    expireDecisions(this.p);
    // 企画スタジオが同じところを回っていたら止める
    if (checkStudioLoop(this.p)) this.stopPlanning();
    // チームの CI を使うなら、GitHub Actions の CI のためのチケットは片付ける(ADR-0028)
    if (teamCiEnabled(this.p)) dropGithubCiTickets(this.p);
    // 始業中なら、新しいチケットの交通整理をリーダーに頼む
    if (this.deps.triage && (this.deps.ticketsAllowed?.() ?? true)) {
      requestTriage(this.p);
      // 間隔ごとにボードを見回り、重複と回り続けているチケットに手を打つ(ADR-0026)
      requestPatrol(this.p);
    }
    this.p.fillSeats();
  }

  /** 次の 1 件を取り出して担当を決める。起こせるものが無ければ null。 */
  next(): Job | null {
    // 全体の予算を使い切ったら、何も起こさない(責任者が予算を足すか無制限にするまで)
    if (projectExhausted(this.p)) return null;
    const released: number[] = [];
    for (;;) {
      // GitHub に入れない間は、チケットの仕事を取らない(企画・チャットなど、チケットを持たない仕事だけ動かす)
      const planningOnly = (this.deps.ticketsAllowed ? !this.deps.ticketsAllowed() : false) || !!githubDown(this.p);
      // 企画スタジオを止めている間は、企画の担当を起こさない
      const msg = claimNext(this.p, { exclude: released, planningOnly, triage: !!this.deps.triage, noPlan: !!studioPaused(this.p) });
      if (!msg) return null;
      const job = this.assign(msg);
      if (job === "wait") {
        release(this.p, msg.id, WAIT_MS);
        released.push(msg.id);
        continue;
      }
      if (job === "handled") continue;
      return job;
    }
  }

  /** 1 件だけ起こして終わるまで待つ。起こすものが無ければ false。 */
  async dispatchOnce(): Promise<boolean> {
    await this.checkGithub();
    this.housekeep();
    const job = this.next();
    if (!job) return false;
    await this.execute(job);
    return true;
  }

  /** GitHub に入れない間は、間を空けて入れるかを確かめ、入れたら再開する(ADR-0027)。 */
  async checkGithub(): Promise<void> {
    if (!githubCheckDue(this.p)) return;
    const repo = this.p.repos()[0];
    const probe = this.deps.workspace.checkGithub;
    if (!repo || !probe) return;
    const error = await probe.call(this.deps.workspace, repo.full_name).catch((e: unknown) => (e instanceof Error ? e.message : String(e)));
    if (error) githubStillDown(this.p, error);
    else markGithubUp(this.p);
  }

  /** 動いている企画の起動(止めるときに使う)。 */
  private readonly planRuns = new Map<number, AbortController>();

  /** 動いている企画の担当の起動を、その場で止める(企画スタジオを止めたとき)。止めた依頼は、再開したら取り直す。 */
  stopPlanning(): number {
    for (const a of this.planRuns.values()) a.abort(new Error("企画スタジオを止めました"));
    return this.planRuns.size;
  }

  private wakers: (() => void)[] = [];

  /**
   * 動いている仕事の終わりを待っている drain を起こし、受信箱を見直させる。
   * 始業した・チケットを足した・チャットを書いたときに呼ぶ(長い仕事が終わるまで次を取らない、を防ぐ)。
   */
  wake(): void {
    const w = this.wakers;
    this.wakers = [];
    for (const f of w) f();
  }

  /**
   * 同時に動かせる仕事の数。島の最大人数の合計(島のメンバーは 1 人 1 件ずつ並列に動く)に、
   * 島に属さない担当(リーダー・アーキテクト・企画・デザイナー)の分を足したもの。
   * 設定 concurrency があれば、それを上限にする(使いすぎを防ぐ)。
   */
  capacity(): number {
    const p = this.p;
    const seats = p.currentFormation().units.reduce((n, u) => n + u.max_members, 0) + FIXED_CAST.length;
    const cap = Number(p.setting("concurrency") ?? 0);
    return cap > 0 ? Math.min(cap, seats) : seats;
  }

  /** 受信箱が空になる(または上限に達する)まで起こし続ける。concurrency 件まで同時に動かす(関数なら見直すたびに読む)。 */
  async drain(opts: { concurrency?: number | (() => number); maxRuns?: number } = {}): Promise<number> {
    const limit = () => (typeof opts.concurrency === "function" ? opts.concurrency() : (opts.concurrency ?? 1));
    const maxRuns = opts.maxRuns ?? Infinity;
    const inflight = new Set<Promise<void>>();
    let started = 0;
    for (;;) {
      await this.checkGithub();
      this.housekeep();
      while (inflight.size < limit() && started < maxRuns) {
        const job = this.next();
        if (!job) break;
        started++;
        const pr: Promise<void> = this.execute(job).finally(() => inflight.delete(pr));
        inflight.add(pr);
      }
      if (inflight.size === 0) return started;
      // 仕事が 1 つ終わるか、起こされるか、少し経つ(待たせたメッセージの期限が来る)まで待って、受信箱を見直す
      let timer: ReturnType<typeof setTimeout> | undefined;
      let waker: (() => void) | undefined;
      const woke = new Promise<void>((res) => {
        waker = res;
        this.wakers.push(res);
        timer = setTimeout(res, this.deps.recheckMs ?? 5000);
      });
      await Promise.race([...inflight, woke]);
      clearTimeout(timer);
      this.wakers = this.wakers.filter((f) => f !== waker);
    }
  }

  // ---- 担当を決める ----

  private assign(msg: MessageRow): Job | "wait" | "handled" {
    const p = this.p;
    const ticket = msg.ticket_id === null ? null : p.ticket(msg.ticket_id);
    if (ticket && (ticket.stage === "dropped" || ticket.stage === "done")) {
      complete(p, msg.id);
      return "handled";
    }
    // リーダーの手助けはチケットの予算で止めない(詰まりを解くための仕事なので)
    if (ticket && msg.kind !== "unstick" && ticketExhausted(p, ticket.id)) {
      tx(p.db, () => {
        complete(p, msg.id);
        // 同じチケットで予算の判断を待っているなら、重ねて聞かない
        const waiting = get(p.db, "SELECT 1 AS x FROM decisions WHERE ticket_id = ? AND decided_at IS NULL AND options LIKE '%\"unlimited\"%'", [ticket.id]);
        if (waiting) return;
        const resume = { toRole: msg.to_role, toMemberId: msg.to_member_id, kind: msg.kind, payload: JSON.parse(msg.payload) as Record<string, unknown> };
        // お金を使い足すかは責任者が決める。期限で勝手に決めない
        raiseToOwner(
          p,
          ticket.id,
          {
            context: `チケット #${ticket.number}「${ticket.title}」`,
            question: `このチケットの予算($${ticketBudgetUsd(p, ticket.id)})を使い切りました。続けますか?`,
            recommended: 0,
            why: "予算を超えるのは、チケットが大きいか、詰まっている合図です。続けると、止まったところから再開します",
            impact: "続けるとさらにトークンを使います。プロジェクトの設定で「チケット 1 枚の予算」を無制限にすると、これからは聞きません。",
            reversible: true,
          },
          [
            { label: "予算を足して続ける", action: "continue", resume },
            { label: "このチケットの予算を無制限にして続ける", action: "unlimited", resume },
          ],
          { noDeadline: true },
        );
        p.event("system", "stopped", ticket.id, { reason: "budget" });
      });
      return "handled";
    }

    const role = msg.to_role;
    if (!isWorkRole(role)) return { msg, role, ticket, member: p.fixedMember(role) };

    // 同じ役割の島が複数あるときは、チケットのリポジトリを受け持つ島から選ぶ(ADR-0019)
    const repo = ticket ? ticketRepo(p, ticket)?.full_name : undefined;
    const units = p.unitsForRole(role, repo);
    if (!units.length) {
      // 編成が変わってこの工程が無くなった。工程を飛ばす。
      if (ticket && role !== "dev") {
        tx(p.db, () => {
          complete(p, msg.id);
          advance(p, ticket, role);
        });
        return "handled";
      }
      throw new Error("開発の島がありません");
    }

    // 予算を使い切った島には仕事を回さない。同じ役割の島がほかにあればそちらへ、無ければ予算が足されるまで待つ
    const affordable = units.filter((u) => !unitExhausted(p, u));
    if (!affordable.length) return "wait";

    const busy = new Set(all<{ member_id: number }>(p.db, "SELECT member_id FROM runs WHERE ended_at IS NULL").map((r) => r.member_id));

    if (msg.to_member_id !== null) {
      // 持ち主への直し。持ち主がこの仕事を受け持つ島の席にいれば、その人がやる
      const m = p.member(msg.to_member_id);
      if (m.left_at === null && affordable.some((u) => u.id === m.unit_id)) {
        if (busy.has(m.id)) return "wait";
        return { msg, role, ticket, member: m };
      }
      // 持ち主が席にいない(席替えで島を離れた)。呼び戻して席を増やすことはせず、島の手すきの人が引き継ぐ(ADR-0023)
      const free = affordable.flatMap((u) => p.membersOfUnit(u.id)).filter((x) => !busy.has(x.id) && (role === "dev" || x.id !== ticket?.owner_member_id));
      if (!free.length) return "wait";
      const next = this.leastLoaded(free);
      tx(p.db, () => {
        run(p.db, "UPDATE messages SET to_member_id = ? WHERE id = ?", [next.id, msg.id]);
        if (ticket && role === "dev") {
          run(p.db, "UPDATE tickets SET owner_member_id = ? WHERE id = ?", [next.id, ticket.id]);
          p.addNote(ticket.id, `【引き継ぎ】持ち主だった ${m.name} が島を離れたので、${next.name} が引き継ぎます。今のブランチの続きから進めてください。`, "lead");
        }
        p.event(next.name, "took_over", ticket?.id ?? null, { from: m.name });
      });
      return { msg: { ...msg, to_member_id: next.id }, role, ticket: ticket ? p.ticket(ticket.id) : ticket, member: next };
    }

    // 兼任していても、自分が実装した PR は自分で確かめない。
    const eligibleOf = (unitId: number) => p.membersOfUnit(unitId).filter((m) => role === "dev" || m.id !== ticket?.owner_member_id);
    const free = affordable.flatMap((u) => eligibleOf(u.id)).filter((m) => !busy.has(m.id));
    if (free.length) return { msg, role, ticket, member: this.leastLoaded(free) };

    // 島のメンバーは最大人数ぶんずっといるので、応援は呼ばない。誰かの手が空くまで待つ
    return "wait";
  }

  /** 起動 1 回の予算。起動 1 回の上限・全体の残り・ほかに渡された残り(チケット・島)の小さい方。 */
  private runBudget(...left: number[]): number {
    return Math.min(this.p.settingNumber("run_budget_usd", 2), projectLeftUsd(this.p), ...left);
  }

  private leastLoaded(ms: MemberRow[]): MemberRow {
    const load = (m: MemberRow) =>
      get<{ n: number }>(this.p.db, "SELECT COUNT(*) AS n FROM tickets WHERE owner_member_id = ? AND stage NOT IN ('done','dropped','merge')", [m.id])?.n ?? 0;
    return [...ms].sort((a, b) => load(a) - load(b) || b.is_base - a.is_base || a.id - b.id)[0]!;
  }

  // ---- 起こす ----

  async execute(job: Job): Promise<void> {
    if (job.msg.kind === "plan") return this.executePlan(job);
    if (job.msg.kind === "chat") return this.executeLeadChat(job, "chat");
    if (job.msg.kind === "triage") return this.executeLeadChat(job, "triage");
    if (job.msg.kind === "patrol") return this.executeLeadChat(job, "patrol");
    if (job.msg.kind === "unstick") return this.executeUnstick(job);
    const p = this.p;
    const { msg, member, role, ticket } = job;
    const policy = p.policy(role);
    // 島に設定があれば島のモデル・深さ、無ければ役割の方針(実際に使ったものを起動に残す)
    const use = p.modelFor(member, policy);
    const formation = p.currentFormation();
    const unit = formation.units.find((u) => u.id === member.unit_id);
    const harness = this.deps.harnesses[policy.harness];
    const repo = ticket ? ticketRepo(p, ticket) : undefined;
    // 開発より前の確認(R17): 受信箱は review/sec/qa のまま、コードを見ずにチケットの中身を読んで申し送りを残す
    const preDev = ["review", "sec", "qa"].includes(msg.kind) && (JSON.parse(msg.payload) as { preDev?: boolean }).preDev === true;

    if (!harness || !repo || !ticket) {
      this.failed(msg, null, !harness ? `ハーネス ${policy.harness} がありません` : !ticket ? "チケットの無いメッセージはまだ扱えません" : "リポジトリが登録されていません");
      return;
    }

    // 確認のやり直しで前の会話を引き継がない設定なら、セッションを使わず新しく始める
    const fresh = ["review", "sec", "qa"].includes(role) && !resumeChecks(p);
    const session = fresh
      ? undefined
      : get<{ id: number; harness_session_id: string; branch: string | null }>(
          p.db,
          "SELECT id, harness_session_id, branch FROM sessions WHERE member_id = ? AND ticket_id = ? AND repo_id = ?",
          [member.id, ticket.id, repo.id],
        );
    const branch = devBranch(p, ticket, repo.id);
    // 同じ会話を引き継ぐのは上限まで。超えたら新しく始める(ADR-0032)
    const resumeId = session && canResume(p, session.harness_session_id) ? session.harness_session_id : undefined;

    let runId: number;
    try {
      runId = run(
        p.db,
        "INSERT INTO runs (message_id, ticket_id, member_id, role, session_id, policy_id, formation_id, started_at, model, effort, unit_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [msg.id, ticket.id, member.id, role, resumeId ? session!.id : null, policy.id, formation.id, p.now(), use.model, use.effort, use.unitName],
      ).lastId;
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
      release(p, msg.id, WAIT_MS); // 同じチケットを別の起動が触っている
      return;
    }
    p.event(member.name, "run_started", ticket.id, { role, kind: msg.kind, model: use.model, effort: use.effort, policyVersion: policy.version, from: use.from });

    const started = p.clock.now().getTime();
    const report: RunReport = {};
    let result: HarnessResult | undefined;
    let error: string | undefined;
    try {
      // 開発より前には、まだ PR のブランチが無い(既定のブランチを置くだけ)
      const ws = await this.deps.workspace.prepare({ repo: repo.full_name, ticketNumber: ticket.number, role, memberName: member.name, branch: preDev ? "" : branch });
      // 画面のデザイン: 企画で合意した試作・デザインシステム・お手本の画像を作業場所に置き、役割ごとの使い方を指示に足す(ADR-0033・0034)
      const designUse = ["dev", "review", "qa"].includes(role) && !preDev;
      const designs = designUse ? designFor(p, ticket) : [];
      const system = designUse ? designSystem(p) : null;
      const systemTicket = designUse && isDesignSystemTicket(p, ticket);
      const withSystem = !!system && (designs.length > 0 || systemTicket);
      const refs = new Map<string, { id: number; png: Buffer }>();
      if (designs.length && this.deps.designStore && this.deps.renderer)
        for (const d of designs) {
          const r = await referenceImage(p, this.deps.designStore, this.deps.renderer, d);
          if (r) refs.set(d.key, r);
        }
      const files = [
        ...designs.map((d) => ({ file: d.file, data: d.html })),
        ...designs.filter((d) => refs.has(d.key)).map((d) => ({ file: d.file.replace(/\.html$/, ".png"), data: refs.get(d.key)!.png })),
        ...(withSystem ? designSystemFiles(system!) : []),
      ];
      if (files.length) await this.deps.workspace.writeDesign?.(ws.path, ws.gitDir, files);
      const compareTools =
        refs.size && (role === "dev" || role === "qa") && this.deps.designStore ? compareScreenTools(p, this.deps.designStore, ticket, ws.path, ws.gitDir, refs, this.deps.workspace) : [];
      result = await harness.run({
        cwd: ws.path,
        confine: confinementFor(p, ws, role),
        systemPrompt: systemPromptFor(p, role, policy, { name: use.unitName, focus: use.unitFocus }, member.name) + (preDev ? PRE_DEV_NOTE : ""),
        prompt: promptFor(p, msg, ticket, { branch, base: ws.base, repo: repo.full_name, ...prNumber(p, ticket.id, repo.id) }) + designPrompt(designs, role, { hasSystem: withSystem, systemTicket, references: new Set(refs.keys()) }),
        model: use.model,
        effort: use.effort,
        ...(resumeId ? { resumeSessionId: resumeId } : {}),
        tools: [
          // PR がある開発には、CI を調べる道具を渡す(作業場所からは GitHub が見えないため)
          ...(role === "dev" && msg.kind !== "implement" ? ciTools(p, this.deps.github, { ticket }) : []),
          ...compareTools,
          ...toolsFor(msg.kind, report, {
          mustAnswer: msg.kind === "fix" && !JSON.parse(msg.payload).conflict ? mustAnswer(p, ticket.id).map((t) => t.id) : [],
          preDev,
          mustResolve: ["review", "sec", "qa"].includes(msg.kind) && !preDev ? mustResolve(p, ticket.id, msg.kind).map((t) => t.id) : [],
          checkReady: () => this.deps.workspace.checkReady(ws.path, ws.base),
          checkLanded: (commit) => this.deps.workspace.landed(ws.path, ws.base, commit),
          // ノンストップでは、戻せる判断はリーダーが決める(戻せない判断だけ責任者へ)
          ...(msg.kind === "decide" ? { escalateAllowed: !nonstop(p) || !decision(p, Number(JSON.parse(msg.payload).decision_id)).reversible } : {}),
          }),
        ],
        onProgress: progressRecorder(p, runId),
        // 開発より前の確認は、コードを見ない(組み込みの道具は渡さず、申し送りを残す道具だけ)
        ...(role === "dev" ? {} : { allowedTools: preDev ? [] : ["Read", "Glob", "Grep", "Bash"] }),
        maxBudgetUsd: this.runBudget(leftUsd(ticketBudgetUsd(p, ticket.id), ticketSpentUsd(p, ticket.id)), unit ? unitLeftUsd(p, unit) : Infinity),
      });
      if (result.status === "error") error = result.error ?? "ハーネスがエラーで終わりました";
      if (result.status === "max_turns") error = "回数の上限に達しました";
      // 開発が報告したら、Kuramoto が外で push して PR を作る・更新する(エージェントは作業場所の外に出られない)
      if (!error && result.status === "ok" && report.draft) {
        const d = report.draft;
        const pub = await this.deps.workspace.publish({
          repo: repo.full_name,
          ticketNumber: ticket.number,
          path: ws.path,
          branch,
          base: ws.base,
          title: d.title ?? `${ticket.jira_key ? `${ticket.jira_key} ` : ""}${ticket.title}`,
          body: `${d.body ?? d.summary}\n\n---\nKuramoto のチケット #${ticket.number}${issueOf(p, ticket) ? `\nCloses #${issueOf(p, ticket)}` : ""}`,
        });
        // 承認済みのチケットが(衝突・CI などで)戻ってきたなら、承認のあとに自分で足した変更があるかを数える
        const approved = p.setting(`approved_sha:${ticket.id}`);
        report.pr = {
          repo: repo.full_name,
          number: pub.number,
          head: pub.head,
          summary: d.summary,
          ...(d.conflictResolution ? { conflictResolution: d.conflictResolution } : {}),
          ...(pub.sha ? { sha: pub.sha } : {}),
          ...(approved ? { ownCommitsSinceApproved: await this.deps.workspace.ownCommits(ws.path, ws.base, approved) } : {}),
        };
        p.event(member.name, "pushed", ticket.id, { number: pub.number, head: pub.head });
        // チームの CI: レビューに回す前に、最新の main と合わせて確認を流す(落ちればその場で戻す。ADR-0028)
        if (teamCiEnabled(p) && this.deps.checkRunner) report.teamCi = await runTeamCi(p, this.deps.workspace, this.deps.checkRunner, ticket, repo.full_name, branch);
      }
      // すでに main に入っていたなら、開いたままの PR は要らないので閉じる
      if (!error && result.status === "ok" && report.alreadyDone) await closeOpenPrs(this.deps.workspace, p, ticket, report.alreadyDone);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }

    const elapsed = p.clock.now().getTime() - started;
    tx(p.db, () => {
      const u = result?.usage;
      run(p.db, "UPDATE runs SET ended_at = ?, input_tokens = ?, output_tokens = ?, cache_read_tokens = ?, cost_usd = ?, outcome = ?, error = ?, summary = ? WHERE id = ?", [
        p.now(),
        u?.inputTokens ?? 0,
        u?.outputTokens ?? 0,
        u?.cacheReadTokens ?? 0,
        u?.costUsd ?? 0,
        error ? "error" : (result?.status ?? "error"),
        error ?? null,
        (report.pr?.summary || report.draft?.summary || result?.finalText || "").trim() || null,
        runId,
      ]);
      run(p.db, "UPDATE tickets SET active_ms = active_ms + ? WHERE id = ?", [elapsed, ticket.id]);
      if (result?.sessionId) {
        run(
          p.db,
          `INSERT INTO sessions (member_id, ticket_id, repo_id, harness, harness_session_id, branch, created_at, last_used_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(member_id, ticket_id, repo_id) DO UPDATE SET harness_session_id = excluded.harness_session_id, last_used_at = excluded.last_used_at`,
          [member.id, ticket.id, repo.id, harness.name, result.sessionId, role === "dev" ? branch : null, p.now(), p.now()],
        );
        noteSession(p, result.sessionId, resumeId);
      }
    });

    if (result?.status === "budget") {
      // 起動 1 回の予算に達した。次の起動でチケットの予算を確かめ直す。
      tx(p.db, () => {
        complete(p, msg.id);
        send(p, { ticketId: ticket.id, toRole: msg.to_role, toMemberId: msg.to_member_id, kind: msg.kind, payload: JSON.parse(msg.payload) });
        p.event(member.name, "run_budget_reached", ticket.id, {});
      });
      return;
    }
    if (!error) {
      error = applyReport(p, { msg, runId, memberId: member.id }, report);
      if (!error) {
        complete(p, msg.id);
        resetUnstick(p, ticket.id); // 前に進んだので、リーダーの手助けの回数を数え直す
        p.event(member.name, "run_finished", ticket.id, { role, kind: msg.kind });
        return;
      }
    }
    this.failed(msg, ticket, error);
  }

  /** 企画スタジオの担当を 1 回起こす。道具は起動の中で企画の中身を直接書き換える。 */
  private async executePlan(job: Job): Promise<void> {
    const p = this.p;
    const { msg, member, role } = job;
    const payload = JSON.parse(msg.payload) as PlanPayload;
    const policy = p.policy(role);
    const harness = this.deps.harnesses[policy.harness];
    const repo = p.repos()[0];
    if (!harness || !repo) {
      this.failed(msg, null, !harness ? `ハーネス ${policy.harness} がありません` : "リポジトリが登録されていません");
      return;
    }
    // 企画の会話は段階ごとに分け、引き継ぐのは上限まで(段階をまたいで 1 つの会話を引き継ぐと、回ごとに高くなっていた)
    const sessionKey = `plan_session:${member.id}:${payload.stage}`;
    const saved = p.setting(sessionKey);
    const resume = canResume(p, saved) ? saved : undefined;
    const runId = run(
      p.db,
      "INSERT INTO runs (message_id, ticket_id, member_id, role, policy_id, formation_id, started_at, model, effort) VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?)",
      [msg.id, member.id, role, policy.id, p.currentFormation().id, p.now(), policy.model, policy.effort],
    ).lastId;
    p.event(member.name, "plan_run_started", null, { stage: payload.stage, model: policy.model, effort: policy.effort, policyVersion: policy.version });

    let result: HarnessResult | undefined;
    let error: string | undefined;
    const abort = new AbortController();
    this.planRuns.set(runId, abort);
    try {
      const ws = await this.deps.workspace.prepare({ repo: repo.full_name, ticketNumber: 0, role, memberName: member.name, branch: "" });
      result = await harness.run({
        cwd: ws.path,
        confine: confinementFor(p, ws, role),
        systemPrompt: planningSystemPrompt(p, role, policy.focus) + planWebNote(p),
        prompt: planningPrompt(p, payload, { fresh: !resume }),
        model: policy.model,
        effort: policy.effort,
        ...(resume ? { resumeSessionId: resume } : {}),
        // 質問だけなら、書き換えの道具を渡さない(答えるだけ。合意も外れない)
        tools: onlyQuestions(payload.events) ? [] : planningTools(p, payload.stage),
        onProgress: progressRecorder(p, runId),
        // 設計のときは外のサイトも見られる(検索・ページを読む。ADR-0035)
        allowedTools: ["Read", "Glob", "Grep", ...planWebTools(p)],
        maxBudgetUsd: this.runBudget(),
        signal: abort.signal,
      });
      if (result.status !== "ok" && result.status !== "budget") error = result.error ?? "ハーネスがエラーで終わりました";
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      this.planRuns.delete(runId);
    }
    // 企画スタジオを止めたので途中でやめた。失敗に数えず、再開したら同じ依頼を取り直す
    if (abort.signal.aborted) {
      tx(p.db, () => {
        run(p.db, "UPDATE runs SET ended_at = ?, outcome = 'cancelled', error = ?, cost_usd = ? WHERE id = ?", [p.now(), "企画スタジオを止めたので、途中でやめました", result?.usage?.costUsd ?? 0, runId]);
        release(p, msg.id, 0);
      });
      return;
    }

    tx(p.db, () => {
      const u = result?.usage;
      run(p.db, "UPDATE runs SET ended_at = ?, input_tokens = ?, output_tokens = ?, cache_read_tokens = ?, cost_usd = ?, outcome = ?, error = ? WHERE id = ?", [
        p.now(),
        u?.inputTokens ?? 0,
        u?.outputTokens ?? 0,
        u?.cacheReadTokens ?? 0,
        u?.costUsd ?? 0,
        error ? "error" : (result?.status ?? "error"),
        error ?? null,
        runId,
      ]);
      if (result?.sessionId) {
        p.setSetting(sessionKey, result.sessionId);
        noteSession(p, result.sessionId, resume);
      }
    });

    if (error) {
      say(p, payload.stage, "system", `${member.name} の起動がエラーで止まりました: ${error}`);
      this.failed(msg, null, error);
      return;
    }
    tx(p.db, () => {
      complete(p, msg.id);
      afterPlanningRun(p, msg, role, result?.finalText ?? "");
    });
  }

  /** リーダーの起動: 責任者とのチャットへの返事、交通整理(チケットの順番と担当を決める)、または見回り(重複と回り続けているチケットに手を打つ)。 */
  private async executeLeadChat(job: Job, mode: "chat" | "triage" | "patrol"): Promise<void> {
    const p = this.p;
    const { msg, member } = job;
    const targets = mode === "triage" ? untriaged(p) : [];
    if (mode === "triage" && !targets.length) {
      complete(p, msg.id);
      return;
    }
    // チャット: 読んでいない責任者のメッセージが無ければ起こさない(前の起動でまとめて返事をしたなど)
    const unread = mode === "chat" ? unreadOwnerMessages(p) : [];
    if (mode === "chat" && !unread.length) {
      complete(p, msg.id);
      return;
    }
    const signals: LoopSignal[] = mode === "patrol" ? loopSignals(p) : [];
    const policy = p.policy("lead");
    const harness = this.deps.harnesses[policy.harness];
    const repo = p.repos()[0];
    if (!harness || !repo) {
      this.failed(msg, null, !harness ? `ハーネス ${policy.harness} がありません` : "リポジトリが登録されていません");
      return;
    }
    // 取りやめ・重複の片付けで、開いている PR を閉じる
    const closePrs = (t: TicketRow, reason: string) => closeOpenPrs(this.deps.workspace, p, t, { commit: "", reason });
    // チャット・交通整理・見回りは毎回まっさらに始める。チャットの前のやりとりは、指示に最近の分を入れて渡す(ADR-0032)
    const runId = run(
      p.db,
      "INSERT INTO runs (message_id, ticket_id, member_id, role, policy_id, formation_id, started_at, model, effort) VALUES (?, NULL, ?, 'lead', ?, ?, ?, ?, ?)",
      [msg.id, member.id, policy.id, p.currentFormation().id, p.now(), policy.model, policy.effort],
    ).lastId;
    p.event(member.name, `${mode}_run_started`, null, { model: policy.model, tickets: (mode === "patrol" ? signals.map((s) => s.ticket) : targets).map((t) => t.number) });
    let result: HarnessResult | undefined;
    let error: string | undefined;
    try {
      const ws = await this.deps.workspace.prepare({ repo: repo.full_name, ticketNumber: 0, role: "lead", memberName: member.name, branch: "" });
      result = await harness.run({
        cwd: ws.path,
        confine: confinementFor(p, ws, "lead"),
        systemPrompt: LEAD_CHAT_SYSTEM + (policy.focus.trim() ? `\n\n## このプロジェクトで重視すること\n${policy.focus.trim()}` : "") + speechNote(member.name),
        prompt: mode === "chat" ? leadChatPrompt(p, unread) : mode === "triage" ? triagePrompt(p, targets) : patrolPrompt(p, signals, { start: !!(JSON.parse(msg.payload) as { start?: boolean }).start }),
        model: policy.model,
        effort: policy.effort,
        tools:
          mode === "chat"
            ? leadChatTools(p, { closePrs })
            : mode === "triage"
              ? triageTools(p)
              : [...patrolTools(p, { closePrs }), ...ciTools(p, this.deps.github, { rerun: true })],
        allowedTools: ["Read", "Glob", "Grep"],
        maxBudgetUsd: this.runBudget(),
        onProgress: progressRecorder(p, runId),
      });
      if (result.status !== "ok" && result.status !== "budget") error = result.error ?? "ハーネスがエラーで終わりました";
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    tx(p.db, () => {
      const u = result?.usage;
      run(p.db, "UPDATE runs SET ended_at = ?, input_tokens = ?, output_tokens = ?, cache_read_tokens = ?, cost_usd = ?, outcome = ?, error = ?, summary = ? WHERE id = ?", [
        p.now(),
        u?.inputTokens ?? 0,
        u?.outputTokens ?? 0,
        u?.cacheReadTokens ?? 0,
        u?.costUsd ?? 0,
        error ? "error" : (result?.status ?? "error"),
        error ?? null,
        result?.finalText?.trim() || null,
        runId,
      ]);
    });
    if (error) {
      run(p.db, "INSERT INTO lead_messages (who, body, at) VALUES ('system', ?, ?)", [
        `${member.name} の${{ chat: "返事", triage: "交通整理", patrol: "見回り" }[mode]}がエラーで止まりました: ${error}`,
        p.now(),
      ]);
      this.failed(msg, null, error);
      // 交通整理の再試行が尽きたら、チケットを止めずに流す
      if (mode === "triage" && get<{ status: string }>(p.db, "SELECT status FROM messages WHERE id = ?", [msg.id])?.status === "failed") giveUpTriage(p);
      return;
    }
    tx(p.db, () => {
      complete(p, msg.id);
      if (mode === "triage") {
        markTriaged(p, targets.map((t) => t.id));
        p.event(member.name, "triaged", null, { tickets: targets.map((t) => t.number) });
        const text = result?.finalText?.trim();
        leadReply(p, `【交通整理 #${targets.map((t) => t.number).join(", #")}】${text ? `\n${text}` : ""}`);
      } else if (mode === "patrol") {
        finishPatrol(p, signals);
        p.event(member.name, "patrolled", null, { tickets: signals.map((s) => s.ticket.number) });
        const text = result?.finalText?.trim();
        leadReply(p, `【見回り】${text ? `\n${text}` : ""}`);
      } else {
        leadReply(p, result?.finalText ?? "");
        // 渡したメッセージまで読んだことにする(返事の最中に届いたものは、次の起動で読む)
        markOwnerMessagesRead(p, Math.max(...unread.map((m) => m.id)));
      }
    });
  }

  private failed(msg: MessageRow, ticket: TicketRow | null, error: string): void {
    const p = this.p;
    tx(p.db, () => {
      // 利用の上限(5 時間あたりなど)は、待てば解ける。失敗に数えず、間を空けて取り直す
      if (isUsageLimit(error)) {
        release(p, msg.id, p.settingNumber("usage_limit_wait_sec", 900) * 1000);
        p.event("system", "usage_limited", ticket?.id ?? null, { error });
        return;
      }
      // GitHub に入れない(認証切れ)のは環境の問題。チケットの失敗に数えず、入れるようになるまで待って取り直す(ADR-0027)
      if (isGithubAuthError(error)) {
        markGithubDown(p, error);
        release(p, msg.id, WAIT_MS);
        return;
      }
      const exhausted = fail(p, msg, error);
      p.event("system", exhausted ? "stuck" : "retry", ticket?.id ?? null, { reason: "error", error, attempts: msg.attempts });
      if (!exhausted || !ticket) return;
      if (msg.kind === "unstick") {
        // リーダーの手助けそのものが動かない。保留して責任者に頼む
        const payload = JSON.parse(msg.payload) as StuckPayload;
        holdTicket(p, ticket.id, {
          reason: `担当の仕事が止まり、リーダーの調査もエラーで止まりました: ${error}(担当のエラー: ${payload.error})`,
          ownerAction: "エラーの原因(環境・認証・ハーネスなど)を取り除いてから再開してください。",
          resume: payload.resume,
        });
        return;
      }
      // 責任者に上げる前に、リーダーが原因を調べて手助けする
      askLeadToUnstick(p, ticket, msg, error);
    });
  }

  /** 詰まったチケットを、リーダーが調べて手助けする(やり直させるか、保留する)。 */
  private async executeUnstick(job: Job): Promise<void> {
    const p = this.p;
    const { msg, member, ticket } = job;
    if (!ticket) {
      complete(p, msg.id);
      return;
    }
    const payload = JSON.parse(msg.payload) as StuckPayload;
    const policy = p.policy("lead");
    const harness = this.deps.harnesses[policy.harness];
    const repo = ticketRepo(p, ticket);
    if (!harness || !repo) {
      this.failed(msg, ticket, !harness ? `ハーネス ${policy.harness} がありません` : "リポジトリが登録されていません");
      return;
    }
    const runId = run(
      p.db,
      "INSERT INTO runs (message_id, ticket_id, member_id, role, policy_id, formation_id, started_at, model, effort) VALUES (?, ?, ?, 'lead', ?, ?, ?, ?, ?)",
      [msg.id, ticket.id, member.id, policy.id, p.currentFormation().id, p.now(), policy.model, policy.effort],
    ).lastId;
    p.event(member.name, "unstick_run_started", ticket.id, { error: payload.error });
    const done: { action?: "retry" | "hold" | "closed" | "dropped" } = {};
    let result: HarnessResult | undefined;
    let error: string | undefined;
    try {
      // 担当が push したブランチを読むだけの場所で調べる
      const ws = await this.deps.workspace.prepare({ repo: repo.full_name, ticketNumber: ticket.number, role: "lead", memberName: member.name, branch: devBranch(p, ticket, repo.id) });
      result = await harness.run({
        cwd: ws.path,
        confine: confinementFor(p, ws, "lead"),
        systemPrompt: `あなたは Kuramoto の開発チームのリーダーです。チームの仕事が詰まったときに、原因を調べて先に進める手助けをします。
- チケットをやめることはしません。目的はプロダクトを完成させることです。
- 直せる問題は、担当への具体的な助言で解かせます。チームの中では解けないときだけ保留し、責任者に何をしてほしいかを伝えます。` +
          (policy.focus.trim() ? `\n\n## このプロジェクトで重視すること\n${policy.focus.trim()}` : "") +
          speechNote(member.name),
        prompt: unstickPrompt(p, ticket, payload),
        model: policy.model,
        effort: policy.effort,
        tools: [
          ...unstickTools(p, ticket, payload, done, {
            checkLanded: (commit) => this.deps.workspace.landed(ws.path, ws.base, commit),
            closePrs: (a) => closeOpenPrs(this.deps.workspace, p, ticket, a),
            closeTicketPrs: (t, reason) => closeOpenPrs(this.deps.workspace, p, t, { commit: "", reason }),
          }),
          ...ciTools(p, this.deps.github, { ticket, rerun: true }),
        ],
        allowedTools: ["Read", "Glob", "Grep", "Bash"],
        maxBudgetUsd: this.runBudget(),
        onProgress: progressRecorder(p, runId),
      });
      if (result.status !== "ok" && result.status !== "budget") error = result.error ?? "ハーネスがエラーで終わりました";
      else if (!done.action) error = "retry_with_advice・reassign・split_and_retry・close_as_already_done・drop_ticket・hold のどれも呼ばれませんでした";
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    tx(p.db, () => {
      const u = result?.usage;
      run(p.db, "UPDATE runs SET ended_at = ?, input_tokens = ?, output_tokens = ?, cache_read_tokens = ?, cost_usd = ?, outcome = ?, error = ?, summary = ? WHERE id = ?", [
        p.now(),
        u?.inputTokens ?? 0,
        u?.outputTokens ?? 0,
        u?.cacheReadTokens ?? 0,
        u?.costUsd ?? 0,
        error ? "error" : (result?.status ?? "error"),
        error ?? null,
        result?.finalText?.trim() || null,
        runId,
      ]);
    });
    if (error) {
      this.failed(msg, ticket, error);
      return;
    }
    tx(p.db, () => {
      complete(p, msg.id);
      const text = result?.finalText?.trim();
      const what = { hold: "保留にして、あなたに対応をお願いしました。", closed: "変更がすでに main に入っていたので、完了にしました。", dropped: "やることが無いチケットだったので、取りやめました。", retry: "助言を渡して、やり直してもらいます。" }[done.action ?? "retry"];
      leadReply(p, `【#${ticket.number} の手助け】${what}${text ? `\n${text}` : ""}`);
      p.event(member.name, done.action === "hold" ? "unstick_held" : done.action === "closed" ? "unstick_closed" : done.action === "dropped" ? "unstick_dropped" : "unstick_retried", ticket.id, {});
    });
  }
}

/** すでに main に入っていた(commit あり)・重複として片付けた(commit 空)チケットの、開いたままの PR を閉じる。閉じられなくても片付けはする(出来事に残す)。 */
async function closeOpenPrs(ws: Workspace, p: Project, ticket: TicketRow, a: { commit: string; reason: string }): Promise<void> {
  const prs = all<{ number: number; full_name: string }>(
    p.db,
    "SELECT pr.number, r.full_name FROM pull_requests pr JOIN repos r ON r.id = pr.repo_id WHERE pr.ticket_id = ? AND COALESCE(pr.gh_state, 'OPEN') = 'OPEN'",
    [ticket.id],
  );
  for (const pr of prs) {
    try {
      await ws.closePr(pr.full_name, pr.number, a.commit ? `このチケット(#${ticket.number})の変更は、すでに main に入っていました(${a.commit})。${a.reason}` : `${a.reason}(Kuramoto のチケット #${ticket.number})`);
      run(p.db, "UPDATE pull_requests SET gh_state = 'CLOSED' WHERE ticket_id = ? AND number = ?", [ticket.id, pr.number]);
    } catch (e) {
      p.event("system", "pr_close_failed", ticket.id, { pr: pr.number, error: e instanceof Error ? e.message : String(e) });
    }
  }
}

/** 利用の上限(サブスクリプションの 5 時間あたりの上限・API の流量制限など)。待てば解ける。 */
export function isUsageLimit(error: string): boolean {
  return /hit your .*limit|usage limit|rate limit|rate_limit|overloaded/i.test(error);
}

function isWorkRole(r: Role): r is WorkRole {
  return (WORK_ROLES as readonly string[]).includes(r);
}

/** チケットで片付ける GitHub の Issue の番号(既存のリポジトリの続きから。ADR-0030)。 */
function issueOf(p: Project, t: TicketRow): number | undefined {
  const refs = JSON.parse((get<{ plan_refs: string }>(p.db, "SELECT plan_refs FROM tickets WHERE id = ?", [t.id])?.plan_refs ?? "{}")) as { issue?: number };
  return refs.issue;
}

/** チケットが対象にするリポジトリ。plan_refs.repo が無ければ最初に登録したもの。 */
export function ticketRepo(p: Project, t: TicketRow): { id: number; full_name: string } | undefined {
  const refs = JSON.parse((get<{ plan_refs: string }>(p.db, "SELECT plan_refs FROM tickets WHERE id = ?", [t.id])?.plan_refs ?? "{}")) as { repo?: string };
  const repos = p.repos();
  return (refs.repo ? repos.find((r) => r.full_name === refs.repo) : undefined) ?? repos[0];
}

function devBranch(p: Project, t: TicketRow, repoId: number): string {
  const existing = get<{ branch: string }>(p.db, "SELECT branch FROM sessions WHERE ticket_id = ? AND repo_id = ? AND branch IS NOT NULL LIMIT 1", [t.id, repoId]);
  if (existing) return existing.branch;
  const pr = get<{ head: string }>(p.db, "SELECT head FROM pull_requests WHERE ticket_id = ? AND repo_id = ?", [t.id, repoId]);
  return pr?.head ?? `kuramoto/${t.jira_key ?? t.number}`;
}

function prNumber(p: Project, ticketId: number, repoId: number): { prNumber?: number } {
  const pr = get<{ number: number }>(p.db, "SELECT number FROM pull_requests WHERE ticket_id = ? AND repo_id = ?", [ticketId, repoId]);
  return pr ? { prNumber: pr.number } : {};
}
