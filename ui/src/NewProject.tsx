import { useState } from "react";
import { post } from "./api";
import { go, useAct, useToast } from "./hooks";
import { Btn } from "./ui";
import { Input } from "./dads/Input";
import { Select } from "./dads/Select";

const REPO_ROLES = ["フロント", "API", "インフラ", "その他"];
const repoOk = (r: string) => /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(r);

/** プロジェクトを作る(docs/design.md 6.1)。作ると企画スタジオに進む。 */
export function NewProject() {
  const [name, setName] = useState("");
  const [repos, setRepos] = useState([{ r: "", role: "API" }]);
  // 新しく作るか、既存のリポジトリの続きから始めるか(ADR-0030)
  const [mode, setMode] = useState<"new" | "existing">("new");
  const [label, setLabel] = useState("kuramoto");
  const act = useAct();
  const toast = useToast();
  const set = (i: number, patch: Partial<{ r: string; role: string }>) => setRepos(repos.map((x, j) => (j === i ? { ...x, ...patch } : x)));

  const create = async () => {
    const list = repos.filter((x) => x.r).map((x) => ({ fullName: x.r, role: x.role }));
    if (!name.trim()) return toast("名前を入れてください", true);
    if (!list.length || list.some((x) => !repoOk(x.fullName))) return toast("リポジトリを owner/repo の形で入れてください", true);
    const r = await act(
      () => post<{ id: number }>("/projects", { name: name.trim(), repos: list, mode, ...(mode === "existing" ? { issueLabel: label.trim() } : {}) }),
      mode === "existing" ? "プロジェクトを作りました。担当がリポジトリを読んで、今の状態を下書きにします" : "プロジェクトを作りました。企画担当が要件を聞きに来ます",
    );
    if (r) go(`#/p/${r.id}/studio`);
  };

  return (
    <section aria-label="プロジェクトを作る">
      <div className="form">
        <div>
          <h2 style={{ margin: 0, fontFamily: "var(--f-body)", fontSize: "var(--fs-lg)" }}>プロジェクトを作る</h2>
          <p className="lead-in" style={{ margin: "4px 0 0", color: "var(--muted)", fontSize: "var(--fs-md)" }}>
            1 つのプロジェクトに 1 つのチームが付きます。プロダクトを構成するリポジトリをまとめて登録してください。
          </p>
        </div>
        <div>
          <label className="h" htmlFor="np-name">
            名前
          </label>
          <Input type="text" id="np-name" blockSize="md" aria-describedby="np-name-hint" value={name} onChange={(e) => setName(e.target.value)} className="w-full" />
          <div id="np-name-hint" className="hint">例: acme 予約サイト</div>
        </div>
        <div>
          <label className="h">リポジトリ</label>
          <div className="hint" style={{ marginBottom: 6 }}>owner/repo の形で入力します(例: acme/shop-api)</div>
          {repos.map((x, i) => (
            <div key={i}>
              <div className="rrow">
                <label className="sr" htmlFor={`np-r${i}`}>
                  リポジトリ {i + 1}
                </label>
                <Input type="text" id={`np-r${i}`} blockSize="md" isError={!!x.r && !repoOk(x.r)} value={x.r} onChange={(e) => set(i, { r: e.target.value.trim() })} className="w-full font-mono" />
                <Select aria-label="役割" blockSize="md" value={x.role} onChange={(e) => set(i, { role: e.target.value })}>
                  {REPO_ROLES.map((r) => (
                    <option key={r}>{r}</option>
                  ))}
                </Select>
                <Btn kind="text" size="sm" aria-label="削除" onClick={() => setRepos(repos.length > 1 ? repos.filter((_, j) => j !== i) : [{ r: "", role: "API" }])}>
                  削除
                </Btn>
              </div>
              <div className={x.r ? (repoOk(x.r) ? "ok" : "bad") : ""} style={{ margin: "-2px 0 6px" }}>
                {x.r ? (repoOk(x.r) ? "書式 OK" : "owner/repo の形で入力してください") : ""}
              </div>
            </div>
          ))}
          <Btn kind="text" size="sm" onClick={() => setRepos([...repos, { r: "", role: "フロント" }])}>
            + リポジトリを足す
          </Btn>
        </div>
        <fieldset className="runmode">
          <legend className="h">始め方</legend>
          <Select aria-label="始め方" blockSize="md" value={mode} onChange={(e) => setMode(e.target.value as "new" | "existing")}>
            <option value="new">新しく作る(企画担当が要件を聞くところから)</option>
            <option value="existing">既存のリポジトリの続きから</option>
          </Select>
          {mode === "existing" && (
            <>
              <div className="hint">
                担当がリポジトリ(README・docs・コード)を読んで、目的・要件(できているもの / 残っているもの)・インフラ・設計を下書きに起こします。あなたは確かめて、違うところだけ直して合意します。画面の試作は、既にある画面と重なるので省きます(企画スタジオで戻せます)。チームに渡すとき、開いている PR は確認の工程から引き継ぎ、Issue はチケットにします。
              </div>
              <label className="h" htmlFor="np-label" style={{ marginTop: 8 }}>
                チケットにする Issue のラベル
              </label>
              <Input type="text" id="np-label" blockSize="md" value={label} onChange={(e) => setLabel(e.target.value)} className="font-mono" />
              <div className="hint">このラベルの付いた開いている Issue だけを拾います。空にすると、開いている Issue をすべて拾います。</div>
            </>
          )}
        </fieldset>
        <div className="btns">
          <Btn kind="solid-fill" onClick={create}>
            次へ: 企画スタジオ
          </Btn>
          <Btn kind="outline" onClick={() => go("#/")}>
            やめる
          </Btn>
        </div>
      </div>
    </section>
  );
}
