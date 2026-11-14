/**
 * E2E が使うブラウザ。playwright.config.ts と、npm test の E2E の回の「ブラウザに繋がるか」の確かめ(scripts/run-tests.ts)で同じものを使う。
 */
export const BROWSER_CHANNEL = "chrome";

/**
 * ブラウザサーバー(Playwright の launchServer)の wsEndpoint。チームの CI は、ブラウザ専用の狭い閉じ込めの中でブラウザを立て、この環境変数で npm test に渡す(src/project/confined-browser.ts)。
 * 渡されたら、Chrome は起動せずに connect する。渡されたときは、ブラウザに繋がらないことも失敗にする。
 * 手元で自分のブラウザサーバーを使うときも同じ(npx playwright run-server など)。
 */
export const E2E_WS_ENDPOINT_ENV = "KURAMOTO_E2E_WS_ENDPOINT";
