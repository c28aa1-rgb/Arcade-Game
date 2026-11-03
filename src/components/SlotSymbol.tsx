// Slot reel symbols, drawn as SVG so the machine never shows emoji.
// One shared visual language: a dark ink outline, a lit top-left, and a single
// highlight per symbol, so five different objects still read as one set.

type SlotSymbolName = 'dragon' | 'crown' | 'gem' | 'lotus' | 'moon'

const INK = '#2a1630'

function Dragon() {
  return (
    <>
      <defs>
        <radialGradient id="ss-lacquer" cx="0.4" cy="0.35" r="0.7">
          <stop offset="0" stopColor="#ff5a4e" />
          <stop offset="0.7" stopColor="#c21f2b" />
          <stop offset="1" stopColor="#7d0f1a" />
        </radialGradient>
      </defs>
      {/* gold-rimmed lacquer medallion */}
      <circle cx="32" cy="32" r="27" fill="#f2c14e" stroke={INK} strokeWidth="2" />
      <circle cx="32" cy="32" r="22.5" fill="url(#ss-lacquer)" stroke="#8a5a10" strokeWidth="1.2" />
      {/* serpentine jade body */}
      <path d="M17 44c4-10 13-6 17-13s0-14 10-15" fill="none" stroke={INK} strokeWidth="8.5" strokeLinecap="round" />
      <path d="M17 44c4-10 13-6 17-13s0-14 10-15" fill="none" stroke="#3fd39a" strokeWidth="5.5" strokeLinecap="round" />
      <path d="M19 41c3-6 9-5 13-9" fill="none" stroke="#b6ffe0" strokeWidth="1.6" strokeLinecap="round" />
      {/* head, horn, eye */}
      <path d="M41 13l8-4-2 7z" fill="#f2c14e" stroke={INK} strokeWidth="1.2" strokeLinejoin="round" />
      <circle cx="45" cy="17" r="5.2" fill="#3fd39a" stroke={INK} strokeWidth="1.8" />
      <circle cx="46.4" cy="16" r="1.4" fill={INK} />
      {/* back fins */}
      <path d="M26 35l-1-6 5 3M33 26l1-6 3 5" fill="#f2c14e" stroke={INK} strokeWidth="1.1" strokeLinejoin="round" />
    </>
  )
}

function Crown() {
  return (
    <>
      <defs>
        <linearGradient id="ss-gold" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ffe9a3" />
          <stop offset="0.5" stopColor="#f2b72f" />
          <stop offset="1" stopColor="#b47612" />
        </linearGradient>
      </defs>
      <path d="M10 44L7 18l13 11 12-17 12 17 13-11-3 26z" fill="url(#ss-gold)" stroke={INK} strokeWidth="2" strokeLinejoin="round" />
      <rect x="9" y="44" width="46" height="9" rx="2.5" fill="url(#ss-gold)" stroke={INK} strokeWidth="2" />
      <circle cx="7" cy="17" r="3.4" fill="#f2b72f" stroke={INK} strokeWidth="1.6" />
      <circle cx="32" cy="11" r="3.8" fill="#f2b72f" stroke={INK} strokeWidth="1.6" />
      <circle cx="57" cy="17" r="3.4" fill="#f2b72f" stroke={INK} strokeWidth="1.6" />
      <circle cx="32" cy="35" r="4.4" fill="#e23b4a" stroke={INK} strokeWidth="1.4" />
      <circle cx="19" cy="38" r="3" fill="#3b6dff" stroke={INK} strokeWidth="1.2" />
      <circle cx="45" cy="38" r="3" fill="#3b6dff" stroke={INK} strokeWidth="1.2" />
      <path d="M14 22l6 6" stroke="#fff8d8" strokeWidth="2" strokeLinecap="round" />
    </>
  )
}

