import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, post, type DevRulesView } from "./api";
import { useAct } from "./hooks";
import { Button, Chip, List, ListItem, SectionHeading, Segmented, Switch } from "./ds";
import { Input } from "./dads/Input";
import { Textarea } from "./dads/Textarea";

/**
 * チームの方針の「開発ルール」(R15・ADR-0011)。左に一覧(有効 / 無効のスイッチ)とひな形、右にルールの中身か追加のフォーム。
 * 足したルールの中身は変えられない(API は足す・有効 / 無効だけ)ので、直したいときは無効にして足し直す。
 */
export const useDevRules = (id: number) => useQuery({ queryKey: ["dev-rules", id], queryFn: () => api<DevRulesView>("GET", `/projects/${id}/dev-rules`) });

type Rule = DevRulesView["rules"][number];
type RuleTarget = Rule["appliesTo"][number];
type RuleCheck = Rule["check"];
type RuleOnFail = Rule["onFail"];
// サーバーのモジュール(DB を使う)は画面に持ち込まないので、効く場所の並びと名前はここに写す
const TARGETS: RuleTarget[] = ["branch", "commit", "pr_title", "pr_body", "files", "code"];
const TARGET_LABEL: Record<RuleTarget, string> = { branch: "ブランチ名", commit: "コミット", pr_title: "PR タイトル", pr_body: "PR 本文", files: "変更したファイル", code: "コード" };
export type RuleDraft = { name: string; body: string; appliesTo: RuleTarget[]; check: RuleCheck; pattern: string; onFail: RuleOnFail };
const EMPTY: RuleDraft = { name: "", body: "", appliesTo: [], check: "pattern", pattern: "", onFail: "autofix" };

const CHECK_OPTIONS = [
  { value: "pattern" as const, label: "形式(正規表現)" },
  { value: "ai" as const, label: "AI が読む" },
];
const ON_FAIL_OPTIONS = [
  { value: "autofix" as const, label: "持ち主が自動で直す" },
  { value: "review" as const, label: "レビューで指摘" },
  { value: "block" as const, label: "直すまで進めない" },
];
const ON_FAIL_HINT = "PR を出す前に確かめ、持ち主が直してから PR が出ます。違反はチケットのやりとりに残ります。";

const targets = (r: { appliesTo: RuleTarget[] }) => r.appliesTo.map((t) => TARGET_LABEL[t]).join("・");

/** 下書きが空のままか(保存していない変更の数に使う) */
export const draftDirty = (d: RuleDraft) => JSON.stringify(d) !== JSON.stringify(EMPTY);

export function DevRulesTab({ id, draft, setDraft }: { id: number; draft: RuleDraft | null; setDraft: (d: RuleDraft | null) => void }) {
  const { data } = useDevRules(id);
  const act = useAct();
  const [selected, setSelected] = useState<number | null>(null);
  if (!data) return null;

  const active = data.rules.filter((r) => r.enabled).length;
  const current = draft ? null : (data.rules.find((r) => r.id === selected) ?? data.rules[0] ?? null);
  const write = (path: string, body: unknown, message: (r: DevRulesView) => string, then?: (r: DevRulesView) => void) =>
    act(
      async () => {
        const r = await post<DevRulesView>(`/projects/${id}${path}`, body);
        then?.(r);
        return r;
      },
      message,
    );

  const addTemplate = (key: string, name: string) =>
    write("/dev-rules", { template: key }, () => `「${name}」を足しました。次に起動するメンバーから使われます`, (r) => {
      setDraft(null);
      setSelected(r.rules.find((x) => x.template === key)?.id ?? null);
    });
  const toggle = (r: Rule, enabled: boolean) => write(`/dev-rules/${r.id}/enabled`, { enabled }, () => `「${r.name}」を${enabled ? "有効" : "無効"}にしました`);

  const valid = draft && draft.name.trim() && draft.appliesTo.length > 0 && (draft.check === "ai" ? draft.body.trim() : draft.pattern.trim());
  const save = () =>
    draft &&
    write(
      "/dev-rules",
      { name: draft.name, body: draft.body, appliesTo: draft.appliesTo, check: draft.check, onFail: draft.onFail, ...(draft.check === "pattern" ? { pattern: draft.pattern } : {}) },
      () => `「${draft.name.trim()}」を足しました。次に起動するメンバーから使われます`,
      (r) => {
        setDraft(null);
        setSelected(r.rules.at(-1)?.id ?? null);
      },
    );

  return (
    <div className="rules" role="tabpanel" aria-label="開発ルール">
      <div className="rules__side">
        <div>
          <SectionHeading>
            ルール(有効 {active} / {data.rules.length})
          </SectionHeading>
          {data.rules.length > 0 && (
            <List label="ルール">
              {data.rules.map((r) => (
                <ListItem
                  key={r.id}
                  selected={r.id === current?.id}
                  disabled={!r.enabled}
                  onClick={() => {
                    setDraft(null);
                    setSelected(r.id);
                  }}
                  title={
                    <span className="rules__title">
                      <b>{r.name}</b>
                      <span className="rules__sub">{targets(r)}</span>
                    </span>
                  }
                  meta={
                    <span className="rules__meta" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
                      {r.violations - r.autofixed > 0 && <Chip tone="warn">違反 {r.violations - r.autofixed}</Chip>}
                      {r.autofixed > 0 && <Chip tone="ok">自動で直した {r.autofixed}</Chip>}
                      <Switch checked={r.enabled} label={`${r.name}を有効にする`} onChange={(v) => void toggle(r, v)}>
                        {""}
                      </Switch>
                    </span>
                  }
                />
              ))}
            </List>
          )}
          <Button className="rules__add" onClick={() => setDraft(draft ?? EMPTY)}>
            + 空のルールを足す
          </Button>
        </div>
        <div>
          <SectionHeading>ひな形から足す</SectionHeading>
          <div className="rules__tpl">
            {data.templates.map((t) => (
              <Button key={t.key} size="sm" disabled={t.added} onClick={() => void addTemplate(t.key, t.name)}>
                {t.added ? "✓ " : "+ "}
                {t.name}
              </Button>
            ))}
          </div>
        </div>
      </div>
      <div className="rules__form">
        {draft ? <RuleForm draft={draft} set={setDraft} /> : current ? <RuleView r={current} /> : <p className="rules__hint">まだルールがありません。ひな形から足すか、空のルールを足します。</p>}
      </div>
      {draft && (
        <div className="rules__foot">
          <span className="rules__note">保存してない変更: 開発ルール 1 · 次に起動するメンバーから使われます</span>
          <Button variant="text" onClick={() => setDraft(null)}>
            やめる
          </Button>
          <Button variant="primary" disabled={!valid} onClick={() => void save()}>
            このルールを足す
          </Button>
        </div>
      )}
    </div>
  );
}

