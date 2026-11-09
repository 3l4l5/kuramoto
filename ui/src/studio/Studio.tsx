import { useEffect, useRef, useState, type FormEvent } from "react";
import { post, type StudioView } from "../api";
import { duration, useAct, useNow, useStudio } from "../hooks";
import { QuietText } from "../Project";
import { StageWork, type Ui } from "./Work";
import { Btn, LinkBtn } from "../ui";
import { Input } from "../dads/Input";

export type Stage = StudioView["stages"][number];
export type Work = StudioView["work"][string];

export type Cast = StudioView["cast"];
/** 段階ごとの担当の名前。名前はサーバー(src/domain/cast.ts)から受け取る。 */
export const ownerOf = (c: Cast, stage: string): string =>
  ({ req: c.planner, flow: c.designer, screen: c.designer, infra: c.architect, model: c.architect, handoff: c.lead })[stage] ?? "";
const whoOf = (c: Cast, who: string): [string, string] =>
  (
    ({
      plan: [`${c.planner}(企画)`, "plan"],
      design: [`${c.designer}(デザイナー)`, "design"],
      arch: [`${c.architect}(アーキテクト)`, "arch"],
      lead: [`${c.lead}(リーダー)`, "lead"],
    }) as Record<string, [string, string]>
  )[who] ?? ["Kuramoto", "system"];

/** 企画スタジオ(docs/design.md 6.2)。 */
export function Studio({ id }: { id: number }) {
  const { data } = useStudio(id);
  const [ui, setUiState] = useState<Ui>({ stage: null, scr: null, node: null, commentMode: false, pin: null, ask: null });
  const setUi = (patch: Partial<Ui>) => setUiState((u) => ({ ...u, ...patch }));
  useEffect(() => {
    setUiState({ stage: null, scr: null, node: null, commentMode: false, pin: null, ask: null });
  }, [id]);
  if (!data) return <section aria-label="企画スタジオ" />;
  const stage = ui.stage ?? (data.handoff.requested ? "handoff" : (data.stages.find((s) => !s.done) ?? data.stages[data.stages.length - 1]!).key);
  const select = (s: string) => setUi({ stage: s, pin: null, ask: null, commentMode: false });
  return (
    <section aria-label="企画スタジオ">
      <div className="studio">
        <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
          <h2 style={{ margin: 0, fontFamily: "var(--f-display)", fontSize: 18 }}>{data.project.name} · 企画スタジオ</h2>
          <span style={{ fontSize: 12, color: "var(--muted)" }}>段階ごとに合意した版を残し、すべて終わったらチームに渡します</span>
          <LinkBtn kind="outline" size="sm" className="exportbtn" href={`/api/projects/${id}/studio/export`} download>
            設計書をエクスポート(Markdown)
          </LinkBtn>
        </div>
        <Gates d={data} pid={id} stage={stage} select={select} />
        <div className="sbody">
          <Chat d={data} pid={id} stage={stage} />
          <section className="swork" aria-label="作業の場">
            <StageWork d={data} pid={id} stage={stage} ui={ui} setUi={setUi} />
          </section>
        </div>
      </div>
    </section>
  );
}

function Gates({ d, pid, stage, select }: { d: StudioView; pid: number; stage: string; select: (s: string) => void }) {
  const act = useAct();
  const h = d.handoff;
  const hand = async () => {
    const r = await act(() => post(`/projects/${pid}/studio/handoff`), `チームに渡しました。${d.cast.lead}がチケットを作ります`);
    if (r) select("handoff");
  };
  return (
    <nav className="gates" aria-label="段階">
      {d.stages.map((s, i) => (
        <button type="button" key={s.key} className="gate" aria-current={stage === s.key ? "step" : undefined} onClick={() => select(s.key)}>
          <span className="n">
            {i + 1}
            {s.thinking ? ` · ${ownerOf(d.cast, s.key)}が作業中…` : ""}
          </span>
          <span className="t">{s.label}</span>
          <span className={`st ${s.done ? "ok" : "wip"}`}>{s.status}</span>
        </button>
      ))}
      {h.requested || h.handed ? (
        <button type="button" className="gate hand" aria-current={stage === "handoff" ? "step" : undefined} onClick={() => select("handoff")}>
          {h.handed ? "渡しました" : `${d.cast.lead}がチケットを作っています…`}
        </button>
      ) : (
        <button type="button" className="gate hand" disabled={!!h.blocker} title={h.blocker ?? undefined} onClick={hand}>
          チームに渡す
        </button>
      )}
    </nav>
  );
}

