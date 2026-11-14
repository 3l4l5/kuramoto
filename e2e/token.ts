/**
 * E2E の合言葉(ADR-0059)。Kuramoto 本体は localhost からも合言葉を求めるので、
 * テスト用のサーバー(e2e/server.ts)にこの合言葉を渡し、Playwright は Authorization: Bearer で渡す(playwright.config.ts)。
 * テストの中だけの値で、本物の合言葉(~/.kuramoto/access-token)とは関係ない。
 */
export const E2E_TOKEN = "e2e-access-token";
