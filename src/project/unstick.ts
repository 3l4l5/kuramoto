import { z } from "zod";
import { all, get, run } from "../db/sqlite.js";
import { ROLE_LABEL, type Role } from "../domain/roles.js";
import { defineTool, type KuramotoTool } from "../harness/types.js";
import { send, type MessageRow } from "./inbox.js";
import { dropUnneeded } from "./patrol.js";
import { lastCiFailure } from "./merge.js";
import { lastTeamCi, teamCiEnabled } from "./team-ci.js";
import type { Project, TicketRow } from "./project.js";
import { closeAlreadyDone, createTicket, holdTicket, resumeWork, ticketBudgetUsd, ticketSpentUsd, type ResumeMessage } from "./workflow.js";

/**
 * 詰まったチケットの手助け。担当の起動が同じように失敗し続けたら、責任者に上げる前にリーダーが原因を調べる。
 * - 直せそうなら、担当への助言をチケットのメモに書いて、止まった仕事をやり直させる(retry_with_advice)
 * - 担当を替えたほうがよければ、別のメンバー・島に渡す(reassign)
 * - 大きすぎるなら、残りを別チケットに切り出し、範囲を絞ってやり直させる(split_and_retry)
 * - 変更がすでに main に入っていた(重複・先に入った)なら、確かめて完了にする(close_as_already_done)
 * - チームの中では解けない(環境・権限・仕様の判断が要る)なら、保留して責任者に何をしてほしいかを伝える(hold)
 * リーダーの手助けが続けて unstick_max 回(既定 5)に達しても進まなければ、保留にする。
 */

export type StuckPayload = {
  /** 何が起きたか(画面と指示に出す)。 */
  error: string;
  /** 止まった仕事。やり直すときはこれをもう一度送る。 */
  resume: ResumeMessage;
};

function messageOf(msg: MessageRow): ResumeMessage {
  return { toRole: msg.to_role, toMemberId: msg.to_member_id, kind: msg.kind, payload: JSON.parse(msg.payload) as Record<string, unknown> };
}

/** これまでにリーダーが手助けした回数(このチケットで、前に進むまでの続けての回数)。 */
export function unstickCount(p: Project, ticketId: number): number {
  return p.settingNumber(`unstick_count:${ticketId}`, 0);
}

/** チケットが前に進んだら(工程を通ったら)数え直す。 */
export function resetUnstick(p: Project, ticketId: number): void {
  p.setSetting(`unstick_count:${ticketId}`, "0");
}

/** 再試行が尽きた。リーダーに手助けを頼む。手助けを使い切っていたら保留する。 */
export function askLeadToUnstick(p: Project, ticket: TicketRow, msg: MessageRow, error: string): void {
  const resume = messageOf(msg);
  const n = unstickCount(p, ticket.id);
  const max = p.settingNumber("unstick_max", 5);
  if (n >= max) {
    holdTicket(p, ticket.id, {
      reason: `リーダーが ${n} 回手助けしても、同じように止まりました。最後のエラー: ${error}`,
      ownerAction: "チケットの「やりとり」とリーダーのメモを見て、原因(環境・権限・仕様など)を取り除いてから再開してください。",
      resume,
    });
    return;
  }
  p.setStage(ticket.id, "decision");
  send(p, { ticketId: ticket.id, toRole: "lead", kind: "unstick", payload: { error, resume } satisfies StuckPayload });
  p.event("system", "stuck", ticket.id, { error, role: msg.to_role, kind: msg.kind, help: n + 1 });
}

