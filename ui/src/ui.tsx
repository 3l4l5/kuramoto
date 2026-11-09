import type { ComponentProps, ReactNode } from "react";
import { Button, type ButtonSize, type ButtonVariant } from "./dads/Button";

/**
 * デジタル庁デザインシステムの部品(ui/src/dads/)を、Kuramoto の画面で使いやすくする薄い包み。
 * - 主な操作は solid-fill、それ以外は outline、軽い操作は text。
 * - 押せないときは disabled と aria-disabled の両方を付ける(デザインシステムの見た目は aria-disabled で決まる)。
 */
export type BtnProps = Omit<ComponentProps<"button">, "type"> & {
  kind?: ButtonVariant;
  size?: ButtonSize;
  type?: "button" | "submit";
  children: ReactNode;
};

export function Btn({ kind = "outline", size = "md", disabled, type = "button", ...rest }: BtnProps) {
  return <Button type={type} variant={kind} size={size} disabled={disabled} aria-disabled={disabled || undefined} {...rest} />;
}

/** リンクをボタンの見た目で出す(ダウンロードなど)。 */
export function LinkBtn({ kind = "outline", size = "md", ...rest }: ComponentProps<"a"> & { kind?: ButtonVariant; size?: ButtonSize }) {
  return (
    <Button asChild variant={kind} size={size}>
      <a {...rest} />
    </Button>
  );
}
