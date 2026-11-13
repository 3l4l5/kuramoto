import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

export type PrStatus = {
  state: "OPEN" | "CLOSED" | "MERGED";
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  ci: "success" | "failure" | "pending" | "none";
};

/**
 * 落ちている CI の確認 1 つ。
 * - started: ジョブのステップが 1 つでも動いたか(false なら、始まってもいない。請求・上限・ランナーなど、コードの外の原因)。分からなければ null
 * - notes: GitHub がジョブに付けた注記(「The job was not started because ...」など)
 * - failedStep: 落ちたステップの名前
 */
export type FailedCheck = { name: string; link: string | null; runId: number | null; log: string; started?: boolean | null; notes?: string[]; failedStep?: string | null };

/** CI の 1 回の実行(run)の中身。 */
export type CiJob = { id: number; name: string; status: string; conclusion: string | null; started: boolean; failedStep: string | null; notes: string[] };
export type CiRun = { id: number; url: string; workflow: string; status: string; conclusion: string | null; headSha: string; jobs: CiJob[] };

/**
 * CI が落ちたときの詳細。エージェントの作業場所からは GitHub が見えないので、Kuramoto が外で取ってきて渡す(ADR-0027)。
 * - failing: この PR で落ちている確認と、その失敗したステップのログの末尾
 * - baseFailing: 向き先(main)の最新のコミットで落ちている確認の名前(main も赤ければ、この PR のせいではない)
 */
export type CiDetail = { headSha: string; base: string; failing: FailedCheck[]; baseFailing: string[] };

/** PR の確認 1 つ(CI の各チェック)。 */
export type PrCheck = { name: string; status: string; conclusion: string | null; link: string | null };

/**
 * PR の読み取り用の詳細(merge できるか・できない理由・CI の各チェック・レビュー)。リーダーが読むだけ(#56)。
 * - mergeStateStatus: GitHub が merge できるかを判定した結果(CLEAN・BLOCKED・BEHIND・DIRTY・UNSTABLE・DRAFT・UNKNOWN など)
 * - ahead / behind: 向き先との差(コミット数)。分からなければ null
 */
export type PrDetail = {
  title: string;
  url: string;
  state: PrStatus["state"];
  draft: boolean;
  mergeable: PrStatus["mergeable"];
  mergeStateStatus: string;
  reviewDecision: string | null;
  base: string;
  head: string;
  headSha: string;
  checks: PrCheck[];
  ahead: number | null;
  behind: number | null;
  reviews: { author: string; state: string; body: string; at: string }[];
  comments: { author: string; body: string; at: string; path?: string }[];
};

/** Kuramoto が GitHub に対して行うこと。差分は持たず、状態の写しだけを取る(ADR-0003)。CI が落ちたときだけ、ログを取ってくる。 */
export interface GitHub {
  prStatus(repo: string, number: number): Promise<PrStatus>;
  merge(repo: string, number: number): Promise<void>;
  comment(repo: string, number: number, body: string): Promise<string>;
  /** CI が落ちたときの詳細(ログつき)。 */
  ciDetail?(repo: string, number: number): Promise<CiDetail>;
  /** 落ちたジョブだけをやり直す(一時的な失敗を見分ける)。 */
  rerunFailed?(repo: string, runId: number): Promise<void>;
  /** CI の 1 回の実行の、ジョブ・ステップ・注記。 */
  ciRun?(repo: string, runId: number): Promise<CiRun>;
  /** CI の 1 回の実行の、失敗したステップのログの末尾。 */
  runLog?(repo: string, runId: number): Promise<string>;
  /** 登録されている秘密情報と変数の名前(値は取らない)。 */
  ciSettings?(repo: string): Promise<{ secrets: string[]; variables: string[]; error?: string }>;
  /** 開いている PR(既存のリポジトリの続きから始めるとき。ADR-0030)。 */
  openPulls?(repo: string): Promise<{ number: number; title: string; body: string; head: string; url: string; draft: boolean; author: string }[]>;
  /** 開いている Issue。label を渡すとそのラベルの付いたものだけ。 */
  openIssues?(repo: string, label: string | null): Promise<{ number: number; title: string; body: string; url: string; labels: string[] }[]>;
  /** Issue にコメントを書く(外に出る操作。設定 issue_comment を入れたときだけ使う)。 */
  commentIssue?(repo: string, number: number, body: string): Promise<void>;
  /** リポジトリの GitHub Actions を動かすか止めるか(チームの CI を使うときは止める。ADR-0028)。 */
  setActionsEnabled?(repo: string, enabled: boolean): Promise<void>;
  /** PR の詳細(読むだけ。リーダーの読み取り用の道具が使う)。 */
  prDetail?(repo: string, number: number): Promise<PrDetail>;
  /** 向き先のブランチの最近の CI の実行。 */
  recentRuns?(repo: string, branch: string): Promise<{ id: number; workflow: string; status: string; conclusion: string | null; headSha: string; createdAt: string }[]>;
}

