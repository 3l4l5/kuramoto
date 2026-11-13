import { useEffect } from "react";
import { post } from "./api";
import { Home } from "./Home";
import { go, useAct, useProject, useRoute, useStudio } from "./hooks";
import { NewProject } from "./NewProject";
import { ProjectPage } from "./Project";
import { TicketPage } from "./Ticket";
import { Studio } from "./studio/Studio";
import { ProductivityPage } from "./Productivity";
import { SettingsPage } from "./Settings";
import { pct, usd } from "./format";
import { DRAWER_LABEL, useDrawerState, type Drawer } from "./Team";
import { Btn } from "./ui";
import { WorkSwitch } from "./WorkSwitch";
import { clearRequestedTab, useFormationUi } from "./formationUi";

export function App() {
  const route = useRoute();
  const inProject = route.name === "project" || route.name === "studio" || route.name === "metrics" || route.name === "settings" || route.name === "ticket";
  const { drawer, moveTo, guard } = useDrawerState("id" in route ? route.id : null);
  // 床の凡例の「経路を変える」「流れを変える」で、編成の引き出しを開く(開発ルールの下書きがあれば、捨ててよいか確かめる)
  const seq = useFormationUi().request.seq;
  useEffect(() => {
    if (seq > 0) moveTo("formation");
  }, [seq]); // eslint-disable-line react-hooks/exhaustive-deps
  // 確認で引き出しが開かなかったときは、頼んだタブを残さない(あとで「編成」を押したときに、そのタブで開いてしまうため)
  useEffect(() => {
    if (!guard.confirming && drawer !== "formation") clearRequestedTab();
  }, [guard.confirming, drawer]);
  return (
    <div className="app">
      <header className="bar dads-bar">
        <div className="brand">
          <b>Kuramoto</b>
        </div>
        <nav className="crumb" aria-label="場所">
          <Btn kind="text" size="sm" aria-current={route.name === "home" ? "page" : undefined} onClick={() => go("#/")}>
            本部
          </Btn>
          {inProject && (
            <>
              <span className="sep">/</span>
              <ProjectName id={route.id} />
            </>
          )}
        </nav>
        {inProject && (
          <div className="tabs" role="group" aria-label="プロジェクトの画面">
            <Btn kind={route.name === "studio" ? "solid-fill" : "outline"} size="sm" aria-pressed={route.name === "studio"} onClick={() => go(`#/p/${route.id}/studio`)}>
              企画スタジオ
            </Btn>
            <Btn kind={route.name === "project" || route.name === "ticket" ? "solid-fill" : "outline"} size="sm" aria-pressed={route.name === "project" || route.name === "ticket"} onClick={() => go(`#/p/${route.id}`)}>
              オフィス
            </Btn>
            <Btn kind={route.name === "metrics" ? "solid-fill" : "outline"} size="sm" aria-pressed={route.name === "metrics"} onClick={() => go(`#/p/${route.id}/metrics`)}>
              生産性
            </Btn>
            <Btn kind={route.name === "settings" ? "solid-fill" : "outline"} size="sm" aria-pressed={route.name === "settings"} onClick={() => go(`#/p/${route.id}/settings`)}>
              設定
            </Btn>
          </div>
        )}
        <div className="spacer" />
        {(route.name === "project" || route.name === "ticket") && (
          <>
            <OfficeStatus id={route.id} />
            {(Object.keys(DRAWER_LABEL) as Drawer[]).map((k) => (
              <Btn key={k} kind={drawer === k ? "solid-fill" : "outline"} size="sm" aria-expanded={drawer === k} onClick={() => moveTo(drawer === k ? null : k)}>
                {DRAWER_LABEL[k]}
              </Btn>
            ))}
          </>
        )}
      </header>
      {route.name === "home" && <Home />}
      {route.name === "new" && <NewProject />}
      {route.name === "project" && <ProjectPage id={route.id} drawer={drawer} closeDrawer={() => moveTo(null)} guard={guard} />}
      {route.name === "ticket" && <TicketPage id={route.id} ticketId={route.ticketId} drawer={drawer} closeDrawer={() => moveTo(null)} guard={guard} />}
      {route.name === "studio" && <Studio id={route.id} />}
      {route.name === "metrics" && <ProductivityPage id={route.id} />}
      {route.name === "settings" && <SettingsPage id={route.id} />}
    </div>
  );
}

function ProjectName({ id }: { id: number }) {
  // どちらの画面からでも名前を出せるよう、企画スタジオの取得(軽い方ではないが共有される)を使う
  const studio = useStudio(id);
  return (
    <Btn kind="text" size="sm" aria-current="page" onClick={() => go(`#/p/${id}`)}>
      {studio.data?.project.name ?? "…"}
    </Btn>
  );
}

/** オフィスの右上: 指標と、始業 / 終業。 */
function OfficeStatus({ id }: { id: number }) {
  const { data } = useProject(id);
  const act = useAct();
  if (!data) return null;
  const m = data.metrics;
  return (
    <>
      <WorkSwitch id={id} running={data.running} />
    </>
  );
}
