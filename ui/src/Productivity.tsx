import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, type ProductivityView } from "./api";
import { usd } from "./format";
import { Btn } from "./ui";

/**
 * 開発生産性(docs/design.md 8 章)。トークン・金額・PR・手戻り・人間に助けを求めた数を、記録から数えて見せる。
 * グラフは指標ごとに 1 つ(1 系列なので凡例は置かず、題で名前を示す)。色はデジタル庁デザインシステムの key(青)。
 */
export const useProductivity = (id: number) => useQuery({ queryKey: ["productivity", id], queryFn: () => api<ProductivityView>("GET", `/projects/${id}/productivity`) });

const tok = (v: number) => (v >= 1_000_000 ? `${(v / 1_000_000).toFixed(1)}M` : v >= 1000 ? `${Math.round(v / 1000)}k` : String(Math.round(v)));
const int = (v: number) => String(Math.round(v));

type View = "trend" | "cost" | "tickets";
type Mode = "graph" | "table";
const VIEW_LABEL: Record<View, string> = { trend: "日ごとの推移", cost: "金額の内訳", tickets: "チケットごと" };

export function ProductivityPage({ id }: { id: number }) {
  const { data } = useProductivity(id);
  const [view, setView] = useState<View>("trend");
  const [mode, setMode] = useState<Mode>("graph");
  if (!data) return <section aria-label="生産性" />;
  const t = data.totals;
  return (
    <section className="prod" aria-label="生産性">
      <div>
        <h2>開発生産性</h2>
        <p className="hint">エージェントの起動・PR・レビュー・判断の記録から数えています(企画スタジオの担当の分も含みます)。</p>
      </div>

      <div className="tiles" role="list" aria-label="合計">
        <Tile label="消費トークン" value={tok(t.tokens)} note={`入力 ${tok(t.inputTokens)} · 出力 ${tok(t.outputTokens)} · キャッシュ ${tok(t.cacheReadTokens)}`} />
        <Tile label="使った金額" value={usd(t.costUsd)} note={`うち企画スタジオ ${usd(t.planningCostUsd)} · 起動 ${t.runs} 回`} />
        <Tile label="PR" value={`${t.prs}`} note={`merge した ${t.merged}`} />
        <Tile label="完成したチケット" value={`${t.completed}`} note={`1 件あたり ${usd(t.costPerCompletedUsd)} · ${t.tokensPerCompleted == null ? "—" : tok(t.tokensPerCompleted)} トークン`} />
        <Tile label="手戻り" value={`${t.rework.total}`} note={`差し戻し ${t.rework.changes} · 衝突 ${t.rework.conflicts} · エラーでやり直し ${t.rework.retries}`} />
        <Tile label="人間に助けを求めた" value={`${t.help.total}`} note={`判断カード ${t.help.decisions} · 企画の未決 ${t.help.planAsks}`} />
      </div>

      <div className="viewbar">
        <div className="sectabs" role="tablist" aria-label="指標の見方">
          {(Object.keys(VIEW_LABEL) as View[]).map((v) => (
            <button type="button" role="tab" key={v} aria-selected={view === v} onClick={() => setView(v)}>
              {VIEW_LABEL[v]}
            </button>
          ))}
        </div>
        <div className="mode" role="group" aria-label="表示">
          <Btn kind={mode === "graph" ? "solid-fill" : "outline"} size="sm" aria-pressed={mode === "graph"} onClick={() => setMode("graph")}>
            グラフ
          </Btn>
          <Btn kind={mode === "table" ? "solid-fill" : "outline"} size="sm" aria-pressed={mode === "table"} onClick={() => setMode("table")}>
            表
          </Btn>
        </div>
      </div>

      <div role="tabpanel" aria-label={VIEW_LABEL[view]}>
        {view === "trend" && <Trend data={data} mode={mode} />}
        {view === "cost" && <Cost data={data} mode={mode} />}
        {view === "tickets" && <Tickets data={data} mode={mode} />}
      </div>
    </section>
  );
}

const STAGE: Record<string, string> = { dev: "開発", review: "レビュー", sec: "セキュリティ", qa: "QA", decision: "判断待ち", merge: "merge 待ち", done: "完了", dropped: "取りやめ" };

function Tile({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <div className="tile" role="listitem" aria-label={label}>
      <div className="l">{label}</div>
      <div className="v">{value}</div>
      <div className="n">{note}</div>
    </div>
  );
}

