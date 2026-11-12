import dagre from "@dagrejs/dagre";
import { useState, type ReactNode } from "react";
import type { StudioView } from "../api";

/**
 * 企画スタジオの図(ユーザーフロー・ドメインモデル・インフラ)。
 * - 箱の並びは、つながりから自動で決める(dagre の層に並べる配置)。線の交差と、線が箱をくぐるのを減らす
 * - 箱の大きさは中身の文字に合わせ、長い文は折り返す(全文は箱に乗せると出る)
 * - 矢印の言葉にも場所を空けて置き、縁取りで線の上でも読めるようにする
 * - 行きと戻りの矢印は、別々の線にする
 * 図は書いた大きさのまま出し、入りきらなければ横に動かして見る(縮めて文字が読めなくならないように)。
 */

type Flow = NonNullable<StudioView["flow"]>;
type Domain = NonNullable<StudioView["domain"]>;
type Infra = NonNullable<StudioView["infra"]>;

// ---- 文字の幅と折り返し(和文は 1 文字ほぼ 1em、英数字は 0.6em とみなす) ----

function textWidth(s: string, size: number): number {
  let w = 0;
  for (const ch of s) w += ch.charCodeAt(0) > 0x2e80 ? size : ch === " " ? size * 0.3 : size * 0.6;
  return w;
}

/** max 幅で折り返す。lines 行を超えたら最後を「…」にする。 */
function wrap(s: string, size: number, max: number, lines: number): string[] {
  const out: string[] = [];
  let cur = "";
  for (const ch of s) {
    if (textWidth(cur + ch, size) > max && cur) {
      out.push(cur);
      cur = "";
      if (out.length === lines) break;
    }
    cur += ch;
  }
  if (out.length < lines && cur) out.push(cur);
  const used = out.join("").length;
  if (used < [...s].length && out.length) {
    let last = out[out.length - 1]!;
    while (last && textWidth(`${last}…`, size) > max) last = last.slice(0, -1);
    out[out.length - 1] = `${last}…`;
  }
  return out;
}

// ---- 配置 ----

type Box = { id: string; w: number; h: number };
type Link = { key: string; from: string; to: string; labelLines: string[]; full?: string; weight?: number };
type Placed = { nodes: Map<string, { x: number; y: number }>; edges: Map<string, { points: { x: number; y: number }[]; lx: number; ly: number }>; W: number; H: number };

const LABEL = 11;

