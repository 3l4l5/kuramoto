import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, post, type OfficeView } from "./api";
import { duration, useAct, useNow } from "./hooks";
import { Btn } from "./ui";
import { unblockText, usd } from "./format";
import { TicketLink } from "./Ticket";
import { Avatar } from "./Avatar";
import { IslandDialog } from "./IslandDialog";
import { UnitDialog } from "./OfficeDialogs";
import { MemberDrawer } from "./MemberDrawer";
import { KIND_SHAPE, KINDS } from "./kind";
import { Button, Segmented } from "./ds";
import { requestFormationTab, useFormationUi } from "./formationUi";
import { LEG_GAP, linePath } from "./linePath";
import { MAX_UNITS } from "../../src/domain/formation";

/**
 * バーチャルオフィス(docs/design.md 6.3)。島(駅)ごとの机にメンバーが座り、作業中は手元が光って体が揺れ、
 * 今していることを吹き出しで話す。駅は共有し、種類ごとの流れを路線として重ねる(R17)。
 * 床には許されている連絡経路が点線で出て、答えを待っている質問の封筒が経路を行き来する(R16)。
 * チケットが工程を進むと、書類が次の島や merge 待ちの棚へ飛ぶ。メンバーを押すと、右に今していることと話す欄が開く。
 * すべて記録(起動・受信箱・チケット)から組み立てる。
 */
const useOffice = (id: number) => useQuery({ queryKey: ["office", id], queryFn: () => api<OfficeView>("GET", `/projects/${id}/office`), refetchInterval: 2000 });

type Member = OfficeView["units"][number]["members"][number];
type Work = NonNullable<Member["work"]>;

const ROLE_CLASS: Record<string, string> = { 開発: "dev", レビュー: "review", セキュリティ: "sec", QA: "qa", リーダー: "lead", アーキテクト: "arch", 企画: "plan", デザイナー: "design" };
const QUIET_WARN_SEC = 90;

const Selected = createContext<number | null>(null);

