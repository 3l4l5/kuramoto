import type { Harness, HarnessRequest, HarnessResult } from "./types.js";

export type FakeStep = (req: HarnessRequest, call: (name: string, args: Record<string, unknown>) => Promise<string>) =>
  | Promise<Partial<HarnessResult> | void>
  | Partial<HarnessResult>
  | void;

/**
 * テスト用のハーネス。台本(step)の中で Kuramoto の道具を呼び、エージェントの動きを真似る。
 */
export class FakeHarness implements Harness {
  readonly name = "fake";
  readonly calls: HarnessRequest[] = [];
  private seq = 0;

  constructor(private readonly script: FakeStep) {}

  async run(req: HarnessRequest): Promise<HarnessResult> {
    this.calls.push(req);
    const call = async (name: string, args: Record<string, unknown>) => {
      const t = req.tools.find((x) => x.name === name);
      if (!t) throw new Error(`道具 ${name} は渡されていません`);
      return t.handler(args as never);
    };
    const out = (await this.script(req, call)) ?? {};
    return {
      sessionId: req.resumeSessionId ?? `fake-session-${++this.seq}`,
      usage: { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 0, costUsd: 0.01 },
      status: "ok",
      finalText: "",
      ...out,
    };
  }
}

/** テスト用: 直しの指示にある必須の指摘の番号(提案は除く)。 */
export function mustFindingIds(prompt: string): number[] {
  return [...(prompt.split("## 提案")[0] ?? "").matchAll(/- 指摘 (\d+) \[/g)].map((m) => Number(m[1]));
}

/** テスト用: 直しの返事(すべて直した)。 */
export function fixedAll(prompt: string): { finding_id: number; action: "fixed"; comment: string }[] {
  return mustFindingIds(prompt).map((id) => ({ finding_id: id, action: "fixed", comment: "直した" }));
}

/** テスト用: 再レビューの答え(すべて解決)。 */
export function resolvedAll(prompt: string): { finding_id: number; result: "resolved" }[] {
  return [...prompt.matchAll(/- 指摘 (\d+) \[/g)].map((m) => ({ finding_id: Number(m[1]), result: "resolved" }));
}

/** テスト用: submit_review の入力に、前回の指摘への答え(すべて解決)を足す。 */
export function withResolutions<T extends object>(prompt: string, input: T): T & { resolutions: { finding_id: number; result: "resolved" }[] } {
  return { ...input, resolutions: resolvedAll(prompt) };
}
