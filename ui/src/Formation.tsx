import { useEffect, useState } from "react";
import { drawerFromUrl } from "./phoneNav";
import { setDraftRoutes, takeRequestedTab, useFormationUi } from "./formationUi";
import { post, type TeamView } from "./api";
import { useAct } from "./hooks";
import { Btn } from "./ui";
import { Chip, Drawer, List, ListItem, Notice, Segmented, SectionHeading, Select, type ChipTone } from "./ds";
import { History, newUnit, toFullSpec, UnitFields } from "./Team";
import { MAX_UNITS, pipelineOf, validateFormation, type FormationSpec, type UnitSpec } from "../../src/domain/formation";
import { KIND_LABEL, type Flow } from "../../src/domain/flow";
import { routeErrors } from "../../src/domain/route";
import { validateFlows } from "../../src/domain/flow";
import { MODELS, ROLE_LABEL, type WorkRole } from "../../src/domain/roles";
import {
  changeCounts,
  changeSummary,
  effectiveFlow,
  flowDraftErrors,
  FLOW_KEYS,
  flowRows,
  hasOwnFlow,
  moveStage,
  preDevStages,
  routeModeOf,
  routePairs,
  routesToNames,
  setStage,
  withFlow,
  withRoute,
  type FlowKey,
} from "../../src/domain/formation-edit";

/**
 * 編成の引き出し(ADR-0007)。「島 / 連絡経路 / 流れ」の 3 タブで 1 つの下書きを持ち、保存は 3 タブまとめて 1 回(版が 1 つ上がる)。
 */
type Tab = "islands" | "routes" | "flows";

const roleTone = (roles: WorkRole[]): ChipTone => (roles[0] === "review" ? "review" : roles[0] === "qa" ? "design" : roles[0] === "sec" ? "warn" : "default");
const FLOW_LABEL = (k: FlowKey) => (k === "default" ? "既定の流れ" : KIND_LABEL[k]);
const arrow = (flow: readonly WorkRole[]) => flow.map((r) => ROLE_LABEL[r]).join("→");

/** 下書き。ids は島ごとの変わらない印(もとの島は今の版の名前、足した島は新しい印)。経路の端はこの印で持つ。 */
type Draft = { spec: FormationSpec; ids: string[] };
const loadDraft = (v: TeamView["formation"]["versions"][number]): Draft => ({ spec: toFullSpec(v), ids: v.units.map((u) => u.name) });
let newIsland = 0;