/** 日ごとの棒グラフ(1 系列)。棒に乗せると日付と値が出る。 */
function BarChart({ title, rows, fmt }: { title: string; rows: { label: string; value: number }[]; fmt: (v: number) => string }) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 360, H = 150, L = 8, R = 8, T = 12, B = 22;
  const max = Math.max(...rows.map((r) => r.value), 0) || 1;
  const step = (W - L - R) / rows.length;
  const bw = Math.max(4, Math.min(24, step - 2));
  const y = (v: number) => T + (1 - v / max) * (H - T - B);
  const every = Math.ceil(rows.length / 6); // 日付の目盛りは 6 つ程度に間引く
  const last = rows.at(-1)!;
  return (
    <figure className="chart" aria-label={`${title}の日ごとの推移`}>
      <figcaption>
        <span>{title}</span>
        <b>{fmt(last.value)}</b>
        <span className="hint">{last.label.slice(5)}</span>
      </figcaption>
      <div className="plot">
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${title}: ${rows.map((r) => `${r.label} ${fmt(r.value)}`).join("、")}`}>
          <line x1={L} x2={W - R} y1={H - B} y2={H - B} className="axis" />
          <line x1={L} x2={W - R} y1={y(max)} y2={y(max)} className="grid" />
          <text x={W - R} y={y(max) - 3} textAnchor="end" className="tick">
            {fmt(max)}
          </text>
          {rows.map((r, i) => {
            const x = L + i * step + (step - bw) / 2;
            const top = y(r.value);
            const h = H - B - top;
            const rad = Math.min(4, h);
            return (
              <g key={r.label}>
                {r.value > 0 && (
                  <path
                    className={`bar${hover === i ? " on" : ""}`}
                    d={`M${x} ${H - B} V${top + rad} Q${x} ${top} ${x + rad} ${top} H${x + bw - rad} Q${x + bw} ${top} ${x + bw} ${top + rad} V${H - B} Z`}
                  />
                )}
                {i % every === 0 && (
                  <text x={x + bw / 2} y={H - 6} textAnchor="middle" className="tick">
                    {r.label.slice(5)}
                  </text>
                )}
                {/* 当たり判定は棒より広く取る */}
                <rect x={L + i * step} y={T} width={step} height={H - T - B} fill="transparent" onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)} />
              </g>
            );
          })}
        </svg>
        {hover !== null && (
          <div className="tip" style={{ left: `${((L + hover * step + step / 2) / W) * 100}%`, top: `${(y(rows[hover]!.value) / H) * 100}%` }}>
            {rows[hover]!.label} · {fmt(rows[hover]!.value)}
          </div>
        )}
      </div>
    </figure>
  );
}

/** 金額の内訳(横棒、多い順)。棒の長さは全体に対する割合、値と割合は棒の横に書く。 */
function CostBars({ rows, total, label }: { rows: { key: string; label: string; costUsd: number; tokens: number; runs: number }[]; total: number; label: string }) {
  const max = Math.max(...rows.map((r) => r.costUsd)) || 1;
  return (
    <ul className="rolebars" aria-label={label}>
      {rows.map((r) => (
        <li key={r.key} aria-label={r.label}>
          <span className="name">{r.label}</span>
          <span className="track">
            <span className="fill" style={{ width: `${Math.max(1, (r.costUsd / max) * 100)}%` }} />
          </span>
          <span className="val">
            {usd(r.costUsd)} <small>{total > 0 ? `${Math.round((r.costUsd / total) * 100)}%` : ""} · {tok(r.tokens)} トークン · {r.runs} 回</small>
          </span>
        </li>
      ))}
    </ul>
  );
}

type P = { data: ProductivityView; mode: Mode };

function Trend({ data, mode }: P) {
  if (data.daily.length === 0) return <p className="hint">まだ記録がありません。担当が動くと、ここに日ごとの数字が並びます。</p>;
  if (mode === "graph")
    return (
      <div className="charts">
        <BarChart title="消費トークン" rows={data.daily.map((d) => ({ label: d.day, value: d.tokens }))} fmt={tok} />
        <BarChart title="使った金額" rows={data.daily.map((d) => ({ label: d.day, value: d.costUsd }))} fmt={(v) => usd(v)} />
        <BarChart title="出した PR" rows={data.daily.map((d) => ({ label: d.day, value: d.prs }))} fmt={int} />
        <BarChart title="手戻り" rows={data.daily.map((d) => ({ label: d.day, value: d.rework }))} fmt={int} />
        <BarChart title="人間に助けを求めた" rows={data.daily.map((d) => ({ label: d.day, value: d.help }))} fmt={int} />
      </div>
    );
  return (
    <div className="tablewrap">
      <table aria-label="日ごとの推移の表">
        <thead>
          <tr>
            <th>日付</th>
            <th>トークン</th>
            <th>金額</th>
            <th>PR</th>
            <th>merge</th>
            <th>完成</th>
            <th>手戻り</th>
            <th>助けを求めた</th>
          </tr>
        </thead>
        <tbody>
          {data.daily.map((d) => (
            <tr key={d.day}>
              <th>{d.day}</th>
              <td>{d.tokens.toLocaleString()}</td>
              <td>{usd(d.costUsd)}</td>
              <td>{d.prs}</td>
              <td>{d.merged}</td>
              <td>{d.completed}</td>
              <td>{d.rework}</td>
              <td>{d.help}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

type CostRow = { key: string; label: string; costUsd: number; tokens: number; runs: number };

function Cost({ data, mode }: P) {
  const t = data.totals;
  if (data.byPurpose.length === 0) return <p className="hint">まだ記録がありません。</p>;
  const groups: [string, string, CostRow[]][] = [
    ["何の仕事に", "何の仕事にかかったか", data.byPurpose],
    ["どのモデルに", "どのモデルにかかったか", data.byModel],
    ["誰(役割)に", "どの役割にかかったか", data.byRole.map((r) => ({ key: r.role, label: r.label, costUsd: r.costUsd, tokens: r.tokens, runs: r.runs }))],
  ];
  return (
    <>
      <p className="hint">合計 {usd(t.costUsd)} が、何の仕事に・どのモデルに・誰にかかったか。</p>
      <div className="breakdowns">
        {groups.map(([title, label, rows]) => (
          <div key={title}>
            <h4>{title}</h4>
            {mode === "graph" ? (
              <CostBars rows={rows} total={t.costUsd} label={label} />
            ) : (
              <table aria-label={label}>
                <thead>
                  <tr>
                    <th>内訳</th>
                    <th>金額</th>
                    <th>割合</th>
                    <th>トークン</th>
                    <th>起動</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.key}>
                      <th>{r.label}</th>
                      <td>{usd(r.costUsd)}</td>
                      <td>{t.costUsd > 0 ? `${Math.round((r.costUsd / t.costUsd) * 100)}%` : "—"}</td>
                      <td>{r.tokens.toLocaleString()}</td>
                      <td>{r.runs}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        ))}
      </div>
    </>
  );
}

function Tickets({ data, mode }: P) {
  if (data.tickets.length === 0) return <p className="hint">まだチケットがありません。</p>;
  if (mode === "graph")
    return (
      <>
        <p className="hint">チケットごとの金額(多い順)。</p>
        <CostBars
          rows={[...data.tickets].sort((a, b) => b.costUsd - a.costUsd).map((x) => ({ key: String(x.id), label: `#${x.number} ${x.title}`, costUsd: x.costUsd, tokens: x.tokens, runs: x.runs }))}
          total={data.tickets.reduce((s, x) => s + x.costUsd, 0)}
          label="チケットごとの金額"
        />
      </>
    );
  return (
    <div className="tablewrap">
      <table className="tickets" aria-label="チケットごとの指標">
        <thead>
          <tr>
            <th>チケット</th>
            <th>状態</th>
            <th>金額</th>
            <th>トークン</th>
            <th>起動</th>
            <th>PR</th>
            <th>差し戻し</th>
            <th>衝突</th>
            <th>やり直し</th>
            <th>助けを求めた</th>
          </tr>
        </thead>
        <tbody>
          {data.tickets.map((x) => (
            <tr key={x.id}>
              <th>
                #{x.number} {x.title}
              </th>
              <td>{STAGE[x.stage] ?? x.stage}</td>
              <td>{usd(x.costUsd)}</td>
              <td>{tok(x.tokens)}</td>
              <td>{x.runs}</td>
              <td>{x.prs}</td>
              <td>{x.rounds}</td>
              <td>{x.conflicts}</td>
              <td>{x.retries}</td>
              <td>{x.help}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
