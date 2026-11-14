import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const lib = join(root, "scripts/ci-confinement-lib.sh");

/** ログの中身を置いて、lib の関数を呼ぶ bash を流す。終了コードと出力を返す。 */
function run(log: string, body: string) {
  const dir = mkdtempSync(join(tmpdir(), "ci-lib-"));
  try {
    const f = join(dir, "x.log");
    writeFileSync(f, log);
    const r = spawnSync("bash", ["-c", `. "${lib}"; f="${f}"; ${body}; exit $fail`], { encoding: "utf8" });
    return { code: r.status, out: r.stdout + r.stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("ci-confinement-lib.sh(閉じ込めの確かめの CI が、ログを読む道具)", () => {
  it("need: 期待の行があれば通り、無ければエラー注釈を出して落とす", () => {
    expect(run("○ 入口を壊すと落ちた\n", 'need "$f" "^○ 入口を壊すと落ちた"').code).toBe(0);
    const r = run("✗ 入口を壊したのに通った\n", 'need "$f" "^○ 入口を壊すと落ちた"');
    expect(r.code).toBe(1);
    expect(r.out).toContain("::error::x.log に期待の行が無い");
  });

  it("forbid: 出てはいけない行があれば落とす(その行も出す)。無ければ通る", () => {
    expect(run("○ ok\n", 'forbid "$f" "^(✗|△)"').code).toBe(0);
    const r = run("○ ok\n✗ 閉じ込めに穴がある\n", 'forbid "$f" "^(✗|△)"');
    expect(r.code).toBe(1);
    expect(r.out).toContain("✗ 閉じ込めに穴がある");
  });

  it("need_code: 終了コードが期待(既定 0)と違えば落とす", () => {
    expect(run("", 'need_code "手順" 0').code).toBe(0);
    expect(run("", 'need_code "手順" 2 2').code).toBe(0);
    const r = run("", 'need_code "手順" 2');
    expect(r.code).toBe(1);
    expect(r.out).toContain("終了コードが 0 ではない: 2");
  });

  it("どれか 1 つでも落ちれば、あとの確かめが通っても、最後は落ちる", () => {
    expect(run("a\n", 'need "$f" "^b"; need "$f" "^a"').code).toBe(1);
  });
});

describe("ワークフロー confinement-check", () => {
  const wf = readFileSync(join(root, ".github/workflows/confinement-check.yml"), "utf8");
  const readme = readFileSync(join(root, "docs/e2e-logs/README.md"), "utf8");

  it("README のログ 7 本のファイル名どおりに残し、artifact に上げる", () => {
    for (const n of ["env", "a-confined", "b-break", "c-no-browser-server", "d-denied-ports", "d-team-ci-test", "e-mysql-rounds"]) {
      expect(readme, `README に ${n}`).toContain(`<日付>-${n}.log`);
      expect(wf, `ワークフローに ${n}`).toContain(`$L/$D-${n}.log`);
    }
    expect(wf).toContain("actions/upload-artifact");
    expect(wf).toContain("if-no-files-found: error");
  });

  it("macOS のランナーで、workflow_dispatch と、閉じ込め・認証まわりを触る PR で起動する", () => {
    expect(wf).toContain("runs-on: macos-latest");
    expect(wf).toContain("workflow_dispatch:");
    for (const p of ['"src/project/confine*"', '"scripts/check-*"', '"e2e/**"']) expect(wf).toContain(p);
  });
});
