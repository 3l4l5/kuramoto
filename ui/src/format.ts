export const usd = (v: number | null | undefined) => (v == null ? "—" : `$${v < 10 ? v.toFixed(2) : Math.round(v)}`);
export const kfmt = (v: number | null | undefined) => (v == null ? "—" : v >= 1000 ? `${Math.round(v / 1000)}k` : String(Math.round(v)));
export const pct = (v: number | null | undefined) => (v == null ? "—" : `${Math.round(v * 100)}%`);
export const hhmm = (iso: string) => new Date(iso).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" });

/** 判断の期限までの残り。 */
export function timeLeft(iso: string | null, now: number): string {
  if (!iso) return "";
  const ms = new Date(iso).getTime() - now;
  if (ms <= 0) return "まもなく推奨に決定";
  const m = Math.ceil(ms / 60000);
  return `あと ${m >= 60 ? `${Math.floor(m / 60)} 時間 ${m % 60} 分` : `${m} 分`}で推奨に決定`;
}

export const STAGE_NAME: Record<string, string> = { req: "要件", flow: "ユーザーフロー", screen: "画面デザイン", infra: "インフラ", model: "アーキテクチャとデータ" };

const nums = (ns: number[]) => `#${ns.join("・#")}`;

/** 待っているチケットの説明。merge 待ちの棚にあるものは「merge 待ち」、まだ作業中のものは「完了待ち」と分ける。 */
export function waitText(waitFor: number[], waitMerge: number[]): string {
  const working = waitFor.filter((n) => !waitMerge.includes(n));
  return [waitMerge.length ? `${nums(waitMerge)} の merge 待ち` : "", working.length ? `${nums(working)} の完了待ち` : ""].filter(Boolean).join("・");
}

/** merge 待ちのチケットを merge すると動き出すもの。止めているものが無ければ null。 */
export function unblockText(u: { now: number[]; later: number[] } | null): string | null {
  if (!u) return null;
  const now = u.now.length ? `${nums(u.now)} が着手できます` : "";
  const later = u.later.length ? `${u.now.length ? "その先の" : ""}${nums(u.later)} も順に動き出します` : "";
  return [now, later].filter(Boolean).join("。");
}

/** merge 待ちで止まっていることの見出し。 */
export function stalledText(number: number, u: { now: number[]; later: number[] } | null): string | null {
  if (!u) return null;
  const all = [...u.now, ...u.later].sort((a, b) => a - b);
  return `#${number} の merge 待ちで ${nums(all)} が止まっています`;
}
