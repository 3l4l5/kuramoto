import { createContext, useContext, useState, type FormEvent, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, post, type TicketView } from "./api";
import { droppedText, hhmm, usd, waitText } from "./format";
import { BudgetInput, budgetOk } from "./BudgetInput";
import { duration, go, useAct } from "./hooks";
import { Btn } from "./ui";
import { Chip, Input, Segmented, Textarea, type ChipTone } from "./ds";
import { KINDS, KindChip, PRE_DEV_LABEL } from "./kind";
import { TeamDrawer, type Drawer, type RuleGuard } from "./Team";

/**
 * チケットの詳細(1 枚の画面)。上はボードと同じ共通ヘッダー(App)、その下に「← ボードに戻る・番号・題名・工程・往復」の帯、
 * 左に中身・ひも付く要件と画面・PR・金額、右に起動・レビューの指摘・判断・衝突・merge・責任者のメモを時刻順に並べた「やりとり」を見せる。
 * アドレスは #/p/<プロジェクト>/t/<チケット>。
 */
const OpenTicket = createContext<(ticketId: number) => void>(() => {});
export const useOpenTicket = () => useContext(OpenTicket);

export const ticketHash = (projectId: number, ticketId: number) => `#/p/${projectId}/t/${ticketId}`;

export function TicketProvider({ projectId, children }: { projectId: number; children: ReactNode }) {
  return <OpenTicket.Provider value={(ticketId) => go(ticketHash(projectId, ticketId))}>{children}</OpenTicket.Provider>;
}

/** チケットを開くボタン(文字だけ)。 */
export function TicketLink({ id, children }: { id: number; children: ReactNode }) {
  const open = useOpenTicket();
  return (
    <button type="button" className="ticketlink" onClick={() => open(id)}>
      {children}
    </button>
  );
}

const STAGE: Record<string, string> = { dev: "開発", review: "レビュー", sec: "セキュリティ", qa: "QA", decision: "判断待ち", merge: "merge 待ち", done: "完了", dropped: "取りやめ" };
const SEVERITY: Record<string, [string, ChipTone]> = { high: ["重い", "danger"], medium: ["中", "review"], low: ["軽い", "neutral"] };
const FINDING_STATUS: Record<string, string> = {
  open: "未対応",
  addressed: "直したと返事・確認待ち",
  disputed: "直さないと返事・確認待ち",
  fixed: "解決",
  recurred: "再発",
  wontfix: "直さないことで決着",
};
const HANDLED: Record<string, string> = { autofixed: "持ち主が自動で直した", review: "レビューで指摘", blocked: "直すまで進めない" };
const ACTION: Record<string, string> = { fixed: "直した", wontfix: "直さない", resolved: "解決を確認", accepted: "直さないのを了承", reopened: "まだ直っていない", ruled: "裁定" };
const DECIDED_BY: Record<string, string> = { owner: "あなた", lead: "リーダー", timeout: "期限切れで推奨" };

export function TicketPage({ id, ticketId, drawer, closeDrawer, guard }: { id: number; ticketId: number; drawer: Drawer | null; closeDrawer: () => void; guard: RuleGuard }) {
  return (
    <div className="layout">
      <div className="main">
        <TicketScreen projectId={id} ticketId={ticketId} />
      </div>
      {drawer && <TeamDrawer id={id} drawer={drawer} close={closeDrawer} guard={guard} />}
    </div>
  );
}

