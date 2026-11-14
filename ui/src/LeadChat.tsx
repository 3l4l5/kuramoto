import { useEffect, useRef, useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, post, type LeadChatView } from "./api";
import { hhmm } from "./format";
import { duration, useAct, useNow } from "./hooks";
import { Btn } from "./ui";
import { Input } from "./ds";

/** リーダーとのチャット(非同期)。書いておけば、リーダーがfreeのときに返事をする。 */
export function LeadChat({ id }: { id: number }) {
  const { data } = useQuery({ queryKey: ["lead-chat", id], queryFn: () => api<LeadChatView>("GET", `/projects/${id}/lead-chat`), refetchInterval: 2000 });
  const act = useAct();
  const now = useNow();
  const [text, setText] = useState("");
  const box = useRef<HTMLOListElement>(null);
  useEffect(() => {
    if (box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [data?.messages.length, data?.work?.state]);
  if (!data) return null;
  const send = async (e: FormEvent) => {
    e.preventDefault();
    const t = text.trim();
    if (!t) return;
    setText("");
    await act(() => post(`/projects/${id}/lead-chat`, { body: t }));
  };
  const w = data.work;
  return (
    <div className="leadchat">
      <p className="hint">{data.lead}(リーダー)にいつでも書いておけます。手が空いたときに返事をします。作業を頼むとチケットにし、チケットへの指示は担当に伝えます。</p>
      <ol ref={box} aria-label="リーダーとの会話">
        {data.messages.length === 0 && <li className="hint">まだ会話はありません。</li>}
        {data.messages.map((m) => (
          <li key={m.id} className={`lc-${m.who}`}>
            <span className="who">{m.who === "owner" ? "あなた" : m.who === "lead" ? data.lead : "Kuramoto"}</span>
            <span className="body">{m.body}</span>
            <time>{hhmm(m.at)}</time>
          </li>
        ))}
        {w && (
          <li className="lc-work" aria-live="polite">
            {w.state === "queued" ? (
              <span className="hint">{data.lead}がfreeになったら読みます</span>
            ) : (
              <span className="hint">
                {data.lead}が返事を書いています · 経過 {duration(Math.max(0, Math.round((now - Date.parse(w.startedAt)) / 1000)))}
                {w.live ? ` · ${w.live}` : ""}
              </span>
            )}
          </li>
        )}
      </ol>
      <form className="compose" onSubmit={send}>
        <label className="sr" htmlFor="lead-in">
          リーダーへのメッセージ
        </label>
        <Input id="lead-in" type="text" className="grow" autoComplete="off" value={text} onChange={(e) => setText(e.target.value)} />
        <Btn kind="solid-fill" type="submit">
          送る
        </Btn>
      </form>
    </div>
  );
}
