import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, post, type MemberChatView, type MemberNow } from "./api";
import { Avatar } from "./Avatar";
import { Button, Chip, Input } from "./ds";
import { useNow } from "./hooks";
import { hhmm, kfmt } from "./format";
import { KIND_SHAPE, KINDS } from "./kind";
import { TicketLink } from "./Ticket";

/**
 * オフィスでメンバーを押すと右に開く引き出し(スマホでは下からのシート)。
 * 上: 今のチケット(種類・工程・往復・経過・トークン)と直近の手順。手すきなら「手すき」と直前に終えたチケット。
 * 下: そのメンバーと話す欄。話した内容はそのチケットのメモに書き足され、担当や工程は変わらない。
 * 返事を書いている間は、経過の秒数を出す。
 */

const STAGE: Record<string, string> = { dev: "開発", review: "レビュー", sec: "セキュリティ", qa: "QA", decision: "判断待ち", merge: "merge 待ち", done: "完了", dropped: "取りやめ" };
const STATE_LABEL: Record<MemberNow["state"], string> = { working: "作業中", chatting: "会話中", idle: "手すき" };

export function MemberDrawer({ projectId, memberId, canChat, close }: { projectId: number; memberId: number; canChat: boolean; close: () => void }) {
  const qc = useQueryClient();
  const nowQ = useQuery({ queryKey: ["member-now", projectId, memberId], queryFn: () => api<MemberNow>("GET", `/projects/${projectId}/members/${memberId}/now`), refetchInterval: 2000 });
  const chatQ = useQuery({ queryKey: ["member-chat", projectId, memberId], queryFn: () => api<MemberChatView>("GET", `/projects/${projectId}/members/${memberId}/chat`), refetchInterval: 2000, enabled: canChat, retry: false });
  const now = nowQ.data;
  const chat = chatQ.data;
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const log = useRef<HTMLDivElement>(null);
  const clock = useNow();
  const t = now?.ticket ?? null;
  // チケットを受け持っていないメンバーには話しかけられない(サーバーが断る)
  const canSpeak = canChat && !!t;
  useEffect(() => {
    log.current?.scrollTo({ top: log.current.scrollHeight });
  }, [chat?.messages.length, chat?.work?.state]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);

  async function send() {
    const body = text.trim();
    if (!body || busy) return;
    setBusy(true);
    setError(null);
    try {
      const next = await post<MemberChatView>(`/projects/${projectId}/members/${memberId}/chat`, { body });
      qc.setQueryData(["member-chat", projectId, memberId], next);
      setText("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const typing = chat?.work?.state === "typing" ? Math.max(0, Math.round((clock - Date.parse(chat.work.startedAt)) / 1000)) : null;
  const name = now?.member.name ?? "メンバー";
  const kindLabel = t ? (KINDS.find((k) => k.key === (nowKind(now)))?.label ?? "") : "";
  return (
    <aside className="of-drawer" aria-label={`${name} の様子と会話`}>
      <header>
        <Avatar name={name} asleep={now?.state === "idle"} className="of-drawer-av" />
        <div className="of-drawer-who">
          <h2>{name}</h2>
          <span>{[now?.member.unit, now?.doing?.model, now ? STATE_LABEL[now.state] : null].filter(Boolean).join("・")}</span>
        </div>
        {now && <Chip tone={now.state === "idle" ? "default" : "review"}>{STATE_LABEL[now.state]}</Chip>}
        <button type="button" className="of-x" aria-label="閉じる" onClick={close}>
          ×
        </button>
      </header>
      <div className="of-drawer-body">
        <section aria-label="今のチケット">
          <p className="of-sh">{now?.state === "idle" ? "手すき" : "今のチケット"}</p>
          {now && t && now.state !== "idle" && (
            <div className="of-now">
              <div className="of-now-t">
                <span className="mono">#{t.number}</span>
                <b>{t.title}</b>
                <Chip tone="neutral">
                  <span aria-hidden="true">{KIND_SHAPE[nowKind(now)] ?? "●"}</span> {kindLabel}
                </Chip>
              </div>
              {now.doing?.live && <div className="of-doing">{now.doing.live}</div>}
              <div className="of-kv">
                <span>工程 <b>{STAGE[t.stage] ?? t.stage}</b></span>
                <span>往復 <b>{t.rounds}</b></span>
                <span>経過 <b>{t.activeMin} 分</b></span>
                <span>トークン <b>{kfmt(t.tokens)}</b></span>
              </div>
              <TicketLink id={t.id}>チケットを開く</TicketLink>
            </div>
          )}
          {now && now.state === "idle" && (
            <div className="of-now">
              {now.last ? (
                <>
                  <div className="of-now-t">
                    直前に終えたチケット: <span className="mono">#{now.last.number}</span>
                    <b>{now.last.title}</b>
                  </div>
                  {t && <TicketLink id={t.id}>チケットを開く</TicketLink>}
                </>
              ) : (
                <div className="hint">まだチケットを受け持っていません</div>
              )}
            </div>
          )}
        </section>
        <section aria-label="直近の手順">
          <p className="of-sh">直近の手順</p>
          {now && now.steps.length > 0 ? (
            <ul className="of-steps">
              {[...now.steps].reverse().map((s, i) => (
                <li key={i}>
                  <span className="mono">{hhmm(s.at)}</span>
                  {s.text}
                </li>
              ))}
            </ul>
          ) : (
            <div className="hint">まだありません</div>
          )}
        </section>
        <section className="of-chat" aria-label="このメンバーと話す">
          <p className="of-sh">このメンバーと話す</p>
          {canChat ? (
            <div className="of-log" ref={log} role="log" aria-label="会話">
              {chat?.messages.map((m) =>
                m.who === "system" ? (
                  <span key={m.id} className="of-sys">{m.body}</span>
                ) : (
                  <div key={m.id} className={`of-msg ${m.who === "owner" ? "of-me" : "of-them"}`}>
                    <small>{m.who === "owner" ? "あなた" : name} {hhmm(m.at)}</small>
                    {m.body}
                  </div>
                ),
              )}
              {chat?.work?.state === "typing" && <span className="of-typing" role="status">返事を書いています… {typing} 秒</span>}
              {chat?.work?.state === "queued" && <span className="of-typing" role="status">今の仕事が終わるのを待っています</span>}
            </div>
          ) : (
            <div className="hint">{name} は島に属さない担当です。リーダーとは上の「リーダーと話す」から話せます。</div>
          )}
          {canChat && <div className="hint of-note">話したことは今のチケットのメモに残ります。担当や工程は変わりません。新しい仕事の頼みはリーダーに回します</div>}
          {error && <div className="of-err" role="alert">{error}</div>}
        </section>
      </div>
      {canChat && (
        <footer>
          <Input aria-label={`${name} に伝える・聞く`} placeholder={t ? `#${t.number} について伝える・聞く` : "まだチケットがないので話せません"} value={text} disabled={!canSpeak} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && send()} />
          <Button variant="primary" disabled={!canSpeak || busy || !text.trim()} onClick={send}>
            送る
          </Button>
        </footer>
      )}
    </aside>
  );
}

const nowKind = (n: MemberNow | undefined): string => n?.ticket?.kind ?? "feature";