export function OfficeFloor({ id }: { id: number }) {
  const { data } = useOffice(id);
  const floor = useRef<HTMLDivElement>(null);
  const flights = useFlights(floor, data?.where);
  const [edit, setEdit] = useState<{ name: string | null } | null>(null);
  // メンバーを押すと右に引き出し(今していること・話す欄)。島の名前を押すと島の様子のモーダル
  const [member, setMember] = useState<{ id: number; chat: boolean } | null>(null);
  const [unit, setUnit] = useState<number | null>(null);
  // 路線の絞り込み: 選んだ種類の路線だけが濃くなる(null = すべて)
  const [kind, setKind] = useState<string>("all");
  const draftOn = useFormationUi().draftRoutes !== null;
  if (!data) return <section className="officefloor" aria-label="オフィスの床" />;
  const open = (chat: boolean) => (mid: number) => setMember({ id: mid, chat });
  const kinds = KINDS.filter((k) => data.lines.some((l) => l.kinds.some((x) => x.kind === k.key))).map((k) => ({ kind: k.key, label: k.label }));
  const stopsOf = (l: OfficeView["lines"][number]) => ["lead", ...l.stops.map((s) => `unit:${s.unitId}`), "merge"];
  return (
    <section className="officefloor" aria-label="オフィスの床" ref={floor}>
      <Selected.Provider value={member?.id ?? null}>
        <div className="of-filter">
          <span id="of-filter-label">路線</span>
          <Segmented
            label="路線の種類"
            value={kind}
            onChange={setKind}
            options={[{ value: "all", label: "すべて" }, ...kinds.map((k) => ({ value: k.kind, label: `${KIND_SHAPE[k.kind]} ${k.label}` }))]}
          />
        </div>
        <RouteMap data={data} kind={kind}>
          <div className="of-islands">
            {/* スマホだけ: 縦線の上に、種類の形を並べる(選んだ種類が濃くなる) */}
            <div className="of-strandhead" aria-hidden="true">
              {KINDS.map((k) => (
                <span key={k.key}>{KIND_SHAPE[k.key]}</span>
              ))}
            </div>
            <Station loc="lead" data={data} stopsOf={stopsOf}>
              <Desk onMember={open(false)} title="受け口" label="リーダー" who={data.lead} running={data.running} waitingFor="判断・チャットを待っています" loc="lead" sticky={data.lead.decisions.length ? `相談 ${data.lead.decisions.length}` : undefined} note={data.lead.decisions.length ? `判断待ち ${data.lead.decisions.length} 件(#${data.lead.decisions.join("、#")})` : "判断待ちはありません"} />
            </Station>
            {data.units.map((u) => (
              <Station key={u.id} loc={`unit:${u.id}`} data={data} stopsOf={stopsOf}>
                <Island u={u} running={data.running} onEdit={() => setEdit({ name: u.name })} onOpen={() => setUnit(u.id)} onMember={open(true)} />
              </Station>
            ))}
            <Station loc="merge" data={data} stopsOf={stopsOf}>
              <MergeShelf id={id} q={data.mergeQueue} auto={data.autoMerge} />
            </Station>
            {data.units.length < MAX_UNITS && (
              <button type="button" className="of-addisland" onClick={() => setEdit({ name: null })}>
                <span aria-hidden="true">＋</span>
                島を足す
                <small>あと {MAX_UNITS - data.units.length} つ</small>
              </button>
            )}
          </div>
          <aside className="of-side">
            <Desk onMember={open(false)} title="アーキテクト" who={data.architect} running={data.running} waitingFor="相談を待っています" loc="arch" note="設計の相談役" />
            <section className="of-donepile" data-loc="done" aria-label="merge 済み">
              <h3>merge 済み</h3>
              <div className="of-stack" aria-hidden="true">
                {Array.from({ length: Math.min(8, data.done.count) }, (_, i) => (
                  <i key={i} style={{ bottom: i * 4 }} />
                ))}
              </div>
              <div className="hint">{data.done.count ? `${data.done.count} 件(#${data.done.recent.join("、#")})` : "まだありません"}</div>
            </section>
            <p className="of-legend">
            <span><b>○</b> 停車、丸が無い = 省略</span>
            <span><i className="of-legend-ask" aria-hidden="true" /> {draftOn ? "質問・相談できる経路(保存前の案を表示中)" : "質問・相談できる経路"}</span>
            <span>メンバーを押すと様子と話す欄が開く</span>
            <span className="of-legend-links">
              <Button variant="text" size="sm" onClick={() => requestFormationTab("routes")}>経路を変える</Button>
              <Button variant="text" size="sm" onClick={() => requestFormationTab("flows")}>流れを変える</Button>
            </span>
          </p>
          </aside>
        </RouteMap>
        {edit && <IslandDialog id={id} name={edit.name} close={() => setEdit(null)} />}
        {member !== null && <MemberDrawer projectId={id} memberId={member.id} canChat={member.chat} close={() => setMember(null)} />}
        {unit !== null && (
          <UnitDialog
            projectId={id}
            unitId={unit}
            close={() => setUnit(null)}
            onEdit={(name) => {
              setUnit(null);
              setEdit({ name });
            }}
          />
        )}
        {flights.map((f) => (
          <div key={f.key} className="of-flight" style={{ left: f.x, top: f.y, transform: f.go ? `translate(${f.dx}px, ${f.dy}px)` : "none" }} aria-hidden="true">
            #{f.n}
          </div>
        ))}
      </Selected.Provider>
    </section>
  );
}

/**
 * 駅。スマホでは左に縦の路線を出す(パソコンでは何も足さない)。丸の中の数字は停車の順番で、受け口を 0 として数える
 * (受け口には丸を置かない)。丸が無い駅は、その種類の流れが省く駅。
 */
function Station({ loc, data, stopsOf, children }: { loc: string; data: OfficeView; stopsOf: (l: OfficeView["lines"][number]) => string[]; children: React.ReactNode }) {
  return (
    <div className="of-st">
      <span className="of-strands" aria-hidden="true">
        {KINDS.map((k) => {
          const l = data.lines.find((x) => x.kinds.some((y) => y.kind === k.key));
          const at = l ? stopsOf(l).indexOf(loc) : -1;
          return (
            <i key={k.key} className="of-strand" data-k={k.key}>
              {at > 0 && <b className="of-stopnum">{at}</b>}
            </i>
          );
        })}
      </span>
      {children}
    </div>
  );
}

