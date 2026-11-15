import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Connection } from "mysql2/promise";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { ManualClock } from "../clock.js";
import type { KuramotoConfig } from "../config.js";
import { connectTest, MYSQL_TEST_URL, resetDatabase } from "../db/mysql-test-support.js";
import { startDatabase, type StartedDatabase } from "../db/startup.js";
import type { GitHub } from "../github/github.js";
import { FakeHarness } from "../harness/fake.js";
import { currentWorkspaceId, Hq } from "../hq.js";
import { Dispatcher } from "./dispatcher.js";
import { newIssues, pollIssues } from "./issues.js";
import { Project } from "./project.js";
import { StaticWorkspace } from "./workspace.js";

/**
 * GitHub の Issue を見回りで拾う(#79)を、SQLite と MySQL の両方の DB の上で確かめる(flow-e2e.test.ts と同じ作り)。
 *  - SQLite の回(常に流れる。プロジェクトはファイルの DB)と MySQL の回(mysql-test に繋がるときだけ。npm test の MySQL の回では繋がらなければ落ちる)を、同じ試験で流す。
 *  - GitHub はフェイク。
 *  - 「サーバーを立ち上げ直しても」は、同じ DB を Project として開き直して確かめる。
 */
const admin: Connection | undefined = await connectTest();
afterAll(async () => {
  await admin?.end();
});

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const f of cleanups.splice(0).reverse()) await f();
});

type Kind = "sqlite" | "mysql";

type FakeIssue = { number: number; title: string; body: string; url: string; labels: string[] };
const issue = (number: number): FakeIssue => ({ number, title: `課題 ${number}`, body: `課題 ${number} の本文`, url: `https://github.com/acme/shop/issues/${number}`, labels: ["kuramoto"] });

/** その DB の上で本部を開き、プロジェクトを 1 つ作る。開き直せるように、本部とプロジェクトの id を返す。 */
async function boot(kind: Kind) {
  const home = mkdtempSync(join(tmpdir(), "kuramoto-issues-"));
  let db: StartedDatabase = { async close() {} };
  let hq: Hq;
  if (kind === "sqlite") {
    hq = new Hq(home, new ManualClock(), currentWorkspaceId());
  } else {
    await resetDatabase(admin!);
    const config: KuramotoConfig = { file: undefined, database: { type: "mysql", url: MYSQL_TEST_URL }, databaseUrlFromEnv: false };
    db = await startDatabase(config, () => {}, home);
    hq = new Hq(home, new ManualClock(), currentWorkspaceId(), db.mysql);
  }
  const opened = new Set<Project>();
  cleanups.push(async () => {
    for (const p of opened) p.close();
    hq.close();
    await db.close();
    rmSync(home, { recursive: true, force: true });
  });
  const id = (await hq.createProject("お試し", [{ fullName: "acme/shop", role: "API" }])).id;
  const open = async (): Promise<Project> => {
    const p = await hq.openProject(id);
    opened.add(p);
    return p;
  };
  /** 閉じる(立ち上げ直しの前)。後片付けで二度閉じない。 */
  const close = (p: Project) => {
    opened.delete(p);
    p.close();
  };
  const state = { issues: [] as FakeIssue[], fail: false, labels: [] as (string | null)[], comments: [] as string[] };
  const gh = {
    async openIssues(_repo: string, label: string | null) {
      state.labels.push(label);
      if (state.fail) throw new Error("gh: network is unreachable");
      return state.issues;
    },
    async commentIssue(_repo: string, n: number, body: string) {
      state.comments.push(`#${n} ${body}`);
    },
  } as unknown as GitHub;
  return { hq, open, close, state, gh, clock: hq.clock as ManualClock };
}

/** 見回りの間隔が過ぎた状態で 1 周期だけ動かす。リーダー(フェイクの harness)に渡った指示を返す。 */
async function cycle(p: Project, gh: GitHub, onLead: (req: { prompt: string; tools: { name: string }[] }, call: (name: string, args: Record<string, unknown>) => Promise<string>) => Promise<{ finalText?: string } | void>) {
  const prompts: string[] = [];
  await p.setSetting("patrol_last_at", "2000-01-01T00:00:00.000Z");
  // 新しい Issue への応答だけを見る。ほかの起動(新しいチケットの交通整理・担当の仕事)は、取れない時刻にしておく
  await p.pdb.update("messages", { available_at: "9999" }).where("kind", "<>", "patrol").execute();
  const harness = new FakeHarness(async (req, call) => {
    prompts.push(req.prompt);
    return (await onLead(req as never, call as never)) ?? {};
  });
  const d = new Dispatcher(p, { harnesses: { "claude-agent-sdk": harness }, workspace: new StaticWorkspace("/tmp"), triage: true, github: gh, recheckMs: 10 });
  await d.drain({ concurrency: 1, maxRuns: 1 });
  return prompts;
}

