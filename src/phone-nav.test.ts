import { describe, expect, it } from "vitest";
import { initialNav } from "../ui/src/phoneNav";

// 開いたときの場所は URL の ?tab=&view= で指定できる(オフィスのボード・ツリーを、URL だけで撮れるように)。
describe("initialNav", () => {
  it("指定が無ければ、対応タブのオフィス", () => {
    expect(initialNav("")).toEqual({ tab: "inbox", view: "floor" });
  });

  it("tab と view を読む", () => {
    expect(initialNav("?tab=office&view=tree")).toEqual({ tab: "office", view: "tree" });
    expect(initialNav("?view=board")).toEqual({ tab: "inbox", view: "board" });
  });

  it("知らない値は既定にする", () => {
    expect(initialNav("?tab=x&view=y")).toEqual({ tab: "inbox", view: "floor" });
  });
});