type Geo = { w: number; h: number; pos: Record<string, { x: number; top: number; bottom: number }>; rowBottom: number };

/** 駅の下に取る、路線を通すための帯の最小の高さ(style.css の .of-st > section の padding-bottom の既定値と同じ)。 */
const BAND = 160;
/** 路線の間隔。路線名のラベル(20px)と、その下の札(24px)が、上の路線の札に重ならない高さ */
const LANE_GAP = 48;
/** 路線から、その名前のラベルの上端までの高さ。札(路線の上下 12px)の上に、ラベルを載せる */
const LABEL_ABOVE = 34;
/** 帯の上端から最初の路線までの高さ。島の中の席・名前より下に、ラベルと札が収まる */
const FIRST_LANE = 68;
/**
 * 路線図。駅(島・受け口・merge 待ち)を通るように、種類ごとの路線を 1 本ずつ引く(駅の下側の帯)。
 * 路線は止まる駅に丸を置き、開発より前の「申し送りだけ」の停車は点線の丸にする。選んだ種類の路線だけが濃くなる。
 * 開いているチケットは、その種類の路線の、いまの駅に札(▲#45)で置く。
 * 駅の上には、許されている連絡経路を点線で引き、答えを待っている質問の封筒を往復させる。
 * 連絡経路タブを開いている間は、保存前の案を、保存してある経路の代わりに引く。
 * 位置は data-loc を付けた駅の大きさから測る(駅の大きさが変わると引き直す)。
 */
