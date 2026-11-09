import { z } from "zod";
import { all, get, run, tx } from "../db/sqlite.js";
import { artifact, hasContent, STAGES, type Stage } from "./planning.js";
import type { Project, TicketStage } from "./project.js";
import { createTicket } from "./workflow.js";

/**
 * 設計書(Markdown)に埋め込んで、Kuramoto が読み戻すためのデータ。
 * 人が読む本文から逆算すると図の配置や画面の全案が失われるので、企画の中身をそのまま JSON で持たせる。
 * 担当の会話の続き(ハーネスのセッション)はこのマシンにしか無いので含めない。
 */
export const TRANSFER_VERSION = 1;

const stageEnum = z.enum(STAGES);

export const transferSchema = z.object({
  kuramoto: z.literal(TRANSFER_VERSION),
  exportedAt: z.string(),
  project: z.object({ name: z.string().min(1) }),
  repos: z.array(z.object({ fullName: z.string(), role: z.string() })).min(1),
  settings: z.record(z.string(), z.string()),
  stages: z.array(z.object({ stage: stageEnum, mode: z.enum(["agree", "delegate", "skip"]), version: z.number().int().min(1), agreedVersion: z.number().int().nullable() })),
  requirements: z.array(z.object({ code: z.string(), name: z.string(), acceptance: z.string() })),
  openItems: z.array(
    z.object({
      stage: stageEnum,
      question: z.string(),
      options: z.array(z.string()),
      recommended: z.number().int(),
      why: z.string(),
      reversible: z.boolean(),
      answer: z.string().nullable(),
      decidedBy: z.string().nullable(),
      withdrawn: z.string().nullable(),
    }),
  ),
  artifacts: z.array(z.object({ stage: stageEnum, kind: z.string(), key: z.string(), body: z.unknown() })),
  comments: z.array(z.object({ screenKey: z.string(), variant: z.string().nullable(), x: z.number().nullable(), y: z.number().nullable(), body: z.string(), resolved: z.boolean() })),
  messages: z.array(z.object({ stage: z.string(), who: z.string(), body: z.string(), at: z.string() })),
  tickets: z.array(z.object({ title: z.string(), body: z.string(), stage: z.string(), planRefs: z.record(z.string(), z.unknown()) })),
});

export type TransferData = z.infer<typeof transferSchema>;

/** 戻すときに持ち越す設定(企画の進み具合と Jira のキー)。担当のセッションなど、このマシンにしか意味の無いものは除く。 */
const KEEP_SETTING = /^(jira_key|plan_started:.+|plan_handed_at|plan_handoff_requested_at)$/;

