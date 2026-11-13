import { Chip, Segmented } from "./ds";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, type ProductivityView } from "./api";
import { usd } from "./format";
import { Btn } from "./ui";
import { KINDS, KIND_SHAPE } from "./kind";

/**
 * 開発生産性(docs/design.md 8 章、企画の試作 metrics に合わせた並び)。トークン・金額・PR・手戻り・人間に助けを求めた数を、記録から数えて見せる。
 * グラフは指標ごとに 1 つ(1 系列なので凡例は置かず、題で名前を示す)。色はデジタル庁デザインシステムの key(青)。
 */
export const useProductivity = (id: number) => useQuery({ queryKey: ["productivity", id], queryFn: () => api<ProductivityView>("GET", `/projects/${id}/productivity`) });

const tok = (v: number) => (v >= 1_000_000 ? `${(v / 1_000_000).toFixed(1)}M` : v >= 1000 ? `${Math.round(v / 1000)}k` : String(Math.round(v)));
const int = (v: number) => String(Math.round(v));

type View = "flow" | "trend" | "cost" | "tickets" | "members";
type Mode = "graph" | "table";
// 試作(metrics)の並び: 日ごとの推移 / 金額の内訳 / チケットごと。流れとメンバーは試作に無いが、機能として残すので、そのあとに並べる
const VIEW_LABEL: Record<View, string> = { trend: "日ごとの推移", cost: "金額の内訳", tickets: "チケットごと", flow: "流れ", members: "メンバー" };

/** かかった時間(ミリ秒)を、分・時間・日で短く。 */
const span = (ms: number | null) => {
  if (ms == null) return "—";
  if (ms < 60_000) return `${Math.round(ms / 1000)} 秒`;
  const m = ms / 60_000;
  return m < 60 ? `${Math.round(m)} 分` : m < 60 * 48 ? `${(m / 60).toFixed(1)} 時間` : `${(m / 60 / 24).toFixed(1)} 日`;
};
/** チケットごとの表の「かかった時間」: 3h 20m / 1h 05m / 40m。 */
const hm = (ms: number) => {
  const min = Math.round(ms / 60_000);
  return min < 60 ? `${min}m` : `${Math.floor(min / 60)}h ${String(min % 60).padStart(2, "0")}m`;
};
/** 1 時間ごとの目盛り: 「14時」(0 時だけ日付も)。 */
const hourTick = (l: string) => (l.endsWith(" 00時") ? l.slice(5, 10) : l.slice(11));
const pct = (v: number | null) => (v == null ? "—" : `${Math.round(v * 100)}%`);

/** 合計の題の「この N 日」: 最初の記録の日から今日まで(記録が無ければ日数は出さない)。 */
const periodDays = (first: string | undefined) => {
  if (!first) return null;
  const [y, m, d] = first.split("-").map(Number) as [number, number, number];
  const now = new Date();
  return Math.max(1, Math.round((new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() - new Date(y, m - 1, d).getTime()) / 86_400_000) + 1);
};

/** 画面の右上(ヘッダー)の指標: フロー効率と編成の版・完成 1 件あたりのトークン・判断の回数。 */
export function MetricsKpi({ id }: { id: number }) {
  const { data } = useProductivity(id);
  if (!data) return null;
  const t = data.totals;
  return (
    <div className="kpi" role="group" aria-label="主な指標">
      <span>
        フロー効率{t.formationVersion != null && ` · 編成 v${t.formationVersion}`}
        <b>{pct(data.flow.flowEfficiency)}</b>
      </span>
      <span>
        完成 1 件あたり<b>{t.tokensPerCompleted == null ? "—" : tok(t.tokensPerCompleted)}</b>
      </span>
      <span>
        判断の回数<b>{t.decisionsPerTicket == null ? "—" : `${t.decisionsPerTicket.toFixed(1)} / 件`}</b>
      </span>
    </div>
  );
}

