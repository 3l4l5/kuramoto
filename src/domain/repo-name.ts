/**
 * owner/repo の形。GitHub の名前の決まりに合わせ、'.' や '..' だけの部分は断る。
 * データの置き場所は join(home, owner, repo) で決めるので、'.' / '..' を通すと home の外や owner ディレクトリそのものを指してしまう。
 */
export const REPO_RE = /^(?!\.{1,2}\/)(?!.*\/\.{1,2}$)[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export function isRepoFullName(s: string): boolean {
  return REPO_RE.test(s);
}
