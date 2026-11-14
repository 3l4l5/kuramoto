import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { DATABASE_URL_ENV } from "../db/env.js";
import type { Role } from "../domain/roles.js";
import type { Confinement } from "../harness/types.js";
import { kuramotoHome, kuramotoPort } from "../hq.js";
import { DESIGN_DIR } from "./design.js";
import { parsePorts } from "./local-ports.js";
import type { Project } from "./project.js";
import type { PreparedWorkspace } from "./workspace.js";

/**
 * エージェントを作業場所(worktree)に閉じ込める(ADR-0020)。
 * - ファイルの道具は作業場所の外を読み書きできない(ハーネスの設定)
 * - シェルは Kuramoto のデータ(DB・ほかのチケットの worktree)と認証情報を読めない
 * - git の本体だけは開ける(worktree の git 操作に要る)。書けるのは開発だけ
 * - push と PR は Kuramoto が外で行うので、エージェントに GitHub の認証は渡さない
 */

/** 既定で通信してよいドメイン。GitHub(読むだけ。認証は渡さない)と主なパッケージの取得先。 */
export const DEFAULT_ALLOWED_DOMAINS = [
  "github.com",
  "*.github.com",
  "*.githubusercontent.com",
  "registry.npmjs.org",
  "*.npmjs.org",
  "registry.yarnpkg.com",
  "pypi.org",
  "files.pythonhosted.org",
  "proxy.golang.org",
  "sum.golang.org",
  "crates.io",
  "*.crates.io",
  "rubygems.org",
];

/** シェルから読ませない、ホームの下の認証情報など。.docker は Docker のソケット(コンテナで閉じ込めの外に出られる)も含む。 */
const HIDDEN_IN_HOME = [".ssh", ".config/gh", ".aws", ".gnupg", ".netrc", ".docker", ".claude", ".config/gcloud", ".kube"];

/** シェルに渡さない環境変数。SSH_AUTH_SOCK・DOCKER_HOST は、ソケットを許したときの抜け道になるので隠す。 */
const HIDDEN_ENV = [
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "ANTHROPIC_API_KEY",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "SSH_AUTH_SOCK",
  "DOCKER_HOST",
  // MySQL の接続先(パスワードを含みうる)。閉じ込めの中へは渡さない(ADR-0041)
  DATABASE_URL_ENV,
];

/**
 * シェルから書いてよい、ホームの下のツールの置き場所(キャッシュ・ツールチェーン)。
 * 書けないと、npm のキャッシュ・mise の状態・Playwright のブラウザなどが動かず、テストを確かめられない。
 */
const WRITABLE_IN_HOME = [".npm", ".cache", ".local/state/mise", ".local/share/mise", "Library/Caches", "Library/pnpm", ".pnpm-store", ".yarn"];

/**
 * シェルから読んでよい、ホームの下のツールチェーンと設定。
 * 作業場所の外を読ませない設定はシェルにも効くので、ここに無いホームの下の場所は読めない(node も起動できない)。
 * ~/.npmrc など認証情報が入りうるものは入れない。
 */
const READABLE_IN_HOME = [
  ".local/share/mise",
  ".config/mise",
  ".local/bin",
  ".nix-profile",
  ".gitconfig",
  ".config/git",
  ".cargo",
  ".rustup",
  "go",
  ".bun",
  ".deno",
  ".volta",
  ".nvm",
  ".pyenv",
  ".rbenv",
];

/** パスが base の中(または同じ)か。 */
function inside(path: string, base: string): boolean {
  const r = relative(base, path);
  return r === "" || (!r.startsWith("..") && !isAbsolute(r));
}

/** プロジェクトの設定 sandbox_allowed_domains(改行・カンマ区切り)で足したドメイン。 */
export async function extraAllowedDomains(p: Project): Promise<string[]> {
  return (await p.setting("sandbox_allowed_domains") ?? "")
    .split(/[\s,]+/)
    .map((d) => d.trim())
    .filter(Boolean);
}

/** プロジェクトの設定 sandbox_allow_write(改行・カンマ区切りの絶対パス)で足した、書いてよい場所。 */
export async function extraWritable(p: Project): Promise<string[]> {
  return (await p.setting("sandbox_allow_write") ?? "")
    .split(/[\n,]+/)
    .map((d) => d.trim())
    .filter((d) => d.startsWith("/"));
}

export async function confinementFor(p: Project, ws: PreparedWorkspace, role: Role): Promise<Confinement> {
  const real = (path: string) => (existsSync(path) ? realpathSync(path) : path);
  const home = homedir();
  const tools = WRITABLE_IN_HOME.map((x) => join(home, x));
  const hidden = [real(kuramotoHome()), ...HIDDEN_IN_HOME.map((x) => join(home, x))];
  // PATH のうちホームの下にある場所(ツールの置き場所)も読めるようにする。隠す場所の中は入れない
  const pathDirs = (process.env.PATH ?? "").split(":").filter((d) => d.startsWith(`${home}/`));
  const readable = [...new Set([ws.gitDir, ...READABLE_IN_HOME.map((x) => join(home, x)), ...pathDirs])].filter((d) => !hidden.some((h) => inside(d, h)));
  return {
    readable,
    // git の本体に書けるのは開発だけ。ツールの置き場所は、テストを動かすどの役割でも書ける
    writable: [...(role === "dev" ? [ws.gitDir] : []), ...tools, ...await extraWritable(p)],
    hidden,
    allowedDomains: [...new Set([...DEFAULT_ALLOWED_DOMAINS, ...await extraAllowedDomains(p)])],
    hiddenEnv: HIDDEN_ENV,
    // 設定 sandbox_strict_sockets を 1 にすると、ソケットを閉じる(ブラウザでの確かめ・e2e は動かなくなる)
    allowLocalSockets: await p.setting("sandbox_strict_sockets") !== "1",
    // ソケットを許していても、Kuramoto 本体のポート(API。localhost からは合言葉なしで書き込める)と、設定 sandbox_deny_local_ports で足したポートには、届かせない(チームの CI の閉じ込め。ADR-0059)
    deniedLocalPorts: [...new Set([kuramotoPort(), ...parsePorts(await p.setting("sandbox_deny_local_ports"))])],
    // mise は知らない場所の設定ファイルを信用しないので、作業場所の設定を信用させる(node などの版を選べるように)
    // 合意した試作(HTML・お手本の画像)の場所。e2e などが読む(ADR-0034)
    env: { MISE_TRUSTED_CONFIG_PATHS: ws.path, MISE_YES: "1", KURAMOTO_DESIGN_DIR: join(ws.path, DESIGN_DIR) },
  };
}
