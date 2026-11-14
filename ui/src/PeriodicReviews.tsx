import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, post, type PeriodicReviewsView } from "./api";
import { useAct } from "./hooks";
import { Button, Checkbox, Chip, Select, SectionHeading, Switch, TextField, Textarea } from "./ds";

/**
 * 設定の「定期レビュー」(#89)。観点(レビューで見ること)・頻度・担当・対象を持つ定義を、一覧で作る・直す・無効にする・消す・今すぐ実行する。
 * 起動すると、担当が観点に沿って見て、見つけたものをチケットに切る。実行の記録(いつ・何を見て・何件切ったか)は、定義の下に出す。
 */
type Review = PeriodicReviewsView["reviews"][number];
type Run = PeriodicReviewsView["runs"][number];
type Values = { name: string; viewpoint: string; everyHours: number; role: Review["role"]; targetKind: Review["targetKind"]; targetScreens: string[] };
type Draft = Values & { id?: number };

// サーバーのモジュール(DB を使う)は画面に持ち込まないので、役割・対象の名前はここに写す
const ROLE_OPTIONS: { value: Review["role"]; label: string }[] = [
  { value: "designer", label: "デザイナー" },
  { value: "qa", label: "QA" },
  { value: "review", label: "レビュー" },
  { value: "sec", label: "セキュリティ" },
  { value: "lead", label: "リーダー" },
];
const ROLE_LABEL = Object.fromEntries(ROLE_OPTIONS.map((o) => [o.value, o.label])) as Record<Review["role"], string>;
const TARGET_OPTIONS: { value: Review["targetKind"]; label: string }[] = [
  { value: "all_screens", label: "全画面" },
  { value: "screens", label: "選んだ画面" },
  { value: "repo", label: "リポジトリ全体" },
];
const TARGET_LABEL = Object.fromEntries(TARGET_OPTIONS.map((o) => [o.value, o.label])) as Record<Review["targetKind"], string>;
const EMPTY: Draft = { name: "", viewpoint: "", everyHours: 24, role: "qa", targetKind: "repo", targetScreens: [] };

/** 頻度の言い方: 24 = 毎日、168 = 毎週、それ以外は N 時間ごと。 */
export const everyLabel = (h: number) => (h === 24 ? "毎日" : h === 168 ? "毎週" : `${h} 時間ごと`);
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "—");
const STATUS: Record<Run["status"], { label: string; tone: "default" | "ok" | "danger" | "warn" }> = {
  queued: { label: "待ち", tone: "default" },
  running: { label: "実行中", tone: "warn" },
  done: { label: "完了", tone: "ok" },
  error: { label: "失敗", tone: "danger" },
};

const draftOf = (r: Review): Draft => ({ id: r.id, name: r.name, viewpoint: r.viewpoint, everyHours: r.everyHours, role: r.role, targetKind: r.targetKind, targetScreens: r.targetScreens });
const draftOk = (d: Draft) => !!d.name.trim() && !!d.viewpoint.trim() && Number.isInteger(d.everyHours) && d.everyHours >= 1 && (d.targetKind !== "screens" || d.targetScreens.length > 0);

