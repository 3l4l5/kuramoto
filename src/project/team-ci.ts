import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Confinement } from "../harness/types.js";
import { confinementFor } from "./confine.js";
import type { Project, TicketRow } from "./project.js";
import type { Workspace } from "./workspace.js";
import { baseBranchOf } from "./base-branch.js";

/**
 * チームの CI(ADR-0028)。GitHub Actions を待たずに、Kuramoto が PR の中身を最新の main と合わせた状態で、
 * 確認のコマンド(lint・型・テストなど)をエージェントと同じ閉じ込めの中で流す。
 * - 担当が submit_pr したとき(レビューの前)に流す。落ちたら出力を付けて、その場で担当に戻す
 * - merge の直前に、main が進んでいたらもう一度流す(merge キューの代わり)
 * 設定 ci_mode が "team" のときだけ使う。そのときは GitHub Actions を止め、merge は GitHub の CI を見ない。
 */

export type CheckResult = { command: string; ok: boolean; code: number | null; ms: number; output: string };
export type TeamCiResult = {
  ok: boolean;
  /** 確かめた PR のコミット */
  sha: string;
  base: string;
  /** 合わせた main のコミット */
  baseSha: string;
  results: CheckResult[];
  /** main と合わせられなかった(衝突) */
  conflict?: string;
  /** 流すコマンドが決まらなかった */
  noCommands?: boolean;
};

/** コマンドを閉じ込めの中で流す。テストでは差し替える。 */
export interface CommandRunner {
  run(command: string, cwd: string, conf: Confinement, timeoutMs: number): Promise<{ code: number | null; output: string }>;
}

export function teamCiEnabled(p: Project): boolean {
  return p.setting("ci_mode") === "team";
}

