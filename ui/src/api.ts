import type { DbStatusView, DevRulesView, HqView, LeadChatView, MemberChatView, MemberNow, MemberView, OfficeView, ProductivityView, ProjectView, StudioView, TeamView, TicketView, UnitView } from "../../src/server.js";

export type { DbStatusView, DevRulesView, HqView, LeadChatView, MemberChatView, MemberNow, MemberView, OfficeView, ProductivityView, ProjectView, StudioView, TeamView, TicketView, UnitView };

let build: string | null = null;

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
  const json = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(json.error ?? res.statusText);
  return json;
}

export const del = <T = unknown>(path: string) => api<T>("DELETE", path);
export const post = <T = unknown>(path: string, body?: unknown) => api<T>("POST", path, body ?? {});
