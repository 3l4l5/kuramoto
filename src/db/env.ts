/** MySQL の接続先を渡す環境変数。パスワードを含みうるので、閉じ込めの中へは渡さない(project/confine.ts・harness/claude-agent-sdk.ts)。 */
export const DATABASE_URL_ENV = "KURAMOTO_DATABASE_URL";
