/**
 * オフィスの登場人物の絵(ちびキャラ)。髪の色と髪型は人ごと、服の色は今している役割で変わる。
 * 手すきのときは目を閉じて居眠りする。髪の色・髪型は原作の雰囲気に寄せたもの。
 */
type Hair = "long" | "short" | "twin" | "pony" | "bob";
type Look = { hair: string; style: Hair; ribbon?: string; ahoge?: boolean };

const LOOKS: Record<string, Look> = {
  星南: { hair: "#f1e2b3", style: "long" },
  広: { hair: "#c7cfe0", style: "long", ahoge: true },
  咲季: { hair: "#e2643f", style: "long", ribbon: "#f5c542" },
  清夏: { hair: "#f3bf5a", style: "pony" },
  手毬: { hair: "#33406e", style: "pony" },
  ことね: { hair: "#f4d270", style: "twin", ribbon: "#ef7a9a" },
  麻央: { hair: "#8c3340", style: "short" },
  リーリヤ: { hair: "#ecebf3", style: "long", ribbon: "#7fb2e5" },
  千奈: { hair: "#f0a356", style: "long", ribbon: "#e5527a" },
  莉波: { hair: "#d98ea1", style: "long" },
  佑芽: { hair: "#e86a42", style: "pony" },
  美鈴: { hair: "#9aa8dc", style: "bob" },
  春香: { hair: "#8d5b3c", style: "bob", ribbon: "#e5455b" },
  千早: { hair: "#3b5fa8", style: "long" },
  美希: { hair: "#f5d576", style: "long", ahoge: true },
  卯月: { hair: "#7c4b2b", style: "long" },
  凛: { hair: "#3a2a2e", style: "long" },
  未央: { hair: "#9b6b3c", style: "short" },
  未来: { hair: "#a8683a", style: "pony" },
  静香: { hair: "#232634", style: "long" },
  翼: { hair: "#a5703f", style: "pony", ribbon: "#f2a541" },
  真乃: { hair: "#c99c8e", style: "bob" },
};
const DEFAULT: Look = { hair: "#6b5545", style: "short" };

export function Avatar({ name, asleep, className }: { name: string; asleep?: boolean; className?: string }) {
  const l = LOOKS[name] ?? DEFAULT;
  const shade = `color-mix(in srgb, ${l.hair} 78%, #000)`;
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
      <path d="M27 49 L32 55 L37 49" fill="none" stroke="#fff" strokeWidth="2" strokeLinejoin="round" />
      {/* 頭 */}
      <circle cx="32" cy="28" r="16" fill="#fde3cf" />
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
        <g fill="none" stroke="#4a3a3a" strokeWidth="1.8" strokeLinecap="round">
          <path d="M23 31 Q26 33 29 31" />
          <path d="M35 31 Q38 33 41 31" />
        </g>
      ) : (
        <g className="of-eyes">
          <ellipse cx="26" cy="30" rx="2.6" ry="3.4" fill="#3b2c3a" />
          <ellipse cx="38" cy="30" rx="2.6" ry="3.4" fill="#3b2c3a" />
          <circle cx="27" cy="28.6" r="1" fill="#fff" />
          <circle cx="39" cy="28.6" r="1" fill="#fff" />
        </g>
      )}
      {/* ほっぺと口 */}
      <ellipse cx="21.5" cy="35" rx="3" ry="1.8" fill="#f7a9b4" opacity=".75" />
      <ellipse cx="42.5" cy="35" rx="3" ry="1.8" fill="#f7a9b4" opacity=".75" />
      {asleep ? <ellipse cx="32" cy="37.5" rx="1.4" ry="1.1" fill="#c0606e" /> : <path d="M29.5 36.5 Q32 39 34.5 36.5" fill="none" stroke="#c0606e" strokeWidth="1.5" strokeLinecap="round" />}
      {/* ノート PC */}
      <rect className="of-laptop" x="18" y="58" width="28" height="12" rx="2.5" />
      <circle cx="32" cy="64" r="1.6" fill="#fff" opacity=".8" />
    </svg>
  );
}
