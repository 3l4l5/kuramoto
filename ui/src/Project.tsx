import { useState, type FormEvent } from "react";
import { post, type ProjectView } from "./api";
import { TicketTree } from "./Tree";
import { areaWaitText, hhmm, kfmt, pct, stalledText, timeLeft, unblockText, usd, waitText } from "./format";
import { duration, go, useAct, useNow, useProject } from "./hooks";
import { TeamDrawer, type Drawer } from "./Team";
import { OfficeFloor } from "./Office";
import { TicketLink, TicketProvider } from "./Ticket";
import { Btn } from "./ui";
import { Input } from "./dads/Input";
import { Textarea } from "./dads/Textarea";
import { MODELS } from "../../src/domain/roles";
import { castName } from "../../src/domain/cast";

const FIXED_LEAD = castName("lead");

type Ticket = ProjectView["tickets"][number];
type Decision = ProjectView["decisions"][number];
type Pr = Ticket["pr"];

const QUIET_WARN_SEC = 90;

/** オフィス(docs/design.md 6.3)。俯瞰の絵はまだ無く、ボードで見せる。 */
export function ProjectPage({ id, drawer, closeDrawer }: { id: number; drawer: Drawer | null; closeDrawer: () => void }) {
  const { data } = useProject(id);
  if (!data) return <section className="pview" aria-label="プロジェクト" />;
  return (
    <TicketProvider projectId={id}>
      <div className="layout">
        <div className="main">
          <Office id={id} data={data} />
        </div>
        {drawer && <TeamDrawer id={id} drawer={drawer} close={closeDrawer} />}
      </div>
    </TicketProvider>
  );
}

function Office({ id, data }: { id: number; data: ProjectView }) {
  return (
    <section className="pview" aria-label="プロジェクト">
      {!data.project.handed && (
        <div className="panel" style={{ borderColor: "var(--design)", background: "var(--design-soft)" }}>
          <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <span>まだ企画スタジオで、どんなアプリを作るかを決めています。すべての段階が終わってチームに渡すと、ここにチケットが並びます。</span>
            <Btn kind="outline" size="sm" style={{ marginLeft: "auto" }} onClick={() => go(`#/p/${id}/studio`)}>
              企画スタジオを開く
            </Btn>
          </div>
        </div>
      )}
      <Inbox d={data} />
      <FloorOrBoard id={id} data={data} />
      <div className="two-col">
        <NewTicket id={id} />
        <section className="panel" aria-label="出来事">
          <h2>出来事</h2>
          <Events d={data} />
        </section>
      </div>
      <div className="two-col">
        <section className="panel" aria-label="指標">
          <h2>指標</h2>
          <Kpis d={data} />
        </section>
        <section className="panel" aria-label="編成">
          <h2>編成</h2>
          <Formation d={data} />
        </section>
      </div>
    </section>
  );
}

// ---- オフィスの床 / ボード ----

function FloorOrBoard({ id, data }: { id: number; data: ProjectView }) {
  const [view, setView] = useState<"floor" | "board" | "tree">("floor");
  const VIEWS = { floor: "オフィス", board: "ボード", tree: "ツリー" } as const;
  return (
    <section className="panel" aria-label={VIEWS[view]}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <h2>{VIEWS[view]}</h2>
        <div role="group" aria-label="オフィスの見方" style={{ display: "flex", gap: 4, marginLeft: "auto" }}>
          {(Object.keys(VIEWS) as (keyof typeof VIEWS)[]).map((v) => (
            <Btn key={v} kind={view === v ? "solid-fill" : "outline"} size="sm" aria-pressed={view === v} onClick={() => setView(v)}>
              {VIEWS[v]}
            </Btn>
          ))}
        </div>
      </div>
      {view === "floor" ? <OfficeFloor id={id} /> : view === "board" ? <Board d={data} /> : <TicketTree d={data} />}
    </section>
  );
}

// ---- あなたの対応 ----

