import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { networkInterfaces } from "node:os";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { all, get } from "./db/sqlite.js";
import { isPreDev, pipelineOf } from "./domain/formation.js";
import { KIND_LABEL, TICKET_KINDS, type TicketKind } from "./domain/flow.js";
import { ROLE_LABEL } from "./domain/roles.js";
import { ClaudeAgentSdkHarness } from "./harness/claude-agent-sdk.js";
import type { Harness } from "./harness/types.js";
import { GhCli, type GitHub } from "./github/github.js";
import { ConfigError, loadStartupConfig } from "./config.js";
import { currentWorkspaceId, Hq, kuramotoHome, workDirFor, type ProjectRecord } from "./hq.js";
import { Dispatcher } from "./project/dispatcher.js";
import { recoverStale } from "./project/inbox.js";
import { autoMerge, autoMergeEnabled, ownerMerge, suggestedMergeOrder, type TeamCiHook } from "./project/merge.js";
import { patrolMinutes, setPatrolMinutes, startPatrol } from "./project/patrol.js";
import { ciBlockAction, ciBlocked, githubDown } from "./project/outage.js";
import { fetchGithubSnapshot, markExisting } from "./project/onboard.js";
import { runTeamCi, SandboxRunner, teamCiEnabled, type CommandRunner } from "./project/team-ci.js";
import { leadReply } from "./project/leadchat.js";
import { FileDesignStore, imageRow, playwrightRenderer, referenceImage, type DesignStore, type Renderer } from "./project/design-visual.js";
import { zip } from "./project/zip.js";
import { planWebDomains, planWebEnabled } from "./project/web-access.js";
import { metrics } from "./project/metrics.js";
import { exportDesignDoc } from "./project/export.js";
import { extractTransfer, restoreTransfer } from "./project/transfer.js";
import { runWork } from "./project/progress.js";
import { saveFormationInput, savePolicyInput, teamView } from "./project/team.js";
import { addDevRule, deleteDevRule, devRulesView, openViolations, setDevRuleEnabled, updateDevRule } from "./project/dev-rules.js";
import { productivity } from "./project/productivity.js";
import { officeView } from "./project/office.js";
import { memberView, unitView, type MemberView, type UnitView } from "./project/people.js";
import { ticketView } from "./project/ticket.js";
import { leadChatView, sayToLead } from "./project/leadchat.js";
import { memberChatView, memberNow, sayToMember } from "./project/member-chat.js";
import { areaWait, blockers, dependsOn, mergeBlockers, mergeUnblocks } from "./project/triage.js";
import { budgetView, projectBudgetUsd, projectSpentUsd, setProjectBudget } from "./project/budget.js";
import type { Project } from "./project/project.js";
import { GitWorkspace, type Workspace } from "./project/workspace.js";
import { answerDecision, createTicket, defaultTicketBudgetUsd, droppedInfo, nonstop, pendingOwnerDecisions, reopenTicket, resumeChecks, setDefaultTicketBudget, setTicketBudget, setTicketKind, type DecisionOption } from "./project/workflow.js";
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
  type Stage, setStudioPaused, studioPaused, screens } from "./project/planning.js";

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
  /** チームの CI のコマンドを流す(テストで差し替える)。既定は閉じ込めの中で流す。 */
  checkRunner?: CommandRunner;
  /** 画面の画像の置き場所(既定はデータの置き場所のファイル)と、試作を画像にする描き手(既定は手元の Chrome)。 */
  designStoreFor?: (dataDir: string) => DesignStore;
  renderer?: Renderer;
  /**
   * 他の PC から見られるようにする(npm run start:public)。どの Host でも受けるが、合言葉(トークン)を求める。
   * 合言葉は URL の ?token= で一度渡すと Cookie に入り、以後はそれで通る。この PC 自身(localhost)からは合言葉なしで使える。
   */
  publicToken?: string;
};

/**
 * ローカルサーバー(docs/design.md 3.1)。画面を配り、API を受け、稼働中のプロジェクトのディスパッチャを回す。
 * localhost だけで待ち受け、書き込みの API には独自のヘッダーを求める(他のサイトからの書き込みを防ぐ)。
 * 公開するとき(publicToken)は、localhost 以外からの接続に合言葉を求める。
 */
