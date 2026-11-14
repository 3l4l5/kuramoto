import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ManualClock } from "../clock.js";
import { all, run } from "../db/sqlite.js";
import { fixedAll, FakeHarness, withResolutions } from "../harness/fake.js";
import type { Confinement } from "../harness/types.js";
import type { GitHub, PrStatus } from "../github/github.js";
import { Dispatcher } from "./dispatcher.js";
import { ownerMerge, type TeamCiHook } from "./merge.js";
import { Project, type TicketRow } from "./project.js";
import { browserSandboxConfig, confinedBrowserEnabled } from "./confined-browser.js";
import { detectCommands, E2E_WS_ENDPOINT_ENV, runTeamCi, SandboxRunner, wantsBrowser, withBrowser, type CommandRunner } from "./team-ci.js";
import { StaticWorkspace } from "./workspace.js";
import { createTicket } from "./workflow.js";

const REPO = "acme/shop";

/** 決めた台本どおりに終わるコマンドの流し役。 */
class FakeRunner implements CommandRunner {
  ran: string[] = [];
  constructor(private readonly fail: (cmd: string, n: number) => string | null) {}
  async run(cmd: string): Promise<{ code: number | null; output: string }> {
    this.ran.push(cmd);
    const out = this.fail(cmd, this.ran.filter((c) => c === cmd).length);
    return out ? { code: 2, output: out } : { code: 0, output: "ok" };
  }
}

async function setup(runner: CommandRunner, base = () => "main-1") {
  const clock = new ManualClock();
  const p = await Project.open(":memory:", clock);
  await p.addRepo(REPO, "API");
  await p.setSetting("ci_mode", "team");
  await p.setSetting(`team_ci_commands:${REPO}`, "npm ci\nnpm run typecheck\nnpx vitest run");
  const prompts: { tools: string[]; prompt: string }[] = [];
  const harness = new FakeHarness(async (req, call) => {
    prompts.push({ tools: req.tools.map((t) => t.name), prompt: req.prompt });
    if (req.tools.some((t) => t.name === "submit_pr")) await call("submit_pr", { summary: "実装した", responses: fixedAll(req.prompt) });
    else if (req.tools.some((t) => t.name === "submit_review")) await call("submit_review", withResolutions(req.prompt, { verdict: "approve", findings: [] }));
  });
  const workspace = new StaticWorkspace("/tmp/ws", { prNumber: (r) => r.ticketNumber + 9, baseSha: base });
  const d = new Dispatcher(p, { harnesses: { "claude-agent-sdk": harness }, workspace, checkRunner: runner });
  const hook: TeamCiHook = { run: (t: TicketRow, repo, branch) => runTeamCi(p, workspace, runner, t, repo, branch), baseSha: () => workspace.baseSha() };
  return { p, d, prompts, hook, clock };
}

class FakeGitHub implements GitHub {
  merged: number[] = [];
  async prStatus(): Promise<PrStatus> {
    // チームの CI では、GitHub の CI は見ない(止めてあるので落ちている・始まらない)
    return { state: "OPEN", mergeable: "MERGEABLE", ci: "failure" };
  }
  async merge(_r: string, n: number): Promise<void> {
    this.merged.push(n);
  }
  async comment(): Promise<string> {
    return "";
  }
}

