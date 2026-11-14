import { useEffect, useSyncExternalStore } from "react";
import { isUnauthorized, post, subscribeUnauthorized } from "./api";
import { Home } from "./Home";
import { go, useDbStatus, useProject, useRoute, useStudio } from "./hooks";
import { NewProject } from "./NewProject";
import { ProjectPage } from "./Project";
import { TicketPage } from "./Ticket";
import { Studio } from "./studio/Studio";
import { MetricsKpi, ProductivityPage } from "./Productivity";
import { SettingsPage } from "./Settings";
import { pct, usd } from "./format";
import { DRAWER_LABEL, useDrawerState, type Drawer } from "./Team";
import { Btn } from "./ui";
import { Chip } from "./ds";
import { PhoneBar } from "./PhoneBar";
import { WorkSwitch } from "./WorkSwitch";
import { ProjectNav } from "./OfficeViewSwitch";
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
  // オフィス(と、その中のチケット)では、オフィス/ボード/ツリーのどれかが選ばれた状態になる。ほかの画面では、いまの画面の行き先が選ばれる
  const inOffice = route.name === "project" || route.name === "ticket";
  return (
    <div className="app" data-route={route.name}>
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
        {inProject && <ProjectNav id={route.id} route={route.name} />}
        <div className="spacer" />
        {inProject && <FormationChip id={route.id} />}
        {route.name === "metrics" && <MetricsKpi id={route.id} />}
        {inOffice && (
          <>
            <WorkStatus id={route.id} />
            <span className="drawerbtns">
              {(Object.keys(DRAWER_LABEL) as Drawer[]).map((k) => (
                <Btn key={k} kind={drawer === k ? "solid-fill" : "outline"} size="sm" aria-expanded={drawer === k} onClick={() => moveTo(drawer === k ? null : k)}>
                  {DRAWER_LABEL[k]}
                </Btn>
              ))}
            </span>
          </>
        )}
      </header>
      <UnauthorizedBanner />
      <DbDownBanner />
      {route.name === "home" && <Home />}
      {route.name === "new" && <NewProject />}
      {route.name === "project" && <ProjectPage id={route.id} drawer={drawer} closeDrawer={() => moveTo(null)} guard={guard} />}
      {route.name === "ticket" && <TicketPage id={route.id} ticketId={route.ticketId} drawer={drawer} closeDrawer={() => moveTo(null)} guard={guard} />}
      {route.name === "studio" && <Studio id={route.id} />}
      {route.name === "metrics" && <ProductivityPage id={route.id} />}
      {route.name === "settings" && <SettingsPage id={route.id} />}
      {inProject && route.name !== "ticket" && <PhoneBar id={route.id} drawer={drawer} moveTo={moveTo} />}
    </div>
  );
}

/** 合言葉が通らないとき(401)、どの画面でも一番上に出す。通るようになったら消える(ADR-0059)。 */
function UnauthorizedBanner() {
  const unauthorized = useSyncExternalStore(subscribeUnauthorized, isUnauthorized);
  if (!unauthorized) return null;
  return (
    <div className="budgetalert" role="alert">
      <p>
        <b>合言葉が通りません。</b>
        Kuramoto を起動した端末に出ている「合言葉つきの URL」を開いてください(一度開けば、このブラウザでは 1 年間通ります)。
      </p>
    </div>
  );
}

/** DB(MySQL)に繋がらないとき、どの画面でも一番上に出す。繋がり直したら消える(ADR-0041)。 */
function DbDownBanner() {
  const { data } = useDbStatus();
  const down = data?.dbDown;
  if (!down) return null;
  return (
    <div className="budgetalert" role="alert">
      <p>
        <b>DB(MySQL)に繋がらないので、画面の表示と受信箱の見回り・エージェントの起動を止めて待っています({new Date(down.since).toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}から)。</b>
        繋がり直したら自動で再開します。
        <br />
        <small>エラー: {down.error}</small>
      </p>
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

/** どのプロジェクトの画面でも、ヘッダーの右に出す編成の版の札。 */
function FormationChip({ id }: { id: number }) {
  const { data } = useProject(id);
  if (!data) return null;
  return (
    <Chip tone="version" className="verchip" title="いま使っている編成の版">
      編成 v{data.formation.version}
    </Chip>
  );
}

/** オフィスの右上: 始業 / 終業。 */
function WorkStatus({ id }: { id: number }) {
  const { data } = useProject(id);
  if (!data) return null;
  return <WorkSwitch id={id} running={data.running} />;
}