function layout(boxes: Box[], links: Link[], opts: { dir: "LR" | "TB"; nodesep?: number; ranksep?: number }): Placed {
  const g = new dagre.graphlib.Graph({ multigraph: true });
  g.setGraph({ rankdir: opts.dir, nodesep: opts.nodesep ?? 36, ranksep: opts.ranksep ?? 80, edgesep: 24, marginx: 20, marginy: 20 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const b of boxes) g.setNode(b.id, { width: b.w, height: b.h });
  for (const l of links) {
    if (!g.hasNode(l.from) || !g.hasNode(l.to)) continue;
    const w = Math.max(0, ...l.labelLines.map((t) => textWidth(t, LABEL))) + (l.labelLines.length ? 10 : 0);
    g.setEdge(l.from, l.to, { width: w, height: l.labelLines.length * (LABEL + 3), labelpos: "c", weight: l.weight ?? 1 }, l.key);
  }
  dagre.layout(g);
  const nodes = new Map<string, { x: number; y: number }>();
  for (const b of boxes) {
    const n = g.node(b.id) as { x: number; y: number } | undefined;
    if (n) nodes.set(b.id, { x: n.x - b.w / 2, y: n.y - b.h / 2 });
  }
  const edges = new Map<string, { points: { x: number; y: number }[]; lx: number; ly: number }>();
  for (const e of g.edges()) {
    const d = g.edge(e) as { points: { x: number; y: number }[]; x?: number; y?: number };
    edges.set(e.name!, { points: d.points, lx: d.x ?? d.points[Math.floor(d.points.length / 2)]!.x, ly: d.y ?? d.points[Math.floor(d.points.length / 2)]!.y });
  }
  const gl = g.graph() as { width?: number; height?: number };
  return { nodes, edges, W: Math.ceil(gl.width ?? 400), H: Math.ceil(gl.height ?? 200) };
}

/** 折れ点を通る、角の丸い線。 */
function smooth(pts: { x: number; y: number }[]): string {
  if (pts.length < 3) return `M${pts.map((p) => `${p.x} ${p.y}`).join(" L")}`;
  let d = `M${pts[0]!.x} ${pts[0]!.y}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const m = { x: (pts[i]!.x + pts[i + 1]!.x) / 2, y: (pts[i]!.y + pts[i + 1]!.y) / 2 };
    d += ` Q${pts[i]!.x} ${pts[i]!.y} ${i === pts.length - 2 ? `${pts[i + 1]!.x} ${pts[i + 1]!.y}` : `${m.x} ${m.y}`}`;
  }
  return d;
}

function EdgeLabel({ lines, x, y, full, quiet }: { lines: string[]; x: number; y: number; full?: string; quiet?: boolean }) {
  if (!lines.length) return null;
  const top = y - ((lines.length - 1) * (LABEL + 3)) / 2;
  return (
    <text className={`flabel${quiet ? " quiet" : ""}`} textAnchor="middle">
      {full && <title>{full}</title>}
      {lines.map((t, i) => (
        <tspan key={i} x={x} y={top + i * (LABEL + 3) + 4}>
          {t}
        </tspan>
      ))}
    </text>
  );
}

/** 図の枠。大きい図は「全体を見る(縮める)」と「実際の大きさ(横に動かして見る)」を切り替えられる。 */
function Svg({ W, H, label, children }: { W: number; H: number; label: string; children: ReactNode }) {
  const [fit, setFit] = useState(false);
  const big = W > 900;
  return (
    <>
      {big && (
        <button type="button" className="fitbtn" onClick={() => setFit(!fit)} aria-pressed={fit}>
          {fit ? "実際の大きさで見る" : "全体を見る(縮める)"}
        </button>
      )}
      <svg viewBox={`0 0 ${W} ${H}`} width={fit ? "100%" : W} height={fit ? undefined : H} style={fit ? { width: "100%", maxWidth: W } : { width: W, minWidth: 0, maxWidth: "none" }} role="img" aria-label={label}>
        {children}
      </svg>
    </>
  );
}

function Arrows() {
  return (
    <defs>
      <marker id="fa" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
        <path d="M0 0L10 5L0 10z" fill="var(--muted)" />
      </marker>
      <marker id="fa2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
        <path d="M0 0L10 5L0 10z" fill="var(--warn)" />
      </marker>
    </defs>
  );
}

// ---- ユーザーフロー: 画面を左から右へ流れる順に並べる ----

const FW = 190; // 箱の中の文字の最大幅

export function FlowSvg({ flow, selected, onSelect }: { flow: Flow; selected: string | null; onSelect: (id: string) => void }) {
  const text = new Map(
    flow.nodes.map((n) => {
      const title = wrap(n.label, 13, FW, 2);
      const sub = n.sub ? wrap(n.sub, 10.5, FW, 2) : [];
      const w = Math.max(120, ...title.map((t) => textWidth(t, 13)), ...sub.map((t) => textWidth(t, 10.5))) + 24;
      return [n.id, { title, sub, w, h: 18 + title.length * 17 + sub.length * 14 + 8 }];
    }),
  );
  const links: Link[] = flow.edges.map((e, i) => ({ key: `e${i}`, from: e.from, to: e.to, labelLines: e.label ? wrap(e.label, LABEL, 140, 2) : [], full: e.label, weight: e.alt ? 1 : 3 }));
  const g = layout(
    flow.nodes.map((n) => ({ id: n.id, w: text.get(n.id)!.w, h: text.get(n.id)!.h })),
    links,
    { dir: "LR", ranksep: 90 },
  );
  return (
    <Svg W={g.W} H={g.H} label="ユーザーフローの図">
      <Arrows />
      {flow.edges.map((e, i) => {
        const p = g.edges.get(`e${i}`);
        return p ? <path key={i} className={`fedge${e.alt ? " alt" : ""}`} d={smooth(p.points)} markerEnd={`url(#fa${e.alt ? "2" : ""})`} /> : null;
      })}
      {flow.nodes.map((n) => {
        const p = g.nodes.get(n.id);
        const t = text.get(n.id)!;
        if (!p) return null;
        const cls = `fnode${selected === n.id ? " sel" : ""}${n.kind === "question" ? " q" : ""}${n.kind === "error" ? " err" : ""}`;
        return (
          <g key={n.id} className={cls} tabIndex={0} role="button" aria-label={n.label} onClick={() => onSelect(n.id)} onKeyDown={(e) => e.key === "Enter" && onSelect(n.id)}>
            <title>{[n.label, n.sub].filter(Boolean).join("\n")}</title>
            <rect x={p.x} y={p.y} width={t.w} height={t.h} rx={10} />
            {t.title.map((s, i) => (
              <text key={`t${i}`} x={p.x + 12} y={p.y + 22 + i * 17} fontWeight={700}>
                {s}
              </text>
            ))}
            {t.sub.map((s, i) => (
              <text key={`s${i}`} className="sub" x={p.x + 12} y={p.y + 22 + t.title.length * 17 + 2 + i * 14}>
                {s}
              </text>
            ))}
          </g>
        );
      })}
      {/* 矢印の言葉は箱と線の上に描く(隠れないように) */}
      {links.map((l) => {
        const p = g.edges.get(l.key);
        return p ? <EdgeLabel key={l.key} lines={l.labelLines} x={p.lx} y={p.ly} full={l.full} /> : null;
      })}
    </Svg>
  );
}

