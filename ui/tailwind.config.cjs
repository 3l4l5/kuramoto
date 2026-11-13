/**
 * デジタル庁デザインシステム(https://design.digital.go.jp/dads/)のトークンを Tailwind CSS で使う。
 * 部品は ui/src/ds/ の自前の部品(トークンだけを使う)。Tailwind は配置のクラス(w-full など)に使う。
 * @type {import('tailwindcss').Config}
 */
module.exports = {
  content: { relative: true, files: ["./index.html", "./src/**/*.{ts,tsx}"] },
  // デザインシステムのトークン(ui/src/ds/tokens.css の CSS 変数)を Tailwind からも使えるようにする。
  // 既存の画面の見た目を変えないよう、Tailwind の既定の名前(rounded-md など)は上書きせず ds- を付ける。
  theme: { extend: require("./src/ds/tailwind-tokens.cjs") },
  plugins: [require("@digital-go-jp/tailwind-theme-plugin")],
};
