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

/** 作るブランチの名前の頭の既定。チケット #12 なら kuramoto/12。 */
export const DEFAULT_BRANCH_PREFIX = "kuramoto/";

/**
 * 開発が作るブランチの名前の頭(プロジェクトで 1 つ。設定の branch_prefix)。頭のあとにチケットの番号(Jira のキーがあればそれ)が付く。
 * 決めていなければ kuramoto/。作ったあとのブランチの名前は変えない(作業の記録と PR が持っている)。
 */
export function branchPrefixOf(p: Project): string {
  return p.setting("branch_prefix")?.trim() || DEFAULT_BRANCH_PREFIX;
}

/** 空なら既定(kuramoto/)に戻す。頭に番号を付けたものが git のブランチ名にならなければ断る。 */
export function setBranchPrefix(p: Project, prefix: string): void {
  const v = prefix.trim();
  if (v && !branchPrefixOk(v)) throw new Error(`ブランチの名前の頭「${v}」は、番号を付けても git のブランチ名として使えません`);
  p.setSetting("branch_prefix", v);
}

export function branchPrefixOk(prefix: string): boolean {
  return branchNameOk(`${prefix}1`);
}

/** git check-ref-format の主な決まり(空白・制御文字・~^:?*[\ を含まない、.. や @{ を含まない、/ や . で始まり終わらない、.lock で終わらない)。 */
export function branchNameOk(s: string): boolean {
  if (!s || s === "@" || s.startsWith("-")) return false;
  if (/[\s~^:?*[\\\x00-\x1f\x7f]/.test(s)) return false;
  if (s.includes("..") || s.includes("@{") || s.includes("//")) return false;
  if (s.startsWith("/") || s.endsWith("/") || s.endsWith(".") || s.endsWith(".lock")) return false;
  return s.split("/").every((part) => part && !part.startsWith("."));
}