function Chat({ d, pid, stage }: { d: StudioView; pid: number; stage: string }) {
  const act = useAct();
  const [text, setText] = useState("");
  const list = d.messages.filter((m) => m.stage === stage);
  const work = d.work[stage];
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [list.length, stage, work?.state, work && "steps" in work ? work.steps.length : 0]);
  const send = async (e: FormEvent) => {
    e.preventDefault();
    const t = text.trim();
    if (!t) return;
    setText("");
    await act(() => post(`/projects/${pid}/studio/chat`, { stage, text: t }));
  };
  return (
    <section className="strio" aria-label="企画の 3 人との会話">
      <div style={{ padding: "12px 14px", borderBottom: "1px solid var(--line)" }}>
        <b style={{ fontFamily: "var(--f-display)" }}>
          企画 {d.cast.planner} · デザイナー {d.cast.designer} · アーキテクト {d.cast.architect}
        </b>
      </div>
      <div className="chat-list" ref={box}>
        {list.map((m) =>
          m.who === "me" ? (
            <div className="msg me" key={m.id}>
              {m.body}
            </div>
          ) : (
            <div className={`msg ${whoOf(d.cast, m.who)[1]}`} key={m.id}>
              <div className="who">{whoOf(d.cast, m.who)[0]}</div>
              <div className="body" style={{ whiteSpace: "pre-wrap" }}>
                {m.body}
              </div>
            </div>
          ),
        )}
        {work && <WorkBox w={work} who={ownerOf(d.cast, stage)} />}
        {!list.length && !work && <div style={{ color: "var(--muted)", fontSize: 12 }}>{stage === "handoff" ? "" : "まだ会話はありません。"}</div>}
      </div>
      <div id="st-in-hint" className="hint compose-hint">{stage === "handoff" ? `${d.cast.lead}(リーダー)に話す` : `${ownerOf(d.cast, stage)}に話す(この段階について)`}</div>
      <form className="compose" onSubmit={send}>
        <label htmlFor="st-in" className="sr">
          メッセージ
        </label>
        <Input id="st-in" type="text" blockSize="md" className="grow" autoComplete="off" aria-describedby="st-in-hint" value={text} onChange={(e) => setText(e.target.value)} />
        <Btn kind="solid-fill" type="submit">
          送る
        </Btn>
      </form>
    </section>
  );
}

const STEP_LABEL: Record<string, string> = { thinking: "考え", tool: "作業", text: "メモ", status: "状態" };

/** 途中経過。止まっていないことが分かるよう、経過時間と最後の動きからの時間を 1 秒ごとに更新する。 */
function WorkBox({ w, who }: { w: Work; who: string }) {
  const now = useNow();
  if (w.state === "queued")
    return (
      <div className="workbox queued">
        <div className="wh">
          <b>{who}の順番待ち</b>
        </div>
        <div className="live">前の作業が終わると始まります</div>
      </div>
    );
  const elapsed = Math.max(0, Math.round((now - Date.parse(w.startedAt)) / 1000));
  const quiet = Math.max(0, Math.round((now - Date.parse(w.lastActivityAt)) / 1000));
  return (
    <div className={`workbox${quiet >= 90 ? " quiet" : ""}`}>
      <div className="wh">
        <span className="spin" aria-hidden="true" />
        <b>{w.member}が作業中</b>
        <span className="el">経過 {duration(elapsed)}</span>
      </div>
      <div className="live">
        <span>{w.live ?? ""}</span> · <QuietText sec={quiet} />
      </div>
      {w.steps.length > 0 && (
        <ol className="steps">
          {w.steps.map((s, i) => (
            <li className={`k-${s.kind}`} key={i}>
              <span className="sk">{STEP_LABEL[s.kind] ?? ""}</span>
              <span>{s.text}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
