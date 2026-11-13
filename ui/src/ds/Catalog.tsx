/**
 * デザインシステムのカタログ(/_design)。開発のときだけ開ける(main.tsx が import.meta.env.DEV のときだけ読み込む)。
 * トークン・部品の全状態・企画で合意した各画面を並べる。
 */
import { useState, type ReactNode } from "react";
import tokensCss from "./tokens.css?raw";
import { Button, Chip, Desk, DeskPaper, Drawer, List, ListItem, Member, Notice, SectionHeading, Segmented, Switch, TextField } from ".";

type Token = { name: string; value: string; note: string };
export function parseTokens(css: string): Token[] {
  const root = css.slice(css.indexOf(":root {"), css.indexOf("}", css.indexOf(":root {")));
  return [...root.matchAll(/(--[\w-]+):\s*([^;]+);(?:\s*\/\*\s*(.*?)\s*\*\/)?/g)].map((m) => ({ name: m[1]!, value: m[2]!.trim(), note: m[3] ?? "" }));
}

/** 企画で合意した画面。画像と試作は作業場所の .kuramoto/design/ にあり、開発サーバーが /_design/screens/ で配る */
const SCREENS: [string, string][] = [
  ["formation-route", "編成「連絡経路」タブ"], ["formation-flow", "編成「流れ」タブ"], ["formation-islands", "編成「島」タブ"],
  ["dev-rules", "チームの方針「開発ルール」"], ["office", "オフィス"], ["board", "ボード"], ["ticket", "チケットの詳細"],
  ["tree", "ツリー"], ["metrics", "生産性"], ["phone-home", "スマホ: あなたの対応"], ["phone-office", "スマホ: オフィス"],
  ["phone-formation-flow", "スマホ: 編成「流れ」"], ["phone-board", "スマホ: ボード"], ["phone-ticket", "スマホ: チケットの詳細"],
  ["phone-dev-rules", "スマホ: 開発ルール"],
];

function Block({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <section className="ds-cat__block">
      <h2 className="ds-cat__h2">{title}</h2>
      {note && <p className="ds-cat__note">{note}</p>}
      <div className="ds-cat__sample">{children}</div>
    </section>
  );
}

function Tokens({ tokens }: { tokens: Token[] }) {
  const group = (p: RegExp) => tokens.filter((t) => p.test(t.name));
  const colors = group(/^--(?!f-|fs-|fw-|lh-|sp-|r-|shadow|h-|switch|motion)/);
  return (
    <>
      <Block title="色" note="淡い地の上の字は -ink の色を使う">
        <div className="ds-cat__swatches">
          {colors.map((t) => (
            <div key={t.name} className="ds-cat__swatch">
              <span className="ds-cat__chip" style={{ background: `var(${t.name})` }} />
              <code>{t.name}</code><span className="ds-cat__muted">{t.value}</span><span className="ds-cat__muted">{t.note}</span>
            </div>
          ))}
        </div>
      </Block>
      <Block title="文字">
        {group(/^--(f|fs|fw|lh)-/).map((t) => (
          <div key={t.name} className="ds-cat__row">
            <code>{t.name}: {t.value}</code>
            <span style={t.name.startsWith("--fs") ? { fontSize: `var(${t.name})` } : t.name.startsWith("--fw") ? { fontWeight: `var(${t.name})` as never } : t.name.startsWith("--f-") ? { fontFamily: `var(${t.name})` } : { lineHeight: `var(${t.name})` as never }}>
              チケット #42 を開発する
            </span>
            <span className="ds-cat__muted">{t.note}</span>
          </div>
        ))}
      </Block>
      <Block title="余白・角丸・影・高さ">
        {group(/^--(sp|r|shadow|h|switch|motion)/).map((t) => (
          <div key={t.name} className="ds-cat__row">
            <code>{t.name}: {t.value}</code>
            {t.name.startsWith("--sp") && <span className="ds-cat__bar" style={{ width: `var(${t.name})` }} />}
            {t.name.startsWith("--r-") && <span className="ds-cat__box" style={{ borderRadius: `var(${t.name})` }} />}
            {t.name.startsWith("--shadow") && <span className="ds-cat__box" style={{ boxShadow: `var(${t.name})` }} />}
            {(t.name.startsWith("--h-") || t.name.startsWith("--switch")) && <span className="ds-cat__bar" style={{ height: `var(${t.name})`, width: t.name === "--switch-w" ? `var(${t.name})` : undefined }} />}
            <span className="ds-cat__muted">{t.note}</span>
          </div>
        ))}
      </Block>
    </>
  );
}

