import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// パソコンのオフィスは、メンバーを島の箱の上下に立たせる(試作 office)。席は箱の外へ出る(position: absolute)ので、
// 箱の幅が 1 段の人数に合っていないと、人数の多い島(最大 10 人 = 1 段 5 人)で席が隣の島に重なる(#78・#91 の「重ならない」)。
// ブラウザの描画は e2e で見るので、ここでは「幅を人数から決める仕組み」が切れていないことをソースで確かめる。
const ui = new URL("../ui/src/", import.meta.url).pathname;
const css = readFileSync(`${ui}style.css`, "utf8");
const office = readFileSync(`${ui}Office.tsx`, "utf8");

describe("パソコンのオフィス: 島の箱の幅は 1 段の人数に合わせる", () => {
  it("Island は 1 段の人数を --per-row で渡す(上の段 = 席の半分、切り上げ)", () => {
    expect(office).toContain("const top = seats.slice(0, Math.ceil(u.max / 2));");
    expect(office).toMatch(/"--per-row": top\.length/);
  });

  it("パソコン幅の島の箱は、160px を下限に --per-row × 84px(席 76px + すき間)まで広がる。固定の 160px にしない", () => {
    const desktop = css.slice(css.indexOf("チケット 109"));
    expect(desktop).toMatch(/\.of-st > \.of-island \{[^}]*flex: 0 0 max\(160px, calc\(var\(--per-row, 2\) \* 84px\)\)/);
    expect(desktop).not.toMatch(/\.of-st > \.of-island \{[^}]*flex: 0 0 160px/);
  });

  it("席の幅(76px)に対して 84px の刻みで足りる", () => {
    expect(css).toMatch(/\.officefloor \.of-seat \{ width: 76px; \}/);
  });
});

// チケット 113: アーキテクトは受け口の下に立つメンバー、凡例は床の左下に重ねる(パソコンだけ。スマホは変えない)
describe("パソコンのオフィス: アーキテクトと凡例(#113)", () => {
  const desktop = css.slice(css.indexOf("---- チケット 113"));
  it("チケット 113 のブロックは、701px 以上だけに効く(スマホの机・凡例の行は今のまま)", () => {
    expect(desktop).toMatch(/^[^@]*@media \(min-width: 701px\) \{/);
    expect(desktop.trimEnd().endsWith("}")).toBe(true);
  });

  it("アーキテクトの机は、パソコンでは枠を持たず、受け口と同じ幅 160px。DOM(data-loc=\"arch\"・机の名前)は残す", () => {
    expect(desktop).toMatch(/\.of-side > \.of-desk\[data-loc="arch"\] \{[^}]*flex: 0 0 160px;[^}]*border: 0;/);
    expect(office).toContain('loc="arch"');
    expect(office).toContain("aria-label={`${role}の机`}");
  });

  it("床の下の行を島の下の段まで引き上げて、受け口の真下に置く", () => {
    expect(desktop).toMatch(/\.of-side \{ margin-top: calc\(var\(--sp-2\) - var\(--of-below\)\)/);
    expect(css).toMatch(/\.of-islands \{[^}]*padding: 152px 0 var\(--of-below\)/);
  });

  it("凡例は床の左下に重ね、引き出しが開いているときは、その手前(400px + 余白)で止める", () => {
    expect(desktop).toMatch(/\.of-legend \{ position: absolute; left: var\(--sp-4\); bottom: var\(--sp-4\)/);
    expect(desktop).toMatch(/:has\(\.of-drawer\) \.of-legend \{ max-width: calc\(100% - 400px - var\(--sp-4\) \* 3\)/);
  });
});
