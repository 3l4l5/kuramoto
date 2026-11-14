import { spawnSync } from "node:child_process";

/**
 * この環境で、sandbox-runtime(macOS は sandbox-exec)で閉じ込められるか。試験が使う。
 * 閉じ込めの中(担当・レビューの作業場所や、チームの CI の `npm test`)からは、閉じ込めを重ねられない(sandbox_apply: Operation not permitted)ので false になる。
 * 閉じ込めの外の macOS では true。macOS 以外では false。
 */
export function canSandbox(): boolean {
  if (process.platform !== "darwin") return false;
  return spawnSync("/usr/bin/sandbox-exec", ["-p", "(version 1)(allow default)", "/usr/bin/true"]).status === 0;
}

/**
 * macOS で、閉じ込めの中(入れ子)にいるか。Chrome を起動する試験は、閉じ込めの中では起動できない(プロファイル・ソケット・Crashpad の置き場所が書けない。docs/e2e.md)ので、これで飛ばす。
 */
export function insideConfinement(): boolean {
  return process.platform === "darwin" && !canSandbox();
}
