import tseslint from "typescript-eslint";

/**
 * await の付け忘れ(Promise を捨てる・Promise のまま使う)を見つけるためだけの lint。
 * DB を async に移したあと、await を忘れると書き込みが黙って落ちる(型では気づけない)ため。
 */
export default tseslint.config(
  { ignores: ["node_modules/**", "dist/**", "ui/**", "mock/**", "**/*.js", "**/*.mjs"] },
  {
    files: ["src/**/*.ts", "scripts/**/*.ts", "e2e/**/*.ts"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { project: "./tsconfig.lint.json", tsconfigRootDir: import.meta.dirname },
    },
    plugins: { "@typescript-eslint": tseslint.plugin },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/await-thenable": "error",
    },
  },
);
