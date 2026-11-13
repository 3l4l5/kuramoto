import { useSyncExternalStore } from "react";

/**
 * 編成の引き出しとオフィスの床をつなぐ小さな共有の状態。
 * - draftRoutes: 連絡経路タブを開いている間の「保存前の案」(端は島の名前か lead / architect)。床がこれを点線で重ねる(R16)。
 * - 床の凡例の「経路を変える」「流れを変える」は、編成の引き出しを開きたいタブを頼む(seq が増えたら App が引き出しを開く)。
 */
export type FormationTab = "islands" | "routes" | "flows";
export type DraftRoute = { a: string; b: string };
type State = { draftRoutes: DraftRoute[] | null; request: { tab: FormationTab; seq: number } };

let state: State = { draftRoutes: null, request: { tab: "islands", seq: 0 } };
let pending: FormationTab | null = null;
const listeners = new Set<() => void>();
const set = (next: State) => {
  state = next;
  for (const l of listeners) l();
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};

export const useFormationUi = () => useSyncExternalStore(subscribe, () => state);

export function setDraftRoutes(routes: DraftRoute[] | null) {
  const same = JSON.stringify(state.draftRoutes) === JSON.stringify(routes);
  if (!same) set({ ...state, draftRoutes: routes });
}

/** 編成の引き出しを、このタブで開いてほしい。 */
export function requestFormationTab(tab: FormationTab) {
  pending = tab;
  set({ ...state, request: { tab, seq: state.request.seq + 1 } });
}

/** 引き出しが開くときに、頼まれたタブがあれば受け取る(1 回だけ)。 */
export function takeRequestedTab(): FormationTab | null {
  const t = pending;
  pending = null;
  return t;
}

/** 頼んだタブを取り下げる(開発ルールの下書きの確認で「このまま直す」を選んだときなど、引き出しが開かなかったとき)。 */
export function clearRequestedTab() {
  pending = null;
}
