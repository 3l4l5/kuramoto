import { useState, type FormEvent } from "react";
import { post, type StudioView } from "../api";
import { useAct } from "../hooks";
import { FlowSvg, InfraSvg, ModelSvg } from "./diagrams";
import { Btn } from "../ui";
import { Chip, Input } from "../ds";
import { ownerOf, type Cast, type Stage } from "./Studio";

export type Ui = {
  stage: string | null;
  scr: string | null;
  node: string | null;
  commentMode: boolean;
  pin: { variant: string; x: number; y: number } | null;
  ask: string | null;
};
type Props = { d: StudioView; pid: number; stage: string; ui: Ui; setUi: (p: Partial<Ui>) => void };

const SKIP_EFFECT: Record<string, string> = {
  flow: "画面のつながりと例外(満席・未ログインなど)を、開発が画面を作りながら決めます。抜けはテストや QA で見つかることが多く、そこからの手戻りになります。",
  screen: "画面の見た目と配置を、開発が要件から直接作ります。合意のない画面がそのまま出来上がるので、見た目の直しは実装後になります。",
  infra: "どこで・どう動かすか(ホスティング・環境・デプロイ・監視・費用)を、開発が実装しながら決めます。後から動かす場所を変えると作り直しが大きく、費用にも実装が終わるまで気づけません。",
  model: "アーキテクチャスタイル・ドメイン・データ設計を、開発が実装しながら決めます。アーキテクトは着手前の設計確認でだけ見ます。チケットごとに作り方がばらつきやすく、後から表や約束を変えると手戻りが大きくなり、戻せない変更に気づくのも遅れます。",
};
const delegateText = (c: Cast, stage: string): string =>
  ({
    req: `企画の${c.planner}が、未決を推奨で決めて要件の版を作ります。あなたには決めた内容を報告します。`,
    flow: `デザイナーの${c.designer}が、要件から画面のつながりと例外を決めて版を作ります。あなたには決めた内容を報告します。`,
    screen: `デザイナーの${c.designer}が、各画面の案を 1 つに決めて版を作ります。あなたには選んだ案と理由を報告します。`,
    infra: `アーキテクトの${c.architect}が、既にある環境を確かめたうえで、動かす場所・環境とデプロイ・運用・費用を決めて版を作ります。あなたには決めた内容と月額の見積もりを報告します。`,
    model: `アーキテクトの${c.architect}が、アーキテクチャスタイル・ドメインモデル・データ設計(表・列・マイグレーション)を決めて版を作ります。あなたには決めた内容を報告します。`,
  })[stage] ?? "";
const muted = { color: "var(--muted)", fontSize: "var(--fs-md)" } as const;

/** 段階ごとの作業の場。 */
export function StageWork(props: Props) {
  const { d, pid, stage } = props;
  const act = useAct();
  if (stage === "handoff") return <Handoff d={d} />;
  const s = d.stages.find((x) => x.key === stage);
  if (!s) return <Unknown />;
  const setMode = (mode: string) => {
    props.setUi({ ask: null });
    void act(() => post(`/projects/${pid}/studio/stages/${s.key}/mode`, { mode }));
  };
  if (s.mode === "skip")
    return (
      <>
        <header>
          <h2>{s.label}</h2>
        </header>
        <div className="skipped">
          <b style={{ color: "var(--ink)" }}>この段階は省いています</b>
          <span>{SKIP_EFFECT[s.key]}</span>
          <Btn kind="outline" size="sm" onClick={() => setMode("agree")}>
            省くのをやめて、この段階を作る
          </Btn>
        </div>
      </>
    );
  const agreed = s.agreedVersion === s.version;
  return (
    <>
      {s.mode === "delegate" && (
        <div className="delegated">
          <b>お任せ中</b>
          <span>
            {s.done ? `${ownerOf(d.cast, s.key)}が決めた v${s.version} です。` : `${ownerOf(d.cast, s.key)}が版を作っています。`}戻せない変更だけはあなたに聞きます。
          </span>
          <Btn kind="outline" size="sm" style={{ marginLeft: "auto" }} onClick={() => setMode("agree")}>
            自分で確かめる(合意する進め方に戻す)
          </Btn>
        </div>
      )}
      <header>
        <h2>
          {s.label} v{s.version}
        </h2>
        {s.agreedVersion != null && s.agreedVersion < s.version && <span className="chip ver">v{s.agreedVersion} に合意済み · 変更あり</span>}
        {s.mode === "agree" && (
          <Btn
            kind="solid-fill"
            className="agree"
            disabled={!!s.agreeBlocker}
            title={s.agreeBlocker ?? undefined}
            onClick={() => act(() => post(`/projects/${pid}/studio/stages/${s.key}/agree`), "合意しました")}
          >
            {agreed ? "合意済み" : "この版に合意する"}
          </Btn>
        )}
      </header>
      {s.mode === "agree" && s.agreeBlocker && !agreed && !/中身がありません/.test(s.agreeBlocker) && (
        <div style={{ fontSize: "var(--fs-sm)", color: "var(--muted)", marginTop: -8 }}>合意するには: {s.agreeBlocker}</div>
      )}
      {/* あなたに答えてほしい未決は、中身より上に出す */}
      <Issues d={d} pid={pid} stage={s.key} show="open" />
      {!s.started ? (
        <div className="skipped">
          <b style={{ color: "var(--ink)" }}>前の段階が終わると、{ownerOf(d.cast, s.key)}が作り始めます</b>
          <span>{s.key === "req" ? "" : "前の段階を合意するか、お任せ・省略にすると始まります。"}</span>
        </div>
      ) : s.key === "req" ? (
        <Req d={d} />
      ) : s.key === "flow" ? (
        <Flow {...props} />
      ) : s.key === "screen" ? (
        <Screens {...props} />
      ) : s.key === "infra" ? (
        <Infra d={d} />
      ) : s.key === "model" ? (
        <Model d={d} />
      ) : (
        <Unknown />
      )}
      <Issues d={d} pid={pid} stage={s.key} show="decided" />
      <ModeBar s={s} cast={d.cast} ask={props.ui.ask} setAsk={(ask) => props.setUi({ ask })} setMode={setMode} />
    </>
  );
}

