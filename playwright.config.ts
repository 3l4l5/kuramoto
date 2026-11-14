import { defineConfig } from "@playwright/test";
import { BROWSER_CHANNEL } from "./e2e/browser.js";

/**
 * E2E テスト。ビルドした画面(ui/dist)を、フェイクの担当で動くサーバー(e2e/server.ts)にかける。
 * 画面の作りに依らないよう、ボタンの名前や見える文言で操作する(生 JS から React に移したときも同じテストで確かめた)。
 */
const port = Number(process.env.E2E_PORT ?? 4390);

export default defineConfig({
  testDir: "e2e",
  timeout: 90_000,
  expect: { timeout: 12_000 },
  workers: 1,
  // 全体で 12 分を超えたら止める(チームの CI の 1 コマンドの時間切れ 20 分に、npm test のほかの回と合わせて収めるため)
  globalTimeout: 12 * 60_000,
  reporter: [["list"]],
  use: { baseURL: `http://localhost:${port}`, channel: BROWSER_CHANNEL, headless: true, viewport: { width: 1400, height: 1000 } },
  webServer: {
    command: "npx tsx e2e/server.ts",
    url: `http://localhost:${port}/api/hq`,
    env: { E2E_PORT: String(port), E2E_WEB_DIR: "ui/dist" },
    reuseExistingServer: false,
    stdout: "pipe",
  },
});
