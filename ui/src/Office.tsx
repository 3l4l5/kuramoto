import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, post, type OfficeView } from "./api";
import { duration, useAct, useNow } from "./hooks";
import { Btn } from "./ui";
import { unblockText, usd } from "./format";
import { TicketLink } from "./Ticket";
import { Avatar } from "./Avatar";
import { IslandDialog } from "./IslandDialog";
import { MemberDialog, UnitDialog } from "./OfficeDialogs";
import { MAX_UNITS } from "../../src/domain/formation";

/**
 * バーチャルオフィス(docs/design.md 6.3)。島ごとの机にメンバーが座り、作業中は手元が光って体が揺れ、
 * 今していることを吹き出しで話す。チケットが工程を進むと、書類が次の島や merge 待ちの棚へ飛ぶ。
 * すべて記録(起動・受信箱・チケット)から組み立てる。
 */
const useOffice = (id: number) => useQuery({ queryKey: ["office", id], queryFn: () => api<OfficeView>("GET", `/projects/${id}/office`), refetchInterval: 2000 });

type Member = OfficeView["units"][number]["members"][number];
type Work = NonNullable<Member["work"]>;

const ROLE_CLASS: Record<string, string> = { 開発: "dev", レビュー: "review", セキュリティ: "sec", QA: "qa", リーダー: "lead", アーキテクト: "arch", 企画: "plan", デザイナー: "design" };
const QUIET_WARN_SEC = 90;

export function OfficeFloor({ id }: { id: number }) {
  const { data } = useOffice(id);
  const floor = useRef<HTMLDivElement>(null);
  const flights = useFlights(floor, data?.where);
  const [edit, setEdit] = useState<{ name: string | null } | null>(null);
  // 様子のモーダル(メンバー・島)。席の下には短い状態だけを出し、詳しいことはここで見せる
  const [member, setMember] = useState<number | null>(null);
  const [unit, setUnit] = useState<number | null>(null);
  if (!data) return <section className="officefloor" aria-label="オフィスの床" />;
  return (
    <section className="officefloor" aria-label="オフィスの床" ref={floor}>
      <div className="of-islands">
        {data.units.map((u) => (
          <Island key={u.id} u={u} running={data.running} onEdit={() => setEdit({ name: u.name })} onOpen={() => setUnit(u.id)} onMember={setMember} />
        ))}
        {data.units.length < MAX_UNITS && (
          <button type="button" className="of-addisland" onClick={() => setEdit({ name: null })}>
            <span aria-hidden="true">＋</span>
            島を足す
            <small>あと {MAX_UNITS - data.units.length} つ</small>
          </button>
        )}
      </div>
      {edit && <IslandDialog id={id} name={edit.name} close={() => setEdit(null)} />}
      {member !== null && <MemberDialog projectId={id} memberId={member} close={() => setMember(null)} />}
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
      <aside className="of-side">
        <Desk onMember={setMember} title="リーダー" who={data.lead} running={data.running} waitingFor="判断・チャットを待っています" loc="lead" note={data.lead.decisions.length ? `判断待ち ${data.lead.decisions.length} 件(#${data.lead.decisions.join("、#")})` : "判断待ちはありません"} />
        <Desk onMember={setMember} title="アーキテクト" who={data.architect} running={data.running} waitingFor="相談を待っています" loc="arch" note="設計の相談役" />
        <MergeShelf id={id} q={data.mergeQueue} auto={data.autoMerge} />
        <section className="of-donepile" data-loc="done" aria-label="merge 済み">
          <h3>merge 済み</h3>
          <div className="of-stack" aria-hidden="true">
            {Array.from({ length: Math.min(8, data.done.count) }, (_, i) => (
              <i key={i} style={{ bottom: i * 4 }} />
            ))}
          </div>
          <div className="hint">{data.done.count ? `${data.done.count} 件(#${data.done.recent.join("、#")})` : "まだありません"}</div>
        </section>
      </aside>
      {flights.map((f) => (
        <div key={f.key} className="of-flight" style={{ left: f.x, top: f.y, transform: f.go ? `translate(${f.dx}px, ${f.dy}px)` : "none" }} aria-hidden="true">
          #{f.n}
        </div>
      ))}
    </section>
  );
}

function Island({ u, running, onEdit, onOpen, onMember }: { u: OfficeView["units"][number]; running: boolean; onEdit: () => void; onOpen: () => void; onMember: (id: number) => void }) {
  const seats = Array.from({ length: u.max }, (_, i) => u.members[i] ?? null);
  const top = seats.slice(0, Math.ceil(u.max / 2));
  const bottom = seats.slice(Math.ceil(u.max / 2));
  // すぐ取れる仕事が無く、順番待ちだけがあるときは、手すきの理由を出す(ツールチップ・読み上げ)
  const idleText = !u.waiting.length && u.queued.length ? `手すき・順番待ち(${queuedSummary(u.queued)})` : undefined;
  return (
    <section className={`of-island ${u.budget.exhausted ? "of-island-broke" : ""}`} data-loc={`unit:${u.id}`} aria-label={`島 ${u.name}`}>
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
 * 席にいるメンバー。名札と短い状態(何番を何しているか・手すき)と、吹き出し(今していること)だけを出す。
 * モデル・経過時間・途中経過・これまでの仕事は、押すと開く様子のモーダルで見せる。
 * 終業中で手すきなら居眠り、始業していて手すきなら起きて仕事を待つ。
 */
function Person({ m, below, title, running, waitingFor, onOpen }: { m: { id: number; name: string; helper?: boolean; joinedAt?: string; work: Work | null }; below?: boolean; title?: string; running: boolean; waitingFor?: string; onOpen: (id: number) => void }) {
  const now = useNow();
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
      : (waitingFor ?? "手すき・仕事を待っています");
  return (
    <button
      type="button"
      className={`of-seat of-person ${w ? "of-working" : asleep ? "of-idle" : "of-ready"} ${below ? "of-below" : ""} ${fresh ? "of-arrive" : ""} ${quiet >= QUIET_WARN_SEC ? "of-quiet" : ""}`}
      aria-label={`${m.name}${title ? `(${title})` : ""}${m.helper ? "(応援)" : ""} ${status}(押すと様子を見る)`}
      title={`${m.name} ${status}`}
      onClick={() => onOpen(m.id)}
    >
      {say && (
        <div className="of-bubble">
          <span>{say}</span>
        </div>
      )}
      <Avatar name={m.name} asleep={asleep} className={`of-r-${role}`} />
      {asleep && (
        <span className="of-zz" aria-hidden="true">
          zz
        </span>
      )}
      {/* 下には名前と「手すき」だけ。何をしているか・手すきの理由・応援かは、押すと開く様子のモーダルと、読み上げ・ツールチップで伝える */}
      <div className="of-tag">
        <b>{m.name}</b>
        {/* 暇しているかだけは、押さなくても一目でわかるようにする */}
        {!w && !asleep && <span className="of-free">手すき</span>}
      </div>
    </button>
  );
}

function Desk({ title, who, loc, note, running, waitingFor, onMember }: { title: string; who: { id: number; name: string; work: Work | null }; loc: string; note: string; running: boolean; waitingFor: string; onMember: (id: number) => void }) {
  return (
    <section className="of-desk" data-loc={loc} aria-label={`${title}の机`}>
      <h3 title={note}>{title}</h3>
      <Person m={who} title={title} running={running} waitingFor={waitingFor} onOpen={onMember} />
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