function Unknown() {
  return (
    <div className="skipped">
      <b style={{ color: "var(--ink)" }}>この段階を表示できません</b>
      <span>画面が古いかもしれません。ページを読み込み直してください。</span>
    </div>
  );
}

function ModeBar({ s, cast, ask, setAsk, setMode }: { s: Stage; cast: Cast; ask: string | null; setAsk: (a: string | null) => void; setMode: (m: string) => void }) {
  if (s.mode !== "agree" || s.agreedVersion === s.version) return null;
  if (ask === `${s.key}:skip`)
    return (
      <div className="skipask">
        <b>{s.label}を省くと</b>
        <span>{SKIP_EFFECT[s.key]}</span>
        <div className="acts">
          <Btn kind="solid-fill" size="sm" onClick={() => setMode("skip")}>
            省いて進める
          </Btn>
          <Btn kind="outline" size="sm" onClick={() => setAsk(null)}>
            やめる
          </Btn>
        </div>
      </div>
    );
  if (ask === `${s.key}:delegate`)
    return (
      <div className="skipask">
        <b>{s.label}をお任せにすると</b>
        <span>{delegateText(cast, s.key)}戻せない変更(データの消去・公開済みの約束の変更など)だけは、お任せでもあなたに聞きます。後から合意する進め方に戻せます。</span>
        <div className="acts">
          <Btn kind="solid-fill" size="sm" onClick={() => setMode("delegate")}>
            お任せにする
          </Btn>
          <Btn kind="outline" size="sm" onClick={() => setAsk(null)}>
            やめる
          </Btn>
        </div>
      </div>
    );
  return (
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
      <span style={{ fontSize: "var(--fs-sm)", color: "var(--muted)", alignSelf: "center" }}>進め方:</span>
      <Btn kind="outline" size="sm" onClick={() => setAsk(`${s.key}:delegate`)}>
        お任せにする
      </Btn>
      {s.key === "req" ? (
        <span style={{ fontSize: "var(--fs-sm)", color: "var(--muted)", alignSelf: "center" }}>(要件は省けません)</span>
      ) : (
        <Btn kind="outline" size="sm" onClick={() => setAsk(`${s.key}:skip`)}>
          この段階を省く
        </Btn>
      )}
    </div>
  );
}

function Issues({ d, pid, stage, show }: { d: StudioView; pid: number; stage: string; show: "open" | "decided" }) {
  const act = useAct();
  const items = d.openItems.filter((o) => o.stage === stage);
  const open = show === "open" ? items.filter((o) => o.answer === null) : [];
  const closed = show === "decided" ? items.filter((o) => o.answer !== null) : [];
  const answer = (id: number, text: string) => act(() => post(`/projects/${pid}/studio/open-items/${id}`, { answer: text }), "答えました。担当が反映します");
  return (
    <>
      {open.map((o) => (
        <div className="issue" key={o.id}>
          <b>
            未決: {o.question}
            {!o.reversible && (
              <>
                {" "}
                <span className="chip hot">戻せない</span>
              </>
            )}
          </b>
          <span>{o.why}</span>
          <div className="acts">
            {o.options.map((x, i) => (
              <Btn key={i} size="sm" kind={i === o.recommended ? "solid-fill" : "outline"} onClick={() => answer(o.id, x)}>
                {x}
                {i === o.recommended ? "(推奨)" : ""}
              </Btn>
            ))}
          </div>
          <FreeAnswer id={o.id} onAnswer={(t) => answer(o.id, t)} />
        </div>
      ))}
      {closed.length > 0 && (
        <details style={{ fontSize: "var(--fs-md)" }}>
          <summary style={{ cursor: "pointer", color: "var(--muted)" }}>決まったこと({closed.length})</summary>
          <ul style={{ margin: "6px 0 0", paddingLeft: 20 }}>
            {closed.map((o) => (
              <li key={o.id}>
                {o.question} → <b>{o.answer}</b>
                {o.decided_by === "ai" ? "(お任せで決定)" : ""}
              </li>
            ))}
          </ul>
        </details>
      )}
    </>
  );
}

