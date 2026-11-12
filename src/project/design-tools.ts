import { existsSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { z } from "zod";
import { defineTool, type KuramotoTool } from "../harness/types.js";
import { DESIGN_DIR, DIFF_WARN } from "./design.js";
import { recordComparison, type DesignStore } from "./design-visual.js";
import type { Project, TicketRow } from "./project.js";
import type { Workspace } from "./workspace.js";

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
        const full = isAbsolute(a.path) ? a.path : join(wsPath, a.path);
        if (!existsSync(full)) return `${a.path} が見つかりません。スクリーンショットを作業場所に保存してから呼んでください`;
        const rel = relative(realpathSync(wsPath), realpathSync(full));
        if (rel.startsWith("..") || isAbsolute(rel)) return "作業場所の中のファイルを渡してください";
        let c;
        try {
          c = await recordComparison(p, store, { ticketId: ticket.id, screenKey: a.screen, reference: ref, actual: readFileSync(full) });
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