function Gem() {
  return (
    <>
      <defs>
        <linearGradient id="ss-sapphire" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#a9d8ff" />
          <stop offset="0.5" stopColor="#3b7bff" />
          <stop offset="1" stopColor="#1a2e9e" />
        </linearGradient>
      </defs>
      <path d="M19 9h26l13 15-26 32L6 24z" fill="url(#ss-sapphire)" stroke={INK} strokeWidth="2" strokeLinejoin="round" />
      <path d="M6 24h52M19 9l-5 15 18 32 18-32-5-15M32 9l-8 15h16z" fill="none" stroke="rgba(20,20,80,0.5)" strokeWidth="1.3" strokeLinejoin="round" />
      <path d="M24 24l8-15 8 15z" fill="rgba(255,255,255,0.4)" />
      <path d="M14 24l5-15 5 15z" fill="rgba(255,255,255,0.2)" />
      <circle cx="44" cy="15" r="2" fill="#ffffff" />
    </>
  )
}

function Lotus() {
  return (
    <>
      <defs>
        <linearGradient id="ss-petal" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ffd3e6" />
          <stop offset="1" stopColor="#ff5c9d" />
        </linearGradient>
      </defs>
      <path d="M8 46c8 6 40 6 48 0-6-2-14-2-24 0-10-2-18-2-24 0z" fill="#3fbf7a" stroke={INK} strokeWidth="1.8" strokeLinejoin="round" />
      {/* outer petals then inner petals */}
      <path d="M32 46C18 46 8 36 9 24c9 0 18 8 23 22z" fill="url(#ss-petal)" stroke={INK} strokeWidth="1.8" strokeLinejoin="round" />
      <path d="M32 46c14 0 24-10 23-22-9 0-18 8-23 22z" fill="url(#ss-petal)" stroke={INK} strokeWidth="1.8" strokeLinejoin="round" />
      <path d="M32 46c-9-2-14-12-11-24 7 3 11 13 11 24z" fill="url(#ss-petal)" stroke={INK} strokeWidth="1.8" strokeLinejoin="round" />
      <path d="M32 46c9-2 14-12 11-24-7 3-11 13-11 24z" fill="url(#ss-petal)" stroke={INK} strokeWidth="1.8" strokeLinejoin="round" />
      <path d="M32 46c-5-6-5-22 0-32 5 10 5 26 0 32z" fill="url(#ss-petal)" stroke={INK} strokeWidth="1.8" strokeLinejoin="round" />
      <path d="M32 18v20" stroke="#fff0f6" strokeWidth="1.6" strokeLinecap="round" />
    </>
  )
}

function Moon() {
  return (
    <>
      <defs>
        <linearGradient id="ss-moon" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#fff6c8" />
          <stop offset="1" stopColor="#e2a52c" />
        </linearGradient>
      </defs>
      <path d="M38 8a25 25 0 1 0 18 40A20 20 0 1 1 38 8z" fill="url(#ss-moon)" stroke={INK} strokeWidth="2" strokeLinejoin="round" />
      <path d="M20 22c-2 6-2 13 2 19" fill="none" stroke="#fffbe6" strokeWidth="2" strokeLinecap="round" />
      <path d="M49 16l1.6 4 4 1.6-4 1.6-1.6 4-1.6-4-4-1.6 4-1.6z" fill="#fff6c8" stroke={INK} strokeWidth="1" strokeLinejoin="round" />
      <circle cx="54" cy="33" r="1.8" fill="#fff6c8" stroke={INK} strokeWidth="0.8" />
    </>
  )
}

const ART: Record<SlotSymbolName, () => JSX.Element> = { dragon: Dragon, crown: Crown, gem: Gem, lotus: Lotus, moon: Moon }

export default function SlotSymbol({ symbol }: { symbol: SlotSymbolName }) {
  const Art = ART[symbol]
  return (
    <svg className="slot-symbol" viewBox="0 0 64 64" role="img" aria-label={symbol} focusable="false">
      <Art />
    </svg>
  )
}