function RouteMap({ data, kind, children }: { data: OfficeView; kind: string; children: React.ReactNode }) {
  const map = useRef<HTMLDivElement>(null);
  const [geo, setGeo] = useState<Geo | null>(null);
  const draft = useFormationUi().draftRoutes;
  const measure = () => {
    const m = map.current;
    if (!m) return;
    const box = m.getBoundingClientRect();
    const pos: Geo["pos"] = {};
    let bottom = 0;
    for (const el of m.querySelectorAll<HTMLElement>("[data-loc]")) {
      const loc = el.dataset.loc!;
      if (loc === "done") continue;
      const r = el.getBoundingClientRect();
      pos[loc] = { x: r.left - box.left + m.scrollLeft + r.width / 2, top: r.top - box.top, bottom: r.bottom - box.top };
      if (loc !== "arch") bottom = Math.max(bottom, r.bottom - box.top);
    }
    const next: Geo = { w: m.scrollWidth, h: m.scrollHeight, pos, rowBottom: bottom };
    setGeo((g) => (g && JSON.stringify(g) === JSON.stringify(next) ? g : next));
  };
  useLayoutEffect(measure);
  useEffect(() => {
    const m = map.current;
    if (!m) return;
    const ro = new ResizeObserver(measure);
    ro.observe(m);
    for (const c of m.querySelectorAll("[data-loc]")) ro.observe(c);
    return () => ro.disconnect();
  });
  // 路線ごとの高さ: 折り返しがあると、その分だけ下の路線を下げる。駅の下の帯(band)も、その分だけ広げる
  const order = new Map<string, number>([["lead", 0], ...data.units.map((u, i): [string, number] => [`unit:${u.id}`, i + 1]), ["merge", data.units.length + 1]]);
  const stopsAt = (l: OfficeView["lines"][number]) => ["lead", ...l.stops.map((s) => `unit:${s.unitId}`), "merge"];
  let acc = FIRST_LANE;
  const laneAt = data.lines.map((l) => {
    const at = acc;
    acc += linePath(stopsAt(l).filter((x) => order.has(x)).map((x) => order.get(x)!), 0).turns.length * LEG_GAP + LANE_GAP;
    return at;
  });
  const band = Math.max(BAND, acc - LANE_GAP + 56);
  const lane = (i: number) => (geo ? geo.rowBottom - band + (laneAt[i] ?? FIRST_LANE) : 0);
  const ask = (a: string, b: string): string | null => {
    const pa = geo?.pos[a], pb = geo?.pos[b];
    if (!pa || !pb) return null;
    if (a === "arch" || b === "arch") {
      const [s, e] = a === "arch" ? [pb, pa] : [pa, pb];
      return `M ${s.x} ${geo!.rowBottom} L ${e.x} ${e.top}`;
    }
    const y = Math.min(pa.top, pb.top) - 6;
    return `M ${pa.x} ${y} Q ${(pa.x + pb.x) / 2} ${y - 14 - Math.min(54, Math.abs(pa.x - pb.x) / 7)} ${pb.x} ${y}`;
  };
  // 保存前の案は、駅の名前(島の名前・lead・architect)で来る。保存してある島に無い端の経路は引けない
  const locOfName = new Map<string, string>([["lead", "lead"], ["architect", "arch"], ...data.units.map((u): [string, string] => [u.name, `unit:${u.id}`])]);
  const shown = draft ? draft.flatMap((r) => (locOfName.has(r.a) && locOfName.has(r.b) ? [{ a: locOfName.get(r.a)!, b: locOfName.get(r.b)! }] : [])) : data.routes;
  const routes = shown.map((r) => ({ ...r, d: ask(r.a, r.b) })).filter((r): r is typeof r & { d: string } => r.d !== null);
  const waiting = (r: { a: string; b: string }) => data.asks.some((q) => (q.a === r.a && q.b === r.b) || (q.a === r.b && q.b === r.a));
  const lineName = (l: OfficeView["lines"][number]) => {
    const shapes = l.kinds.map((k) => KIND_SHAPE[k.kind]).join("");
    const names = l.kinds.map((k) => k.label).join("・");
    return l.isDefault ? `${shapes} 既定線(${names})` : `${shapes} ${names}線${l.skipped.length ? `(${l.skipped.join("・")}を省略)` : ""}`;
  };
  const built = geo
    ? data.lines.map((l, i) => {
        const locs = stopsAt(l).filter((x) => geo.pos[x]);
        return { l, i, locs, ...linePath(locs.map((x) => geo.pos[x]!.x), lane(i)) };
      })
    : [];
  // 札: 同じ駅・同じ路線に重なるときは横にずらす
  const slot = new Map<string, number>();
  const tickets = geo
    ? Object.entries(data.where).flatMap(([n, loc]) => {
        const k = data.ticketKinds[Number(n)];
        const b = built.find((x) => x.l.kinds.some((y) => y.kind === k));
        const p = geo.pos[loc];
        if (!k || !b || !p || loc === "done" || loc === "arch") return [];
        const y = b.ys[b.locs.indexOf(loc)] ?? lane(b.i);
        const at = slot.get(`${loc}|${b.i}`) ?? 0;
        slot.set(`${loc}|${b.i}`, at + 1);
        return [{ n: Number(n), k, x: p.x - 24 + at * 52, y, on: kind === "all" || b.l.kinds.some((y) => y.kind === kind) }];
      })
    : [];
  return (
    <div className="of-map" ref={map} data-kind={kind} style={{ "--of-band": `${band}px` } as React.CSSProperties}>
      {children}
      {geo && (
        <svg className="of-rails" width={geo.w} height={geo.h} role="img" aria-label={`路線図: ${data.lines.map((l) => `${lineName(l)}は${["受け口", ...l.stops.map((s) => data.units.find((u) => u.id === s.unitId)?.name ?? s.role), "merge 待ち"].join("→")}`).join("、")}`}>
          {routes.map((r) => (
            <path key={`${r.a}-${r.b}`} className={`of-route${draft ? " of-route-draft" : ""}`} data-route={`${r.a}|${r.b}`} d={r.d} />
          ))}
          {built.map(({ l, locs, d, stops, i }) => {
            const on = kind === "all" || l.kinds.some((x) => x.kind === kind);
            return (
              <g key={i} className={`of-line ${on ? "of-line-on" : "of-line-dim"}`} data-line={l.kinds.map((k) => k.kind).join(" ")}>
                <path d={d} className="of-track" />
                <path d={d} className="of-sleepers" />
                {locs.map((loc, at) => {
                  const pre = at > 0 && at < locs.length - 1 && l.stops[at - 1]?.pre;
                  return <circle key={`${loc}-${at}`} className={pre ? "of-stop of-stop-pre" : "of-stop"} cx={stops[at]!.x} cy={stops[at]!.y} r={7} />;
                })}
              </g>
            );
          })}
        </svg>
      )}
      {built.flatMap(({ l, i, locs, turns }) => {
        const on = kind === "all" || l.kinds.some((x) => x.kind === kind);
        const dim = on ? "" : " of-lbl-dim";
        return [
          <span key={`lbl-${i}`} className={`of-lbl${dim}`} style={{ left: geo!.pos[locs[0]!]!.x + 30, top: lane(i) - LABEL_ABOVE }}>
            {lineName(l)}
          </span>,
          ...(l.stops.some((s) => s.pre) && turns[0]
            ? [
                <span key={`turn-${i}`} className={`of-lbl of-lbl-turn${dim}`} style={{ left: (turns[0].x1 + turns[0].x2) / 2, top: turns[0].y - 10 }}>
                  申し送りを書いて開発へ戻る
                </span>,
              ]
            : []),
        ];
      })}
      {tickets.map((t) => (
        <span key={t.n} className={`of-tk ${t.on ? "" : "of-tk-dim"}`} data-ticket={t.n} data-kind-of={t.k} style={{ left: t.x, top: t.y - 12 }}>
          <span aria-hidden="true">{KIND_SHAPE[t.k]}</span>#{t.n}
        </span>
      ))}
      {routes.filter(waiting).map((r) => (
        <span key={`env-${r.a}-${r.b}`} className="of-env" style={{ offsetPath: `path("${r.d}")` }} role="img" aria-label="答えを待っている質問" data-route={`${r.a}|${r.b}`}>
          ?
        </span>
      ))}
    </div>
  );
}

