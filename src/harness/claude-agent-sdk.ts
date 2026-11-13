import { createSdkMcpServer, query, tool, type SDKMessage, type SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import { basename } from "node:path";
import type { Confinement, Harness, HarnessRequest, HarnessResult, ProgressEvent } from "./types.js";
import { EMPTY_USAGE } from "./types.js";

export const KURAMOTO_MCP = "kuramoto";

/**
 * Claude Agent SDK のハーネス(ADR-0012 の最初の 1 つ)。
 * - 責任者個人の設定・CLAUDE.md・メモリは読ませない(settingSources: [])。
 * - 人が見ていない前提なので、許可していない道具は聞かずに断る(permissionMode: dontAsk)。
 */
export class ClaudeAgentSdkHarness implements Harness {
  readonly name = "claude-agent-sdk";

  constructor(private readonly opts: { pathToClaudeCodeExecutable?: string } = {}) {}

  async run(req: HarnessRequest): Promise<HarnessResult> {
    const server = createSdkMcpServer({
      name: KURAMOTO_MCP,
      version: "0.0.0",
      tools: req.tools.map((t) =>
        tool(t.name, t.description, t.input, async (args) => ({
          content: [{ type: "text", text: await t.handler(args as never) }],
        })),
      ),
      alwaysLoad: true,
    });

    const abort = new AbortController();
    req.signal?.addEventListener("abort", () => abort.abort(req.signal?.reason), { once: true });

    const q = query({
      prompt: req.prompt,
      options: {
        cwd: req.cwd,
        model: req.model,
        effort: req.effort,
        // 考えていることの要約を受け取り、途中経過として画面に出す
        thinking: { type: "adaptive", display: "summarized" },
        systemPrompt: { type: "preset", preset: "claude_code", append: req.systemPrompt },
        settingSources: [],
        mcpServers: { [KURAMOTO_MCP]: server },
        // 渡した MCP(Kuramoto の道具)だけを使う。責任者のアカウントの claude.ai のコネクタや、
        // リポジトリの .mcp.json などは読み込まない(関係ない指示が文脈に入り、トークンも使うため)
        strictMcpConfig: true,
        allowedTools: [...(req.allowedTools ?? DEFAULT_ALLOWED_TOOLS), `mcp__${KURAMOTO_MCP}__*`],
        permissionMode: "dontAsk",
        ...(req.confine ? confineOptions(req.cwd, req.confine) : { settings: BASE_SETTINGS }),
        ...(req.resumeSessionId ? { resume: req.resumeSessionId } : {}),
        ...(req.maxBudgetUsd !== undefined ? { maxBudgetUsd: req.maxBudgetUsd } : {}),
        ...(req.maxTurns !== undefined ? { maxTurns: req.maxTurns } : {}),
        ...(this.opts.pathToClaudeCodeExecutable ? { pathToClaudeCodeExecutable: this.opts.pathToClaudeCodeExecutable } : {}),
        abortController: abort,
      },
    });

    let sessionId = req.resumeSessionId ?? "";
    let result: SDKResultMessage | undefined;
    try {
      for await (const m of q) {
        if ("session_id" in m && typeof m.session_id === "string") sessionId = m.session_id;
        if (m.type === "result") result = m;
        else if (req.onProgress) for (const e of progressOf(m)) req.onProgress(e);
      }
    } catch (e) {
      const error = errorText(e);
      // 予算の上限で止まると、結果ではなく例外で返ってくることがある。エラーではなく予算切れとして扱う
      return { sessionId, usage: EMPTY_USAGE, status: isBudgetError(error) ? "budget" : "error", error, finalText: "" };
    }
    if (!result) return { sessionId, usage: EMPTY_USAGE, status: "error", error: "結果が返りませんでした", finalText: "" };

    const usage = {
      inputTokens: result.usage.input_tokens + result.usage.cache_creation_input_tokens,
      outputTokens: result.usage.output_tokens,
      cacheReadTokens: result.usage.cache_read_input_tokens,
      costUsd: result.total_cost_usd,
    };
    if (result.subtype === "success") {
      const status = !result.is_error ? "ok" : isBudgetError(result.result) ? "budget" : "error";
      return { sessionId, usage, status, finalText: result.result, ...(result.is_error ? { error: result.result } : {}) };
    }
    const status = result.subtype === "error_max_budget_usd" ? "budget" : result.subtype === "error_max_turns" ? "max_turns" : "error";
    return { sessionId, usage, status, error: result.subtype, finalText: "" };
  }
}

/**
 * 閉じ込め(ADR-0020)を SDK の設定に直す。
 * - ファイルの道具(Read・Grep・Edit など): 作業場所の外を読み書きさせない
 * - シェル: サンドボックスの中だけで動かす(外で動かす抜け道は塞ぐ)。用意できなければ起動しない
 */
export function confineOptions(cwd: string, c: Confinement) {
  return {
    env: { ...process.env, ...c.env },
    settings: {
      ...BASE_SETTINGS,
      permissions: { blockReadsOutsideWorkingDirectories: true, blockWritesOutsideWorkingDirectories: true },
    },
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      autoAllowBashIfSandboxed: true,
      allowUnsandboxedCommands: false,
      // 作業場所の外を読ませない設定はシェルの読み込みにも効くので、読む必要のある場所を allowRead で名指しする。
      // 書ける場所も読めないと困る(書いて読めない)ので、allowRead にも入れる
      filesystem: { denyRead: c.hidden, allowRead: [...new Set([cwd, ...c.readable, ...c.writable])], allowWrite: [cwd, ...c.writable] },
      network: {
        allowedDomains: c.allowedDomains,
        strictAllowlist: true,
        ...(c.allowLocalSockets ? { allowAllUnixSockets: true, allowLocalBinding: true } : {}),
      },
      credentials: { envVars: c.hiddenEnv.map((name) => ({ name, mode: "deny" as const })) },
    },
  };
}

