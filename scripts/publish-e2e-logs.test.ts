import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const script = resolve(import.meta.dirname, "publish-e2e-logs.sh");

let dir: string;
let work: string;
let remote: string;
let logs: string;
let ghLog: string;

function git(cwd: string, ...args: string[]) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

/** 本物の bare リポジトリを remote にして、gh だけ台本に置き換えて流す。 */
function run(env: Record<string, string> = {}, ghListOutput = "") {
  writeFileSync(join(dir, "bin/gh"), `#!/bin/sh\necho "gh $*" >> "${ghLog}"\n[ "$1 $2" = "pr list" ] && printf '%s' "${ghListOutput}"\nexit 0\n`);
  chmodSync(join(dir, "bin/gh"), 0o755);
  const r = spawnSync("bash", [script, logs], {
    cwd: work,
    encoding: "utf8",
    env: { ...process.env, PATH: `${join(dir, "bin")}:${process.env.PATH}`, RUN_ID: "123456", RUN_URL: "https://github.com/o/r/actions/runs/123456", ...env },
  });
  return { code: r.status, out: r.stdout + r.stderr };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "publish-logs-"));
  remote = join(dir, "remote.git");
  work = join(dir, "work");
  logs = join(dir, "logs");
  ghLog = join(dir, "gh.log");
  mkdirSync(join(dir, "bin"));
  mkdirSync(logs);
  git(dir, "init", "-q", "--bare", "-b", "main", remote);
  git(dir, "init", "-q", "-b", "main", work);
  git(work, "config", "user.name", "t");
  git(work, "config", "user.email", "t@example.com");
  writeFileSync(join(work, "README.md"), "x\n");
  git(work, "add", ".");
  git(work, "commit", "-q", "-m", "init");
  git(work, "remote", "add", "origin", remote);
  git(work, "push", "-q", "origin", "main");
  // 実行のブランチ(main とは別)にいる想定。作業ツリーに未追跡のログのディレクトリがあっても、main から切れること
  git(work, "checkout", "-q", "-b", "feature");
  for (const n of ["env", "a-confined", "b-break", "c-no-browser-server", "d-denied-ports", "d-team-ci-test", "e-mysql-rounds"]) {
    writeFileSync(join(logs, `2026-11-20-${n}.log`), `行 1 \x1b[32m色\x1b[39m\r\n○ ${n}\n末尾の改行なし`);
  }
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("publish-e2e-logs.sh(ログを main に入れる PR を開く)", () => {
  it("ログ 7 本を、中身を変えずに docs/e2e-logs/run-<run_id>/ に置き、e2e-logs/run-<run_id> に push して、main への PR を開く", () => {
    const r = run();
    expect(r.code, r.out).toBe(0);
    const branch = "e2e-logs/run-123456";
    const files = git(remote, "ls-tree", "--name-only", `${branch}:docs/e2e-logs/run-123456`).split("\n");
    expect(files).toHaveLength(7);
    // artifact と同じ(バイト単位で同じ。色の制御文字・CRLF・末尾の改行なしも)
    for (const f of files) {
      const pushed = spawnSync("git", ["show", `${branch}:docs/e2e-logs/run-123456/${f}`], { cwd: remote }).stdout;
      expect(pushed.equals(readFileSync(join(logs, f)))).toBe(true);
    }
    // main から切っている(差分はログだけ。feature ブランチの変更は入らない)
    expect(git(remote, "diff", "--name-only", `main...${branch}`).split("\n").every((p) => p.startsWith("docs/e2e-logs/run-123456/"))).toBe(true);
    // push したのは e2e-logs/run-* だけ(main は動いていない)
    expect(git(remote, "for-each-ref", "--format=%(refname)").split("\n").sort()).toEqual(["refs/heads/e2e-logs/run-123456", "refs/heads/main"]);
    const gh = readFileSync(ghLog, "utf8");
    expect(gh).toContain("gh pr create --base main --head e2e-logs/run-123456 --title [docs] e2e-logs: confinement-check の実行 123456 のログ");
    expect(gh).toContain("https://github.com/o/r/actions/runs/123456");
    expect(gh).toContain("| `2026-11-20-env.log` | 2 |"); // 行数は改行の数(wc -l)
    expect(gh).toContain("| `2026-11-20-e-mysql-rounds.log` | 2 |");
  });

  it("この実行の PR がすでに開いていれば、もう 1 本は開かない(ブランチだけ更新する)", () => {
    const r = run({}, "42");
    expect(r.code, r.out).toBe(0);
    expect(readFileSync(ghLog, "utf8")).not.toContain("pr create");
    expect(git(remote, "rev-parse", "--verify", "e2e-logs/run-123456")).toMatch(/^[0-9a-f]{40}$/);
  });

  it("再実行(同じ run_id)でもブランチを上書きして通る", () => {
    expect(run().code).toBe(0);
    writeFileSync(join(logs, "2026-11-20-env.log"), "別の実行の中身\n");
    const r = run({}, "42");
    expect(r.code, r.out).toBe(0);
    expect(git(remote, "show", "e2e-logs/run-123456:docs/e2e-logs/run-123456/2026-11-20-env.log")).toBe("別の実行の中身");
  });

  it("run_id が数字でなければ、push の前に断る(push 先は e2e-logs/run-<数字> だけ)", () => {
    const r = run({ RUN_ID: "1/../main" });
    expect(r.code).toBe(1);
    expect(r.out).toContain("RUN_ID は数字だけ");
    expect(git(remote, "for-each-ref", "--format=%(refname)")).toBe("refs/heads/main");
    expect(existsSync(ghLog)).toBe(false);
  });

  it("ログが 1 本も無ければ、何も push せず落ちる", () => {
    rmSync(logs, { recursive: true });
    mkdirSync(logs);
    const r = run();
    expect(r.code).toBe(1);
    expect(r.out).toContain(".log が無い");
    expect(git(remote, "for-each-ref", "--format=%(refname)")).toBe("refs/heads/main");
  });

  it("DRY_RUN=1 は commit までで、push も PR もしない", () => {
    const r = run({ DRY_RUN: "1" });
    expect(r.code, r.out).toBe(0);
    expect(git(remote, "for-each-ref", "--format=%(refname)")).toBe("refs/heads/main");
    expect(existsSync(ghLog)).toBe(false);
  });
});
