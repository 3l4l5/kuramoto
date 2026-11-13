import { fixedAll, withResolutions } from "./harness/fake.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FakeHarness } from "./harness/fake.js";
import { Hq } from "./hq.js";
import { StaticWorkspace } from "./project/workspace.js";
import { KuramotoServer } from "./server.js";
import { leadMessages } from "./project/leadchat.js";
import type { Project } from "./project/project.js";
import { addDevRule } from "./project/dev-rules.js";
import { createTicket } from "./project/workflow.js";
import { run } from "./db/sqlite.js";

const leadSaid = (p: Project, text: string) => leadMessages(p).some((m) => m.body.includes(text));

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((f) => f()));

async function boot(opts: { publicToken?: string; renderer?: import("./project/design-visual.js").Renderer } = {}) {
  const home = mkdtempSync(join(tmpdir(), "kuramoto-srv-"));
  const harness = new FakeHarness(async (req, call) => {
    if (req.tools.some((t) => t.name === "submit_pr")) await call("submit_pr", { summary: "", responses: fixedAll(req.prompt) });
    else if (req.tools.some((t) => t.name === "submit_review")) await call("submit_review", withResolutions(req.prompt, { verdict: "approve", findings: [] }));
    else return { finalText: "企画担当の咲季です。何のためのものですか?" };
  });
  const github = { openPulls: async () => [{ number: 3, title: "途中の PR", body: "", head: "wip", url: "u", draft: false, author: "a" }], openIssues: async () => [], merged: [] as number[], actions: [] as string[], setActionsEnabled: async (r: string, on: boolean) => void github.actions.push(`${r}:${on}`), prStatus: async () => ({ state: "OPEN" as const, mergeable: "MERGEABLE" as const, ci: "success" as const }), merge: async (_r: string, n: number) => void github.merged.push(n), comment: async () => "" };
  writeFileSync(join(home, "index.html"), "<!doctype html><title>Kuramoto</title>");
  const app = new KuramotoServer({ hq: new Hq(home), webDir: home, harnesses: { "claude-agent-sdk": harness }, github, workspaceFor: () => new StaticWorkspace(home, { prNumber: () => 5 }), ...opts });
  const server: Server = createServer((req, res) => void app.handle(req, res));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  cleanups.push(() => { app.close(); server.close(); app.hq.close(); rmSync(home, { recursive: true, force: true }); });
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = { "x-kuramoto": "1" }) => {
    const res = await fetch(`http://localhost:${port}${path}`, { method, headers: { "content-type": "application/json", ...headers }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, json: (await res.json().catch(() => null)) as any, text: res.headers.get("content-type") };
  };
  return { app, call, github, port };
}

