import { afterEach, describe, expect, it, vi } from "vitest";
import { adminUrl, disposableDbName, testDbMode, withDatabase } from "./mysql-test-support.js";

describe("mysql-test-support(試験の回の切り替えと、使い捨ての database)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("KURAMOTO_TEST_DB で回が決まる(未設定は auto)", () => {
    expect(testDbMode({ KURAMOTO_TEST_DB: "sqlite" })).toBe("sqlite");
    expect(testDbMode({ KURAMOTO_TEST_DB: "mysql" })).toBe("mysql");
    expect(testDbMode({})).toBe("auto");
    expect(testDbMode({ KURAMOTO_TEST_DB: "x" })).toBe("auto");
  });

  it("使い捨ての database の名前は重ならない。管理用の URL は、試験の接続先の host:port の root", () => {
    const names = new Set(Array.from({ length: 200 }, () => disposableDbName()));
    expect(names.size).toBe(200);
    for (const n of names) expect(n).toMatch(/^kuramoto_test_[0-9a-z]+_[0-9a-f]{8}$/);
    expect(adminUrl("mysql://kuramoto_test:kuramoto-test@127.0.0.1:3307/kuramoto_test", {})).toBe("mysql://root:kuramoto-test-root@127.0.0.1:3307");
    expect(adminUrl("mysql://a:b@h:1/x", { KURAMOTO_MYSQL_TEST_ADMIN_URL: "mysql://root:z@h:1" })).toBe("mysql://root:z@h:1");
    expect(withDatabase("mysql://u:p@127.0.0.1:3307/kuramoto_test", "kuramoto_test_a")).toBe("mysql://u:p@127.0.0.1:3307/kuramoto_test_a");
  });

  // 127.0.0.1:1 は、誰も待ち受けていない(繋がらない)
  const unreachable = "mysql://kuramoto_test:kuramoto-test@127.0.0.1:1/kuramoto_test";

  it("MySQL の回で mysql-test に繋がらなければ、飛ばさずに投げる(案内つき)。SQLite の回と未設定は飛ばす(undefined)", async () => {
    vi.stubEnv("KURAMOTO_MYSQL_TEST_URL", unreachable);
    vi.resetModules();
    const m = await import("./mysql-test-support.js");

    vi.stubEnv("KURAMOTO_TEST_DB", "mysql");
    await expect(m.connectTest()).rejects.toThrow("docker compose up -d mysql-test");

    vi.stubEnv("KURAMOTO_TEST_DB", "sqlite");
    expect(await m.connectTest()).toBeUndefined();

    vi.stubEnv("KURAMOTO_TEST_DB", "");
    expect(await m.connectTest()).toBeUndefined();
  });

  it("使い捨ての database を作るとき、管理用の接続が繋がらなければ案内つきで投げる", async () => {
    const m = await import("./mysql-test-support.js");
    await expect(m.createDisposableDb(unreachable, {})).rejects.toThrow("docker compose up -d mysql-test");
  });
});