export class KuramotoServer {
  private readonly projects = new Map<number, Project>();
  private readonly runners = new Map<number, { timer: NodeJS.Timeout; mergeTimer: NodeJS.Timeout; busy: boolean; dispatcher: Dispatcher; tick: () => Promise<void>; teamCi: TeamCiHook }>();
  /** チームの CI のコマンドを閉じ込めの中で流す(プロセスで 1 つ。1 度に 1 つずつ流す)。 */
  private readonly checkRunner: CommandRunner;
  /** オフィス(チケットの仕事)を動かしているプロジェクト。企画スタジオの担当は止めていても動く。 */
  private readonly running = new Set<number>();
  private readonly records = new Map<number, ProjectRecord>();
  private readonly opening = new Map<number, Promise<Project>>();
  private readonly looping = new Set<number>();
  private readonly harnesses: Record<string, Harness>;
  private readonly github: GitHub;
  private readonly workspaceFor: (dataDir: string) => Workspace;
  private readonly mergePollMs: number;

  constructor(private readonly deps: ServerDeps) {
    this.harnesses = deps.harnesses ?? { "claude-agent-sdk": new ClaudeAgentSdkHarness() };
    this.github = deps.github ?? new GhCli();
    this.mergePollMs = deps.mergePollMs ?? MERGE_POLL_MS;
    this.workspaceFor = deps.workspaceFor ?? ((d) => new GitWorkspace(workDirFor(d)));
    this.checkRunner = deps.checkRunner ?? new SandboxRunner();
  }

  get hq(): Hq {
    return this.deps.hq;
  }

  /** すべてのプロジェクトの受信箱を見始める。前回「稼働中」のまま止めたものはオフィスも再開する。 */
  async resume(): Promise<void> {
    for (const rec of await this.hq.projects()) {
      if (rec.status === "running") this.running.add(rec.id);
      // 止まっている間に始められるようになった段階があれば始める
      advance(await this.open(rec.id));
      await this.loop(rec.id);
    }
  }

  /**
   * 入口: プロジェクトの id がいまのワークスペースの中にあるかを本部で確かめ、DB を開いて(開いてあれば再利用して)返す。
   * ワークスペースの外・無い id は投げる。以後の project(id) / record(id) は、ここで開いたものを同期で引く。
   */
  async open(id: number): Promise<Project> {
    this.records.set(id, await this.hq.project(id));
    const known = this.projects.get(id);
    if (known) return known;
    let opening = this.opening.get(id);
    if (!opening) {
      opening = this.hq.openProject(id).then((p) => {
        this.projects.set(id, p);
        return p;
      });
      this.opening.set(id, opening);
      opening.then(() => this.opening.delete(id), () => this.opening.delete(id));
    }
    return opening;
  }

  /** open() で開いてあるプロジェクト。開いていなければ投げる。 */
  project(id: number): Project {
    const p = this.projects.get(id);
    if (!p) throw new Error(`プロジェクト ${id} がありません`);
    return p;
  }

  /** open() で確かめた本部の記録(名前・データの置き場所など)。 */
  record(id: number): ProjectRecord {
    const r = this.records.get(id);
    if (!r) throw new Error(`プロジェクト ${id} がありません`);
    return r;
  }