/** どの起動にも効かせる設定。claude.ai のコネクタを自動で読み込まない。 */
const BASE_SETTINGS = { disableClaudeAiConnectors: true };

const DEFAULT_ALLOWED_TOOLS = ["Read", "Glob", "Grep", "Edit", "Write", "Bash"];

/** Kuramoto の道具を、画面に出す言葉にする。 */
const KURAMOTO_TOOL_TEXT: Record<string, string> = {
  set_brief: "目的・使う人・やらないことを書いています",
  upsert_requirement: "要件の項目を書いています",
  remove_requirement: "要件の項目を外しています",
  add_open_item: "未決を足しています",
  answer_open_item: "未決を決めています",
  withdraw_open_item: "未決を取り下げています",
  set_flow: "ユーザーフローの図を書いています",
  upsert_screen: "画面の試作を作っています",
  get_screen: "試作とコメントを読み直しています",
  remove_screen: "画面を外しています",
  resolve_comment: "コメントを対応済みにしています",
  set_infra: "インフラの構成を書いています",
  set_architecture: "アーキテクチャスタイルを書いています",
  set_domain_model: "ドメインモデルを書いています",
  set_data_design: "データ設計を書いています",
  create_ticket: "チケットを作っています",
  finish_handoff: "引き渡しを終えています",
  submit_pr: "PR を報告しています",
  raise_question: "判断をリーダーに上げています",
  submit_review: "確認の結果を報告しています",
  decide: "判断を決めています",
  escalate_to_owner: "判断を責任者に上げています",
};

const clip = (s: string, n: number) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

export function describeTool(name: string, input: Record<string, unknown>): string {
  const str = (k: string) => (typeof input[k] === "string" ? (input[k] as string) : "");
  const k = name.replace(new RegExp(`^mcp__${KURAMOTO_MCP}__`), "");
  if (k !== name) {
    const base = KURAMOTO_TOOL_TEXT[k] ?? `${k} を使っています`;
    const detail = str("name") || str("title") || str("question");
    return detail ? `${base}: ${clip(detail, 40)}` : base;
  }
  switch (name) {
    case "Read":
      return `${basename(str("file_path"))} を読んでいます`;
    case "Glob":
      return `ファイルを探しています(${clip(str("pattern"), 40)})`;
    case "Grep":
      return `「${clip(str("pattern"), 30)}」を検索しています`;
    case "Bash":
      return `コマンドを実行しています: ${clip(str("command"), 60)}`;
    case "Edit":
    case "Write":
      return `${basename(str("file_path"))} を書いています`;
    case "WebSearch":
      return `Web を検索しています: ${clip(str("query"), 50)}`;
    case "WebFetch":
      return `ページを読んでいます: ${clip(str("url"), 70)}`;
    default:
      return `${name} を使っています`;
  }
}

/** SDK のメッセージ 1 つから、画面に出す途中経過を取り出す。 */
export function progressOf(m: SDKMessage): ProgressEvent[] {
  if (m.type === "assistant") {
    const out: ProgressEvent[] = [];
    for (const b of m.message.content as { type: string; text?: string; thinking?: string; name?: string; input?: unknown }[]) {
      if (b.type === "thinking" && b.thinking?.trim()) out.push({ type: "step", kind: "thinking", text: clip(b.thinking, 300) });
      else if (b.type === "text" && b.text?.trim()) out.push({ type: "step", kind: "text", text: clip(b.text, 300) });
      else if (b.type === "tool_use" && b.name) out.push({ type: "step", kind: "tool", text: describeTool(b.name, (b.input ?? {}) as Record<string, unknown>) });
    }
    return out;
  }
  if (m.type === "system" && m.subtype === "init") return [{ type: "step", kind: "status", text: "起動しました" }];
  if (m.type === "system" && m.subtype === "thinking_tokens") return [{ type: "heartbeat", text: `考えています(約 ${m.estimated_tokens.toLocaleString()} トークン)` }];
  if (m.type === "system" && m.subtype === "api_retry") return [{ type: "step", kind: "status", text: "API が混んでいるため再試行しています" }];
  if (m.type === "tool_progress") return [{ type: "heartbeat", text: `${m.tool_name} を実行中(${Math.round(m.elapsed_time_seconds)} 秒)` }];
  return [];
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function isBudgetError(text: string): boolean {
  return /maximum budget/i.test(text);
}
