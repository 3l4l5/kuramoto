import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, post, type TeamView } from "./api";
import { useAct } from "./hooks";
import { MAX_MEMBERS_PER_UNIT, type FormationSpec, type UnitSpec } from "../../src/domain/formation";
import { EFFORTS, MODELS, ROLE_LABEL, WORK_ROLES, type WorkRole } from "../../src/domain/roles";
import { Btn } from "./ui";
import { LeadChat } from "./LeadChat";
import { FormationDrawer } from "./Formation";
import { Button, Checkbox, Input, Select, Textarea } from "./ds";
import { BudgetInput } from "./BudgetInput";
import { Drawer as DsDrawer } from "./ds";
import { DevRulesTab, draftDirty, useDevRules, type RuleDraft } from "./DevRules";

/**
 * チームの編成と方針(docs/design.md 6.3 の引き出し、ADR-0007・0010)。変えるたびに版を残す。
 */
export type Drawer = "formation" | "policy" | "lead";

export const DRAWER_LABEL: Record<Drawer, string> = { formation: "編成", policy: "チームの方針", lead: "リーダーと話す" };

export const useTeam = (id: number) => useQuery({ queryKey: ["team", id], queryFn: () => api<TeamView>("GET", `/projects/${id}/team`) });

/**
 * 開いている引き出しと、開発ルールの下書き。下書きは引き出しの外(App)で持ち、閉じる・別の引き出しへ移るときに
 * 保存していない変更があれば、捨ててよいか確かめてから移る(一覧の選び直し・「足す」と同じ)。
 */
export type RuleGuard = {
  draft: RuleDraft | null;
  setDraft: (d: RuleDraft | null) => void;
  /** 保存していない下書きがあるまま移ろうとして、確かめている最中 */
  confirming: boolean;
  /** 下書きを捨てて、行こうとしていた先へ移る */
  discard: () => void;
  /** 移るのをやめて、直し続ける */
  stay: () => void;
};

/**
 * `projectId` は今見ているプロジェクト(ホームなどプロジェクトの外では null)。
 * 企画スタジオ・生産性・設定・本部へ移っても、引き出しと下書きはそのまま残し、オフィスへ戻ると続きから直せる
 * (移る操作は戻る・進む・アドレスの書き換えでも起きるので、確かめるのではなく残す)。
 * 別のプロジェクトを開いたときだけ、前のプロジェクトの引き出し・下書きを空にする(本部を経由しても同じ)。
 */
export function useDrawerState(projectId: number | null): { drawer: Drawer | null; moveTo: (to: Drawer | null) => void; guard: RuleGuard } {
  const [drawer, setDrawer] = useState<Drawer | null>(null);
  const [draft, setDraft] = useState<RuleDraft | null>(null);
  const [pending, setPending] = useState<{ to: Drawer | null } | null>(null);
  const [owner, setOwner] = useState<number | null>(null);
  if (projectId !== null && projectId !== owner) {
    // 描画の途中で state を直す(React 公認の書き方)。前のプロジェクトの下書きを 1 フレームも見せない
    setOwner(projectId);
    if (owner !== null) {
      setDrawer(null);
      setDraft(null);
      setPending(null);
    }
  }
  const open = (to: Drawer | null) => {
    setPending(null);
    if (to !== "policy") setDraft(null);
    setDrawer(to);
  };
  const moveTo = (to: Drawer | null) => {
    if (drawer === "policy" && to !== "policy" && draft && draftDirty(draft)) setPending({ to });
    else open(to);
  };
  return { drawer, moveTo, guard: { draft, setDraft, confirming: pending !== null, discard: () => open(pending ? pending.to : drawer), stay: () => setPending(null) } };
}

export function TeamDrawer({ id, drawer, close, guard }: { id: number; drawer: Drawer; close: () => void; guard: RuleGuard }) {
  const { data } = useTeam(id);
  if (drawer === "formation") return data ? <FormationDrawer id={id} t={data} close={close} /> : null;
  if (drawer === "policy") return <PolicyDrawer id={id} team={data} close={close} guard={guard} />;
  return (
    <aside className="drawer" aria-label={DRAWER_LABEL[drawer]}>
      <header>
        <h2>{DRAWER_LABEL[drawer]}</h2>
        <Btn kind="text" size="sm" aria-label="閉じる" onClick={close}>
          閉じる
        </Btn>
      </header>
      <div className="pol">{drawer === "lead" ? <LeadChat id={id} /> : null}</div>
    </aside>
  );
}

type PolicyTab = "models" | "rules";