function FreeAnswer({ id, onAnswer }: { id: number; onAnswer: (t: string) => void }) {
  const [t, setT] = useState("");
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (t.trim()) onAnswer(t.trim());
  };
  return (
    <form className="pinform" onSubmit={submit}>
      <label className="hint" htmlFor={`free-${id}`}>
        別の答え
      </label>
      <Input id={`free-${id}`} type="text" size="sm" className="grow" autoComplete="off" value={t} onChange={(e) => setT(e.target.value)} />
      <Btn kind="outline" size="sm" type="submit">
        答える
      </Btn>
    </form>
  );
}

// ---- 要件 ----

function Req({ d }: { d: StudioView }) {
  const b = d.brief;
  const screensOf = (code: string) => d.screens.filter((s) => s.requirements.includes(code)).map((s) => s.name);
  return (
    <>
      {b && (
        <div style={{ display: "grid", gridTemplateColumns: "96px 1fr", gap: "4px 10px", fontSize: "var(--fs-md)" }}>
          <b>目的</b>
          <span>{b.purpose}</span>
          <b>使う人</b>
          <span>{b.users.join("、")}</span>
          <b>やらないこと</b>
          <span>{b.outOfScope.join("、") || "—"}</span>
        </div>
      )}
      {d.requirements.length === 0 && <div style={muted}>{d.cast.planner}との会話から、要件の項目(受け入れ条件付き)がここに書かれていきます。</div>}
      {d.requirements.map((r) => (
        <div className="reqi" key={r.id}>
          <span className="nm">
            {r.code} {r.name}
          </span>
          <div className="ac">
            <b>受け入れ条件</b>
            {r.acceptance}
          </div>
          <div className="links">画面: {screensOf(r.code).join("、") || "なし"}</div>
        </div>
      ))}
    </>
  );
}

// ---- ユーザーフロー ----

function Flow({ d, ui, setUi }: Props) {
  const f = d.flow;
  if (!f) return <div style={muted}>{d.cast.designer}がフローを描いています。</div>;
  const sel = f.nodes.find((n) => n.id === ui.node);
  return (
    <>
      <div className="flowwrap">
        <FlowSvg flow={f} selected={ui.node} onSelect={(id) => setUi({ node: id })} />
      </div>
      <div style={muted}>
        {sel && (
          <>
            選択中: <b style={{ color: "var(--ink)" }}>{sel.label}</b>
            {sel.sub ? `(${sel.sub})` : ""} ·{" "}
          </>
        )}
        図の四角を押すと選べます。実線は通常の流れ、黄色い点線は分岐と例外です。直したいところは{d.cast.designer}に言葉で伝えてください。
      </div>
    </>
  );
}

// ---- 画面デザイン ----

