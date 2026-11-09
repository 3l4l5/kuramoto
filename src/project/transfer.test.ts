import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ManualClock } from "../clock.js";
import { Hq } from "../hq.js";
import { exportDesignDoc } from "./export.js";
import {
  advance,
  addComment,
  addOpenItem,
  agree,
  agreeScreen,
  answerOpenItem,
  chat,
  pickVariant,
  putArtifact,
  putScreen,
  resolveComment,
  setMode,
  studioView,
  upsertRequirement,
  withdrawOpenItem,
} from "./planning.js";
import { collectTransfer, extractTransfer, restoreTransfer } from "./transfer.js";
import { createTicket } from "./workflow.js";

const homes: string[] = [];
afterEach(() => homes.splice(0).forEach((h) => rmSync(h, { recursive: true, force: true })));

function newHq() {
  const home = mkdtempSync(join(tmpdir(), "kuramoto-transfer-"));
  homes.push(home);
  return new Hq(home, new ManualClock());
}

/** 企画の中身がひととおり詰まったプロジェクトを作る。 */
function fullProject(hq: Hq) {
  const rec = hq.createProject("予約サイト", [
    { fullName: "acme/reserve-web", role: "フロント" },
    { fullName: "acme/shop-api", role: "API" },
  ]);
  const p = hq.openProject(rec.id);
  p.setSetting("jira_key", "RSV");
  p.setSetting("plan_session:5", "このマシンだけのセッション");
  putArtifact(p, "req", "brief", "main", { purpose: "予約を 1 分で", users: ["会員"], outOfScope: ["決済"] });
  upsertRequirement(p, { name: "空き枠を探す", acceptance: "残りのある枠が並ぶ" });
  upsertRequirement(p, { name: "予約する", acceptance: "確定すると予約できる" });
  answerOpenItem(p, addOpenItem(p, "req", { question: "変更を作るか", options: ["作らない", "作る"], recommended: 0, why: "足りる", reversible: true }), "作らない");
  withdrawOpenItem(p, addOpenItem(p, "req", { question: "取り下げる問い", options: ["a", "b"], recommended: 0, why: "", reversible: true }), "聞く意味がなくなった");
  chat(p, "req", "予約サイトを作りたい");
  agree(p, "req");
  // 合意した要件を直して、版を上げておく
  upsertRequirement(p, { code: "R2", name: "予約する", acceptance: "確定すると予約でき、メールが届く" });
  putArtifact(p, "flow", "flow", "main", { nodes: [{ id: "S1", label: "探す", col: 2, row: 1 }], edges: [] });
  agree(p, "flow");
  putScreen(p, "search", { name: "空き枠を探す", device: "phone", requirements: ["R1"], variants: [{ id: "A", html: "<p>A</p>" }, { id: "B", html: "<p>B</p>" }], chosen: null, agreed: false });
  putScreen(p, "confirm", { name: "予約の確認", device: "desktop", requirements: ["R2"], variants: [{ id: "A", html: "<p>C</p>" }], chosen: "A", agreed: false });
  pickVariant(p, "search", "B");
  const c1 = addComment(p, "search", { variant: "B", x: 40, y: 60, body: "大きく" });
  resolveComment(p, c1);
  addComment(p, "search", { variant: "B", x: 10, y: 20, body: "まだ直っていない" });
  agreeScreen(p, "confirm");
  setMode(p, "infra", "skip");
  setMode(p, "model", "delegate");
  addOpenItem(p, "model", { question: "データを消すか", options: ["消す", "残す"], recommended: 1, why: "戻せない", reversible: false });
  putArtifact(p, "model", "architecture", "main", {
    style: { name: "モジュラーモノリス", why: "速い", alternatives: [] },
    modules: [],
    principles: [],
    api: { style: "REST", notes: "" },
    frontend: { rendering: "SPA", state: "" },
    stack: [],
  });
  createTicket(p, { title: "予約の表を足す", body: "R2", planRefs: { fromPlan: true, requirement: "R2", screens: [], design: [] } });
  return { rec, p };
}

