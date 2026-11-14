import type { Project } from "./project.js";

/**
 * チームが使うブランチ(作業の起点・PR の向き先・merge 済みの判定・main の CI の見張りの対象)。
 * プロジェクトの設定(settings 表の team_branch)に持つ。未設定(空)なら、各リポジトリの origin/HEAD(無ければ main)を使う。
 */
const KEY = "team_branch";

/** 文言に出すときの既定。未設定なら今までどおり main と書く。 */
export const DEFAULT_BRANCH_LABEL = "main";

/** 設定されたブランチ。未設定なら undefined。 */
export async function teamBranch(p: Project): Promise<string | undefined> {
  const v = (await p.setting(KEY))?.trim();
  return v ? v : undefined;
}

/** プロンプトやメッセージに書く名前(未設定なら main)。 */
export async function teamBranchLabel(p: Project): Promise<string> {
  return (await teamBranch(p)) ?? DEFAULT_BRANCH_LABEL;
}

/**
 * ブランチ名として安全か(git の refname の決まりのうち、よくある誤りと、コマンドの引数に化ける形を断る)。
 * 問題があればその理由。
 */
export function branchNameError(name: string): string | undefined {
  if (name.length > 200) return "ブランチ名が長すぎます";
  if (name.startsWith("-") || name.startsWith("/") || name.endsWith("/") || name.endsWith(".") || name.endsWith(".lock")) return `ブランチ名として使えません: ${name}`;
  if (/[\s~^:?*[\\\x00-\x1f\x7f]/.test(name) || name.includes("..") || name.includes("@{") || name.includes("//") || name === "@") return `ブランチ名として使えません: ${name}`;
  if (name.split("/").some((seg) => seg.startsWith(".") || seg.endsWith(".lock"))) return `ブランチ名として使えません: ${name}`;
  return undefined;
}

/** 空なら未設定に戻す(今どおり origin/HEAD → main)。 */
export async function setTeamBranch(p: Project, name: string): Promise<void> {
  const v = name.trim();
  if (v) {
    const err = branchNameError(v);
    if (err) throw new Error(err);
  }
  await p.setSetting(KEY, v);
}