describe("ローカルサーバー", () => {
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
    expect(p.setting("patrol_last_at")).toBeTruthy();
    for (let i = 0; i < 50 && !leadSaid(p, "【見回り】"); i++) await new Promise((r) => setTimeout(r, 20));
    expect(leadSaid(p, "【見回り】")).toBe(true);
    // 見回りの間隔はプロジェクトの設定で変えられる
    expect((await call("GET", `/api/projects/${created.id}/settings`)).json.patrolMin).toBe(5);
    await call("POST", `/api/projects/${created.id}/settings`, { name: "お試し", repos: [{ fullName: "acme/shop", role: "API" }], patrolMin: 10 });
    expect((await call("GET", `/api/projects/${created.id}/settings`)).json.patrolMin).toBe(10);
    // チームの CI に切り替えると、GitHub Actions を止める。戻すと動かす(ADR-0028)
    expect((await call("GET", `/api/projects/${created.id}/settings`)).json.ciMode).toBe("github");
    await call("POST", `/api/projects/${created.id}/settings`, { name: "お試し", repos: [{ fullName: "acme/shop", role: "API" }], ciMode: "team", ciCommands: { "acme/shop": "npm ci\nnpm test" } });
    expect((await call("GET", `/api/projects/${created.id}/settings`)).json).toMatchObject({ ciMode: "team", ciCommands: { "acme/shop": "npm ci\nnpm test" } });
    expect(leadSaid(p, "【チームの CI に切り替えました】")).toBe(true);
    await call("POST", `/api/projects/${created.id}/settings`, { name: "お試し", repos: [{ fullName: "acme/shop", role: "API" }], ciMode: "github" });
    expect(github.actions).toEqual(["acme/shop:false", "acme/shop:true"]);

    const ticketId = (await app.projectView(created.id)).mergeOrder[0];
    expect((await call("POST", `/api/projects/${created.id}/merge/${ticketId}`)).json).toEqual({ result: "merged" });
    expect(github.merged).toEqual([5]);
    expect((await app.hq.project(created.id)).status).toBe("running");
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
    expect(p.ticket(t.id)).toMatchObject({ kind: "bugfix", stage: "qa" });
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
    p.fillSeats();
    const idle = p.membersOfUnit(p.currentFormation().units[0]!.id)[0]!;
    // まだチケットを持っていないメンバーには話せない
    expect((await call("GET", `${base}/members/${idle.id}/now`)).json).toMatchObject({ state: "idle", ticket: null, last: null });
    expect((await call("POST", `${base}/members/${idle.id}/chat`, { body: "やあ" })).json.error).toMatch(/まだチケットを受け持っていない/);

    // 1 枚進めてから終業する(終業中でも会話は取り出される)
    await call("POST", `${base}/tickets`, { title: "CSV" });
    await call("POST", `${base}/run`, { running: true });
    for (let i = 0; i < 50 && (await app.projectView(created.id)).mergeOrder.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
    await call("POST", `${base}/run`, { running: false });
    const ticket = p.tickets()[0]!;
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
    expect(p.setting("origin")).toBe("existing");
    expect(p.setting("issue_label")).toBe("*");
    expect(p.setting("onboard_github")).toContain("途中の PR");
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
    const rule = addDevRule(p, { template: "migration-alone" });
    run(p.db, "INSERT INTO rule_violations (rule_id, ticket_id, handled, created_at, detail) VALUES (?, ?, 'blocked', ?, '')", [rule.id, t.id, p.now()]);
    const tickets = (await call("GET", `/api/projects/${created.id}`)).json.tickets as { id: number; ruleBlocked: string[] }[];
    expect(tickets.find((x) => x.id === t.id)!.ruleBlocked).toEqual(["マイグレーションは単独の PR"]);
    expect(tickets.find((x) => x.id === other.id)!.ruleBlocked).toEqual([]);
    // 無効にすると止まらない
    await call("POST", `/api/projects/${created.id}/dev-rules/${rule.id}/enabled`, { enabled: false });
    expect(((await call("GET", `/api/projects/${created.id}`)).json.tickets as { id: number; ruleBlocked: string[] }[]).find((x) => x.id === t.id)!.ruleBlocked).toEqual([]);
  });

  it("独自ヘッダーの無い書き込みと、localhost 以外の Host は断る", async () => {
    const { call, port } = await boot();
    expect((await call("POST", "/api/projects", { name: "x", repos: [] }, {})).status).toBe(403);
    const status = await new Promise<number>((resolve) => {
      request({ host: "127.0.0.1", port, path: "/api/hq", headers: { host: "evil.example" } }, (res) => resolve(res.statusCode ?? 0)).end();
    });
    expect(status).toBe(403);
  });

  it("公開するときは、localhost 以外からの接続に合言葉を求め、合言葉つきの URL で Cookie を渡す", async () => {
    const { call, port } = await boot({ publicToken: "s3cret" });
    const get = (path: string, headers: Record<string, string>) =>
      new Promise<{ status: number; headers: Record<string, unknown> }>((resolve) => {
        request({ host: "127.0.0.1", port, path, headers: { host: "192.168.1.20:4300", ...headers } }, (res) => {
          res.resume();
          resolve({ status: res.statusCode ?? 0, headers: res.headers });
        }).end();
      });
    // この PC 自身(localhost)は合言葉なしで使える
    expect((await call("GET", "/api/hq")).status).toBe(200);
    // 他の PC: 合言葉が無ければ断る。違っていても断る
    expect((await get("/api/hq", {})).status).toBe(401);
    expect((await get("/", {})).status).toBe(401);
    expect((await get("/?token=wrong", {})).status).toBe(401);
    // 合言葉つきの URL は Cookie を渡して、合言葉を外した URL へ送り直す
    const r = await get("/projects/1?token=s3cret", {});
    expect(r.status).toBe(303);
    expect(r.headers.location).toBe("/projects/1");
    expect(String(r.headers["set-cookie"])).toContain("kuramoto_token=s3cret");
    expect(String(r.headers["set-cookie"])).toContain("HttpOnly");
    // 以後は Cookie で通る
    expect((await get("/api/hq", { cookie: "kuramoto_token=s3cret" })).status).toBe(200);
    expect((await get("/api/hq", { authorization: "Bearer s3cret" })).status).toBe(200);
    expect((await get("/api/hq", { cookie: "kuramoto_token=nope" })).status).toBe(401);
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
    putArtifact(p, "screen", "designsystem", "main", { principles: ["青 1 色"], tokens: [{ group: "color", name: "--color-primary", value: "#2f67d4", use: "主ボタン" }], components: [{ name: "主ボタン", use: "確定", states: ["通常"], html: "<button>保存</button>" }] });
    putScreen(p, "list", { name: "メモ一覧", device: "phone", requirements: [], variants: [{ id: "A", html: "<p>一覧</p>" }], chosen: "A", agreed: true });
    const res = await fetch(`http://localhost:${port}/api/projects/${created.id}/studio/export.zip`);
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
