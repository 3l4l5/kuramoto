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
    const r = spawnSync("bash", ["-c", `. "${lib}"; f="${f}"; ${body}; exit $fail`], { encoding: "utf8", env: { ...process.env, SKIP_DENY_LOG: "1", RUNNER_TEMP: dir } });
    return { code: r.status, out: r.stdout + r.stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("ci-confinement-lib.sh(閉じ込めの確かめの CI が、ログを読む道具)", () => {
  it("need: 期待の行があれば通り、無ければ理由を貯めて落とす(注釈は finish が 1 件にまとめる)", () => {
    expect(run("○ 入口を壊すと落ちた\n", 'need "$f" "^○ 入口を壊すと落ちた"').code).toBe(0);
    const r = run("✗ 入口を壊したのに通った\n", 'need "$f" "^○ 入口を壊すと落ちた"');
    expect(r.code).toBe(1);
    expect(r.out).toContain("FAIL: x.log に期待の行が無い");
  });

  it("forbid: 出てはいけない行があれば落とす(その行も出す)。無ければ通る", () => {
    expect(run("○ ok\n", 'forbid "$f" "^(✗|△)"').code).toBe(0);
    const r = run("○ ok\n✗ 閉じ込めに穴がある\n", 'forbid "$f" "^(✗|△)"');
    expect(r.code).toBe(1);
    expect(r.out).toContain("✗ 閉じ込めに穴がある");
  });

  it("need / forbid: ログに制御文字(色の ESC など)があっても、その先の行まで読む", () => {
    const log = "○ 前の行\n\x1b[32m✓\x1b[39m 色つきの行 \x07\x08\nTests  12 passed (12)\n✗ 落ちた回: MySQL\n";
    expect(run(log, 'need "$f" "Tests +[0-9]+ passed"').code).toBe(0);
    expect(run(log, 'forbid "$f" "^✗ 落ちた回"').code).toBe(1);
  });

  it("need_code: 終了コードが期待(既定 0)と違えば落とす", () => {
    expect(run("", 'need_code "手順" 0').code).toBe(0);
    expect(run("", 'need_code "手順" 2 2').code).toBe(0);
    const r = run("", 'need_code "手順" 2');
    expect(r.code).toBe(1);
    expect(r.out).toContain("終了コードが 0 ではない: 2");
  });

  it("show_reasons: 「---」の行とその前後、末尾を出す", () => {
    const r = run("前の行\n--- 確かめられなかった: 理由\n後の行\n", 'show_reasons "$f"');
    expect(r.code).toBe(0);
    expect(r.out).toContain("::group::x.log");
    expect(r.out).toContain("2:--- 確かめられなかった: 理由");
    expect(r.out).toContain("前の行");
    expect(r.out).toContain("後の行");
  });

  it("finish: 貯めた理由を、改行を %0A にした 1 件の注釈にまとめて出し、落ちる。何も無ければ通る", () => {
    const ok = run("a\n", 'need "$f" "^a"; finish');
    expect(ok.code).toBe(0);
    expect(ok.out).not.toContain("::error");
    const r = run("a\n", 'need "$f" "^b"; need "$f" "^c"; need_code 手順 2; finish');
    expect(r.code).toBe(1);
    expect(r.out.match(/^::error title=期待どおりではない::/gm)).toHaveLength(1);
    expect(r.out).toMatch(/::error title=期待どおりではない::.*\^b.*%0A.*\^c.*%0A.*終了コードが 0 ではない: 2/);
  });

  it("show_reasons: ✗ の行・Chrome の落ちた理由・末尾を、短い注釈に分けて出す(注釈は 1 件 700 文字ほどで切れるため)。中身が無い注釈は出さない", () => {
    const r = run("%\n✗ 落ちた回: X\n[browser-server] FATAL: Check failed\n○ ok\n", 'show_reasons "$f"');
    expect(r.out).toMatch(/^::error title=1 ✗△\?---\(x\.log\)::✗ 落ちた回: X/m);
    expect(r.out).toMatch(/^::error title=2 Chrome の落ちた理由\(x\.log\)::.*FATAL/m);
    expect(r.out).toMatch(/^::error title=3 ブラウザサーバーの先頭/m);
    expect(r.out).not.toMatch(/title=5 落ちた E2E/);
    expect(r.out).toMatch(/title=6 末尾\(x\.log\)::.*%25.*%0A/);
    for (const l of r.out.split("\n")) if (l.startsWith("::error")) expect(l.length).toBeLessThan(900);
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

  it("continue-on-error は、どのステップ・ジョブにも付けない((a) は #118、(e) の MySQL の回は #116)。判定はゆるめない", () => {
    expect(wf).not.toMatch(/^\s*continue-on-error:/m);
    // (e) は #116 で直った。既知の失敗として扱う仕組み(steps.e.outcome・::warning::)は残さない
    expect(wf).not.toContain("steps.e.outcome");
    expect(wf).not.toContain("#116 の既知の失敗");
    for (const n of ["need_code \"(a) check-confined-browser\"", "'^○ E2E [0-9]+ 件が通った'", "forbid \"$L/$D-a-confined.log\" '^✗'"]) {
      expect(wf, `(a) の判定 ${n}`).toContain(n);
    }
  });
});
