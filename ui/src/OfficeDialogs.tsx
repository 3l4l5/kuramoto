import { useEffect, useRef, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, type MemberView, type UnitView } from "./api";
import { duration, useNow } from "./hooks";
import { Btn } from "./ui";
import { hhmm, usd } from "./format";
import { TicketLink } from "./Ticket";
import { Avatar } from "./Avatar";

/**
 * オフィスの「様子」のモーダル。席の下には名前と短い状態だけを出し、
 * 今していることの経過・これまでの仕事(メンバー)や、待ち・予算・最近の仕事(島)はここで見せる。
 */

const STAGE: Record<string, string> = { dev: "開発", review: "レビュー", sec: "セキュリティ", qa: "QA", decision: "判断待ち", merge: "merge 待ち", done: "完了", dropped: "取りやめ" };

function Modal({ label, title, close, children, actions }: { label: string; title: ReactNode; close: () => void; children: ReactNode; actions?: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
  }, []);
  return (
    <dialog ref={ref} className="ticketdialog peopledialog" aria-label={label} onClose={close} onCancel={close}>
      <header>
        <h2>{title}</h2>
        <span style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          {actions}
          <Btn kind="text" size="sm" onClick={() => ref.current?.close()}>
            閉じる
          </Btn>
        </span>
      </header>
      <div className="pd-body">{children}</div>
    </dialog>
  );
}

type Run = MemberView["history"][number];

/** 起動の一覧(新しい順)。 */
function Runs({ runs, showMember }: { runs: Run[]; showMember?: boolean }) {
  if (!runs.length) return <p className="hint">まだありません</p>;
  return (
    <ol className="pd-runs" aria-label="これまでの仕事">
      {runs.map((r) => (
        <li key={r.runId} className={r.running ? "pd-running" : r.ok ? "pd-ok" : "pd-bad"}>
          <div className="pd-runhead">
            <span className="pd-when">{hhmm(r.startedAt)}</span>
            {showMember && <b>{r.member}</b>}
            <span>
              {r.ticket ? (
                <TicketLink id={r.ticket.id}>
                  #{r.ticket.number} {r.ticket.title}
                </TicketLink>
              ) : (
                "チケットなし"
              )}
            </span>
            <span className="pd-kind">
              {r.kind}({r.role})
            </span>
            <span className="pd-outcome">{r.outcome}</span>
            <span className="hint">
              {r.durationSec !== null ? duration(r.durationSec) : ""} · {usd(r.costUsd)}
              {r.model ? ` · ${r.model}` : ""}
            </span>
          </div>
          {r.error && <div className="pd-error">{r.error}</div>}
          {r.summary && <div className="pd-summary">{r.summary}</div>}
        </li>
      ))}
    </ol>
  );
}