/** リーダーが調べる材料: チケット・止まった仕事・最近の起動・最後の起動の途中経過・これまでの助言。 */
export function unstickPrompt(p: Project, ticket: TicketRow, payload: StuckPayload): string {
  const runs = all<{ id: number; role: string; name: string; outcome: string | null; error: string | null; summary: string | null; started_at: string; cost_usd: number | null }>(
    p.db,
    "SELECT r.id, r.role, m.name, r.outcome, r.error, r.summary, r.started_at, r.cost_usd FROM runs r JOIN members m ON m.id = r.member_id WHERE r.ticket_id = ? ORDER BY r.id DESC LIMIT 8",
    [ticket.id],
  );
  const last = runs.find((r) => r.outcome === "error") ?? runs[0];
  const steps = last
    ? all<{ kind: string; text: string }>(p.db, "SELECT kind, text FROM run_steps WHERE run_id = ? ORDER BY id DESC LIMIT 30", [last.id]).reverse()
    : [];
  const notes = p.notes(ticket.id);
  const budget = ticketBudgetUsd(p, ticket.id);
  const pr = get<{ number: number; head: string }>(p.db, "SELECT number, head FROM pull_requests WHERE ticket_id = ? LIMIT 1", [ticket.id]);
  const who = payload.resume.toMemberId ? p.member(payload.resume.toMemberId).name : `${ROLE_LABEL[payload.resume.toRole as Role] ?? payload.resume.toRole}の手すきの人`;
  return `チケットの仕事が同じように失敗し続けて止まりました。原因を調べて、チームが先に進めるように手助けしてください。

## チケット #${ticket.number}: ${ticket.title}
${ticket.body.trim().slice(0, 2000) || "(本文なし)"}

## 止まった仕事
- 担当: ${who}(${ROLE_LABEL[payload.resume.toRole as Role] ?? payload.resume.toRole}の「${payload.resume.kind}」)
- 最後のエラー: ${payload.error}
- 使った額: $${ticketSpentUsd(p, ticket.id).toFixed(2)}${budget === null ? "(予算は無制限)" : ` / 予算 $${budget}`}
${pr ? `- PR: #${pr.number}(ブランチ ${pr.head})` : "- PR: まだありません"}
- これまでのリーダーの手助け: ${unstickCount(p, ticket.id)} 回

## 最近の起動(新しい順)
${runs.map((r) => `- [${r.started_at}] ${r.name}(${r.role}): ${r.outcome ?? "?"}${r.error ? ` / ${r.error.slice(0, 300)}` : ""}${r.summary ? ` / ${r.summary.slice(0, 200)}` : ""}`).join("\n") || "(なし)"}

## 最後の起動の途中経過
${steps.map((s) => `- [${s.kind}] ${s.text.slice(0, 300)}`).join("\n") || "(記録なし)"}

${lastCiFailure(p, ticket.id)}
${lastTeamCi(p, ticket.id)}

## これまでのメモ(責任者・リーダーから)
${notes.map((n) => `- ${n.who === "lead" ? "リーダー" : "責任者"}: ${n.body}`).join("\n") || "(なし)"}

## 進め方
- 作業場所には、このチケットのブランチ(push 済みのもの)が取り出してあります。コードを読み、必要ならテストやコマンドを動かして原因を確かめます(ファイルは変えられません)。
- チームで責任を持って解きます。チケットをやめたり、責任者に判断を頼んだりはしません。
- 直せそうなら retry_with_advice で、担当への具体的な助言(何が原因で、どこをどう直すか・何を避けるか)を渡してやり直させます。同じ助言の繰り返しは避けます。
- 担当が同じところで詰まり続けているなら、reassign で別のメンバーか島に渡します(新しい目で見てもらう)。
- チケットが大きすぎる・手元で確かめられない部分がある(例: 本番の CI でしか動かない)なら、split_and_retry で残りを別チケットに切り出し、今のチケットは確かめられる範囲に絞ってやり直させます。
- このチケットの変更が、すでに main に入っている(別のチケットで先に入った・重複していた)なら、close_as_already_done で完了にします。git log origin/main でコミットを確かめ、受け入れ条件を満たしているかも見てから呼びます。保留にはしません。
${teamCiEnabled(p) ? "- CI はチームの CI を使っています(GitHub Actions は止めてあり、merge にも使いません)。落ちたなら、上の「最後のチームの CI」の出力で原因を見立てます。GitHub の CI の失敗は理由にしません。" : `- CI が落ちているなら、上の「最後に落ちた CI」と、ci_status・ci_run(ジョブ・ステップ・GitHub の注記・ログ)・ci_settings(秘密情報の名前)で原因を見立てます。作業場所からは GitHub は見えませんが、これらの道具は Kuramoto が外で GitHub を見て答えます。責任者に「ログを貼ってほしい」「やり直してほしい」とは頼みません(ci_rerun で自分でやり直せます)。ジョブが始まってもいない(ステップが 1 つも動いていない)なら、注記に理由(請求・使用額の上限・ランナー)が書かれています。原因がコードなら retry_with_advice で直し方を、main でも落ちているなら main の CI を直すチケットに任せて待つよう伝えます。ワークフローの設定・秘密情報など責任者にしかできないことが原因なら hold にします。`}
- 直すコードが無い・やることが無いチケット(GitHub の CI のためだけのもの、仕様が変わっていらなくなったものなど)は、hold にせず drop_ticket で理由を書いて取りやめます。
- 仕様が決まっていないなら、受け入れ条件と設計から仮に決め、その前提を助言に書いて進めます。
- hold(保留)は、責任者にしかできないことが要るときだけです(秘密情報やアカウントの登録・外のサービスの契約・権限の付与など)。そのときは責任者に何をしてほしいかを具体的に書きます。
- 最後のテキストは、責任者への短い報告(原因の見立てと、どうしたか)にします。`;
}

export function unstickTools(
  p: Project,
  ticket: TicketRow,
  payload: StuckPayload,
  done: { action?: "retry" | "hold" | "closed" | "dropped" },
  ws: { checkLanded?: (commit: string) => Promise<string | undefined>; closePrs?: (a: { commit: string; reason: string }) => Promise<void>; closeTicketPrs?: (t: TicketRow, reason: string) => Promise<void> } = {},
): KuramotoTool[] {
  return [
    defineTool({
      name: "close_as_already_done",
      description:
        "このチケットの変更が、すでに main に入っていて、やることが無いときに完了にする(別のチケット・PR で先に入った、重複していた)。Kuramoto がコミットが main に入っていることを確かめ、開いたままの PR があれば閉じる。",
      input: {
        commit: z.string().min(4).describe("このチケットの変更が入った main 上のコミット(SHA)"),
        reason: z.string().min(1).describe("何がどこで入っていたか(受け入れ条件を満たしていることも含めて)"),
      },
      handler: async (a) => {
        if (done.action) return "もう決めました。";
        const problem = await ws.checkLanded?.(a.commit);
        if (problem) return problem;
        await ws.closePrs?.(a);
        closeAlreadyDone(p, ticket, { ...a, by: p.fixedMember("lead").name });
        done.action = "closed";
        return "確かめて、完了にしました。";
      },
    }),
    defineTool({
      name: "retry_with_advice",
      description: "担当への助言をチケットのメモに書き、止まった仕事をやり直させる。",
      input: { advice: z.string().min(1).describe("担当への具体的な助言。原因の見立て、どこをどう直すか、何を避けるか") },
      handler: (a) => {
        if (done.action) return "もう決めました。";
        p.addNote(ticket.id, `【手助け】${a.advice}`, "lead");
        p.setSetting(`unstick_count:${ticket.id}`, String(unstickCount(p, ticket.id) + 1));
        resumeWork(p, ticket, payload.resume);
        done.action = "retry";
        return "助言を渡して、やり直しを頼みました。";
      },
    }),
    defineTool({
      name: "reassign",
      description: "止まった仕事を、別のメンバーか島に渡してやり直させる。助言はチケットのメモになる。",
      input: {
        to: z.string().min(1).describe("渡す相手。メンバーの名前か島の名前(島なら手すきの人が取る)"),
        advice: z.string().min(1).describe("新しい担当への助言(ここまでの経緯・原因の見立て・避けること)"),
      },
      handler: (a) => {
        if (done.action) return "もう決めました。";
        const role = payload.resume.toRole;
        const units = p.currentFormation().units.filter((u) => (u.roles as string[]).includes(role));
        const unit = units.find((u) => u.name === a.to);
        const member = units.flatMap((u) => p.membersOfUnit(u.id)).find((m) => m.name === a.to);
        if (!unit && !member) return `「${a.to}」は${ROLE_LABEL[role as Role] ?? role}の島のメンバーでも島でもありません。今の島: ${units.map((u) => `${u.name}(${p.membersOfUnit(u.id).map((m) => m.name).join("・")})`).join("、")}`;
        p.addNote(ticket.id, `【手助け・担当替え】${a.advice}`, "lead");
        p.setSetting(`unstick_count:${ticket.id}`, String(unstickCount(p, ticket.id) + 1));
        // 開発なら持ち主ごと替える(新しい担当がブランチの続きから進める)。島を指したら、持ち主を外して手すきの人に取らせる
        if (role === "dev") run(p.db, "UPDATE tickets SET owner_member_id = ? WHERE id = ?", [member?.id ?? null, ticket.id]);
        const kind = role === "dev" ? (member ? "answer" : "implement") : payload.resume.kind;
        resumeWork(p, ticket, {
          ...payload.resume,
          toMemberId: member?.id ?? null,
          kind,
          payload:
            kind === "answer"
              ? { question: "前の担当がこのチケットで詰まっていました", answer: "あなたが引き継ぎます。チケットのメモ(リーダーの助言)を読み、今のブランチの続きから進めてください" }
              : payload.resume.payload,
        });
        done.action = "retry";
        return `${a.to} に渡しました。`;
      },
    }),
    defineTool({
      name: "split_and_retry",
      description: "残りを別チケットに切り出し、今のチケットは範囲を絞ってやり直させる。切り出したチケットは、リーダーの交通整理で順番と担当が決まる。",
      input: {
        tickets: z.array(z.object({ title: z.string().min(1), body: z.string().describe("やること・受け入れ条件・なぜ切り出したか") })).min(1),
        advice: z.string().min(1).describe("今のチケットの担当への助言(どこまでをこのチケットでやるか)"),
      },
      handler: (a) => {
        if (done.action) return "もう決めました。";
        const made = a.tickets.map((t) =>
          createTicket(p, { title: t.title, body: `${t.body}\n\n---\n#${ticket.number}「${ticket.title}」が大きすぎたため、リーダーが切り出しました。`, planRefs: { splitFrom: ticket.number } }),
        );
        p.addNote(ticket.id, `【手助け・切り出し】#${made.map((t) => t.number).join("・#")} に切り出しました。${a.advice}`, "lead");
        p.setSetting(`unstick_count:${ticket.id}`, String(unstickCount(p, ticket.id) + 1));
        resumeWork(p, ticket, payload.resume);
        done.action = "retry";
        return `#${made.map((t) => t.number).join("・#")} に切り出し、範囲を絞ってやり直してもらいます。`;
      },
    }),
    defineTool({
      name: "drop_ticket",
      description: "直すコードが無い・やることが無いチケットを、理由を書いて取りやめる(GitHub の CI のためだけのもの、仕様が変わっていらなくなったものなど)。記録は消さず、責任者が戻せる。",
      input: { reason: z.string().min(1).describe("なぜいらないか(責任者が読む)") },
      handler: async (a) => {
        if (done.action) return "もう決めました。";
        const r = await dropUnneeded(p, ticket.number, a.reason, ws.closeTicketPrs);
        if (p.ticket(ticket.id).stage === "dropped") done.action = "dropped";
        return r;
      },
    }),
    defineTool({
      name: "hold",
      description:
        "責任者にしかできないこと(秘密情報やアカウントの登録・契約・権限の付与など)が要るときだけ、保留して責任者に対応を頼む。チケットはやめずに止めておき、責任者が再開を押すまで待つ。仕様の判断は保留の理由にしない(仮に決めて進める)。",
      input: {
        reason: z.string().min(1).describe("何が原因で止まっているか(分かった範囲で)"),
        owner_action: z.string().min(1).describe("責任者にしてほしいこと(具体的に。例: CI の秘密情報 X を登録する、仕様 Y を決める)"),
      },
      handler: (a) => {
        if (done.action) return "もう決めました。";
        holdTicket(p, ticket.id, { reason: a.reason, ownerAction: a.owner_action, resume: payload.resume });
        done.action = "hold";
        return "保留して、責任者に対応を頼みました。";
      },
    }),
  ];
}
