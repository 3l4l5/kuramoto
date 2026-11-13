import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["src/**/*.test.ts", "scripts/**/*.test.ts"], setupFiles: ["src/db/vitest-setup.ts"] },
});