export function FormationDrawer({ id, t, close }: { id: number; t: TeamView; close: () => void }) {
  const act = useAct();
  const currentV = t.formation.versions.find((v) => v.version === t.formation.current)!;
  const current = toFullSpec(currentV);
  const [{ spec: draft, ids }, setState] = useState<Draft>(() => loadDraft(currentV));
  const [tab, setTab] = useState<Tab>(() => {
    const u = drawerFromUrl();
    return u.drawer === "formation" && (u.tab === "routes" || u.tab === "flows") ? u.tab : "islands";
  });
  const req = useFormationUi().request;
  // 床の凡例の「経路を変える」「流れを変える」から開かれたら、そのタブに切り替える
  useEffect(() => {
    const t = takeRequestedTab();
    if (t) setTab(t);
  }, [req.seq]);
  const [asking, setAsking] = useState(false);
  // 島タブで右に出して編集している島(一覧で選ぶ)。タブを行き来しても保つ
  const [sel, setSel] = useState(0);
  // 他の場所で版が上がったら、下書きを今の版に合わせ直す
  useEffect(() => {
    setState(loadDraft(currentV));
  }, [currentV.version]); // eslint-disable-line react-hooks/exhaustive-deps
  const setDraft = (f: FormationSpec | ((d: FormationSpec) => FormationSpec)) => setState((s) => ({ ...s, spec: typeof f === "function" ? f(s.spec) : f }));

  // 検証と保存は、経路の端を今の島の名前に直した形で行う
  const names = draft.units.map((u) => u.name);
  const named: FormationSpec = { ...draft, routes: routesToNames(draft.routes, ids, names) };
  const counts = changeCounts(current, draft, ids);
  const changed = counts.islands + counts.routes + counts.flows > 0;
  const all = validateFormation(named, t.repos);
  const flowErrs = validateFlows(draft.flows);
  const routeErrs = routeErrors(named.routes, names);
  // 連絡経路タブを開いている間は、保存前の案をオフィスの床に重ねる(閉じる・ほかのタブでは消す)
  const askJson = JSON.stringify((named.routes ?? []).filter((r) => r.mode === "ask").map((r) => ({ a: r.from, b: r.to })));
  useEffect(() => {
    setDraftRoutes(tab === "routes" ? JSON.parse(askJson) : null);
  }, [tab, askJson]);
  useEffect(() => () => setDraftRoutes(null), []);
  const islandErrs = all.filter((e) => !flowErrs.includes(e) && !routeErrs.includes(e));
  const nextVersion = t.formation.versions.length + 1;

  const setUnit = (i: number, patch: Partial<UnitSpec>) => setDraft((d) => ({ ...d, units: d.units.map((u, j) => (j === i ? { ...u, ...patch } : u)) }));
  const addUnit = () => {
    setSel(draft.units.length);
    setState((s) => ({ spec: { ...s.spec, units: [...s.spec.units, newUnit(s.spec)] }, ids: [...s.ids, `\u0001${++newIsland}`] }));
  };
  const removeUnit = (i: number) => {
    setSel(Math.max(0, i - 1));
    setState((s) => {
      const gone = s.ids[i]!;
      return {
        spec: { ...s.spec, units: s.spec.units.filter((_, j) => j !== i), routes: (s.spec.routes ?? []).filter((r) => r.from !== gone && r.to !== gone) },
        ids: s.ids.filter((_, j) => j !== i),
      };
    });
  };

  const save = () =>
    act(
      () => post<{ version: number }>(`/projects/${id}/formation`, { pull: named.pull, units: named.units, flows: named.flows ?? {}, routes: named.routes ?? [] }),
      (r) => `編成 v${r.version} を適用しました`,
    );
  const requestClose = () => (changed ? setAsking(true) : close());

  const msg = asking
    ? "保存してない変更があります。捨てて閉じますか。"
    : all.length
      ? `保存できません: ${all[0]}${all.length > 1 ? ` ほか ${all.length - 1} 件` : ""}`
      : changeSummary(counts);

  return (
    <aside className={`drawer formation${tab === "flows" ? " wide" : tab === "islands" ? " mid" : ""}`} aria-label="編成">
      <Drawer
        title="編成"
        version={`v${t.formation.current}`}
        onClose={requestClose}
        activeTab={tab}
        onTabChange={setTab}
        tabs={[
          { key: "islands", label: "島", count: counts.islands, error: islandErrs.length > 0 },
          { key: "routes", label: "連絡経路", count: counts.routes, error: routeErrs.length > 0 },
          { key: "flows", label: "流れ", count: counts.flows, error: flowErrs.length > 0 },
        ]}
        footer={
          <>
            <span className={`msg${all.length && !asking ? " bad" : ""}`} role={all.length && !asking ? "alert" : undefined}>
              {msg}
            </span>
            {asking ? (
              <>
                <Btn kind="text" size="md" onClick={close}>
                  捨てて閉じる
                </Btn>
                <Btn kind="solid-fill" size="md" onClick={() => setAsking(false)}>
                  戻る
                </Btn>
              </>
            ) : (
              <>
                <Btn kind="text" size="md" disabled={!changed} onClick={() => setState(loadDraft(currentV))}>
                  元に戻す
                </Btn>
                <Btn kind="solid-fill" size="md" disabled={!changed || all.length > 0} onClick={save}>
                  保存して v{nextVersion} にする
                </Btn>
              </>
            )}
          </>
        }
      >
        {tab === "islands" && <IslandsTab t={t} current={current} ids={ids} sel={Math.min(sel, draft.units.length - 1)} setSel={setSel} draft={draft} setDraft={setDraft} setUnit={setUnit} addUnit={addUnit} removeUnit={removeUnit} errors={islandErrs} currentV={currentV} load={(v) => setState(loadDraft(v))} />}
        {tab === "routes" && <RoutesTab draft={draft} ids={ids} setDraft={setDraft} errors={routeErrs} />}
        {tab === "flows" && <FlowsTab draft={draft} current={current} setDraft={setDraft} />}
      </Drawer>
    </aside>
  );
}

// ---- 島 ----

type TabProps = { draft: FormationSpec; setDraft: (f: FormationSpec | ((d: FormationSpec) => FormationSpec)) => void };

