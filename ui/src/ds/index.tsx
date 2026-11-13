/**
 * デザインシステムの共通の部品。見た目は ds.css(トークンだけを使う)にまとめ、ここは形と状態だけを持つ。
 * 画面からは `import { Button, Chip, ... } from "./ds"` で使う。見本は開発のときだけ開ける /_design にある。
 */
import { useId, type ButtonHTMLAttributes, type CSSProperties, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";
import "./ds.css";

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");

// ---- ボタン ----
export type ButtonVariant = "primary" | "secondary" | "text";
export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  /** primary = 主(--action の地)、secondary = 副(白地に枠)、text = 文字だけ。押せないは disabled */
  variant?: ButtonVariant;
  /** sm は行の中の小さなボタン(--h-control-sm) */
  size?: "md" | "sm";
};
export function Button({ variant = "secondary", size = "md", className, type = "button", ...rest }: ButtonProps) {
  return <button type={type} className={cx("ds-btn", `ds-btn--${variant}`, size === "sm" && "ds-btn--sm", className)} {...rest} />;
}

// ---- 入力欄 ----
export type TextFieldProps = Omit<InputHTMLAttributes<HTMLInputElement>, "size"> & {
  label: ReactNode;
  /** 下に出す補足 */
  hint?: ReactNode;
  /** あるとエラーの見た目になり、ヒントの代わりに出す */
  error?: ReactNode;
};
export function TextField({ label, hint, error, id, className, style, ...rest }: TextFieldProps) {
  const auto = useId();
  const inputId = id ?? auto;
  const noteId = `${inputId}-note`;
  const note = error ?? hint;
  return (
    <div className={cx("ds-field", className)} style={style}>
      <label className="ds-field__label" htmlFor={inputId}>{label}</label>
      <input
        id={inputId}
        className="ds-input"
        aria-invalid={error ? true : undefined}
        aria-describedby={note ? noteId : undefined}
        {...rest}
      />
      {note && <span id={noteId} className={error ? "ds-field__error" : "ds-field__hint"}>{note}</span>}
    </div>
  );
}

// 画面の中でラベルを別に置く入力欄(TextField はラベルごと包むので、フォームの行に合わせるときはこちらを使う)。
// md は --h-control、sm は行の中の小さな欄(--h-control-sm)。invalid は枠が --danger になる。
type ControlProps = { size?: "md" | "sm"; invalid?: boolean };
const control = (base: string, size: "md" | "sm", invalid: boolean | undefined, className: string | undefined) => ({
  className: cx("ds-input", base, size === "sm" && "ds-input--sm", className),
  "aria-invalid": invalid ? (true as const) : undefined,
});

export function Input({ size = "md", invalid, className, ...rest }: Omit<InputHTMLAttributes<HTMLInputElement>, "size"> & ControlProps) {
  return <input {...control("", size, invalid, className)} {...rest} />;
}
export function Select({ size = "md", invalid, className, ...rest }: Omit<SelectHTMLAttributes<HTMLSelectElement>, "size"> & ControlProps) {
  return <select {...control("ds-select", size, invalid, className)} {...rest} />;
}
export function Textarea({ invalid, className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean }) {
  return <textarea {...control("ds-textarea", "md", invalid, className)} {...rest} />;
}

// ---- チェックボックス ----
export function Checkbox({ children, invalid, ...rest }: Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "size"> & { invalid?: boolean }) {
  const box = <input type="checkbox" className="ds-check__box" aria-invalid={invalid ? true : undefined} {...rest} />;
  return children ? <label className="ds-check">{box}<span>{children}</span></label> : box;
}

// ---- 切り替え(セグメント) ----
export type SegmentOption<T extends string> = { value: T; label: ReactNode; disabled?: boolean };
export function Segmented<T extends string>({ options, value, onChange, label, className }: {
  options: SegmentOption<T>[];
  value: T;
  onChange: (v: T) => void;
  /** 読み上げ用の名前 */
  label: string;
  className?: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className={cx("ds-seg", className)}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          disabled={o.disabled}
          className="ds-seg__opt"
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

// ---- スイッチ ----
export function Switch({ checked, onChange, children, disabled, label, title }: {
  checked: boolean;
  onChange: (v: boolean) => void;
  /** 横に出す文字(省くと「有効 / 無効」。null なら出さない) */
  children?: ReactNode;
  disabled?: boolean;
  /** 横の文字が無いときの読み上げ用の名前 */
  label?: string;
  title?: string;
}) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} title={title} disabled={disabled} className="ds-switch" onClick={() => onChange(!checked)}>
      <span className="ds-switch__track"><span className="ds-switch__knob" /></span>
      {children === undefined ? (checked ? "有効" : "無効") : children}
    </button>
  );
}

// ---- チップ ----
export type ChipTone = "default" | "warn" | "danger" | "ok" | "review" | "neutral" | "version";
export function Chip({ tone = "default", children, className, title }: { tone?: ChipTone; children: ReactNode; className?: string; title?: string }) {
  return <span title={title} className={cx("ds-chip", tone !== "default" && `ds-chip--${tone}`, className)}>{children}</span>;
}

