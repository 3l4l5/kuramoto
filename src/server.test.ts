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

const leadSaid = (p: Project, text: string) => leadMessages(p).some((m) => m.body.includes(text));

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((f) => f()));

async function boot(opts: { publicToken?: string } = {}) {
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

    for (let i = 0; i < 50 && app.projectView(created.id).mergeOrder.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
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

    const ticketId = app.projectView(created.id).mergeOrder[0];
    expect((await call("POST", `/api/projects/${created.id}/merge/${ticketId}`)).json).toEqual({ result: "merged" });
    expect(github.merged).toEqual([5]);
    expect(app.hq.project(created.id).status).toBe("running");
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
});
