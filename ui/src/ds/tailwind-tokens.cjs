/**
 * tokens.css の CSS 変数から Tailwind の theme.extend を作る(値は持たず var(--x) を指すだけ)。
 * 例: bg-ds-dev-soft / text-ds-warn-ink / p-ds-3 / rounded-ds-md / shadow-ds / h-ds-control / text-ds-sm / font-ds-bold
 */
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

const css = readFileSync(join(__dirname, "tokens.css"), "utf8");
const names = [...css.matchAll(/^\s*(--[\w-]+):/gm)].map((m) => m[1].slice(2));
const pick = (prefix, rename = (n) => n.slice(prefix.length)) =>
  Object.fromEntries(names.filter((n) => n.startsWith(prefix)).map((n) => [`ds-${rename(n)}`, `var(--${n})`]));
const isColor = (n) => !/^(f|fs|fw|lh|sp|r|shadow|h|switch|motion)(-|$)/.test(n);

module.exports = {
  colors: Object.fromEntries(names.filter(isColor).map((n) => [`ds-${n}`, `var(--${n})`])),
  fontFamily: { "ds-body": "var(--f-body)", "ds-mono": "var(--f-mono)" },
  fontSize: pick("fs-"),
  fontWeight: pick("fw-"),
  lineHeight: pick("lh-"),
  spacing: { ...pick("sp-"), ...pick("h-") },
  borderRadius: pick("r-"),
  boxShadow: { ds: "var(--shadow)", "ds-desk": "var(--shadow-desk)" },
};