export function collectTransfer(p: Project, projectName: string): TransferData {
  // 画面などは最初に作られた順に並べる(並び順も戻すため)
  const keys = all<{ stage: Stage; kind: string; key: string }>(p.db, "SELECT stage, kind, key FROM plan_artifacts GROUP BY stage, kind, key ORDER BY MIN(id)");
  const artifacts: TransferData["artifacts"] = [];
  for (const k of keys) {
    const body = artifact<unknown>(p, k.stage, k.kind, k.key);
    if (body !== null) artifacts.push({ stage: k.stage, kind: k.kind, key: k.key, body });
  }
  return {
    kuramoto: TRANSFER_VERSION,
    exportedAt: p.now(),
    project: { name: projectName },
    repos: p.repos().map((r) => ({ fullName: r.full_name, role: r.role })),
    settings: Object.fromEntries(all<{ key: string; value: string }>(p.db, "SELECT key, value FROM settings").filter((s) => KEEP_SETTING.test(s.key)).map((s) => [s.key, s.value])),
    stages: all<{ stage: Stage; mode: "agree" | "delegate" | "skip"; version: number; agreed_version: number | null }>(p.db, "SELECT * FROM plan_stages").map((s) => ({
      stage: s.stage,
      mode: s.mode,
      version: s.version,
      agreedVersion: s.agreed_version,
    })),
    requirements: all<{ code: string; name: string; acceptance: string }>(
      p.db,
      "SELECT code, name, acceptance FROM requirement_items WHERE removed_in IS NULL ORDER BY CAST(SUBSTR(code, 2) AS INTEGER), id",
    ),
    openItems: all<{ stage: Stage; question: string; options: string; recommended: number; why: string; reversible: number; answer: string | null; decided_by: string | null; withdrawn: string | null }>(
      p.db,
      "SELECT * FROM plan_open_items ORDER BY id",
    ).map((o) => ({
      stage: o.stage,
      question: o.question,
      options: JSON.parse(o.options) as string[],
      recommended: o.recommended,
      why: o.why,
      reversible: !!o.reversible,
      answer: o.answer,
      decidedBy: o.decided_by,
      withdrawn: o.withdrawn,
    })),
    artifacts,
    comments: all<{ key: string; variant: string | null; x: number | null; y: number | null; body: string; resolved_in: number | null }>(
      p.db,
      "SELECT a.key, c.variant, c.x, c.y, c.body, c.resolved_in FROM plan_comments c JOIN plan_artifacts a ON a.id = c.artifact_id ORDER BY c.id",
    ).map((c) => ({ screenKey: c.key, variant: c.variant, x: c.x, y: c.y, body: c.body, resolved: c.resolved_in !== null })),
    messages: all<{ stage: string; who: string; body: string; at: string }>(p.db, "SELECT stage, who, body, at FROM plan_messages ORDER BY id"),
    tickets: p.tickets().map((t) => ({ title: t.title, body: t.body, stage: t.stage, planRefs: JSON.parse(t.plan_refs || "{}") as Record<string, unknown> })),
  };
}

/**
 * 空のプロジェクトに、書き出したときの企画の状態を戻す。版は書き出したときの番号のまま置く(途中の版の履歴は戻さない)。
 * チケットは、完了・取りやめはそのまま、それ以外は開発の受信箱に入れ直す(PR は GitHub にあるので、持ち主が続きから直す)。
 */