export function ProductivityPage({ id }: { id: number }) {
  const { data } = useProductivity(id);
  const [view, setView] = useState<View>("tickets");
  const [mode, setMode] = useState<Mode>("graph");
  const [kind, setKind] = useState("all"); // チケットごとの表の、種類の絞り込み(R17)
  if (!data) return <section aria-label="生産性" />;
  const t = data.totals;
  const days = periodDays(data.daily[0]?.day);
  return (
    <section className="prod" aria-label="生産性">
      <h2 className="sr-only">生産性</h2>
      <section className="panel" aria-label="合計の指標">
        <p className="sub">合計{days != null && ` · この ${days} 日`}</p>
        <div className="tiles" role="list" aria-label="合計">
          <Tile label="トークン" value={tok(t.tokens)} />
          <Tile label="金額" value={usd(t.costUsd)} />
          <Tile label="PR / 完成" value={`${t.prs} / ${t.completed}`} />
          <Tile label="手戻り" value={`${t.rework.total}`} />
          <Tile label="人に助けを求めた" value={`${t.help.total}`} />
          <Tile label="ルール違反" value={`${t.ruleViolations.total}`} note={`うち自動で直した ${t.ruleViolations.autofixed}`} fresh />
          <Tile label="質問(島どうし)" value={`${t.questions.islands}`} />
          <Tile label="経路が無くリーダーへ" value={`${t.questions.noRoute}`} />
        </div>
      </section>

      {/* どの表示にしても、この図は残る(R16) */}
      <section className="panel" aria-label="フロー効率の推移">
        <EfficiencyTrend data={data} />
      </section>

      <section className="panel wide" aria-label="指標の中身">
        <div className="bar">
          <div className="sectabs" role="tablist" aria-label="指標の見方">
            {(Object.keys(VIEW_LABEL) as View[]).map((v) => (
              <button type="button" role="tab" key={v} aria-selected={view === v} onClick={() => setView(v)}>
                {VIEW_LABEL[v]}
              </button>
            ))}
          </div>
          {view === "tickets" ? (
            <TicketKindFilter kind={kind} onChange={setKind} />
          ) : (
            <div className="mode" role="group" aria-label="表示">
              <Btn kind={mode === "graph" ? "solid-fill" : "outline"} size="sm" aria-pressed={mode === "graph"} onClick={() => setMode("graph")}>
                グラフ
              </Btn>
              <Btn kind={mode === "table" ? "solid-fill" : "outline"} size="sm" aria-pressed={mode === "table"} onClick={() => setMode("table")}>
                表
              </Btn>
            </div>
          )}
        </div>
        <div role="tabpanel" aria-label={VIEW_LABEL[view]}>
          {view === "flow" && <Flow data={data} mode={mode} />}
          {view === "members" && <Members data={data} />}
          {view === "trend" && <Trend data={data} mode={mode} />}
          {view === "cost" && <Cost data={data} mode={mode} />}
          {view === "tickets" && <Tickets data={data} kind={kind} />}
        </div>
      </section>
    </section>
  );
}

const STAGE: Record<string, string> = { dev: "開発", review: "レビュー", sec: "セキュリティ", qa: "QA", decision: "判断待ち", merge: "merge 待ち", done: "完了", dropped: "取りやめ" };

function Tile({ label, value, note, fresh }: { label: string; value: string; note?: string; fresh?: boolean }) {
  return (
    <div className={`tile${fresh ? " fresh" : ""}`} role="listitem" aria-label={label}>
      <div className="l">{label}</div>
      <div className="v">{value}</div>
      {note && <div className="n">{note}</div>}
    </div>
  );
}

