// Gem and mine artwork for the Mines board. Drawn as SVG so they stay crisp at
// any tile size and never fall back to emoji.

export function GemIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 48 48" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id="gem-body" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#8ff7d4" />
          <stop offset="0.55" stopColor="#22c79a" />
          <stop offset="1" stopColor="#0b7a5b" />
        </linearGradient>
      </defs>
      {/* outline: table, crown, pavilion */}
      <path d="M14 7h20l9 11-19 24L5 18z" fill="url(#gem-body)" stroke="#063d2e" strokeWidth="1.6" strokeLinejoin="round" />
      {/* facets */}
      <path d="M5 18h38M14 7l-3 11 13 24 13-24-3-11M24 7l-6 11h12z" fill="none" stroke="rgba(6,61,46,0.55)" strokeWidth="1.1" strokeLinejoin="round" />
      <path d="M18 18l6-11 6 11z" fill="rgba(255,255,255,0.35)" />
      <path d="M11 18l3-11 4 11z" fill="rgba(255,255,255,0.18)" />
      <circle cx="33" cy="12" r="1.6" fill="#ffffff" />
    </svg>
  )
}

export function MineIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 48 48" aria-hidden="true" focusable="false">
      <defs>
        <radialGradient id="mine-body" cx="0.38" cy="0.34" r="0.7">
          <stop offset="0" stopColor="#c3c8d3" />
          <stop offset="0.55" stopColor="#6b7180" />
          <stop offset="1" stopColor="#2b2e37" />
        </radialGradient>
      </defs>
      {/* spikes */}
      <g stroke="#8a90a0" strokeWidth="3.6" strokeLinecap="round">
        <path d="M24 8v6M24 34v6M8 24h6M34 24h6M12.7 12.7l4.2 4.2M31.1 31.1l4.2 4.2M35.3 12.7l-4.2 4.2M16.9 31.1l-4.2 4.2" />
      </g>
      <circle cx="24" cy="24" r="12" fill="url(#mine-body)" stroke="#16181e" strokeWidth="1.6" />
      <circle cx="20" cy="20" r="3" fill="rgba(255,255,255,0.45)" />
      <circle cx="24" cy="24" r="3" fill="#ff4b55" stroke="#ffd0d4" strokeWidth="0.8" />
    </svg>
  )
}
