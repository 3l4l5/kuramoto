import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { del } from "./api";
import { go, useAct } from "./hooks";
import { Btn } from "./ui";
import { Notice, TextField } from "./ds";

/**
 * プロジェクトの削除の確認。プロジェクト名を入力するまで、削除は押せない(誤操作を防ぐ)。
 * 消せたら、消したプロジェクトの取得を捨てて、プロジェクト一覧(ホーム)に戻る。
 */
export function DeleteProjectDialog({ id, name, close }: { id: number; name: string; close: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const act = useAct();
  const qc = useQueryClient();
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
  }, []);
  const ok = typed === name;

  const remove = async () => {
    setBusy(true);
    const r = await act(async () => {
      await del(`/projects/${id}`);
      // 消したプロジェクトを取り直しに行かない(行くと「ありません」のエラーが出る)
      qc.removeQueries({ predicate: (q) => q.queryKey[1] === id });
      go("#/");
      return true;
    }, "プロジェクトを削除しました");
    if (!r) setBusy(false);
  };

  return (
    <dialog ref={ref} className="ticketdialog" style={{ width: "min(520px, 94vw)" }} aria-label="プロジェクトの削除" onClose={close} onCancel={close}>
      <header>
        <h2>プロジェクトを削除</h2>
        <Btn kind="text" size="sm" style={{ marginLeft: "auto" }} onClick={() => ref.current?.close()}>
          閉じる
        </Btn>
      </header>
      <div style={{ padding: "14px 18px", display: "flex", flexDirection: "column", gap: 12 }}>
        <Notice tone="danger" title="元に戻せません">
          「{name}」のチケット・やりとり・設定などの記録(画面の画像などのファイルも)と、Kuramoto の作業場所(clone と worktree)を消します。動いているメンバーも止まります。GitHub のリポジトリ・PR・Issue には触れません。
        </Notice>
        <TextField label={`確認のため、プロジェクト名「${name}」を入力してください`} value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" />
        <div className="btns">
          <Btn kind="solid-fill" disabled={!ok || busy} onClick={() => void remove()}>
            削除する
          </Btn>
          <Btn kind="outline" onClick={() => ref.current?.close()}>
            やめる
          </Btn>
        </div>
      </div>
    </dialog>
  );
}