/** 日ごとの棒グラフ(1 系列)。棒に乗せると日付と値が出る。 */
function BarChart({ title, rows, fmt, tick = (l) => l.slice(5) }: { title: string; rows: { label: string; value: number }[]; fmt: (v: number) => string; tick?: (label: string) => string }) {
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
                    {tick(r.label)}
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

/**
 * フロー効率の推移(折れ線)と、編成の版が上がった日(縦の点線と札)。札には何を変えたか(連絡経路 / 流れ / 島)を出す(R16)。
 * 効率が上がり下がりしたのが編成を変えたせいかを、日付で見比べられる。
 */
const CHANGED_LABEL: Record<string, string> = { routes: "連絡経路", flows: "流れ", units: "島" };
function EfficiencyTrend({ data }: { data: ProductivityView }) {
  const [picked, setPicked] = useState<number | null>(null); // 押した札の版
  const rows = data.flow.efficiencyDaily;
  const marks = data.flow.formationMarks;
  const days = [...new Set([...rows.map((r) => r.day), ...marks.map((m) => m.day)])].sort();
  if (days.length === 0) return null;
  const W = 386, L = 34, R = 8, B = 36;
  const x = (day: string) => (days.length === 1 ? (L + W - R) / 2 : L + (days.indexOf(day) / (days.length - 1)) * (W - L - R));
  // 札は、横に重なるものを別の段に積む(同じ日に版が複数上がっても、札が重ならず読める)。段の数だけ上の余白を広げ、グラフ本体の高さは変えない
  const CARD_H = 20, LANE_GAP = 4, GAP_X = 4;
  const cards = marks.map((m) => {
    const text = `v${m.version} ${m.changed.map((c) => CHANGED_LABEL[c] ?? c).join("・")}`;
    const w = text.length * 12 + 12;
    const left = Math.min(Math.max(x(m.day) - w / 2, 0), W - w);
    return { m, text, w, left, lane: 0 };
  });
  const lanes: { left: number; right: number }[][] = [];
  for (const c of cards) {
    let lane = lanes.findIndex((l) => l.every((o) => c.left >= o.right + GAP_X || c.left + c.w + GAP_X <= o.left));
    if (lane < 0) lane = lanes.push([]) - 1;
    lanes[lane]!.push({ left: c.left, right: c.left + c.w });
    c.lane = lane;
  }
  const laneY = (lane: number) => lane * (CARD_H + LANE_GAP);
  const T = Math.max(34, lanes.length * (CARD_H + LANE_GAP) + 10);
  const H = 196 + (T - 34);
  const top = Math.max(0.5, ...rows.map((r) => r.value));
  const y = (v: number) => T + (1 - v / top) * (H - T - B);
  return (
    <figure className="chart" aria-label="フロー効率の推移と編成を変えた日">
      <figcaption className="sub">フロー効率の推移 · 編成を変えた日</figcaption>
      <div className="plot">
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`フロー効率の推移: ${rows.map((r) => `${r.day} ${Math.round(r.value * 100)}%`).join("、") || "まだありません"}`}>
          <line x1={L} x2={W - R} y1={H - B} y2={H - B} className="axis" />
          <line x1={L} x2={W - R} y1={y(top)} y2={y(top)} className="grid" />
          <line x1={L} x2={W - R} y1={y(top / 2)} y2={y(top / 2)} className="grid" />
          <text x={0} y={H - B + 4} className="tick">0%</text>
          <text x={0} y={y(top / 2) + 4} className="tick">{Math.round((top / 2) * 100)}%</text>
          <text x={0} y={y(top) + 4} className="tick">{Math.round(top * 100)}%</text>
          {rows.length > 1 && <polyline fill="none" className="line" stroke="var(--dev)" strokeWidth={2} points={rows.map((r) => `${x(r.day)},${y(r.value)}`).join(" ")} />}
          {rows.length > 0 && <circle cx={x(rows.at(-1)!.day)} cy={y(rows.at(-1)!.value)} r={4} fill="var(--dev)" />}
          {cards.map(({ m, text, w, left, lane }) => (
            <g
              key={m.version}
              className="mark"
              data-version={m.version}
              data-lane={lane}
              role="button"
              tabIndex={0}
              aria-pressed={picked === m.version}
              aria-label={`${text} の変えたことを${picked === m.version ? "閉じる" : "見る"}`}
              onClick={() => setPicked(picked === m.version ? null : m.version)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  setPicked(picked === m.version ? null : m.version);
                }
              }}
            >
              <line x1={x(m.day)} x2={x(m.day)} y1={laneY(lane) + CARD_H} y2={H - B} stroke="var(--lead)" strokeDasharray="4 3" />
              <rect x={left} y={laneY(lane)} width={w} height={CARD_H} rx={6} fill="var(--lead-soft)" stroke={picked === m.version ? "var(--lead)" : "none"} />
              <text x={left + 6} y={laneY(lane) + 14} style={{ fill: "var(--lead)", fontSize: "var(--fs-xs)" }}>{text}</text>
            </g>
          ))}
          <text x={L} y={H - 8} className="tick">{days[0]!.slice(5)}</text>
          <text x={W - R} y={H - 8} textAnchor="end" className="tick">{days.at(-1)!.slice(5)}</text>
        </svg>
      </div>
      {(() => {
        const mark = marks.find((m) => m.version === picked);
        if (mark)
          return (
            <div className="markdetail" role="status">
              <b>v{mark.version} で変えたこと</b>
              <ul>{mark.detail.map((d) => <li key={d}>{d}</li>)}</ul>
            </div>
          );
        return <p className="hint">{marks.length > 0 ? "札を押すと、その版で変えたこと(例: 開発 ↔ レビューを「質問・相談できる」に)が出る" : "編成を変えた日はまだありません。編成の版が上がると、その日に縦の点線と札が入ります。"}</p>;
      })()}
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