function Island({ u, running, onEdit, onOpen, onMember }: { u: OfficeView["units"][number]; running: boolean; onEdit: () => void; onOpen: () => void; onMember: (id: number) => void }) {
  const seats = Array.from({ length: u.max }, (_, i) => u.members[i] ?? null);
  const top = seats.slice(0, Math.ceil(u.max / 2));
  const bottom = seats.slice(Math.ceil(u.max / 2));
  // すぐ取れる仕事が無く、順番待ちだけがあるときは、freeの理由を出す(ツールチップ・読み上げ)
  const idleText = !u.waiting.length && u.queued.length ? `free・順番待ち(${queuedSummary(u.queued)})` : undefined;
  return (
    <section className={`of-island of-tone-${u.roleKeys[0] ?? "dev"} ${u.budget.exhausted ? "of-island-broke" : ""}`} data-loc={`unit:${u.id}`} aria-label={`島 ${u.name}`}>
      <header>
        <div className="of-head-row">
          <h3>
            <button type="button" className="of-islandname" aria-label={`${u.name} の様子`} onClick={onOpen}>
              {u.name}
            </button>
          </h3>
          <Btn kind="text" size="xs" aria-label={`${u.name} の設定`} onClick={onEdit}>
            設定
          </Btn>
        </div>
        {/* 役割・人数・モデル・予算などは、島の様子のモーダルで見せる。予算切れは「あなたの対応」にも出る */}
      </header>
      <div className="of-seats of-top">
        {top.map((m, i) => (
          <Seat key={m?.id ?? `e${i}`} m={m} running={running} waitingFor={idleText} onOpen={onMember} />
        ))}
      </div>
      {/* 机は書類の山だけを見せる。押すと島の様子(すぐ取れる仕事・順番待ちとその理由)が開く */}
      <button
        type="button"
        className="of-table"
        aria-label={`${u.name} の机: すぐ取れる仕事 ${u.waiting.length} 件、順番待ち ${u.queued.length} 件(押すと島の様子を見る)`}
        title={[u.waiting.length ? `すぐ取れる: #${u.waiting.join("、#")}` : "すぐ取れる仕事はありません", ...u.queued.map((q) => `#${q.number}: ${q.why}`)].join("\n")}
        onClick={onOpen}
      >
        <Papers n={u.waiting} queued={u.queued} />
        <span className="of-wait">待ち {u.waiting.length}</span>
        <span className="of-mug" aria-hidden="true" />
        <span className="of-plant" aria-hidden="true" />
      </button>
      <div className="of-seats of-bottom">
        {bottom.map((m, i) => (
          <Seat key={m?.id ?? `f${i}`} m={m} below running={running} waitingFor={idleText} onOpen={onMember} />
        ))}
      </div>
    </section>
  );
}