function Screens({ d, pid, ui, setUi }: Props) {
  const act = useAct();
  const [text, setText] = useState("");
  if (!d.screens.length) return d.designSystem ? <DesignSystemPanel ds={d.designSystem} /> : <div style={muted}>{d.cast.designer}が画面の試作を作っています。</div>;
  const sc = d.screens.find((s) => s.key === ui.scr) ?? d.screens[0]!;
  const multi = sc.variants.length > 1;
  const openPins = sc.comments.filter((c) => c.resolved_in === null);
  const canComment = !multi || !!sc.chosen;
  const agreeMode = d.stages.find((s) => s.key === "screen")?.mode === "agree";

  const submitPin = async (e: FormEvent) => {
    e.preventDefault();
    const pin = ui.pin;
    if (!pin || !text.trim()) return;
    setUi({ pin: null, commentMode: false });
    setText("");
    await act(() => post(`/projects/${pid}/studio/screens/${sc.key}/comments`, { variant: pin.variant, x: pin.x, y: pin.y, body: text.trim() }), `コメントを付けました。${d.cast.designer}が直します`);
  };

  return (
    <>
      {d.designSystem ? <DesignSystemPanel ds={d.designSystem} /> : <div className="hint">デザインシステム(トークンと部品)がまだありません。{d.cast.designer}に頼むと作ります。合意には必要です。</div>}
      <div className="scrlist" role="group" aria-label="画面">
        {d.screens.map((s) => (
          <Btn kind={s.key === sc.key ? "solid-fill" : "outline"} size="xs" key={s.key} aria-pressed={s.key === sc.key} onClick={() => setUi({ scr: s.key, pin: null, commentMode: false })}>
            {s.name}
            <span className="d" aria-hidden="true" style={{ background: s.agreed ? "var(--ok)" : "var(--warn)" }} />
          </Btn>
        ))}
      </div>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", fontSize: "var(--fs-sm)", color: "var(--muted)" }}>
        要件: {sc.requirements.join("、") || "なし"}
        <Btn kind="outline" size="sm" style={{ marginLeft: "auto" }} disabled={!canComment} onClick={() => setUi({ commentMode: !ui.commentMode, pin: null })}>
          {ui.commentMode ? "コメントをやめて試作を触る" : "コメントを付ける"}
        </Btn>
      </div>
      {ui.commentMode ? (
        <div style={{ fontSize: "var(--fs-sm)", color: "var(--design)" }}>{multi ? "選んだ案" : "試作"}の上を押すと、その場所にコメントを付けられます。</div>
      ) : (
        !canComment && <div style={{ fontSize: "var(--fs-sm)", color: "var(--muted)" }}>案を選ぶと、その案にコメントを付けられます。</div>
      )}
      <div className="variants">
        {sc.variants.map((v) => {
          const pins = sc.comments.map((c, i) => [c, i] as const).filter(([c]) => c.variant === v.id || (!c.variant && !multi));
          return (
            <div className="variant" key={v.id}>
              <div className="vh">
                <b>案 {v.id}</b>
                {multi && (
                  <Btn
                    kind={sc.chosen === v.id ? "solid-fill" : "outline"}
                    size="xs"
                    onClick={() => act(() => post(`/projects/${pid}/studio/screens/${sc.key}/pick`, { variant: v.id }))}
                  >
                    {sc.chosen === v.id ? "この案に決定" : "この案にする"}
                  </Btn>
                )}
              </div>
              <div className={`${sc.device === "desktop" ? "desk" : "phone"} proto`}>
                <iframe title={`${sc.name} 案 ${v.id}`} sandbox="allow-scripts" srcDoc={v.html} />
                {pins.map(([c, i]) => (
                  <span key={c.id} className={`pin${c.resolved_in !== null ? " done" : ""}`} style={{ left: `${c.x}%`, top: `${c.y}%` }}>
                    {i + 1}
                  </span>
                ))}
                {ui.pin?.variant === v.id && (
                  <span className="pin" style={{ left: `${ui.pin.x}%`, top: `${ui.pin.y}%` }}>
                    +
                  </span>
                )}
                {ui.commentMode && (!multi || sc.chosen === v.id) && (
                  <div
                    className="pinlayer"
                    role="button"
                    aria-label={`案 ${v.id} の上にコメントを付ける`}
                    onClick={(e) => {
                      const r = e.currentTarget.getBoundingClientRect();
                      setUi({ pin: { variant: v.id, x: Math.round(((e.clientX - r.left) / r.width) * 100), y: Math.round(((e.clientY - r.top) / r.height) * 100) } });
                    }}
                  />
                )}
              </div>
              {v.note && <div style={{ fontSize: "var(--fs-sm)", color: "var(--muted)", maxWidth: 300 }}>{v.note}</div>}
            </div>
          );
        })}
      </div>
      <div className="pins-list">
        <b>コメント</b>
        {sc.comments.length === 0 && <span style={{ color: "var(--muted)" }}>まだありません</span>}
        {sc.comments.map((c, i) => (
          <div className="pc" key={c.id}>
            <i className={c.resolved_in !== null ? "done" : ""}>{i + 1}</i>
            <span>
              {c.body}{" "}
              {c.resolved_in !== null ? <span className="okc">v{c.resolved_in} で対応済み</span> : <span style={{ color: "var(--muted)" }}>{d.cast.designer}が対応中</span>}
            </span>
          </div>
        ))}
      </div>
      {ui.pin && (
        <form className="pinform" onSubmit={submitPin}>
          <label className="hint" htmlFor="pin-in">
            コメント
          </label>
          <Input id="pin-in" type="text" size="sm" className="grow" autoComplete="off" autoFocus value={text} onChange={(e) => setText(e.target.value)} />
          <Btn kind="solid-fill" size="sm" type="submit">
            付ける
          </Btn>
          <Btn kind="text" size="sm" onClick={() => setUi({ pin: null })}>
            やめる
          </Btn>
        </form>
      )}
      {agreeMode && (
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <Btn
            kind="outline"
            size="sm"
            disabled={sc.agreed || (multi && !sc.chosen) || openPins.length > 0}
            onClick={() => act(() => post(`/projects/${pid}/studio/screens/${sc.key}/agree`), "この画面に合意しました")}
          >
            {sc.agreed ? "この画面は合意済み" : "この画面に合意する"}
          </Btn>
          <span style={{ fontSize: "var(--fs-sm)", color: "var(--muted)" }}>{multi && !sc.chosen ? "案を 1 つ選んでください" : openPins.length ? "対応待ちのコメントがあります" : ""}</span>
        </div>
      )}
    </>
  );
}