describe("チームの CI(ADR-0028)", () => {
  it("package.json から、入れる → lint → 型 → テストを決める", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kuramoto-ci-"));
    try {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { lint: "eslint .", typecheck: "tsc", test: "vitest run", dev: "vite" } }));
      writeFileSync(join(dir, "package-lock.json"), "{}");
      expect(detectCommands(dir)).toEqual(["npm ci", "npm run lint", "npm run typecheck", "npm test"]);
      writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { "type-check": "tsc" } }));
      writeFileSync(join(dir, "pnpm-lock.yaml"), "");
      expect(detectCommands(dir)).toEqual(["pnpm install --frozen-lockfile", "pnpm run type-check"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("PR を出したら、レビューの前に流す。落ちたら出力を付けてその場で持ち主に戻し、通ったらレビューに回す", async () => {
    const runner = new FakeRunner((cmd, n) => (cmd === "npm run typecheck" && n === 1 ? "src/a.ts(3,1): error TS2322: Type 'string' is not assignable to type 'number'." : null));
    const { p, d, prompts } = await setup(runner);
    const t = await createTicket(p, { title: "A" });
    await d.drain();

    // 1 回目は型で落ちる。テストは流さない(早く返す)。レビューには回さない
    expect(runner.ran.slice(0, 2)).toEqual(["npm ci", "npm run typecheck"]);
    expect(prompts[0]!.prompt).toContain("Kuramoto がチームの CI");
    expect(prompts[0]!.prompt).toContain("`npm run typecheck`");
    expect(prompts[1]!.tools).toContain("submit_pr"); // 2 回目も開発(直し)
    expect(prompts[1]!.prompt).toContain("チームの CI で確かめたところ、落ちました");
    expect(prompts[1]!.prompt).toContain("error TS2322");
    // 直したら通って、レビューを経て merge 待ちへ
    expect(prompts[2]!.tools).toContain("submit_review");
    expect((await p.ticket(t.id)).stage).toBe("merge");
    expect(all<{ type: string }>(p.db, "SELECT type FROM events WHERE type LIKE 'team_ci_%' ORDER BY id").map((e) => e.type)).toEqual(["team_ci_failed", "team_ci_passed"]);
  });

  it("merge では GitHub の CI を見ない。通ったときから main が進んでいなければそのまま merge し、進んでいれば流し直す", async () => {
    let base = "main-1";
    let failNext = false;
    const runner = new FakeRunner((cmd) => (failNext && cmd === "npx vitest run" ? "FAIL test/save.test.ts" : null));
    const { p, d, hook } = await setup(runner, () => base);
    const a = await createTicket(p, { title: "A" });
    const b = await createTicket(p, { title: "B" });
    await d.drain();
    const gh = new FakeGitHub();

    const before = runner.ran.length;
    expect(await ownerMerge(p, gh, a.id, "team", { teamCi: hook })).toEqual({ result: "merged" });
    expect(runner.ran.length).toBe(before); // main が同じなので流し直さない

    // main が進んだ。B は新しい main と合わせると落ちるので、merge せず持ち主に戻す
    base = "main-2";
    failNext = true;
    expect(await ownerMerge(p, gh, b.id, "team", { teamCi: hook })).toMatchObject({ result: "blocked", reason: expect.stringContaining("npx vitest run") });
    expect(gh.merged).toEqual([10]);
    expect((await p.ticket(b.id)).stage).toBe("dev");

    // 持ち主が直した(今度は通る)。チームの CI を流す口が無ければ merge しない
    failNext = false;
    await d.drain({ maxRuns: 10 });
    expect((await p.ticket(b.id)).stage).toBe("merge");
    expect(await ownerMerge(p, gh, b.id, "team")).toMatchObject({ result: "blocked" });
  });

  it.skipIf(process.platform !== "darwin")("閉じ込めの中で流す: 作業場所は書けて、ホームの認証情報は読めない", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kuramoto-srt-"));
    mkdirSync(join(dir, "sub"));
    try {
      const conf: Confinement = { readable: [], writable: [], hidden: [join(homedir(), ".ssh")], allowedDomains: ["registry.npmjs.org"], hiddenEnv: ["GH_TOKEN"], allowLocalSockets: false, env: {} };
      const r = new SandboxRunner();
      process.env.GH_TOKEN = "secret-token";
      const ok = await r.run("echo hi > sub/out.txt && cat sub/out.txt && echo token=${GH_TOKEN:-none}", dir, conf, 60_000);
      expect(ok).toMatchObject({ code: 0 });
      expect(ok.output).toContain("hi");
      expect(ok.output).toContain("token=none");
      const denied = await r.run(`ls ${join(homedir(), ".ssh")} && echo READ`, dir, conf, 60_000);
      expect(denied.output).not.toContain("READ");
      const home = await r.run(`touch ${join(homedir(), ".kuramoto-srt-probe")} && echo WROTE`, dir, conf, 60_000);
      expect(home.output).not.toContain("WROTE");
      await r.close();
    } finally {
      delete process.env.GH_TOKEN;
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it.skipIf(process.platform !== "darwin")("閉じ込めの中から 127.0.0.1 のポート(mysql-test の 3307 と同じ作り)に届く。ソケットを閉じた設定(sandbox_strict_sockets)では届かない", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kuramoto-srt-"));
    const server = createServer((c) => c.end());
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
    const port = (server.address() as AddressInfo).port;
    try {
      const base: Confinement = { readable: [], writable: [], hidden: [], allowedDomains: ["registry.npmjs.org"], hiddenEnv: [], allowLocalSockets: true, env: {} };
      const r = new SandboxRunner();
      const probe = `/usr/bin/nc -z -w 3 127.0.0.1 ${port} && echo REACHED`;
      expect((await r.run(probe, dir, base, 60_000)).output).toContain("REACHED");
      expect((await r.run(probe, dir, { ...base, allowLocalSockets: false }, 60_000)).output).not.toContain("REACHED");
      await r.close();
    } finally {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("チームの CI を使うなら、GitHub Actions の CI のためのチケット(main の CI を直す)は取りやめる。リーダーは、やることの無いチケットを手助けの中で取りやめられる", async () => {
    const runner = new FakeRunner(() => null);
    const { p, d } = await setup(runner);
    const fixer = await createTicket(p, { title: "main の CI を直す(check)", planRefs: { repo: REPO, baseCi: REPO } });
    const { holdTicket, droppedInfo } = await import("./workflow.js");
    await holdTicket(p, fixer.id, { reason: "Actions の請求で止まっている", ownerAction: "請求を直す", resume: { toRole: "dev", toMemberId: null, kind: "implement", payload: {} } });
    await p.setSetting("ci_blocked", JSON.stringify([{ repo: REPO, since: "", notes: [], probedAt: "", runIds: [] }]));
    await d.housekeep();
    expect((await p.ticket(fixer.id)).stage).toBe("dropped");
    expect((await droppedInfo(p, fixer.id))!.reason).toContain("チームの CI");
    expect(await p.setting("ci_blocked")).toBe("[]");
    const { pendingOwnerDecisions } = await import("./workflow.js");
    expect(await pendingOwnerDecisions(p)).toEqual([]);

    // 手助けの道具: やることの無いチケットを取りやめる(リーダー自身の起動中でも)
    const { unstickTools } = await import("./unstick.js");
    const t = await createTicket(p, { title: "docs だけの調査" });
    const msg = run(p.db, "INSERT INTO messages (ticket_id, to_role, kind, status, available_at, created_at) VALUES (?, 'lead', 'unstick', 'claimed', '', '')", [t.id]).lastId;
    run(p.db, "INSERT INTO runs (message_id, ticket_id, member_id, role, policy_id, formation_id, started_at) VALUES (?, ?, ?, 'lead', 1, 1, '')", [msg, t.id, (await p.fixedMember("lead")).id]);
    const done: { action?: "retry" | "hold" | "closed" | "dropped" } = {};
    const tools = unstickTools(p, await p.ticket(t.id), { error: "submit_pr が呼ばれませんでした", resume: { toRole: "dev", toMemberId: null, kind: "implement", payload: {} } }, done);
    expect(await tools.find((x) => x.name === "drop_ticket")!.handler({ reason: "直すコードが無い" } as never)).toContain("取りやめました");
    expect(done.action).toBe("dropped");
    // チームの CI では、GitHub の CI を調べる道具は渡さない
    const { ciTools } = await import("./ci-tools.js");
    expect(await ciTools(p, { ciDetail: async () => ({}) } as never, { rerun: true })).toEqual([]);
  });
});

/** この環境で、sandbox-runtime(macOS は sandbox-exec)で閉じ込められるか。閉じ込めの中からは重ねられない。 */
function canSandbox(): boolean {
  if (process.platform !== "darwin") return false;
  return spawnSync("/usr/bin/sandbox-exec", ["-p", "(version 1)(allow default)", "/usr/bin/true"]).status === 0;
}

describe("チームの CI: ブラウザの E2E は、ブラウザ専用の狭い閉じ込めの中で立てたブラウザサーバーに繋ぐ(#93)", () => {
  const conf: Confinement = { readable: [], writable: [], hidden: [], allowedDomains: [], hiddenEnv: [], allowLocalSockets: true, env: {} };
  const repoWith = (config: string | null) => {
    const dir = mkdtempSync(join(tmpdir(), "kuramoto-pw-"));
    if (config) writeFileSync(join(dir, config), "export default {};");
    return dir;
  };

  it("playwright の設定があるリポジトリのテストのコマンドだけが、ブラウザを要る", () => {
    const dir = repoWith("playwright.config.ts");
    try {
      expect(wantsBrowser("npm test", dir)).toBe(true);
      expect(wantsBrowser("npm run test:e2e", dir)).toBe(true);
      expect(wantsBrowser("npm ci", dir)).toBe(false);
      expect(wantsBrowser("npm run lint", dir)).toBe(false);
      expect(wantsBrowser("npm test", repoWith(null))).toBe(false); // playwright の設定が無い
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("要るコマンドには、立てたブラウザサーバーの宛先を環境変数で渡し、close で閉じる。要らないコマンドでは立てない", async () => {
    const dir = repoWith("playwright.config.ts");
    const events: string[] = [];
    const start = async () => {
      events.push("start");
      return { endpoint: "ws://127.0.0.1:9/abc", close: async () => void events.push("close") };
    };
    try {
      const b = await withBrowser("npm test", dir, conf, start, false, true);
      expect(b.env).toEqual({ [E2E_WS_ENDPOINT_ENV]: "ws://127.0.0.1:9/abc" });
      await b.close();
      expect(events).toEqual(["start", "close"]);
      expect((await withBrowser("npm ci", dir, conf, start, false, true)).env).toEqual({});
      // ソケットを閉じた設定(sandbox_strict_sockets)では、E2E そのものが動かないので立てない
      expect((await withBrowser("npm test", dir, { ...conf, allowLocalSockets: false }, start, false, true)).env).toEqual({});
      expect(events).toEqual(["start", "close"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("狭い閉じ込めの中でブラウザを立てられなかったときは、閉じ込めの無いブラウザには切り替えず、宛先を渡さずに進める(理由は知らせに入れる)", async () => {
    const dir = repoWith("playwright.config.ts");
    let started = 0;
    try {
      const b = await withBrowser("npm test", dir, conf, async () => {
        started++;
        throw new Error("Chrome が見つかりません");
      }, false, true);
      expect(b.env).toEqual({});
      expect(b.notice).toContain("狭い閉じ込めの中でブラウザを起動できなかった");
      expect(b.notice).toContain("Chrome が見つかりません");
      expect(b.notice).toContain("閉じ込めの無いブラウザには切り替えません");
      expect(started).toBe(1); // 立て直しや別の立て方は試さない
      await b.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("既定では動かない: KURAMOTO_E2E_CONFINED_BROWSER=1 が無ければ、ブラウザサーバーを立てず、宛先も渡さない(閉じ込めの無いブラウザも立たない)", async () => {
    expect(confinedBrowserEnabled({})).toBe(false);
    expect(confinedBrowserEnabled({ KURAMOTO_E2E_CONFINED_BROWSER: "0" })).toBe(false);
    expect(confinedBrowserEnabled({ KURAMOTO_E2E_CONFINED_BROWSER: "1" })).toBe(true);
    const dir = repoWith("playwright.config.ts");
    let started = 0;
    const start = async () => {
      started++;
      return { endpoint: "ws://127.0.0.1:9/abc", close: async () => {} };
    };
    try {
      const saved = process.env.KURAMOTO_E2E_CONFINED_BROWSER;
      delete process.env.KURAMOTO_E2E_CONFINED_BROWSER;
      try {
        const b = await withBrowser("npm test", dir, conf, start); // 設定が無い
        expect(b.env).toEqual({});
        expect(b.notice).toBeUndefined(); // E2E の回が「ブラウザを起動できなかった」の知らせを出して通す
        expect(started).toBe(0);
        // SandboxRunner も同じ(宛先を渡さない)
        if (canSandbox()) {
          const out = await new SandboxRunner(start).run("echo endpoint=${KURAMOTO_E2E_WS_ENDPOINT:-none}; echo test", dir, { ...conf, hidden: [], allowedDomains: [], hiddenEnv: [] }, 60_000);
          expect(out.output).toContain("endpoint=none");
          expect(started).toBe(0);
        }
      } finally {
        if (saved !== undefined) process.env.KURAMOTO_E2E_CONFINED_BROWSER = saved;
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("ブラウザ専用の閉じ込めは、書けるのはプロファイルの一時ディレクトリだけ・読めないのはホームと隠す場所・外には通信できない", () => {
    const home = "/Users/someone";
    const hidden = [`${home}/.kuramoto`, `${home}/.ssh`];
    const c = browserSandboxConfig("/work/repo", { ...conf, hidden }, "/tmp/kuramoto-pw-abc", `${home}/.local/share/mise/installs/node/24/bin/node`, home);
    expect(c.filesystem.allowWrite).toEqual(["/tmp/kuramoto-pw-abc"]); // リポジトリにも書けない
    expect(c.filesystem.denyRead).toEqual([home, ...hidden]);
    // ホームの下で読めるのは、node のツールチェーン・リポジトリの node_modules と package.json・Playwright のブラウザだけ
    expect(c.filesystem.allowRead).toEqual([
      `${home}/.local/share/mise/installs/node/24`,
      "/work/repo/node_modules",
      "/work/repo/package.json",
      `${home}/Library/Caches/ms-playwright`,
      `${home}/.cache/ms-playwright`,
    ]);
    expect(c.filesystem.allowRead.some((p) => p === home || hidden.some((h) => p.startsWith(h)))).toBe(false);
    expect(c.network.allowedDomains).toEqual([]); // 許すドメインは無い(localhost だけ)
  });

  it("node がホームの外(/usr/local など)にあるときは、ホームの下の読める場所に node を足さない", () => {
    const c = browserSandboxConfig("/work/repo", conf, "/tmp/kuramoto-pw-abc", "/usr/local/bin/node", "/Users/someone");
    expect(c.filesystem.allowRead.every((p) => p.startsWith("/work/repo") || p.startsWith("/Users/someone/"))).toBe(true);
  });

  it("SandboxRunner は、ブラウザを立てられなくても npm test(コマンド)を流し、知らせを出力の末尾に付ける。宛先は渡さない", async () => {
    if (!canSandbox()) return; // 閉じ込めの中など、閉じ込めを重ねられない環境では確かめられない(流せる環境の CI で確かめる)
    const dir = mkdtempSync(join(tmpdir(), "kuramoto-srt-"));
    writeFileSync(join(dir, "playwright.config.ts"), "export default {};");
    let closed = 0;
    process.env.KURAMOTO_E2E_CONFINED_BROWSER = "1";
    try {
      const r = new SandboxRunner(async () => {
        throw new Error("狭い閉じ込めでは Chrome が起動できない");
      });
      const out = await r.run("echo endpoint=${KURAMOTO_E2E_WS_ENDPOINT:-none}; echo test", dir, { ...conf, hidden: [], allowedDomains: [], hiddenEnv: [] }, 60_000);
      expect(out.code).toBe(0);
      expect(out.output).toContain("endpoint=none");
      expect(out.output.trimEnd().split("\n").at(-1)).toContain("狭い閉じ込めでは Chrome が起動できない");
      // 立てたときは、宛先を渡し、コマンドが終わったら必ず閉じる
      const ok = new SandboxRunner(async () => ({ endpoint: "ws://127.0.0.1:9/abc", close: async () => void closed++ }));
      const out2 = await ok.run("echo endpoint=$KURAMOTO_E2E_WS_ENDPOINT; echo test; exit 3", dir, { ...conf, hidden: [], allowedDomains: [], hiddenEnv: [] }, 60_000);
      expect(out2.code).toBe(3);
      expect(out2.output).toContain("endpoint=ws://127.0.0.1:9/abc");
      expect(closed).toBe(1);
      await r.close();
      await ok.close();
    } finally {
      delete process.env.KURAMOTO_E2E_CONFINED_BROWSER;
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
