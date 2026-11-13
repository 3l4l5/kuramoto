import type { Project } from "./project.js";

/**
 * リポジトリごとの merge 先(PR の向き先・差分の起点)のブランチ。
 * 設定に置く(base_branch:<owner/repo>)。空なら origin の既定のブランチ(origin/HEAD)を使う。
 */
export function baseBranchOf(p: Project, repo: string): string | undefined {
  return p.setting(`base_branch:${repo}`)?.trim() || undefined;
}

export function setBaseBranch(p: Project, repo: string, branch: string): void {
  const b = branch.trim();
  if (b && !branchNameOk(b)) throw new Error(`${repo} の merge 先のブランチ名「${b}」は、git のブランチ名として使えません`);
  p.setSetting(`base_branch:${repo}`, b);
}

/** git check-ref-format の主な決まり(空白・制御文字・~^:?*[\ を含まない、.. や @{ を含まない、/ や . で始まり終わらない、.lock で終わらない)。 */
export function branchNameOk(s: string): boolean {
  if (!s || s === "@" || s.startsWith("-")) return false;
  if (/[\s~^:?*[\\\x00-\x1f\x7f]/.test(s)) return false;
  if (s.includes("..") || s.includes("@{") || s.includes("//")) return false;
  if (s.startsWith("/") || s.endsWith("/") || s.endsWith(".") || s.endsWith(".lock")) return false;
  return s.split("/").every((part) => part && !part.startsWith("."));
}
