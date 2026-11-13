import { useSyncExternalStore } from "react";

/**
 * スマホ(幅 700px 以下)の見ている場所。同じ画面を CSS のメディアクエリで組み替えるので、
 * どの部分を見せるかはここで持ち、CSS が data 属性を見て出し分ける(未決 #21)。
 * - tab: 下のタブ。対応 = あなたの対応(判断カード・merge)/ オフィス = 路線図・ボード・ツリー
 * - view: オフィスの中の見方(オフィス / ボード / ツリー)。パソコンの幅でも同じ値を使う
 * チケットの画面から「← ボードに戻る」で戻ったとき、見ていたものに戻れるよう、画面の外で持つ。
 */
export type PhoneTab = "inbox" | "office";
export type OfficeView = "floor" | "board" | "tree";

/**
 * 開いたときの見ている場所。URL の ?tab=office&view=tree で指定できる(撮影・共有用。ハッシュの前に付ける)。
 * 知らない値は無視して、既定(対応・オフィス)にする。
 */
export function initialNav(search: string): { tab: PhoneTab; view: OfficeView } {
  const q = new URLSearchParams(search);
  const tab = q.get("tab");
  const view = q.get("view");
  return { tab: tab === "office" ? "office" : "inbox", view: view === "board" || view === "tree" ? view : "floor" };
}

let state = initialNav(typeof location === "undefined" ? "" : location.search);
const listeners = new Set<() => void>();

export function setPhoneNav(next: Partial<typeof state>) {
  state = { ...state, ...next };
  for (const l of listeners) l();
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export const usePhoneNav = () => useSyncExternalStore(subscribe, () => state);

/**
 * 開いたときの引き出し。URL の ?drawer=formation|policy|lead と、その中のタブ ?dtab=(編成: islands|routes|flows / 方針: models|rules)で指定できる
 * (撮影・共有用)。知らない値は無視して、閉じた状態にする。
 */
export function initialDrawer(search: string): { drawer: "formation" | "policy" | "lead" | null; tab: string | null } {
  const q = new URLSearchParams(search);
  const d = q.get("drawer");
  return { drawer: d === "formation" || d === "policy" || d === "lead" ? d : null, tab: q.get("dtab") };
}

export const drawerFromUrl = () => initialDrawer(typeof location === "undefined" ? "" : location.search);
