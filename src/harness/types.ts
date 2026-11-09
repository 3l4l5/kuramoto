import type { z } from "zod";
import type { Effort } from "../domain/roles.js";

/**
 * Kuramoto がエージェントに渡す道具(ADR-0001)。ハーネスに依存しない形で定義し、
 * 各ハーネスの差し替え口で MCP の道具に包む。
 */
export type KuramotoTool<S extends z.ZodRawShape = z.ZodRawShape> = {
  name: string;
  description: string;
  input: S;
  handler: (args: z.infer<z.ZodObject<S>>) => Promise<string> | string;
};

export function defineTool<S extends z.ZodRawShape>(t: KuramotoTool<S>): KuramotoTool {
  return t as unknown as KuramotoTool;
}

/**
 * 起動の途中経過。
 * - step: 区切りのある動き(考えたことの要約・ファイルを読んだ・道具を使ったなど)。記録に残す
 * - heartbeat: 生きている合図(考え中のトークン数・道具の実行時間など)。今の様子だけを上書きする
 */
export type ProgressEvent =
  | { type: "step"; kind: "thinking" | "text" | "tool" | "status"; text: string }
  | { type: "heartbeat"; text: string };

/**
 * 作業場所への閉じ込め(ADR-0020)。ファイルの道具は cwd の外を読み書きできず、シェルのコマンドは
 * サンドボックスの中で動く。cwd は常に読み書きできる。
 */
export type Confinement = {
  /**
   * cwd のほかに、シェルから読んでよい場所(git の本体・ツールチェーン・git の設定など)。
   * ファイルの道具を作業場所に閉じ込めると、シェルの読み込みも作業場所に絞られるので、要る場所を名指しで開ける。
   * hidden の中は開けられない(サンドボックスが外す)ので、hidden の外の場所だけを入れる。
   */
  readable: string[];
  /** cwd のほかに、シェルから書いてよい場所。 */
  writable: string[];
  /** シェルから読ませない場所(Kuramoto のデータ・認証情報など)。 */
  hidden: string[];
  /** シェルから通信してよいドメイン。ここに無いものは断る。 */
  allowedDomains: string[];
  /** シェルに渡さない環境変数(トークンなど)。 */
  hiddenEnv: string[];
  /**
   * テスト用のブラウザ・開発サーバーのために、Unix ソケットと localhost での待ち受けを許すか。
   * Chrome は起動のたびにプロファイルにソケットを作り、e2e テストは localhost でサーバーを立てる。
   */
  allowLocalSockets: boolean;
  /** 起動に足す環境変数(ツールチェーンの設定など)。 */
  env: Record<string, string>;
};

export type HarnessRequest = {
  /** 作業場所(worktree)。ここの外は触らせない(confine)。 */
  cwd: string;
  /** 閉じ込め方。省略時は閉じ込めない(テストや動作確認用)。 */
  confine?: Confinement;
  systemPrompt: string;
  prompt: string;
  model: string;
  effort: Effort;
  /** 続きから再開するセッション。無ければ新しく始める。 */
  resumeSessionId?: string;
  tools: KuramotoTool[];
  /** ハーネス組み込みの道具のうち使ってよいもの。省略時はハーネスの既定。 */
  allowedTools?: string[];
  /** 起動 1 回の予算(USD)。 */
  maxBudgetUsd?: number;
  maxTurns?: number;
  signal?: AbortSignal;
  /** 途中経過を受け取る。省略可。 */
  onProgress?: (e: ProgressEvent) => void;
};

export type HarnessUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  costUsd: number;
};

export type HarnessResult = {
  /** 次に再開するときに渡すセッションの ID。 */
  sessionId: string;
  usage: HarnessUsage;
  /** ok 以外は止まった理由。 */
  status: "ok" | "budget" | "max_turns" | "error";
  error?: string;
  finalText: string;
};

/**
 * ハーネスの差し替え口(ADR-0012)。Kuramoto がハーネスに求める 5 つ:
 * 1. 作業場所を指定して無人で動かせる 2. セッションを再開できる 3. 道具を MCP で渡せる
 * 4. トークンとコストを返せる 5. 予算や回数の上限で止められる
 */
export interface Harness {
  readonly name: string;
  run(req: HarnessRequest): Promise<HarnessResult>;
}

export const EMPTY_USAGE: HarnessUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0 };
