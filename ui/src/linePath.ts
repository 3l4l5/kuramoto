/** 折り返すとき、1 本下の線までの間(試作どおり、折り返しは半円で結ぶ)。 */
export const LEG_GAP = 30;

/**
 * 路線の通り道。止まる駅を順に結び、あとの駅が左にあるときは半円で折り返す(折り返しは 1 本下の線に移る)。
 * 折り返す駅の丸は、半円の頂点に置く。
 * 例: バグ修正(QA → 開発 → レビュー)は、受け口から QA へ進み、開発へ戻り、レビュー・merge 待ちへ進む。
 * stops は丸を置く位置(駅ごと)、turns は折り返しの半円の中心(ラベルを置く場所)。
 */
export function linePath(xs: number[], y0: number): { d: string; ys: number[]; stops: { x: number; y: number }[]; turns: { x1: number; x2: number; y: number }[] } {
  const r = LEG_GAP / 2;
  const stops = [{ x: xs[0]!, y: y0 }];
  const turns: { x1: number; x2: number; y: number }[] = [];
  let d = `M ${xs[0]} ${y0}`;
  let y = y0;
  let dir = 0;
  for (let i = 1; i < xs.length; i++) {
    const step = Math.sign(xs[i]! - xs[i - 1]!) || dir || 1;
    if (dir !== 0 && step !== dir) {
      d += ` A ${r} ${r} 0 0 ${dir > 0 ? 1 : 0} ${xs[i - 1]} ${y + LEG_GAP}`;
      stops[i - 1] = { x: xs[i - 1]! + dir * r, y: y + r };
      turns.push({ x1: xs[i - 1]!, x2: xs[i]!, y: y + r });
      y += LEG_GAP;
    }
    dir = step;
    d += ` L ${xs[i]} ${y}`;
    stops.push({ x: xs[i]!, y });
  }
  return { d, ys: stops.map((p) => p.y), stops, turns };
}

