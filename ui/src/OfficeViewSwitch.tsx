import { go } from "./hooks";
import { setPhoneNav, usePhoneNav, type OfficeView } from "./phoneNav";
import { Btn } from "./ui";

export const OFFICE_VIEWS: Record<OfficeView, string> = { floor: "オフィス", board: "ボード", tree: "ツリー" };

/**
 * オフィス / ボード / ツリーの切り替え。パソコンの幅では共通ヘッダー(試作どおり)に、スマホの幅ではオフィスの枠の上に出す
 * (どちらか一方を CSS で隠す)。チケットの画面から押したときは、選んだ見方でオフィスへ戻る。
 * `home` を渡すと、押したあとにそのハッシュへ移る(チケットの画面用)。
 */
export function OfficeViewSwitch({ className, home }: { className: string; home?: string }) {
  const { view } = usePhoneNav();
  return (
    <div role="group" aria-label="オフィスの見方" className={className}>
      {(Object.keys(OFFICE_VIEWS) as OfficeView[]).map((v) => (
        <Btn
          key={v}
          kind={view === v && !home ? "solid-fill" : "outline"}
          size="sm"
          aria-pressed={view === v && !home}
          onClick={() => {
            setPhoneNav({ view: v });
            if (home) go(home);
          }}
        >
          {OFFICE_VIEWS[v]}
        </Btn>
      ))}
    </div>
  );
}
