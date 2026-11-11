import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { all, get } from "./db/sqlite.js";
import { pipelineOf } from "./domain/formation.js";
import { ROLE_LABEL } from "./domain/roles.js";
import { ClaudeAgentSdkHarness } from "./harness/claude-agent-sdk.js";
import type { Harness } from "./harness/types.js";
import { GhCli, type GitHub } from "./github/github.js";
import { Hq, workDirFor } from "./hq.js";
import { Dispatcher } from "./project/dispatcher.js";
import { recoverStale } from "./project/inbox.js";
import { autoMerge, autoMergeEnabled, ownerMerge, suggestedMergeOrder } from "./project/merge.js";
import { metrics } from "./project/metrics.js";
import { exportDesignDoc } from "./project/export.js";
import { extractTransfer, restoreTransfer } from "./project/transfer.js";
import { runWork } from "./project/progress.js";
import { saveFormationInput, savePolicyInput, teamView } from "./project/team.js";
import { productivity } from "./project/productivity.js";
import { officeView } from "./project/office.js";
import { memberView, unitView, type MemberView, type UnitView } from "./project/people.js";
import { ticketView } from "./project/ticket.js";
import { leadChatView, sayToLead } from "./project/leadchat.js";
import { areaWait, blockers, dependsOn, mergeBlockers, mergeUnblocks } from "./project/triage.js";
import { budgetView, projectBudgetUsd, projectSpentUsd, setProjectBudget } from "./project/budget.js";
import type { Project } from "./project/project.js";
import { GitWorkspace, type Workspace } from "./project/workspace.js";
import { answerDecision, createTicket, defaultTicketBudgetUsd, nonstop, pendingOwnerDecisions, reopenTicket, resumeChecks, setDefaultTicketBudget, setTicketBudget, type DecisionOption } from "./project/workflow.js";
import {
  addComment,
  advance,
  agree,
  agreeScreen,
  answerOpenItem,
  chat,
  handedOff,
  handoff,
  ownerPlanItems,
  pickVariant,
  setMode,
  stageDone,
  STAGES,
  studioView,
  type Mode,
  type Stage,
} from "./project/planning.js";

/** ビルドした画面(vite build の出力)。 */
const WEB_DIR = fileURLToPath(new URL("../ui/dist/", import.meta.url));
/** サーバーを起動し直すたびに変わる。開いたままの画面が、古い画面のまま動き続けないように使う。 */
const BUILD_ID = String(Date.now());
const POLL_MS = 3_000;
/** 自動 merge で merge 待ちを見回る間隔。 */
const MERGE_POLL_MS = 20_000;

export type ServerDeps = {
  hq: Hq;
  /** 画面のファイルの置き場所。省略時は ui/dist。 */
  webDir?: string;
  harnesses?: Record<string, Harness>;
  github?: GitHub;
  workspaceFor?: (dataDir: string) => Workspace;
  /** 自動 merge で merge 待ちを見回る間隔(ミリ秒)。既定は 20 秒。 */
  mergePollMs?: number;
};

/**
 * ローカルサーバー(docs/design.md 3.1)。画面を配り、API を受け、稼働中のプロジェクトのディスパッチャを回す。
 * localhost だけで待ち受け、書き込みの API には独自のヘッダーを求める(他のサイトからの書き込みを防ぐ)。
 */
export class KuramotoServer {
  private readonly projects = new Map<number, Project>();
  private readonly runners = new Map<number, { timer: NodeJS.Timeout; mergeTimer: NodeJS.Timeout; busy: boolean; dispatcher: Dispatcher; tick: () => Promise<void> }>();
  /** オフィス(チケットの仕事)を動かしているプロジェクト。企画スタジオの担当は止めていても動く。 */
  private readonly running = new Set<number>();
  private readonly harnesses: Record<string, Harness>;
  private readonly github: GitHub;
  private readonly workspaceFor: (dataDir: string) => Workspace;
  private readonly mergePollMs: number;

  constructor(private readonly deps: ServerDeps) {
    this.harnesses = deps.harnesses ?? { "claude-agent-sdk": new ClaudeAgentSdkHarness() };
    this.github = deps.github ?? new GhCli();
    this.mergePollMs = deps.mergePollMs ?? MERGE_POLL_MS;
    this.workspaceFor = deps.workspaceFor ?? ((d) => new GitWorkspace(workDirFor(d)));
  }

