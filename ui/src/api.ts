import type { DbStatusView, DevRulesView, HqView, LeadChatView, MemberChatView, MemberNow, MemberView, OfficeView, PeriodicReviewsView, ProductivityView, ProjectView, StudioView, TeamView, TicketView, UnitView } from "../../src/server.js";

export type { DbStatusView, DevRulesView, HqView, LeadChatView, MemberChatView, MemberNow, MemberView, OfficeView, PeriodicReviewsView, ProductivityView, ProjectView, StudioView, TeamView, TicketView, UnitView };

let build: string | null = null;

/**
 * 合言葉・セッションの状態(ADR-0059・ADR-0061)。
 * - unauthorized: 合言葉が通らなかった(401)。Cookie の期限切れ・失効・合言葉の作り直しのとき、画面の上に案内を出すために覚える。通るようになったら ok に戻る
 * - signed-out: この画面から「ログアウト」「すべてのセッションを失効」を押した。Cookie は消えているので、合言葉つきの URL を開き直す(画面を読み込み直す)まで戻さない
 * 画面そのものは合言葉つきの URL で開くので、ふつうは ok のまま。Vite の開発サーバー経由などで開いたときは unauthorized が出る。
 */
export type AuthState = "ok" | "unauthorized" | "signed-out";
let authState: AuthState = "ok";
const listeners = new Set<() => void>();
const setAuthState = (v: AuthState) => {
  if (authState === v || authState === "signed-out") return;
  authState = v;
  listeners.forEach((f) => f());
};
export const subscribeAuth = (f: () => void) => {
  listeners.add(f);
  return () => void listeners.delete(f);
};
export const getAuthState = () => authState;
/** セッションを失効させたあと(ログアウト・すべて失効)に呼ぶ。session.ts だけが使う。 */
export const markSignedOut = () => {
  if (authState === "signed-out") return;
  authState = "signed-out";
  listeners.forEach((f) => f());
};

/** ローカルサーバーの API を呼ぶ。書き込みには独自のヘッダーを付ける(他のサイトからの書き込みを防ぐ)。 */
export async function api<T = unknown>(method: "GET" | "POST" | "DELETE", path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    headers: method === "GET" ? {} : { "content-type": "application/json", "x-kuramoto": "1" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  // サーバーが起動し直されたら、画面のファイルも変わったかもしれないので読み込み直す
  const b = res.headers.get("x-kuramoto-build");
  if (b && build && b !== build) {
    location.reload();
    return new Promise<T>(() => {});
  }
  if (b) build = b;
  setAuthState(res.status === 401 ? "unauthorized" : "ok");
  const json = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(json.error ?? res.statusText);
  return json;
}

export const del = <T = unknown>(path: string) => api<T>("DELETE", path);
export const post = <T = unknown>(path: string, body?: unknown) => api<T>("POST", path, body ?? {});