function Components() {
  const [seg, setSeg] = useState<"must" | "skip">("must");
  const [on, setOn] = useState(true);
  const [off, setOff] = useState(false);
  const [tab, setTab] = useState<"island" | "route" | "flow">("island");
  return (
    <>
      <Block title="ボタン" note="主・主(ホバー)・副・文字だけ・押せない。小さいのは行の中で使う">
        <div className="ds-cat__line">
          <Button variant="primary">保存する</Button>
          <Button variant="primary" data-hover="">保存する</Button>
          <Button>ひな形から足す</Button>
          <Button variant="text">取り消す</Button>
          <Button variant="primary" disabled>保存する</Button>
        </div>
        <div className="ds-cat__line">
          <Button variant="primary" size="sm">足す</Button>
          <Button size="sm">ひな形</Button>
          <Button variant="text" size="sm">消す</Button>
          <Button size="sm" disabled>足した</Button>
        </div>
      </Block>
      <Block title="入力欄" note="ラベルは上、ヒントとエラーは下(通常・フォーカス・エラー)">
        <div className="ds-cat__line ds-cat__top">
          <TextField style={{ width: 220 }} label="名前" defaultValue="Jira 番号をそろえる" hint="一覧に出る名前" />
          <TextField style={{ width: 220 }} label="名前" defaultValue="Jira 番号" data-focus="" />
          <TextField style={{ width: 220 }} label="名前" defaultValue="" error="名前を入れてください" />
        </div>
      </Block>
      <Block title="切り替え(セグメント)" note="通常・選んでいる">
        <Segmented label="必須か" value={seg} onChange={setSeg} options={[{ value: "must", label: "必須" }, { value: "skip", label: "省略" }]} />
      </Block>
      <Block title="スイッチ" note="オン・オフ">
        <div className="ds-cat__line"><Switch checked={on} onChange={setOn} /><Switch checked={off} onChange={setOff} /></div>
      </Block>
      <Block title="チップ" note="既定・注意・エラー・完了・レビュー・版">
        <div className="ds-cat__line">
          <Chip>機能</Chip><Chip tone="warn">手戻り 2</Chip><Chip tone="danger">衝突</Chip><Chip tone="ok">自動で直した</Chip><Chip tone="review">レビュー</Chip><Chip tone="version">v12</Chip>
        </div>
      </Block>
      <Block title="引き出し" note="通常・タブあり(未保存の件数・決まりに反した印)">
        <div className="ds-cat__line ds-cat__top">
          <Drawer style={{ width: 400 }} title="編成" version="v12" onClose={() => {}} tabs={[{ key: "island", label: "島" }, { key: "route", label: "連絡経路" }, { key: "flow", label: "流れ" }]} activeTab={tab} onTabChange={setTab} footer={<Button variant="primary">保存して v13 にする</Button>}>中身</Drawer>
          <Drawer style={{ width: 400 }} title="編成" version="v12" onClose={() => {}} tabs={[{ key: "island", label: "島", count: 1 }, { key: "route", label: "連絡経路", count: 2 }, { key: "flow", label: "流れ", error: true }]} activeTab="flow" footer={<Button variant="primary" disabled>保存して v13 にする</Button>}>
            <Notice tone="danger" title="保存できません">merge 待ちの前に工程が 1 つもありません</Notice>
          </Drawer>
        </div>
      </Block>
      <Block title="節の小見出し" note="節どうしは --sp-5 空ける">
        <div style={{ width: 400 }}><SectionHeading>島どうし</SectionHeading><p style={{ margin: 0 }}>中身</p></div>
      </Block>
      <Block title="一覧" note="通常・選んでいる・無効">
        <List className="ds-cat__w400">
          <ListItem title="コミット 1 行目 50 字以内" meta="コミット" onClick={() => {}} />
          <ListItem title="Jira 番号をそろえる" meta="ブランチ名・PR タイトル" selected onClick={() => {}} />
          <ListItem title="マイグレーションは単独の PR" meta="無効" disabled />
        </List>
      </Block>
      <Block title="知らせ" note="エラー・注意・完了">
        <div className="ds-cat__col ds-cat__w400">
          <Notice tone="danger" title="保存できません">merge 待ちの前に工程が 1 つもありません</Notice>
          <Notice tone="warn">バグ修正は既定の流れを使います</Notice>
          <Notice tone="ok">この流れで保存できます</Notice>
        </div>
      </Block>
      <Block title="吹き出しとアバター" note="作業中・手すき">
        <div className="ds-cat__line ds-cat__members">
          <Member bubble="#42 実装中…" cloth="dev" />
          <Member bubble="♪ 手すき" idle cloth="review" hair="dark" />
        </div>
      </Block>
      <Block title="机(オフィスの絵)">
        <Desk><DeskPaper>#42 機能</DeskPaper></Desk>
      </Block>
    </>
  );
}

function Screens() {
  return (
    <div className="ds-cat__screens">
      {SCREENS.map(([key, name]) => (
        <figure key={key} className="ds-cat__screen">
          <figcaption><b>{name}</b> <code className="ds-cat__muted">{key}</code> <a href={`/_design/screens/${key}.html`} target="_blank" rel="noreferrer">試作を開く</a></figcaption>
          <img src={`/_design/screens/${key}.png`} alt={name} loading="lazy" />
        </figure>
      ))}
    </div>
  );
}

export function Catalog() {
  const tokens = parseTokens(tokensCss);
  return (
    <main className="ds-cat">
      <h1 className="ds-cat__h1">デザインシステム</h1>
      <p className="ds-cat__note">開発のときだけ開けるカタログ。値は ui/src/ds/tokens.css、部品は ui/src/ds/index.tsx。</p>
      <h2 className="ds-cat__part">トークン</h2>
      <Tokens tokens={tokens} />
      <h2 className="ds-cat__part">部品</h2>
      <Components />
      <h2 className="ds-cat__part">画面</h2>
      <Screens />
    </main>
  );
}