  get hq(): Hq {
    return this.deps.hq;
  }

  /** すべてのプロジェクトの受信箱を見始める。前回「稼働中」のまま止めたものはオフィスも再開する。 */
  resume(): void {
    for (const rec of this.hq.projects()) {
      if (rec.status === "running") this.running.add(rec.id);
      // 止まっている間に始められるようになった段階があれば始める
      advance(this.project(rec.id));
      this.loop(rec.id);
    }
  }

  project(id: number): Project {
    let p = this.projects.get(id);
    if (!p) {
      p = this.hq.openProject(id);
      this.projects.set(id, p);
    }
    return p;
  }

  /** オフィスを動かす。 */
  start(id: number): void {
    this.running.add(id);
    this.hq.setStatus(id, "running");
    this.loop(id);
    this.poke(id);
  }

  /** 次の見回りを待たずに受信箱を見に行く。 */
  poke(id: number): void {
    const r = this.runners.get(id);
    if (!r) return;
    // 長い仕事の終わりを待っている最中でも、すぐ受信箱を見直させる
    r.dispatcher.wake();
    void r.tick();
  }

  /** オフィスを止める(企画スタジオの担当は動き続ける)。 */
  stop(id: number): void {
    this.running.delete(id);
    this.hq.setStatus(id, handedOff(this.project(id)) ? "starting" : "planning");
  }

  /** プロジェクトの受信箱を見回るループ。1 プロジェクトに 1 つ。 */
  private loop(id: number): void {
    if (this.runners.has(id)) return;
    const p = this.project(id);
    recoverStale(p);
    const dispatcher = new Dispatcher(p, {
      harnesses: this.harnesses,
      workspace: this.workspaceFor(this.hq.project(id).data_dir),
      ticketsAllowed: () => this.running.has(id),
      triage: true,
    });
    // チームが自動で merge する(ADR-0022)。始業中だけ。merge できたら、待っていた後のチケットが動けるように受信箱を見直す
    let merging = false;
    const merge = async (): Promise<void> => {
      if (merging || !this.running.has(id) || !autoMergeEnabled(p)) return;
      merging = true;
      try {
        if (await autoMerge(p, this.github)) this.poke(id);
      } catch (e) {
        p.event("system", "dispatcher_error", null, { error: e instanceof Error ? e.message : String(e) });
      } finally {
        merging = false;
      }
    };
    const r = {
      busy: false,
      dispatcher,
      timer: setInterval(() => void tick(), POLL_MS),
      mergeTimer: setInterval(() => void merge(), this.mergePollMs),
      tick: async () => tick(),
    };
    let again = false;
    const tick = async (): Promise<void> => {
      if (r.busy) {
        again = true; // 見回り中に呼ばれたら、終わってからもう一度見る
        return;
      }
      r.busy = true;
      try {
        // 島の最大人数まで並列に動かす(編成を変えたら次に見直すときから効く)
        await dispatcher.drain({ concurrency: () => dispatcher.capacity() });
      } catch (e) {
        p.event("system", "dispatcher_error", null, { error: e instanceof Error ? e.message : String(e) });
      } finally {
        r.busy = false;
      }
      if (again) {
        again = false;
        await tick();
      }
    };
    this.runners.set(id, r);
    void tick();
  }

  /** テスト用: 今すぐ受信箱を見に行く。 */
  async tick(id: number): Promise<void> {
    const r = this.runners.get(id);
    if (!r) return;
    while (r.busy) await new Promise((res) => setTimeout(res, 5));
    r.busy = true;
    try {
      await r.dispatcher.drain({ concurrency: 2 });
    } finally {
      r.busy = false;
    }
  }

  close(): void {
    for (const r of this.runners.values()) {
      clearInterval(r.timer);
      clearInterval(r.mergeTimer);
    }
    for (const p of this.projects.values()) p.close();
  }

