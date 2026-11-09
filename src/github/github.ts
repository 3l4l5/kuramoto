import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

export type PrStatus = {
  state: "OPEN" | "CLOSED" | "MERGED";
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  ci: "success" | "failure" | "pending" | "none";
};

/** Kuramoto が GitHub に対して行うこと。差分や CI の詳細は持たず、状態の写しだけを取る(ADR-0003)。 */
export interface GitHub {
  prStatus(repo: string, number: number): Promise<PrStatus>;
  merge(repo: string, number: number): Promise<void>;
  comment(repo: string, number: number, body: string): Promise<string>;
}

/** gh CLI を使う実装。 */
export class GhCli implements GitHub {
  async prStatus(repo: string, number: number): Promise<PrStatus> {
    const { stdout } = await exec("gh", ["pr", "view", String(number), "--repo", repo, "--json", "state,mergeable,statusCheckRollup"]);
    const j = JSON.parse(stdout) as {
      state: PrStatus["state"];
      mergeable: PrStatus["mergeable"];
      statusCheckRollup: { conclusion?: string | null; state?: string | null; status?: string | null }[];
    };
    return { state: j.state, mergeable: j.mergeable, ci: rollup(j.statusCheckRollup) };
  }

  async merge(repo: string, number: number): Promise<void> {
    await exec("gh", ["pr", "merge", String(number), "--repo", repo, "--squash", "--delete-branch"]);
  }

  async comment(repo: string, number: number, body: string): Promise<string> {
    const { stdout } = await exec("gh", ["pr", "comment", String(number), "--repo", repo, "--body", body]);
    return stdout.trim();
  }
}

function rollup(checks: { conclusion?: string | null; state?: string | null; status?: string | null }[]): PrStatus["ci"] {
  if (checks.length === 0) return "none";
  const states = checks.map((c) => (c.conclusion ?? c.state ?? c.status ?? "").toUpperCase());
  if (states.some((s) => ["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED"].includes(s))) return "failure";
  if (states.every((s) => ["SUCCESS", "NEUTRAL", "SKIPPED"].includes(s))) return "success";
  return "pending";
}