/** 種類の絞り込み(R17)。試作の並び: 「種類」の字・全部・● 機能 …。 */
function TicketKindFilter({ kind, onChange }: { kind: string; onChange: (k: string) => void }) {
  return (
    <div className="types">
      <span>種類</span>
      <Segmented
        label="種類で絞り込み"
        className="pills"
        value={kind}
        onChange={onChange}
        options={[{ value: "all", label: "全部" }, ...KINDS.map((k) => ({ value: k.key as string, label: `${KIND_SHAPE[k.key]} ${k.label}` }))]}
      />
    </div>
  );
}

/** チケットの状態(試作の札): 工程の名前。完了は「完成」、ルール違反で止まっているときは「止まっている」。 */
const TICKET_STATE: Record<string, { label: string; tone: "default" | "ok" | "warn" | "danger" | "neutral" }> = {
  dev: { label: "開発", tone: "default" },
  review: { label: "レビュー", tone: "default" },
  sec: { label: "セキュリティ", tone: "default" },
  qa: { label: "QA", tone: "default" },
  decision: { label: "判断待ち", tone: "warn" },
  merge: { label: "merge 待ち", tone: "ok" },
  done: { label: "完成", tone: "ok" },
  dropped: { label: "取りやめ", tone: "neutral" },
};