function TicketScreen({ projectId, ticketId }: { projectId: number; ticketId: number }) {
  const { data, error } = useQuery({ queryKey: ["ticket", projectId, ticketId], queryFn: () => api<TicketView>("GET", `/projects/${projectId}/tickets/${ticketId}`), refetchInterval: 3000 });
  const back = (
    <Btn kind="text" size="sm" className="back" onClick={() => go(`#/p/${projectId}`)}>
      ← ボードに戻る
    </Btn>
  );
  if (!data)
    return (
      <section className="ticketpage" aria-label="チケット">
        <header className="tk-band">{back}</header>
        <p className="hint pad">{error ? "このチケットは見つかりません。" : "読み込んでいます…"}</p>
      </section>
    );
  return (
    <section className="ticketpage" aria-label={`チケット #${data.number}`}>
      <header className="tk-band">
        {back}
        <h2>
          <span className="num">#{data.number}</span>
          {data.jiraKey ? ` · ${data.jiraKey}` : ""} {data.title}
        </h2>
        <Chip tone={data.stage === "done" ? "ok" : data.stage === "decision" ? "warn" : "default"}>{STAGE[data.stage] ?? data.stage}</Chip>
        <KindChip kind={data.kind} label={data.kindLabel} />
        <span className="rounds">往復 {data.rounds}</span>
        {data.ruleBlocked.length > 0 && <Chip tone="danger">ルール違反で止まっている: {data.ruleBlocked.join("・")}</Chip>}
        {data.stage === "dropped" && <Reopen projectId={projectId} id={data.id} />}
      </header>
      {data.dropped && (
        <div className="dropnote" role="note">
          {droppedText(data.dropped)}
          {data.dropped.at && <span className="at">({new Date(data.dropped.at).toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })})</span>}
        </div>
      )}
      {data.designCompare.length > 0 && <DesignCompare projectId={projectId} rows={data.designCompare} />}
      <div className="cols">
        <Details projectId={projectId} t={data} />
        <Timeline projectId={projectId} t={data} />
      </div>
    </section>
  );
}

/** 取りやめたチケットを戻して、続きから進める。 */
function Reopen({ projectId, id }: { projectId: number; id: number }) {
  const act = useAct();
  const [busy, setBusy] = useState(false);
  return (
    <Btn
      kind="solid-fill"
      size="sm"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        await act(() => post(`/projects/${projectId}/tickets/${id}/reopen`), "取りやめを戻しました。持ち主が続きから進めます");
        setBusy(false);
      }}
    >
      取りやめを戻して再開する
    </Btn>
  );
}

function Details({ projectId, t }: { projectId: number; t: TicketView }) {
  const act = useAct();
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(t.title);
  const [body, setBody] = useState(t.body);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    const r = await act(() => post(`/projects/${projectId}/tickets/${t.id}`, { title, body }), "チケットを書き直しました");
    if (r) setEditing(false);
  };
  return (
    <section className="details" aria-label="チケットの中身">
      {editing ? (
        <form className="dads-form" onSubmit={save}>
          <div>
            <label className="h" htmlFor="tk-title">
              タイトル
            </label>
            <Input id="tk-title"className="w-full" value={title} onChange={(e) => setTitle(e.target.value)} />
          </div>
          <div>
            <label className="h" htmlFor="tk-body">
              中身
            </label>
            <Textarea id="tk-body" rows={8} className="w-full" value={body} onChange={(e) => setBody(e.target.value)} />
            <div className="hint">やってほしいこと・受け入れ条件・注意点。次に仕事を始める担当から読みます。</div>
          </div>
          <div className="btns">
            <Btn kind="solid-fill" size="sm" type="submit">
              保存する
            </Btn>
            <Btn kind="text" size="sm" onClick={() => setEditing(false)}>
              やめる
            </Btn>
          </div>
        </form>
      ) : (
        <>
          <div className="body">{t.body ? t.body : <span className="hint">中身はまだありません</span>}</div>
          <Btn
            kind="outline"
            size="sm"
            onClick={() => {
              setTitle(t.title);
              setBody(t.body);
              setEditing(true);
            }}
          >
            編集
          </Btn>
        </>
      )}
      <dl>
        <dt>種類</dt>
        <dd>
          <KindSelect projectId={projectId} t={t} />
        </dd>
        {t.requirement && (
          <>
            <dt>要件</dt>
            <dd>
              <b>
                {t.requirement.code} {t.requirement.name}
              </b>
              <div className="hint">受け入れ条件: {t.requirement.acceptance}</div>
            </dd>
          </>
        )}
        {t.screens.length > 0 && (
          <>
            <dt>画面</dt>
            <dd>{t.screens.join("、")}</dd>
          </>
        )}
        {t.design.length > 0 && (
          <>
            <dt>設計</dt>
            <dd>{t.design.join("、")}</dd>
          </>
        )}
        <dt>順番</dt>
        <dd>
          {!t.triaged
            ? "リーダーが交通整理をしています"
            : t.after.length
              ? `#${t.after.join("・#")} のあと${t.waitFor.length ? `(${waitText(t.waitFor, t.waitMerge)})` : "(着手できます)"}`
              : "すぐ着手できます"}
        </dd>
        <dt>PR</dt>
        <dd>
          {t.prs.length
            ? t.prs.map((pr) => (
                <a key={pr.number} href={`https://github.com/${pr.full_name}/pull/${pr.number}`} target="_blank" rel="noopener">
                  {pr.full_name}#{pr.number}
                </a>
              ))
            : "まだありません"}
        </dd>
        <dt>持ち主</dt>
        <dd>{t.owner ?? "—"}</dd>
        <dt>使った金額</dt>
        <dd>
          {usd(t.costUsd)} · {t.tokens.toLocaleString()} トークン · 往復 {t.rounds}
        </dd>
        <dt>予算</dt>
        <dd>
          <Budget projectId={projectId} t={t} />
        </dd>
      </dl>
    </section>
  );
}

