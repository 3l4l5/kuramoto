import { z } from "zod";
import { all, get } from "../db/sqlite.js";
import type { CiRun, GitHub } from "../github/github.js";
import { defineTool, type KuramotoTool } from "../harness/types.js";
import { ciFindings } from "./merge.js";
import type { Project, TicketRow } from "./project.js";
import { teamCiEnabled } from "./team-ci.js";

/**
 * CI を調べる道具(ADR-0027)。エージェントの作業場所からは GitHub が見えないので、Kuramoto が外で gh を動かして答える。
 * 読むだけのもの(状態・ログ・注記・秘密情報の名前)は開発とリーダーに、落ちたジョブのやり直しはリーダーだけに渡す。
 * 秘密情報の値・設定の変更は扱わない。
 */

const MAX = 12_000;

function clip(s: string): string {
  return s.length > MAX ? `${s.slice(0, MAX)}\n…(長いので切りました)` : s;
}

function errText(e: unknown): string {
  const err = e as { stderr?: string; message?: string };
  return (err?.stderr || err?.message || String(e)).trim().slice(0, 400);
}

function prsOf(p: Project, ticketId: number): { number: number; full_name: string }[] {
  return all(p.db, "SELECT pr.number, r.full_name FROM pull_requests pr JOIN repos r ON r.id = pr.repo_id WHERE pr.ticket_id = ? ORDER BY pr.id", [ticketId]);
}

function runText(r: CiRun): string {
  return `- 実行 ${r.id}「${r.workflow}」: ${r.status}${r.conclusion ? ` / ${r.conclusion}` : ""}(コミット ${r.headSha.slice(0, 7)}、${r.url})\n${r.jobs
    .map(
      (j) =>
        `  - ジョブ「${j.name}」: ${j.conclusion ?? j.status}${j.started ? "" : "(ステップが 1 つも動いていない = 始まっていない)"}${j.failedStep ? ` / 落ちたステップ: ${j.failedStep}` : ""}${j.notes.length ? `\n    GitHub の注記: ${j.notes.join(" / ")}` : ""}`,
    )
    .join("\n")}`;
}