/** チケットごと(試作の表: 番号・種類・チケット・トークン・金額・往復・ルール違反・かかった時間・状態)。 */
function Tickets({ data, kind }: { data: ProductivityView; kind: string }) {
  if (data.tickets.length === 0) return <p className="hint">まだチケットがありません。</p>;
  const rows = kind === "all" ? data.tickets : data.tickets.filter((x) => x.kind === kind);
  if (rows.length === 0) return <p className="hint">この種類のチケットはまだありません。</p>;
  return (
    <div className="tablewrap">
      <table className="tickets" aria-label="チケットごとの指標">
        <thead>
          <tr>
            <th>番号</th>
            <th>種類</th>
            <th>チケット</th>
            <th>トークン</th>
            <th>金額</th>
            <th>往復</th>
            <th>ルール違反</th>
            <th>かかった時間</th>
            <th>状態</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((x) => {
            const state = x.stopped ? { label: "止まっている", tone: "danger" as const } : (TICKET_STATE[x.stage] ?? { label: x.stage, tone: "neutral" as const });
            return (
              <tr key={x.id}>
                <td className="id">#{x.number}</td>
                <td>
                  <span className="kindname" title={`種類: ${KINDS.find((k) => k.key === x.kind)?.label ?? x.kind}`}>
                    <span aria-hidden="true">{KIND_SHAPE[x.kind] ?? "●"}</span> {KINDS.find((k) => k.key === x.kind)?.label ?? x.kind}
                  </span>
                </td>
                <th>{x.title}</th>
                <td>{tok(x.tokens)}</td>
                <td>{usd(x.costUsd)}</td>
                <td>{x.rounds}</td>
                <td>
                  {x.violations === 0 ? (
                    "—"
                  ) : (
                    <span className="viol">
                      {x.autofixed > 0 && <Chip tone="ok">{x.autofixed} · 自動で直した</Chip>}
                      {x.reviewed > 0 && <Chip tone="warn">{x.reviewed} · レビューで指摘</Chip>}
                      {x.blocked > 0 && <Chip tone="danger">{x.blocked} · 直すまで止める</Chip>}
                    </span>
                  )}
                </td>
                <td>{hm(x.activeMs)}</td>
                <td>
                  <Chip tone={state.tone}>{state.label}</Chip>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** 件数の横棒(多い順・並びを決めたもの)。棒の長さは一番多いものに対する割合。 */
function CountBars({ rows, label, unit = "件" }: { rows: { key: string; label: string; n: number; note?: string }[]; label: string; unit?: string }) {
  const max = Math.max(...rows.map((r) => r.n)) || 1;
  return (
    <ul className="rolebars" aria-label={label}>
      {rows.map((r) => (
        <li key={r.key} aria-label={r.label}>
          <span className="name">{r.label}</span>
          <span className="track">
            <span className="fill" style={{ width: `${Math.max(1, (r.n / max) * 100)}%` }} />
          </span>
          <span className="val">
            {r.n} {unit}
            {r.note && <small> · {r.note}</small>}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** 流れ: 速さ・入ってくる数と片付く数・仕掛かり・待ち(直近 48 時間は 1 時間ずつ)。 */
function Flow({ data, mode }: P) {
  const f = data.flow;
  const th = f.throughput;
  const h = f.hourly;
  return (
    <>
      <div className="tiles" role="list" aria-label="流れの指標">
        <Tile label="時間あたりの merge" value={th.mergedPerActiveHour == null ? "—" : th.mergedPerActiveHour.toFixed(2)} note={`直近 24 時間で ${th.mergedLast24h} 件 · チームが動いていた ${th.activeHours} 時間あたり(24 時間ならし ${th.mergedPerHour.toFixed(2)})`} />
        <Tile label="入った / 片付いた(24 時間)" value={`${th.createdLast24h} / ${th.closedLast24h}`} note={th.netLast24h > 0 ? `${th.netLast24h} 件溜まっています(未完了 ${f.open} 件)` : th.netLast24h < 0 ? `${-th.netLast24h} 件減りました(未完了 ${f.open} 件)` : `増減なし(未完了 ${f.open} 件)`} />
        <Tile label="リードタイム(中央値)" value={span(f.times.leadMs.median)} note={`入ってから merge まで · 90% は ${span(f.times.leadMs.p90)} 以内 · ${f.times.leadMs.n} 件`} />
        <Tile label="サイクルタイム(中央値)" value={span(f.times.cycleMs.median)} note={`取りかかってから merge まで · 90% は ${span(f.times.cycleMs.p90)} 以内`} />
        <Tile label="merge 待ち(中央値)" value={span(f.times.mergeWaitMs.median)} note={`確認が済んでから merge まで · 90% は ${span(f.times.mergeWaitMs.p90)} 以内`} />
        <Tile label="フロー効率" value={pct(f.flowEfficiency)} note="リードタイムのうち、誰かが手を動かしていた割合" />
        <Tile label="一発で通った" value={pct(f.firstPassYield)} note={`差し戻し・衝突・CI での戻りなしで merge した割合(${f.mergedTotal} 件中)`} />
        <Tile label="あなたを待った時間" value={span(f.ownerWait.totalMs)} note={`判断カード ${f.ownerWait.count} 枚(いま待っている ${f.ownerWait.pending} 枚) · 1 枚あたり中央値 ${span(f.ownerWait.median)}`} />
      </div>

      <p className="hint">直近 48 時間を 1 時間ずつ。片付いたのは merge・取りやめ・すでに入っていたもの、未完了は各時間の終わりの数です。</p>
      {mode === "graph" ? (
        <div className="charts">
          <BarChart title="入ったチケット" rows={h.map((x) => ({ label: x.hour, value: x.created }))} fmt={int} tick={hourTick} />
          <BarChart title="片付いたチケット" rows={h.map((x) => ({ label: x.hour, value: x.closed }))} fmt={int} tick={hourTick} />
          <BarChart title="未完了のチケット" rows={h.map((x) => ({ label: x.hour, value: x.open }))} fmt={int} tick={hourTick} />
          <BarChart title="merge" rows={h.map((x) => ({ label: x.hour, value: x.merged }))} fmt={int} tick={hourTick} />
          <BarChart title="起動" rows={h.map((x) => ({ label: x.hour, value: x.runs }))} fmt={int} tick={hourTick} />
          <BarChart title="使った金額" rows={h.map((x) => ({ label: x.hour, value: x.costUsd }))} fmt={(v) => usd(v)} tick={hourTick} />
        </div>
      ) : (
        <div className="tablewrap">
          <table aria-label="1 時間ごとの推移の表">
            <thead>
              <tr>
                <th>時間</th>
                <th>入った</th>
                <th>片付いた</th>
                <th>未完了</th>
                <th>merge</th>
                <th>起動</th>
                <th>金額</th>
              </tr>
            </thead>
            <tbody>
              {h.map((x) => (
                <tr key={x.hour}>
                  <th>{x.hour}</th>
                  <td>{x.created}</td>
                  <td>{x.closed}</td>
                  <td>{x.open}</td>
                  <td>{x.merged}</td>
                  <td>{x.runs}</td>
                  <td>{usd(x.costUsd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="breakdowns">
        <div>
          <h4>どこから入ったか</h4>
          {f.sources.length ? <CountBars label="チケットがどこから入ったか" rows={f.sources.map((s) => ({ key: s.key, label: s.label, n: s.total, note: `直近 24 時間 ${s.last24h} · 未完了 ${s.open}` }))} /> : <p className="hint">まだありません。</p>}
        </div>
        <div>
          <h4>いまの仕掛かり</h4>
          {f.wip.length ? <CountBars label="工程ごとの未完了のチケット" rows={f.wip.map((w) => ({ key: w.key, label: w.label, n: w.n }))} /> : <p className="hint">未完了のチケットはありません。</p>}
        </div>
        <div>
          <h4>長く開いているチケット</h4>
          {f.aging.length ? (
            <div className="tablewrap">
            <table aria-label="長く開いているチケット">
              <thead>
                <tr>
                  <th>チケット</th>
                  <th>工程</th>
                  <th>入ってから</th>
                </tr>
              </thead>
              <tbody>
                {f.aging.map((a) => (
                  <tr key={a.id}>
                    <th>
                      #{a.number} {a.title}
                    </th>
                    <td>{a.stage === "todo" ? "未着手" : (STAGE[a.stage] ?? a.stage)}</td>
                    <td>{span(a.ageMs)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          ) : (
            <p className="hint">ありません。</p>
          )}
        </div>
      </div>
    </>
  );
}

/** メンバーごとと、役割ごとの起動の長さ。 */
function Members({ data }: { data: ProductivityView }) {
  const m = data.members;
  if (!m.list.length) return <p className="hint">まだ記録がありません。</p>;
  return (
    <>
      <p className="hint">稼働率は、直近 24 時間のうちチームが動いていた時間に対して、その人が起動していた割合です。</p>
      <div className="tablewrap">
        <table aria-label="メンバーごとの指標">
          <thead>
            <tr>
              <th>メンバー</th>
              <th>島</th>
              <th>稼働率(24 時間)</th>
              <th>起動</th>
              <th>動いていた時間(通算)</th>
              <th>金額</th>
              <th>エラー</th>
              <th>merge まで持っていった</th>
            </tr>
          </thead>
          <tbody>
            {m.list.map((x) => (
              <tr key={x.id}>
                <th>
                  {x.name}
                  {x.left ? "(離れた)" : ""}
                </th>
                <td>{x.unit || x.role}</td>
                <td>{pct(x.utilization)}</td>
                <td>{x.runs}</td>
                <td>{span(x.busyMs)}</td>
                <td>{usd(x.costUsd)}</td>
                <td>{x.errors}</td>
                <td>{x.merged}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <h4>役割ごとの起動</h4>
      <div className="tablewrap">
        <table aria-label="役割ごとの起動の長さ">
          <thead>
            <tr>
              <th>役割</th>
              <th>起動</th>
              <th>1 回の長さ(中央値)</th>
              <th>90% は</th>
              <th>エラーの割合</th>
            </tr>
          </thead>
          <tbody>
            {m.roles.map((r) => (
              <tr key={r.role}>
                <th>{r.label}</th>
                <td>{r.runs}</td>
                <td>{span(r.median)}</td>
                <td>{span(r.p90)} 以内</td>
                <td>{pct(r.errorRate)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