/** チームの方針: 役割ごとのモデル(R11)と開発ルール(R15)の 2 つのタブ。 */
function PolicyDrawer({ id, team, close, guard }: { id: number; team: TeamView | undefined; close: () => void; guard: RuleGuard }) {
  const { draft, setDraft } = guard;
  // 別の画面から戻ってきたときは、直していた開発ルールの続きから
  const [tab, setTab] = useState<PolicyTab>(draft && draftDirty(draft) ? "rules" : "models");
  const rules = useDevRules(id);
  return (
    <DsDrawer
      className="drawer drawer--wide"
      label={DRAWER_LABEL.policy}
      title={DRAWER_LABEL.policy}
      version={tab === "rules" && rules.data ? `v${rules.data.version}` : undefined}
      onClose={close}
      tabs={[
        { key: "models" as const, label: "役割ごとのモデル" },
        { key: "rules" as const, label: "開発ルール", count: draft && draftDirty(draft) ? 1 : 0 },
      ]}
      activeTab={tab}
      onTabChange={setTab}
    >
      {guard.confirming && (
        <div className="rules__confirm" role="alert">
          <span className="rules__hint">開発ルールに保存していない変更があります。捨てて閉じる・移ると、直した内容は戻りません。</span>
          <Button size="sm" onClick={guard.discard}>
            捨てて移る
          </Button>
          <Button
            size="sm"
            variant="text"
            onClick={() => {
              guard.stay();
              setTab("rules");
            }}
          >
            このまま直す
          </Button>
        </div>
      )}
      {tab === "rules" ? (
        <DevRulesTab id={id} draft={draft} setDraft={setDraft} />
      ) : (
        <div className="pol">{team ? <PolicyEditor id={id} t={team} /> : null}</div>
      )}
    </DsDrawer>
  );
}

// ---- 編成 ----

type Version = TeamView["formation"]["versions"][number];
export const toSpec = (v: Version): FormationSpec => ({
  pull: v.pull,
  units: v.units.map((u) => ({ ...u, roles: [...u.roles], repos: [...(u.repos ?? [])], model: u.model ?? null, effort: u.effort ?? null, focus: u.focus ?? null, budgetUsd: u.budgetUsd ?? null })),
});

/** 流れ・経路まで含めた版の中身(編成の引き出しの下書き)。 */
export const toFullSpec = (v: Version): FormationSpec => ({ ...toSpec(v), flows: structuredClone(v.flows ?? {}), routes: structuredClone(v.routes ?? []) });

/** 新しい島の既定値。名前は「島 n」で空いているもの。 */
export function newUnit(f: FormationSpec): UnitSpec {
  let n = f.units.length + 1;
  while (f.units.some((u) => u.name === `島 ${n}`)) n++;
  return { name: `島 ${n}`, roles: [], maxMembers: 3, summonAt: 2, idleSec: 300, repos: [], model: null, effort: null, focus: null, budgetUsd: null };
}

