import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, post } from "./api";
import { useAct } from "./hooks";
import { Btn } from "./ui";
import { DeleteProjectDialog } from "./DeleteProjectDialog";
import { Checkbox, Input, Select, Textarea } from "./ds";
import { BudgetInput, budgetOk as totalOk } from "./BudgetInput";
import { usd } from "./format";

const REPO_ROLES = ["フロント", "API", "インフラ", "その他"];
const repoOk = (r: string) => /^(?!\.{1,2}\/)(?!.*\/\.{1,2}$)[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(r);
type Settings = { name: string; dataDir: string; repos: { fullName: string; role: string }[]; ticketBudgetUsd: number | null; projectBudgetUsd: number | null; projectSpentUsd: number; nonstop: boolean; autoMerge: boolean; resumeChecks: boolean; patrolMin: number; issueComment: boolean; planWeb: boolean; planWebDomains: string; ciMode: "team" | "github"; ciCommands: Record<string, string> };

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
  const [issueCommentOn, setIssueComment] = useState(false);
  const [patrolMin, setPatrolMin] = useState("5");
  const [ciMode, setCiMode] = useState<"team" | "github">("github");
  const [planWeb, setPlanWeb] = useState(true);
  const [planWebDomains, setPlanWebDomains] = useState("");
  const [ciCommands, setCiCommands] = useState<Record<string, string>>({});
  const [deleting, setDeleting] = useState(false);
  const reset = () => {
    if (!data) return;
    setName(data.name);
    setBudget(data.ticketBudgetUsd);
    setTotal(data.projectBudgetUsd);
    setNonstop(data.nonstop);
    setAutoMerge(data.autoMerge);
    setIssueComment(data.issueComment);
    setResume(data.resumeChecks);
    setPatrolMin(String(data.patrolMin));
    setCiMode(data.ciMode);
    setPlanWeb(data.planWeb);
    setPlanWebDomains(data.planWebDomains);
    setCiCommands(data.ciCommands);
    setRepos(data.repos.map((x) => ({ r: x.fullName, role: x.role })));
  };
  useEffect(() => {
    reset();
  }, [data]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!data) return <section aria-label="プロジェクトの設定" />;

  const set = (i: number, patch: Partial<{ r: string; role: string }>) => setRepos(repos.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const list = repos.filter((x) => x.r).map((x) => ({ fullName: x.r, role: x.role }));
  const budgetOk = totalOk(budget);
  const changed = name !== data.name || JSON.stringify(list) !== JSON.stringify(data.repos) || budget !== data.ticketBudgetUsd || total !== data.projectBudgetUsd || nonstopOn !== data.nonstop || autoMergeOn !== data.autoMerge || resumeOn !== data.resumeChecks || patrolMin !== String(data.patrolMin) || issueCommentOn !== data.issueComment || planWeb !== data.planWeb || planWebDomains !== data.planWebDomains || ciMode !== data.ciMode || JSON.stringify(ciCommands) !== JSON.stringify(data.ciCommands);
  const patrolOk = /^\d+$/.test(patrolMin);
  const invalid = !name.trim() || !list.length || list.some((x) => !repoOk(x.fullName)) || !budgetOk || !totalOk(total) || !patrolOk;
  const save = () => act(() => post(`/projects/${id}/settings`, { name: name.trim(), repos: list, ticketBudgetUsd: budget, projectBudgetUsd: total, nonstop: nonstopOn, autoMerge: autoMergeOn, resumeChecks: resumeOn, patrolMin: Number(patrolMin), issueComment: issueCommentOn, planWeb, planWebDomains, ciMode, ciCommands }), "プロジェクトの設定を保存しました");

  return (
    <section aria-label="プロジェクトの設定">
      <div className="form">
        <div>
          <h2 style={{ margin: 0, fontSize: "var(--fs-xl)" }}>プロジェクトの設定</h2>
          <p className="hint" style={{ margin: "4px 0 0" }}>
            名前とリポジトリを変えられます。PR や作業の記録があるリポジトリと、編成の島が受け持っているリポジトリは外せません。
          </p>
        </div>
        <div>
          <label className="h" htmlFor="ps-name">
            名前
          </label>
          <Input type="text" id="ps-name"className="w-full" value={name} onChange={(e) => setName(e.target.value)} />
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
                <Input type="text" id={`ps-r${i}`} invalid={!!x.r && !repoOk(x.r)} className="w-full font-mono" value={x.r} onChange={(e) => set(i, { r: e.target.value.trim() })} />
                <Select aria-label={`リポジトリ ${i + 1} の役割`}value={x.role} onChange={(e) => set(i, { role: e.target.value })}>
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
          <Checkbox checked={nonstopOn} onChange={() => setNonstop(!nonstopOn)}>
            ノンストップで進める(戻せる判断はチームで決め、あなたには報告だけする)
          </Checkbox>
          <Checkbox checked={autoMergeOn} onChange={() => setAutoMerge(!autoMergeOn)}>
            チームが自動で merge する(確認がすべて済み、CI が通り、衝突が無いとき)
          </Checkbox>
          <Checkbox checked={resumeOn} onChange={() => setResume(!resumeOn)}>
            確認のやり直しで、前の会話を引き継ぐ(前回の見立てを覚えている。外すと毎回新しく読み直し、トークンを節約できる)
          </Checkbox>
          <Checkbox checked={issueCommentOn} onChange={() => setIssueComment(!issueCommentOn)}>
            Issue をチケットにしたとき、GitHub の Issue に「チケット #N にしました」とコメントを書く(外に出る操作なので、既定では書きません)
          </Checkbox>
          <div className="hint">
            ノンストップでも、取り消せない操作と、あなたにしかできないこと(秘密情報の登録など)はあなたに上がります。止めたいときは、全体の予算で歯止めを掛けてください。
          </div>
        </fieldset>
        <fieldset className="runmode">
          <legend className="h">設計で外のサイトを見る</legend>
          <Checkbox checked={planWeb} onChange={() => setPlanWeb(!planWeb)}>
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
          <Select aria-label="CI の扱い"value={ciMode} onChange={(e) => setCiMode(e.target.value as "team" | "github")}>
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
          <Input type="number" id="ps-patrol" min={0} step={1} invalid={!patrolOk} value={patrolMin} onChange={(e) => setPatrolMin(e.target.value.trim())} />
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
        <div>
          <div className="h">危険な操作</div>
          <div className="hint" style={{ marginBottom: 6 }}>
            プロジェクトを消します。チケット・やりとり・設定など、このプロジェクトの記録(画面の画像などのファイルも)と、Kuramoto の作業場所(clone と worktree)が消えます。GitHub のリポジトリ・PR・Issue はそのまま残ります。
          </div>
          <Btn kind="outline" onClick={() => setDeleting(true)}>
            このプロジェクトを削除
          </Btn>
        </div>
      </div>
      {deleting && <DeleteProjectDialog id={id} name={data.name} close={() => setDeleting(false)} />}
    </section>
  );
}