/** プロジェクトの設定で決めたコマンド(リポジトリごと。1 行に 1 つ)。空なら null。 */
export function configuredCommands(p: Project, repo: string): string[] | null {
  const v = (p.setting(`team_ci_commands:${repo}`) ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
  return v.length ? v : null;
}

/** package.json と lock ファイルから、流すコマンドを決める(入れる → lint → 型 → テスト)。 */
export function detectCommands(cwd: string): string[] {
  const pkgPath = join(cwd, "package.json");
  if (!existsSync(pkgPath)) return [];
  const scripts = (JSON.parse(readFileSync(pkgPath, "utf8")) as { scripts?: Record<string, string> }).scripts ?? {};
  const pm = existsSync(join(cwd, "pnpm-lock.yaml")) ? "pnpm" : existsSync(join(cwd, "yarn.lock")) ? "yarn" : "npm";
  const install = pm === "pnpm" ? "pnpm install --frozen-lockfile" : pm === "yarn" ? "yarn install --frozen-lockfile" : existsSync(join(cwd, "package-lock.json")) ? "npm ci" : "npm install";
  const run = (s: string) => (pm === "npm" ? `npm run ${s}` : `${pm} run ${s}`);
  const pick = (...names: string[]) => names.find((n) => scripts[n]);
  const steps = [pick("lint"), pick("typecheck", "type-check", "tsc", "check-types"), pick("test")].filter((x): x is string => !!x);
  // npm test は既定で「テストが無い」と失敗するので、本当に書かれているときだけ
  return [install, ...steps.map((s) => (s === "test" && pm === "npm" ? "npm test" : run(s)))];
}

const OUT_LINES = 150;
const OUT_CHARS = 6000;

function tail(s: string): string {
  const lines = s.trimEnd().split("\n").slice(-OUT_LINES);
  const t = lines.join("\n");
  return t.length > OUT_CHARS ? `…${t.slice(-OUT_CHARS)}` : t;
}

/**
 * チケットのブランチを、最新の main と合わせた状態で確かめる。
 * 結果はチケットごとに残す(team_ci:<id>)。通ったら、どのコミットと main の組で通ったかも残す(team_ci_pass:<id>)。
 */
export async function runTeamCi(p: Project, ws: Workspace, runner: CommandRunner, ticket: TicketRow, repo: string, branch: string): Promise<TeamCiResult> {
  if (!ws.prepareCheck) throw new Error("この作業場所では、チームの CI を流せません");
  const prep = await ws.prepareCheck({ repo, ticketNumber: ticket.number, branch, base: baseBranchOf(p, repo) });
  const base = { sha: prep.sha, base: prep.base, baseSha: prep.baseSha };
  let result: TeamCiResult;
  if (prep.conflict) {
    result = { ok: false, ...base, results: [], conflict: prep.conflict };
  } else {
    const commands = configuredCommands(p, repo) ?? detectCommands(prep.path);
    if (!commands.length) {
      result = { ok: false, ...base, results: [], noCommands: true };
    } else {
      const conf = confinementFor(p, { path: prep.path, base: prep.base, gitDir: prep.gitDir }, "qa");
      const timeoutMs = p.settingNumber("team_ci_timeout_min", 20) * 60_000;
      const results: CheckResult[] = [];
      for (const command of commands) {
        const started = Date.now();
        const r = await runner.run(command, prep.path, conf, timeoutMs).catch((e: unknown) => ({ code: null, output: e instanceof Error ? e.message : String(e) }));
        results.push({ command, ok: r.code === 0, code: r.code, ms: Date.now() - started, output: tail(r.output) });
        if (r.code !== 0) break; // 落ちたら先は流さない(早く返す)
      }
      result = { ok: results.every((r) => r.ok), ...base, results };
    }
  }
  p.setSetting(`team_ci:${ticket.id}`, JSON.stringify(result));
  if (result.ok) p.setSetting(`team_ci_pass:${ticket.id}`, JSON.stringify({ sha: result.sha, baseSha: result.baseSha }));
  p.event("team_ci", result.ok ? "team_ci_passed" : "team_ci_failed", ticket.id, {
    sha: result.sha,
    baseSha: result.baseSha,
    ...(result.conflict ? { conflict: true } : {}),
    ...(result.noCommands ? { noCommands: true } : {}),
    results: result.results.map((r) => ({ command: r.command, ok: r.ok, ms: r.ms })),
  });
  return result;
}

/** そのコミットと main の組で、もう通っているか(merge の直前に流し直すかを決める)。 */
export function passedAt(p: Project, ticketId: number): { sha: string; baseSha: string } | null {
  const v = p.setting(`team_ci_pass:${ticketId}`);
  return v ? (JSON.parse(v) as { sha: string; baseSha: string }) : null;
}

/** 落ちた確認を、持ち主への指示にする。 */
export function teamCiFindings(r: TeamCiResult): { severity: string; body: string }[] {
  if (r.noCommands)
    return [{ severity: "high", body: "チームの CI で流すコマンドが決まりませんでした(package.json に lint・typecheck・test が無く、プロジェクトの設定にもありません)。責任者にプロジェクトの設定でコマンドを決めてもらうまで、merge できません。" }];
  const failed = r.results.filter((x) => !x.ok);
  return failed.map((x) => ({
    severity: "high",
    body: `チームの CI の「${x.command}」が落ちました(終了コード ${x.code ?? "なし(時間切れか止められた)"}、${Math.round(x.ms / 1000)} 秒。PR のコミット ${r.sha.slice(0, 7)} を main ${r.baseSha.slice(0, 7)} と合わせた状態)。\n出力(末尾):\n\`\`\`\n${x.output || "(出力なし)"}\n\`\`\``,
  }));
}

/** 最後のチームの CI の結果(リーダーに見せる)。無ければ空。 */
export function lastTeamCi(p: Project, ticketId: number, maxChars = 3000): string {
  const v = p.setting(`team_ci:${ticketId}`);
  if (!v) return "";
  const r = JSON.parse(v) as TeamCiResult;
  const head = `## 最後のチームの CI(${r.ok ? "通った" : r.conflict ? "main と衝突" : "落ちた"}。コミット ${r.sha.slice(0, 7)} を main ${r.baseSha.slice(0, 7)} と合わせて流した)\n${r.results.map((x) => `- ${x.ok ? "○" : "×"} ${x.command}(${Math.round(x.ms / 1000)} 秒)`).join("\n")}`;
  const body = r.ok ? "" : `\n${teamCiFindings(r).map((f) => f.body).join("\n")}`;
  const s = head + body;
  return s.length > maxChars ? `${s.slice(0, maxChars)}…` : s;
}

/**
 * Claude Code と同じ閉じ込め(@anthropic-ai/sandbox-runtime)の中でコマンドを流す。
 * - ホームの下は、ツールチェーンと作業場所のほかは読めない。認証情報と Kuramoto のデータは読めない
 * - 書けるのは作業場所とツールのキャッシュだけ
 * - 通信は、許したドメイン(パッケージの取得先など)だけ
 * 閉じ込めの設定はプロセスで 1 つなので、1 度に 1 つずつ流す。
 */
export class SandboxRunner implements CommandRunner {
  private queue: Promise<unknown> = Promise.resolve();
  private ready = false;

  /** 閉じ込めのための通信の中継を止める(プロセスを終えるとき)。 */
  async close(): Promise<void> {
    if (!this.ready) return;
    const { SandboxManager } = await import("@anthropic-ai/sandbox-runtime");
    await SandboxManager.reset();
    this.ready = false;
  }

  run(command: string, cwd: string, conf: Confinement, timeoutMs: number): Promise<{ code: number | null; output: string }> {
    const next = this.queue.then(() => this.runOne(command, cwd, conf, timeoutMs));
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async runOne(command: string, cwd: string, conf: Confinement, timeoutMs: number): Promise<{ code: number | null; output: string }> {
    const { SandboxManager } = await import("@anthropic-ai/sandbox-runtime");
    const config = {
      network: {
        allowedDomains: conf.allowedDomains,
        deniedDomains: [],
        strictAllowlist: true,
        ...(conf.allowLocalSockets ? { allowAllUnixSockets: true, allowLocalBinding: true } : {}),
      },
      filesystem: {
        // ホームの下は名指ししたところだけ読める(エージェントのシェルと同じ)
        denyRead: [homedir(), ...conf.hidden],
        allowRead: [...new Set([cwd, ...conf.readable, ...conf.writable])],
        allowWrite: [cwd, ...conf.writable],
        denyWrite: [],
      },
    };
    if (!this.ready) {
      await SandboxManager.initialize(config);
      this.ready = true;
    } else SandboxManager.updateConfig(config);
    const wrapped = await SandboxManager.wrapWithSandbox(command);
    const env: NodeJS.ProcessEnv = { ...process.env, ...conf.env, CI: "1" };
    for (const k of conf.hiddenEnv) delete env[k];
    return new Promise((resolve) => {
      const child = spawn("/bin/bash", ["-c", wrapped], { cwd, env });
      let out = "";
      const add = (b: Buffer) => {
        out += b.toString();
        if (out.length > 200_000) out = out.slice(-100_000);
      };
      child.stdout.on("data", add);
      child.stderr.on("data", add);
      const timer = setTimeout(() => {
        out += `\n(${Math.round(timeoutMs / 60_000)} 分を過ぎたので止めました)`;
        child.kill("SIGKILL");
      }, timeoutMs);
      child.on("close", (code) => {
        clearTimeout(timer);
        SandboxManager.cleanupAfterCommand();
        resolve({ code, output: SandboxManager.annotateStderrWithSandboxFailures(wrapped, out) });
      });
      child.on("error", (e) => {
        clearTimeout(timer);
        resolve({ code: null, output: `${out}\n${e.message}` });
      });
    });
  }
}