const FAILED = ["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE"];
/** ログの末尾をどれだけ渡すか(行・文字)。 */
const LOG_LINES = 120;
const LOG_CHARS = 5000;

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

  async ciDetail(repo: string, number: number): Promise<CiDetail> {
    const { stdout } = await exec("gh", ["pr", "view", String(number), "--repo", repo, "--json", "headRefOid,baseRefName,statusCheckRollup"]);
    const j = JSON.parse(stdout) as {
      headRefOid: string;
      baseRefName: string;
      statusCheckRollup: { name?: string; context?: string; conclusion?: string | null; state?: string | null; detailsUrl?: string; targetUrl?: string }[];
    };
    const failing: FailedCheck[] = j.statusCheckRollup
      .filter((c) => FAILED.includes((c.conclusion ?? c.state ?? "").toUpperCase()))
      .map((c) => {
        const link = c.detailsUrl ?? c.targetUrl ?? null;
        const run = link?.match(/\/actions\/runs\/(\d+)/);
        return { name: c.name ?? c.context ?? "(名前なし)", link, runId: run ? Number(run[1]) : null, log: "" };
      });
    // 同じ実行(run)のログは 1 回だけ取る。多すぎると渡しきれないので 3 つまで
    const logs = new Map<number, string>();
    for (const id of [...new Set(failing.flatMap((f) => (f.runId ? [f.runId] : [])))].slice(0, 3)) {
      const log = await exec("gh", ["run", "view", String(id), "--repo", repo, "--log-failed"], { maxBuffer: 32 * 1024 * 1024 }).then(
        (r) => tail(r.stdout),
        (e: { stderr?: string; message?: string }) => `(ログを取れませんでした: ${(e.stderr || e.message || "").trim().slice(0, 300)})`,
      );
      logs.set(id, log);
    }
    // ジョブが始まったか・GitHub の注記(ログが無いとき、理由はここに書かれている)
    const runs = new Map<number, CiRun>();
    for (const id of logs.keys()) {
      const r = await this.ciRun(repo, id).catch(() => undefined);
      if (r) runs.set(id, r);
    }
    for (const f of failing) {
      f.log = f.runId ? (logs.get(f.runId) ?? "") : "";
      const job = f.runId ? runs.get(f.runId)?.jobs.find((x) => x.name === f.name || f.name.endsWith(x.name)) : undefined;
      if (job) Object.assign(f, { started: job.started, notes: job.notes, failedStep: job.failedStep });
    }
    const baseFailing = await exec("gh", ["api", `repos/${repo}/commits/${j.baseRefName}/check-runs`, "--jq", ".check_runs[] | select(.conclusion != null) | [.name, .conclusion] | @tsv"]).then(
      (r) =>
        r.stdout
          .split("\n")
          .map((l) => l.split("\t"))
          .filter(([, c]) => c && FAILED.includes(c.toUpperCase()))
          .map(([n]) => n!),
      () => [] as string[],
    );
    return { headSha: j.headRefOid, base: j.baseRefName, failing, baseFailing };
  }

  async prDetail(repo: string, number: number): Promise<PrDetail> {
    const { stdout } = await exec(
      "gh",
      ["pr", "view", String(number), "--repo", repo, "--json", "title,url,state,isDraft,mergeable,mergeStateStatus,reviewDecision,baseRefName,headRefName,headRefOid,statusCheckRollup,reviews,comments"],
      { maxBuffer: 16 * 1024 * 1024 },
    );
    const j = JSON.parse(stdout) as {
      title: string;
      url: string;
      state: PrStatus["state"];
      isDraft: boolean;
      mergeable: PrStatus["mergeable"];
      mergeStateStatus: string;
      reviewDecision: string | null;
      baseRefName: string;
      headRefName: string;
      headRefOid: string;
      statusCheckRollup: { name?: string; context?: string; status?: string | null; state?: string | null; conclusion?: string | null; detailsUrl?: string; targetUrl?: string }[];
      reviews: { author?: { login: string } | null; state: string; body: string; submittedAt?: string }[];
      comments: { author?: { login: string } | null; body: string; createdAt: string }[];
    };
    // 向き先との差(衝突・遅れの手がかり)と、コードへの行のコメント。取れなくても詳細は返す
    const diff = await exec("gh", ["api", `repos/${repo}/compare/${j.baseRefName}...${j.headRefOid}`, "--jq", "[.ahead_by, .behind_by] | @tsv"]).then(
      (r) => r.stdout.trim().split("\t").map(Number),
      () => undefined,
    );
    const inline = await exec("gh", ["api", `repos/${repo}/pulls/${number}/comments`, "--jq", '.[] | [.user.login, .path, .created_at, (.body | gsub("[\\t\\n]"; " "))] | @tsv']).then(
      (r) =>
        r.stdout
          .split("\n")
          .filter(Boolean)
          .map((l) => l.split("\t"))
          .map(([author, path, at, body]) => ({ author: author ?? "", body: body ?? "", at: at ?? "", path })),
      () => [] as { author: string; body: string; at: string; path?: string }[],
    );
    const num = (n: number | undefined) => (n === undefined || Number.isNaN(n) ? null : n);
    return {
      title: j.title,
      url: j.url,
      state: j.state,
      draft: j.isDraft,
      mergeable: j.mergeable,
      mergeStateStatus: j.mergeStateStatus,
      reviewDecision: j.reviewDecision || null,
      base: j.baseRefName,
      head: j.headRefName,
      headSha: j.headRefOid,
      checks: j.statusCheckRollup.map((c) => ({ name: c.name ?? c.context ?? "(名前なし)", status: c.status ?? c.state ?? "", conclusion: c.conclusion ?? null, link: c.detailsUrl ?? c.targetUrl ?? null })),
      ahead: num(diff?.[0]),
      behind: num(diff?.[1]),
      reviews: j.reviews.map((r) => ({ author: r.author?.login ?? "", state: r.state, body: r.body ?? "", at: r.submittedAt ?? "" })),
      comments: [...j.comments.map((c) => ({ author: c.author?.login ?? "", body: c.body, at: c.createdAt })), ...inline],
    };
  }

  async openPulls(repo: string) {
    const { stdout } = await exec("gh", ["pr", "list", "--repo", repo, "--state", "open", "--limit", "100", "--json", "number,title,body,headRefName,url,isDraft,author"]);
    return (JSON.parse(stdout) as { number: number; title: string; body: string; headRefName: string; url: string; isDraft: boolean; author: { login: string } | null }[]).map((x) => ({
      number: x.number,
      title: x.title,
      body: x.body ?? "",
      head: x.headRefName,
      url: x.url,
      draft: x.isDraft,
      author: x.author?.login ?? "",
    }));
  }

  async openIssues(repo: string, label: string | null) {
    const { stdout } = await exec("gh", ["issue", "list", "--repo", repo, "--state", "open", "--limit", "200", "--json", "number,title,body,url,labels", ...(label ? ["--label", label] : [])]);
    return (JSON.parse(stdout) as { number: number; title: string; body: string; url: string; labels: { name: string }[] }[]).map((x) => ({
      number: x.number,
      title: x.title,
      body: x.body ?? "",
      url: x.url,
      labels: x.labels.map((l) => l.name),
    }));
  }

  async commentIssue(repo: string, number: number, body: string): Promise<void> {
    await exec("gh", ["issue", "comment", String(number), "--repo", repo, "--body", body]);
  }

  async setActionsEnabled(repo: string, enabled: boolean): Promise<void> {
    await exec("gh", ["api", "-X", "PUT", `repos/${repo}/actions/permissions`, "-F", `enabled=${enabled}`]);
  }

  async rerunFailed(repo: string, runId: number): Promise<void> {
    await exec("gh", ["run", "rerun", String(runId), "--repo", repo, "--failed"]);
  }

  async ciRun(repo: string, runId: number): Promise<CiRun> {
    const { stdout } = await exec("gh", ["run", "view", String(runId), "--repo", repo, "--json", "databaseId,url,workflowName,status,conclusion,headSha,jobs"]);
    const j = JSON.parse(stdout) as {
      databaseId: number;
      url: string;
      workflowName: string;
      status: string;
      conclusion: string | null;
      headSha: string;
      jobs: { databaseId: number; name: string; status: string; conclusion: string | null; steps?: { name: string; conclusion: string | null; status: string }[] }[];
    };
    const jobs: CiJob[] = [];
    for (const x of j.jobs) {
      const steps = x.steps ?? [];
      const ran = steps.filter((s) => s.conclusion && !["skipped", "SKIPPED"].includes(s.conclusion));
      const failed = FAILED.includes((x.conclusion ?? "").toUpperCase());
      // 注記は落ちたジョブだけ取る(始まらなかった理由・エラーの行が書かれている)
      const notes = failed
        ? await exec("gh", ["api", `repos/${repo}/check-runs/${x.databaseId}/annotations`, "--jq", ".[] | [.annotation_level, .message] | @tsv"]).then(
            (r) => r.stdout.split("\n").filter(Boolean).map((l) => l.replace("\t", ": ").slice(0, 500)).slice(0, 10),
            () => [] as string[],
          )
        : [];
      jobs.push({
        id: x.databaseId,
        name: x.name,
        status: x.status,
        conclusion: x.conclusion,
        started: ran.length > 0,
        failedStep: steps.find((s) => FAILED.includes((s.conclusion ?? "").toUpperCase()))?.name ?? null,
        notes,
      });
    }
    return { id: j.databaseId, url: j.url, workflow: j.workflowName, status: j.status, conclusion: j.conclusion, headSha: j.headSha, jobs };
  }

  async runLog(repo: string, runId: number): Promise<string> {
    const r = await exec("gh", ["run", "view", String(runId), "--repo", repo, "--log-failed"], { maxBuffer: 32 * 1024 * 1024 });
    return tail(r.stdout);
  }

  async ciSettings(repo: string): Promise<{ secrets: string[]; variables: string[]; error?: string }> {
    const names = (kind: "secret" | "variable") =>
      exec("gh", [kind, "list", "--repo", repo, "--json", "name"]).then((r) => (JSON.parse(r.stdout) as { name: string }[]).map((x) => x.name));
    try {
      const [secrets, variables] = await Promise.all([names("secret"), names("variable")]);
      return { secrets, variables };
    } catch (e) {
      const err = e as { stderr?: string; message?: string };
      return { secrets: [], variables: [], error: (err.stderr || err.message || String(e)).trim().slice(0, 300) };
    }
  }

  async recentRuns(repo: string, branch: string) {
    const { stdout } = await exec("gh", ["run", "list", "--repo", repo, "--branch", branch, "--limit", "8", "--json", "databaseId,workflowName,status,conclusion,headSha,createdAt"]);
    return (JSON.parse(stdout) as { databaseId: number; workflowName: string; status: string; conclusion: string | null; headSha: string; createdAt: string }[]).map((r) => ({
      id: r.databaseId,
      workflow: r.workflowName,
      status: r.status,
      conclusion: r.conclusion,
      headSha: r.headSha,
      createdAt: r.createdAt,
    }));
  }
}

/** ログの末尾。タイムスタンプなどで長い行は詰める。 */
function tail(log: string): string {
  const lines = log.trimEnd().split("\n").slice(-LOG_LINES).map((l) => (l.length > 400 ? `${l.slice(0, 400)}…` : l));
  const s = lines.join("\n");
  return s.length > LOG_CHARS ? `…${s.slice(-LOG_CHARS)}` : s;
}

function rollup(checks: { conclusion?: string | null; state?: string | null; status?: string | null }[]): PrStatus["ci"] {
  if (checks.length === 0) return "none";
  const states = checks.map((c) => (c.conclusion ?? c.state ?? c.status ?? "").toUpperCase());
  if (states.some((s) => ["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED"].includes(s))) return "failure";
  if (states.every((s) => ["SUCCESS", "NEUTRAL", "SKIPPED"].includes(s))) return "success";
  return "pending";
}
