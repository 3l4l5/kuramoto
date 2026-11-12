import type { Project } from "./project.js";

/**
 * 担当の会話(ハーネスのセッション)を引き継ぐ回数の上限(ADR-0032)。
 * 引き継ぐと、起動のたびにそれまでの会話を丸ごと読み直すので、回数に比例して 1 回の額が増える
 * (実際の記録で、企画のアーキテクトは 1 回 $1 から $20 まで、開発は 6 回目に 10 倍になった)。
 * 同じ会話を引き継ぐのは session_max_resumes 回(既定 3)までにし、超えたら新しく始める。
 * 新しく始めても、要るもの(チケットの本文・メモ・指摘・企画の中身・最近の会話)は指示に入れて渡す。
 */
export function maxResumes(p: Project): number {
  return Math.max(0, p.settingNumber("session_max_resumes", 3));
}

/** その会話で、これまでに起こした回数(最初の起動を 1 とする)。 */
function uses(p: Project, sessionId: string): number {
  return p.settingNumber(`session_uses:${sessionId}`, 1);
}

/** この会話を引き継いでよいか。 */
export function canResume(p: Project, sessionId: string | null | undefined): sessionId is string {
  return !!sessionId && uses(p, sessionId) <= maxResumes(p);
}

/** 起動が終わった。新しい会話なら 1 回目、引き継いだなら回数を足して覚える。 */
export function noteSession(p: Project, sessionId: string | undefined, resumedFrom: string | undefined): void {
  if (!sessionId) return;
  p.setSetting(`session_uses:${sessionId}`, String(resumedFrom ? uses(p, resumedFrom) + 1 : 1));
}
