import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, post } from "./api";
import { useAct } from "./hooks";
import { Btn } from "./ui";
import { Input } from "./dads/Input";
import { Select } from "./dads/Select";
import { BudgetInput, budgetOk as totalOk } from "./BudgetInput";
import { Checkbox } from "./dads/Checkbox";
import { Textarea } from "./dads/Textarea";
import { usd } from "./format";

const REPO_ROLES = ["フロント", "API", "インフラ", "その他"];
const repoOk = (r: string) => /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(r);
/** git のブランチ名として使えるか(サーバーの branchNameOk と同じ決まり)。空は「既定のブランチ」。 */
const branchOk = (s: string) =>
  !s ||
  (s !== "@" &&
    !s.startsWith("-") &&
    !/[\s~^:?*[\\\x00-\x1f\x7f]/.test(s) &&
    !s.includes("..") &&
    !s.includes("@{") &&
    !s.includes("//") &&
    !s.startsWith("/") &&
    !s.endsWith("/") &&
    !s.endsWith(".") &&
    !s.endsWith(".lock") &&
    s.split("/").every((part) => part && !part.startsWith(".")));
type Settings = { name: string; dataDir: string; repos: { fullName: string; role: string }[]; ticketBudgetUsd: number | null; projectBudgetUsd: number | null; projectSpentUsd: number; nonstop: boolean; autoMerge: boolean; resumeChecks: boolean; patrolMin: number; planWeb: boolean; planWebDomains: string; ciMode: "team" | "github"; ciCommands: Record<string, string>; baseBranches: Record<string, string>; branchPrefix: string };

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
  const [patrolMin, setPatrolMin] = useState("5");
  const [ciMode, setCiMode] = useState<"team" | "github">("github");
  const [planWeb, setPlanWeb] = useState(true);
  const [planWebDomains, setPlanWebDomains] = useState("");
  const [ciCommands, setCiCommands] = useState<Record<string, string>>({});
  const [baseBranches, setBaseBranches] = useState<Record<string, string>>({});
  const [branchPrefix, setBranchPrefix] = useState("");
  const reset = () => {
    if (!data) return;
    setName(data.name);
    setBudget(data.ticketBudgetUsd);
    setTotal(data.projectBudgetUsd);
    setNonstop(data.nonstop);
    setAutoMerge(data.autoMerge);
    setResume(data.resumeChecks);
    setPatrolMin(String(data.patrolMin));
    setCiMode(data.ciMode);
    setPlanWeb(data.planWeb);
    setPlanWebDomains(data.planWebDomains);
    setCiCommands(data.ciCommands);
    setBaseBranches(data.baseBranches);
    setBranchPrefix(data.branchPrefix);
    setRepos(data.repos.map((x) => ({ r: x.fullName, role: x.role })));
  };
  useEffect(() => {
    reset();
  }, [data]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!data) return <section aria-label="プロジェクトの設定" />;

  const set = (i: number, patch: Partial<{ r: string; role: string }>) => setRepos(repos.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const list = repos.filter((x) => x.r).map((x) => ({ fullName: x.r, role: x.role }));
  const budgetOk = totalOk(budget);
  const bases = Object.fromEntries(list.map((x) => [x.fullName, (baseBranches[x.fullName] ?? "").trim()]));
  const basesBefore = Object.fromEntries(list.map((x) => [x.fullName, data.baseBranches[x.fullName] ?? ""]));
  const changed = name !== data.name || JSON.stringify(list) !== JSON.stringify(data.repos) || budget !== data.ticketBudgetUsd || total !== data.projectBudgetUsd || nonstopOn !== data.nonstop || autoMergeOn !== data.autoMerge || resumeOn !== data.resumeChecks || patrolMin !== String(data.patrolMin) || planWeb !== data.planWeb || planWebDomains !== data.planWebDomains || ciMode !== data.ciMode || JSON.stringify(ciCommands) !== JSON.stringify(data.ciCommands) || JSON.stringify(bases) !== JSON.stringify(basesBefore) || branchPrefix.trim() !== data.branchPrefix;
  const patrolOk = /^\d+$/.test(patrolMin);
  // 頭のあとに番号が付くので、番号を付けた形で確かめる
  const prefixOk = !branchPrefix.trim() || branchOk(`${branchPrefix.trim()}1`);
  const invalid = !name.trim() || !list.length || list.some((x) => !repoOk(x.fullName)) || !budgetOk || !totalOk(total) || !patrolOk || Object.values(bases).some((b) => !branchOk(b)) || !prefixOk;
  const save = () => act(() => post(`/projects/${id}/settings`, { name: name.trim(), repos: list, ticketBudgetUsd: budget, projectBudgetUsd: total, nonstop: nonstopOn, autoMerge: autoMergeOn, resumeChecks: resumeOn, patrolMin: Number(patrolMin), planWeb, planWebDomains, ciMode, ciCommands, baseBranches: bases, branchPrefix: branchPrefix.trim() }), "プロジェクトの設定を保存しました");

  return (
    <section aria-label="プロジェクトの設定">
      <div className="form">
        <div>
          <h2 style={{ margin: 0, fontSize: 24 }}>プロジェクトの設定</h2>
          <p className="hint" style={{ margin: "4px 0 0" }}>
            名前とリポジトリを変えられます。PR や作業の記録があるリポジトリと、編成の島が受け持っているリポジトリは外せません。merge 先のブランチを変えると、これから作る PR の向き先と、作業・チームの CI の起点がそのブランチになります(出してある PR の向き先は変わりません)。
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
              {x.r && repoOk(x.r) && (
                <div style={{ margin: "0 0 10px" }}>
                  <label className="h" htmlFor={`ps-base${i}`}>
                    {x.r} の merge 先のブランチ
                  </label>
                  <div className="hint" style={{ marginBottom: 6 }}>
                    PR の向き先です(例: <code>develop</code>)。空ならリポジトリの既定のブランチ(GitHub の default branch)に向けます
                  </div>
                  <Input
                    type="text"
                    id={`ps-base${i}`}
                    blockSize="md"
                    isError={!branchOk((baseBranches[x.r] ?? "").trim())}
                    className="w-full font-mono"
                    value={baseBranches[x.r] ?? ""}
                    onChange={(e) => setBaseBranches({ ...baseBranches, [x.r]: e.target.value })}
                  />
                  {!branchOk((baseBranches[x.r] ?? "").trim()) && <div className="bad">git のブランチ名として使えない文字が入っています</div>}
                </div>
              )}
            </div>
          ))}
          <Btn kind="text" size="sm" onClick={() => setRepos([...repos, { r: "", role: "フロント" }])}>
            + リポジトリを足す
          </Btn>
        </div>
        <div>
          <label className="h" htmlFor="ps-prefix">
            作るブランチの名前の頭
          </label>
          <div className="hint" style={{ marginBottom: 6 }}>
            開発が作るブランチは、この頭のあとにチケットの番号(Jira のキーがあればそれ)を付けた名前になります。空なら <code>kuramoto/</code>(例: <code>kuramoto/12</code>)。<code>feature/</code> にすると <code>feature/12</code> です。変えても、もう作ったブランチの名前はそのままです。
          </div>
          <Input type="text" id="ps-prefix" blockSize="md" isError={!prefixOk} className="w-full font-mono" value={branchPrefix} onChange={(e) => setBranchPrefix(e.target.value)} />
          {!prefixOk && <div className="bad">git のブランチ名として使えない文字が入っています</div>}
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
        <fieldset className="runmode">
          <legend className="h">設計で外のサイトを見る</legend>
          <Checkbox size="sm" checked={planWeb} onChange={() => setPlanWeb(!planWeb)}>
            企画スタジオの担当(企画・デザイナー・アーキテクト)が、Web を検索し、ページを読める(公式のドキュメント・版・料金・よく似たサービスを確かめるため)
          </Checkbox>
          {planWeb && (
            <>
              <label className="h" htmlFor="ps-webdom" style={{ marginTop: 8 }}>
                ページを読んでよいドメイン(1 行に 1 つ)
              </label>
              <div className="hint" style={{ marginBottom: 6 }}>
                空なら、どのサイトのページも読めます。書くと、そのドメインとその下だけを読めます(例: <code>developer.mozilla.org</code>・<code>docs.github.com</code>)。検索はどちらでもできます。ページに書かれた指示には従わず、リポジトリの中身を外に出さないよう担当に伝えています。
              </div>
              <Textarea id="ps-webdom" rows={3} className="w-full font-mono" value={planWebDomains} onChange={(e) => setPlanWebDomains(e.target.value)} />
            </>
          )}
        </fieldset>
        <fieldset className="runmode">
          <legend className="h">CI</legend>
          <Select aria-label="CI の扱い" blockSize="md" value={ciMode} onChange={(e) => setCiMode(e.target.value as "team" | "github")}>
            <option value="team">チームの CI を使う(GitHub Actions は止める)</option>
            <option value="github">GitHub Actions の CI を待つ</option>
          </Select>
          <div className="hint">
            チームの CI では、担当が PR を出すたびに Kuramoto がこの PC で(エージェントと同じ閉じ込めの中で)、PR を最新の main と合わせて確認のコマンドを流します。通ったものだけをレビューに回し、merge の直前にも main が進んでいれば流し直します。GitHub の CI を待たないので速く、Actions の利用枠も使いません。切り替えると、リポジトリの GitHub Actions を止めます(戻すと動かします)。ブランチ保護で CI の確認を必須にしていると merge できないので、そのときは必須を外してください。
          </div>
          {ciMode === "team" &&
            list.map((x) => (
              <div key={x.fullName} style={{ marginTop: 8 }}>
                <label className="h" htmlFor={`ps-ci-${x.fullName}`}>
                  {x.fullName} で流すコマンド(1 行に 1 つ、上から順に)
                </label>
                <div className="hint" style={{ marginBottom: 6 }}>
                  空なら package.json から決めます(入れる → lint → 型 → テスト)。例: <code>npm ci</code>・<code>npm run lint</code>・<code>npm run typecheck</code>・<code>npx vitest run</code>
                </div>
                <Textarea
                  id={`ps-ci-${x.fullName}`}
                  rows={4}
                  className="w-full font-mono"
                  value={ciCommands[x.fullName] ?? ""}
                  onChange={(e) => setCiCommands({ ...ciCommands, [x.fullName]: e.target.value })}
                />
              </div>
            ))}
        </fieldset>
        <div>
          <label className="h" htmlFor="ps-patrol">
            リーダーの見回りの間隔(分)
          </label>
          <div className="hint" style={{ marginBottom: 6 }}>
            リーダーがボードを見て、重複したチケットを片付け、同じところを回り続けているチケットに手を打ちます。始業したときは必ず見回り、その後はこの間隔ごとに見ます(気になるものが無ければ起動しません)。0 にすると見回りません。
          </div>
          <Input type="number" id="ps-patrol" blockSize="md" min={0} step={1} isError={!patrolOk} value={patrolMin} onChange={(e) => setPatrolMin(e.target.value.trim())} />
          {!patrolOk && <div className="bad">0 以上の整数(分)を入れてください</div>}
        </div>
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