/** 机の上の書類の山。すぐ取れる仕事は白い紙、順番待ちは灰色の紙で積む(文字は出さない)。 */
function Papers({ n, queued }: { n: number[]; queued: { number: number; why: string }[] }) {
  const level = n.length >= 5 ? "of-hot" : n.length >= 3 ? "of-warn" : "";
  return (
    <div className={`of-papers ${level}`} aria-hidden="true">
      <div className="of-stack">
        {Array.from({ length: Math.min(8, n.length) }, (_, i) => (
          <i key={i} style={{ bottom: i * 4 }} />
        ))}
      </div>
      {queued.length > 0 && (
        <div className="of-stack of-stack-queued">
          {Array.from({ length: Math.min(8, queued.length) }, (_, i) => (
            <i key={i} style={{ bottom: i * 4 }} />
          ))}
        </div>
      )}
    </div>
  );
}

/** 順番待ちの理由を短くまとめる(同じ理由はまとめる)。 */
function queuedSummary(queued: { number: number; why: string }[]): string {
  const byWhy = new Map<string, number[]>();
  for (const q of queued) byWhy.set(q.why, [...(byWhy.get(q.why) ?? []), q.number]);
  return [...byWhy].map(([why, ns]) => `#${ns.join("・#")} は ${why}`).join("、");
}

function Seat({ m, below, running, waitingFor, onOpen }: { m: Member | null; below?: boolean; running: boolean; waitingFor?: string; onOpen: (id: number) => void }) {
  if (!m) return <div className="of-seat of-empty" aria-hidden="true" />;
  return <Person m={m} below={below} running={running} waitingFor={waitingFor} onOpen={onOpen} />;
}

/**
 * 席にいるメンバー。名札と短い状態(何番を何しているか・free)と、吹き出し(今していること)だけを出す。
 * モデル・経過時間・途中経過・これまでの仕事は、押すと開く様子のモーダルで見せる。
 * 終業中でfreeなら居眠り、始業していてfreeなら起きて仕事を待つ。
 */
function Person({ m, below, title, running, waitingFor, onOpen }: { m: { id: number; name: string; helper?: boolean; joinedAt?: string; work: Work | null }; below?: boolean; title?: string; running: boolean; waitingFor?: string; onOpen: (id: number) => void }) {
  const now = useNow();
  const selected = useContext(Selected) === m.id;
  const w = m.work;
  const role = w ? (ROLE_CLASS[w.role] ?? "dev") : "idle";
  const quiet = w ? Math.round((now - Date.parse(w.lastActivityAt)) / 1000) : 0;
  const fresh = m.joinedAt ? now - Date.parse(m.joinedAt) < 8000 : false;
  const say = w ? (w.lastStep ?? w.live) : null;
  const asleep = !w && !running;
  const status = w
    ? `${w.ticket ? `#${w.ticket} ` : ""}${w.kind}中${quiet >= QUIET_WARN_SEC ? `・${duration(quiet)}動きなし` : ""}`
    : asleep
      ? "終業中"
      : (waitingFor ?? "free・仕事を待っています");
  return (
    <button
      type="button"
      className={`of-seat of-person ${w ? "of-working" : asleep ? "of-idle" : "of-ready"} ${below ? "of-below" : ""} ${fresh ? "of-arrive" : ""} ${selected ? "of-sel" : ""} ${quiet >= QUIET_WARN_SEC ? "of-quiet" : ""}`}
      aria-label={`${m.name}${title ? `(${title})` : ""}${m.helper ? "(応援)" : ""} ${status}(押すと様子を見る)`}
      title={`${m.name} ${status}`}
      aria-pressed={selected}
      onClick={() => onOpen(m.id)}
    >
      {say && (
        <div className="of-bubble">
          <span>{say}</span>
        </div>
      )}
      {/* freeのメンバーは、直前の仕事の代わりに「♪ free」を話す(パソコン。スマホは名札の「free」で出す) */}
      {!w && !asleep && (
        <div className="of-bubble of-bubble-free">
          <span>♪ free</span>
        </div>
      )}
      <Avatar name={m.name} asleep={asleep} className={`of-r-${role}`} />
      {asleep && (
        <span className="of-zz" aria-hidden="true">
          zz
        </span>
      )}
      {/* 下には名前と「free」だけ。何をしているか・freeの理由・応援かは、押すと開く様子のモーダルと、読み上げ・ツールチップで伝える */}
      <div className="of-tag">
        <b>{m.name}</b>
        {selected && <span className="of-selmark">選択中</span>}
        {/* 暇しているかだけは、押さなくても一目でわかるようにする */}
        {!w && !asleep && <span className="of-free">free</span>}
      </div>
    </button>
  );
}

