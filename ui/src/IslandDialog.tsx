import { useEffect, useRef, useState } from "react";
import { post } from "./api";
import { useAct } from "./hooks";
import { Btn } from "./ui";
import { newUnit, toSpec, UnitFields, useTeam } from "./Team";
import { pipelineOf, validateFormation, type FormationSpec, type UnitSpec } from "../../src/domain/formation";
import { ROLE_LABEL } from "../../src/domain/roles";

/**
 * オフィスの床から島を足す・変える・外す。保存すると編成の版が上がる(編成の引き出しと同じ)。
 * name が null なら新しい島を足す。
 */
export function IslandDialog({ id, name, close }: { id: number; name: string | null; close: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const { data: t } = useTeam(id);
  const act = useAct();
  const [unit, setUnit] = useState<UnitSpec | null>(null);
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
  }, []);
  const current = t ? toSpec(t.formation.versions.find((v) => v.version === t.formation.current)!) : null;
  const index = current ? (name === null ? current.units.length : current.units.findIndex((u) => u.name === name)) : -1;
  useEffect(() => {
    if (current && !unit) setUnit(name === null ? newUnit(current) : (current.units[index] ?? null));
  }, [current, unit, name, index]);

  const next = (u: UnitSpec | null): FormationSpec | null => {
    if (!current) return null;
    const units = [...current.units];
    if (u === null) units.splice(index, 1);
    else units[index] = u;
    return { ...current, units };
  };
  const draft = unit ? next(unit) : null;
  const errors = draft && t ? validateFormation(draft, t.repos) : [];
  const save = async (f: FormationSpec | null, done: string) => {
    if (!f) return;
    const r = await act(() => post<{ version: number }>(`/projects/${id}/formation`, f), (x) => `編成 v${x.version} を適用しました。${done}`);
    if (r) ref.current?.close();
  };
  const removeErrors = current && t && name !== null ? validateFormation(next(null)!, t.repos) : [];

  return (
    <dialog ref={ref} className="ticketdialog islanddialog" aria-label={name === null ? "島を足す" : `${name} の設定`} onClose={close} onCancel={close}>
      <header>
        <h2>{name === null ? "島を足す" : `${name} の設定`}</h2>
        <Btn kind="text" size="sm" style={{ marginLeft: "auto" }} onClick={() => ref.current?.close()}>
          閉じる
        </Btn>
      </header>
      {!t || !unit ? (
        <p className="hint" style={{ padding: 18 }}>
          読み込んでいます…
        </p>
      ) : (
        <div className="pol" style={{ padding: "14px 18px" }}>
          <div className="knobs unit">
            <UnitFields u={unit} i={index} repos={t.repos} set={(patch) => setUnit({ ...unit, ...patch })} />
          </div>
          {draft && (
            <div className="preview">
              工程: {pipelineOf(draft).map((r) => ROLE_LABEL[r]).join(" → ")}
              {pipelineOf(draft).length ? " → merge 待ち" : ""}
            </div>
          )}
          {errors.length > 0 && (
            <ul className="errors" aria-label="編成の問題">
              {errors.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          )}
          <p className="hint">保存すると編成の版が上がり、席替えが起きます。前の版には編成の引き出しから戻せます。</p>
          <div className="save">
            <Btn kind="solid-fill" size="sm" disabled={errors.length > 0} onClick={() => save(draft, name === null ? `${unit.name} を足しました` : "")}>
              {name === null ? "この島を足す" : "保存する"}
            </Btn>
            {name !== null && (
              <Btn
                kind="outline"
                size="sm"
                disabled={removeErrors.length > 0}
                title={removeErrors.length ? removeErrors.join(" / ") : undefined}
                onClick={() => save(next(null), `${name} を外しました`)}
              >
                この島を外す
              </Btn>
            )}
          </div>
          {name !== null && removeErrors.length > 0 && <p className="hint">外せません: {removeErrors.join(" / ")}</p>}
        </div>
      )}
    </dialog>
  );
}
