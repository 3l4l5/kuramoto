import { useEffect, useState } from "react";
import { Checkbox } from "./dads/Checkbox";
import { Input } from "./dads/Input";

/** 0 より大きい金額か。 */
export const budgetOk = (v: number | null) => v === null || (Number.isFinite(v) && v > 0);

/**
 * 予算(ドル)の入力。「無制限」に印を付けると null を返す。
 * 金額の欄が空・0 以下のあいだは NaN を返す(呼ぶ側で budgetOk で確かめる)。
 */
export function BudgetInput({ id, name, value, onChange, size = "md" }: { id: string; name: string; value: number | null; onChange: (v: number | null) => void; size?: "sm" | "md" }) {
  const [text, setText] = useState(value === null ? "" : String(value));
  useEffect(() => {
    // 外から値が変わったとき(読み込み・変更を捨てる)だけ欄を合わせる
    if (value === null || Number(text) !== value) setText(value === null ? "" : String(value));
  }, [value]); // eslint-disable-line react-hooks/exhaustive-deps
  const unlimited = value === null;
  return (
    <div className="budgetinput">
      <Input
        type="number"
        id={id}
        min="0.01"
        step="0.01"
        blockSize={size}
        disabled={unlimited}
        isError={!unlimited && !budgetOk(value)}
        value={unlimited ? "" : text}
        onChange={(e) => {
          setText(e.target.value);
          onChange(e.target.value.trim() === "" ? NaN : Number(e.target.value));
        }}
      />
      <Checkbox size="sm" aria-label={`${name}を無制限にする`} checked={unlimited} onChange={() => onChange(unlimited ? (Number(text) > 0 ? Number(text) : NaN) : null)}>
        無制限
      </Checkbox>
    </div>
  );
}