function Field({ label, hint, htmlFor, children }: { label: string; hint?: string; htmlFor?: string; children: React.ReactNode }) {
  return (
    <div className="rules__field">
      {htmlFor ? <label htmlFor={htmlFor}>{label}</label> : <b id={`f-${label}`}>{label}</b>}
      {children}
      {hint && <span className="rules__hint">{hint}</span>}
    </div>
  );
}

function Targets({ value, onToggle }: { value: RuleTarget[]; onToggle?: (t: RuleTarget) => void }) {
  return (
    <div className="rules__checks" role="group" aria-label="どこに効くか">
      {TARGETS.map((t) => {
        const on = value.includes(t);
        return (
          <button key={t} type="button" className="rules__check" aria-pressed={on} disabled={!onToggle} onClick={() => onToggle?.(t)}>
            {on ? "✓ " : ""}
            {TARGET_LABEL[t]}
          </button>
        );
      })}
    </div>
  );
}

function RuleForm({ draft, set }: { draft: RuleDraft; set: (d: RuleDraft) => void }) {
  const patch = (p: Partial<RuleDraft>) => set({ ...draft, ...p });
  return (
    <>
      <Field label="名前" htmlFor="rule-name" hint="一覧に出る名前">
        <Input id="rule-name" blockSize="sm" value={draft.name} onChange={(e) => patch({ name: e.target.value })} />
      </Field>
      <Field label="何を守るか" htmlFor="rule-body">
        <Textarea id="rule-body" rows={3} value={draft.body} onChange={(e) => patch({ body: e.target.value })} />
      </Field>
      <Field label="どこに効くか">
        <Targets value={draft.appliesTo} onToggle={(t) => patch({ appliesTo: draft.appliesTo.includes(t) ? draft.appliesTo.filter((x) => x !== t) : [...draft.appliesTo, t] })} />
      </Field>
      <Field label="確かめ方" hint="形式は速くてトークンを使いません。意味を読む必要があるものは「AI が読む」。">
        <Segmented label="確かめ方" options={CHECK_OPTIONS} value={draft.check} onChange={(check) => patch({ check })} />
        {draft.check === "pattern" && (
          <Input id="rule-pattern" aria-label="正規表現" className="rules__mono" blockSize="sm" value={draft.pattern} onChange={(e) => patch({ pattern: e.target.value })} />
        )}
      </Field>
      <Field label="違反したとき" hint={ON_FAIL_HINT}>
        <Segmented label="違反したとき" options={ON_FAIL_OPTIONS} value={draft.onFail} onChange={(onFail) => patch({ onFail })} />
      </Field>
    </>
  );
}

/** 足したルールの中身(読むだけ) */
function RuleView({ r }: { r: Rule }) {
  return (
    <>
      <Field label="名前">
        <p className="rules__text">{r.name}</p>
      </Field>
      <Field label="何を守るか">
        <p className="rules__text">{r.body || "—"}</p>
      </Field>
      <Field label="どこに効くか">
        <Targets value={r.appliesTo} />
      </Field>
      <Field label="確かめ方">
        <Segmented label="確かめ方" options={CHECK_OPTIONS.map((o) => ({ ...o, disabled: o.value !== r.check }))} value={r.check} onChange={() => {}} />
        {r.check === "pattern" && <code className="rules__ex">{r.pattern}</code>}
      </Field>
      <Field label="違反したとき" hint={ON_FAIL_HINT}>
        <Segmented label="違反したとき" options={ON_FAIL_OPTIONS.map((o) => ({ ...o, disabled: o.value !== r.onFail }))} value={r.onFail} onChange={() => {}} />
      </Field>
    </>
  );
}
