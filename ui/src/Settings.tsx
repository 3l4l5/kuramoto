import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, post } from "./api";
import { useAct } from "./hooks";
import { Btn } from "./ui";
import { Input } from "./dads/Input";
import { Select } from "./dads/Select";
import { BudgetInput, budgetOk as totalOk } from "./BudgetInput";
import { Checkbox } from "./dads/Checkbox";
import { usd } from "./format";

const REPO_ROLES = ["フロント", "API", "インフラ", "その他"];
const repoOk = (r: string) => /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(r);
type Settings = { name: string; dataDir: string; repos: { fullName: string; role: string }[]; ticketBudgetUsd: number | null; projectBudgetUsd: number | null; projectSpentUsd: number; nonstop: boolean; autoMerge: boolean; resumeChecks: boolean };

/** プロジェクトの設定: 名前とリポジトリ(足す・外す・役割を変える)。 */
export function SettingsPage({ id }: { id: number }) {
  const { data } = useQuery({ queryKey: ["settings", id], queryFn: () => api<Settings>("GET", `/projects/${id}/settings`) });
  const act = useAct();
  const [name, setName] = useState("");
  const [repos, setRepos] = useState<{ r: string; role: string }[]>([]);
  const [budget, setBudget] = useState<number | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [nonstopOn, setNonstop] = useState(true);
  const [autoMergeOn, setAutoMerge] = useState(true);
  const [resumeOn, setResume] = useState(true);
  const reset = () => {
    if (!data) return;
    setName(data.name);
    setBudget(data.ticketBudgetUsd);
    setTotal(data.projectBudgetUsd);
    setNonstop(data.nonstop);
    setAutoMerge(data.autoMerge);
    setResume(data.resumeChecks);
    setRepos(data.repos.map((x) => ({ r: x.fullName, role: x.role })));
  };
  useEffect(() => {
    reset();
  }, [data]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!data) return <section aria-label="プロジェクトの設定" />;

  const set = (i: number, patch: Partial<{ r: string; role: string }>) => setRepos(repos.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const list = repos.filter((x) => x.r).map((x) => ({ fullName: x.r, role: x.role }));
  const budgetOk = totalOk(budget);
  const changed = name !== data.name || JSON.stringify(list) !== JSON.stringify(data.repos) || budget !== data.ticketBudgetUsd || total !== data.projectBudgetUsd || nonstopOn !== data.nonstop || autoMergeOn !== data.autoMerge || resumeOn !== data.resumeChecks;
  const invalid = !name.trim() || !list.length || list.some((x) => !repoOk(x.fullName)) || !budgetOk || !totalOk(total);
  const save = () => act(() => post(`/projects/${id}/settings`, { name: name.trim(), repos: list, ticketBudgetUsd: budget, projectBudgetUsd: total, nonstop: nonstopOn, autoMerge: autoMergeOn, resumeChecks: resumeOn }), "プロジェクトの設定を保存しました");

  return (
    <section aria-label="プロジェクトの設定">
      <div className="form">
        <div>
          <h2 style={{ margin: 0, fontSize: 24 }}>プロジェクトの設定</h2>
          <p className="hint" style={{ margin: "4px 0 0" }}>
            名前とリポジトリを変えられます。PR や作業の記録があるリポジトリと、編成の島が受け持っているリポジトリは外せません。
          </p>
        </div>
        <div>
          <label className="h" htmlFor="ps-name">
            名前
          </label>
          <Input type="text" id="ps-name" blockSize="md" className="w-full" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div>
          <label className="h">リポジトリ</label>
          <div className="hint" style={{ marginBottom: 6 }}>
            owner/repo の形で入力します
          </div>
          {repos.map((x, i) => (
            <div key={i}>
              <div className="rrow">
                <label className="sr" htmlFor={`ps-r${i}`}>
                  リポジトリ {i + 1}
                </label>
                <Input type="text" id={`ps-r${i}`} blockSize="md" isError={!!x.r && !repoOk(x.r)} className="w-full font-mono" value={x.r} onChange={(e) => set(i, { r: e.target.value.trim() })} />
                <Select aria-label={`リポジトリ ${i + 1} の役割`} blockSize="md" value={x.role} onChange={(e) => set(i, { role: e.target.value })}>
                  {REPO_ROLES.map((r) => (
                    <option key={r}>{r}</option>
                  ))}
                </Select>
                <Btn kind="text" size="sm" aria-label={`リポジトリ ${i + 1} を外す`} onClick={() => setRepos(repos.filter((_, j) => j !== i))}>
                  外す
                </Btn>
              </div>
              {x.r && !repoOk(x.r) && (
                <div className="bad" style={{ margin: "-2px 0 6px" }}>
                  owner/repo の形で入力してください
                </div>
              )}
            </div>
          ))}
          <Btn kind="text" size="sm" onClick={() => setRepos([...repos, { r: "", role: "フロント" }])}>
            + リポジトリを足す
          </Btn>
        </div>
        <fieldset className="runmode">
          <legend className="h">進め方</legend>
          <Checkbox size="sm" checked={nonstopOn} onChange={() => setNonstop(!nonstopOn)}>
            ノンストップで進める(戻せる判断はチームで決め、あなたには報告だけする)
          </Checkbox>
          <Checkbox size="sm" checked={autoMergeOn} onChange={() => setAutoMerge(!autoMergeOn)}>
            チームが自動で merge する(確認がすべて済み、CI が通り、衝突が無いとき)
          </Checkbox>
          <Checkbox size="sm" checked={resumeOn} onChange={() => setResume(!resumeOn)}>
            確認のやり直しで、前の会話を引き継ぐ(前回の見立てを覚えている。外すと毎回新しく読み直し、トークンを節約できる)
          </Checkbox>
          <div className="hint">
            ノンストップでも、取り消せない操作と、あなたにしかできないこと(秘密情報の登録など)はあなたに上がります。止めたいときは、全体の予算で歯止めを掛けてください。
          </div>
        </fieldset>
        <div>
          <label className="h" htmlFor="ps-total">
            全体の予算(ドル)
          </label>
          <div className="hint" style={{ marginBottom: 6 }}>
            このプロジェクトで使ってよい金額の合計です(企画・リーダーの起動も含む)。使い切るとチームは止まり、予算を足すか無制限にすると再開します。これまでに使った額: {usd(data.projectSpentUsd)}
          </div>
          <BudgetInput id="ps-total" name="全体の予算" value={total} onChange={setTotal} />
          {!totalOk(total) && <div className="bad">0 より大きい金額を入れるか、無制限にしてください</div>}
        </div>
        <div>
          <label className="h" htmlFor="ps-budget">
            チケット 1 枚の予算(ドル)
          </label>
          <div className="hint" style={{ marginBottom: 6 }}>
            1 枚のチケットで使ってよい金額の既定です。使い切ると止まり、続けるかを聞きます。無制限にすると、チケットの予算では止まりません(全体の予算・島の予算は別に効きます)。チケットごとの額は、チケットの詳細で変えられます。
          </div>
          <BudgetInput id="ps-budget" name="チケット 1 枚の予算" value={budget} onChange={setBudget} />
          {!budgetOk && <div className="bad">0 より大きい金額を入れるか、無制限にしてください</div>}
        </div>
        <div className="hint">データの置き場所: {data.dataDir}(リポジトリを変えても移りません)</div>
        <div className="btns">
          <Btn kind="solid-fill" disabled={!changed || invalid} onClick={save}>
            保存する
          </Btn>
          {changed && (
            <Btn kind="outline" onClick={reset}>
              変更を捨てる
            </Btn>
          )}
        </div>
      </div>
    </section>
  );
}