  /** オフィスを動かす。 */
  async start(id: number): Promise<void> {
    this.running.add(id);
    await this.hq.setStatus(id, "running");
    // 始業したら、リーダーがまずボードを見回る(重複・回り続けているチケット。ADR-0026)
    startPatrol(this.project(id));
    await this.loop(id);
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
  async stop(id: number): Promise<void> {
    this.running.delete(id);
    await this.hq.setStatus(id, handedOff(this.project(id)) ? "starting" : "planning");
  }

  /** プロジェクトの受信箱を見回るループ。1 プロジェクトに 1 つ。 */
  private async loop(id: number): Promise<void> {
    if (this.runners.has(id) || this.looping.has(id)) return;
    this.looping.add(id);
    const p = this.project(id);
    try {
      await recoverStale(p);
    } finally {
      this.looping.delete(id);
    }
    if (this.runners.has(id)) return;
    const workspace = this.workspaceFor(this.record(id).data_dir);
    // merge の直前にチームの CI を流す口(ADR-0028)
    const teamCi: TeamCiHook = {
      run: (t, repo, branch) => runTeamCi(p, workspace, this.checkRunner, t, repo, branch),
      baseSha: (repo) => workspace.baseSha?.(repo) ?? Promise.resolve(""),
    };
    const dispatcher = new Dispatcher(p, {
      harnesses: this.harnesses,
      checkRunner: this.checkRunner,
      designStore: this.designStoreFor(id),
      renderer: this.deps.renderer ?? playwrightRenderer,
      workspace,
      ticketsAllowed: () => this.running.has(id),
      triage: true,
      github: this.github,
    });
    // チームが自動で merge する(ADR-0022)。始業中だけ。merge できたら、待っていた後のチケットが動けるように受信箱を見直す
    let merging = false;
    const merge = async (): Promise<void> => {
      if (merging || !this.running.has(id) || !autoMergeEnabled(p)) return;
      merging = true;
      try {
        if (await autoMerge(p, this.github, { teamCi })) this.poke(id);
      } catch (e) {
        p.event("system", "dispatcher_error", null, { error: e instanceof Error ? e.message : String(e) });
      } finally {
        merging = false;
      }
    };
    const r = {
      busy: false,
      dispatcher,
      teamCi,
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

  /**
   * CI の扱いを切り替える(ADR-0028)。チームの CI にするなら、リポジトリの GitHub Actions を止める(戻すなら動かす)。
   * Actions を切り替えられなかった(権限が無い等)ときは、チームの CI には切り替えたうえで、責任者に知らせる。
   */
  private async setCiMode(p: Project, mode: "team" | "github"): Promise<void> {
    p.setSetting("ci_mode", mode);
    const done: string[] = [];
    const failed: string[] = [];
    for (const r of p.repos()) {
      try {
        if (!this.github.setActionsEnabled) throw new Error("この環境では切り替えられません");
        await this.github.setActionsEnabled(r.full_name, mode === "github");
        done.push(r.full_name);
      } catch (e) {
        failed.push(`${r.full_name}(${(e instanceof Error ? e.message : String(e)).slice(0, 200)})`);
      }
    }
    p.event("owner", "ci_mode", null, { mode, done, failed });
    leadReply(
      p,
      mode === "team"
        ? `【チームの CI に切り替えました】これからは、担当が PR を出すたびに Kuramoto が閉じ込めの中で確認を流し、通ったものだけをレビューに回します。merge の直前にも、main が進んでいれば流し直します。GitHub の CI は待ちません。${done.length ? `\n${done.join("・")} の GitHub Actions を止めました。` : ""}${failed.length ? `\nGitHub Actions を止められませんでした: ${failed.join("・")}。リポジトリの Settings > Actions で止めてください。` : ""}\nリポジトリのブランチ保護で「CI の確認が通ること」を必須にしていると、GitHub が merge を断ります。そのときは必須の確認を外してください。`
        : `【GitHub Actions の CI に戻しました】これからは merge の前に GitHub の CI を待ちます。${done.length ? `\n${done.join("・")} の GitHub Actions を動かしました。` : ""}${failed.length ? `\nGitHub Actions を動かせませんでした: ${failed.join("・")}。リポジトリの Settings > Actions で動かしてください。` : ""}`,
    );
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
    if (this.checkRunner instanceof SandboxRunner) void this.checkRunner.close();
  }

  // ---- API ----

  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (!this.allowed(req, url, res)) return;
      if (!url.pathname.startsWith("/api/")) return await this.serveStatic(url.pathname, res);
      if (req.method !== "GET" && req.headers["x-kuramoto"] !== "1") return send(res, 403, { error: "ヘッダーがありません" });
      const exp = req.method === "GET" && url.pathname.match(/^\/api\/projects\/(\d+)\/studio\/export$/);
      if (exp) return await this.sendExport(Number(exp[1]), res);
      const expZip = req.method === "GET" && url.pathname.match(/^\/api\/projects\/(\d+)\/studio\/export\.zip$/);
      if (expZip) return await this.sendExportZip(Number(expZip[1]), res);
      const img = req.method === "GET" && url.pathname.match(/^\/api\/projects\/(\d+)\/design-images\/(\d+)$/);
      if (img) return await this.sendDesignImage(Number(img[1]), Number(img[2]), res);
      const body = req.method === "GET" ? {} : await readJson(req);
      const out = await this.route(req.method ?? "GET", url.pathname.split("/").filter(Boolean).slice(1), body);
      if (out === undefined) return send(res, 404, { error: "ありません" });
      send(res, 200, out);
    } catch (e) {
      send(res, 400, { error: e instanceof Error ? e.message : String(e) });
    }
  }

  /** 入ってよいか。だめなら応答を返して false。合言葉つきの URL で来たら Cookie に入れて、合言葉を外した URL へ送り直す。 */
  private allowed(req: IncomingMessage, url: URL, res: ServerResponse): boolean {
    const local = isLocalHost(req.headers.host) && isLoopback(req.socket.remoteAddress);
    const token = this.deps.publicToken;
    if (!token) {
      if (isLocalHost(req.headers.host)) return true;
      send(res, 403, { error: "localhost からだけ使えます" });
      return false;
    }
    if (local) return true;
    const given = url.searchParams.get("token");
    if (given !== null && sameSecret(given, token)) {
      url.searchParams.delete("token");
      res.writeHead(303, { location: url.pathname + url.search, "set-cookie": `${TOKEN_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${60 * 60 * 24 * 365}` });
      res.end();
      return false;
    }
    const cookie = parseCookies(req.headers.cookie)[TOKEN_COOKIE];
    const bearer = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
    if ((cookie && sameSecret(cookie, token)) || (bearer && sameSecret(bearer, token))) return true;
    if (url.pathname.startsWith("/api/")) send(res, 401, { error: "合言葉(トークン)が要ります" });
    else {
      res.writeHead(401, { "content-type": "text/html; charset=utf-8" });
      res.end('<!doctype html><meta charset="utf-8"><title>Kuramoto</title><p style="font-family:sans-serif;padding:24px">Kuramoto を開くには、起動したターミナルに出ている「合言葉つきの URL」を開いてください。</p>');
    }
    return false;
  }

  private async route(method: string, parts: string[], body: Record<string, unknown>): Promise<unknown> {
    const [a, idStr, b, c] = parts;
    if (a === "hq" && method === "GET") return this.hqView();
    if (a !== "projects") return undefined;
    if (idStr === "import" && method === "POST") {
      // 書き出した設計書から、新しいプロジェクトとして復元する
      const data = extractTransfer(String(body.markdown ?? ""));
      const rec = await this.hq.createProject(data.project.name, data.repos);
      await restoreTransfer(await this.open(rec.id), data);
      await this.hq.setStatus(rec.id, handedOff(this.project(rec.id)) ? "starting" : "planning");
      advance(this.project(rec.id));
      await this.loop(rec.id);
      return { id: rec.id };
    }
    if (!idStr && method === "POST") {
      const repos = (body.repos as { fullName: string; role: string }[] | undefined) ?? [];
      const rec = await this.hq.createProject(String(body.name ?? ""), repos.map((r) => ({ fullName: String(r.fullName).trim(), role: String(r.role) })));
      await this.open(rec.id);
      // 既存のリポジトリの続きから: GitHub の途中の仕事(開いている PR・Issue)を取ってきてから、担当に現状を読ませる(ADR-0030)
      if (body.mode === "existing") {
        markExisting(await this.open(rec.id), typeof body.issueLabel === "string" ? body.issueLabel : "kuramoto");
        await fetchGithubSnapshot(this.project(rec.id), this.github);
      }
      // リポジトリを登録したら、企画スタジオの企画担当が要件を聞き始める(既存なら現状を読み始める)
      advance(this.project(rec.id));
      await this.loop(rec.id);
      return { id: rec.id };
    }
    const id = Number(idStr);
    if (!Number.isInteger(id)) return undefined;
    const p = await this.open(id); // 入口: id がいまのワークスペースの中にあるかを確かめる
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
    // 責任者がチケットの種類を変える。次の工程から新しい種類の流れで進み、変えたことはやりとりに残る(R17)
    if (b === "tickets" && c && parts[4] === "kind" && method === "POST") {
      setTicketKind(p, Number(c), body.kind);
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
      const t = createTicket(p, { title, body: String(body.body ?? ""), ...(body.kind === undefined ? {} : { kind: body.kind as TicketKind }) });
      this.poke(id);
      return t;
    }
    if (b === "decisions" && c && method === "POST") {
      answerDecision(p, Number(c), Number(body.choice), typeof body.note === "string" ? body.note : undefined);
      this.poke(id);
      return { ok: true };
    }
    if (b === "merge" && c && method === "POST") {
      await this.loop(id);
      return ownerMerge(p, this.github, Number(c), "owner", { teamCi: this.runners.get(id)!.teamCi });
    }
    if (b === "run" && method === "POST") {
      if (body.running) await this.start(id);
      else await this.stop(id);
      return { running: this.running.has(id) };
    }
    if (b === "team" && method === "GET") return teamView(p);
    if (b === "productivity" && method === "GET") return productivity(p);
    if (b === "dev-rules" && !c && method === "GET") return devRulesView(p);
    if (b === "dev-rules" && !c && method === "POST") {
      addDevRule(p, {
        ...(typeof body.template === "string" ? { template: body.template } : {}),
        ...(typeof body.name === "string" ? { name: body.name } : {}),
        ...(typeof body.body === "string" ? { body: body.body } : {}),
        ...(Array.isArray(body.appliesTo) ? { appliesTo: body.appliesTo as never } : {}),
        ...(typeof body.check === "string" ? { check: body.check as never } : {}),
        ...(typeof body.pattern === "string" ? { pattern: body.pattern } : {}),
        ...(typeof body.onFail === "string" ? { onFail: body.onFail as never } : {}),
      });
      return devRulesView(p);
    }
    if (b === "dev-rules" && c && !parts[4] && method === "POST") {
      updateDevRule(p, Number(c), {
        ...(typeof body.name === "string" ? { name: body.name } : {}),
        ...(typeof body.body === "string" ? { body: body.body } : {}),
        ...(Array.isArray(body.appliesTo) ? { appliesTo: body.appliesTo as never } : {}),
        ...(typeof body.check === "string" ? { check: body.check as never } : {}),
        ...(typeof body.pattern === "string" ? { pattern: body.pattern } : {}),
        ...(typeof body.onFail === "string" ? { onFail: body.onFail as never } : {}),
      });
      return devRulesView(p);
    }
    if (b === "dev-rules" && c && parts[4] === "delete" && method === "POST") {
      deleteDevRule(p, Number(c));
      return devRulesView(p);
    }
    if (b === "dev-rules" && c && parts[4] === "enabled" && method === "POST") {
      setDevRuleEnabled(p, Number(c), body.enabled === true);
      return devRulesView(p);
    }
    if (b === "office" && method === "GET") return { ...(await officeView(p)), running: this.running.has(id) };
    // メンバーの今していること・話す欄(オフィスでメンバーを押して開く引き出し)
    if (b === "members" && c && parts[4] === "now" && method === "GET") return memberNow(p, Number(c));
    if (b === "members" && c && parts[4] === "chat" && method === "GET") return memberChatView(p, Number(c));
    if (b === "members" && c && parts[4] === "chat" && method === "POST") {
      sayToMember(p, Number(c), String(body.body ?? ""));
      this.poke(id);
      return memberChatView(p, Number(c));
    }
    if (b === "members" && c && method === "GET") return memberView(p, Number(c));
    if (b === "units" && c && method === "GET") return unitView(p, Number(c), await officeView(p));
    if (b === "lead-chat" && method === "GET") return leadChatView(p);
    if (b === "lead-chat" && method === "POST") {
      sayToLead(p, String(body.body ?? ""));
      this.poke(id);
      return leadChatView(p);
    }
    if (b === "settings" && method === "GET")
      return {
        name: this.record(id).name,
        dataDir: this.record(id).data_dir,
        repos: p.repos().map((r) => ({ fullName: r.full_name, role: r.role })),
        ticketBudgetUsd: defaultTicketBudgetUsd(p),
        projectBudgetUsd: projectBudgetUsd(p),
        projectSpentUsd: projectSpentUsd(p),
        nonstop: nonstop(p),
        autoMerge: autoMergeEnabled(p),
        resumeChecks: resumeChecks(p),
        patrolMin: patrolMinutes(p),
        planWeb: planWebEnabled(p),
        planWebDomains: planWebDomains(p).join("\n"),
        ciMode: teamCiEnabled(p) ? "team" : "github",
        // チームの CI で流すコマンド(リポジトリごと)。空なら package.json から決める
        ciCommands: Object.fromEntries(p.repos().map((r) => [r.full_name, p.setting(`team_ci_commands:${r.full_name}`) ?? ""])),
      };
    if (b === "settings" && method === "POST") {
      const budget = body.ticketBudgetUsd === undefined ? undefined : body.ticketBudgetUsd === null ? null : Number(body.ticketBudgetUsd);
      if (budget !== undefined && budget !== null && !(Number.isFinite(budget) && budget > 0)) throw new Error("チケット 1 枚の予算は 0 より大きい金額か、無制限にしてください");
      const repos = (body.repos as { fullName: string; role: string }[] | undefined) ?? [];
      const rec = await this.hq.updateProject(p, id, { name: String(body.name ?? ""), repos: repos.map((r) => ({ fullName: String(r.fullName).trim(), role: String(r.role) })) });
      const total = body.projectBudgetUsd === undefined ? undefined : body.projectBudgetUsd === null || body.projectBudgetUsd === "" ? null : Number(body.projectBudgetUsd);
      if (total !== undefined && total !== null && !(Number.isFinite(total) && total > 0)) throw new Error("全体の予算は 0 より大きい金額か、無制限にしてください");
      if (budget !== undefined) setDefaultTicketBudget(p, budget);
      if (total !== undefined) setProjectBudget(p, total);
      if (typeof body.nonstop === "boolean") p.setSetting("nonstop", body.nonstop ? "1" : "0");
      if (typeof body.autoMerge === "boolean") p.setSetting("auto_merge", body.autoMerge ? "1" : "0");
      if (typeof body.resumeChecks === "boolean") p.setSetting("resume_checks", body.resumeChecks ? "1" : "0");
      if (body.patrolMin !== undefined) setPatrolMinutes(p, Number(body.patrolMin));
      if (typeof body.planWeb === "boolean") p.setSetting("plan_web", body.planWeb ? "1" : "0");
      if (typeof body.planWebDomains === "string") p.setSetting("plan_web_domains", body.planWebDomains.trim());
      if (body.ciCommands && typeof body.ciCommands === "object")
        for (const [repo, cmds] of Object.entries(body.ciCommands as Record<string, unknown>)) p.setSetting(`team_ci_commands:${repo}`, String(cmds ?? "").trim());
      if ((body.ciMode === "team" || body.ciMode === "github") && (body.ciMode === "team") !== teamCiEnabled(p)) await this.setCiMode(p, body.ciMode);
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
      case "pause": {
        // 企画スタジオを止める(動いている担当もその場で止める)・再開する
        setStudioPaused(p, !!body.paused);
        if (body.paused) this.runners.get(id)?.dispatcher.stopPlanning();
        else this.poke(id);
        return { paused: !!studioPaused(p) };
      }
      case "chat": {
        const text = String(body.text ?? "").trim();
        if (!text) throw new Error("メッセージがありません");
        chat(p, body.stage === "handoff" ? "handoff" : stage(body.stage), text, body.kind === "question" ? "question" : "chat");
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

  async hqView() {
    const recs = await this.hq.projects();
    for (const rec of recs) await this.open(rec.id);
    const projects = await Promise.all(recs.map(async (rec) => {
      const p = this.project(rec.id);
      const m = await metrics(p);
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
    }));
    const queue = recs.flatMap((rec) => {
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

  async studioViewOf(id: number) {
    await this.open(id);
    return { ...studioView(this.project(id)), project: { id, name: this.record(id).name } };
  }

  async projectView(id: number) {
    const p = await this.open(id);
    const rec = this.record(id);
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
        // 種類(R17)。preDev: 開発より前の確認(申し送りだけを残す工程)にいる
        kind: t.kind,
        kindLabel: KIND_LABEL[t.kind as TicketKind] ?? t.kind,
        preDev: !t.dev_done && isPreDev(pipelineOf(formation, t.kind), t.stage as never),
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
        // 取りやめたとき: 誰が・なぜ・いつ(ボードの「取りやめ」に出す)
        dropped: droppedInfo(p, t.id),
        // 「直すまで進めない」ルールに反して止まっているルールの名前(ボードの赤い札)
        ruleBlocked: openViolations(p, t.id, "blocked").map((v) => v.name),
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
      // 種類ごとの流れ(ボードを種類で絞ったときの列の順)。開発より前の工程は preDev(申し送りだけの工程)
      kinds: TICKET_KINDS.map((k) => {
        const pipeline = pipelineOf(formation, k);
        return {
          key: k,
          label: KIND_LABEL[k],
          stages: pipeline.map((r) => ({ key: r, label: ROLE_LABEL[r], preDev: isPreDev(pipeline, r) })),
          // 編成にはあるが、この種類の流れでは省く工程(ボードの「セキュリティは省略」)
          omitted: pipelineOf(formation).concat(TICKET_KINDS.flatMap((o) => pipelineOf(formation, o))).filter((r, i, a) => a.indexOf(r) === i && !pipeline.includes(r)).map((r) => ROLE_LABEL[r]),
        };
      }),
      // 工程の名前(流れに無い工程にいるチケットの列にも名前を付けるため)
      roleLabels: ROLE_LABEL as Record<string, string>,
      formation: { version: formation.version, units: formation.units.map((u) => ({ name: u.name, roles: u.roles, max: u.max_members, repos: u.repos, model: u.model, effort: u.effort, members: p.membersOfUnit(u.id).map((m) => m.name) })) },
      tickets,
      decisions,
      mergeOrder: suggestedMergeOrder(p).map((t) => t.id),
      budget: budgetView(p),
      autoMerge: autoMergeEnabled(p),
      // GitHub に入れない(認証切れ)とき: いつから・どんなエラーか(ADR-0027)
      githubDown: githubDown(p),
      // CI のジョブが始まらない(請求・上限など)リポジトリ。merge だけ止まっている
      ciBlocked: ciBlocked(p).map((b) => ({ ...b, action: ciBlockAction(b.notes) })),
      events: p.events(30),
      metrics: await metrics(p),
      spentUsd: get<{ s: number | null }>(p.db, "SELECT SUM(cost_usd) AS s FROM runs")?.s ?? 0,
    };
  }

  /** 要件と技術的な設計を Markdown でダウンロードさせる。 */
  /** 画面の画像(お手本・実装・違い)を返す(ADR-0034)。 */
  private async sendDesignImage(id: number, imageId: number, res: ServerResponse): Promise<void> {
    const row = await imageRow(await this.open(id), imageId);
    const data = row ? await this.designStoreFor(id).get(row.store_key) : null;
    if (!data) return send(res, 404, { error: "画像がありません" });
    res.writeHead(200, { "content-type": "image/png", "cache-control": "private, max-age=86400" });
    res.end(data);
  }

  /** 画面の画像の置き場所。既定はプロジェクトのデータの置き場所の design/(S3 に替えるときは deps.designStoreFor)。 */
  private designStoreFor(id: number): DesignStore {
    return this.deps.designStoreFor?.(this.record(id).data_dir) ?? new FileDesignStore(join(this.record(id).data_dir, "design"));
  }

  /**
   * 設計書と画面の画像を zip で書き出す。画像は、選んだ案を実際の端末の幅で描いたお手本(images/<画面>.png)。
   * 設計書から画像を参照するので、GitHub などに置いても画面の絵が出る。描けなかった画面は画像なしで書く。
   */
  private async sendExportZip(id: number, res: ServerResponse): Promise<void> {
    const p = await this.open(id);
    const name = this.record(id).name;
    const store = this.designStoreFor(id);
    const render = this.deps.renderer ?? playwrightRenderer;
    const images = new Map<string, string>();
    const files: { name: string; data: Buffer | string }[] = [];
    for (const [key, s] of screens(p)) {
      const v = s.variants.find((x) => x.id === s.chosen) ?? s.variants[0];
      if (!v) continue;
      const ref = await referenceImage(p, store, render, { key, html: v.html, device: s.device });
      if (!ref) continue;
      const file = `images/${key.replace(/[^A-Za-z0-9_-]/g, "_")}.png`;
      images.set(key, file);
      files.push({ name: file, data: ref.png });
    }
    files.unshift({ name: "design.md", data: await exportDesignDoc(p, name, { images }) });
    const body = zip(files);
    res.writeHead(200, {
      "content-type": "application/zip",
      "content-disposition": `attachment; filename="design.zip"; filename*=UTF-8''${encodeURIComponent(`${name}-設計書.zip`)}`,
      "x-kuramoto-build": BUILD_ID,
    });
    res.end(body);
  }

  private async sendExport(id: number, res: ServerResponse): Promise<void> {
    const p = await this.open(id);
    const name = this.record(id).name;
    const md = await exportDesignDoc(p, name);
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
export type HqView = Awaited<ReturnType<KuramotoServer["hqView"]>>;
export type ProjectView = Awaited<ReturnType<KuramotoServer["projectView"]>>;
export type StudioView = Awaited<ReturnType<KuramotoServer["studioViewOf"]>>;
export type TeamView = ReturnType<typeof teamView>;
export type DevRulesView = ReturnType<typeof devRulesView>;
export type ProductivityView = Awaited<ReturnType<typeof productivity>>;
export type OfficeView = Awaited<ReturnType<typeof officeView>> & { running: boolean };
export type { MemberView, UnitView };
export type TicketView = Awaited<ReturnType<typeof ticketView>>;
export type LeadChatView = ReturnType<typeof leadChatView>;
export type { MemberChatView, MemberNow } from "./project/member-chat.js";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
};

const TOKEN_COOKIE = "kuramoto_token";

function isLoopback(addr: string | undefined): boolean {
  return !!addr && (addr === "::1" || addr.startsWith("127.") || addr.startsWith("::ffff:127."));
}

function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/** 公開するときの合言葉。KURAMOTO_TOKEN があればそれ、なければ ~/.kuramoto/access-token に作って使い回す(本人だけが読める)。 */
function publicToken(): string {
  if (process.env.KURAMOTO_TOKEN) return process.env.KURAMOTO_TOKEN;
  const file = join(kuramotoHome(), "access-token");
  if (existsSync(file)) {
    const t = readFileSync(file, "utf8").trim();
    if (t) return t;
  }
  mkdirSync(kuramotoHome(), { recursive: true });
  const t = randomBytes(24).toString("base64url");
  writeFileSync(file, t + "\n", { mode: 0o600 });
  return t;
}

/** 他の PC から開ける URL(この PC の LAN の IPv4 アドレス)。 */
function lanUrls(port: number): string[] {
  return Object.values(networkInterfaces())
    .flat()
    .filter((i): i is NonNullable<typeof i> => !!i && i.family === "IPv4" && !i.internal)
    .map((i) => `http://${i.address}:${port}`);
}

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
  try {
    loadStartupConfig();
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    console.error(e.message);
    process.exit(1);
  }
  const port = Number(process.env.KURAMOTO_PORT ?? 4300);
  const open = process.env.KURAMOTO_PUBLIC === "1";
  const token = open ? publicToken() : undefined;
  // 入口で今のワークスペースを決め、本部へ渡す
  const app = new KuramotoServer({ hq: new Hq(undefined, undefined, currentWorkspaceId()), ...(token ? { publicToken: token } : {}) });
  await app.resume();
  const server = createServer((req, res) => void app.handle(req, res));
  server.listen(port, open ? "0.0.0.0" : "127.0.0.1", () => {
    console.log(`Kuramoto: http://localhost:${port}`);
    if (!token) return;
    console.log("他の PC からは、次の URL を開いてください(合言葉つき。一度開けば、そのブラウザでは以後合言葉なしで入れます):");
    for (const u of lanUrls(port)) console.log(`  ${u}/?token=${token}`);
    console.log("この URL を知っている人は、チームを動かし、あなたの GitHub に push できます。信頼できるネットワークでだけ使い、他人に渡さないでください。");
  });
  const shutdown = () => {
    app.close();
    server.close(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
