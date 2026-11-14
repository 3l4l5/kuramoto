import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Connection } from "mysql2/promise";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { ManualClock } from "../clock.js";
import type { KuramotoConfig } from "../config.js";
import { connectTest, MYSQL_TEST_URL, resetDatabase } from "../db/mysql-test-support.js";
import { startDatabase, type StartedDatabase } from "../db/startup.js";
import { FakeHarness } from "../harness/fake.js";
import { currentWorkspaceId, Hq } from "../hq.js";
import { Dispatcher } from "./dispatcher.js";
import { createPeriodicReview, deletePeriodicReview, listPeriodicReviews, listPeriodicRuns, requestPeriodicReviews, setPeriodicReviewEnabled, startPeriodicRun, updatePeriodicReview, REVIEW_TEMPLATES } from "./periodic-review.js";
import { Project } from "./project.js";
import { StaticWorkspace } from "./workspace.js";

/**
 * 定期レビュー(#89)を、SQLite と MySQL の両方の DB の上で確かめる(flow-e2e.test.ts と同じ作り)。
 *  - SQLite の回(常に流れる。プロジェクトはファイルの DB)と MySQL の回(mysql-test に繋がるときだけ。npm test の MySQL の回では繋がらなければ落ちる)を、同じ試験で流す。
 *  - 担当(エージェント)はフェイクの harness。
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
  return { open, clock: hq.clock as ManualClock };
}

const HOUR = 3_600_000;
const input = { name: "QA の見回り", viewpoint: "壊れていそうなところを探す", everyHours: 24, role: "qa", targetKind: "repo" } as const;

for (const kind of ["sqlite", "mysql"] as const) {
  describe.skipIf(kind === "mysql" && !admin)(`定期レビュー(${kind})`, () => {
    it("作る・直す・無効にする・消す。入力は確かめる", async () => {
      const { open } = await boot(kind);
      const p = await open();
      const r = await createPeriodicReview(p, input);
      expect(r).toMatchObject({ name: "QA の見回り", everyHours: 24, role: "qa", targetKind: "repo", enabled: true, template: null });
      await expect(createPeriodicReview(p, { ...input, everyHours: 0 })).rejects.toThrow();
      await expect(createPeriodicReview(p, { ...input, name: " " })).rejects.toThrow();
      await expect(createPeriodicReview(p, { ...input, targetKind: "screens", targetScreens: [] })).rejects.toThrow(/画面/);
      await expect(createPeriodicReview(p, { ...input, targetKind: "screens", targetScreens: ["nope"] })).rejects.toThrow(/企画にありません/);
      const u = await updatePeriodicReview(p, r.id, { ...input, name: "改名", everyHours: 168, role: "designer" });
      expect(u).toMatchObject({ name: "改名", everyHours: 168, role: "designer" });
      expect((await setPeriodicReviewEnabled(p, r.id, false)).enabled).toBe(false);
      expect((await listPeriodicReviews(p)).map((x) => x.nextRunAt)).toEqual([null]);
      await startPeriodicRun(p, r.id, "manual");
      await deletePeriodicReview(p, r.id);
      expect(await listPeriodicReviews(p)).toEqual([]);
      expect(await listPeriodicRuns(p)).toEqual([]);
      expect(await p.pdb.from("messages").select("id").where("kind", "=", "periodic_review").execute()).toEqual([]);
    });

    it("初期の観点(デザイナーによる画面レビュー)を、ひな形から作れる", async () => {
      const { open } = await boot(kind);
      const p = await open();
      const t = REVIEW_TEMPLATES[0]!;
      expect(t.key).toBe("designer_screens");
      const r = await createPeriodicReview(p, {}, t.key);
      expect(r).toMatchObject({ template: "designer_screens", role: "designer", targetKind: "all_screens", everyHours: 168 });
      expect(r.viewpoint).toContain("1280px");
      await expect(createPeriodicReview(p, {}, "nope")).rejects.toThrow(/ひな形/);
    });

    it("頻度が来たら起動する。来る前・無効のとき・実行待ちのあいだは起動しない", async () => {
      const { open, clock } = await boot(kind);
      const p = await open();
      const r = await createPeriodicReview(p, input);
      expect(await requestPeriodicReviews(p)).toBe(0);
      clock.advance(23 * HOUR);
      expect(await requestPeriodicReviews(p)).toBe(0);
      clock.advance(2 * HOUR);
      expect(await requestPeriodicReviews(p)).toBe(1);
      expect(await requestPeriodicReviews(p)).toBe(0);
      expect((await listPeriodicRuns(p)).map((x) => [x.origin, x.status])).toEqual([["schedule", "queued"]]);
      // 手動で重ねて起こすことはできない
      expect(await startPeriodicRun(p, r.id, "manual")).toBeNull();
      // 無効にして、また有効にしても、溜まった分を一度に回さない
      await setPeriodicReviewEnabled(p, r.id, false);
      clock.advance(100 * HOUR);
      expect(await requestPeriodicReviews(p)).toBe(0);
      await setPeriodicReviewEnabled(p, r.id, true);
      expect(await requestPeriodicReviews(p)).toBe(0);
    });

    it("ハーネスが無くて再試行が尽きたら、記録を error で閉じ、次の回が起動できる(定義が詰まらない)", async () => {
      const { open } = await boot(kind);
      const p = await open();
      await p.setSetting("max_attempts", "1");
      const r = await createPeriodicReview(p, {}, "designer_screens");
      const first = (await startPeriodicRun(p, r.id, "manual"))!;
      await p.pdb.update("messages", { available_at: "2000-01-01T00:00:00.000Z" }).execute();
      const d = new Dispatcher(p, { harnesses: {}, workspace: new StaticWorkspace("/tmp"), recheckMs: 10 });
      await d.drain({ concurrency: 1, maxRuns: 1 });
      expect((await p.pdb.from("messages").select("status").where("kind", "=", "periodic_review").executeTakeFirst())?.status).toBe("failed");
      expect((await listPeriodicRuns(p))[0]).toMatchObject({ id: first, status: "error", error: expect.stringContaining("ハーネス") });
      expect(await startPeriodicRun(p, r.id, "manual")).not.toBeNull();
    });

    it("ひも付くメッセージが failed のまま取り残された回は、次の起動で閉じられて詰まらない", async () => {
      const { open } = await boot(kind);
      const p = await open();
      const r = await createPeriodicReview(p, input);
      const first = (await startPeriodicRun(p, r.id, "manual"))!;
      expect(await startPeriodicRun(p, r.id, "manual")).toBeNull(); // まだ待っている回がある
      await p.pdb.update("messages", { status: "failed" }).where("kind", "=", "periodic_review").execute();
      const second = await startPeriodicRun(p, r.id, "manual");
      expect(second).not.toBeNull();
      expect((await listPeriodicRuns(p)).find((x) => x.id === first)).toMatchObject({ status: "error" });
      // 消すときは、待っているメッセージも、この定義のものだけが消える
      const other = await createPeriodicReview(p, { ...input, name: "別" });
      await startPeriodicRun(p, other.id, "manual");
      await deletePeriodicReview(p, r.id);
      const left = await p.pdb.from("messages").select("payload").where("kind", "=", "periodic_review").where("status", "=", "pending").execute();
      expect(left.map((m) => (JSON.parse(m.payload) as { reviewId: number }).reviewId)).toEqual([other.id]);
    });

    it("担当が見つけたものがチケットになり、重複は切らない。実行の記録に残る", async () => {
      const { open } = await boot(kind);
      const p = await open();
      const r = await createPeriodicReview(p, {}, "designer_screens");
      await p.pdb.update("messages", { available_at: "9999" }).execute();
      const runId = (await startPeriodicRun(p, r.id, "manual"))!;
      await p.pdb.update("messages", { available_at: "2000-01-01T00:00:00.000Z" }).where("kind", "=", "periodic_review").execute();
      const prompts: string[] = [];
      const harness = new FakeHarness(async (req, call) => {
        prompts.push(req.prompt);
        const c = call as (name: string, args: Record<string, unknown>) => Promise<string>;
        expect(await c("create_review_ticket", { title: "一覧の余白が試作とずれている", body: "8px 足りない" })).toMatch(/を作りました/);
        expect(await c("create_review_ticket", { title: "一覧の余白が試作とずれている", body: "同じこと" })).toMatch(/重複/);
        expect(await c("create_review_ticket", { title: "ボタンの色がトークン外", body: "独自の色", kind: "bugfix" })).toMatch(/を作りました/);
        return { finalText: "2 件見つけました" };
      });
      const d = new Dispatcher(p, { harnesses: { "claude-agent-sdk": harness }, workspace: new StaticWorkspace("/tmp"), recheckMs: 10 });
      await d.drain({ concurrency: 1, maxRuns: 1 });
      expect(prompts).toHaveLength(1);
      expect(prompts[0]).toContain("デザイナーによる画面レビュー");
      const tickets = await p.tickets();
      expect(tickets.map((t) => [t.title, t.kind])).toEqual([["一覧の余白が試作とずれている", "bugfix"], ["ボタンの色がトークン外", "bugfix"]]);
      const [run] = await listPeriodicRuns(p);
      expect(run).toMatchObject({ id: runId, origin: "manual", status: "done", skippedDuplicates: 1, summary: "2 件見つけました" });
      expect(run!.createdTickets).toEqual(tickets.map((t) => t.number));
      expect(run!.lookedAt).toContain("390px");
      expect(run!.endedAt).not.toBeNull();
    });
  });
}