  // ---- API ----

  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (!isLocalHost(req.headers.host)) return send(res, 403, { error: "localhost からだけ使えます" });
      if (!url.pathname.startsWith("/api/")) return await this.serveStatic(url.pathname, res);
      if (req.method !== "GET" && req.headers["x-kuramoto"] !== "1") return send(res, 403, { error: "ヘッダーがありません" });
      const exp = req.method === "GET" && url.pathname.match(/^\/api\/projects\/(\d+)\/studio\/export$/);
      if (exp) return this.sendExport(Number(exp[1]), res);
      const body = req.method === "GET" ? {} : await readJson(req);
      const out = await this.route(req.method ?? "GET", url.pathname.split("/").filter(Boolean).slice(1), body);
      if (out === undefined) return send(res, 404, { error: "ありません" });
      send(res, 200, out);
    } catch (e) {
      send(res, 400, { error: e instanceof Error ? e.message : String(e) });
    }
  }

  private async route(method: string, parts: string[], body: Record<string, unknown>): Promise<unknown> {
    const [a, idStr, b, c] = parts;
    if (a === "hq" && method === "GET") return this.hqView();
    if (a !== "projects") return undefined;
    if (idStr === "import" && method === "POST") {
      // 書き出した設計書から、新しいプロジェクトとして復元する
      const data = extractTransfer(String(body.markdown ?? ""));
      const rec = this.hq.createProject(data.project.name, data.repos);
      restoreTransfer(this.project(rec.id), data);
      this.hq.setStatus(rec.id, handedOff(this.project(rec.id)) ? "starting" : "planning");
      advance(this.project(rec.id));
      this.loop(rec.id);
      return { id: rec.id };
    }
    if (!idStr && method === "POST") {
      const repos = (body.repos as { fullName: string; role: string }[] | undefined) ?? [];
      const rec = this.hq.createProject(String(body.name ?? ""), repos.map((r) => ({ fullName: String(r.fullName).trim(), role: String(r.role) })));
      // リポジトリを登録したら、企画スタジオの企画担当が要件を聞き始める
      advance(this.project(rec.id));
      this.loop(rec.id);
      return { id: rec.id };
    }
    const id = Number(idStr);
    if (!Number.isInteger(id)) return undefined;
    const p = this.project(id);
    if (!b && method === "GET") return this.projectView(id);
    if (b === "tickets" && c && method === "GET") return ticketView(p, Number(c));
    if (b === "tickets" && c && parts[4] === "notes" && method === "POST") {
      p.addNote(Number(c), String(body.body ?? ""));
      return ticketView(p, Number(c));
    }
    if (b === "tickets" && c && parts[4] === "reopen" && method === "POST") {
      reopenTicket(p, Number(c));
      this.poke(id);
      return ticketView(p, Number(c));
    }
    if (b === "tickets" && c && parts[4] === "budget" && method === "POST") {
      setTicketBudget(p, Number(c), body.unlimited ? "unlimited" : body.usd === null || body.usd === undefined || body.usd === "" ? null : Number(body.usd));
      this.poke(id);
      return ticketView(p, Number(c));
    }
    if (b === "tickets" && c && method === "POST") {
      p.editTicket(Number(c), { title: String(body.title ?? ""), body: String(body.body ?? "") });
      return ticketView(p, Number(c));
    }
    if (b === "tickets" && method === "POST") {
      const title = String(body.title ?? "").trim();
      if (!title) throw new Error("タイトルがありません");
      const t = createTicket(p, { title, body: String(body.body ?? "") });
      this.poke(id);
      return t;
    }
    if (b === "decisions" && c && method === "POST") {
      answerDecision(p, Number(c), Number(body.choice), typeof body.note === "string" ? body.note : undefined);
      this.poke(id);
      return { ok: true };
    }
    if (b === "merge" && c && method === "POST") return ownerMerge(p, this.github, Number(c));
    if (b === "run" && method === "POST") {
      if (body.running) this.start(id);
      else this.stop(id);
      return { running: this.running.has(id) };
    }
    if (b === "team" && method === "GET") return teamView(p);
    if (b === "productivity" && method === "GET") return productivity(p);
    if (b === "office" && method === "GET") return { ...officeView(p), running: this.running.has(id) };
    if (b === "members" && c && method === "GET") return memberView(p, Number(c));
    if (b === "units" && c && method === "GET") return unitView(p, Number(c), officeView(p));
    if (b === "lead-chat" && method === "GET") return leadChatView(p);
    if (b === "lead-chat" && method === "POST") {
      sayToLead(p, String(body.body ?? ""));
      this.poke(id);
      return leadChatView(p);
    }
    if (b === "settings" && method === "GET")
      return {
        name: this.hq.project(id).name,
        dataDir: this.hq.project(id).data_dir,
        repos: p.repos().map((r) => ({ fullName: r.full_name, role: r.role })),
        ticketBudgetUsd: defaultTicketBudgetUsd(p),
        projectBudgetUsd: projectBudgetUsd(p),
        projectSpentUsd: projectSpentUsd(p),
        nonstop: nonstop(p),
        autoMerge: autoMergeEnabled(p),
        resumeChecks: resumeChecks(p),
      };
    if (b === "settings" && method === "POST") {
      const budget = body.ticketBudgetUsd === undefined ? undefined : body.ticketBudgetUsd === null ? null : Number(body.ticketBudgetUsd);
      if (budget !== undefined && budget !== null && !(Number.isFinite(budget) && budget > 0)) throw new Error("チケット 1 枚の予算は 0 より大きい金額か、無制限にしてください");
      const repos = (body.repos as { fullName: string; role: string }[] | undefined) ?? [];
      const rec = this.hq.updateProject(p, id, { name: String(body.name ?? ""), repos: repos.map((r) => ({ fullName: String(r.fullName).trim(), role: String(r.role) })) });
      const total = body.projectBudgetUsd === undefined ? undefined : body.projectBudgetUsd === null || body.projectBudgetUsd === "" ? null : Number(body.projectBudgetUsd);
      if (total !== undefined && total !== null && !(Number.isFinite(total) && total > 0)) throw new Error("全体の予算は 0 より大きい金額か、無制限にしてください");
      if (budget !== undefined) setDefaultTicketBudget(p, budget);
      if (total !== undefined) setProjectBudget(p, total);
      if (typeof body.nonstop === "boolean") p.setSetting("nonstop", body.nonstop ? "1" : "0");
      if (typeof body.autoMerge === "boolean") p.setSetting("auto_merge", body.autoMerge ? "1" : "0");
      if (typeof body.resumeChecks === "boolean") p.setSetting("resume_checks", body.resumeChecks ? "1" : "0");
      this.poke(id);
      return { name: rec.name };
    }
    if (b === "formation" && method === "POST") {
      const f = saveFormationInput(p, body);
      this.poke(id);
      return { version: f.version };
    }
    if (b === "policies" && c && method === "POST") return { version: savePolicyInput(p, c, body).version };
    if (b === "studio") {
      const out = this.studioRoute(p, id, method, parts.slice(3), body);
      if (method === "POST") this.poke(id);
      return out;
    }
    return undefined;
  }

  private studioRoute(p: Project, id: number, method: string, parts: string[], body: Record<string, unknown>): unknown {
    const [a, key, c] = parts;
    const stage = (s: unknown): Stage => {
      if (!STAGES.includes(s as Stage)) throw new Error(`段階 ${String(s)} はありません`);
      return s as Stage;
    };
    if (!a && method === "GET") return this.studioViewOf(id);
    if (method !== "POST") return undefined;
    switch (a) {
      case "chat": {
        const text = String(body.text ?? "").trim();
        if (!text) throw new Error("メッセージがありません");
        chat(p, body.stage === "handoff" ? "handoff" : stage(body.stage), text);
        return { ok: true };
      }
      case "open-items":
        answerOpenItem(p, Number(key), String(body.answer ?? "").trim() || (() => { throw new Error("答えがありません"); })());
        return { ok: true };
      case "stages":
        if (c === "agree") agree(p, stage(key));
        else if (c === "mode") setMode(p, stage(key), body.mode as Mode);
        else return undefined;
        return { ok: true };
      case "screens":
        if (c === "pick") pickVariant(p, String(key), String(body.variant));
        else if (c === "agree") agreeScreen(p, String(key));
        else if (c === "comments") addComment(p, String(key), { variant: String(body.variant), x: Number(body.x), y: Number(body.y), body: String(body.body ?? "").trim() || (() => { throw new Error("コメントがありません"); })() });
        else return undefined;
        return { ok: true };
      case "handoff":
        handoff(p);
        return { ok: true };
    }
    return undefined;
  }

  hqView() {
    const projects = this.hq.projects().map((rec) => {
      const p = this.project(rec.id);
      const m = metrics(p);
      const stages = STAGES.map((s) => ({ key: s, done: stageDone(p, s) }));
      return {
        id: rec.id,
        name: rec.name,
        status: rec.status,
        running: this.running.has(rec.id),
        planning: { handed: handedOff(p), stages: stages.length, stagesDone: stages.filter((s) => s.done).length, current: stages.find((s) => !s.done)?.key ?? null },
        repos: p.repos().map((r) => ({ fullName: r.full_name, role: r.role })),
        decisions: pendingOwnerDecisions(p).length,
        merges: suggestedMergeOrder(p).length,
        open: p.tickets().filter((t) => !["done", "dropped"].includes(t.stage)).length,
        working: get<{ n: number }>(p.db, "SELECT COUNT(*) AS n FROM runs WHERE ended_at IS NULL")?.n ?? 0,
        metrics: m,
      };
    });
    const queue = this.hq.projects().flatMap((rec) => {
      const p = this.project(rec.id);
      return [
        ...ownerPlanItems(p).map((x) => ({ projectId: rec.id, projectName: rec.name, kind: "plan", text: x.text, deadline: null })),
        ...pendingOwnerDecisions(p).map((d) => ({ projectId: rec.id, projectName: rec.name, kind: "decide", text: d.question.split("\n").pop(), deadline: d.deadline_at })),
        ...suggestedMergeOrder(p).map((t) => ({ projectId: rec.id, projectName: rec.name, kind: "merge", text: `#${t.number} ${t.title} を merge できます`, deadline: null })),
      ];
    });
    const order = { decide: 0, merge: 1, plan: 2 } as Record<string, number>;
    queue.sort((x, y) => (x.kind === y.kind ? String(x.deadline).localeCompare(String(y.deadline)) : order[x.kind]! - order[y.kind]!));
    return { projects, queue };
  }

  studioViewOf(id: number) {
    return { ...studioView(this.project(id)), project: { id, name: this.hq.project(id).name } };
  }

  projectView(id: number) {
    const p = this.project(id);
    const rec = this.hq.project(id);
    const members = new Map(p.activeMembers().concat(all(p.db, "SELECT * FROM members WHERE left_at IS NOT NULL")).map((m) => [m.id, m.name]));
    const working = new Map(
      all<{ id: number; ticket_id: number; member_id: number; role: string }>(p.db, "SELECT id, ticket_id, member_id, role FROM runs WHERE ended_at IS NULL AND ticket_id IS NOT NULL").map((r) => [r.ticket_id, r]),
    );
    const prs = new Map(
      all<{ ticket_id: number; number: number; full_name: string; ci: string | null; mergeable: string | null; fetched_at: string | null }>(
        p.db,
        "SELECT pr.ticket_id, pr.number, r.full_name, pr.ci, pr.mergeable, pr.fetched_at FROM pull_requests pr JOIN repos r ON r.id = pr.repo_id",
      ).map((r) => [r.ticket_id, r]),
    );
    const formation = p.currentFormation();
    const unblocks = mergeUnblocks(p);
    // 開発に一度でも取りかかったチケット(ボードで「未着手」と「開発中」を分ける)
    const started = new Set(all<{ ticket_id: number }>(p.db, "SELECT DISTINCT ticket_id FROM runs WHERE ticket_id IS NOT NULL AND role = 'dev'").map((r) => r.ticket_id));
    const tickets = p.tickets().map((t) => {
      const w = working.get(t.id);
      return {
        id: t.id,
        number: t.number,
        jiraKey: t.jira_key,
        title: t.title,
        stage: t.stage,
        rounds: t.rounds,
        started: started.has(t.id) || !!w,
        owner: t.owner_member_id ? members.get(t.owner_member_id) : null,
        worker: w ? { name: members.get(w.member_id), role: ROLE_LABEL[w.role as keyof typeof ROLE_LABEL], work: runWork(p, w.id, 3) } : null,
        pr: prs.get(t.id) ?? null,
        // リーダーの交通整理: まだなら triaging、先に終わらせるチケットが残っていれば waitFor
        triaging: !(get<{ triaged: number }>(p.db, "SELECT triaged FROM tickets WHERE id = ?", [t.id])?.triaged ?? 1),
        waitFor: blockers(p, t.id),
        // 同じ場所を触るチケットが先に進んでいて、まだ取りかかれないもの(ADR-0024)
        waitArea: areaWait(p, t.id),
        // waitFor のうち merge 待ちの棚にあるもの(責任者が merge を押せば外れる)
        waitMerge: mergeBlockers(p, t.id),
        // merge 待ちのとき: merge すると動き出すチケット
        unblocks: unblocks.get(t.id) ?? null,
        conflict: !!get(p.db, "SELECT 1 AS x FROM conflicts c JOIN pull_requests pr ON pr.id = c.pr_id WHERE pr.ticket_id = ? AND c.resolved_at IS NULL", [t.id]),
      };
    });
    const decisions = pendingOwnerDecisions(p).map((d) => {
      const t = p.ticket(d.ticket_id);
      return {
        id: d.id,
        ticket: { id: t.id, number: t.number, title: t.title, owner: t.owner_member_id ? members.get(t.owner_member_id) : null, rounds: t.rounds },
        question: d.question,
        options: (JSON.parse(d.options) as DecisionOption[]).map((o) => o.label),
        recommended: d.recommended,
        why: d.why,
        impact: d.impact,
        reversible: !!d.reversible,
        deadline: d.deadline_at,
        leadNote: d.lead_note,
        pr: prs.get(t.id) ?? null,
      };
    });
    return {
      project: { id, name: rec.name, status: rec.status, dataDir: rec.data_dir, handed: handedOff(p) },
      running: this.running.has(id),
      repos: p.repos(),
      stages: pipelineOf(formation).map((r) => ({ key: r, label: ROLE_LABEL[r] })),
      formation: { version: formation.version, units: formation.units.map((u) => ({ name: u.name, roles: u.roles, max: u.max_members, repos: u.repos, model: u.model, effort: u.effort, members: p.membersOfUnit(u.id).map((m) => m.name) })) },
      tickets,
      decisions,
      mergeOrder: suggestedMergeOrder(p).map((t) => t.id),
      budget: budgetView(p),
      autoMerge: autoMergeEnabled(p),
      events: p.events(30),
      metrics: metrics(p),
      spentUsd: get<{ s: number | null }>(p.db, "SELECT SUM(cost_usd) AS s FROM runs")?.s ?? 0,
    };
  }

  /** 要件と技術的な設計を Markdown でダウンロードさせる。 */
  private sendExport(id: number, res: ServerResponse): void {
    const name = this.hq.project(id).name;
    const md = exportDesignDoc(this.project(id), name);
    const file = `${name}-設計書.md`;
    res.writeHead(200, {
      "content-type": "text/markdown; charset=utf-8",
      "content-disposition": `attachment; filename="design.md"; filename*=UTF-8''${encodeURIComponent(file)}`,
      "x-kuramoto-build": BUILD_ID,
    });
    res.end(md);
  }

  private async serveStatic(pathname: string, res: ServerResponse): Promise<void> {
    const rel = pathname === "/" ? "index.html" : normalize(pathname).replace(/^([/\\])+/, "");
    if (rel.includes("..")) return send(res, 404, { error: "ありません" });
    try {
      const data = await readFile(join(this.deps.webDir ?? WEB_DIR, rel));
      res.writeHead(200, { "content-type": MIME[extname(rel)] ?? "application/octet-stream", "cache-control": "no-store" });
      res.end(data);
    } catch {
      send(res, 404, { error: rel === "index.html" ? "画面がビルドされていません。npm start(または npm run build:ui)で起動してください" : "ありません" });
    }
  }
}

/** 画面(ui/)が受け取る API の形。サーバーの戻り値から型を作り、画面とずれないようにする。 */
export type HqView = ReturnType<KuramotoServer["hqView"]>;
export type ProjectView = ReturnType<KuramotoServer["projectView"]>;
export type StudioView = ReturnType<KuramotoServer["studioViewOf"]>;
export type TeamView = ReturnType<typeof teamView>;
export type ProductivityView = ReturnType<typeof productivity>;
export type OfficeView = ReturnType<typeof officeView> & { running: boolean };
export type { MemberView, UnitView };
export type TicketView = ReturnType<typeof ticketView>;
export type LeadChatView = ReturnType<typeof leadChatView>;

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
};

function isLocalHost(host: string | undefined): boolean {
  return !!host && /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host);
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "x-kuramoto-build": BUILD_ID });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

// 直接起動したとき
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const port = Number(process.env.KURAMOTO_PORT ?? 4300);
  const app = new KuramotoServer({ hq: new Hq() });
  app.resume();
  const server = createServer((req, res) => void app.handle(req, res));
  server.listen(port, "127.0.0.1", () => console.log(`Kuramoto: http://localhost:${port}`));
  const shutdown = () => {
    app.close();
    server.close(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
