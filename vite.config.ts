import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// 画面(ui/)を ui/dist にビルドし、ローカルサーバー(src/server.ts)が配る。
// 開発中は `npm run dev:ui` で Vite を動かし、/api はローカルサーバーへ回す。
export default defineConfig({
  root: "ui",
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true },
  server: { port: 5173, proxy: { "/api": "http://localhost:4300" } },
});