// ---- ドメインモデル: 関係から上から下へ並べる ----

export function ModelSvg({ domain }: { domain: Domain }) {
  if (!domain.entities.length) return null;
  const BW = 200;
  const size = new Map(domain.entities.map((e) => [e.name, { w: BW, h: 34 + e.fields.length * 18 }]));
  const links: Link[] = domain.relations.map((r, i) => ({ key: `r${i}`, from: r.from, to: r.to, labelLines: r.label ? wrap(r.label, LABEL, 140, 2) : [] }));
  const g = layout(
    domain.entities.map((e) => ({ id: e.name, ...size.get(e.name)! })),
    links,
    { dir: "TB", nodesep: 50, ranksep: 70 },
  );
  return (
    <div className="flowwrap">
      <Svg W={g.W} H={g.H} label="ドメインモデルの図">
        {links.map((l) => {
          const p = g.edges.get(l.key);
          return p ? <path key={l.key} className="fedge" d={smooth(p.points)} /> : null;
        })}
        {domain.entities.map((e) => {
          const p = g.nodes.get(e.name);
          const s = size.get(e.name)!;
          if (!p) return null;
          return (
            <g key={e.name}>
              <rect x={p.x} y={p.y} width={s.w} height={s.h} rx={10} fill="var(--surface)" stroke={e.isNew ? "var(--dev)" : "var(--table-edge)"} strokeWidth={1.5} />
              <text x={p.x + 12} y={p.y + 22} fontWeight={700} fill="var(--ink)" fontSize={13}>
                {wrap(e.name, 13, BW - 60, 1)[0]}
                {"  "}
                <tspan fill={e.isNew ? "var(--dev)" : "var(--muted)"} fontSize={10.5}>
                  {e.isNew ? "新規" : "既存"}
                </tspan>
              </text>
              {e.fields.map((f, i) => (
                <text key={i} x={p.x + 12} y={p.y + 44 + i * 18} fill="var(--muted)" fontSize={11} fontFamily="IBM Plex Mono, monospace">
                  {wrap(f, 11, BW - 24, 1)[0]}
                  <title>{f}</title>
                </text>
              ))}
            </g>
          );
        })}
        {links.map((l) => {
          const p = g.edges.get(l.key);
          return p ? <EdgeLabel key={`l${l.key}`} lines={l.labelLines} x={p.lx} y={p.ly} /> : null;
        })}
      </Svg>
    </div>
  );
}

// ---- インフラの構成図: 利用者から奥へ、つながりの順に左から右へ並べる。実線の枠は新しく用意するもの、点線は既存 ----

