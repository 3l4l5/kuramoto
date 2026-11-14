import type { ComponentProps, ReactNode } from "react";
import { Button, type ButtonVariant } from "./ds";

/**
 * 画面で使うボタン。見た目はデザインシステムの共通の部品(ui/src/ds/)で、色・大きさはトークンだけで決まる。
 * - 主な操作(保存・作成)は solid-fill = --action(ほぼ黒)、それ以外は outline(副)、軽い操作は text(リンクの青)。
 * - 青は開発の島・リンク・選択の印だけに使う。主ボタンには使わない。
 */
export type BtnKind = "solid-fill" | "outline" | "text";
export type BtnSize = "lg" | "md" | "sm" | "xs";
export type BtnProps = Omit<ComponentProps<"button">, "type"> & {
  kind?: BtnKind;
  size?: BtnSize;
  type?: "button" | "submit";
  children: ReactNode;
};

const VARIANT: Record<BtnKind, ButtonVariant> = { "solid-fill": "primary", outline: "secondary", text: "text" };
/** 行の中の小さなボタン(sm・xs)は --h-control-sm、それ以外は --h-control */
const small = (size: BtnSize) => size === "sm" || size === "xs";

export function Btn({ kind = "outline", size = "md", type = "button", ...rest }: BtnProps) {
  return <Button type={type} variant={VARIANT[kind]} size={small(size) ? "sm" : "md"} {...rest} />;
}