type Version = TeamView["formation"]["versions"][number];
type IslandsProps = TabProps & {
  t: TeamView;
  current: FormationSpec;
  ids: string[];
  sel: number;
  setSel: (i: number) => void;
  setUnit: (i: number, p: Partial<UnitSpec>) => void;
  addUnit: () => void;
  removeUnit: (i: number) => void;
  load: (v: Version) => void;
  errors: string[];
  currentV: Version;
};

/** 左に島の一覧、右に選んだ島の編集。仕事の取り方・工程・版の履歴は編成全体のことなので、右の下にまとめる。 */
function IslandsTab({ t, current, ids, sel, setSel, draft, setDraft, setUnit, addUnit, removeUnit, errors, currentV, load }: IslandsProps) {
  const u = draft.units[sel]!;
  const before = new Map(current.units.map((x) => [x.name, x]));
  const state = (x: UnitSpec, i: number) => {
    const old = before.get(ids[i]!);
    return !old ? "追加" : JSON.stringify(old) !== JSON.stringify(x) ? "変更" : null;
  };
  const members = t.formation.members[currentV.units[sel]?.name ?? ""];
  return (
    <div className="islandtab">
      <aside className="islands">
        <SectionHeading>{`島 ${draft.units.length} / ${MAX_UNITS}`}</SectionHeading>
        <List label="島の一覧">
          {draft.units.map((x, i) => {
            const mark = state(x, i);
            return (
              <ListItem
                key={ids[i]}
                selected={i === sel}
                onClick={() => setSel(i)}
                title={
                  <span className="islandname">
                    <span className={`dot ${roleTone(x.roles)}`} aria-hidden="true" />
                    <b>{x.name || `島 ${i + 1}`}</b>
                  </span>
                }
                meta={mark ? <span className="islandmark">{mark}</span> : undefined}
              />
            );
          })}
        </List>
        {draft.units.length < MAX_UNITS && (
          <Btn kind="text" size="sm" onClick={addUnit}>
            + 島を足す({MAX_UNITS} つまで)
          </Btn>
        )}
      </aside>
      <div className="islandmain pol">
        <p className="hint">島ごとに、持つ役割と人数を決めます。同じ役割を複数の島に持たせると、手の空いている島が取ります。島に受け持つリポジトリを決めると、そのリポジトリのチケットだけを取ります(開発をフロントと API に分けるなど)。工程は持っている役割から、「流れ」タブで決めた順に組み立てます。保存すると版が上がり、席替えが起きます。</p>
        <div className="knobs unit" key={ids[sel]}>
          <UnitFields u={u} i={sel} repos={t.repos} set={(patch) => setUnit(sel, patch)} remove={draft.units.length > 1 ? () => removeUnit(sel) : undefined} />
          {members && <div className="hint">今いるメンバー: {members.map((m) => `${m.name}${m.helper ? "(応援)" : ""}`).join("、") || "なし"}</div>}
        </div>
        <div>
          <label className="h" htmlFor="pull">
            仕事の取り方
          </label>
          <Select id="pull" size="sm" className="w-full" value={draft.pull} onChange={(e) => setDraft((d) => ({ ...d, pull: e.target.value as FormationSpec["pull"] }))}>
            <option value="down">下流優先(仕掛かりを先に片付ける)</option>
            <option value="start">着手優先(新しいチケットを先に取る)</option>
          </Select>
        </div>
        <div className="preview">
          工程: {pipelineOf(draft).map((r) => ROLE_LABEL[r]).join(" → ")}
          {pipelineOf(draft).length ? " → merge 待ち" : ""}
        </div>
        {errors.length > 0 && (
          <ul className="errors" aria-label="編成の問題">
            {errors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        )}
        <History
          title="編成の版"
          items={[...t.formation.versions].reverse().map((v) => ({
            key: v.version,
            label: `v${v.version}${v.version === t.formation.current ? "(今)" : ""}`,
            detail: `${v.units.map((x) => `${x.name}: ${x.roles.map((r) => ROLE_LABEL[r]).join("・") || "役割なし"} ×${x.maxMembers}${x.repos?.length ? `(${x.repos.join("・")})` : ""}${x.model ? ` ${MODELS[x.model as keyof typeof MODELS]?.label ?? x.model}` : ""}${x.effort ? `/${x.effort}` : ""}`).join(" / ")} · ${v.pull === "down" ? "下流優先" : "着手優先"}`,
            load: v.version === t.formation.current ? undefined : () => load(v),
          }))}
        />
      </div>
    </div>
  );
}

// ---- 連絡経路(R16) ----

function RoutesTab({ draft, ids, setDraft, errors }: TabProps & { ids: string[]; errors: string[] }) {
  // 経路の端は島の印(ids)。表に出す名前は、いまの下書きの名前
  const nameOf = (end: string) => (end === "lead" ? "リーダー" : end === "architect" ? "アーキテクト" : (draft.units[ids.indexOf(end)]?.name ?? end));
  const tone = (end: string): ChipTone => roleTone(draft.units[ids.indexOf(end)]?.roles ?? []);
  const pairs = routePairs(ids);
  const chipOf = (n: string) =>
    n === "lead" ? <Chip tone="lead">リーダー</Chip> : n === "architect" ? <Chip tone="lead">アーキテクト</Chip> : <Chip tone={tone(n)}>{nameOf(n)}</Chip>;
  const row = (p: { a: string; b: string }) => {
    const mode = routeModeOf(draft.routes, p.a, p.b);
    const name = `${nameOf(p.a)} と ${nameOf(p.b)}`;
    return (
      <ListItem
        key={`${p.a}|${p.b}`}
        selected={mode === "ask"}
        title={
          <span className="pair">
            {chipOf(p.a)}↔{chipOf(p.b)}
          </span>
        }
        meta={
          <Segmented
            label={`${name}の連絡`}
            value={mode}
            onChange={(m) => setDraft((d) => ({ ...d, routes: withRoute(d.routes, p.a, p.b, m) }))}
            options={[
              { value: "none", label: "連絡しない" },
              { value: "ask", label: "質問・相談できる" },
            ]}
          />
        }
      />
    );
  };
  return (
    <div className="pol">
      <p className="hint">経路があると、メンバーが相手の島に質問を送れ、freeの人が答えます。チケットの担当・工程は変わりません。担当を変えたいときはリーダーに相談します。</p>
      <div>
        <SectionHeading>島どうし</SectionHeading>
        <List label="島どうしの連絡経路">{pairs.filter((p) => p.group === "islands").map(row)}</List>
        {pairs.every((p) => p.group !== "islands") && <p className="hint">島が 1 つだけなので、島どうしの経路はありません。</p>}
      </div>
      <div>
        <SectionHeading>リーダー / アーキテクトと</SectionHeading>
        <List label="リーダー・アーキテクトとの連絡経路">{pairs.filter((p) => p.group === "fixed").map(row)}</List>
      </div>
      {errors.length > 0 && (
        <ul className="errors" aria-label="連絡経路の問題">
          {errors.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      )}
      <Notice tone="warn">経路が無い相手への質問は届かず、リーダーに回ります(やりとりに「経路が無いのでリーダーに回した」と残ります)。</Notice>
    </div>
  );
}

// ---- 流れ(R17) ----

const NODE: Record<WorkRole, string> = { dev: "d", review: "r", sec: "s", qa: "q" };

function FlowsTab({ draft, current, setDraft }: TabProps & { current: FormationSpec }) {
  const [key, setKey] = useState<FlowKey>("default");
  const flows = draft.flows ?? {};
  const own = hasOwnFlow(flows, key);
  const flow = effectiveFlow(flows, key);
  const errors = flowDraftErrors(flows, key);
  const pre = preDevStages(flow);
  const put = (f: Flow | undefined) => setDraft((d) => ({ ...d, flows: withFlow(d.flows, key, f) }));
  const metaOf = (k: FlowKey) => {
    if (k === "default") return arrow(effectiveFlow(flows, "default"));
    if (!hasOwnFlow(flows, k)) return "既定の流れを使う";
    if (JSON.stringify(flows[k]) !== JSON.stringify(current.flows?.[k])) return "専用の流れ(変更あり)";
    const skipped = flowRows(flows[k]!).filter((r) => !r.on).map((r) => ROLE_LABEL[r.role]);
    return skipped.length ? `専用の流れ(${skipped.join("・")} 省略)` : "専用の流れ";
  };
  const rows = flowRows(flow);
  const includedCount = flow.length;
  return (
    <div className="flowtab">
      <aside className="kinds">
        <SectionHeading>チケットの種類</SectionHeading>
        <List label="チケットの種類">
          {FLOW_KEYS.map((k) => (
            <ListItem
              key={k}
              selected={k === key}
              onClick={() => setKey(k)}
              title={
                <span className="kindname">
                  <b>{FLOW_LABEL(k)}</b>
                  <span>{metaOf(k)}</span>
                </span>
              }
            />
          ))}
        </List>
      </aside>
      <div className="flowmain">
        <div className="flowhead">
          <b>{key === "default" ? "既定の流れ" : `${FLOW_LABEL(key)}の流れ`}</b>
          {own ? (
            <Btn kind="outline" size="sm" onClick={() => put(undefined)}>
              既定の流れに戻す
            </Btn>
          ) : key !== "default" ? (
            <Btn kind="outline" size="sm" onClick={() => put([...flow])}>
              専用の流れを作る
            </Btn>
          ) : null}
        </div>
        <div>
          <SectionHeading>流れの図</SectionHeading>
          <div className="diagram" role="img" aria-label={`流れの図: ${arrow(flow)}→merge 待ち`}>
            {rows.map((r, i) => (
              <span key={r.role} className="dg">
                {i > 0 && <span className="ar">→</span>}
                <span className={`n ${NODE[r.role]}${!r.on ? " skip" : pre.includes(r.role) ? " pre" : ""}`}>
                  {ROLE_LABEL[r.role]}
                  {r.on && pre.includes(r.role) && <small>申し送り</small>}
                </span>
              </span>
            ))}
            <span className="ar">→</span>
            <span className="n m">merge 待ち</span>
          </div>
        </div>
        {!own && key !== "default" ? (
          <Notice tone="ok">{FLOW_LABEL(key)}は専用の流れを持たず、既定の流れ(上の図)を使います。専用の流れを作ると、この種類だけ順番や省略を変えられます。</Notice>
        ) : (
          <>
            {errors.length > 0 ? (
              <ul className="errors" aria-label="流れの問題">
                {errors.map((e) => (
                  <li key={e}>{e}</li>
                ))}
              </ul>
            ) : (
              <Notice tone="ok">
                この流れで保存できます。
                {pre.length > 0 && `開発より前の${pre.map((r) => ROLE_LABEL[r]).join("・")}はコードを見ず、チケットの中身(要件・画面・設計)を読んで、受け入れ条件や注意点を開発への申し送りとして残すだけです。差し戻しは無く、往復の回数にも数えません。`}
              </Notice>
            )}
            <div>
              <SectionHeading>工程の並び</SectionHeading>
              <List label="工程の並び">
                {rows.map((r, i) => {
                  const name = ROLE_LABEL[r.role];
                  return (
                    <ListItem
                      key={r.role}
                      disabled={!r.on}
                      title={
                        <span className="stagename">
                          <span className="no">{r.on ? i + 1 : "—"}</span>
                          <b>{name}</b>
                          {r.on && pre.includes(r.role) && <small>開発の前: 中身を読んで申し送る</small>}
                        </span>
                      }
                      meta={
                        <span className="stagectl">
                          {r.on && pre.includes(r.role) && <Chip tone="neutral">差し戻し無し</Chip>}
                          <span className="mv">
                            <Btn kind="outline" size="xs" aria-label={`${name}を前へ`} disabled={!r.on || i === 0} onClick={() => put(moveStage(flow, r.role, -1))}>
                              ▲
                            </Btn>
                            <Btn kind="outline" size="xs" aria-label={`${name}を後ろへ`} disabled={!r.on || i === includedCount - 1} onClick={() => put(moveStage(flow, r.role, 1))}>
                              ▼
                            </Btn>
                          </span>
                          {r.role === "dev" ? (
                            <span className="fixed">省けません</span>
                          ) : (
                            <Segmented
                              label={`${name}の必須・省略`}
                              value={r.on ? "on" : "off"}
                              onChange={(v) => put(setStage(flow, r.role, v === "on"))}
                              options={[
                                { value: "on", label: "必須" },
                                { value: "off", label: "省略" },
                              ]}
                            />
                          )}
                        </span>
                      }
                    />
                  );
                })}
                <ListItem disabled title={<span className="stagename"><span className="no">—</span><b>merge 待ち</b></span>} meta={<span className="fixed">いつも最後</span>} />
              </List>
            </div>
          </>
        )}
        <p className="hint">{`開発はどの位置にも置けますが、省けません。開発より前に置いたレビュー・セキュリティ・QA は申し送りだけを残し、開発より後に置いたものはいつもどおり差分を確かめます。開発が無い・merge 待ちの前に工程が 1 つも無いときは、理由が出て保存できません。保存すると、このあと工程を進む${key === "default" ? "(種類の流れを持たない)" : FLOW_LABEL(key)}のチケットから新しい流れで動きます。`}</p>
      </div>
    </div>
  );
}