const KIND_COLOR: Record<string, string> = { web: "var(--dev)", api: "var(--dev)", db: "var(--review)", storage: "var(--review)", auth: "var(--lead)", queue: "var(--warn)", cdn: "var(--ok)" };
const KIND_LABEL: Record<string, string> = { web: "画面", api: "API", db: "データベース", storage: "置き場所", auth: "認証", queue: "キュー", cdn: "入口・配信" };
const IW = 190;

export function InfraSvg({ infra }: { infra: Infra }) {
  if (!infra.components.length) return null;
  const text = new Map(
    infra.components.map((c) => {
      const title = wrap(c.name, 13, IW, 1);
      const sub = wrap(c.service, 10.5, IW, 2);
      return [c.name, { title, sub, w: IW + 24, h: 20 + 17 + sub.length * 14 + 10 }];
    }),
  );
  // 運用の部品(デプロイ・監視・CI など)とのつながりは脇役として薄く描き、配置でも重みを下げて、利用者からの流れをまっすぐにする
  const ops = new Set(infra.components.filter((c) => !KIND_COLOR[c.kind]).map((c) => c.name));
  const links: Link[] = infra.links.map((l, i) => {
    const side = ops.has(l.from) || ops.has(l.to);
    return { key: `i${i}`, from: l.from, to: l.to, labelLines: l.label ? wrap(l.label, LABEL, 130, 1) : [], full: l.label, weight: side ? 1 : 4 };
  });
  const quiet = new Set(links.filter((l) => l.weight === 1).map((l) => l.key));
  const g = layout(
    infra.components.map((c) => ({ id: c.name, w: text.get(c.name)!.w, h: text.get(c.name)!.h })),
    links,
    { dir: "LR", nodesep: 28, ranksep: 110 },
  );
  const kinds = [...new Set(infra.components.map((c) => c.kind))].filter((k) => KIND_COLOR[k]);
  return (
    <>
      <div className="flowwrap">
        <Svg W={g.W} H={g.H} label="インフラの構成図">
          <Arrows />
          {links.map((l) => {
            const p = g.edges.get(l.key);
            return p ? (
              <path key={l.key} className={`fedge${quiet.has(l.key) ? " quiet" : ""}`} d={smooth(p.points)} markerEnd="url(#fa)">
                {l.full && <title>{`${l.from} → ${l.to}: ${l.full}`}</title>}
              </path>
            ) : null;
          })}
          {infra.components.map((c) => {
            const p = g.nodes.get(c.name);
            const t = text.get(c.name)!;
            if (!p) return null;
            return (
              <g key={c.name}>
                <title>{`${c.name}\n${c.service}\n${c.purpose}`}</title>
                <rect x={p.x} y={p.y} width={t.w} height={t.h} rx={10} fill="var(--surface)" stroke={KIND_COLOR[c.kind] ?? "var(--table-edge)"} strokeWidth={1.8} strokeDasharray={c.isNew ? undefined : "4 3"} />
                <text x={p.x + 12} y={p.y + 22} fontWeight={700} fill="var(--ink)" fontSize={13}>
                  {t.title[0]}
                </text>
                {t.sub.map((s, i) => (
                  <text key={i} x={p.x + 12} y={p.y + 40 + i * 14} fill="var(--muted)" fontSize={10.5}>
                    {s}
                  </text>
                ))}
              </g>
            );
          })}
          {links.map((l) => {
            const p = g.edges.get(l.key);
            return p ? <EdgeLabel key={`l${l.key}`} lines={l.labelLines} x={p.lx} y={p.ly} full={l.full} quiet={quiet.has(l.key)} /> : null;
          })}
        </Svg>
      </div>
      <div className="diagram-legend">
        <span>
          <i className="lg solid" /> 新しく用意する
        </span>
        <span>
          <i className="lg dashed" /> 既にあるものを使う
        </span>
        {kinds.map((k) => (
          <span key={k}>
            <i className="lg" style={{ borderColor: KIND_COLOR[k] }} /> {KIND_LABEL[k] ?? k}
          </span>
        ))}
        <span>
          <i className="lg line" /> 利用者からの流れ
        </span>
        <span>
          <i className="lg line quiet" /> 運用(デプロイ・監視など)
        </span>
        <span className="hint">箱や言葉に乗せると全文が出ます。</span>
      </div>
    </>
  );
}
