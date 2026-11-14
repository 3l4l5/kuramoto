import { post, type HqView } from "./api";
import { go, useAct, useHq } from "./hooks";
import { STAGE_NAME, usd } from "./format";
import { Btn } from "./ui";
import { WorkSwitch } from "./WorkSwitch";
import { SessionPanel } from "./SessionPanel";

const KIND: Record<string, [string, string]> = { decide: ["判断", "var(--warn)"], merge: ["merge", "var(--ok)"], plan: ["企画", "var(--design)"] };

/** 本部(docs/design.md 6.1)。 */
export function Home() {
  const { data } = useHq();
  if (!data) return <section className="home" aria-label="本部" />;
  const count = (k: string) => data.queue.filter((x) => x.kind === k).length;
  return (
    <section className="home" aria-label="本部">
      <div>
        <h2>本部</h2>
        <p className="lead-in">プロジェクトごとにチームがいて、互いの文脈は混ざりません。ここでは全体を見渡し、新しいプロジェクトを作ります。</p>
      </div>
      <section className="agg" aria-label="全プロジェクトのあなたの対応">
        <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
          <h2 style={{ fontSize: "var(--fs-lg)" }}>あなたの対応(全プロジェクト)</h2>
          <span className="sub" style={{ fontSize: "var(--fs-sm)", color: "var(--muted)" }}>
            判断 {count("decide")} · merge {count("merge")} · 企画 {count("plan")}
          </span>
        </div>
        {data.queue.length === 0 && <div style={{ fontSize: "var(--fs-md)", color: "var(--muted)", padding: "4px 2px" }}>今あなたが対応することはありません。</div>}
        {data.queue.map((x, i) => (
          <div className="rowi" key={i}>
            <span className="k" style={{ background: KIND[x.kind]![1] }}>
              {KIND[x.kind]![0]}
            </span>
            <span>
              <span className="pj">{x.projectName}</span>
              {x.text}
            </span>
            <Btn kind="outline" size="sm" onClick={() => go(x.kind === "plan" ? `#/p/${x.projectId}/studio` : `#/p/${x.projectId}`)}>
              開く
            </Btn>
          </div>
        ))}
      </section>
      <div className="projects">
        {data.projects.map((p) => (
          <ProjectCard key={p.id} p={p} />
        ))}
        <article className="proj new">
          <div>チームを 1 つ立ち上げます</div>
          <Btn kind="solid-fill" size="md" onClick={() => go("#/new")}>
            + プロジェクトを作る
          </Btn>
          <ImportButton />
        </article>
      </div>
      <SessionPanel />
    </section>
  );
}

/** 書き出した設計書(Markdown)から、プロジェクトを復元する。 */
function ImportButton() {
  const act = useAct();
  const restore = async (file: File | undefined) => {
    if (!file) return;
    const markdown = await file.text();
    const r = await act(() => post<{ id: number }>("/projects/import", { markdown }), "設計書からプロジェクトを復元しました");
    if (r) go(`#/p/${r.id}/studio`);
  };
  return (
    <label className="importbtn ds-btn ds-btn--secondary">
      設計書から復元
      <input type="file" accept=".md,text/markdown" aria-label="設計書から復元" onChange={(e) => void restore(e.target.files?.[0]).finally(() => (e.target.value = ""))} />
    </label>
  );
}

function ProjectCard({ p }: { p: HqView["projects"][number] }) {
  const neck = p.metrics.bottleneck;
  const handed = p.planning.handed;
  const state = !handed ? (
    <span className="state" style={{ background: "var(--design-soft)", color: "var(--design)" }}>
      企画中 {p.planning.stagesDone}/{p.planning.stages}
    </span>
  ) : p.running ? (
    <span className="state" style={{ background: "var(--ok-soft)", color: "var(--ok)" }}>
      稼働中
    </span>
  ) : (
    <span className="state" style={{ background: "var(--bg)", color: "var(--muted)" }}>
      終業中
    </span>
  );
  return (
    <article className="proj">
      <div className="head">
        <span className="name">{p.name}</span>
        {state}
      </div>
      <div className="repos">
        {p.repos.map((r) => (
          <span className="repo" key={r.fullName}>
            {r.fullName}
            <i>{r.role}</i>
          </span>
        ))}
      </div>
      <div className="nums">
        <div>
          <div className="l">あなたの対応</div>
          <div className="v">{p.decisions + p.merges}</div>
        </div>
        <div>
          <div className="l">1 件あたり</div>
          <div className="v">{usd(p.metrics.costPerCompletedUsd)}</div>
        </div>
        <div>
          <div className="l">完成</div>
          <div className="v">{p.metrics.completed}</div>
        </div>
      </div>
      <div style={{ fontSize: "var(--fs-sm)", color: "var(--muted)" }}>
        {handed
          ? `進行中のチケット ${p.open} 件 · 作業中 ${p.working} 人${neck ? ` · ボトルネック: ${neck.stage}(待ち ${neck.waiting})` : ""}`
          : `企画スタジオで「${STAGE_NAME[p.planning.current ?? ""] ?? "チームに渡す"}」を決めています。終わるとリーダーがチケットに分けます`}
      </div>
      <div className="acts">
        {handed ? (
          <>
            <Btn kind="solid-fill" size="sm" onClick={() => go(`#/p/${p.id}`)}>
              オフィスを開く
            </Btn>
            <WorkSwitch id={p.id} running={p.running} showState={false} />
            <Btn kind="outline" size="sm" onClick={() => go(`#/p/${p.id}/studio`)}>
              企画スタジオ
            </Btn>
          </>
        ) : (
          <>
            <Btn kind="solid-fill" size="sm" onClick={() => go(`#/p/${p.id}/studio`)}>
              企画スタジオを開く
            </Btn>
            <Btn kind="outline" size="sm" onClick={() => go(`#/p/${p.id}`)}>
              オフィス
            </Btn>
          </>
        )}
      </div>
    </article>
  );
}