export function restoreTransfer(p: Project, d: TransferData): void {
  tx(p.db, () => {
    if (get(p.db, "SELECT 1 AS x FROM plan_artifacts LIMIT 1") || p.tickets().length) throw new Error("空のプロジェクトにだけ戻せます");
    for (const [k, v] of Object.entries(d.settings)) if (KEEP_SETTING.test(k)) p.setSetting(k, v);

    for (const s of d.stages) run(p.db, "UPDATE plan_stages SET mode = ?, version = ?, agreed_version = ? WHERE stage = ?", [s.mode, s.version, s.agreedVersion, s.stage]);
    const version = (s: Stage) => d.stages.find((x) => x.stage === s)?.version ?? 1;

    const reqV = version("req");
    if (!get(p.db, "SELECT 1 AS x FROM requirements WHERE version = ?", [reqV])) run(p.db, "INSERT INTO requirements (version, created_at) VALUES (?, ?)", [reqV, p.now()]);
    for (const r of d.requirements) run(p.db, "INSERT INTO requirement_items (code, name, acceptance, added_in) VALUES (?, ?, ?, ?)", [r.code, r.name, r.acceptance, reqV]);

    const screenRow = new Map<string, number>();
    for (const a of d.artifacts) {
      const id = run(p.db, "INSERT INTO plan_artifacts (stage, version, kind, key, body) VALUES (?, ?, ?, ?, ?)", [a.stage, version(a.stage), a.kind, a.key, JSON.stringify(a.body)]).lastId;
      if (a.stage === "screen" && a.kind === "screen") screenRow.set(a.key, id);
    }
    for (const c of d.comments) {
      const aid = screenRow.get(c.screenKey);
      if (!aid) continue;
      run(p.db, "INSERT INTO plan_comments (artifact_id, x, y, body, variant, resolved_in, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)", [
        aid,
        c.x,
        c.y,
        c.body,
        c.variant,
        c.resolved ? version("screen") : null,
        p.now(),
      ]);
    }
    for (const o of d.openItems) {
      run(
        p.db,
        "INSERT INTO plan_open_items (stage, question, options, recommended, why, reversible, answer, decided_by, withdrawn, created_at, answered_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [o.stage, o.question, JSON.stringify(o.options), o.recommended, o.why, o.reversible ? 1 : 0, o.answer, o.decidedBy, o.withdrawn, p.now(), o.answer === null ? null : p.now()],
      );
    }
    for (const m of d.messages) run(p.db, "INSERT INTO plan_messages (stage, who, body, at) VALUES (?, ?, ?, ?)", [m.stage, m.who, m.body, m.at]);
    run(p.db, "INSERT INTO plan_messages (stage, who, body, at) VALUES ('req', 'plan', ?, ?)", [`設計書(${d.exportedAt} に書き出したもの)から復元しました。担当は、ここまでの中身を読み直してから続きを始めます。`, p.now()]);

    for (const t of d.tickets) {
      const final = (t.stage === "done" || t.stage === "dropped") as boolean;
      if (final) {
        const row = p.addTicket({ title: t.title, body: t.body, planRefs: t.planRefs });
        p.setStage(row.id, t.stage as TicketStage);
      } else {
        createTicket(p, { title: t.title, body: t.body, planRefs: t.planRefs });
      }
    }
    // 書き出したときに担当が作業中・順番待ちだった依頼は持ち越していない。
    // 始まっているのに中身が無い段階は「まだ始まっていない」に戻し、advance() で担当を起こし直す
    for (const s of STAGES) {
      if (p.setting(`plan_started:${s}`) && !hasContent(p, s)) run(p.db, "DELETE FROM settings WHERE key = ?", [`plan_started:${s}`]);
    }
    if (p.setting("plan_handoff_requested_at") && !p.setting("plan_handed_at")) run(p.db, "DELETE FROM settings WHERE key = 'plan_handoff_requested_at'");
    p.event("system", "restored", null, { exportedAt: d.exportedAt });
  });
}

// ---- Markdown への埋め込み ----

const MARK = "kuramoto-export";

/** 設計書の末尾に置く。HTML コメントなので、GitHub などで開いても表示されない。 */
export function embedTransfer(d: TransferData): string {
  const b64 = Buffer.from(JSON.stringify(d), "utf8").toString("base64");
  const lines = b64.match(/.{1,120}/g) ?? [];
  return [
    "",
    "---",
    "",
    "_この下の注釈は、Kuramoto がこの設計書からプロジェクトを復元するためのデータです(本文を書き換えても、復元には反映されません)。_",
    "",
    `<!-- ${MARK} v${TRANSFER_VERSION}`,
    ...lines,
    "-->",
    "",
  ].join("\n");
}

/** 設計書から埋め込みデータを取り出す。無い・壊れているときは理由を投げる。 */
export function extractTransfer(markdown: string): TransferData {
  const m = markdown.match(new RegExp(`<!-- ${MARK} v(\\d+)([\\s\\S]*?)-->`));
  if (!m) throw new Error("Kuramoto が書き出した設計書ではありません(復元用のデータが見つかりません)");
  if (Number(m[1]) !== TRANSFER_VERSION) throw new Error(`この設計書の形式(v${m[1]})には対応していません`);
  const b64 = m[2]!.replace(/\s+/g, "");
  let json: unknown;
  try {
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) throw new Error();
    json = JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
  } catch {
    throw new Error("復元用のデータが壊れています");
  }
  const r = transferSchema.safeParse(json);
  if (!r.success) throw new Error(`復元用のデータの形が正しくありません: ${r.error.issues[0]?.path.join(".")} ${r.error.issues[0]?.message}`);
  return r.data;
}
