import { post } from "./api";
import { useAct } from "./hooks";
import { Switch } from "./ds";

/** 始業 / 終業のスイッチ(デザインシステムのスイッチ)。入れると始業、切ると終業。 */
export function WorkSwitch({ id, running, showState = true }: { id: number; running: boolean; showState?: boolean }) {
  const act = useAct();
  const toggle = () =>
    act(() => post(`/projects/${id}/run`, { running: !running }), running ? "終業しました。作業中の仕事が終わったら止まります" : "始業しました。受信箱を見に行きます");
  return (
    <span className={`workswitch${running ? " on" : ""}`}>
      {showState && (
        <span className="state" aria-hidden="true">
          {running ? "稼働中" : "終業中"}
        </span>
      )}
      <Switch label="稼働" checked={running} title={running ? "切ると終業します" : "入れると始業します"} onChange={toggle}>
        {null}
      </Switch>
    </span>
  );
}