/** メンバー 1 人の様子。 */
export function MemberDialog({ projectId, memberId, close }: { projectId: number; memberId: number; close: () => void }) {
  const { data } = useQuery({ queryKey: ["member", projectId, memberId], queryFn: () => api<MemberView>("GET", `/projects/${projectId}/members/${memberId}`), refetchInterval: 2000 });
  const now = useNow();
  const w = data?.work;
  return (
    <Modal label={data ? `${data.name} の様子` : "メンバーの様子"} title={data ? `${data.name} の様子` : "読み込んでいます…"} close={close}>
      {data && (
        <div className="pd-cols">
          <section aria-label="今の仕事">
            <div className="pd-who">
              <Avatar name={data.name} asleep={!w} />
              <div>
                <b>{data.name}</b>
                {data.helper && <span className="of-helper">応援</span>}
                <div className="hint">
                  {data.unit ?? "島に属さない担当"} · 来た時刻 {hhmm(data.joinedAt)}
                  {data.leftAt ? ` · 帰った時刻 ${hhmm(data.leftAt)}` : ""}
                </div>
              </div>
            </div>
            <h3>今していること</h3>
            {w ? (
              <>
                <p>
                  {w.ticket ? `#${w.ticket} ${w.title ?? ""} の` : ""}
                  {w.kind}({w.role}・{w.model})· 経過 {duration(Math.max(0, Math.round((now - Date.parse(w.startedAt)) / 1000)))}
                  {w.live ? ` · ${w.live}` : ""}
                </p>
                <ol className="pd-steps" aria-label="途中経過">
                  {w.steps.map((s, i) => (
                    <li key={i}>
                      <span className="pd-when">{hhmm(s.at)}</span> <span className="pd-kind">{s.kind}</span> {s.text}
                    </li>
                  ))}
                </ol>
              </>
            ) : (
              <p className="hint">手すきです</p>
            )}
            {data.queued.length > 0 && (
              <>
                <h3>次に頼まれている仕事</h3>
                <ul>
                  {data.queued.map((q, i) => (
                    <li key={i}>
                      #{q.number} {q.title}({q.kind})
                    </li>
                  ))}
                </ul>
              </>
            )}
            <h3>受け持ちのチケット</h3>
            {data.owned.length ? (
              <ul className="pd-owned">
                {data.owned.map((t) => (
                  <li key={t.id}>
                    <TicketLink id={t.id}>
                      #{t.number} {t.title}
                    </TicketLink>{" "}
                    <span className="hint">{STAGE[t.stage] ?? t.stage}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="hint">ありません</p>
            )}
          </section>
          <section aria-label="これまでの仕事">
            <h3>
              これまでの仕事 <span className="hint">{data.totals.runs} 回 · うち終わった {data.totals.ok} 回 · {usd(data.totals.costUsd)}</span>
            </h3>
            <Runs runs={data.history} />
          </section>
        </div>
      )}
    </Modal>
  );
}

/** 島 1 つの様子。 */
export function UnitDialog({ projectId, unitId, close, onEdit }: { projectId: number; unitId: number; close: () => void; onEdit: (name: string) => void }) {
  const { data } = useQuery({ queryKey: ["unit", projectId, unitId], queryFn: () => api<UnitView>("GET", `/projects/${projectId}/units/${unitId}`), refetchInterval: 2000 });
  const now = useNow();
  return (
    <Modal
      label={data ? `${data.name} の様子` : "島の様子"}
      title={data ? `${data.name} の様子` : "読み込んでいます…"}
      close={close}
      actions={
        data && (
          <Btn kind="outline" size="sm" onClick={() => onEdit(data.name)}>
            島の設定を変える
          </Btn>
        )
      }
    >
      {data && (
        <div className="pd-cols">
          <section aria-label="島の今">
            <dl className="pd-facts">
              <dt>役割</dt>
              <dd>{data.roles.join("・")}</dd>
              <dt>人数</dt>
              <dd>
                {data.members.length} 人(ずっといます。増やす・減らすは「島の設定を変える」から)
              </dd>
              <dt>受け持ち</dt>
              <dd>{data.repos.length ? data.repos.join("・") : "すべてのリポジトリ"}</dd>
              <dt>モデル</dt>
              <dd>
                {data.model ?? "役割の方針どおり"}
                {data.effort ? ` · ${data.effort}` : ""}
              </dd>
              {data.focus && (
                <>
                  <dt>重視すること</dt>
                  <dd style={{ whiteSpace: "pre-wrap" }}>{data.focus}</dd>
                </>
              )}
              <dt>予算</dt>
              <dd>
                {data.budget.budgetUsd === null ? "無制限" : `${usd(data.budget.spentUsd)} / ${usd(data.budget.budgetUsd)}`}
                {data.budget.budgetUsd === null ? `(使った額 ${usd(data.budget.spentUsd)})` : ""}
                {data.budget.exhausted && <b className="of-broke">使い切りました</b>}
              </dd>
              <dt>この 24 時間</dt>
              <dd>
                {data.last24h.runs} 回動いた · うち終わった {data.last24h.ok} 回 · {usd(data.last24h.costUsd)}
              </dd>
            </dl>
            <h3>メンバー</h3>
            <ul className="pd-members">
              {data.members.map((m) => (
                <li key={m.id}>
                  <b>{m.name}</b>
{" "}
                  {m.work ? (
                    <span>
                      {m.work.ticket ? `#${m.work.ticket} ` : ""}
                      {m.work.kind}中 · {duration(Math.max(0, Math.round((now - Date.parse(m.work.startedAt)) / 1000)))}
                      {m.work.lastStep ? <span className="hint"> · {m.work.lastStep}</span> : null}
                    </span>
                  ) : (
                    <span className="hint">手すき</span>
                  )}
                </li>
              ))}
            </ul>
            <h3>すぐ取れる仕事</h3>
            <p>{data.waiting.length ? `#${data.waiting.join("・#")}` : <span className="hint">ありません</span>}</p>
            <h3>順番待ち</h3>
            {data.queued.length ? (
              <ul>
                {data.queued.map((q) => (
                  <li key={q.number}>
                    #{q.number}: {q.why}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="hint">ありません</p>
            )}
          </section>
          <section aria-label="最近の仕事">
            <h3>最近の仕事</h3>
            <Runs runs={data.recent} showMember />
          </section>
        </div>
      )}
    </Modal>
  );
}