/** チケットの種類。責任者が変えられる。変えると、次の工程から変えた先の流れで進む。 */
function KindSelect({ projectId, t }: { projectId: number; t: TicketView }) {
  const act = useAct();
  // 変えた直後は、画面にとどまる説明を出す(トーストは消えるため)
  const [changed, setChanged] = useState<{ from: string; to: string } | null>(null);
  const change = async (kind: string) => {
    const from = t.kindLabel;
    const to = KINDS.find((k) => k.key === kind)?.label ?? kind;
    const r = await act(() => post(`/projects/${projectId}/tickets/${t.id}/kind`, { kind }), `種類を「${to}」に変えました。次の工程から、その種類の流れで進みます`);
    if (r) setChanged({ from, to });
  };
  return (
    <div className="kindsel">
      <Segmented label="チケットの種類" value={t.kind} onChange={(k) => void change(k)} options={KINDS.map((k) => ({ value: k.key as string, label: k.label }))} />
      <div className="kindflow" aria-label={`${t.kindLabel}の流れ`}>
        {t.kindLabel}の流れ:{" "}
        {[...t.flow.map((f) => ({ key: f.key, text: f.preDev ? `${f.label} ${PRE_DEV_LABEL}` : f.label })), { key: "merge", text: "merge 待ち" }].map((f, i) => (
          <span key={f.key}>
            {i > 0 && " → "}
            <Chip tone={f.key === "merge" ? "ok" : "neutral"}>{f.text}</Chip>
          </span>
        ))}
      </div>
      {changed && (
        <div className="kindchanged" role="note">
          {changed.from} → {changed.to}に変えました。次の工程から{changed.to}の流れで進みます。
        </div>
      )}
    </div>
  );
}

/** チケット 1 枚の予算。使い切ると止まり、責任者に「続けるか」を聞く。無制限にもできる。 */
function Budget({ projectId, t }: { projectId: number; t: TicketView }) {
  const act = useAct();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState<number | null>(null);
  const send = async (body: { usd: number | null } | { unlimited: true }) => {
    const r = await act(() => post(`/projects/${projectId}/tickets/${t.id}/budget`, body), "usd" in body && body.usd === null ? "予算を既定に戻しました" : "予算を変えました");
    if (r) setEditing(false);
  };
  const left = t.budgetUsd === null ? null : t.budgetUsd - t.costUsd;
  const defaultText = t.defaultBudgetUsd === null ? "無制限" : `$${t.defaultBudgetUsd}`;
  if (editing)
    return (
      <form
        className="budgetform"
        onSubmit={(e) => {
          e.preventDefault();
          if (value === null) void send({ unlimited: true });
          else if (budgetOk(value)) void send({ usd: value });
        }}
      >
        <label className="sr" htmlFor="tk-budget">
          このチケットの予算(ドル)
        </label>
        <BudgetInput id="tk-budget" name="このチケットの予算" size="sm" value={value} onChange={setValue} />
        <Btn kind="solid-fill" size="xs" type="submit" disabled={!budgetOk(value)}>
          決める
        </Btn>
        {t.ownBudget && (
          <Btn kind="text" size="xs" onClick={() => void send({ usd: null })}>
            既定({defaultText})に戻す
          </Btn>
        )}
        <Btn kind="text" size="xs" onClick={() => setEditing(false)}>
          やめる
        </Btn>
      </form>
    );
  return (
    <span className="budget">
      {t.budgetUsd === null ? "無制限" : usd(t.budgetUsd)}
      <span className="hint">
        {t.ownBudget ? "(このチケットだけ)" : "(既定)"} · {left === null ? `使った額 ${usd(t.costUsd)}` : left > 0 ? `残り ${usd(left)}` : "使い切りました"}
      </span>
      <Btn
        kind="text"
        size="xs"
        onClick={() => {
          setValue(t.budgetUsd);
          setEditing(true);
        }}
      >
        予算を変える
      </Btn>
    </span>
  );
}

