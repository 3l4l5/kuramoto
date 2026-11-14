/**
 * 画面の見た目を撮り直すためのフェイクのデータ(E2E_SCREENS=1 で e2e/server.ts が使う)。
 * プロジェクトとチケット 5 件・開発ルール 4 件を API で作り、ツリー・ボードに出る 5 つの状態(作業中・あなたの番・止まっている・待ち・free)は
 * 画面データ(GET /api/projects/:id)の tickets を差し替えて作る。担当を動かさずに、いつでも同じ絵を撮れる。
 * 撮り方は docs/screenshots/80/README.md。
 */
import type { ProjectView } from "../src/server.js";
import { E2E_TOKEN } from "./token.js";

const auth = { authorization: `Bearer ${E2E_TOKEN}` };
const write = { "content-type": "application/json", "x-kuramoto": "1", ...auth };

/** 作るチケット。番号は作った順(#1〜#5)。 */
const TICKETS = [
  { title: "予約の表を足す" },
  { title: "空き枠を探す画面" },
  { title: "予約の確認" },
  { title: "確認メールを送る" },
  { title: "ログインで落ちるのを直す", kind: "bugfix" },
];

async function post(base: string, path: string, data: unknown): Promise<{ id?: number }> {
  const r = await fetch(`${base}${path}`, { method: "POST", headers: write, body: JSON.stringify(data) });
  if (!r.ok) throw new Error(`${path}: ${r.status} ${await r.text()}`);
  return (await r.json()) as { id?: number };
}

/** プロジェクト「予約サイト」とチケットを作り、プロジェクトの番号を返す。 */
export async function seedScreens(base: string): Promise<number> {
  const { id } = await post(base, "/api/projects", { name: "予約サイト", repos: [{ fullName: "acme/shop", role: "API" }, { fullName: "acme/web", role: "フロント" }] });
  if (id === undefined) throw new Error("プロジェクトを作れませんでした");
  for (const t of TICKETS) await post(base, `/api/projects/${id}/tickets`, t);
  // 開発ルール(R15): 試作と同じ 4 件(ひな形)。4 つ目は無効にして、「押せない」見た目も撮れるようにする
  for (const template of ["jira", "pr-body-target", "commit-50", "migration-alone"]) await post(base, `/api/projects/${id}/dev-rules`, { template });
  const rules = (await (await fetch(`${base}/api/projects/${id}/dev-rules`, { headers: auth })).json()) as { rules: { id: number; template: string | null }[] };
  const off = rules.rules.find((r) => r.template === "migration-alone");
  if (off) await post(base, `/api/projects/${id}/dev-rules/${off.id}/enabled`, { enabled: false });
  return id;
}

/** 5 状態の確認用に、チケットの状態を差し替える。 */
export function withTreeStates(view: ProjectView): ProjectView {
  const at = (n: number) => view.tickets.find((t) => t.number === n);
  const tickets = view.tickets.map((t): ProjectView["tickets"][number] => {
    switch (t.number) {
      case 1: // 作業中: 開発の手毬が取りかかっている。#3 が待っている
        return { ...t, stage: "dev", started: true, triaging: false, worker: { name: "手毬", role: "開発", work: null } };
      case 2: // あなたの番: 責任者の判断待ち
        return { ...t, stage: "decision", started: true, triaging: false };
      case 3: // 待ち: #1 が終わるのを待っている
        return { ...t, stage: "dev", triaging: false, waitFor: [1] };
      case 4: // free: レビューで、手が空くのを待っている
        return { ...t, stage: "review", started: true, triaging: false };
      case 5: // 止まっている: 「直すまで進めない」ルールに反している
        return { ...t, stage: "dev", started: true, triaging: false, ruleBlocked: ["テストを足す"] };
      default:
        return t;
    }
  });
  const t2 = at(2);
  const decisions = t2
    ? [
        {
          id: 1,
          ticket: { id: t2.id, number: 2, title: t2.title, owner: null, rounds: 0 },
          question: "空き枠は店舗ごとに出すか、まとめて出すか",
          options: ["店舗ごと", "まとめて"],
          recommended: 0,
          why: "予約は店舗を決めてから探すため",
          impact: "あとから変えると、画面と検索の両方を作り直す",
          reversible: false,
          deadline: null,
          leadNote: null,
          pr: null,
        },
      ]
    : [];
  return { ...view, tickets, decisions };
}