describe("設計書からの復元", () => {
  it("書き出したときに担当が作業中だった段階は、復元したあと担当を起こし直す", () => {
    const hq = newHq();
    const rec = hq.createProject("途中", [{ fullName: "acme/mid", role: "API" }]);
    const p = hq.openProject(rec.id);
    advance(p); // 要件の段階を始める
    upsertRequirement(p, { name: "探す", acceptance: "並ぶ" });
    agree(p, "req"); // フローの担当が起こされる(まだ描いていない)
    expect(p.setting("plan_started:flow")).toBeTruthy();
    const data = extractTransfer(exportDesignDoc(p, "途中"));

    const q = hq.openProject(hq.createProject("途中", data.repos).id);
    restoreTransfer(q, data);
    expect(q.setting("plan_started:flow")).toBeUndefined();
    advance(q);
    expect(q.db.prepare("SELECT to_role, json_extract(payload, '$.stage') AS stage FROM messages WHERE status = 'pending'").all()).toEqual([
      { to_role: "designer", stage: "flow" },
    ]);
  });

  it("書き出した設計書を読み込むと、企画の中身がそのまま戻る(このマシンだけのセッションは持ち越さない)", () => {
    const hq = newHq();
    const { p } = fullProject(hq);
    const md = exportDesignDoc(p, "予約サイト");
    // 人が読む本文はそのまま、末尾に復元用のデータが HTML コメントで入る
    expect(md).toContain("# 予約サイト 設計書");
    expect(md).toMatch(/<!-- kuramoto-export v1\n[A-Za-z0-9+/=\n]+-->/);

    const data = extractTransfer(md);
    expect(data.settings).toMatchObject({ jira_key: "RSV" });
    expect(data.settings["plan_session:5"]).toBeUndefined();

    const rec2 = hq.createProject(data.project.name, data.repos);
    expect(rec2.data_dir).toMatch(/reserve-web-2$/); // 同じリポジトリでも置き場所は分ける
    const q = hq.openProject(rec2.id);
    restoreTransfer(q, data);

    // 書き出した中身が同じ(書き出した時刻・会話の「復元しました」・チケットの番号以外)
    const strip = (t: ReturnType<typeof collectTransfer>) => ({ ...t, exportedAt: "", messages: t.messages.filter((m) => !m.body.includes("復元しました")) });
    expect(strip(collectTransfer(q, "予約サイト"))).toEqual(strip(collectTransfer(p, "予約サイト")));

    // 画面に出す状態も同じ
    const view = (x: typeof p) => {
      const v = studioView(x);
      return {
        stages: v.stages.map((s) => ({ key: s.key, mode: s.mode, version: s.version, agreedVersion: s.agreedVersion, status: s.status, done: s.done })),
        screens: v.screens.map((s) => ({ key: s.key, chosen: s.chosen, agreed: s.agreed, comments: s.comments.map((c) => [c.body, c.variant, c.x, c.y, c.resolved_in !== null]) })),
        open: v.openItems.map((o) => [o.question, o.answer, o.reversible]),
        requirements: v.requirements.map((r) => [r.code, r.acceptance]),
      };
    };
    expect(view(q)).toEqual(view(p));
    expect(view(q).stages.find((s) => s.key === "req")).toMatchObject({ version: 2, agreedVersion: 1 });
    expect(q.tickets().map((t) => [t.title, t.stage, t.jira_key])).toEqual([["予約の表を足す", "dev", "RSV-1"]]);
    expect(studioView(q).messages.at(-1)!.body).toContain("復元しました");
  });

  it("Kuramoto が書き出したものでない・壊れている・空でないプロジェクトには戻さない", () => {
    expect(() => extractTransfer("# ただの Markdown")).toThrow(/Kuramoto が書き出した設計書ではありません/);
    expect(() => extractTransfer("<!-- kuramoto-export v1\n!!!!\n-->")).toThrow(/壊れています/);
    expect(() => extractTransfer(`<!-- kuramoto-export v1\n${Buffer.from(JSON.stringify({ kuramoto: 1 })).toString("base64")}\n-->`)).toThrow(/形が正しくありません/);
    expect(() => extractTransfer("<!-- kuramoto-export v9\nAAAA\n-->")).toThrow(/v9/);

    const hq = newHq();
    const { p } = fullProject(hq);
    expect(() => restoreTransfer(p, extractTransfer(exportDesignDoc(p, "予約サイト")))).toThrow(/空のプロジェクト/);
  });
});
