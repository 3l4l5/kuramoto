import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ACCESS_TOKEN_ENV, ACCESS_TOKEN_FILE, accessToken } from "./access-token.js";

const dirs: string[] = [];
const home = () => {
  const d = mkdtempSync(join(tmpdir(), "kuramoto-token-"));
  dirs.push(d);
  return d;
};
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

describe("合言葉(ADR-0059)", () => {
  it("環境変数が無ければ、置き場所の access-token を作り(本人だけが読める)、次からは同じ値を使う", () => {
    const h = join(home(), "new-home"); // まだ無い置き場所も作る
    const a = accessToken(h, {});
    expect(a.length).toBeGreaterThanOrEqual(24);
    expect(readFileSync(join(h, ACCESS_TOKEN_FILE), "utf8").trim()).toBe(a);
    expect(statSync(join(h, ACCESS_TOKEN_FILE)).mode & 0o777).toBe(0o600);
    expect(accessToken(h, {})).toBe(a);
  });

  it("start:public と同じファイルを使う。空のファイルは作り直す", () => {
    const h = home();
    writeFileSync(join(h, ACCESS_TOKEN_FILE), "already-there\n");
    expect(accessToken(h, {})).toBe("already-there");
    writeFileSync(join(h, ACCESS_TOKEN_FILE), "\n");
    expect(accessToken(h, {})).not.toBe("");
  });

  it("KURAMOTO_TOKEN があればそれを使い、ファイルは作らない", () => {
    const h = home();
    expect(accessToken(h, { [ACCESS_TOKEN_ENV]: "given" })).toBe("given");
    expect(() => statSync(join(h, ACCESS_TOKEN_FILE))).toThrow();
  });
});
