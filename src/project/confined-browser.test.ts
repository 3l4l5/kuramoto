import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { serverScript } from "./confined-browser.js";

describe("serverScript(狭い閉じ込めの中のブラウザサーバーの起動のスクリプト)", () => {
  it("@playwright/test を、リポジトリの node_modules の絶対パスで読む(カレントディレクトリに頼らない)", () => {
    expect(serverScript("/work/repo")).toContain('require("/work/repo/node_modules/@playwright/test")');
  });

  it("確かめの CI(KURAMOTO_E2E_BROWSER_DEBUG=1)では、DEBUG に頼らず、ブラウザの標準エラーと「閉じた」を標準エラーに出す", () => {
    const s = serverScript("/work/repo");
    expect(s).toContain('KURAMOTO_E2E_BROWSER_DEBUG === "1"');
    expect(s).toContain("[pw:browser]");
    expect(s).toContain('server.on("close"');
  });

  it("GPU プロセスを使わない起動オプション(--disable-gpu)を渡す(閉じ込めの中で描画のフレームが出ず click が時間切れになるのを避ける。許可は足さない。#118)", () => {
    const s = serverScript("/work/repo");
    expect(s).toContain('args: ["--disable-gpu"]');
    // Chrome の起動も、同梱の Chromium への切り替えも、同じ opts(起動オプション入り)で立てる
    expect(s).toContain('launchServer({ channel: "chrome", ...opts })');
    expect(s).toContain("chromium.launchServer(opts)");
  });

  it("確かめの CI(KURAMOTO_E2E_BROWSER_DEBUG=1)では、描画のフレームが出るかを調べて [pw:probe] に出す(ブラウザサーバーの動きは変えない)", () => {
    const s = serverScript("/work/repo");
    expect(s).toContain("[pw:probe]");
    expect(s).toContain("requestAnimationFrame");
    // 宛先の出力(KURAMOTO_WS)のあとで調べる(宛先を渡すのを遅らせない)
    expect(s.indexOf("KURAMOTO_WS")).toBeLessThan(s.indexOf("[pw:probe]"));
  });

  it("ブラウザの起動オプションを入れたスクリプトは、node の構文として読める", () => {
    const r = spawnSync(process.execPath, ["--check", "-"], { input: serverScript("/work/repo"), encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0);
  });

  it("カレントディレクトリが別の場所でも、そのパスの @playwright/test を読める", () => {
    const repo = mkdtempSync(join(tmpdir(), "cb-repo-"));
    const elsewhere = mkdtempSync(join(tmpdir(), "cb-cwd-"));
    try {
      mkdirSync(join(repo, "node_modules/@playwright/test"), { recursive: true });
      writeFileSync(join(repo, "node_modules/@playwright/test/index.js"), 'module.exports = { chromium: { launchServer: async () => { console.log("FOUND"); process.exit(0); } } };');
      const r = spawnSync(process.execPath, ["-e", serverScript(repo)], { cwd: elsewhere, encoding: "utf8" });
      expect(r.stdout + r.stderr).toContain("FOUND");
      expect(r.stderr).not.toContain("Cannot find module");
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });
});