function Desk({ title, label, who, loc, note, sticky, running, waitingFor, onMember }: { title: string; label?: string; who: { id: number; name: string; work: Work | null }; loc: string; note: string; sticky?: string; running: boolean; waitingFor: string; onMember: (id: number) => void }) {
  const role = label ?? title;
  return (
    <section className="of-desk" data-loc={loc} aria-label={`${role}の机`}>
      <h3 title={note}>{title}</h3>
      {label && <div className="hint">{label}</div>}
      {sticky && <span className="of-sticky">{sticky}</span>}
      <Person m={who} title={role} running={running} waitingFor={waitingFor} onOpen={onMember} />
    </section>
  );
}

function MergeShelf({ id, q, auto }: { id: number; q: OfficeView["mergeQueue"]; auto: boolean }) {
  const act = useAct();
  return (
    <section className="of-shelf" data-loc="merge" aria-label="merge 待ちの棚">
      <h3>merge 待ち {q.length}</h3>
      {auto && q.length > 0 && <div className="hint">CI と確認が済み次第、チームが merge します</div>}
      {q.length === 0 && <div className="hint">まだありません</div>}
      <ul>
        {q.map((t) => (
          <li key={t.id}>
            <TicketLink id={t.id}>
              #{t.number} {t.title}
            </TicketLink>
            <Btn
              kind="solid-fill"
              size="xs"
              aria-label={`#${t.number} を merge`}
              onClick={() =>
                act(
                  () => post<{ result: string; reason?: string }>(`/projects/${id}/merge/${t.id}`),
                  (r) => (r.result === "merged" ? "merge しました" : `merge できませんでした: ${r.reason}`),
                )
              }
            >
              merge
            </Btn>
            {t.unblocks && <div className="of-unblocks">{unblockText(t.unblocks)}</div>}
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * 書類の居場所が変わったチケットを見つけ、元の場所から新しい場所へ書類を飛ばす。
 * 場所は data-loc を付けた要素(島・棚・机)の位置で決める。動きを減らす設定のときは飛ばさない。
 */
type Flight = { key: string; n: number; x: number; y: number; dx: number; dy: number; go: boolean };
function useFlights(floor: React.RefObject<HTMLDivElement | null>, where: Record<number, string> | undefined): Flight[] {
  const prev = useRef<Record<number, string> | null>(null);
  const [flights, setFlights] = useState<Flight[]>([]);
  useLayoutEffect(() => {
    if (!where || !floor.current) return;
    const before = prev.current;
    prev.current = where;
    if (!before || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const box = floor.current.getBoundingClientRect();
    const center = (loc: string) => {
      const el = floor.current!.querySelector(`[data-loc="${loc}"]`);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left - box.left + r.width / 2, y: r.top - box.top + r.height / 2 };
    };
    const added: Flight[] = [];
    for (const [k, to] of Object.entries(where)) {
      const from = before[Number(k)];
      if (!from || from === to) continue;
      const a = center(from), b = center(to);
      if (!a || !b) continue;
      added.push({ key: `${k}-${Date.now()}`, n: Number(k), x: a.x, y: a.y, dx: b.x - a.x, dy: b.y - a.y, go: false });
    }
    if (!added.length) return;
    setFlights((f) => [...f, ...added]);
    requestAnimationFrame(() => requestAnimationFrame(() => setFlights((f) => f.map((x) => (added.some((a) => a.key === x.key) ? { ...x, go: true } : x)))));
    const keys = new Set(added.map((a) => a.key));
    setTimeout(() => setFlights((f) => f.filter((x) => !keys.has(x.key))), 1400);
  }, [where, floor]);
  useEffect(() => {
    return () => {
      prev.current = null;
    };
  }, []);
  return flights;
}