// ---- インフラ ----

function Infra({ d }: { d: StudioView }) {
  const f = d.infra;
  if (!f) return <div style={muted}>{d.cast.architect}が既にある環境を確かめて、インフラの構成を書いています。</div>;
  const total = f.cost.monthly.reduce((s, x) => s + x.usd, 0);
  const sec = (title: string, inner: React.ReactNode) => (
    <div>
      <b style={{ fontSize: "var(--fs-md)" }}>{title}</b>
      {inner}
    </div>
  );
  const dl = (rows: [string, string][]) => (
    <div style={{ display: "grid", gridTemplateColumns: "110px 1fr", gap: "4px 10px", fontSize: "var(--fs-md)", marginTop: 4 }}>
      {rows
        .filter((r) => r[1])
        .map((r) => (
          <FragmentPair key={r[0]} k={r[0]} v={r[1]} />
        ))}
    </div>
  );
  return (
    <>
      <div style={{ fontSize: "var(--fs-base)" }}>{f.hosting.summary}</div>
      {f.hosting.reuse.length > 0 && <div style={{ fontSize: "var(--fs-sm)", color: "var(--muted)" }}>既にあって使うもの: {f.hosting.reuse.join("、")}</div>}
      <InfraSvg infra={f} />
      {sec(
        "構成",
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "var(--fs-md)", marginTop: 4 }}>
          <thead>
            <tr style={{ textAlign: "left", color: "var(--muted)" }}>
              <th>名前</th>
              <th>種類</th>
              <th>サービス</th>
              <th>役目</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {f.components.map((c) => (
              <tr key={c.name} style={{ borderTop: "1px solid var(--line)" }}>
                <td>
                  <b>{c.name}</b>
                </td>
                <td>{c.kind}</td>
                <td>{c.service}</td>
                <td>{c.purpose}</td>
                <td>{c.isNew ? <span style={{ color: "var(--dev)", fontSize: "var(--fs-xs)" }}>新規</span> : <span style={{ color: "var(--muted)", fontSize: "var(--fs-xs)" }}>既存</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>,
      )}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(min(100%,320px),1fr))", gap: 14 }}>
        {sec(
          "環境",
          <ul style={{ margin: "4px 0 0", paddingLeft: 20, fontSize: "var(--fs-md)" }}>
            {f.environments.map((e) => (
              <li key={e.name}>
                <b>{e.name}</b> — {e.purpose}
              </li>
            ))}
          </ul>,
        )}
        {sec(
          "デプロイ",
          <>
            {dl([
              ["CI/CD", f.deploy.ci],
              ["マイグレーション", f.deploy.migrations],
              ["秘密情報", f.deploy.secrets],
            ])}
            {f.deploy.steps.length > 0 && (
              <ol style={{ margin: "6px 0 0", paddingLeft: 20, fontSize: "var(--fs-md)" }}>
                {f.deploy.steps.map((x, i) => (
                  <li key={i}>{x}</li>
                ))}
              </ol>
            )}
          </>,
        )}
        {sec(
          "運用",
          dl([
            ["監視", f.operations.monitoring],
            ["ログ", f.operations.logging],
            ["バックアップ", f.operations.backup],
            ["障害時の戻し方", f.operations.rollback],
          ]),
        )}
        {sec(
          "費用と規模(月額の見積もり)",
          <>
            <ul style={{ margin: "4px 0 0", paddingLeft: 20, fontSize: "var(--fs-md)", color: "var(--muted)" }}>
              {f.cost.assumptions.map((x, i) => (
                <li key={i}>{x}</li>
              ))}
            </ul>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "var(--fs-md)", marginTop: 6 }}>
              <tbody>
                {f.cost.monthly.map((x, i) => (
                  <tr key={i} style={{ borderTop: "1px solid var(--line)" }}>
                    <td>{x.item}</td>
                    <td style={{ textAlign: "right", fontFamily: "var(--f-mono)" }}>${x.usd.toLocaleString()}</td>
                  </tr>
                ))}
                <tr style={{ borderTop: "2px solid var(--ink)" }}>
                  <td>
                    <b>合計</b>
                  </td>
                  <td style={{ textAlign: "right", fontFamily: "var(--f-mono)" }}>
                    <b>${total.toLocaleString()}</b> / 月
                  </td>
                </tr>
              </tbody>
            </table>
          </>,
        )}
      </div>
    </>
  );
}