for (const kind of ["sqlite", "mysql"] as const) {
  describe.skipIf(kind === "mysql" && !admin)(`GitHub の Issue を見回りで拾う(${kind})`, () => {
    it("新しい Issue が無い周期では、取りには行くが、リーダー(LLM)は一度も呼ばない", async () => {
      const { open, state, gh, clock } = await boot(kind);
      const p = await open();
      clock.advance(10 * 60_000);
      const prompts = await cycle(p, gh, async () => ({}));
      expect(state.labels).toEqual(["kuramoto"]);
      expect(prompts).toEqual([]);
      expect(await newIssues(p)).toEqual([]);
    });

    it("新しい Issue に、リーダーが一度だけ応答してチケットができる。DB を開き直しても(立ち上げ直しても)二度は応答せず、チケットも増えない", async () => {
      const { open, close, state, gh, clock } = await boot(kind);
      let p = await open();
      state.issues = [issue(5)];
      clock.advance(10 * 60_000);
      const first = await cycle(p, gh, async (_req, call) => {
        expect(await call("create_ticket", { title: "課題 5 を直す", body: "やること", kind: "bugfix", issue: 5 })).toMatch(/を作りました/);
        return { finalText: "Issue #5 をチケットにしました。" };
      });
      expect(first).toHaveLength(1);
      expect(first[0]).toContain("Issue #5(acme/shop): 課題 5");
      let t = (await p.tickets())[0]!;
      expect(JSON.parse(t.plan_refs)).toMatchObject({ issue: 5, issueUrl: "https://github.com/acme/shop/issues/5", issueRepo: "acme/shop" });
      expect((await p.pdb.from("github_issues").execute()).map((r) => [r.number, r.status, r.ticket_id])).toEqual([[5, "ticketed", t.id]]);
      expect((await p.pdb.from("lead_messages").execute()).some((m) => m.who === "lead" && m.body.includes("Issue #5") && m.body.includes(`チケット #${t.number}`))).toBe(true);
      expect(state.comments).toEqual([]); // 既定ではコメントを書かない

      // 立ち上げ直す(同じ DB を開き直す)。Issue はまだ GitHub で開いている
      close(p);
      p = await open();
      clock.advance(10 * 60_000);
      expect(await pollIssues(p, gh)).toBe(0);
      t =(await p.tickets())[0]!;
      const polls = state.labels.length;
      clock.advance(10 * 60_000);
      await p.pdb.update("tickets", { triaged: 1 }).execute(); // 交通整理は済んだことにして、リーダーが呼ばれるとすれば Issue のためだけにする
      const second = await cycle(p, gh, async () => ({}));
      expect(state.labels.length).toBe(polls + 1); // 取りには行く
      expect(second).toEqual([]); // リーダーは呼ばれない
      expect(await p.tickets()).toHaveLength(1);
      expect(await newIssues(p)).toEqual([]);
    });

    it("gh が失敗しても見回りは止まらず、出来事に残し、次の周期でやり直す。立ち上げ直しても、扱った Issue は新しいものに戻らない", async () => {
      const { open, close, state, gh, clock } = await boot(kind);
      let p = await open();
      state.issues = [issue(5)];
      state.fail = true;
      expect(await pollIssues(p, gh)).toBe(0);
      expect((await p.events(100)).some((e) => e.type === "issue_poll_failed")).toBe(true);
      state.fail = false;
      clock.advance(5 * 60_000);
      expect(await pollIssues(p, gh)).toBe(1);
      close(p);
      p = await open();
      clock.advance(5 * 60_000);
      expect(await pollIssues(p, gh)).toBe(0);
      expect((await newIssues(p)).map((i) => i.number)).toEqual([5]);
    });
  });
}