export function ciTools(p: Project, gh: GitHub | undefined, ctx: { ticket?: TicketRow; rerun?: boolean }): KuramotoTool[] {
  // チームの CI を使うなら、GitHub Actions は止めてあり、merge にも使わない。調べる道具も渡さない(ADR-0028)
  if (!gh?.ciDetail || teamCiEnabled(p)) return [];
  const target = (number?: number): TicketRow | string => {
    if (number === undefined) return ctx.ticket ?? "チケット番号を指定してください";
    return get<TicketRow>(p.db, "SELECT * FROM tickets WHERE number = ?", [number]) ?? `#${number} はありません`;
  };
  const repoOf = (t?: TicketRow) => (t ? prsOf(p, t.id)[0]?.full_name : undefined) ?? p.repos()[0]?.full_name ?? "";
  const tools: KuramotoTool[] = [
    defineTool({
      name: "ci_status",
      description:
        "チケットの PR の CI の今を、Kuramoto が GitHub から取ってくる(あなたの作業場所からは GitHub は見えない)。落ちた確認・落ちたステップ・GitHub の注記・失敗したログの末尾と、main の最近の CI の実行が分かる。",
      input: { number: z.number().int().optional().describe("チケット番号(省くとこのチケット)") },
      handler: async (a) => {
        const t = target(a.number);
        if (typeof t === "string") return t;
        const prs = prsOf(p, t.id);
        if (!prs.length) return `#${t.number} にはまだ PR がありません`;
        const out: string[] = [];
        for (const pr of prs) {
          try {
            const s = await gh.prStatus(pr.full_name, pr.number);
            out.push(`## PR #${pr.number}(${pr.full_name}): CI ${s.ci} / ${s.mergeable} / ${s.state}`);
            if (s.ci === "failure") {
              const d = await gh.ciDetail!(pr.full_name, pr.number);
              out.push(ciFindings(d).map((f) => `- ${f.body}`).join("\n"));
              if (d.baseFailing.length) out.push(`${d.base} でも落ちている確認: ${d.baseFailing.join("・")}`);
              const base = await gh.recentRuns?.(pr.full_name, d.base).catch(() => undefined);
              if (base?.length) out.push(`## ${d.base} の最近の実行\n${base.map((r) => `- 実行 ${r.id}「${r.workflow}」: ${r.status}${r.conclusion ? ` / ${r.conclusion}` : ""}(${r.headSha.slice(0, 7)}、${r.createdAt})`).join("\n")}`);
            }
          } catch (e) {
            out.push(`PR #${pr.number}: 取れませんでした: ${errText(e)}`);
          }
        }
        return clip(out.join("\n\n"));
      },
    }),
    defineTool({
      name: "ci_run",
      description: "CI の 1 回の実行(run)を、ジョブ・ステップ・GitHub の注記・失敗したログの末尾まで見る。ci_status や main の実行に出てくる実行の番号を渡す。",
      input: { run_id: z.number().int().describe("実行の番号(URL の /actions/runs/<番号>)"), number: z.number().int().optional().describe("どのチケットのリポジトリか(省くとこのチケット)") },
      handler: async (a) => {
        const t = target(a.number);
        const repo = repoOf(typeof t === "string" ? undefined : t);
        try {
          const r = gh.ciRun ? runText(await gh.ciRun(repo, a.run_id)) : "";
          const log = gh.runLog ? await gh.runLog(repo, a.run_id).catch((e: unknown) => `(ログを取れませんでした: ${errText(e)})`) : "";
          return clip(`${r}\n\n## 失敗したステップのログ(末尾)\n${log || "(ありません。ジョブが始まっていなければ、ログはできません。注記を見てください)"}`);
        } catch (e) {
          return `取れませんでした: ${errText(e)}`;
        }
      },
    }),
    defineTool({
      name: "ci_settings",
      description: "リポジトリに登録されている Actions の秘密情報と変数の名前を見る(値は見えない)。必要な秘密情報が登録されているかを確かめるのに使う。",
      input: { number: z.number().int().optional().describe("どのチケットのリポジトリか(省くとこのチケット)") },
      handler: async (a) => {
        const t = target(a.number);
        const repo = repoOf(typeof t === "string" ? undefined : t);
        if (!gh.ciSettings) return "この環境では取れません";
        const s = await gh.ciSettings(repo);
        if (s.error) return `取れませんでした(権限が足りない可能性があります): ${s.error}`;
        return `秘密情報: ${s.secrets.join(", ") || "(なし)"}\n変数: ${s.variables.join(", ") || "(なし)"}`;
      },
    }),
  ];
  if (ctx.rerun && gh.rerunFailed)
    tools.push(
      defineTool({
        name: "ci_rerun",
        description: "CI の実行の、落ちたジョブだけをやり直す(一時的な失敗か、直ったかを確かめる)。同じチケットで 1 時間に 3 回まで。終わるまで数分かかるので、結果は次の見回りか、merge の見回りで分かる。",
        input: { run_id: z.number().int(), number: z.number().int().optional() },
        handler: async (a) => {
          const t = target(a.number);
          const key = `ci_rerun_by_lead:${typeof t === "string" ? 0 : t.id}`;
          const recent = (JSON.parse(p.setting(key) || "[]") as string[]).filter((x) => p.clock.now().getTime() - new Date(x).getTime() < 3_600_000);
          if (recent.length >= 3) return "この 1 時間で 3 回やり直しました。原因を見立ててから手を打ってください";
          const repo = repoOf(typeof t === "string" ? undefined : t);
          try {
            await gh.rerunFailed!(repo, a.run_id);
          } catch (e) {
            return `やり直せませんでした: ${errText(e)}`;
          }
          p.setSetting(key, JSON.stringify([...recent, p.now()]));
          p.event(p.fixedMember("lead").name, "ci_rerun", typeof t === "string" ? null : t.id, { runId: a.run_id, checks: [] });
          return `実行 ${a.run_id} の落ちたジョブをやり直しました。`;
        },
      }),
    );
  return tools;
}