function FragmentPair({ k, v }: { k: string; v: string }) {
  return (
    <>
      <span style={{ color: "var(--muted)" }}>{k}</span>
      <span>{v}</span>
    </>
  );
}

// ---- ドメインとデータ ----

const BUILD: Record<string, [string, string]> = { build: ["作る", "var(--dev)"], reuse: ["既存を使う", "var(--ok)"], skip: ["作らない", "var(--muted)"] };
const CHANGE: Record<string, string> = { new: "新規", alter: "変更", none: "変更なし" };

function Model({ d }: { d: StudioView }) {
  const sections: Section[] = [];
  if (d.architecture) sections.push({ key: "arch", label: "アーキテクチャ", content: <ArchitectureView a={d.architecture} /> });
  const selections = d.architecture?.selections ?? [];
  if (selections.length) sections.push({ key: "tech", label: "技術選定", count: selections.length, content: <TechSelectionView s={selections} /> });
  if (d.domain) sections.push({ key: "domain", label: "ドメインモデル", content: <DomainView m={d.domain} /> });
  if (d.data && d.data.tables.length) sections.push({ key: "tables", label: "テーブル設計", count: d.data.tables.length, content: <TablesView t={d.data} /> });
  if (!sections.length) return <div style={muted}>{d.cast.architect}がアーキテクチャスタイルを書いています。</div>;
  return <SectionTabs label="アーキテクチャとデータの中身" sections={sections} />;
}

type Section = { key: string; label: string; count?: number; content: React.ReactNode };

/**
 * 中身が 2 つ以上あるときだけタブに分ける。1 つしか無いうちはタブを出さず、そのまま見せる。
 * 選んでいたタブの中身が無くなったら、先頭のタブに戻す。
 */
