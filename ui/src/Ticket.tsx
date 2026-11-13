import { createContext, useContext, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, post, type TicketView } from "./api";
import { droppedText, hhmm, usd, waitText } from "./format";
import { BudgetInput, budgetOk } from "./BudgetInput";
import { duration, useAct } from "./hooks";
import { Btn } from "./ui";
import { Input } from "./dads/Input";
import { Textarea } from "./dads/Textarea";
import { ChipLabel } from "./dads/ChipLabel";

/**
 * チケットの詳細(モーダル)。中身・ひも付く要件と画面・PR・金額と、
 * 起動・レビューの指摘・判断・衝突・merge・責任者のメモを時刻順に並べた「やりとり」を見せる。
 */
const OpenTicket = createContext<(ticketId: number) => void>(() => {});
export const useOpenTicket = () => useContext(OpenTicket);

export function TicketProvider({ projectId, children }: { projectId: number; children: ReactNode }) {
  const [open, setOpen] = useState<number | null>(null);
  return (
    <OpenTicket.Provider value={setOpen}>
      {children}
      {open !== null && <TicketDialog projectId={projectId} ticketId={open} close={() => setOpen(null)} />}
    </OpenTicket.Provider>
  );
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
const SEVERITY: Record<string, [string, "red" | "orange" | "gray"]> = { high: ["重い", "red"], medium: ["中", "orange"], low: ["軽い", "gray"] };
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

function TicketDialog({ projectId, ticketId, close }: { projectId: number; ticketId: number; close: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const { data } = useQuery({ queryKey: ["ticket", projectId, ticketId], queryFn: () => api<TicketView>("GET", `/projects/${projectId}/tickets/${ticketId}`), refetchInterval: 3000 });
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
  }, []);
  return (
    <dialog ref={ref} className="ticketdialog" aria-label={data ? `チケット #${data.number}` : "チケット"} onClose={close} onCancel={close}>
      {!data ? (
        <p className="hint">読み込んでいます…</p>
      ) : (
        <>
          <header>
            <h2>
              #{data.number}
              {data.jiraKey ? ` · ${data.jiraKey}` : ""} {data.title}
            </h2>
            <ChipLabel variant="filled-1" color={data.stage === "done" ? "green" : data.stage === "decision" ? "yellow" : "blue"}>
              {STAGE[data.stage] ?? data.stage}
            </ChipLabel>
            {data.ruleBlocked.length > 0 && <ChipLabel variant="filled-1" color="red">ルール違反で止まっている: {data.ruleBlocked.join("・")}</ChipLabel>}
            {data.stage === "dropped" && <Reopen projectId={projectId} id={data.id} />}
            <Btn kind="text" size="sm" style={{ marginLeft: "auto" }} onClick={() => ref.current?.close()}>
              閉じる
            </Btn>
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
        </>
      )}
    </dialog>
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
            <Input id="tk-title" blockSize="md" className="w-full" value={title} onChange={(e) => setTitle(e.target.value)} />
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
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    end.current?.scrollIntoView({ block: "nearest" });
  }, [t.timeline.length]);
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
      <div ref={end} />
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
            <ChipLabel variant="filled-1" color={x.verdict === "承認" ? "green" : "red"}>
              {x.verdict}
            </ChipLabel>
          </b>
          {x.findings.length > 0 && (
            <ul className="findings" aria-label="指摘">
              {x.findings.map((f, i) => (
                <li key={i} className={f.blocking ? "must" : "nit"}>
                  <div>
                    <ChipLabel variant="outlined" color={f.blocking ? (SEVERITY[f.severity]?.[1] ?? "gray") : "gray"}>
                      {f.blocking ? `必須・${SEVERITY[f.severity]?.[0] ?? f.severity}` : "提案"}
                    </ChipLabel>{" "}
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
            <ChipLabel variant="filled-1" color={x.handled === "autofixed" ? "green" : x.handled === "blocked" ? "red" : "yellow"}>
              {HANDLED[x.handled] ?? x.handled}
            </ChipLabel>
          </b>
          {x.detail && <p className="said">{x.detail}</p>}
          <span className="meta">{x.resolvedAt ? `${hhmm(x.resolvedAt)} に直りました` : "まだ直っていません"}</span>
        </>
      );
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