/** 島 1 つ分の入力(名前・役割・リポジトリ・モデル・重視すること・人数など)。編成の引き出しとオフィスの島の設定で使う。 */
export function UnitFields({ u, i, repos, set, remove }: { u: UnitSpec; i: number; repos: string[]; set: (patch: Partial<UnitSpec>) => void; remove?: () => void }) {
  // 同じ役割を複数の島に持たせてよい(ADR-0019)
  const toggleRole = (r: WorkRole) => set({ roles: u.roles.includes(r) ? u.roles.filter((x) => x !== r) : [...u.roles, r] });
  const toggleRepo = (repo: string) => {
    const cur = u.repos ?? [];
    set({ repos: cur.includes(repo) ? cur.filter((x) => x !== repo) : [...cur, repo] });
  };
  return (
    <>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <label className="sr" htmlFor={`unit-name-${i}`}>
              島 {i + 1} の名前
            </label>
            <Input id={`unit-name-${i}`} size="sm" type="text" className="w-full font-bold" value={u.name} onChange={(e) => set({ name: e.target.value })} />
            {remove && (
              <Btn kind="text" size="xs" aria-label={`島 ${i + 1} を外す`} onClick={remove}>
                外す
              </Btn>
            )}
          </div>
          <fieldset className="roles">
            <legend className="sr">島 {i + 1} の役割</legend>
            {WORK_ROLES.map((r) => (
              <Checkbox key={r} checked={u.roles.includes(r)} onChange={() => toggleRole(r)}>
                {ROLE_LABEL[r]}
              </Checkbox>
            ))}
          </fieldset>
          {repos.length > 1 && (
            <fieldset className="roles">
              <legend className="hint">受け持つリポジトリ(選ばなければすべて)</legend>
              {repos.map((r) => (
                <Checkbox key={r} checked={(u.repos ?? []).includes(r)} onChange={() => toggleRepo(r)}>
                  <span className="font-mono">{r}</span>
                </Checkbox>
              ))}
            </fieldset>
          )}
          <div className="unitmodel">
            <div>
              <label className="h" htmlFor={`unit-model-${i}`}>
                モデル
              </label>
              <Select id={`unit-model-${i}`} size="sm" className="w-full" value={u.model ?? ""} onChange={(e) => set({ model: e.target.value || null })}>
                <option value="">役割の方針どおり</option>
                {Object.entries(MODELS).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v.label}
                  </option>
                ))}
              </Select>
            </div>
            <div>
              <label className="h" htmlFor={`unit-effort-${i}`}>
                考える深さ
              </label>
              <Select id={`unit-effort-${i}`} size="sm" className="w-full" value={u.effort ?? ""} onChange={(e) => set({ effort: (e.target.value || null) as UnitSpec["effort"] })}>
                <option value="">役割の方針どおり</option>
                {EFFORTS.map((x) => (
                  <option key={x}>{x}</option>
                ))}
              </Select>
            </div>
          </div>
          <div>
            <label className="h" htmlFor={`unit-focus-${i}`} style={{ fontSize: "var(--fs-base)", marginBottom: 2 }}>
              この島で重視すること
            </label>
            <Textarea id={`unit-focus-${i}`} rows={2} className="w-full" value={u.focus ?? ""} onChange={(e) => set({ focus: e.target.value || null })} />
            <div className="hint">役割の方針の「重視すること」に足して、この島のメンバーが読みます。</div>
          </div>
          <div>
            <label className="h" htmlFor={`unit-budget-${i}`} style={{ fontSize: "var(--fs-base)", marginBottom: 2 }}>
              この島の予算(ドル)
            </label>
            <BudgetInput id={`unit-budget-${i}`} name={`${u.name || `島 ${i + 1}`}の予算`} size="sm" value={u.budgetUsd ?? null} onChange={(v) => set({ budgetUsd: v })} />
            <div className="hint">この島のメンバーが使ってよい金額の合計です。使い切ると、この島には仕事が回りません(同じ役割の島がほかにあればそちらへ回ります)。</div>
          </div>
          {/* メンバーは最大人数ぶんずっといる(応援を呼んだり帰したりしない。ADR-0023) */}
          <Knob label="人数" unit=" 人" min={1} max={MAX_MEMBERS_PER_UNIT} value={u.maxMembers} onChange={(v) => set({ maxMembers: v })} id={`max-${i}`} />
    </>
  );
}

function Knob({ id, label, unit, min, max, value, onChange }: { id: string; label: string; unit: string; min: number; max: number; value: number; onChange: (v: number) => void }) {
  return (
    <div className="knob">
      <label htmlFor={id}>{label}</label>
      <output htmlFor={id}>
        {value}
        {unit}
      </output>
      <input id={id} type="range" min={min} max={max} value={Math.min(value, Math.max(max, value))} onChange={(e) => onChange(Number(e.target.value))} />
    </div>
  );
}

export function History({ title, items }: { title: string; items: { key: number; label: string; detail: string; load?: () => void }[] }) {
  return (
    <details className="history">
      <summary>
        {title}({items.length})
      </summary>
      <ol>
        {items.map((x) => (
          <li key={x.key}>
            <b>{x.label}</b> <span>{x.detail}</span>
            {x.load && (
              <Btn kind="text" size="sm" onClick={x.load}>
                この版を下書きに読み込む
              </Btn>
            )}
          </li>
        ))}
      </ol>
    </details>
  );
}

// ---- チームの方針 ----

type PolicyVersion = TeamView["policies"][number]["versions"][number];
type Draft = { model: string; effort: string; focus: string; options: Record<string, unknown> };
const toDraft = (v: PolicyVersion): Draft => ({ model: v.model, effort: v.effort, focus: v.focus, options: { ...v.options } });

const OPTION_UI: Record<string, { key: string; label: string; kind: "bool" | "select" | "range"; choices?: [string, string][]; min?: number; max?: number }[]> = {
  dev: [
    { key: "requireTests", label: "変更にはテストを付ける", kind: "bool" },
    { key: "smallPr", label: "PR を小さく保つ", kind: "bool" },
  ],
  review: [
    { key: "strictness", label: "指摘の厳しさ", kind: "select", choices: [["important", "重要なものだけ"], ["standard", "標準"], ["detailed", "細かく"]] },
    { key: "escalateAfterRounds", label: "責任者に上げるまでの往復", kind: "range", min: 1, max: 5 },
  ],
  lead: [{ key: "askOwner", label: "責任者に聞く範囲", kind: "select", choices: [["heavy", "重いものだけ"], ["medium", "中以上"], ["all", "なんでも聞く"]] }],
};

