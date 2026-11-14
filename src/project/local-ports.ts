/**
 * 閉じ込め(@anthropic-ai/sandbox-runtime)の中から、localhost の特定のポートに届かせない(ADR-0059)。
 *
 * sandbox-runtime は、localhost を「全部許す(allowLocalBinding)」か「全部閉じる」かしか選べない。
 * 全部閉じると、テストが自分で立てるサーバー(待ち受けのポートは毎回変わる)・E2E・mysql-test に届かなくなるので、
 * 許したまま、Kuramoto 本体のポートなど、届かせたくないポートだけを macOS の Seatbelt の規則で断る。
 * Seatbelt は、あとに書いた規則が先に勝つ。sandbox-runtime が書く「localhost の全ポートに接続してよい」の規則のすぐあとに、ポートごとの断りを足す。
 */

/** sandbox-runtime が書く、localhost の全ポートへの接続の許可。wrapWithSandbox が返すコマンドの中では、引用符が \" になることがある。 */
const LOCAL_OUTBOUND_ALLOW = /\(allow network-outbound \(remote ip (\\?")localhost:\*\\?"\)\)/g;

/**
 * wrapWithSandbox が返したコマンドに、localhost の指定のポートへの接続の断りを足す。
 * 許可の規則が見つからなければ(sandbox-runtime の版が変わって書き方が変わった)、断りを足せないので投げる。閉じ込めを緩めたまま流さない。
 */
export function denyLocalPorts(wrapped: string, ports: readonly number[]): string {
  const list = [...new Set(ports)].filter((p) => Number.isInteger(p) && p >= 1 && p <= 65535);
  if (!list.length) return wrapped;
  let found = 0;
  const out = wrapped.replace(LOCAL_OUTBOUND_ALLOW, (rule, q: string) => {
    found++;
    return `${rule} ${list.map((p) => `(deny network-outbound (remote ip ${q}localhost:${p}${q}))`).join(" ")}`;
  });
  if (!found) throw new Error(`閉じ込めの規則に、localhost のポート ${list.join("・")} を断る規則を足せませんでした(sandbox-runtime の規則の書き方が想定と違います)。閉じ込めを緩めたまま流さないので止めます`);
  return out;
}

/** プロジェクトの設定 sandbox_deny_local_ports(改行・カンマ・空白区切りのポート番号)の値を、ポートの並びにする。 */
export function parsePorts(value: string | null | undefined): number[] {
  return (value ?? "")
    .split(/[\s,]+/)
    .filter(Boolean)
    .map(Number)
    .filter((p) => Number.isInteger(p) && p >= 1 && p <= 65535);
}

/** Seatbelt の規則を足す必要があるか(macOS で、localhost を許していて、断るポートがあるとき)。Linux の閉じ込めは、ネットワークの名前空間が別なので、ホストの localhost には元から届かない。 */
export function needsLocalPortDeny(allowLocalSockets: boolean, ports: readonly number[] | undefined, platform: NodeJS.Platform = process.platform): boolean {
  return platform === "darwin" && allowLocalSockets && !!ports?.length;
}
