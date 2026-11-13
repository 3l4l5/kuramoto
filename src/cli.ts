import { parseArgs } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";
import { loadStartupConfig } from "./config.js";
import { ClaudeAgentSdkHarness } from "./harness/claude-agent-sdk.js";
import { GhCli } from "./github/github.js";
import { currentWorkspaceId, Hq, workDirFor } from "./hq.js";
import { Dispatcher } from "./project/dispatcher.js";
import { recoverStale } from "./project/inbox.js";
import { ownerMerge, suggestedMergeOrder } from "./project/merge.js";
import { metrics } from "./project/metrics.js";
import { GitWorkspace } from "./project/workspace.js";
import { answerDecision, createTicket, pendingOwnerDecisions, type DecisionOption } from "./project/workflow.js";

const USAGE = `使い方:
  kuramoto project create <名前> <owner/repo[:役割]>...
  kuramoto project list
  kuramoto ticket add <project> <タイトル> [--body <本文>]
  kuramoto status <project>
  kuramoto run <project> [--concurrency N] [--once]
  kuramoto decisions <project>
  kuramoto answer <project> <判断の番号> <選択肢の番号>
  kuramoto merge <project> <チケット番号>`;

async function main(argv: string[]): Promise<void> {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { body: { type: "string" }, concurrency: { type: "string" }, once: { type: "boolean" } },
  });
  const [cmd, sub, ...rest] = positionals;
  // 設定は stderr に出す(一覧などの出力に混ぜない)
  loadStartupConfig((line) => console.error(line));
  // 入口で今のワークスペースを決め、本部へ渡す。プロジェクトの id がそのワークスペースの中にあるかは、hq.project() / hq.openProject() が確かめる
  const hq = new Hq(undefined, undefined, currentWorkspaceId());
  try {
    switch (cmd) {
      case "project":
        if (sub === "create") {
          const [name, ...repos] = rest;
          if (!name || repos.length === 0) throw new Error(USAGE);
          const rec = await hq.createProject(
            name,
            repos.map((r) => {
              const [fullName, role] = r.split(":");
              return { fullName: fullName!, role: role ?? "その他" };
            }),
          );
          console.log(`作りました: ${rec.id} ${rec.name}(${rec.data_dir})`);
        } else {
          for (const q of await hq.ownerQueue()) console.log(`${q.project.id}\t${q.project.name}\t${q.project.status}\t判断 ${q.decisions} / merge 待ち ${q.merges}`);
        }
        return;
      case "ticket": {
        const p = await hq.openProject(Number(rest[0]));
        const t = createTicket(p, { title: rest[1] ?? "", body: values.body ?? "" });
        console.log(`#${t.number} を作りました`);
        p.close();
        return;
      }
      case "status": {
        const p = await hq.openProject(Number(sub));
        for (const t of p.tickets()) console.log(`#${t.number}\t${t.stage}\t往復 ${t.rounds}\t${t.title}`);
        console.log(JSON.stringify(await metrics(p), null, 2));
        p.close();
        return;
      }
      case "run": {
        const rec = await hq.project(Number(sub));
        const p = await hq.openProject(rec.id);
        const d = new Dispatcher(p, { harnesses: { "claude-agent-sdk": new ClaudeAgentSdkHarness() }, workspace: new GitWorkspace(workDirFor(rec.data_dir)) });
        const recovered = await recoverStale(p);
        if (recovered) console.log(`止まっていた ${recovered} 件を受信箱に戻しました`);
        const concurrency = Number(values.concurrency ?? 1);
        for (;;) {
          const n = await d.drain({ concurrency });
          if (n) console.log(`${n} 件を起動しました`);
          if (values.once) break;
          await sleep(5_000);
        }
        p.close();
        return;
      }
      case "decisions": {
        const p = await hq.openProject(Number(sub));
        for (const d of pendingOwnerDecisions(p)) {
          const opts = (JSON.parse(d.options) as DecisionOption[]).map((o, i) => `  ${i}. ${o.label}${i === d.recommended ? "(推奨)" : ""}`).join("\n");
          console.log(`[${d.id}] ${d.question}\n${opts}\n  理由: ${d.why}\n  間違えると: ${d.impact}(${d.reversible ? "戻せる" : "戻せない"})\n  期限: ${d.deadline_at}(過ぎると推奨で進みます)\n`);
        }
        p.close();
        return;
      }
      case "answer": {
        const p = await hq.openProject(Number(sub));
        answerDecision(p, Number(rest[0]), Number(rest[1]));
        console.log("答えました");
        p.close();
        return;
      }
      case "merge": {
        const p = await hq.openProject(Number(sub));
        const t = p.tickets().find((x) => x.number === Number(rest[0]));
        if (!t) {
          console.log(`merge 待ち(この順がおすすめ): ${suggestedMergeOrder(p).map((x) => `#${x.number}`).join(" → ") || "なし"}`);
        } else {
          console.log(JSON.stringify(await ownerMerge(p, new GhCli(), t.id)));
        }
        p.close();
        return;
      }
      default:
        console.log(USAGE);
    }
  } finally {
    hq.close();
  }
}

main(process.argv.slice(2)).catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