export function PeriodicReviews({ id }: { id: number }) {
  const key = ["periodic-reviews", id];
  const { data } = useQuery({ queryKey: key, queryFn: () => api<PeriodicReviewsView>("GET", `/projects/${id}/periodic-reviews`) });
  const qc = useQueryClient();
  const act = useAct();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [freq, setFreq] = useState<"24" | "168" | "custom">("24");
  const [confirming, setConfirming] = useState<number | null>(null);
  if (!data) return <section aria-label="定期レビュー" />;

  const write = (path: string, body: unknown, message: string, then?: () => void) =>
    act(async () => {
      const r = await post<PeriodicReviewsView>(`/projects/${id}/periodic-reviews${path}`, body);
      qc.setQueryData(key, r);
      then?.();
      return r;
    }, message);
  const open = (d: Draft) => {
    setFreq(d.everyHours === 24 ? "24" : d.everyHours === 168 ? "168" : "custom");
    setConfirming(null);
    setDraft(d);
  };
  const save = () => draft && write(draft.id === undefined ? "" : `/${draft.id}`, draft, `「${draft.name.trim()}」を保存しました`, () => setDraft(null));
  const runsOf = (r: Review) => data.runs.filter((x) => x.reviewId === r.id).slice(0, 3);

  return (
    <fieldset className="periodic" aria-label="定期レビュー">
      <legend className="h">定期レビュー</legend>
      <div className="hint" style={{ marginBottom: 8 }}>
        決まった頻度で、担当が観点に沿ってレビューし、見つけたものをチケットに切ります(開いているチケットと同じものは切りません)。始業中に動きます。「今すぐ実行」しても、次の定期の起動はそこから 1 頻度ぶん後になります。
      </div>
      <SectionHeading>
        観点(有効 {data.reviews.filter((r) => r.enabled).length} / {data.reviews.length})
      </SectionHeading>
      {data.reviews.map((r) => (
        <div key={r.id} className="periodic__item" style={{ display: "grid", gap: 6, padding: "var(--space-2, 8px) 0" }}>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <b>{r.name}</b>
            <Chip tone="design">{ROLE_LABEL[r.role]}</Chip>
            <Chip>{everyLabel(r.everyHours)}</Chip>
            <Chip tone="neutral">{TARGET_LABEL[r.targetKind]}</Chip>
            <Switch checked={r.enabled} label={`${r.name}を有効にする`} onChange={(v) => void write(`/${r.id}/enabled`, { enabled: v }, `「${r.name}」を${v ? "有効" : "無効"}にしました`)}>
              {""}
            </Switch>
          </div>
          <div className="hint">
            前回 {when(r.lastRunAt)} / 次回 {r.enabled ? when(r.nextRunAt) : "(無効)"}
          </div>
          {runsOf(r).map((x) => (
            <div key={x.id} className="hint" style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <Chip tone={STATUS[x.status].tone}>{STATUS[x.status].label}</Chip>
              <span>{when(x.createdAt)}({x.origin === "manual" ? "手動" : "定期"})</span>
              <span>見たもの: {x.lookedAt}</span>
              <span>
                切ったチケット {x.createdTickets.length} 件{x.createdTickets.length > 0 && `(${x.createdTickets.map((n) => `#${n}`).join(" ")})`}・重複で見送り {x.skippedDuplicates} 件
              </span>
              {x.error && <span className="bad">{x.error}</span>}
            </div>
          ))}
          <div style={{ display: "flex", gap: 8 }}>
            <Button size="sm" onClick={() => void write(`/${r.id}/run`, {}, `「${r.name}」を実行に回しました`)}>
              今すぐ実行
            </Button>
            <Button size="sm" onClick={() => open(draftOf(r))}>
              編集
            </Button>
            {confirming === r.id ? (
              <>
                <Button size="sm" onClick={() => void write(`/${r.id}/delete`, {}, `「${r.name}」を消しました`, () => setConfirming(null))}>
                  本当に消す
                </Button>
                <Button size="sm" variant="text" onClick={() => setConfirming(null)}>
                  やめる
                </Button>
              </>
            ) : (
              <Button size="sm" variant="text" onClick={() => setConfirming(r.id)}>
                削除
              </Button>
            )}
          </div>
        </div>
      ))}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", margin: "var(--space-2, 8px) 0" }}>
        <Button onClick={() => open(EMPTY)}>+ 観点を作る</Button>
        {data.templates.map((t) => (
          <Button key={t.key} size="sm" disabled={t.added} onClick={() => void write("", { template: t.key }, `「${t.name}」を足しました`)}>
            {t.added ? "✓ " : "+ "}
            {t.name}
          </Button>
        ))}
      </div>
      {draft && (
        <div role="group" aria-label={draft.id === undefined ? "観点を作る" : "観点を直す"} style={{ display: "grid", gap: 10 }}>
          <TextField label="名前" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          <div>
            <label className="h" htmlFor="pr-viewpoint">
              観点(レビューで見ること)
            </label>
            <Textarea id="pr-viewpoint" rows={6} className="w-full" value={draft.viewpoint} onChange={(e) => setDraft({ ...draft, viewpoint: e.target.value })} />
          </div>
          <div>
            <label className="h" htmlFor="pr-freq">
              頻度
            </label>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <Select
                id="pr-freq"
                value={freq}
                onChange={(e) => {
                  const v = e.target.value as typeof freq;
                  setFreq(v);
                  if (v !== "custom") setDraft({ ...draft, everyHours: Number(v) });
                }}
              >
                <option value="24">毎日</option>
                <option value="168">毎週</option>
                <option value="custom">N 時間ごと</option>
              </Select>
              {freq === "custom" && (
                <TextField label="時間" type="number" min={1} step={1} value={String(draft.everyHours)} onChange={(e) => setDraft({ ...draft, everyHours: Number(e.target.value) })} />
              )}
            </div>
          </div>
          <div>
            <label className="h" htmlFor="pr-role">
              担当
            </label>
            <Select id="pr-role" value={draft.role} onChange={(e) => setDraft({ ...draft, role: e.target.value as Review["role"] })}>
              {ROLE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <label className="h" htmlFor="pr-target">
              対象
            </label>
            <Select id="pr-target" value={draft.targetKind} onChange={(e) => setDraft({ ...draft, targetKind: e.target.value as Review["targetKind"] })}>
              {TARGET_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
            {draft.targetKind === "screens" && (
              <div style={{ display: "grid", gap: 4, marginTop: 6 }}>
                {data.screens.length === 0 && <div className="hint">企画に画面がありません</div>}
                {data.screens.map((s) => (
                  <Checkbox
                    key={s.key}
                    checked={draft.targetScreens.includes(s.key)}
                    onChange={(e) => setDraft({ ...draft, targetScreens: e.target.checked ? [...draft.targetScreens, s.key] : draft.targetScreens.filter((k) => k !== s.key) })}
                  >
                    {s.name}
                  </Checkbox>
                ))}
              </div>
            )}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <Button variant="primary" disabled={!draftOk(draft)} onClick={() => void save()}>
              保存する
            </Button>
            <Button variant="text" onClick={() => setDraft(null)}>
              やめる
            </Button>
          </div>
        </div>
      )}
    </fieldset>
  );
}
