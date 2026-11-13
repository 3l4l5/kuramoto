import { existsSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { z } from "zod";
import { defineTool, type KuramotoTool } from "../harness/types.js";
import { DESIGN_DIR, DIFF_WARN } from "./design.js";
import { DEVICE_WIDTH, recordComparison, renderableUrl, type DesignStore, type Renderer, type UrlRenderer } from "./design-visual.js";
import type { Project, TicketRow } from "./project.js";
import type { Workspace } from "./workspace.js";

/** 作業場所の中のファイルの場所。外や無いファイルなら、担当に返す理由。 */
function workspaceFile(wsPath: string, path: string): { path: string } | { error: string } {
  const full = isAbsolute(path) ? path : join(wsPath, path);
  if (!existsSync(full)) return { error: `${path} が見つかりません。作業場所に保存してから呼んでください` };
  const rel = relative(realpathSync(wsPath), realpathSync(full));
  if (rel.startsWith("..") || isAbsolute(rel)) return { error: "作業場所の中のファイルを渡してください" };
  return { path: full };
}

/**
 * 実装した画面のスクリーンショットを、お手本の画像と見比べる道具(ADR-0034)。開発と QA に渡す。
 * 担当は作業場所に保存したスクリーンショットの場所を渡し、Kuramoto が比べて、違いの割合と違いを色付けした画像を返す。
 */
export function compareScreenTools(
  p: Project,
  store: DesignStore,
  ticket: TicketRow,
  wsPath: string,
  gitDir: string,
  refs: Map<string, { id: number; png: Buffer }>,
  ws: Workspace,
): KuramotoTool[] {
  return [
    defineTool({
      name: "compare_screen",
      description: `実装した画面のスクリーンショット(PNG・ページ全体・お手本と同じ幅)を、企画で合意したお手本の画像と比べる。違う画素の割合と、違うところを赤く塗った画像(作業場所の ${DESIGN_DIR}/shots/ に置く)が返る。`,
      input: {
        screen: z.string().describe(`画面の key(${[...refs.keys()].join("・")})`),
        path: z.string().describe("作業場所に保存したスクリーンショットの場所(作業場所からの相対パス。例: .kuramoto/shots/list.png)"),
      },
      handler: async (a) => {
        const ref = refs.get(a.screen);
        if (!ref) return `画面「${a.screen}」のお手本はありません。使えるのは ${[...refs.keys()].join("・")} です`;
        const full = workspaceFile(wsPath, a.path);
        if ("error" in full) return full.error;
        let c;
        try {
          c = await recordComparison(p, store, { ticketId: ticket.id, screenKey: a.screen, reference: ref, actual: readFileSync(full.path) });
        } catch (e) {
          return `比べられませんでした(PNG の画像を渡してください): ${(e instanceof Error ? e.message : String(e)).slice(0, 200)}`;
        }
        const diffFile = `${DESIGN_DIR}/shots/${a.screen}-diff.png`;
        await ws.writeDesign?.(wsPath, gitDir, [{ file: diffFile, data: c.diff }]);
        const pct = (c.ratio * 100).toFixed(1);
        return [
          `お手本との違い: ${pct}%(目安は ${Math.round(DIFF_WARN * 100)}% 以下)。`,
          c.sizeNote,
          `違うところを赤く塗った画像: ${diffFile}(お手本: ${DESIGN_DIR}/${a.screen}.png)。開いて、どこが違うかを確かめてください。`,
          c.ratio > DIFF_WARN ? "違いが大きいので、並び・要素・文言・色・余白を見直してください。" : "",
        ]
          .filter(Boolean)
          .join("\n");
      },
    }),
  ];
}

/**
 * 画面を描いてスクリーンショットにする道具(ADR-0034)。開発と QA に渡す。
 * 担当の作業場所(サンドボックス)の中ではブラウザを起動できない(Chrome が一時ディレクトリとソケットを作れない)ので、
 * サンドボックスの外のサーバが描き、PNG を作業場所に置く。描く先は、担当が動かしたアプリ(ローカルの URL)か、作業場所の HTML(試作など)。
 */
export function renderPageTools(wsPath: string, gitDir: string, ws: Workspace, render: { html: Renderer; url: UrlRenderer; /** false なら URL は描かない(プロジェクトが担当からのローカルの通信を閉じているとき) */ allowUrl?: boolean }): KuramotoTool[] {
  return [
    defineTool({
      name: "render_page",
      description: `画面を、実際の端末の幅(スマホ ${DEVICE_WIDTH.phone}px・パソコン ${DEVICE_WIDTH.desktop}px)のブラウザで描き、ページ全体のスクリーンショット(PNG)を作業場所の ${DESIGN_DIR}/shots/ に置く。作業場所の中ではブラウザが動かないので、撮るときはこれを使う。`,
      input: {
        target: z.string().describe(`描くもの。担当が動かしたアプリのローカルの URL(例: http://localhost:5173/)か、作業場所の HTML の場所。ページが読むのはこの機械の中だけ(外のフォントや画像は読まない)(例: ${DESIGN_DIR}/list.html)`),
        width: z.union([z.literal(DEVICE_WIDTH.phone), z.literal(DEVICE_WIDTH.desktop)]).describe(`幅(スマホ ${DEVICE_WIDTH.phone}・パソコン ${DEVICE_WIDTH.desktop})`),
        name: z.string().describe("保存する名前(英数字と - _。例: list-app)。ファイルは <name>-<幅>.png になる"),
      },
      handler: async (a) => {
        const name = a.name.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 60) || "page";
        let png: Buffer;
        const isUrl = /^[a-z][a-z0-9+.-]*:/i.test(a.target);
        if (isUrl) {
          if (render.allowUrl === false) return "このプロジェクトは、担当からのローカルの通信を閉じている(sandbox_strict_sockets)ので、URL は描けません。作業場所の HTML のファイルを渡してください。";
          if (!renderableUrl(a.target)) return "描けるのは、担当が動かしたアプリの URL(http://localhost:… か http://127.0.0.1:…)だけです。外の URL と、Kuramoto 自身の画面は描けません。";
        }
        try {
          if (isUrl) png = await render.url(a.target, a.width);
          else {
            const f = workspaceFile(wsPath, a.target);
            if ("error" in f) return f.error;
            png = await render.html(readFileSync(f.path, "utf8"), a.width);
          }
        } catch (e) {
          const why = (e instanceof Error ? e.message : String(e)).split("\n")[0]!.slice(0, 200);
          return isUrl ? `描けませんでした。アプリが起動していて、URL が開けるか確かめてください: ${why}` : `描けませんでした。HTML のファイルを確かめてください(外の読み込みは止めています): ${why}`;
        }
        const file = `${DESIGN_DIR}/shots/${name}-${a.width}.png`;
        await ws.writeDesign?.(wsPath, gitDir, [{ file, data: png }]);
        return `スクリーンショットを ${file} に置きました(幅 ${a.width}px)。開いて確かめてください。お手本と比べるなら、これを compare_screen に渡します。`;
      },
    }),
  ];
}
