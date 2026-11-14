import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { allowChromiumMachRegister, CHROMIUM_MACH_REGISTER_NAME, needsMachRegister } from "./mach-register.js";

const RULE = `(allow mach-register (global-name-prefix "${CHROMIUM_MACH_REGISTER_NAME}"))`;

describe("allowChromiumMachRegister(ブラウザ専用の閉じ込めに、Chromium の mach-register を 1 行だけ足す)", () => {
  const profile = '(version 1)\n(deny default)\n(allow mach-priv-task-port (target same-sandbox))\n(allow mach-lookup\n  (global-name "com.apple.logd")\n)\n';

  it("目印の行のすぐあとに、規則を 1 行だけ足す。ほかは 1 文字も変えない", () => {
    const out = allowChromiumMachRegister(`sandbox-exec -p '${profile}' bash`);
    expect(out).toContain(`(allow mach-priv-task-port (target same-sandbox))\n${RULE}\n(allow mach-lookup`);
    expect(out.replace(`\n${RULE}`, "")).toBe(`sandbox-exec -p '${profile}' bash`);
    expect(out.split("mach-register").length - 1).toBe(1);
  });

  it("引用符が \\\" の形(shell-quote の出力)でも、同じ形で足す", () => {
    const quoted = profile.replaceAll('"', '\\"');
    const out = allowChromiumMachRegister(quoted);
    expect(out).toContain(`(allow mach-register (global-name-prefix \\"${CHROMIUM_MACH_REGISTER_NAME}\\"))`);
  });

  it("ファイル・ネットワーク・mach-lookup の許可は足さない(足すのは mach-register の 1 行だけ)", () => {
    const out = allowChromiumMachRegister(profile);
    const added = out.split("\n").filter((l) => !profile.split("\n").includes(l));
    expect(added).toEqual([RULE]);
  });

  it("差し込む位置(目印の行)が無ければ、黙って素のプロファイルで流さず投げる", () => {
    expect(() => allowChromiumMachRegister('(version 1)\n(deny default)\n(allow mach-lookup (global-name "com.apple.logd"))')).toThrow(/mach-register の許可を足せませんでした/);
    expect(() => allowChromiumMachRegister("(allow mach-priv-task-port (target same-sandbox))")).toThrow(/足せませんでした/);
  });

  it("macOS だけで足す", () => {
    expect(needsMachRegister("darwin")).toBe(true);
    expect(needsMachRegister("linux")).toBe(false);
  });

  it.skipIf(process.platform !== "darwin")("sandbox-runtime が実際に返すコマンドに足せる(ライブラリの書き方が変わったら、ここで止まる)", async () => {
    const { SandboxManager } = await import("@anthropic-ai/sandbox-runtime");
    await SandboxManager.reset();
    await SandboxManager.initialize({
      network: { allowedDomains: [], deniedDomains: [], strictAllowlist: true },
      filesystem: { denyRead: [], allowRead: [], allowWrite: [tmpdir()], denyWrite: [] },
    });
    try {
      const raw = await SandboxManager.wrapWithSandbox("echo hi");
      expect(raw).not.toContain("mach-register");
      const out = allowChromiumMachRegister(raw);
      expect(out).toContain("(allow mach-register (global-name-prefix");
      expect(out).toContain(CHROMIUM_MACH_REGISTER_NAME);
      expect(out.length).toBeGreaterThan(raw.length);
    } finally {
      await SandboxManager.reset();
    }
  });
});
