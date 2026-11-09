import type { StudioView } from "../api";

// 図は書いた大きさ(W)より大きく引き伸ばさない。箱が少ないときに巨大にならないようにする。

type Flow = NonNullable<StudioView["flow"]>;
type Domain = NonNullable<StudioView["domain"]>;
type Infra = NonNullable<StudioView["infra"]>;

// ---- ユーザーフロー: 箱は col・row の格子に置く ----

const NW = 150, NH = 54, CX = 250, CY = 130, OX = 20, OY = 36;

export function FlowSvg({ flow, selected, onSelect }: { flow: Flow; selected: string | null; onSelect: (id: string) => void }) {
  const pos = new Map(flow.nodes.map((n) => [n.id, { x: OX + n.col * CX, y: OY + n.row * CY, n }]));
  const W = Math.max(...flow.nodes.map((n) => n.col)) * CX + OX * 2 + NW;
  const H = Math.max(...flow.nodes.map((n) => n.row)) * CY + OY * 2 + NH;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ maxWidth: W, minWidth: Math.min(W, 760) }} role="img" aria-label="ユーザーフローの図">
      <defs>
        <marker id="fa" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
          <path d="M0 0L10 5L0 10z" fill="var(--muted)" />
        </marker>
        <marker id="fa2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
          <path d="M0 0L10 5L0 10z" fill="var(--warn)" />
        </marker>
      </defs>
      {flow.edges.map((e, i) => {
        const a = pos.get(e.from), b = pos.get(e.to);
        if (!a || !b) return null;
        let x1: number, y1: number, x2: number, y2: number;
        if (b.x > a.x) [x1, y1, x2, y2] = [a.x + NW, a.y + NH / 2, b.x, b.y + NH / 2];
        else if (b.x < a.x) [x1, y1, x2, y2] = [a.x, a.y + NH / 2, b.x + NW, b.y + NH / 2];
        else if (b.y > a.y) [x1, y1, x2, y2] = [a.x + NW / 2, a.y + NH, b.x + NW / 2, b.y];
        else if (b.y < a.y) [x1, y1, x2, y2] = [a.x + NW / 2, a.y, b.x + NW / 2, b.y + NH];
        else [x1, y1, x2, y2] = [a.x + NW, a.y + 12, a.x + NW, a.y + NH - 12];
        // 隣り合う箱どうしはまっすぐ、離れた箱や斜めは曲げて、箱と重ならないようにする
        const straight = (a.n.row === b.n.row && Math.abs(a.n.col - b.n.col) === 1) || (a.n.col === b.n.col && Math.abs(a.n.row - b.n.row) === 1);
        const bend = straight ? 0 : a.n.row === b.n.row ? -50 : 24;
        const cx = (x1 + x2) / 2 + (x1 === x2 && !straight ? 50 : 0), cy = (y1 + y2) / 2 + bend;
        const lx = x1 === x2 ? cx + 8 : cx, ly = x1 === x2 ? cy + 4 : straight ? cy - 8 : cy - 6;
        return (
          <g key={i}>
            <path className={`fedge${e.alt ? " alt" : ""}`} d={`M${x1} ${y1} Q${cx} ${cy} ${x2} ${y2}`} markerEnd={`url(#fa${e.alt ? "2" : ""})`} />
            {e.label && (
              <text className="flabel" textAnchor={x1 === x2 ? "start" : "middle"} x={lx} y={ly}>
                {e.label}
              </text>
            )}
          </g>
        );
      })}
      {flow.nodes.map((n) => {
        const p = pos.get(n.id)!;
        const cls = `fnode${selected === n.id ? " sel" : ""}${n.kind === "question" ? " q" : ""}${n.kind === "error" ? " err" : ""}`;
        return (
          <g key={n.id} className={cls} tabIndex={0} role="button" aria-label={n.label} onClick={() => onSelect(n.id)} onKeyDown={(e) => e.key === "Enter" && onSelect(n.id)}>
            <rect x={p.x} y={p.y} width={NW} height={NH} rx={10} />
            <text x={p.x + 12} y={p.y + 24} fontWeight={700}>
              {n.label}
            </text>
            <text className="sub" x={p.x + 12} y={p.y + 42}>
              {n.sub ?? ""}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

// ---- ドメインモデル: 1 段に 3 つずつ並べる ----

export function ModelSvg({ domain }: { domain: Domain }) {
  if (!domain.entities.length) return null;
  const BW = 190, gapX = 70, gapY = 50, perRow = 3;
  const rowsH = (e: Domain["entities"][number]) => 34 + e.fields.length * 18;
  const pos = new Map<string, { x: number; y: number; h: number; e: Domain["entities"][number] }>();
  let y = 20;
  for (let i = 0; i < domain.entities.length; i += perRow) {
    const row = domain.entities.slice(i, i + perRow);
    const h = Math.max(...row.map(rowsH));
    row.forEach((e, j) => pos.set(e.name, { x: 20 + j * (BW + gapX), y, h: rowsH(e), e }));
    y += h + gapY;
  }
  const W = 20 + Math.min(perRow, domain.entities.length) * (BW + gapX);
  return (
    <div className="flowwrap">
      <svg viewBox={`0 0 ${W} ${y}`} style={{ maxWidth: W, minWidth: Math.min(W, 760) }} role="img" aria-label="ドメインモデルの図">
        {domain.relations.map((r, i) => {
          const a = pos.get(r.from), b = pos.get(r.to);
          if (!a || !b) return null;
          const x1 = a.x + BW / 2, y1 = a.y + a.h / 2, x2 = b.x + BW / 2, y2 = b.y + b.h / 2;
          return (
            <g key={i}>
              <path d={`M${x1} ${y1} L${x2} ${y2}`} stroke="var(--muted)" strokeWidth={1.5} />
              <text x={(x1 + x2) / 2 + 4} y={(y1 + y2) / 2 - 6} fill="var(--muted)" fontSize={11}>
                {r.label}
              </text>
            </g>
          );
        })}
        {[...pos.values()].map((p) => (
          <g key={p.e.name}>
            <rect x={p.x} y={p.y} width={BW} height={p.h} rx={10} fill="var(--surface)" stroke={p.e.isNew ? "var(--dev)" : "var(--table-edge)"} strokeWidth={1.5} />
            <text x={p.x + 12} y={p.y + 22} fontWeight={700} fill="var(--ink)" fontSize={13}>
              {p.e.name}{"  "}
              <tspan fill={p.e.isNew ? "var(--dev)" : "var(--muted)"} fontSize={10.5}>
                {p.e.isNew ? "新規" : "既存"}
              </tspan>
            </text>
            {p.e.fields.map((f, i) => (
              <text key={i} x={p.x + 12} y={p.y + 44 + i * 18} fill="var(--muted)" fontSize={11} fontFamily="IBM Plex Mono, monospace">
                {f}
              </text>
            ))}
          </g>
        ))}
      </svg>
    </div>
  );
}

// ---- インフラの構成図: 1 段に 4 つずつ並べる。実線は新しく用意するもの、点線は既存 ----

const KIND_COLOR: Record<string, string> = { web: "var(--dev)", api: "var(--dev)", db: "var(--review)", storage: "var(--review)", auth: "var(--lead)", queue: "var(--warn)", cdn: "var(--ok)" };

export function InfraSvg({ infra }: { infra: Infra }) {
  if (!infra.components.length) return null;
  const BW = 170, BH = 58, GX = 60, GY = 46, per = 4;
  const pos = new Map(infra.components.map((c, i) => [c.name, { x: 20 + (i % per) * (BW + GX), y: 56 + Math.floor(i / per) * (BH + GY + 30), c }]));
  const W = 20 + Math.min(per, infra.components.length) * (BW + GX);
  const H = 56 + Math.ceil(infra.components.length / per) * (BH + GY + 30);
  return (
    <>
      <div className="flowwrap">
        <svg viewBox={`0 0 ${W} ${H}`} style={{ maxWidth: W, minWidth: Math.min(W, 760) }} role="img" aria-label="インフラの構成図">
          <defs>
            <marker id="ia" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
              <path d="M0 0L10 5L0 10z" fill="var(--muted)" />
            </marker>
          </defs>
          {infra.links.map((l, i) => {
            const a = pos.get(l.from), b = pos.get(l.to);
            if (!a || !b) return null;
            const x1 = a.x + BW / 2, y1 = a.y + BH / 2, x2 = b.x + BW / 2, y2 = b.y + BH / 2;
            const dx = x2 - x1, dy = y2 - y1;
            // 同じ段で間に箱を挟むときは、上に弧を描いて箱の下をくぐらないようにする
            if (dy === 0 && Math.abs(dx) > BW + GX) {
              const sx = x1 + (Math.sign(dx) * BW) / 4, ex = x2 - (Math.sign(dx) * BW) / 4, top = a.y - 4, cy = a.y - 34;
              return (
                <g key={i}>
                  <path className="fedge" d={`M${sx} ${top} Q${(sx + ex) / 2} ${cy - 20} ${ex} ${top}`} markerEnd="url(#ia)" />
                  <text className="flabel" textAnchor="middle" x={(sx + ex) / 2} y={cy - 8}>
                    {l.label}
                  </text>
                </g>
              );
            }
            const k = Math.min(Math.abs(dx) ? (BW / 2 + 4) / Math.abs(dx) : 1, Math.abs(dy) ? (BH / 2 + 4) / Math.abs(dy) : 1);
            return (
              <g key={i}>
                <path className="fedge" d={`M${x1 + dx * k} ${y1 + dy * k} L${x2 - dx * k} ${y2 - dy * k}`} markerEnd="url(#ia)" />
                <text className="flabel" textAnchor="middle" x={(x1 + x2) / 2} y={(y1 + y2) / 2 - 6}>
                  {l.label}
                </text>
              </g>
            );
          })}
          {[...pos.values()].map((p) => (
            <g key={p.c.name}>
              <rect
                x={p.x}
                y={p.y}
                width={BW}
                height={BH}
                rx={10}
                fill="var(--surface)"
                stroke={KIND_COLOR[p.c.kind] ?? "var(--table-edge)"}
                strokeWidth={1.5}
                strokeDasharray={p.c.isNew ? undefined : "4 3"}
              />
              <text x={p.x + 12} y={p.y + 24} fontWeight={700} fill="var(--ink)" fontSize={13}>
                {p.c.name}
              </text>
              <text x={p.x + 12} y={p.y + 42} fill="var(--muted)" fontSize={11}>
                {p.c.service}
              </text>
            </g>
          ))}
        </svg>
      </div>
      <div style={{ fontSize: 12, color: "var(--muted)", marginTop: -8 }}>実線の枠は新しく用意するもの、点線の枠は既にあるものを使います。</div>
    </>
  );
}