function SectionTabs({ label, sections }: { label: string; sections: Section[] }) {
  const [sel, setSel] = useState<string | null>(null);
  if (sections.length === 1) return <>{sections[0]!.content}</>;
  const cur = sections.find((s) => s.key === sel) ?? sections[0]!;
  return (
    <div className="sectabs-wrap">
      <div className="sectabs" role="tablist" aria-label={label}>
        {sections.map((s) => (
          <button
            type="button"
            role="tab"
            key={s.key}
            id={`tab-${s.key}`}
            aria-selected={s.key === cur.key}
            aria-controls={`panel-${s.key}`}
            onClick={() => setSel(s.key)}
          >
            {s.label}
            {s.count !== undefined && <span className="cnt">{s.count}</span>}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`panel-${cur.key}`} aria-labelledby={`tab-${cur.key}`} className="sectab-panel">
        {cur.content}
      </div>
    </div>
  );
}

function ArchitectureView({ a }: { a: NonNullable<StudioView["architecture"]> }) {
  return (
    <div className="arch">
      <div>
        <div style={{ fontSize: "var(--fs-sm)", color: "var(--muted)" }}>アーキテクチャスタイル</div>
        <div style={{ fontSize: "var(--fs-lg)", fontWeight: 700 }}>{a.style.name}</div>
        <div style={{ fontSize: "var(--fs-md)" }}>{a.style.why}</div>
        {a.style.alternatives.length > 0 && (
          <ul style={{ margin: "6px 0 0", paddingLeft: 20, fontSize: "var(--fs-md)", color: "var(--muted)" }}>
            {a.style.alternatives.map((x, i) => (
              <li key={i}>
                選ばなかった案: <b>{x.name}</b> — {x.whyNot}
              </li>
            ))}
          </ul>
        )}
      </div>
      {a.modules.length > 0 && (
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "var(--fs-md)" }}>
          <thead>
            <tr style={{ textAlign: "left", color: "var(--muted)" }}>
              <th>モジュール</th>
              <th>責務</th>
              <th>リポジトリ</th>
            </tr>
          </thead>
          <tbody>
            {a.modules.map((m) => (
              <tr key={m.name} style={{ borderTop: "1px solid var(--line)" }}>
                <td>
                  <b>{m.name}</b>
                </td>
                <td>{m.responsibility}</td>
                <td style={{ fontFamily: "var(--f-mono)" }}>{m.repo}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(min(100%,280px),1fr))", gap: 12, fontSize: "var(--fs-md)" }}>
        <div>
          <b style={{ fontSize: "var(--fs-md)" }}>守る原則</b>
          <ul style={{ margin: "4px 0 0", paddingLeft: 20 }}>
            {a.principles.map((x, i) => (
              <li key={i}>{x}</li>
            ))}
          </ul>
        </div>
        <div>
          <b style={{ fontSize: "var(--fs-md)" }}>API とフロント</b>
          <div style={{ display: "grid", gridTemplateColumns: "80px 1fr", gap: "4px 10px", marginTop: 4 }}>
            <FragmentPair k="API" v={`${a.api.style}${a.api.notes ? `(${a.api.notes})` : ""}`} />
            <FragmentPair k="描画" v={a.frontend.rendering} />
            <FragmentPair k="状態" v={a.frontend.state} />
          </div>
        </div>
      </div>
      {a.stack.length > 0 && (
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "var(--fs-md)" }}>
          <thead>
            <tr style={{ textAlign: "left", color: "var(--muted)" }}>
              <th>領域</th>
              <th>技術</th>
              <th>理由</th>
            </tr>
          </thead>
          <tbody>
            {a.stack.map((s) => (
              <tr key={s.area} style={{ borderTop: "1px solid var(--line)" }}>
                <td>{s.area}</td>
                <td>
                  <b>{s.choice}</b>
                </td>
                <td>{s.why}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function DomainView({ m }: { m: NonNullable<StudioView["domain"]> }) {
  const list = (title: string, xs: string[]) =>
    xs.length > 0 && (
      <div key={title}>
        <b style={{ fontSize: "var(--fs-md)" }}>{title}</b>
        <ul style={{ margin: "4px 0 0", paddingLeft: 20, fontSize: "var(--fs-md)" }}>
          {xs.map((x, i) => (
            <li key={i}>{x}</li>
          ))}
        </ul>
      </div>
    );
  return (
    <>
      <ModelSvg domain={m} />
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(min(100%,260px),1fr))", gap: 10 }}>
        {list("用語", m.terms)}
        {list("集約", m.aggregates)}
        {list("守るルール", m.rules)}
        {list("状態の移り変わり", m.states)}
        {list("境界", m.boundaries)}
      </div>
      <div>
        <b style={{ fontSize: "var(--fs-md)" }}>作る / 既存を使う / 作らない</b>
        <ul style={{ margin: "4px 0 0", paddingLeft: 20, fontSize: "var(--fs-md)" }}>
          {m.build.map((x, i) => (
            <li key={i}>
              <b style={{ fontSize: "var(--fs-xs)", padding: "0 6px", borderRadius: "var(--r-sm)", marginRight: 6, color: "var(--surface)", background: BUILD[x.decision]![1] }}>{BUILD[x.decision]![0]}</b>
              {x.feature}
              {x.note ? ` — ${x.note}` : ""}
            </li>
          ))}
        </ul>
      </div>
    </>
  );
}

/** 技術選定: 領域ごとに、なぜ選ぶ必要があるか・評価軸・候補の比較・選んだものと理由を並べる。 */
function TechSelectionView({ s }: { s: NonNullable<NonNullable<StudioView["architecture"]>["selections"]> }) {
  return (
    <div className="techsel">
      {s.map((x) => (
        <section className="sel" key={x.area} aria-label={`技術選定 ${x.area}`}>
          <header>
            <b className="area">{x.area}</b>
            <span>
              → <b>{x.choice}</b>
            </span>
            {!x.reversible && (
              <Chip tone="danger">
                後から替えにくい
              </Chip>
            )}
          </header>
          <div className="need">{x.need}</div>
          <div className="hint">評価軸: {x.criteria.join("、")}</div>
          <table>
            <thead>
              <tr>
                <th>候補</th>
                <th>よい点</th>
                <th>気になる点</th>
              </tr>
            </thead>
            <tbody>
              {x.candidates.map((c) => (
                <tr key={c.name} className={c.name === x.choice ? "chosen" : undefined}>
                  <th>
                    {c.name}
                    {c.name === x.choice && (
                      <>
                        {" "}
                        <Chip>
                          選択
                        </Chip>
                      </>
                    )}
                  </th>
                  <td>{c.pros}</td>
                  <td>{c.cons}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="why">
            <b>選んだ理由</b> {x.why}
          </div>
        </section>
      ))}
    </div>
  );
}

/** テーブル設計: 表ごとに、変更の種類・戻せるか・列を並べる。 */
function TablesView({ t }: { t: NonNullable<StudioView["data"]> }) {
  return (
    <div className="tables">
      {t.tables.map((x) => (
        <section className="tbl" key={x.name} aria-label={`表 ${x.name}`}>
          <header>
            <b className="name">{x.name}</b>
            <span className={`chip ${x.change === "new" ? "new" : x.change === "alter" ? "warn" : "ver"}`}>{CHANGE[x.change]}</span>
            {x.reversible ? <span className="chip ver">戻せる</span> : <span className="chip hot">戻せない</span>}
          </header>
          {x.note && <div className="note">{x.note}</div>}
          <ol className="cols">
            {x.columns.map((c, i) => {
              const [head, ...rest] = c.split(" — ");
              return (
                <li key={i}>
                  <code>{head}</code>
                  {rest.length > 0 && <span>{rest.join(" — ")}</span>}
                </li>
              );
            })}
          </ol>
        </section>
      ))}
    </div>
  );
}

// ---- チームに渡す ----

function Handoff({ d }: { d: StudioView }) {
  if (!d.handoff.handed)
    return (
      <>
        <header>
          <h2>チームに渡しています</h2>
        </header>
        <div className="handed">
          <span>リーダーの{d.cast.lead}が、合意した版からチケットを作っています。</span>
        </div>
      </>
    );
  const mode: Record<string, string> = { agree: "", delegate: "(お任せ)", skip: "省略" };
  return (
    <>
      <header>
        <h2>チームに渡しました</h2>
      </header>
      <div className="handed">
        <span>リーダーの{d.cast.lead}が、合意した版から {d.tickets.length} 件のチケットを作りました。オフィスの「始業」で開発が始まります。</span>
        <table>
          <thead>
            <tr>
              <th>チケット</th>
              <th>内容</th>
              <th>要件</th>
              <th>画面</th>
              <th>設計</th>
            </tr>
          </thead>
          <tbody>
            {d.tickets.map((t) => {
              // 引き継いだ PR・Issue のチケット(既存のリポジトリの続きから)や、デザインシステムの土台のチケットは、画面や設計のひも付けを持たないことがある
              const r = t.refs as { requirement?: string | null; screens?: string[]; design?: string[]; modes?: Record<string, string>; adoptedPr?: number; issue?: number; designSystem?: boolean };
              const modes = r.modes ?? {};
              const scr = (r.screens ?? []).map((k) => d.screens.find((s) => s.key === k)?.name ?? k);
              const origin = [r.adoptedPr ? `PR #${r.adoptedPr} を引き継ぎ` : "", r.issue ? `Issue #${r.issue}` : "", r.designSystem ? "デザインシステムの土台" : ""].filter(Boolean).join("・");
              return (
                <tr key={t.number}>
                  <td>#{t.number}</td>
                  <td>
                    {t.title}
                    {origin && <div className="hint">{origin}</div>}
                  </td>
                  <td>{r.requirement ?? "—"}</td>
                  <td>
                    {modes.screen === "skip" ? "省略" : scr.join("、") || "—"}
                    {scr.length ? mode[modes.screen ?? "agree"] : ""}
                  </td>
                  <td>{modes.model === "skip" ? "省略" : (r.design ?? []).join("、") || "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

type DS = NonNullable<StudioView["designSystem"]>;

/** デザインシステム(ADR-0034): 方針・トークン(色見本)・部品の見本。部品はトークンの CSS 変数で描く。 */
function DesignSystemPanel({ ds }: { ds: DS }) {
  const css = `:root{${ds.tokens.map((t) => `${t.name}:${t.value};`).join("")}}body{margin:12px;font-family:system-ui,sans-serif}`;
  return (
    <details className="dspanel">
      <summary>
        デザインシステム(トークン {ds.tokens.length}・部品 {ds.components.length})— 開発チームとの共通の決まり
      </summary>
      {ds.principles.length > 0 && (
        <ul className="ds-principles">
          {ds.principles.map((x, i) => (
            <li key={i}>{x}</li>
          ))}
        </ul>
      )}
      <div className="ds-tokens">
        {ds.tokens.map((t) => (
          <div key={t.name} className="ds-token" title={t.use}>
            {t.group === "color" ? <span className="sw" style={{ background: t.value }} /> : <span className="sw grp">{t.group}</span>}
            <code>{t.name}</code>
            <span className="v">{t.value}</span>
          </div>
        ))}
      </div>
      <div className="ds-comps">
        {ds.components.map((c) => (
          <figure key={c.name}>
            <figcaption>
              <b>{c.name}</b> <span className="hint">{c.use}(状態: {c.states.join("・")})</span>
            </figcaption>
            <iframe title={`部品 ${c.name}`} sandbox="" srcDoc={`<!doctype html><meta charset="utf-8"><style>${css}</style>${c.html}`} />
          </figure>
        ))}
      </div>
    </details>
  );
}
