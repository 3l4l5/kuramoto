/**
 * デジタル庁デザインシステム(https://design.digital.go.jp/dads/)のトークンを Tailwind CSS で使う。
 * 部品は公式のコードスニペット(React 版)を ui/src/dads/ に写して使う(それが前提にしている v1 のプラグイン)。
 * @type {import('tailwindcss').Config}
 */
module.exports = {
  content: { relative: true, files: ["./index.html", "./src/**/*.{ts,tsx}"] },
  theme: { extend: {} },
  plugins: [require("@digital-go-jp/tailwind-theme-plugin")],
};
