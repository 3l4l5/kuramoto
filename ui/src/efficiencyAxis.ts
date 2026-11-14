/**
 * フロー効率の推移の横軸。日の並びではなく、時刻(ms)を連続した軸にして、最初の記録から最後の記録までを時刻で比例して割り付ける。
 * 編成の版が上がった印は、その版が作られた時刻の位置に置く。同じ日に何度変えても、時刻に応じて別の位置に出る。
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** 軸の範囲。時刻が無ければ null。 */
export function axisRange(times: number[]): { min: number; max: number } | null {
  if (times.length === 0) return null;
  return { min: Math.min(...times), max: Math.max(...times) };
}

/** 時刻 t の横の位置(左端 left〜右端 right)。範囲が 1 点(長さ 0)のときは真ん中。 */
export function axisX(t: number, range: { min: number; max: number }, left: number, right: number): number {
  const span = range.max - range.min;
  if (span <= 0) return (left + right) / 2;
  return left + ((t - range.min) / span) * (right - left);
}

const two = (n: number) => String(n).padStart(2, "0");

/** 札や詳細に出す時刻(ローカル)。例: 11/14 15:30 */
export function stamp(t: number): string {
  const d = new Date(t);
  return `${two(d.getMonth() + 1)}/${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
}

/** 軸の端のラベル。期間が 2 日以内と短いときは時刻まで(11/14 15:30)、それより長いときは日だけ(11/14)。 */
export function axisLabel(t: number, range: { min: number; max: number }): string {
  const s = stamp(t);
  return range.max - range.min <= 2 * DAY_MS ? s : s.slice(0, 5);
}

/** 推移の図に並べる時刻(効率の記録の時刻と、編成の版が上がった時刻)。 */
export function trendTimes(rows: { at: string }[], marks: { at: string }[]): number[] {
  return [...rows, ...marks].map((r) => Date.parse(r.at)).filter((t) => Number.isFinite(t));
}
