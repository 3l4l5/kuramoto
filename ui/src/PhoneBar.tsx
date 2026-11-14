import { useState } from "react";
import { go, useProject } from "./hooks";
import { setPhoneNav, usePhoneNav } from "./phoneNav";
import type { Drawer } from "./Team";

/**
 * スマホ(幅 700px 以下)の下のタブ「対応 / オフィス / リーダー / メニュー」と、メニューのシート。
 * パソコンの幅では CSS で隠す(上の共通ヘッダーが同じ行き先を持つ)。メニューからは、本部・企画スタジオ・ボード・ツリー・
 * 編成・チームの方針・生産性・設定の全部に行ける(未決 #21)。
 */
export function PhoneBar({ id, drawer, moveTo }: { id: number; drawer: Drawer | null; moveTo: (d: Drawer | null) => void }) {
  const { tab } = usePhoneNav();
  const [menu, setMenu] = useState(false);
  const { data } = useProject(id);
  const waiting = data ? data.decisions.length + (data.autoMerge ? 0 : data.mergeOrder.length) : 0;
  const onProject = location.hash === `#/p/${id}`;
  const show = (t: "inbox" | "office", view?: "floor" | "board" | "tree") => {
    setPhoneNav({ tab: t, ...(view ? { view } : {}) });
    moveTo(null);
    setMenu(false);
    go(`#/p/${id}`);
  };
  const to = (hash: string) => {
    moveTo(null);
    setMenu(false);
    go(hash);
  };
  // 引き出しはオフィスの画面にだけ描かれる。企画スタジオ・生産性・設定から開くときは、オフィスへ移ってから開く(移らないと、開いたことになっても何も見えない)
  const drawerTo = (d: Drawer | null) => {
    setMenu(false);
    moveTo(d);
    if (d && !onProject) go(`#/p/${id}`);
  };
  const cur = menu ? "menu" : drawer === "lead" ? "lead" : onProject && !drawer ? tab : null;
  const items: [string, string, string][] = [
    ["inbox", "☑", "対応"],
    ["office", "◎", "オフィス"],
    ["lead", "✉", "リーダー"],
    ["menu", "≡", "メニュー"],
  ];
  return (
    <>
      <nav className="phonebar" aria-label="スマホの下のタブ">
        {items.map(([k, icon, label]) => (
          <button
            key={k}
            type="button"
            aria-current={cur === k ? "page" : undefined}
            onClick={() => {
              if (k === "inbox" || k === "office") show(k);
              else if (k === "lead") {
                drawerTo(drawer === "lead" ? null : "lead");
              } else setMenu(!menu);
            }}
          >
            <span aria-hidden="true">{icon}</span>
            {label}
            {k === "inbox" && waiting > 0 && <i className="phonebar__n">{waiting}</i>}
          </button>
        ))}
      </nav>
      {menu && (
        <div className="phonemenu" role="dialog" aria-label="メニュー">
          <button type="button" className="phonemenu__scrim" aria-label="メニューを閉じる" onClick={() => setMenu(false)} />
          <ul className="phonemenu__sheet">
            <li><button type="button" onClick={() => to("#/")}>本部</button></li>
            <li><button type="button" onClick={() => to(`#/p/${id}/studio`)}>企画スタジオ</button></li>
            <li><button type="button" onClick={() => show("office", "board")}>ボード</button></li>
            <li><button type="button" onClick={() => show("office", "tree")}>ツリー</button></li>
            <li><button type="button" onClick={() => drawerTo("formation")}>編成</button></li>
            <li><button type="button" onClick={() => drawerTo("policy")}>チームの方針</button></li>
            <li><button type="button" onClick={() => to(`#/p/${id}/metrics`)}>生産性</button></li>
            <li><button type="button" onClick={() => to(`#/p/${id}/settings`)}>設定</button></li>
          </ul>
        </div>
      )}
    </>
  );
}