function Inbox({ d }: { d: ProjectView }) {
  const [all, setAll] = useState(false);
  const byId = new Map(d.tickets.map((t) => [t.id, t]));
  const merges = d.mergeOrder.flatMap((tid, i) => {
    const t = byId.get(tid);
    return t ? [{ t, order: i + 1 }] : [];
  });
  // 自動 merge のときは、merge はチームの仕事なので「あなたの対応」には出さない(ADR-0022)
  const items: ({ kind: "decide"; d: Decision } | { kind: "merge"; t: Ticket; order: number })[] = [
    ...d.decisions.map((x) => ({ kind: "decide" as const, d: x })),
    ...(d.autoMerge ? [] : merges.map((m) => ({ kind: "merge" as const, ...m }))),
  ];
  const ownerMerges = d.autoMerge ? 0 : merges.length;
  const shown = all ? items : items.slice(0, 3);
  return (
    <section className="inbox" aria-label="あなたの対応" aria-live="polite">
      <header>
        <h2>あなたの対応</h2>
        <span className="cnt">{items.length}</span>
        <span className="sub">{items.length ? `判断 ${d.decisions.length} 件${ownerMerges ? ` · merge ${ownerMerges} 件` : ""}。チームの中で片付くものはここに出ません` : ""}</span>
        {items.length > 3 && (
          <Btn kind="text" size="sm" className="more" onClick={() => setAll(!all)}>
            {all ? "上位 3 件だけ表示" : `すべて表示(${items.length} 件)`}
          </Btn>
        )}
      </header>
      <BudgetAlerts d={d} />
      {d.autoMerge && merges.length > 0 && (
        <p className="hint" style={{ margin: "0 0 8px" }}>
          merge 待ち {merges.length} 件(#{merges.map((m) => m.t.number).join("・#")})は、CI と確認が済み次第チームが merge します。あなたの対応は要りません(オフィスの「merge 待ちの棚」から今すぐ merge することもできます)。
        </p>
      )}
      {items.length ? (
        <div className="items">
          {shown.map((x) => (x.kind === "decide" ? <DecisionCard key={`d${x.d.id}`} pid={d.project.id} d={x.d} /> : <MergeCard key={`m${x.t.id}`} pid={d.project.id} t={x.t} order={x.order} auto={d.autoMerge} />))}
        </div>
      ) : (
        <div className="empty">
          今あなたが対応することはありません。{d.running ? "チームは自分たちで進めています。" : "チームは終業中です。右上の「始業」で始めます。"}
        </div>
      )}
    </section>
  );
}

function PrLink({ pr }: { pr: Pr }) {
  if (!pr) return null;
  return (
    <a href={`https://github.com/${pr.full_name}/pull/${pr.number}`} target="_blank" rel="noopener">
      {pr.full_name}#{pr.number}
    </a>
  );
}

function DecisionCard({ pid, d }: { pid: number; d: Decision }) {
  const act = useAct();
  const now = useNow();
  const [note, setNote] = useState("");
  const lines = d.question.split("\n");
  const q = lines.pop();
  const where = lines.join(" ");
  const t = d.ticket;
  return (
    <article className="item decide">
      <div className="top">
        <span className="kind">判断</span>
        <span className="where">
          <TicketLink id={t.id}>
            #{t.number} {t.title}
          </TicketLink>
          {t.owner ? ` · 持ち主 ${t.owner}` : ""}
          {where ? ` · ${where}` : ""}
        </span>
        <span className="due">{timeLeft(d.deadline, now)}</span>
      </div>
      <div className="q">{q}</div>
      {d.leadNote && (
        <div className="leadnote">
          <b>{FIXED_LEAD}(リーダー)から</b>
          <p style={{ whiteSpace: "pre-wrap" }}>{d.leadNote}</p>
        </div>
      )}
      <dl>
        <dt>推奨</dt>
        <dd>
          {d.options[d.recommended]}。{d.why}
        </dd>
        <dt>{d.impact.startsWith("- 指摘") || d.impact.startsWith("[") ? "残っている指摘" : "間違えると"}</dt>
        <dd style={{ whiteSpace: "pre-wrap" }}>
          {d.impact}({d.reversible ? "戻せる" : <b>戻せない</b>})
        </dd>
        <dt>返事が無いと</dt>
        <dd>{d.deadline ? "期限が来たら推奨で進みます" : "あなたが選ぶまで止まっています"}</dd>
      </dl>
      <div className="answer">
        <label className="h" htmlFor={`dc-note-${d.id}`} style={{ fontSize: 14 }}>
          答え・指示(任意。チケットのメモになり、次に動く担当が読みます)
        </label>
        <Textarea id={`dc-note-${d.id}`} rows={d.leadNote ? 4 : 2} className="w-full" value={note} onChange={(e) => setNote(e.target.value)} />
      </div>
      <div className="choices">
        {d.options.map((o, i) => (
          <Btn
            key={i}
            size="sm"
            kind={i === d.recommended ? "solid-fill" : "outline"}
            onClick={() => act(() => post(`/projects/${pid}/decisions/${d.id}`, { choice: i, note }), note.trim() ? "答えました。書いた答えはチケットのメモとして担当に伝わります" : "答えました。持ち主に伝えます")}
          >
            {o}
            {i === d.recommended && <small>(推奨)</small>}
          </Btn>
        ))}
      </div>
      {d.pr && (
        <div className="links">
          <span>
            証拠: <PrLink pr={d.pr} />
          </span>
        </div>
      )}
    </article>
  );
}

/** 予算を使い切って止まっているものを、責任者の対応の先頭に出す。 */
function BudgetAlerts({ d }: { d: ProjectView }) {
  const broke = d.budget.units.filter((u) => u.exhausted);
  if (!d.budget.project.exhausted && !broke.length) return null;
  return (
    <div className="budgetalert" role="alert">
      {d.budget.project.exhausted && (
        <p>
          <b>全体の予算({usd(d.budget.project.budgetUsd)})を使い切ったので、チームは止まっています。</b>
          <a href={`#/p/${d.project.id}/settings`}>プロジェクトの設定</a>で予算を足すか、無制限にすると再開します。
        </p>
      )}
      {broke.map((u) => (
        <p key={u.name}>
          <b>
            {u.name}の予算({usd(u.budgetUsd)})を使い切りました。
          </b>
          この島には仕事が回りません。オフィスの島の「設定」で予算を足すと再開します。
        </p>
      ))}
    </div>
  );
}

function MergeCard({ pid, t, order, auto }: { pid: number; t: Ticket; order: number; auto: boolean }) {
  const act = useAct();
  const [busy, setBusy] = useState(false);
  const pr = t.pr;
  const checked = pr?.fetched_at ? `CI ${pr.ci ?? "?"} · ${pr.mergeable ?? "?"}(${hhmm(pr.fetched_at)} 時点)` : "押した瞬間に CI・衝突・レビューを確かめ直します";
  const merge = async () => {
    setBusy(true);
    await act(
      () => post<{ result: string; reason?: string }>(`/projects/${pid}/merge/${t.id}`),
      (r) => (r.result === "merged" ? "merge しました" : `merge できませんでした: ${r.reason}`),
    );
    setBusy(false);
  };
  return (
    <article className="item merge">
      <div className="top">
        <span className="kind">merge</span>
        <span className="where">
          推奨 {order} 番目{t.owner ? ` · 持ち主 ${t.owner}` : ""}
        </span>
      </div>
      <div className="q">
        <TicketLink id={t.id}>
          #{t.number} {t.title}
        </TicketLink>
      </div>
      {stalledText(t.number, t.unblocks) && <p className="stalled">{stalledText(t.number, t.unblocks)}</p>}
      <dl>
        <dt>確認済み</dt>
        <dd>
          レビュー済み({t.rounds} 往復)· {checked}
        </dd>
        <dt>押すと</dt>
        <dd>
          {auto && (
            <>
              <b>チームが自動で merge します(CI と確認が済み次第)。待たずに今 merge するなら押してください。</b>
              <br />
            </>
          )}
          main に入り、残りの merge 待ちの衝突を確かめ直します
          {unblockText(t.unblocks) && (
            <>
              <br />
              <b>{unblockText(t.unblocks)}</b>
            </>
          )}
        </dd>
      </dl>
      <div className="choices">
        <Btn kind="solid-fill" size="sm" disabled={busy} onClick={merge}>
          merge する
        </Btn>
      </div>
      {pr && (
        <div className="links">
          <span>
            差分: <PrLink pr={pr} />
          </span>
        </div>
      )}
    </article>
  );
}

// ---- ボード ----

function Board({ d }: { d: ProjectView }) {
  const now = useNow();
  // 開発の工程は、まだ誰も手を付けていない「未着手」と、取りかかった・直しに戻った「開発中」に分ける
  const cols: [string, string][] = [
    ...d.stages.flatMap((s): [string, string][] => (s.key === "dev" ? [["todo", "未着手"], ["dev", "開発中(直し含む)"]] : [[s.key, s.label]])),
    ["decision", "判断待ち"],
    ["merge", "merge 待ち"],
    ["done", "完了"],
  ];
  const colOf = (t: ProjectView["tickets"][number]) => (t.stage === "dev" && !t.started ? "todo" : t.stage);
  return (
    <div className="board-wrap">
      <div className="board" style={{ gridTemplateColumns: `repeat(${cols.length}, minmax(170px, 1fr))` }}>
        {cols.map(([k, label]) => {
          const list = d.tickets.filter((t) => colOf(t) === k);
          return (
            <div className="col" key={k}>
              <h3>
                {label}
                <span>{list.length}</span>
              </h3>
              {list.map((t) => {
                const wk = t.worker?.work;
                const quiet = wk ? Math.max(0, Math.round((now - Date.parse(wk.lastActivityAt)) / 1000)) : 0;
                return (
                  <div className={`card${wk && quiet >= QUIET_WARN_SEC ? " quiet" : ""}`} key={t.id}>
                    <span className="id">
                      <span>
                        #{t.number}
                        {t.jiraKey ? ` · ${t.jiraKey}` : ""}
                      </span>
                      <span>{t.conflict ? <span className="cf">衝突</span> : t.rounds ? `往復 ${t.rounds}` : ""}</span>
                    </span>
                    <TicketLink id={t.id}>{t.title}</TicketLink>
                    {t.worker ? (
                      <>
                        <span className="wk">
                          {t.worker.name} が{t.worker.role}中{wk && <span className="el"> · 経過 {duration(Math.max(0, Math.round((now - Date.parse(wk.startedAt)) / 1000)))}</span>}
                        </span>
                        {wk && (
                          <span className="live">
                            {wk.live} · <QuietText sec={quiet} />
                          </span>
                        )}
                      </>
                    ) : t.triaging ? (
                      <span className="who wait">リーダーが交通整理中</span>
                    ) : t.waitFor.length ? (
                      <span className="who wait">{waitText(t.waitFor, t.waitMerge)}</span>
                    ) : t.waitArea.length ? (
                      <span className="who wait">{areaWaitText(t.waitArea)}</span>
                    ) : (
                      t.owner &&
                      k !== "done" && (
                        <span className="who" style={{ color: "var(--muted)" }}>
                          持ち主: {t.owner}
                        </span>
                      )
                    )}
                    {t.pr && (
                      <span style={{ fontSize: 11 }}>
                        <PrLink pr={t.pr} />
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function QuietText({ sec }: { sec: number }) {
  if (sec >= QUIET_WARN_SEC) return <span className="quiet-text">{duration(sec)}動きがありません(長く考えているか、止まっている可能性があります)</span>;
  return <span>{sec <= 2 ? "たった今" : `${duration(sec)}前`}</span>;
}

// ---- チケットを足す ----

function NewTicket({ id }: { id: number }) {
  const act = useAct();
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    const r = await act(() => post<{ number: number }>(`/projects/${id}/tickets`, { title: title.trim(), body }), (t) => `#${t.number} を足しました`);
    if (r) {
      setTitle("");
      setBody("");
    }
  };
  return (
    <section className="panel" aria-label="チケットを足す">
      <h2>チケットを足す</h2>
      <form className="newticket dads-form" onSubmit={submit}>
        <div>
          <label className="h" htmlFor="nt-title">
            タイトル
          </label>
          <Input id="nt-title" blockSize="md" autoComplete="off" aria-describedby="nt-title-hint" className="w-full" value={title} onChange={(e) => setTitle(e.target.value)} />
          <div id="nt-title-hint" className="hint">例: 注文履歴を CSV で書き出す</div>
        </div>
        <div>
          <label className="h" htmlFor="nt-body">
            中身(任意)
          </label>
          <Textarea id="nt-body" rows={3} className="w-full" aria-describedby="nt-body-hint" value={body} onChange={(e) => setBody(e.target.value)} />
          <div id="nt-body-hint" className="hint">やってほしいこと・受け入れ条件</div>
        </div>
        <Btn kind="solid-fill" type="submit">
          足す
        </Btn>
      </form>
      <div style={{ fontSize: 12, color: "var(--muted)" }}>足したチケットは開発の受信箱に入り、稼働中なら空いているメンバーが取ります。</div>
    </section>
  );
}

// ---- 出来事 ----

const ROLE_TEXT: Record<string, string> = { dev: "開発", review: "レビュー", sec: "セキュリティ", qa: "QA", lead: "リーダー", planner: "企画", designer: "デザイナー", architect: "アーキテクト" };
const KIND_TEXT: Record<string, string> = { implement: "実装", fix: "直し", answer: "続き", review: "レビュー", sec: "セキュリティの確認", qa: "QA", decide: "判断", unstick: "詰まりの調査" };
const labelOf = (role: string) => ({ review: "レビュー", sec: "セキュリティ", qa: "QA" })[role] ?? role;
type Ev = ProjectView["events"][number];
const EVENT_TEXT: Record<string, (e: Ev, d: Record<string, any>) => string> = {
  ticket_created: (_e, d) => `#${d.number} 「${d.title}」ができました`,
  chat_run_started: (e) => `${e.actor} がチャットの返事を書き始めました`,
  triage_run_started: (e, d) => `${e.actor} が #${(d.tickets ?? []).join("・#")} の交通整理を始めました`,
  helper_called: (e, d) => `${e.actor} が ${d.unit} に ${d.member} を応援に呼びました`,
  triaged: (e, d) => `${e.actor} が #${(d.tickets ?? []).join("・#")} の順番と担当を決めました`,
  ticket_planned: (e, d) => `${e.actor} が順番を決めました${d.after?.length ? `(#${d.after.join("・#")} のあと)` : "(すぐ着手できる)"}・担当: ${d.assignee}`,
  note_added: (e) => `${e.actor === "owner" ? "あなた" : e.actor} がチケットにメモを残しました`,
  run_started: (e, d) =>
    `${e.actor} が${KIND_TEXT[d.kind] ?? d.kind}を始めました${d.model ? `(${MODELS[d.model as keyof typeof MODELS]?.label ?? d.model}${d.from === "unit" ? "・島の設定" : ""})` : ""}`,
  plan_run_started: (e, d) =>
    `${e.actor} が企画スタジオ(${({ req: "要件", flow: "ユーザーフロー", screen: "画面デザイン", infra: "インフラ", model: "アーキテクチャとデータ", handoff: "チームに渡す" } as Record<string, string>)[d.stage] ?? d.stage})の作業を始めました${d.model ? `(${MODELS[d.model as keyof typeof MODELS]?.label ?? d.model})` : ""}`,
  plan_agreed: (_e, d) => `企画スタジオの段階に合意しました(v${d.version})`,
  plan_handed: (_e, d) => `企画スタジオからチームに渡しました(チケット ${d.tickets} 件)`,
  restored: () => "設計書から復元しました",
  policy_saved: (_e, d) => `${ROLE_TEXT[d.role] ?? d.role}の方針を v${d.version} にしました(${MODELS[d.model as keyof typeof MODELS]?.label ?? d.model} / ${d.effort})`,
  run_finished: (e) => `${e.actor} が仕事を終えました`,
  pr_submitted: (e, d) => `${e.actor} が PR #${d.number} を出しました`,
  approved: (e) => `${labelOf(e.actor)}を通りました`,
  changes_requested: (e, d) => `${labelOf(e.actor)}で差し戻し(${d.findings} 件の指摘)`,
  decision_raised: () => "リーダーに判断が上がりました",
  decided_by_recommendation: (_e, d) => `リーダーが推奨で決めました: ${d.reason}`,
  escalated: () => "あなたに判断が上がりました",
  decided: (e, d) => `${({ owner: "あなた", lead: "リーダー", timeout: "期限切れで推奨" } as Record<string, string>)[e.actor] ?? e.actor}が「${d.label}」に決めました`,
  ready_to_merge: (_e, d) => `#${d.number} が merge 待ちに着きました`,
  merged: (_e, d) => `#${d.number} を merge しました`,
  merge_blocked: (_e, d) => `merge できませんでした: ${d.reason}`,
  conflict: (_e, d) => `PR #${d.pr} が衝突しました。持ち主に戻します`,
  summoned: (e) => `${e.actor} が応援に来ました`,
  recalled: (e) => `${e.actor} が持ち主として呼び戻されました`,
  left: (e) => `${e.actor} が帰りました`,
  retry: (_e, d) => `エラーのため再試行します: ${d.error}`,
  stopped: (_e, d) => `止まりました: ${d.reason === "budget" ? "予算切れ" : d.error}`,
  budget_set: (_e, d) => {
    const amount = d.usd === null || d.usd === undefined ? "無制限" : `$${d.usd}`;
    return d.own ? `予算を ${amount} にしました` : `予算を既定(${amount})に戻しました`;
  },
  stuck: (_e, d) => (d.help ? `同じエラーが続いたので、リーダーが原因を調べます(${d.help} 回目): ${d.error}` : `止まりました: ${d.error}`),
  unstick_run_started: (e) => `${e.actor} が詰まった原因を調べ始めました`,
  unstick_retried: (e) => `${e.actor} が助言を渡して、やり直してもらいます`,
  unstick_held: (e) => `${e.actor} が保留にして、あなたに対応をお願いしました`,
  held: (_e, d) => `保留しました: ${d.reason}`,
  resumed: () => "止まったところから再開しました",
  usage_limited: () => "利用の上限に達したので、時間を置いてやり直します",
  pushed: (e, d) => `${e.actor} の変更を push しました(PR #${d.number})`,
  project_budget_set: (_e, d) => `全体の予算を ${d.usd === null ? "無制限" : `$${d.usd}`} にしました`,
  project_budget_reached: (_e, d) => `全体の予算($${d.usd})を使い切りました。チームは止まっています`,
  run_budget_reached: (e) => `${e.actor} が起動 1 回の予算に達しました`,
  formation_saved: (_e, d) => `編成 v${d.version} を適用しました`,
  dispatcher_error: (_e, d) => `ディスパッチャのエラー: ${d.error}`,
};

/** チケットの出来事には番号を前に付ける。文の中に既に番号があるときは付けない。 */
function eventText(text: string, number: number | undefined): string {
  if (number === undefined || text.includes(`#${number}`)) return text;
  return `#${number} ${text}`;
}

function Events({ d }: { d: ProjectView }) {
  const byId = new Map(d.tickets.map((t) => [t.id, t]));
  return (
    <ol className="evlog">
      {d.events.length === 0 && (
        <li>
          <span style={{ color: "var(--muted)" }}>まだ何も起きていません</span>
        </li>
      )}
      {d.events.map((e) => {
        const data = JSON.parse(e.data || "{}") as Record<string, any>;
        const f = EVENT_TEXT[e.type];
        const t = e.ticket_id ? byId.get(e.ticket_id) : undefined;
        return (
          <li key={e.id}>
            <time>{hhmm(e.at)}</time>
            <span>{eventText(f ? f(e, data) : e.type, t?.number)}</span>
          </li>
        );
      })}
    </ol>
  );
}

// ---- 指標・編成 ----

function Kpis({ d }: { d: ProjectView }) {
  const m = d.metrics;
  const k = (l: string, v: string | number, n?: string) => (
    <div className="kpi" key={l}>
      <div className="l">{l}</div>
      <div className="v">{v}</div>
      {n && <div className="n">{n}</div>}
    </div>
  );
  return (
    <div className="kpis">
      {k("完成", m.completed, "merge 待ちに着いたもの")}
      {k("1 件あたりのコスト", usd(m.costPerCompletedUsd), `トークン ${kfmt(m.tokensPerCompleted)}`)}
      {k("フロー効率", pct(m.flowEfficiency), "作業時間 ÷ リードタイム")}
      {k("判断 / 完成", m.decisionsPerCompleted == null ? "—" : m.decisionsPerCompleted.toFixed(1), "あなたに上がった回数")}
      {k("平均レビュー往復", m.avgReviewRounds == null ? "—" : m.avgReviewRounds.toFixed(1), `再発 ${m.recurred} · 衝突 ${m.conflicts}`)}
      {k("使った金額", usd(d.spentUsd), "すべての起動の合計")}
    </div>
  );
}

const ROLE_NAME: Record<string, string> = { dev: "開発", review: "レビュー", sec: "セキュリティ", qa: "QA" };

function Formation({ d }: { d: ProjectView }) {
  const f = d.formation;
  return (
    <div style={{ fontSize: 13 }}>
      <div style={{ color: "var(--muted)", marginBottom: 6 }}>
        編成 v{f.version} · リポジトリ {d.repos.map((r) => r.full_name).join("、")}
      </div>
      {f.units.map((u) => (
        <div key={u.name} style={{ padding: "6px 0", borderTop: "1px solid var(--line)" }}>
          <b>{u.name}</b>{" "}
          <span style={{ color: "var(--muted)" }}>
            {u.roles.map((r) => ROLE_NAME[r] ?? r).join("・")} · {u.members.length}/{u.max} 人{u.repos.length ? ` · ${u.repos.join("・")} を受け持つ` : ""}
            {u.model || u.effort ? ` · ${u.model ? (MODELS[u.model as keyof typeof MODELS]?.label ?? u.model) : "方針のモデル"} / ${u.effort ?? "方針の深さ"}` : ""}
          </span>
          <div>{u.members.join("、")}</div>
        </div>
      ))}
      <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 6 }}>
        データ: <code>{d.project.dataDir}</code>
      </div>
    </div>
  );
}