function PolicyEditor({ id, t }: { id: number; t: TeamView }) {
  const act = useAct();
  const [role, setRole] = useState(t.policies[0]!.role);
  const pol = t.policies.find((x) => x.role === role)!;
  const current = pol.versions.at(-1)!;
  const [draft, setDraft] = useState<Draft>(() => toDraft(current));
  useEffect(() => {
    setDraft(toDraft(current));
  }, [role, current.version]); // eslint-disable-line react-hooks/exhaustive-deps
  const changed = JSON.stringify(draft) !== JSON.stringify(toDraft(current));
  const m = MODELS[draft.model as keyof typeof MODELS];
  const save = () => act(() => post<{ version: number }>(`/projects/${id}/policies/${role}`, draft), (r) => `${pol.label}の方針を v${r.version} として保存しました。次に仕事を始めたメンバーから使います`);

  return (
    <>
      <div className="roletabs" role="tablist" aria-label="役割">
        {t.policies.map((x) => (
          <Btn kind={x.role === role ? "solid-fill" : "outline"} size="xs" role="tab" key={x.role} aria-selected={x.role === role} onClick={() => setRole(x.role)}>
            {x.label}
          </Btn>
        ))}
      </div>
      <p className="hint">
        {pol.label} · 今の方針 v{current.version}。保存すると版が上がり、次に仕事を始めたメンバーから使います(作業中のメンバーはそのまま)。モデルと考える深さは、編成で島ごとに上書きできます。
      </p>
      <div>
        <label className="h" htmlFor="pol-model">
          モデル
        </label>
        <Select id="pol-model" size="sm" className="w-full" value={draft.model} onChange={(e) => setDraft({ ...draft, model: e.target.value })}>
          {Object.entries(MODELS).map(([k, v]) => (
            <option key={k} value={k}>
              {v.label}
            </option>
          ))}
        </Select>
        {m && (
          <div className="hint">
            100 万トークンあたり 入力 ${m.input} / 出力 ${m.output}
          </div>
        )}
      </div>
      <div>
        <label className="h" htmlFor="pol-effort">
          考える深さ(effort)
        </label>
        <Select id="pol-effort" size="sm" className="w-full" value={draft.effort} onChange={(e) => setDraft({ ...draft, effort: e.target.value })}>
          {EFFORTS.map((e) => (
            <option key={e}>{e}</option>
          ))}
        </Select>
      </div>
      {(OPTION_UI[role] ?? []).map((o) =>
        o.kind === "bool" ? (
          <Checkbox key={o.key}checked={!!draft.options[o.key]} onChange={(e) => setDraft({ ...draft, options: { ...draft.options, [o.key]: e.target.checked } })}>
            {o.label}
          </Checkbox>
        ) : o.kind === "select" ? (
          <div key={o.key}>
            <label className="h" htmlFor={`opt-${o.key}`}>
              {o.label}
            </label>
            <Select id={`opt-${o.key}`} size="sm" className="w-full" value={String(draft.options[o.key] ?? "")} onChange={(e) => setDraft({ ...draft, options: { ...draft.options, [o.key]: e.target.value } })}>
              {o.choices!.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </Select>
          </div>
        ) : (
          <Knob
            key={o.key}
            id={`opt-${o.key}`}
            label={o.label}
            unit=" 回"
            min={o.min!}
            max={o.max!}
            value={Number(draft.options[o.key] ?? o.min)}
            onChange={(v) => setDraft({ ...draft, options: { ...draft.options, [o.key]: v } })}
          />
        ),
      )}
      <div>
        <label className="h" htmlFor="pol-focus">
          重視すること
        </label>
        <Textarea id="pol-focus" rows={4} className="w-full" value={draft.focus} onChange={(e) => setDraft({ ...draft, focus: e.target.value })} />
        <div className="hint">例: 型を厳しく。既存の書き方に合わせる。この役割のメンバーが仕事を始めるたびに読みます。ツールの使い方や報告の形などの基本の指示は Kuramoto が持っています。</div>
      </div>
      <div className="save">
        <Btn kind="solid-fill" size="sm" disabled={!changed} onClick={save}>
          v{current.version + 1} として保存
        </Btn>
        {changed && (
          <Btn kind="text" size="sm" onClick={() => setDraft(toDraft(current))}>
            変更を捨てる
          </Btn>
        )}
      </div>
      <History
        title={`${pol.label}の方針の版`}
        items={[...pol.versions].reverse().map((v) => ({
          key: v.version,
          label: `v${v.version}${v.version === current.version ? "(今)" : ""}`,
          detail: `${MODELS[v.model as keyof typeof MODELS]?.label ?? v.model} / ${v.effort}${v.focus ? ` · ${v.focus.slice(0, 40)}` : ""}`,
          load: v.version === current.version ? undefined : () => setDraft(toDraft(v)),
        }))}
      />
    </>
  );
}