// ---- 引き出し ----
export type DrawerTab<K extends string> = {
  key: K;
  label: ReactNode;
  /** まだ保存していない変更の数(0 か省くと出さない) */
  count?: number;
  /** 決まりに反しているときの赤い印 */
  error?: boolean;
};
export function Drawer<K extends string>({ title, version, onClose, tabs, activeTab, onTabChange, footer, children, className, style }: {
  title: ReactNode;
  /** 見出しの横の版(例 "v12") */
  version?: string;
  onClose?: () => void;
  tabs?: DrawerTab<K>[];
  activeTab?: K;
  onTabChange?: (k: K) => void;
  footer?: ReactNode;
  children?: ReactNode;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <section className={cx("ds-drawer", className)} style={style}>
      <header className="ds-drawer__head">
        <h2 className="ds-drawer__title">
          {title} {version && <span className="ds-drawer__version">{version}</span>}
        </h2>
        {onClose && <button type="button" className="ds-drawer__close" aria-label="閉じる" onClick={onClose}>×</button>}
      </header>
      {tabs && (
        <nav className="ds-drawer__tabs" role="tablist">
          {tabs.map((t) => (
            <button key={t.key} type="button" role="tab" aria-selected={t.key === activeTab} className="ds-drawer__tab" onClick={() => onTabChange?.(t.key)}>
              {t.label}
              {t.error ? <span className="ds-drawer__badge ds-drawer__badge--error" aria-label="決まりに反しています">!</span>
                : t.count ? <span className="ds-drawer__badge" aria-label={`保存していない変更 ${t.count}`}>{t.count}</span> : null}
            </button>
          ))}
        </nav>
      )}
      <div className="ds-drawer__body">{children}</div>
      {footer && <footer className="ds-drawer__foot">{footer}</footer>}
    </section>
  );
}

// ---- 節の小見出し ----
export function SectionHeading({ children }: { children: ReactNode }) {
  return <p className="ds-section-heading">{children}</p>;
}

// ---- 一覧 ----
export function List({ children, className, label }: { children: ReactNode; className?: string; label?: string }) {
  return <ul className={cx("ds-list", className)} aria-label={label}>{children}</ul>;
}
export function ListItem({ title, meta, selected, disabled, onClick }: {
  title: ReactNode;
  /** 右の補足 */
  meta?: ReactNode;
  selected?: boolean;
  disabled?: boolean;
  onClick?: () => void;
}) {
  const clickable = !!onClick && !disabled;
  return (
    <li
      className={cx("ds-list__item", clickable && "ds-list__item--button")}
      aria-selected={selected || undefined}
      aria-disabled={disabled || undefined}
      tabIndex={clickable ? 0 : undefined}
      onClick={clickable ? onClick : undefined}
      onKeyDown={clickable ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onClick(); } } : undefined}
    >
      <span className="ds-list__main">{title}</span>
      {meta != null && <span className="ds-list__meta">{meta}</span>}
    </li>
  );
}

// ---- 知らせ ----
export function Notice({ tone, title, children }: { tone: "danger" | "warn" | "ok"; title?: ReactNode; children: ReactNode }) {
  return (
    <div role={tone === "danger" ? "alert" : "status"} className={cx("ds-notice", tone !== "danger" && `ds-notice--${tone}`)}>
      {title && <><b>{title}</b>: </>}
      {children}
    </div>
  );
}

// ---- 吹き出しとアバター ----
export type Cloth = "dev" | "review" | "lead" | "design" | "ok";
export function Avatar({ cloth = "dev", hair = "light" }: { cloth?: Cloth; hair?: "light" | "dark" }) {
  return (
    <span className={cx("ds-avatar", cloth !== "dev" && `ds-avatar--${cloth}`, hair === "dark" && "ds-avatar--dark-hair")} aria-hidden="true">
      <span className="ds-avatar__head" />
      <span className="ds-avatar__body" />
    </span>
  );
}
export function Bubble({ idle, children }: { idle?: boolean; children: ReactNode }) {
  return <span className={cx("ds-bubble", idle && "ds-bubble--idle")}>{children}</span>;
}
/** 吹き出しを頭の上に載せたメンバー。idle で手すき(付箋色の吹き出し) */
export function Member({ bubble, idle, cloth, hair, width = 120 }: { bubble?: ReactNode; idle?: boolean; cloth?: Cloth; hair?: "light" | "dark"; width?: number }) {
  return (
    <span className="ds-member ds-art" style={{ width }}>
      {bubble != null && <Bubble idle={idle}>{bubble}</Bubble>}
      <Avatar cloth={cloth} hair={hair} />
    </span>
  );
}

// ---- 机 ----
export function Desk({ children, width = 320, onClick, label }: { children?: ReactNode; width?: number; onClick?: () => void; label?: string }) {
  const inner = (
    <>
      <span className="ds-desk__mug" />
      {children}
      <span className="ds-desk__plant" />
    </>
  );
  return onClick
    ? <button type="button" className="ds-desk ds-art" style={{ width }} aria-label={label} onClick={onClick}>{inner}</button>
    : <div className="ds-desk ds-art" style={{ width }}>{inner}</div>;
}
export function DeskPaper({ children }: { children: ReactNode }) {
  return <span className="ds-desk__paper">{children}</span>;
}
