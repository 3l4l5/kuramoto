import { Chip } from "./ds";

/**
 * チケットの種類(R17)の見せ方。種類は形(●▲■◆)と名前で出す(色だけに頼らない)。
 * オフィス・ボード・ツリー・チケットの詳細・生産性で同じ形を使う。
 */
export const KIND_SHAPE: Record<string, string> = { feature: "●", bugfix: "▲", refactor: "■", docs: "◆" };
export const KINDS = [
  { key: "feature", label: "機能" },
  { key: "bugfix", label: "バグ修正" },
  { key: "refactor", label: "リファクタ" },
  { key: "docs", label: "ドキュメント" },
] as const;

export function KindChip({ kind, label }: { kind: string; label: string }) {
  return (
    <Chip tone="neutral" className="kindchip" title={`種類: ${label}`}>
      <span className="shp" aria-hidden="true">
        {KIND_SHAPE[kind] ?? "●"}
      </span>
      {label}
    </Chip>
  );
}

/** 開発より前の確認(申し送りだけを残す工程)の札。 */
export const PRE_DEV_LABEL = "申し送り";
