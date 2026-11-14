import { go } from "./hooks";
import { setPhoneNav, usePhoneNav, type OfficeView } from "./phoneNav";
import { SegmentNav, SegmentNavButton } from "./ds";

export const OFFICE_VIEWS: Record<OfficeView, string> = { floor: "オフィス", board: "ボード", tree: "ツリー" };

/**
 * オフィス / ボード / ツリーの切り替え(スマホの幅でオフィスの枠の上に出す形。パソコンの幅は共通ヘッダーの ProjectNav)。
 */
export function OfficeViewSwitch({ className }: { className: string }) {
  const { view } = usePhoneNav();
  return (
    <SegmentNav label="オフィスの見方" className={className}>
      {(Object.keys(OFFICE_VIEWS) as OfficeView[]).map((v) => (
        <SegmentNavButton key={v} on={view === v} onClick={() => setPhoneNav({ view: v })}>
          {OFFICE_VIEWS[v]}
        </SegmentNavButton>
      ))}
    </SegmentNav>
  );
}

/**
 * 共通ヘッダーの行き先の切り替えスイッチ(試作どおり。灰色の地の上に置く、外枠が白・選んでいるのが灰の形)。
 * オフィス / ボード / ツリーの見方と、企画スタジオ / 生産性 / 設定を、どの画面でも同じ形・同じ位置に出す。
 * 見方はオフィス(とチケット)にいるときだけ選ばれ、ほかの画面ではいまの画面の行き先が選ばれる。
 * 見方の 3 つは読み上げでは「オフィスの見方」の組、全体は「プロジェクトの画面」の組になる。
 */
export function ProjectNav({ id, route }: { id: number; route: string }) {
  const { view } = usePhoneNav();
  const inOffice = route === "project" || route === "ticket";
  const screens: [string, string, string][] = [
    ["studio", "企画スタジオ", `#/p/${id}/studio`],
    ["metrics", "生産性", `#/p/${id}/metrics`],
    ["settings", "設定", `#/p/${id}/settings`],
  ];
  return (
    <SegmentNav label="プロジェクトの画面" raised className="navsw">
      <div role="group" aria-label="オフィスの見方" className="ds-seg__group">
        {(Object.keys(OFFICE_VIEWS) as OfficeView[]).map((v) => (
          <SegmentNavButton
            key={v}
            on={inOffice && view === v}
            onClick={() => {
              setPhoneNav({ view: v });
              go(`#/p/${id}`);
            }}
          >
            {OFFICE_VIEWS[v]}
          </SegmentNavButton>
        ))}
      </div>
      {screens.map(([key, label, hash]) => (
        <SegmentNavButton key={key} on={route === key} mark="current" onClick={() => go(hash)}>
          {label}
        </SegmentNavButton>
      ))}
    </SegmentNav>
  );
}