function Timeline({ projectId, t }: { projectId: number; t: TicketView }) {
  const act = useAct();
  const [note, setNote] = useState("");
  const send = async (e: FormEvent) => {
    e.preventDefault();
    if (!note.trim()) return;
    const r = await act(() => post(`/projects/${projectId}/tickets/${t.id}/notes`, { body: note }), "メモを残しました。次に仕事を始める担当が読みます");
    if (r) setNote("");
  };
  return (
    <section className="timeline" aria-label="やりとり">
      <h3>やりとり</h3>
      <ol>
        {t.timeline.map((x, i) => (
          <li key={i} className={`tl-${x.type}`}>
            <time>{hhmm(x.at)}</time>
            <div>{item(x)}</div>
          </li>
        ))}
      </ol>
      <form className="note" onSubmit={send}>
        <label className="h" htmlFor="tk-note">
          メモを残す
        </label>
        <Textarea id="tk-note" rows={2} className="w-full" value={note} onChange={(e) => setNote(e.target.value)} />
        <div className="hint">担当への補足や決めたこと。次に仕事を始める担当が、チケットの中身と一緒に読みます。</div>
        <Btn kind="solid-fill" size="sm" type="submit" disabled={!note.trim()}>
          メモを残す
        </Btn>
      </form>
    </section>
  );
}

function item(x: TicketView["timeline"][number]): ReactNode {
  switch (x.type) {
    case "created":
      return <b>チケットができました</b>;
    case "note":
      return (
        <>
          <b>{x.who}のメモ</b>
          <p className="said">{x.body}</p>
        </>
      );
    case "run":
      return (
        <>
          <b>
            {x.who}({x.role})が{x.kind}
            {x.outcome === "running" ? "をしています" : x.outcome === "error" ? "に失敗しました" : "をしました"}
          </b>
          <span className="meta">
            {x.model} · {usd(x.costUsd)} · {x.tokens.toLocaleString()} トークン{x.ms != null ? ` · ${duration(Math.round(x.ms / 1000))}` : ""}
          </span>
          {x.summary && <p className="said">{x.summary}</p>}
          {x.error && <p className="said err">{x.error}</p>}
        </>
      );
    case "pr":
      return (
        <b>
          {x.who}が PR{" "}
          <a href={`https://github.com/${x.repo}/pull/${x.number}`} target="_blank" rel="noopener">
            {x.repo}#{x.number}
          </a>{" "}
          を出しました
        </b>
      );
    case "review":
      return (
        <>
          <b>
            {x.who}の{x.role}({x.round} 回目):{" "}
            <Chip tone={x.verdict === "承認" ? "ok" : "danger"}>
              {x.verdict}
            </Chip>
          </b>
          {x.findings.length > 0 && (
            <ul className="findings" aria-label="指摘">
              {x.findings.map((f, i) => (
                <li key={i} className={f.blocking ? "must" : "nit"}>
                  <div>
                    <Chip tone={f.blocking ? (SEVERITY[f.severity]?.[1] ?? "neutral") : "neutral"}>
                      {f.blocking ? `必須・${SEVERITY[f.severity]?.[0] ?? f.severity}` : "提案"}
                    </Chip>{" "}
                    {f.path && (
                      <code>
                        {f.path}
                        {f.line ? `:${f.line}` : ""}
                      </code>
                    )}{" "}
                    {f.body} <span className="meta">({FINDING_STATUS[f.status] ?? f.status})</span>
                  </div>
                  {f.comments.filter((c) => c.action !== "raised").length > 0 && (
                    <ol className="thread" aria-label={`指摘 ${f.id} のやりとり`}>
                      {f.comments
                        .filter((c) => c.action !== "raised")
                        .map((c, j) => (
                          <li key={j} className={`th-${c.action}`}>
                            <b>
                              {c.who}({ACTION[c.action] ?? c.action})
                            </b>
                            {c.body && `: ${c.body}`}
                          </li>
                        ))}
                    </ol>
                  )}
                </li>
              ))}
            </ul>
          )}
        </>
      );
    case "rule":
      return (
        <>
          <b>
            ルール「{x.rule}」に反していました{" "}
            <Chip tone={x.handled === "autofixed" ? "ok" : x.handled === "blocked" ? "danger" : "warn"}>
              {HANDLED[x.handled] ?? x.handled}
            </Chip>
          </b>
          {x.detail && <p className="said">{x.detail}</p>}
          <span className="meta">{x.resolvedAt ? `${hhmm(x.resolvedAt)} に直りました` : "まだ直っていません"}</span>
        </>
      );
    case "handoff":
      return (
        <>
          <b>
            {x.role}の申し送り(開発の前) <Chip tone="neutral">差し戻し無し・往復に数えない</Chip>
          </b>
          <p className="said">{x.body}</p>
        </>
      );
    case "kind_change":
      return (
        <>
          <b>
            {x.who}が種類を「{x.from}」から「{x.to}」に変えました
          </b>
          <span className="meta">次の工程から、{x.to}の流れで進みます</span>
        </>
      );
    case "question":
      return <QuestionItem x={x} />;
    case "decision":
      return (
        <>
          <b>{x.escalated ? "あなたに判断が上がりました" : "リーダーに判断が上がりました"}</b>
          <p className="said">{x.question.split("\n").pop()}</p>
          <span className="meta">
            選択肢: {x.options.map((o, i) => (i === x.recommended ? `${o}(推奨)` : o)).join(" / ")}
          </span>
          {x.answer ? (
            <span className="meta">
              → {DECIDED_BY[x.decidedBy ?? ""] ?? x.decidedBy}が「{x.answer}」に決めました
            </span>
          ) : (
            <span className="meta">→ まだ決まっていません</span>
          )}
        </>
      );
    case "conflict":
      return (
        <b>
          衝突しました{x.cause ? `(原因: ${x.cause})` : ""}
          {x.resolution ? ` → ${x.resolution === "mechanical" ? "機械的に解いた" : x.resolution === "logic" ? "ロジックを直した" : "判断した"}` : ""}
        </b>
      );
    case "merge":
      return <b>{x.result === "merged" ? "merge しました" : x.result === "conflict" ? "merge しようとしたら衝突していました" : "merge できませんでした"}</b>;
  }
}

