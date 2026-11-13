import type { ProjectView } from "./api";
import { TicketLink } from "./Ticket";
import { KindChip, PRE_DEV_LABEL } from "./kind";

/**
 * ツリー: どのチケットが、どのチケットを待って止まっているかを木で見せる。
 * 根は「自分は何も待っていないが、誰かに待たれている」チケット。その下に、それを待っているチケットがぶら下がる。
 * 待つ理由は 2 つ: リーダーが決めた順番(先に終わらせるチケット)と、同じ場所を触るチケット(ADR-0024)。
 * 誰にも待たれていない・何も待っていないチケットは、下にまとめて並べる。
 */

type T = ProjectView["tickets"][number];

const STAGE: Record<string, string> = { dev: "開発", review: "レビュー", sec: "セキュリティ", qa: "QA", decision: "判断待ち", merge: "merge 待ち" };

export function TicketTree({ d }: { d: ProjectView }) {
  const open = d.tickets.filter((t) => t.stage !== "done" && t.stage !== "dropped");
  const byNumber = new Map(open.map((t) => [t.number, t]));
  const ownerDecision = new Set(d.decisions.map((x) => x.ticket.id));

  // 待っている側 → 待たれている側。理由は「順番」か「同じ場所」
  const parents = new Map<number, { n: number; why: string }[]>();
  const children = new Map<number, { n: number; why: string }[]>();
  for (const t of open) {
    const ps = [
      ...t.waitFor.map((n) => ({ n, why: "リーダーが決めた順番" })),
      ...t.waitArea.map((w) => ({ n: w.number, why: `同じ場所: ${w.areas.join("・")}` })),
    ].filter((p) => byNumber.has(p.n));
    parents.set(t.number, ps);
    for (const p of ps) children.set(p.n, [...(children.get(p.n) ?? []), { n: t.number, why: p.why }]);
  }
  const count = (n: number, seen = new Set<number>()): number => {
    for (const c of children.get(n) ?? []) if (!seen.has(c.n)) (seen.add(c.n), count(c.n, seen));
    return seen.size;
  };
  // 根: 何も待っていないのに、誰かに待たれているもの。止めている数の多い順
  const roots = open
    .filter((t) => !(parents.get(t.number) ?? []).length && (children.get(t.number) ?? []).length)
    .sort((a, b) => count(b.number) - count(a.number) || a.number - b.number);
  const alone = open.filter((t) => !(parents.get(t.number) ?? []).length && !(children.get(t.number) ?? []).length);
  const stuck = open.filter((t) => (parents.get(t.number) ?? []).length).length;

  const state = (t: T): { text: string; tone: "work" | "you" | "wait" | "idle" | "blocked" } => {
    // 開発ルールの「直すまで進めない」で止まっている(R15)
    if (t.ruleBlocked.length > 0) return { text: "ルール違反で止まっている", tone: "blocked" };
    if (t.worker) return { text: `${t.worker.name} が${t.worker.role}中`, tone: "work" };
    if (t.triaging) return { text: "リーダーが交通整理中", tone: "wait" };
    if (t.stage === "decision") return ownerDecision.has(t.id) ? { text: "あなたの判断待ち", tone: "you" } : { text: "リーダーの判断待ち", tone: "wait" };
    if (t.stage === "merge") return d.autoMerge ? { text: "merge 待ち(チームが merge します)", tone: "wait" } : { text: "merge 待ち(あなたが merge を押す)", tone: "you" };
    if ((parents.get(t.number) ?? []).length) return { text: "待っています", tone: "wait" };
    if (t.stage === "dev" && !t.started) return { text: "未着手・手が空くのを待っています", tone: "idle" };
    return { text: `${STAGE[t.stage] ?? t.stage}・手が空くのを待っています`, tone: "idle" };
  };

  const Node = ({ t, why, path }: { t: T; why?: string; path: number[] }) => {
    const s = state(t);
    const kids = (children.get(t.number) ?? []).filter((c) => !path.includes(c.n));
    const others = (parents.get(t.number) ?? []).filter((p) => p.n !== path.at(-1)).map((p) => p.n);
    const blocked = kids.length ? count(t.number) : 0;
    return (
      <li>
        <div className={`tr-node tr-${s.tone}`}>
          {why && <span className="tr-why">{why}</span>}
          <span className="tr-num">#{t.number}</span>
          <TicketLink id={t.id}>{t.title}</TicketLink>
          <KindChip kind={t.kind} label={t.kindLabel} />
          <span className="tr-stage">{STAGE[t.stage] ?? t.stage}</span>
          {t.preDev && <span className="tr-pre">{PRE_DEV_LABEL}</span>}
          <span className="tr-state">{s.text}</span>
          {t.ruleBlocked.length > 0 && <span className="tr-viol">「{t.ruleBlocked.join("」「")}」を直すまで進めません</span>}
          {others.length > 0 && <span className="tr-also">ほかに #{others.join("・#")} も待っています</span>}
          {blocked > 0 && <span className="tr-blocks">{blocked} 件がこれを待っています</span>}
        </div>
        {kids.length > 0 && (
          <ul>
            {kids.map((c) => (
              <Node key={c.n} t={byNumber.get(c.n)!} why={c.why} path={[...path, t.number]} />
            ))}
          </ul>
        )}
      </li>
    );
  };

  return (
    <div className="tree">
      <p className="hint">
        {stuck ? `${stuck} 件が、ほかのチケットを待って止まっています。上にあるチケットが進むと、下のチケットが動き出します。` : "ほかのチケットを待って止まっているものはありません。"}
      </p>
      {roots.length > 0 && (
        <section aria-label="待ちのつながり">
          <h3>待ちのつながり</h3>
          <ul className="tr-root">
            {roots.map((t) => (
              <Node key={t.id} t={t} path={[]} />
            ))}
          </ul>
        </section>
      )}
      <section aria-label="ほかのチケット">
        <h3>
          ほかのチケット <span className="hint">何も待っていない・誰にも待たれていない</span>
        </h3>
        {alone.length ? (
          <ul className="tr-root tr-flat">
            {alone.map((t) => (
              <Node key={t.id} t={t} path={[]} />
            ))}
          </ul>
        ) : (
          <p className="hint">ありません</p>
        )}
      </section>
    </div>
  );
}
