import { createReadStream, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

/**
 * 開発のときだけ、デザインシステムのカタログ(/_design)が使う「企画で合意した画面」の画像と試作を
 * 作業場所の .kuramoto/design/ から /_design/screens/ で配る。configureServer は vite build では動かないので本番には出ない。
 */
function designScreens(): Plugin {
  const dir = fileURLToPath(new URL("./.kuramoto/design/", import.meta.url));
  return {
    name: "kuramoto-design-screens",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use("/_design/screens/", (req, res, next) => {
        const m = /^\/([a-z-]+)\.(png|html)$/.exec((req.url ?? "").split("?")[0]);
        if (!m || !existsSync(dir + m[1] + "." + m[2])) return next();
        res.setHeader("Content-Type", m[2] === "png" ? "image/png" : "text/html; charset=utf-8");
        createReadStream(dir + m[1] + "." + m[2]).pipe(res);
      });
    },
  };
}

// 画面(ui/)を ui/dist にビルドし、ローカルサーバー(src/server.ts)が配る。
// 開発中は `npm run dev:ui` で Vite を動かし、/api はローカルサーバーへ回す。
export default defineConfig({
  root: "ui",
  plugins: [react(), designScreens()],
  build: { outDir: "dist", emptyOutDir: true },
  server: { port: 5173, proxy: { "/api": "http://localhost:4300" } },
});
