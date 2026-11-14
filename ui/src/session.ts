import { api, markSignedOut } from "./api";

/**
 * セッションを止める API を呼ぶのは、ここだけ(ADR-0061)。画面のボタンはここの関数を呼ぶ。
 * 資格情報の持ち方が変わっても(チケット 106)、直すのはここ(と api.ts)だけで済むようにしてある。
 * どちらも成功すると、このブラウザのセッションも止まっているので、「ログアウトした」状態にする(画面の上に案内が出る)。
 */

/** このブラウザのセッションだけを失効させ、Cookie を消す。 */
export async function logout(): Promise<void> {
  await api("DELETE", "/session");
  markSignedOut();
}

/** すべてのセッション(このブラウザも含む)を失効させる。止めた数を返す。 */
export async function revokeAllSessions(): Promise<number> {
  const r = await api<{ revoked: number }>("POST", "/session/revoke-all", {});
  markSignedOut();
  return r.revoked;
}
