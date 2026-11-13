/**
 * オフィスの登場人物の絵(ちびキャラ)。髪の色と髪型は人ごと、服の色は今している役割で変わる。
 * 手すきのときは目を閉じて居眠りする。髪の色・髪型は原作の雰囲気に寄せたもの。
 */
type Hair = "long" | "short" | "twin" | "pony" | "bob";
type Look = { hair: string; style: Hair; ribbon?: string; ahoge?: boolean };

const LOOKS: Record<string, Look> = {
  星南: { hair: "var(--art-hair-seina)", style: "long" },
  広: { hair: "var(--art-hair-hiro)", style: "long", ahoge: true },
  咲季: { hair: "var(--art-hair-saki)", style: "long", ribbon: "var(--art-ribbon-1)" },
  清夏: { hair: "var(--art-hair-sumika)", style: "pony" },
  手毬: { hair: "var(--art-hair-temari)", style: "pony" },
  ことね: { hair: "var(--art-hair-kotone)", style: "twin", ribbon: "var(--art-ribbon-2)" },
  麻央: { hair: "var(--art-hair-mao)", style: "short" },
  リーリヤ: { hair: "var(--art-hair-lilja)", style: "long", ribbon: "var(--art-ribbon-3)" },
  千奈: { hair: "var(--art-hair-china)", style: "long", ribbon: "var(--art-ribbon-4)" },
  莉波: { hair: "var(--art-hair-rinami)", style: "long" },
  佑芽: { hair: "var(--art-hair-ume)", style: "pony" },
  美鈴: { hair: "var(--art-hair-misuzu)", style: "bob" },
  春香: { hair: "var(--art-hair-haruka)", style: "bob", ribbon: "var(--art-ribbon-5)" },
  千早: { hair: "var(--art-hair-chihaya)", style: "long" },
  美希: { hair: "var(--art-hair-miki)", style: "long", ahoge: true },
  卯月: { hair: "var(--art-hair-uzuki)", style: "long" },
  凛: { hair: "var(--art-hair-rin)", style: "long" },
  未央: { hair: "var(--art-hair-mio)", style: "short" },
  未来: { hair: "var(--art-hair-miku)", style: "pony" },
  静香: { hair: "var(--art-hair-shizuka)", style: "long" },
  翼: { hair: "var(--art-hair-tsubasa)", style: "pony", ribbon: "var(--art-ribbon-6)" },
  真乃: { hair: "var(--art-hair-mano)", style: "bob" },
};
const DEFAULT: Look = { hair: "var(--art-hair-default)", style: "short" };

export function Avatar({ name, asleep, className }: { name: string; asleep?: boolean; className?: string }) {
  const l = LOOKS[name] ?? DEFAULT;
  const shade = `color-mix(in srgb, ${l.hair} 78%, var(--art-shade))`;
  return (
    <svg className={`of-avatar ${className ?? ""}`} viewBox="0 0 64 72" aria-hidden="true">
      {/* 後ろ髪 */}
      {l.style === "long" && <path d="M14 28 Q12 58 20 62 L44 62 Q52 58 50 28 Z" fill={shade} />}
      {l.style === "bob" && <path d="M14 26 Q12 46 20 46 L44 46 Q52 46 50 26 Z" fill={shade} />}
      {l.style === "twin" && (
        <>
          <path d="M14 22 Q2 30 6 52 Q12 46 16 34 Z" fill={l.hair} />
          <path d="M50 22 Q62 30 58 52 Q52 46 48 34 Z" fill={l.hair} />
        </>
      )}
      {l.style === "pony" && <path d="M46 14 Q62 18 56 46 Q50 36 44 22 Z" fill={l.hair} />}
      {/* 体(服は役割の色) */}
      <path className="of-body" d="M16 70 Q16 48 32 48 Q48 48 48 70 Z" />
      <path d="M27 49 L32 55 L37 49" fill="none" stroke="var(--surface)" strokeWidth="2" strokeLinejoin="round" />
      {/* 頭 */}
      <circle cx="32" cy="28" r="16" fill="var(--art-face)" />
      {/* 前髪 */}
      <path d="M15 28 Q14 10 32 10 Q50 10 49 28 Q44 20 38 19 Q34 24 26 22 Q22 26 15 28 Z" fill={l.hair} />
      {l.ahoge && <path d="M32 11 Q30 2 37 3 Q33 5 33 11 Z" fill={l.hair} />}
      {l.ribbon && (
        <g transform="translate(45 14) rotate(20)">
          <path d="M0 0 L-6 -4 L-6 4 Z M0 0 L6 -4 L6 4 Z" fill={l.ribbon} />
          <circle r="1.8" fill={l.ribbon} />
        </g>
      )}
      {/* 目 */}
      {asleep ? (
        <g fill="none" stroke="var(--art-eye-closed)" strokeWidth="1.8" strokeLinecap="round">
          <path d="M23 31 Q26 33 29 31" />
          <path d="M35 31 Q38 33 41 31" />
        </g>
      ) : (
        <g className="of-eyes">
          <ellipse cx="26" cy="30" rx="2.6" ry="3.4" fill="var(--art-outline)" />
          <ellipse cx="38" cy="30" rx="2.6" ry="3.4" fill="var(--art-outline)" />
          <circle cx="27" cy="28.6" r="1" fill="var(--surface)" />
          <circle cx="39" cy="28.6" r="1" fill="var(--surface)" />
        </g>
      )}
      {/* ほっぺと口 */}
      <ellipse cx="21.5" cy="35" rx="3" ry="1.8" fill="var(--art-blush)" opacity=".75" />
      <ellipse cx="42.5" cy="35" rx="3" ry="1.8" fill="var(--art-blush)" opacity=".75" />
      {asleep ? <ellipse cx="32" cy="37.5" rx="1.4" ry="1.1" fill="var(--art-mouth)" /> : <path d="M29.5 36.5 Q32 39 34.5 36.5" fill="none" stroke="var(--art-mouth)" strokeWidth="1.5" strokeLinecap="round" />}
      {/* ノート PC */}
      <rect className="of-laptop" x="18" y="58" width="28" height="12" rx="2.5" />
      <circle cx="32" cy="64" r="1.6" fill="var(--surface)" opacity=".8" />
    </svg>
  );
}