type QuestionView = Extract<TicketView["timeline"][number], { type: "question" }>;

/** 他の島(またはリーダー)への質問と答え(R16)。経路が無くてリーダーに回ったときは、そのことを印にして残す。 */
export function QuestionItem({ x }: { x: QuestionView }) {
  return (
    <>
      <b>
        {x.from}が{x.to}に質問しました
        {x.noRoute && <Chip tone="warn">経路が無いのでリーダーに回した</Chip>}
      </b>
      <p className="said">{x.body}</p>
      {x.answer ? (
        <>
          <span className="meta">
            {x.answeredBy ?? x.to}の答え{x.answeredAt ? `(${hhmm(x.answeredAt)})` : ""}
          </span>
          <p className="said answer">{x.answer}</p>
        </>
      ) : (
        <span className="meta">{x.noRoute ? "→ リーダーの返事を待っています" : "→ まだ答えを待っています"}</span>
      )}
    </>
  );
}

/** 画面のデザインの見比べ(ADR-0034)。お手本(企画で合意した試作)・実装・違い(赤いところ)を並べる。 */
function DesignCompare({ projectId, rows }: { projectId: number; rows: TicketView["designCompare"] }) {
  const src = (id: number | null) => (id ? `/api/projects/${projectId}/design-images/${id}` : "");
  return (
    <section className="designcompare" aria-label="デザインの見比べ">
      <h3>デザインの見比べ</h3>
      {rows.map((r) => (
        <div key={r.screen} className="dc-row">
          <div className="dc-head">
            <b>{r.name}</b>
            <span className={r.ratio > 0.1 ? "bad" : "ok"}>違い {(r.ratio * 100).toFixed(1)}%</span>
            <span className="hint">{new Date(r.at).toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span>
          </div>
          <div className="dc-imgs">
            {([["お手本(試作)", r.reference], ["実装", r.actual], ["違い(赤)", r.diff]] as const).map(([label, id]) => (
              <figure key={label}>
                <figcaption>{label}</figcaption>
                {id ? (
                  <a href={src(id)} target="_blank" rel="noreferrer">
                    <img src={src(id)} alt={`${r.name}の${label}`} loading="lazy" />
                  </a>
                ) : (
                  <span className="hint">ありません</span>
                )}
              </figure>
            ))}
          </div>
        </div>
      ))}
    </section>
  );
}
