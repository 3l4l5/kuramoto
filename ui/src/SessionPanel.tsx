import { useEffect, useRef, useState } from "react";
import { useAct } from "./hooks";
import { logout, revokeAllSessions } from "./session";
import { Btn } from "./ui";
import { Notice, SectionHeading } from "./ds";

/**
 * 本部の下の「アクセスの管理」(ADR-0061)。
 * 画面に入れるのは、端末に出た合言葉つきの URL を開いてから 8 時間(セッション)。使い終わったとき、
 * 担当の成果物にこのブラウザの Cookie が届いた疑いがあるときに、ここから止める。
 */
export function SessionPanel() {
  const act = useAct();
  const [confirming, setConfirming] = useState(false);
  return (
    <section className="sessionpanel" aria-label="アクセスの管理">
      <div>
        <SectionHeading>アクセスの管理</SectionHeading>
        <p>
          この画面に入れるのは、起動した端末に出る「合言葉つきの URL」を開いてから 8 時間です。使い終わったときは、ログアウトで止められます。担当が動かした成果物にこのブラウザの Cookie が届いた疑いがあるときは、すべてのセッションを失効させてください(合言葉そのものは変わりません)。
        </p>
      </div>
      <div className="acts">
        <Btn kind="outline" onClick={() => void act(logout, "ログアウトしました")}>
          ログアウト
        </Btn>
        <Btn kind="outline" onClick={() => setConfirming(true)}>
          すべてのセッションを失効
        </Btn>
      </div>
      {confirming && <RevokeAllDialog close={() => setConfirming(false)} />}
    </section>
  );
}

/** 「すべてのセッションを失効」の確認。このブラウザも入れなくなる(合言葉つきの URL を開き直す)ので、押す前に伝える。 */
function RevokeAllDialog({ close }: { close: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const act = useAct();
  const busy = useRef(false);
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
  }, []);
  const revoke = async () => {
    if (busy.current) return;
    busy.current = true;
    const n = await act(revokeAllSessions, (n) => `${n} 件のセッションを失効しました`);
    busy.current = false;
    if (n !== undefined) ref.current?.close();
  };
  return (
    <dialog ref={ref} className="ticketdialog sessiondialog" aria-label="すべてのセッションを失効" onClose={close} onCancel={close}>
      <header>
        <h2>すべてのセッションを失効</h2>
        <Btn kind="text" size="sm" style={{ marginLeft: "auto" }} onClick={() => ref.current?.close()}>
          閉じる
        </Btn>
      </header>
      <div className="sessiondialog__body">
        <Notice tone="warn" title="このブラウザも入れなくなります">
          すべてのブラウザ・端末のセッションを止めます。このブラウザも含みます。そのあとは、Kuramoto を起動した端末に出ている「合言葉つきの URL」を開き直してください。合言葉(~/.kuramoto/access-token)は変わりません。
        </Notice>
        <div className="btns">
          <Btn kind="solid-fill" onClick={() => void revoke()}>
            失効する
          </Btn>
          <Btn kind="outline" onClick={() => ref.current?.close()}>
            やめる
          </Btn>
        </div>
      </div>
    </dialog>
  );
}
