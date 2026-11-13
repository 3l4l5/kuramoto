import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { initialDrawer } from "../ui/src/phoneNav";

// 編成・チームの方針の引き出しは、URL の ?drawer=&dtab= で開いた状態にできる(撮影・共有用)。
describe("initialDrawer", () => {
  it("指定が無ければ閉じている", () => {
    expect(initialDrawer("")).toEqual({ drawer: null, tab: null });
  });

  it("drawer と dtab を読む", () => {
    expect(initialDrawer("?drawer=formation&dtab=routes")).toEqual({ drawer: "formation", tab: "routes" });
    expect(initialDrawer("?drawer=policy&dtab=rules")).toEqual({ drawer: "policy", tab: "rules" });
    expect(initialDrawer("?drawer=lead")).toEqual({ drawer: "lead", tab: null });
  });

  it("知らない引き出しは閉じたままにする", () => {
    expect(initialDrawer("?drawer=x&dtab=y")).toEqual({ drawer: null, tab: "y" });
  });
});

// スマホで引き出しが全画面になるのは CSS の出し分け。チームの方針は部品(ds/Drawer)の section がそのまま引き出しなので、
// aside だけに書くと全画面にならず、受信箱の下に流れて出る(描画して見つかった崩れ)。
describe("スマホの引き出し(style.css)", () => {
  const css = readFileSync(new URL("../ui/src/style.css", import.meta.url), "utf8");
  const phone = css.slice(css.indexOf("引き出し(編成・チームの方針)は全画面"));

  it("aside と section の両方を全画面にし、下のタブの上までにする", () => {
    expect(phone).toMatch(/aside\.drawer, section\.drawer \{ position: fixed; inset: 0 0 calc\(57px/);
  });

  it("オフィスの種類の切り替えは、狭くても折り返して全部見せる", () => {
    expect(phone).toMatch(/\.officefloor \.of-filter \.ds-seg \{[^}]*flex-wrap: wrap/);
  });

  it("対応タブの件数の札は、リーダー側の色(--lead)にする(試作どおり。企画の --design ではない)", () => {
    expect(css).toMatch(/\.phonebar__n \{[^}]*background: var\(--lead\)/);
  });
});
