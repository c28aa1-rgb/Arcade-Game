// Shared playing-card face for Blackjack, Hi-Lo and Poker.
//
// Drop it inside any `.playing-card` (or a flip-face) and it fills the card:
// mirrored corner indices, a centre pip for number cards and aces, and a framed
// monogram for court cards. Suits are drawn as SVG so they never fall back to a
// colour emoji, and every size is in container units, so the same face reads
// on a 40px poker seat card and a 140px Hi-Lo card.
//
// Inner elements are divs/b on purpose: the older `.playing-card span/small`
// rules (and Poker's size overrides for them) can't reach in and resize them.

const SUIT_PATHS: Record<string, string> = {
  '♥': 'M50 90C22 66 6 49 6 31 6 17 17 7 30 7c9 0 16 5 20 12 4-7 11-12 20-12 13 0 24 10 24 24 0 18-16 35-44 59z',
  '♦': 'M50 4Q68 28 88 50 68 72 50 96 32 72 12 50 32 28 50 4z',
  '♠':
    'M50 5C78 30 94 45 94 61c0 13-10 22-22 22-9 0-16-5-20-12 1 10 6 17 13 23H35c7-6 12-13 13-23-4 7-11 12-20 12C16 83 6 74 6 61 6 45 22 30 50 5z',
  '♣':
    'M50 6a20 20 0 1 1 0 40 20 20 0 1 1 0-40zM28 38a20 20 0 1 1 0 40 20 20 0 1 1 0-40zM72 38a20 20 0 1 1 0 40 20 20 0 1 1 0-40zM45 54c0 18-4 30-13 40h36c-9-10-13-22-13-40z',
}

const SUIT_NAMES: Record<string, string> = { '♥': 'hearts', '♦': 'diamonds', '♠': 'spades', '♣': 'clubs' }
const RANK_NAMES: Record<string, string> = { A: 'Ace', K: 'King', Q: 'Queen', J: 'Jack' }

export function SuitIcon({ suit, className }: { suit: string; className?: string }) {
  return (
    <svg className={className} viewBox="0 0 100 100" aria-hidden="true" focusable="false">
      <path d={SUIT_PATHS[suit] ?? SUIT_PATHS['♠']} fill="currentColor" />
    </svg>
  )
}

export default function CardFace({ rank, suit }: { rank: string; suit: string }) {
  // a card the server hasn't revealed yet (the dealer's hole card) has no face
  if (!rank) {
    return null
  }

  const red = suit === '♥' || suit === '♦'
  const court = rank === 'J' || rank === 'Q' || rank === 'K'
  const label = `${RANK_NAMES[rank] ?? rank} of ${SUIT_NAMES[suit] ?? 'spades'}`

  const corner = (pos: 'tl' | 'br') => (
    <div className={`card-face__corner card-face__corner--${pos}`}>
      <b className="card-face__rank">{rank}</b>
      <SuitIcon suit={suit} className="card-face__corner-suit" />
    </div>
  )

  return (
    <div className={`card-face ${red ? 'card-face--red' : 'card-face--black'}`} role="img" aria-label={label}>
      {corner('tl')}
      {court ? (
        <div className="card-face__court">
          <b className="card-face__court-rank">{rank}</b>
          <SuitIcon suit={suit} className="card-face__court-suit" />
        </div>
      ) : (
        <SuitIcon suit={suit} className={`card-face__pip${rank === 'A' ? ' card-face__pip--ace' : ''}`} />
      )}
      {corner('br')}
    </div>
  )
}
