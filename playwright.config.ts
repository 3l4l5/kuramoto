import { defineConfig } from "@playwright/test";

/**
 * E2E テスト。ビルドした画面(ui/dist)を、フェイクの担当で動くサーバー(e2e/server.ts)にかける。
 * 画面の作りに依らないよう、ボタンの名前や見える文言で操作する(生 JS から React に移したときも同じテストで確かめた)。
 */
const port = 4390;

export default defineConfig({
  testDir: "e2e",
  timeout: 90_000,
  expect: { timeout: 12_000 },
  workers: 1,
  reporter: [["list"]],
  use: { baseURL: `http://localhost:${port}`, channel: "chrome", headless: true, viewport: { width: 1400, height: 1000 } },
  webServer: {
    command: "npx tsx e2e/server.ts",
    url: `http://localhost:${port}/api/hq`,
    env: { E2E_PORT: String(port), E2E_WEB_DIR: "ui/dist" },
    reuseExistingServer: false,
    stdout: "pipe",
  },
});
