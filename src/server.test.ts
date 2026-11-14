import { fixedAll, withResolutions } from "./harness/fake.js";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeHarness } from "./harness/fake.js";
import { Hq } from "./hq.js";
import { teamBranch } from "./project/team-branch.js";
import { StaticWorkspace } from "./project/workspace.js";
import { KuramotoServer } from "./server.js";
import { leadMessages } from "./project/leadchat.js";
import type { Project } from "./project/project.js";
import { addDevRule } from "./project/dev-rules.js";
import { createTicket } from "./project/workflow.js";
import { run } from "./db/sqlite.js";
import { DbHealth } from "./db/mysql-health.js";
import { Sessions } from "./sessions.js";

const leadSaid = async (p: Project, text: string) => (await leadMessages(p)).some((m) => m.body.includes(text));

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((f) => f()));

/** テストの合言葉(ADR-0059)。API と画面は localhost からも合言葉を求めるので、call は Authorization: Bearer で渡す。 */
const TOKEN = "s3cret";

async function boot(opts: { workspaceFor?: (dataDir: string) => import("./project/workspace.js").Workspace; open?: boolean; renderer?: import("./project/design-visual.js").Renderer; dbHealth?: DbHealth } = {}) {
  const home = mkdtempSync(join(tmpdir(), "kuramoto-srv-"));
  const harness = new FakeHarness(async (req, call) => {
    if (req.tools.some((t) => t.name === "submit_pr")) await call("submit_pr", { summary: "", responses: fixedAll(req.prompt) });
    else if (req.tools.some((t) => t.name === "submit_review")) await call("submit_review", withResolutions(req.prompt, { verdict: "approve", findings: [] }));
    else return { finalText: "企画担当の咲季です。何のためのものですか?" };
  });
  const github = { openPulls: async () => [{ number: 3, title: "途中の PR", body: "", head: "wip", url: "u", draft: false, author: "a" }], openIssues: async () => [], merged: [] as number[], actions: [] as string[], setActionsEnabled: async (r: string, on: boolean) => void github.actions.push(`${r}:${on}`), prStatus: async () => ({ state: "OPEN" as const, mergeable: "MERGEABLE" as const, ci: "success" as const }), merge: async (_r: string, n: number) => void github.merged.push(n), comment: async () => "" };
  writeFileSync(join(home, "index.html"), "<!doctype html><title>Kuramoto</title>");
  const app = new KuramotoServer({ hq: new Hq(home), webDir: home, harnesses: { "claude-agent-sdk": harness }, github, workspaceFor: () => new StaticWorkspace(home, { prNumber: () => 5 }), accessToken: TOKEN, ...opts });
  const server: Server = createServer((req, res) => void app.handle(req, res));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  cleanups.push(() => { app.close(); server.close(); app.hq.close(); rmSync(home, { recursive: true, force: true }); });
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = { "x-kuramoto": "1" }) => {
    const res = await fetch(`http://localhost:${port}${path}`, { method, headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}`, ...headers }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, json: (await res.json().catch(() => null)) as any, text: res.headers.get("content-type") };
  };
  return { app, call, github, port };
}

describe("ローカルサーバー", () => {
  it("DELETE /api/projects/:id: 動きを止めて、そのプロジェクトの行と作業場所を消す。別のプロジェクトは残る", async () => {
    const workspaces: StaticWorkspace[] = [];
    const { call, app } = await boot({ workspaceFor: (d) => { const w = new StaticWorkspace(d, { prNumber: () => 5 }); workspaces.push(w); return w; } });
    const a = (await call("POST", "/api/projects", { name: "消す", repos: [{ fullName: "acme/shop", role: "API" }, { fullName: "acme/web", role: "UI" }] })).json.id as number;
    const b = (await call("POST", "/api/projects", { name: "残す", repos: [{ fullName: "acme/other", role: "API" }] })).json.id as number;
    await call("POST", `/api/projects/${a}/tickets`, { title: "CSV" });
    await call("POST", `/api/projects/${b}/tickets`, { title: "残る" });
    await call("POST", `/api/projects/${a}/run`, { running: true });
    await new Promise((r) => setTimeout(r, 100));
    const keep = app.project(b);
    // ヘッダーが無い書き込みは通さない(他の書き込みの API と同じ)
    expect((await call("DELETE", `/api/projects/${a}`, undefined, {})).status).toBe(403);
    expect((await app.hq.projects()).map((p) => p.id)).toEqual([a, b]);

    const res = await call("DELETE", `/api/projects/${a}`);
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ ok: true, failed: [] });
    expect((await app.hq.projects()).map((p) => p.id)).toEqual([b]);
    // 消したプロジェクトは開けない・もう 1 度消そうとしても何も起きない
    expect((await call("GET", `/api/projects/${a}`)).status).toBe(400);
    expect((await call("DELETE", `/api/projects/${a}`)).status).toBe(400);
    // 作業場所の片付けは、そのプロジェクトのリポジトリ全部に頼む(1 回だけ)
    expect(workspaces.flatMap((w) => w.removedProjects)).toEqual([["acme/shop", "acme/web"]]);
    // 残す側: 行も、動きも、そのまま
    expect((await keep.tickets()).map((t) => t.title)).toEqual(["残る"]);
    expect((await call("GET", `/api/projects/${b}`)).status).toBe(200);
    expect((await app.hq.project(b)).name).toBe("残す");
  });

  it("DELETE: データの置き場所(SQLite・design/ の画像)も消し、同じリポジトリで作り直すと元の置き場所が使われる(repo-2 にならない)", async () => {
    const { call, app } = await boot();
    const repos = [{ fullName: "acme/shop", role: "API" }];
    const a = (await call("POST", "/api/projects", { name: "消す", repos })).json.id as number;
    const other = (await call("POST", "/api/projects", { name: "残す", repos: [{ fullName: "acme/web", role: "UI" }] })).json.id as number;
    const dir = (await app.hq.project(a)).data_dir;
    const otherDir = (await app.hq.project(other)).data_dir;
    mkdirSync(join(dir, "design"), { recursive: true });
    writeFileSync(join(dir, "design", "shot.png"), "png");
    expect(existsSync(join(dir, "project.sqlite"))).toBe(true);

    expect((await call("DELETE", `/api/projects/${a}`)).json).toMatchObject({ ok: true, failed: [] });
    expect(existsSync(dir)).toBe(false);
    expect(existsSync(otherDir)).toBe(true); // 別のプロジェクトの置き場所は残る

    const again = (await call("POST", "/api/projects", { name: "作り直し", repos })).json.id as number;
    expect((await app.hq.project(again)).data_dir).toBe(dir);
    expect(existsSync(join(dir, "design", "shot.png"))).toBe(false);
  });

  it("Hq.removeDataDir: 本部の置き場所の外・置き場所そのものは消さない。owner の下が空になったら owner も片付ける", () => {
    const home = mkdtempSync(join(tmpdir(), "kuramoto-rm-"));
    const outside = mkdtempSync(join(tmpdir(), "kuramoto-out-"));
    const hq = new Hq(home);
    cleanups.push(() => { hq.close(); rmSync(home, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); });
    writeFileSync(join(outside, "keep.txt"), "x");
    expect(() => hq.removeDataDir(outside)).toThrow(/外/);
    expect(() => hq.removeDataDir(home)).toThrow(/外/);
    expect(() => hq.removeDataDir(join(home, "..", "x"))).toThrow(/外/);
    expect(existsSync(join(outside, "keep.txt"))).toBe(true);
    expect(existsSync(join(home, "hq.sqlite"))).toBe(true);

    mkdirSync(join(home, "acme", "shop", "design"), { recursive: true });
    mkdirSync(join(home, "acme", "web"), { recursive: true });
    hq.removeDataDir(join(home, "acme", "shop"));
    expect(existsSync(join(home, "acme", "shop"))).toBe(false);
    expect(existsSync(join(home, "acme", "web"))).toBe(true); // owner の下にまだあるので owner は残る
    hq.removeDataDir(join(home, "acme", "web"));
    expect(existsSync(join(home, "acme"))).toBe(false);
    hq.removeDataDir(join(home, "acme", "web")); // もう無くても通る
  });

  it("設定で、チームが使うブランチを見られて変えられる。存在しないブランチは保存を断り、空にすると未設定に戻る", async () => {
    const w = new StaticWorkspace("/tmp/ws", { branches: ["main", "develop"] });
    const { call, app } = await boot({ workspaceFor: () => w });
    const { json: created } = await call("POST", "/api/projects", { name: "お試し", repos: [{ fullName: "acme/shop", role: "API" }] });
    const url = `/api/projects/${created.id}/settings`;
    const repos = [{ fullName: "acme/shop", role: "API" }];
    expect((await call("GET", url)).json.teamBranch).toBe("");
    // 無いブランチは断る(保存されない)
    const bad = await call("POST", url, { name: "お試し", repos, teamBranch: "nope" });
    expect(bad.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(bad.json)).toContain("nope");
    expect((await call("GET", url)).json.teamBranch).toBe("");
    // ブランチ名として使えない形は、リポジトリに問い合わせる前に断る
    expect((await call("POST", url, { name: "お試し", repos, teamBranch: "-D" })).status).toBeGreaterThanOrEqual(400);
    // ある(リポジトリごとに確かめる)
    await call("POST", url, { name: "お試し", repos, teamBranch: " develop " });
    expect((await call("GET", url)).json.teamBranch).toBe("develop");
    expect(w.checkedBranches).toContainEqual({ repo: "acme/shop", branch: "develop" });
    expect(await teamBranch(app.project(created.id))).toBe("develop");
    // 変えていなければ確かめ直さない・送らなければ変わらない
    const n = w.checkedBranches.length;
    await call("POST", url, { name: "お試し", repos, teamBranch: "develop" });
    await call("POST", url, { name: "お試し", repos });
    expect(w.checkedBranches.length).toBe(n);
    expect((await call("GET", url)).json.teamBranch).toBe("develop");
    // 空にすると未設定(今どおり origin/HEAD → main)に戻る
    await call("POST", url, { name: "お試し", repos, teamBranch: "" });
    expect((await call("GET", url)).json.teamBranch).toBe("");
  });

  it("作業場所を消せなくても(投げても)DB の削除は進み、ログに残す", async () => {
    const w = new StaticWorkspace("/tmp/ws");
    w.removeProjectFiles = async () => { throw new Error("busy"); };
    const errors: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((m: string) => void errors.push(String(m)));
    try {
      const { call, app } = await boot({ workspaceFor: () => w });
      const id = (await call("POST", "/api/projects", { name: "消す", repos: [{ fullName: "acme/shop", role: "API" }] })).json.id as number;
      const res = await call("DELETE", `/api/projects/${id}`);
      expect(res.status).toBe(200);
      expect(res.json.failed).toHaveLength(1);
      expect(await app.hq.projects()).toEqual([]);
      expect(errors.some((e) => e.includes("busy"))).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it("DB(MySQL)が切れている間は受信箱の見回りとエージェントの起動を止めて待ち、画面にそう出す。繋がり直したら再開する(ADR-0041)", async () => {
    let alive = true;
    const health = new DbHealth(async () => {
      if (!alive) throw Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:3306"), { code: "ECONNREFUSED" });
    }, { intervalMs: 3_600_000 });
    const { call, app } = await boot({ dbHealth: health });
    const { json: created } = await call("POST", "/api/projects", { name: "お試し", repos: [{ fullName: "acme/shop", role: "API" }] });
    // 切れた(クエリが接続のエラーで落ちた)
    alive = false;
    health.reportFailure(Object.assign(new Error("lost"), { code: "PROTOCOL_CONNECTION_LOST", fatal: true }));
    await call("POST", `/api/projects/${created.id}/tickets`, { title: "CSV" });
    await call("POST", `/api/projects/${created.id}/run`, { running: true });
    await new Promise((r) => setTimeout(r, 300));
    // 待っている: エージェントは起動せず(起動の記録なし)、チケットの仕事は受信箱に残ったまま
    const p = app.project(created.id);
    expect((p.db.prepare("SELECT COUNT(*) AS n FROM runs WHERE role = 'dev'").get() as { n: number }).n).toBe(0);
    expect((p.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE kind = 'implement' AND status = 'pending'").get() as { n: number }).n).toBe(1);
    const view = (await call("GET", `/api/projects/${created.id}`)).json;
    expect(view.dbDown).toMatchObject({ error: "lost" });
    expect(view.dbDown.since).toBeTruthy();
    // まだ切れている間は、見張りの確認でも戻らない
    await health.check();
    expect(app.dbUp()).toBe(false);
    // 繋がり直した: 自動で再開し、仕事が merge 待ちまで進む
    alive = true;
    await health.check();
    expect(app.dbUp()).toBe(true);
    for (let i = 0; i < 100 && (await app.projectView(created.id)).mergeOrder.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
    expect((await app.projectView(created.id)).mergeOrder).toHaveLength(1);
    expect((await app.projectView(created.id)).dbDown).toBeNull();
  });

  it("画面から プロジェクト作成 → チケット → 稼働 → merge まで進められる", async () => {
    const { call, app, github } = await boot();
    expect((await call("GET", "/")).text).toContain("text/html");

    const { json: created } = await call("POST", "/api/projects", { name: "お試し", repos: [{ fullName: "acme/shop", role: "API" }] });
    await call("POST", `/api/projects/${created.id}/tickets`, { title: "CSV" });
    await call("POST", `/api/projects/${created.id}/run`, { running: true });

    for (let i = 0; i < 50 && (await app.projectView(created.id)).mergeOrder.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
    const hq = (await call("GET", "/api/hq")).json;
    expect(hq.queue).toMatchObject([{ kind: "merge", projectName: "お試し" }]);
    expect(hq.projects[0]).toMatchObject({ running: true, merges: 1 });

    // 始業したら、リーダーがまずボードを見回る(ADR-0026)
    const p = app.project(created.id);
    expect(await p.setting("patrol_last_at")).toBeTruthy();
    for (let i = 0; i < 50 && !(await leadSaid(p, "【見回り】")); i++) await new Promise((r) => setTimeout(r, 20));
    expect(await leadSaid(p, "【見回り】")).toBe(true);
    // 見回りの間隔はプロジェクトの設定で変えられる
    expect((await call("GET", `/api/projects/${created.id}/settings`)).json.patrolMin).toBe(5);
    await call("POST", `/api/projects/${created.id}/settings`, { name: "お試し", repos: [{ fullName: "acme/shop", role: "API" }], patrolMin: 10 });
    expect((await call("GET", `/api/projects/${created.id}/settings`)).json.patrolMin).toBe(10);
    // チームの CI に切り替えると、GitHub Actions を止める。戻すと動かす(ADR-0028)
    expect((await call("GET", `/api/projects/${created.id}/settings`)).json.ciMode).toBe("github");
    await call("POST", `/api/projects/${created.id}/settings`, { name: "お試し", repos: [{ fullName: "acme/shop", role: "API" }], ciMode: "team", ciCommands: { "acme/shop": "npm ci\nnpm test" } });
    expect((await call("GET", `/api/projects/${created.id}/settings`)).json).toMatchObject({ ciMode: "team", ciCommands: { "acme/shop": "npm ci\nnpm test" } });
    expect(await leadSaid(p, "【チームの CI に切り替えました】")).toBe(true);
    await call("POST", `/api/projects/${created.id}/settings`, { name: "お試し", repos: [{ fullName: "acme/shop", role: "API" }], ciMode: "github" });
    expect(github.actions).toEqual(["acme/shop:false", "acme/shop:true"]);

    const ticketId = (await app.projectView(created.id)).mergeOrder[0];
    expect((await call("POST", `/api/projects/${created.id}/merge/${ticketId}`)).json).toEqual({ result: "merged" });
    expect(github.merged).toEqual([5]);
    expect((await app.hq.project(created.id)).status).toBe("running");
  });

  it("オフィスの取得は、島・merge 待ちなどの中身と running を返す(async にした officeView を展開する)", async () => {
    const { call } = await boot();
    const { json: created } = await call("POST", "/api/projects", { name: "お試し", repos: [{ fullName: "acme/shop", role: "API" }] });
    const office = (await call("GET", `/api/projects/${created.id}/office`)).json;
    expect(office.running).toBe(false);
    expect(Array.isArray(office.units)).toBe(true);
    expect(office.units.length).toBeGreaterThan(0);
    expect(office.units[0].budget).toMatchObject({ spentUsd: 0, exhausted: false });
    expect(Array.isArray(office.mergeQueue)).toBe(true);
    // 島を指す口(officeView を引数に取る)も中身を返す
    const unit = (await call("GET", `/api/projects/${created.id}/units/${office.units[0].id}`)).json;
    expect(unit).toMatchObject({ id: office.units[0].id });
  });

  it("チケットに種類を付けて作り、責任者が API で変えると、やりとりに残り、次の工程から新しい流れになる(R17)", async () => {
    const { call, app } = await boot();
    const { json: created } = await call("POST", "/api/projects", { name: "種類", repos: [{ fullName: "acme/shop", role: "API" }] });
    const base = `/api/projects/${created.id}`;
    const p = app.project(created.id);
    const saved = await call("POST", `${base}/formation`, { pull: "down", units: [{ name: "開発", roles: ["dev"], maxMembers: 2, summonAt: 2, idleSec: 300 }, { name: "QA", roles: ["qa"], maxMembers: 2, summonAt: 2, idleSec: 300 }], flows: { bugfix: ["qa", "dev"] } });
    expect(saved.status).toBe(200);
    expect((await call("POST", `${base}/formation`, { pull: "down", units: [{ name: "開発", roles: ["dev"], maxMembers: 2, summonAt: 2, idleSec: 300 }], flows: { bugfix: ["qa"] } })).status).toBe(400);

    const t = (await call("POST", `${base}/tickets`, { title: "落ちる", kind: "bugfix" })).json;
    expect(await p.ticket(t.id)).toMatchObject({ kind: "bugfix", stage: "qa" });
    const changed = await call("POST", `${base}/tickets/${t.id}/kind`, { kind: "feature" });
    expect(changed.json).toMatchObject({ kind: "feature", stage: "qa" });
    expect(changed.json.timeline.some((i: { type: string }) => i.type === "kind_change")).toBe(true);
    expect((await call("POST", `${base}/tickets/${t.id}/kind`, { kind: "chore" })).status).toBe(400);
  });

  it("ボードの API は、チケットの種類と、種類ごとの流れ(開発より前の工程の印つき)を返す。生産性の表にも種類が入る(R17)", async () => {
    const { call } = await boot();
    const { json: created } = await call("POST", "/api/projects", { name: "ボード", repos: [{ fullName: "acme/shop", role: "API" }] });
    const base = `/api/projects/${created.id}`;
    await call("POST", `${base}/formation`, { pull: "down", units: [{ name: "開発", roles: ["dev"], maxMembers: 2, summonAt: 2, idleSec: 300 }, { name: "QA", roles: ["qa"], maxMembers: 2, summonAt: 2, idleSec: 300 }], flows: { bugfix: ["qa", "dev"] } });
    const bug = (await call("POST", `${base}/tickets`, { title: "落ちる", kind: "bugfix" })).json;
    const feat = (await call("POST", `${base}/tickets`, { title: "足す" })).json;
    const view = (await call("GET", base)).json;
    expect(view.stages.map((s: { key: string }) => s.key)).toEqual(["dev", "qa"]);
    expect(view.kinds.find((k: { key: string }) => k.key === "bugfix")).toMatchObject({
      label: "バグ修正",
      stages: [{ key: "qa", label: "QA", preDev: true }, { key: "dev", label: "開発", preDev: false }],
    });
    expect(view.roleLabels.qa).toBe("QA");
    expect(view.kinds.find((k: { key: string }) => k.key === "bugfix").omitted).toEqual([]);
    expect(view.kinds.find((k: { key: string }) => k.key === "feature").stages.every((s: { preDev: boolean }) => !s.preDev)).toBe(true);
    const row = (id: number) => view.tickets.find((t: { id: number }) => t.id === id);
    expect(row(bug.id)).toMatchObject({ kind: "bugfix", kindLabel: "バグ修正", stage: "qa", preDev: true });
    expect(row(feat.id)).toMatchObject({ kind: "feature", kindLabel: "機能", preDev: false });
    const prod = (await call("GET", `${base}/productivity`)).json;
    expect(prod.tickets.find((t: { id: number }) => t.id === bug.id)).toMatchObject({ kind: "bugfix" });
  });

  it("メンバーの今していること・話す欄の API。話しかけると、終業中でも返事が来る", async () => {
    const { call, app } = await boot();
    const { json: created } = await call("POST", "/api/projects", { name: "会話", repos: [{ fullName: "acme/shop", role: "API" }] });
    const base = `/api/projects/${created.id}`;
    const p = app.project(created.id);
    await p.fillSeats();
    const idle = (await p.membersOfUnit((await p.currentFormation()).units[0]!.id))[0]!;
    // まだチケットを持っていないメンバーには話せない
    expect((await call("GET", `${base}/members/${idle.id}/now`)).json).toMatchObject({ state: "idle", ticket: null, last: null });
    expect((await call("POST", `${base}/members/${idle.id}/chat`, { body: "やあ" })).json.error).toMatch(/まだチケットを受け持っていない/);

    // 1 枚進めてから終業する(終業中でも会話は取り出される)
    await call("POST", `${base}/tickets`, { title: "CSV" });
    await call("POST", `${base}/run`, { running: true });
    for (let i = 0; i < 50 && (await app.projectView(created.id)).mergeOrder.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
    await call("POST", `${base}/run`, { running: false });
    const ticket = (await p.tickets())[0]!;
    const memberId = ticket.owner_member_id!;
    expect((await call("GET", `${base}/members/${memberId}/now`)).json).toMatchObject({ state: "idle", ticket: { number: ticket.number, title: "CSV" }, last: { number: ticket.number } });

    const posted = (await call("POST", `${base}/members/${memberId}/chat`, { body: "いまどう?" })).json;
    expect(posted.messages.map((m: { who: string }) => m.who)).toEqual(["owner"]);
    for (let i = 0; i < 50 && (await call("GET", `${base}/members/${memberId}/chat`)).json.messages.every((m: { who: string }) => m.who !== "member"); i++) await new Promise((r) => setTimeout(r, 20));
    const chat = (await call("GET", `${base}/members/${memberId}/chat`)).json;
    expect(chat.messages.map((m: { who: string }) => m.who)).toEqual(["owner", "member", "system"]);
    expect(chat.work).toBeNull();
    expect(chat.now.member.id).toBe(memberId);
  });

  it("既存のリポジトリの続きから作ると、GitHub の途中の仕事を取ってきて、担当に現状を読ませる(ADR-0030)", async () => {
    const { call, app } = await boot();
    const { json: created } = await call("POST", "/api/projects", { name: "続き", repos: [{ fullName: "acme/shop", role: "API" }], mode: "existing", issueLabel: "" });
    const p = app.project(created.id);
    expect(await p.setting("origin")).toBe("existing");
    expect(await p.setting("issue_label")).toBe("*");
    expect(await p.setting("onboard_github")).toContain("途中の PR");
  });

  it("プロジェクトを作ると企画スタジオが始まり、オフィスを止めていても企画の担当は答える", async () => {
    const { call, app } = await boot();
    const { json: created } = await call("POST", "/api/projects", { name: "企画", repos: [{ fullName: "acme/shop", role: "API" }] });
    await app.tick(created.id);
    let studio = (await call("GET", `/api/projects/${created.id}/studio`)).json;
    expect(studio.messages).toMatchObject([{ stage: "req", who: "plan" }]);
    expect(studio.stages[0]).toMatchObject({ key: "req", status: "作成中" });

    await call("POST", `/api/projects/${created.id}/studio/chat`, { stage: "req", text: "予約サイト" });
    await app.tick(created.id);
    studio = (await call("GET", `/api/projects/${created.id}/studio`)).json;
    expect(studio.messages.map((m: { who: string }) => m.who)).toEqual(["plan", "me", "plan"]);
    expect((await call("POST", `/api/projects/${created.id}/studio/stages/req/mode`, { mode: "skip" })).json.error).toMatch(/省けません/);
    expect((await call("GET", "/api/hq")).json.projects[0]).toMatchObject({ running: false, planning: { handed: false, current: "req" } });
  });

  it("開発ルールを API で 一覧・追加・直す・消す・有効 / 無効 にでき、変えるたびに版が上がる", async () => {
    const { call } = await boot();
    const { json: created } = await call("POST", "/api/projects", { name: "お試し", repos: [{ fullName: "acme/shop", role: "API" }] });
    const base = `/api/projects/${created.id}/dev-rules`;
    expect((await call("GET", base)).json.rules).toEqual([]);
    expect((await call("GET", base)).json.templates).toHaveLength(4);

    const added = (await call("POST", base, { template: "jira" })).json;
    expect(added.rules).toMatchObject([{ name: "Jira 番号をそろえる", onFail: "autofix", enabled: true, template: "jira" }]);
    expect((await call("POST", base, { template: "jira" })).status).toBe(400);
    const own = (await call("POST", base, { name: "作った", body: "x", appliesTo: ["pr_body"], check: "pattern", pattern: "^対象", onFail: "block" })).json;
    expect(own.rules).toHaveLength(2);

    const off = (await call("POST", `${base}/${added.rules[0].id}/enabled`, { enabled: false })).json;
    expect(off.rules[0].enabled).toBe(false);
    expect(off.version).toBe(4);

    // 直す: 版が上がり、渡した項目だけが変わる。読めない正規表現は断る
    const ruleId = own.rules[1].id;
    const fixed = (await call("POST", `${base}/${ruleId}`, { name: "直した", onFail: "review" })).json;
    expect(fixed).toMatchObject({ version: 5, rules: [{}, { name: "直した", onFail: "review", pattern: "^対象" }] });
    expect((await call("POST", `${base}/${ruleId}`, { pattern: "(" })).status).toBe(400);
    expect((await call("POST", `${base}/999`, { name: "x" })).status).toBe(400);
    // 消す
    const gone = (await call("POST", `${base}/${ruleId}/delete`)).json;
    expect(gone).toMatchObject({ version: 6, rules: [{ name: "Jira 番号をそろえる" }] });
    expect(gone.rules).toHaveLength(1);
    expect((await call("POST", `${base}/${ruleId}/delete`)).status).toBe(400);
    expect((await call("GET", `/api/projects/${created.id}/productivity`)).json.totals.ruleViolations).toEqual({ total: 0, autofixed: 0 });
  });

  it("「直すまで進めない」ルールに反して止まっているチケットは、ボードの一覧で止まっている印が付く", async () => {
    const { call, app } = await boot();
    const { json: created } = await call("POST", "/api/projects", { name: "止まる", repos: [{ fullName: "acme/shop", role: "API" }] });
    const p = app.project(created.id);
    const t = await createTicket(p, { title: "A" });
    const other = await createTicket(p, { title: "B" });
    const rule = await addDevRule(p, { template: "migration-alone" });
    run(p.db, "INSERT INTO rule_violations (rule_id, ticket_id, handled, created_at, detail, project_id) VALUES (?, ?, 'blocked', ?, '', ?)", [rule.id, t.id, p.now(), created.id]);
    const tickets = (await call("GET", `/api/projects/${created.id}`)).json.tickets as { id: number; ruleBlocked: string[] }[];
    expect(tickets.find((x) => x.id === t.id)!.ruleBlocked).toEqual(["マイグレーションは単独の PR"]);
    expect(tickets.find((x) => x.id === other.id)!.ruleBlocked).toEqual([]);
    // 無効にすると止まらない
    await call("POST", `/api/projects/${created.id}/dev-rules/${rule.id}/enabled`, { enabled: false });
    expect(((await call("GET", `/api/projects/${created.id}`)).json.tickets as { id: number; ruleBlocked: string[] }[]).find((x) => x.id === t.id)!.ruleBlocked).toEqual([]);
  });

  it("定期レビューを API で 作る・直す・無効にする・今すぐ実行する・消す(#89)", async () => {
    const { call } = await boot();
    const { json: created } = await call("POST", "/api/projects", { name: "お試し", repos: [{ fullName: "acme/shop", role: "API" }] });
    const base = `/api/projects/${created.id}/periodic-reviews`;
    expect((await call("GET", base)).json).toMatchObject({ reviews: [], runs: [], templates: [{ key: "designer_screens", added: false }] });

    const added = (await call("POST", base, { template: "designer_screens" })).json;
    expect(added.reviews).toMatchObject([{ name: "デザイナーによる画面レビュー", role: "designer", everyHours: 168, enabled: true }]);
    expect(added.templates[0].added).toBe(true);
    const own = (await call("POST", base, { name: "QA", viewpoint: "壊れ物を探す", everyHours: 6, role: "qa", targetKind: "repo" })).json;
    expect(own.reviews).toHaveLength(2);
    expect((await call("POST", base, { name: "", viewpoint: "x", everyHours: 6, role: "qa", targetKind: "repo" })).status).toBe(400);

    const id = own.reviews[1].id;
    expect((await call("POST", `${base}/${id}`, { name: "QA 改", viewpoint: "壊れ物を探す", everyHours: 12, role: "qa", targetKind: "repo" })).json.reviews[1]).toMatchObject({ name: "QA 改", everyHours: 12 });
    expect((await call("POST", `${base}/${id}/enabled`, { enabled: false })).json.reviews[1].enabled).toBe(false);
    const ran = (await call("POST", `${base}/${id}/run`, {})).json;
    // 起動の記録ができる(動いているチームがすぐ取ることもあるので、状態までは見ない)
    expect(ran.runs[0]).toMatchObject({ reviewId: id, origin: "manual" });
    const gone = (await call("POST", `${base}/${id}/delete`, {})).json;
    expect(gone.reviews).toHaveLength(1);
    expect(gone.runs).toEqual([]);
  });

  it("独自ヘッダーの無い書き込みと、localhost 以外の Host は断る", async () => {
    const { call, port } = await boot();
    expect((await call("POST", "/api/projects", { name: "x", repos: [] }, {})).status).toBe(403);
    const status = await new Promise<number>((resolve) => {
      request({ host: "127.0.0.1", port, path: "/api/hq", headers: { host: "evil.example" } }, (res) => resolve(res.statusCode ?? 0)).end();
    });
    expect(status).toBe(403);
  });

  /** 合言葉の確かめ用に、Host と Authorization・Cookie を自分で決めて送る(fetch は Host を変えられない)。 */
  const rawGet = (port: number, path: string, headers: Record<string, string> = {}, method = "GET") =>
    new Promise<{ status: number; headers: Record<string, unknown>; body: string }>((resolve) => {
      request({ host: "127.0.0.1", port, path, method, headers: { host: `localhost:${port}`, ...headers } }, (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      }).end();
    });

  it("localhost からも、API のすべてで合言葉を求める(合言葉なし・違う合言葉は 401)。画面のファイルは合言葉なしで配る(ADR-0062)", async () => {
    const { call, port } = await boot();
    // 合言葉を渡した呼び出しは通る
    expect((await call("GET", "/api/hq")).status).toBe(200);
    // 合言葉なし: 読み取りの API・書き込みの API のどれも 401。独自ヘッダーがあっても同じ。画像・書き出しの API も同じ
    expect((await rawGet(port, "/api/hq")).status).toBe(401);
    expect((await rawGet(port, "/api/projects", { "x-kuramoto": "1" }, "POST")).status).toBe(401);
    expect((await rawGet(port, "/api/db")).status).toBe(401);
    expect((await rawGet(port, "/api/projects/1/design-images/1")).status).toBe(401);
    expect((await rawGet(port, "/api/projects/1/studio/export.zip")).status).toBe(401);
    expect((await rawGet(port, "/api/hq")).body).not.toContain(TOKEN); // 合言葉を渡す道は作らない
    // 画面のファイルは、合言葉なしで読める(<script src> は Authorization を付けられない)。中に合言葉は入らない
    const page = await rawGet(port, "/");
    expect(page.status).toBe(200);
    expect(page.body).toContain("<title>Kuramoto</title>");
    expect(page.body).not.toContain(TOKEN);
    expect((await rawGet(port, "/missing.js")).status).toBe(404);
    expect((await rawGet(port, "/../etc/passwd")).status).toBe(404);
    // 違う合言葉・Cookie も API は断る。合言葉の長さが違っても落ちない
    for (const h of <Record<string, string>[]>[{ authorization: "Bearer wrong" }, { authorization: "Bearer" }, { authorization: `Basic ${TOKEN}` }, { cookie: "kuramoto_session=nope" }, { cookie: "kuramoto_session=" }, { cookie: `kuramoto_token=${TOKEN}` }, { cookie: "kuramoto_session=%E0%A4%A" }]) {
      expect((await rawGet(port, "/api/hq", h)).status).toBe(401);
    }
    expect((await rawGet(port, "/api/hq?token=wrong")).status).toBe(401);
    // 合言葉つきなら書き込みもできるが、独自ヘッダーが無ければ今までどおり 403
    expect((await rawGet(port, "/api/projects", { authorization: `Bearer ${TOKEN}` }, "POST")).status).toBe(403);
  });

  /** POST /api/session で、合言葉からセッション ID をもらう(画面がやること)。 */
  const newSession = async (port: number, headers: Record<string, string> = {}) => {
    const r = await rawGet(port, "/api/session", { authorization: `Bearer ${TOKEN}`, "x-kuramoto": "1", ...headers }, "POST");
    return { r, id: (r.status === 200 ? (JSON.parse(r.body) as { id: string }).id : "") };
  };

  it("POST /api/session は、合言葉(Authorization: Bearer)でセッション ID を作って返す。Cookie は出さず、以後は ID を Bearer で送って通る(ADR-0062)", async () => {
    const { port } = await boot({ open: true });
    const { r, id } = await newSession(port);
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).toEqual({ id, expiresIn: 8 * 60 * 60 });
    expect(id).toMatch(/^[\w-]{40,}$/);
    expect(id).not.toBe(TOKEN);
    expect(r.body).not.toContain(TOKEN); // 合言葉は返さない
    expect(r.headers["set-cookie"]).toBeUndefined(); // Cookie は発行しない(担当の別ポートのサーバーに届かない)
    expect(r.headers["cache-control"]).toBe("no-store");
    expect((await newSession(port)).id).not.toBe(id); // 毎回別の ID
    // ID を Bearer に入れれば、API も通る。他の PC(Host が localhost 以外)も、open なら同じ
    expect((await rawGet(port, "/api/hq", { authorization: `Bearer ${id}` })).status).toBe(200);
    expect((await rawGet(port, "/api/hq", { authorization: `Bearer ${id}`, host: "192.168.1.20:4300" })).status).toBe(200);
    // 書き込みの API も、ID と独自ヘッダーで通る
    expect((await rawGet(port, "/api/projects", { authorization: `Bearer ${id}` }, "POST")).status).toBe(403);
    // 合言葉なし・違う合言葉・セッション ID では、セッションを作れない(ID で期限を延ばし続ける道にしない)
    expect((await rawGet(port, "/api/session", { "x-kuramoto": "1" }, "POST")).status).toBe(401);
    expect((await rawGet(port, "/api/session", { authorization: "Bearer wrong", "x-kuramoto": "1" }, "POST")).status).toBe(401);
    expect((await rawGet(port, "/api/session", { authorization: `Bearer ${id}`, "x-kuramoto": "1" }, "POST")).status).toBe(401);
    // 独自ヘッダーが無い書き込みは 403(他のサイトからのフォーム送信などを断る)
    expect((await rawGet(port, "/api/session", { authorization: `Bearer ${TOKEN}` }, "POST")).status).toBe(403);
    // GET では作れない(ID を URL に載せない)
    expect((await rawGet(port, "/api/session", { authorization: `Bearer ${TOKEN}` })).status).toBe(404);
  });

  it("CORS のヘッダーを出さない。担当のページが cross-origin で本体を取りに来ても、読めず、ID も付かない(ADR-0062)", async () => {
    const { port } = await boot();
    const { id } = await newSession(port);
    for (const [path, method, h] of <[string, string, Record<string, string>][]>[
      ["/api/hq", "GET", { authorization: `Bearer ${id}`, origin: "http://localhost:5555" }],
      ["/api/hq", "OPTIONS", { origin: "http://localhost:5555", "access-control-request-method": "GET", "access-control-request-headers": "authorization" }],
      ["/api/session", "POST", { authorization: `Bearer ${TOKEN}`, "x-kuramoto": "1", origin: "http://localhost:5555" }],
      ["/", "GET", { origin: "http://localhost:5555" }],
    ]) {
      const r = await rawGet(port, path, h, method);
      expect(Object.keys(r.headers).filter((k) => k.startsWith("access-control-"))).toEqual([]);
    }
    // プリフライトは通らない(Authorization は付けられず、成功の応答も返らない)
    expect((await rawGet(port, "/api/hq", { origin: "http://localhost:5555", "access-control-request-method": "GET" }, "OPTIONS")).status).toBe(401);
  });

  it("前の版が Cookie に入れていた合言葉(kuramoto_token)は通さず、ブラウザから消させる(API の 401 と POST /api/session で)", async () => {
    const { port } = await boot();
    const legacy = await rawGet(port, "/api/hq", { cookie: `kuramoto_token=${TOKEN}` });
    expect(legacy.status).toBe(401);
    expect(String(legacy.headers["set-cookie"])).toMatch(/kuramoto_token=; .*Max-Age=0/);
    const made = await newSession(port, { cookie: `kuramoto_token=${TOKEN}` });
    expect(made.r.status).toBe(200);
    expect(String(made.r.headers["set-cookie"])).toMatch(/kuramoto_token=; .*Max-Age=0/);
    // Cookie 以外は出さない(セッションの Cookie は発行しない)
    expect(String(made.r.headers["set-cookie"])).not.toContain("kuramoto_session=");
  });

  it("セッションは、ログアウト(DELETE /api/session)でその ID だけ、revoke-all ですべて失効できる。どれも Authorization: Bearer で動く(合言葉は作り直さなくてよい)", async () => {
    const { port } = await boot();
    const [a, b, c] = [(await newSession(port)).id, (await newSession(port)).id, (await newSession(port)).id];
    const bearer = (id: string) => ({ authorization: `Bearer ${id}` });
    // 書き込みなので独自ヘッダーが要る
    expect((await rawGet(port, "/api/session", bearer(a), "DELETE")).status).toBe(403);
    const out = await rawGet(port, "/api/session", { ...bearer(a), "x-kuramoto": "1" }, "DELETE");
    expect(out.status).toBe(200);
    expect(out.headers["set-cookie"]).toBeUndefined();
    expect((await rawGet(port, "/api/hq", bearer(a))).status).toBe(401);
    expect((await rawGet(port, "/api/hq", bearer(b))).status).toBe(200);
    // 失効した ID では、もう何も止められない
    expect((await rawGet(port, "/api/session", { ...bearer(a), "x-kuramoto": "1" }, "DELETE")).status).toBe(401);
    // 合言葉なしでは失効もさせられない(担当が他人のセッションを止めることも、ID なしでは出来ない)
    expect((await rawGet(port, "/api/session/revoke-all", { "x-kuramoto": "1" }, "POST")).status).toBe(401);
    const all = await rawGet(port, "/api/session/revoke-all", { ...bearer(b), "x-kuramoto": "1" }, "POST");
    expect(JSON.parse(all.body)).toEqual({ revoked: 2 }); // a は失効済みなので、残っていた b と c
    for (const id of [b, c]) expect((await rawGet(port, "/api/hq", bearer(id))).status).toBe(401);
    // 合言葉は変わらないので、セッションは作り直せる
    expect((await rawGet(port, "/api/hq", { authorization: `Bearer ${TOKEN}` })).status).toBe(200);
    expect((await newSession(port)).r.status).toBe(200);
    // 合言葉で DELETE しても、止めるものは無いが落ちない(合言葉は失効できない)
    expect((await rawGet(port, "/api/session", { authorization: `Bearer ${TOKEN}`, "x-kuramoto": "1" }, "DELETE")).status).toBe(200);
    expect((await rawGet(port, "/api/hq", { authorization: `Bearer ${TOKEN}` })).status).toBe(200);
  });

  it("セッションは期限が来たら通らない(短期)", async () => {
    let now = 1_000_000;
    const { port } = await boot({ sessions: new Sessions(60_000, () => now) });
    const { id } = await newSession(port);
    const h = { authorization: `Bearer ${id}` };
    expect((await rawGet(port, "/api/hq", h)).status).toBe(200);
    now += 59_000;
    expect((await rawGet(port, "/api/hq", h)).status).toBe(200);
    now += 2_000;
    expect((await rawGet(port, "/api/hq", h)).status).toBe(401);
  });

  // ---- 移行用(前の画面): 画面を #k= に替える PR で、このブロックごと消す ----

  /** 前の画面がやること: 合言葉つきの URL を開いて、Cookie に入ったセッション ID(kuramoto_session=…)を返す。 */
  const login = async (port: number, headers: Record<string, string> = {}) => {
    const r = await rawGet(port, `/projects/1?token=${TOKEN}`, headers);
    return { r, cookie: String(([] as string[]).concat(r.headers["set-cookie"] as string[])[0]) };
  };

  it("移行用: 前の画面の ?token= の道と、セッションの Cookie は、画面を替えるまで動く。ログアウト・revoke-all も Cookie で効く", async () => {
    const { port } = await boot();
    const { r, cookie } = await login(port);
    expect(r.status).toBe(303);
    expect(r.headers.location).toBe("/projects/1"); // 合言葉は URL から外す
    expect(cookie).toMatch(/^kuramoto_session=[\w-]{40,};/);
    expect(cookie).not.toContain(TOKEN);
    const a = cookie.split(";")[0]!;
    const b = (await login(port)).cookie.split(";")[0]!;
    expect((await rawGet(port, "/api/hq", { cookie: a })).status).toBe(200);
    const out = await rawGet(port, "/api/session", { cookie: a, "x-kuramoto": "1" }, "DELETE");
    expect(out.status).toBe(200);
    expect(String(out.headers["set-cookie"])).toContain("Max-Age=0");
    expect((await rawGet(port, "/api/hq", { cookie: a })).status).toBe(401);
    const all = await rawGet(port, "/api/session/revoke-all", { cookie: b, "x-kuramoto": "1" }, "POST");
    expect(JSON.parse(all.body)).toEqual({ revoked: 1 });
    expect((await rawGet(port, "/api/hq", { cookie: b })).status).toBe(401);
    expect((await rawGet(port, "/?token=wrong")).headers.location).toBeUndefined(); // 違う合言葉では送り直さない
  });

  it("open でないときは、合言葉があっても localhost 以外の Host は断る(403)", async () => {
    const { port } = await boot();
    expect((await rawGet(port, "/api/hq", { host: "192.168.1.20:4300", authorization: `Bearer ${TOKEN}` })).status).toBe(403);
  });

  it("設計書を、画面のお手本の画像と一緒に zip で書き出す(デザインシステムの節つき)", async () => {
    const { PNG } = await import("pngjs");
    const { execFileSync } = await import("node:child_process");
    const img = new PNG({ width: 390, height: 10 });
    img.data.fill(255);
    const { call, app, port } = await boot({ renderer: async () => PNG.sync.write(img) });
    const { json: created } = await call("POST", "/api/projects", { name: "書き出し", repos: [{ fullName: "acme/shop", role: "API" }] });
    const p = app.project(created.id);
    const { putScreen, putArtifact } = await import("./project/planning.js");
    await putArtifact(p, "screen", "designsystem", "main", { principles: ["青 1 色"], tokens: [{ group: "color", name: "--color-primary", value: "#2f67d4", use: "主ボタン" }], components: [{ name: "主ボタン", use: "確定", states: ["通常"], html: "<button>保存</button>" }] });
    await putScreen(p, "list", { name: "メモ一覧", device: "phone", requirements: [], variants: [{ id: "A", html: "<p>一覧</p>" }], chosen: "A", agreed: true });
    const res = await fetch(`http://localhost:${port}/api/projects/${created.id}/studio/export.zip`, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(res.headers.get("content-type")).toBe("application/zip");
    const dir = mkdtempSync(join(tmpdir(), "kuramoto-zip-"));
    try {
      writeFileSync(join(dir, "d.zip"), Buffer.from(await res.arrayBuffer()));
      const listing = execFileSync("unzip", ["-l", join(dir, "d.zip")]).toString();
      expect(listing).toContain("design.md");
      expect(listing).toContain("images/list.png");
      const md = execFileSync("unzip", ["-p", join(dir, "d.zip"), "design.md"]).toString();
      expect(md).toContain("### デザインシステム");
      expect(md).toContain("| `--color-primary` | 色 | `#2f67d4` | 主ボタン |");
      expect(md).toContain("![メモ一覧](images/list.png)");
      expect(execFileSync("unzip", ["-t", join(dir, "d.zip")]).toString()).toContain("No errors");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
