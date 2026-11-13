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

let state: { tab: PhoneTab; view: OfficeView } = { tab: "inbox", view: "floor" };
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
