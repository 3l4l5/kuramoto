import { z } from "zod";
import { inScope } from "../db/count.js";
import { dialect } from "../db/dialect/index.js";
import { inferDevDone } from "../domain/dev-done.js";
import { TICKET_KINDS } from "../domain/flow.js";
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
  // kind / devDone は古い書き出し(無し)も読めるよう省略可。kind が無ければ feature、devDone が無ければ工程から決める(inferDevDone)
  tickets: z.array(z.object({ title: z.string(), body: z.string(), stage: z.string(), kind: z.enum(TICKET_KINDS).optional(), devDone: z.boolean().optional(), planRefs: z.record(z.string(), z.unknown()) })),
});

export type TransferData = z.infer<typeof transferSchema>;

/** 戻すときに持ち越す設定(企画の進み具合と Jira のキー)。担当のセッションなど、このマシンにしか意味の無いものは除く。 */
const KEEP_SETTING = /^(jira_key|plan_started:.+|plan_handed_at|plan_handoff_requested_at)$/;

export async function collectTransfer(p: Project, projectName: string): Promise<TransferData> {
  const [artifactRows, settings, stageRows, reqRows, openRows, commentRows, messageRows] = await Promise.all([
    inScope(p.pdb, "plan_artifacts").orderBy("id").execute(),
    inScope(p.pdb, "settings").execute(),
    inScope(p.pdb, "plan_stages").execute(),
    inScope(p.pdb, "requirement_items").where("removed_in", "is", null).execute(),
    inScope(p.pdb, "plan_open_items").orderBy("id").execute(),
    inScope(p.pdb, "plan_comments").orderBy("id").execute(),
    inScope(p.pdb, "plan_messages").orderBy("id").execute(),
  ]);
  // 画面などは最初に作られた順に並べる(並び順も戻すため)
  const seen = new Set<string>();
  const keys: { stage: Stage; kind: string; key: string }[] = [];
  for (const r of artifactRows) {
    const id = JSON.stringify([r.stage, r.kind, r.key]);
    if (seen.has(id)) continue;
    seen.add(id);
    keys.push({ stage: r.stage as Stage, kind: r.kind, key: r.key });
  }
  const artifacts: TransferData["artifacts"] = [];
  for (const k of keys) {
    const body = await artifact<unknown>(p, k.stage, k.kind, k.key);
    if (body !== null) artifacts.push({ stage: k.stage, kind: k.kind, key: k.key, body });
  }
  const keyOf = new Map(artifactRows.map((a) => [a.id, a.key]));
  const codeNo = (code: string) => Number.parseInt(code.slice(1), 10) || 0;
  return {
    kuramoto: TRANSFER_VERSION,
    exportedAt: p.now(),
    project: { name: projectName },
    repos: (await p.repos()).map((r) => ({ fullName: r.full_name, role: r.role })),
    settings: Object.fromEntries(settings.filter((s) => KEEP_SETTING.test(s.key)).map((s) => [s.key, s.value])),
    stages: stageRows.map((s) => ({ stage: s.stage as Stage, mode: s.mode as "agree" | "delegate" | "skip", version: s.version, agreedVersion: s.agreed_version })),
    requirements: reqRows.sort((a, b) => codeNo(a.code) - codeNo(b.code) || a.id - b.id).map((r) => ({ code: r.code, name: r.name, acceptance: r.acceptance })),
    openItems: openRows.map((o) => ({
      stage: o.stage as Stage,
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
    comments: commentRows.flatMap((c) => {
      const key = keyOf.get(c.artifact_id);
      return key === undefined ? [] : [{ screenKey: key, variant: c.variant, x: c.x, y: c.y, body: c.body, resolved: c.resolved_in !== null }];
    }),
    messages: messageRows.map((m) => ({ stage: m.stage, who: m.who, body: m.body, at: m.at })),
    tickets: (await p.tickets()).map((t) => ({ title: t.title, body: t.body, stage: t.stage, kind: t.kind, devDone: !!t.dev_done, planRefs: JSON.parse(t.plan_refs || "{}") as Record<string, unknown> })),
  };
}

/**
 * 空のプロジェクトに、書き出したときの企画の状態を戻す。版は書き出したときの番号のまま置く(途中の版の履歴は戻さない)。
 * チケットは、完了・取りやめはそのまま、それ以外は開発の受信箱に入れ直す(PR は GitHub にあるので、持ち主が続きから直す)。
 */
export async function restoreTransfer(p: Project, d: TransferData): Promise<void> {
  await p.pdb.transaction(async () => {
    if ((await inScope(p.pdb, "plan_artifacts").limit(1).executeTakeFirst()) || (await p.tickets()).length) throw new Error("空のプロジェクトにだけ戻せます");
    for (const [k, v] of Object.entries(d.settings)) if (KEEP_SETTING.test(k)) await p.setSetting(k, v);

    for (const s of d.stages) await p.pdb.k.updateTable("plan_stages").set({ mode: s.mode, version: s.version, agreed_version: s.agreedVersion }).where("project_id", "=", p.pdb.projectId).where("stage", "=", s.stage).execute();
    const version = (s: Stage) => d.stages.find((x) => x.stage === s)?.version ?? 1;

    const reqV = version("req");
    if (!(await inScope(p.pdb, "requirements").where("version", "=", reqV).executeTakeFirst())) await p.pdb.insert("requirements", { version: reqV, created_at: p.now() }).execute();
    for (const r of d.requirements) await p.pdb.insert("requirement_items", { code: r.code, name: r.name, acceptance: r.acceptance, added_in: reqV }).execute();

    const screenRow = new Map<string, number>();
    for (const a of d.artifacts) {
      const id = await dialect.insertedId(p.pdb.insert("plan_artifacts", { stage: a.stage, version: version(a.stage), kind: a.kind, key: a.key, body: JSON.stringify(a.body) }));
      if (a.stage === "screen" && a.kind === "screen") screenRow.set(a.key, id);
    }
    for (const c of d.comments) {
      const aid = screenRow.get(c.screenKey);
      if (!aid) continue;
      await p.pdb.insert("plan_comments", { artifact_id: aid, x: c.x, y: c.y, body: c.body, variant: c.variant, resolved_in: c.resolved ? version("screen") : null, created_at: p.now() }).execute();
    }
    for (const o of d.openItems) {
      await p.pdb
        .insert("plan_open_items", { stage: o.stage, question: o.question, options: JSON.stringify(o.options), recommended: o.recommended, why: o.why, reversible: o.reversible ? 1 : 0, answer: o.answer, decided_by: o.decidedBy, withdrawn: o.withdrawn, created_at: p.now(), answered_at: o.answer === null ? null : p.now() })
        .execute();
    }
    for (const m of d.messages) await p.pdb.insert("plan_messages", { stage: m.stage, who: m.who, body: m.body, at: m.at }).execute();
    await p.pdb.insert("plan_messages", { stage: "req", who: "plan", body: `設計書(${d.exportedAt} に書き出したもの)から復元しました。担当は、ここまでの中身を読み直してから続きを始めます。`, at: p.now() }).execute();

    for (const t of d.tickets) {
      const final = (t.stage === "done" || t.stage === "dropped") as boolean;
      // 種類と、開発を通ったか(通っていれば開発より前へは戻らない)を持ち越す。古い書き出しは feature として読み、
      // devDone は SQLite の版 19 と同じ決まりで工程から決める(書き出しに起動の記録は無いので、開発の起動の有無は見られない)
      const base = { title: t.title, body: t.body, kind: t.kind, devDone: t.devDone ?? inferDevDone(t.stage, false), planRefs: t.planRefs };
      if (final) {
        const row = await p.addTicket(base);
        await p.setStage(row.id, t.stage as TicketStage);
      } else {
        await createTicket(p, base);
      }
    }
    // 書き出したときに担当が作業中・順番待ちだった依頼は持ち越していない。
    // 始まっているのに中身が無い段階は「まだ始まっていない」に戻し、advance() で担当を起こし直す
    for (const s of STAGES) {
      if (await p.setting(`plan_started:${s}`) && !await hasContent(p, s)) await p.pdb.k.deleteFrom("settings").where("project_id", "=", p.pdb.projectId).where("key", "=", `plan_started:${s}`).execute();
    }
    if (await p.setting("plan_handoff_requested_at") && !await p.setting("plan_handed_at")) await p.pdb.k.deleteFrom("settings").where("project_id", "=", p.pdb.projectId).where("key", "=", "plan_handoff_requested_at").execute();
    await p.event("system", "restored", null, { exportedAt: d.exportedAt });
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
