import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { QuestionItem } from "../ui/src/Ticket.js";
import type { TicketView } from "./server.js";

type Q = Extract<TicketView["timeline"][number], { type: "question" }>;
const base: Q = { type: "question", at: "2026-01-01T00:00:00.000Z", from: "手毬", to: "レビュー", body: "空のときは?", routedToLead: false, noRoute: false, answer: null, answeredBy: null, answeredAt: null };
const html = (q: Partial<Q>) => renderToStaticMarkup(createElement(QuestionItem, { x: { ...base, ...q } }));

describe("やりとりの質問(R16)", () => {
  it("答えを待っている質問と、答えが付いた質問", () => {
    expect(html({})).toContain("手毬がレビューに質問しました");
    expect(html({})).toContain("まだ答えを待っています");
    const answered = html({ answer: "0 件と 1 件を見て", answeredBy: "蛍" });
    expect(answered).toContain("蛍の答え");
    expect(answered).toContain("0 件と 1 件を見て");
    expect(answered).not.toContain("経路が無い");
  });
  it("経路が無くてリーダーに回ったことが残る", () => {
    const out = html({ to: "QA", routedToLead: true, noRoute: true });
    expect(out).toContain("手毬がQAに質問しました");
    expect(out).toContain("経路が無いのでリーダーに回した");
  });
  it("リーダーへの質問は「経路が無い」とは出さない", () => {
    expect(html({ to: "リーダー", routedToLead: true })).not.toContain("経路が無い");
  });
});
