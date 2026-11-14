/**
 * ブラウザ専用の閉じ込め(confined-browser.ts)にだけ、Chromium が起動時に要る mach-register を 1 行だけ足す(#114)。
 *
 * macOS の Chromium は、起動時に Mach サービス名 org.chromium.Chromium.MachPortRendezvousServer.<pid> を登録する(bootstrap_check_in。seatbelt では mach-register)。
 * sandbox-runtime が作る macOS のプロファイルは `(deny default)` で、mach-register をどこでも許さず、設定で足せるのは mach-lookup だけ。
 * そのため、プロファイルの中では Chromium が「bootstrap_check_in ... Permission denied (1100)」で落ちる(GitHub の macOS ランナーで確かめた)。
 *
 * 2 行目(mach-lookup)は、あとから分かった: ブラウザの子プロセス(renderer・GPU)が、親が登録した同じ名前を引く(bootstrap_look_up)。
 * それが「deny(1) mach-lookup org.chromium.Chromium.MachPortRendezvousServer.<pid>」で断られ、ブラウザが起動直後に閉じて「newPage: ... has been closed」になった(macOS ランナーの deny のログで確かめた)。
 * sandbox-runtime の network.allowMachLookup は、全体の設定(npm test の閉じ込めと共通)にしか効かず、ブラウザ専用に分けられないので、同じ名前の前方一致だけを、同じ位置に足す。
 *
 * 足すのは、同じ名前(org.chromium.Chromium.MachPortRendezvousServer の前方一致)の mach-register と mach-lookup の 2 行だけ。ファイル・ネットワークや、ほかの Mach サービスの許可は広げない。~/.kuramoto・~/.ssh などを読めないことは変わらない。
 * npm test の閉じ込め(confine.ts)・担当のシェル・ほかの閉じ込めには足さない(ブラウザサーバーの閉じ込めだけ)。
 * 外す条件: sandbox-runtime が mach-register を設定できるようになったら、この書き換えをやめて設定に置き換える。
 */

/** 足す規則(Chromium の Mach ポートの受け渡しの名前だけ。名前の前方一致)。 */
export const CHROMIUM_MACH_REGISTER_NAME = "org.chromium.Chromium.MachPortRendezvousServer";

/** 規則を差し込む位置の目印(sandbox-runtime のプロファイルの先頭近くの、引用符を含まない 1 行)。 */
const ANCHOR = "(allow mach-priv-task-port (target same-sandbox))";
/** wrapWithSandbox が返すコマンドの中の引用符の形(" か \")を、プロファイルの中の名前の指定から読む。 */
const QUOTE = /\(global-name (\\?")com\.apple\.logd\\?"\)/;

/**
 * wrapWithSandbox が返したコマンドのプロファイルに、Chromium の mach-register・mach-lookup の許可を足す。
 * 差し込む位置が見つからなければ(sandbox-runtime の出力の形が変わった)、素のプロファイルでは流さず、投げて止める。
 */
export function allowChromiumMachRegister(wrapped: string): string {
  const q = QUOTE.exec(wrapped)?.[1];
  const at = wrapped.indexOf(ANCHOR);
  if (q === undefined || at < 0) {
    throw new Error("ブラウザ専用の閉じ込めに mach-register の許可を足せませんでした(sandbox-runtime のプロファイルの書き方が想定と違います)。Chrome は起動できないので、素のプロファイルでは流さず止めます");
  }
  const end = at + ANCHOR.length;
  const name = `${q}${CHROMIUM_MACH_REGISTER_NAME}${q}`;
  return `${wrapped.slice(0, end)}\n(allow mach-register (global-name-prefix ${name}))\n(allow mach-lookup (global-name-prefix ${name}))${wrapped.slice(end)}`;
}

/** mach-register の許可が要るか(macOS だけ。Linux の閉じ込めには Mach が無い)。 */
export const needsMachRegister = (platform: NodeJS.Platform = process.platform) => platform === "darwin";
