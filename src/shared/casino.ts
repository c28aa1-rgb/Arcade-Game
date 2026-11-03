// Game rules shared by the page and the game server. Everything here is pure:
// no React, no DOM, no Firebase. The server runs these to decide outcomes; the
// page uses the same functions to show odds, totals and payouts.
import { random, randomInt } from './random'

// ---------- shared types ----------

export type Card = {
  rank: string
  suit: string
}

export type RoundResult = {
  message: string
  delta: number
  payout: number
}

export type RoulettePocket = number | '00'

export type RouletteBet =
  | { kind: 'number'; value: RoulettePocket }
  | { kind: 'color'; value: 'red' | 'black' }
  | { kind: 'parity'; value: 'odd' | 'even' }
  | { kind: 'range'; value: '1-18' | '19-36' | '1-12' | '13-24' | '25-36' }
  | { kind: 'column'; value: 'column-1' | 'column-2' | 'column-3' }

export type SlotRegularSymbol = 'dragon' | 'moon' | 'gem' | 'crown' | 'lotus'
export type SlotJackpot = 'mini' | 'minor' | 'major'
export type SlotCell =
  | { kind: 'symbol'; symbol: SlotRegularSymbol }
  | { kind: 'orb'; value: number; jackpot?: SlotJackpot | null }

export type DiceMode = 'lower' | 'higher'

// ---------- constants ----------

export const MIN_BET = 10
export const BANKROLL = 1000
export const DICE_COUNT = 20
export const DICE_MIN_TOTAL = DICE_COUNT
export const DICE_MAX_TOTAL = DICE_COUNT * 6
export const DICE_MAX_MULTIPLIER = 1000
export const MINES_GRID_SIZE = 5
export const MINES_TILE_COUNT = MINES_GRID_SIZE * MINES_GRID_SIZE
export const MINES_MIN_COUNT = 5
export const MINES_MAX_COUNT = 24
export const DEFAULT_MINES_COUNT = 5
export const MINES_EDGE = 0.99
export const HILO_HOUSE_EDGE = 0.99
export const PLINKO_ROWS = 12
export const PLINKO_MULTIPLIERS = [24, 7.5, 3.8, 1.4, 0.8, 0.6, 0.35, 0.6, 0.8, 1.4, 3.8, 7.5, 24]
export const SLOT_ROWS = 3
export const SLOT_COLUMNS = 5
export const SUITS = ['♠', '♥', '♦', '♣']
export const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K']

export const normalizeBankroll = (value: number) => Math.max(0, Math.round(value))
export const roundMoney = (value: number) => Number(value.toFixed(2))

// ---------- cards ----------

export const getCardValue = (rank: string) => {
  if (rank === 'A') {
    return 11
  }

  if (['K', 'Q', 'J'].includes(rank)) {
    return 10
  }

  return Number(rank)
}

export const getHandValue = (hand: Card[]) => {
  let total = hand.reduce((sum, card) => sum + getCardValue(card.rank), 0)
  let aces = hand.filter((card) => card.rank === 'A').length

  while (total > 21 && aces > 0) {
    total -= 10
    aces -= 1
  }

  return total
}

export const createShuffledDeck = () => {
  const deck: Card[] = []

  for (const suit of SUITS) {
    for (const rank of RANKS) {
      deck.push({ rank, suit })
    }
  }

  for (let index = deck.length - 1; index > 0; index -= 1) {
    const swapIndex = randomInt(index + 1)
    ;[deck[index], deck[swapIndex]] = [deck[swapIndex], deck[index]]
  }

  return deck
}

export const drawCards = (currentDeck: Card[], count: number) => {
  let workingDeck = [...currentDeck]

  if (workingDeck.length < count) {
    workingDeck = createShuffledDeck()
  }

  return {
    drawnCards: workingDeck.slice(0, count),
    remainingDeck: workingDeck.slice(count),
  }
}

export const drawRandomCard = (currentDeck: Card[]) => {
  let workingDeck = [...currentDeck]

  if (workingDeck.length === 0) {
    workingDeck = createShuffledDeck()
  }

  const randomIndex = randomInt(workingDeck.length)
  const drawnCard = workingDeck[randomIndex]
  const remainingDeck = workingDeck.filter((_, index) => index !== randomIndex)

  return { drawnCard, remainingDeck }
}

export const removeCardFromDeck = (currentDeck: Card[], targetCard: Card) => {
  const matchingCardIndex = currentDeck.findIndex(
    (card) => card.rank === targetCard.rank && card.suit === targetCard.suit,
  )

  if (matchingCardIndex === -1) {
    return [...currentDeck]
  }

  return currentDeck.filter((_, index) => index !== matchingCardIndex)
}

// ---------- blackjack ----------

export const finishDealerHand = (startingHand: Card[], currentDeck: Card[]) => {
  let dealerCards = [...startingHand]
  let deckAfterDraw = [...currentDeck]

  while (getHandValue(dealerCards) < 17) {
    const { drawnCards, remainingDeck } = drawCards(deckAfterDraw, 1)
    dealerCards = [...dealerCards, drawnCards[0]]
    deckAfterDraw = remainingDeck
  }

  return { finalDealerHand: dealerCards, remainingDeck: deckAfterDraw }
}

export const getRoundResult = (playerHands: Card[][], dealer: Card[], handBets: number[]): RoundResult => {
  const dealerTotal = getHandValue(dealer)
  const summaries: string[] = []
  let payout = 0

  playerHands.forEach((hand, index) => {
    const playerTotal = getHandValue(hand)
    const wager = handBets[index]
    const label = playerHands.length > 1 ? `Hand ${index + 1}` : 'You'
    // "You lose" but "Hand 1 loses" — the verb agrees with the subject
    const s = label === 'You' ? '' : 's'

    if (playerTotal > 21) {
      summaries.push(`${label} bust${s} with ${playerTotal}.`)
      return
    }

    if (dealerTotal > 21) {
      summaries.push(`${label} win${s}. Dealer busts with ${dealerTotal}.`)
      payout += wager * 2
      return
    }

    if (playerTotal > dealerTotal) {
      summaries.push(`${label} win${s} ${playerTotal} to ${dealerTotal}.`)
      payout += wager * 2
      return
    }

    if (playerTotal < dealerTotal) {
      summaries.push(`${label} lose${s} ${playerTotal} to ${dealerTotal}.`)
      return
    }

    summaries.push(`${label} tie${s} at ${playerTotal}.`)
    payout += wager
  })

  const totalWager = handBets.reduce((sum, wager) => sum + wager, 0)
  const delta = payout - totalWager

  return { message: summaries.join(' '), delta, payout }
}

// ---------- hi-lo ----------

export const getHiLoValue = (card: Card | null) => {
  if (!card) {
    return 0
  }

  if (card.rank === 'A') {
    return 14
  }

  if (card.rank === 'K') {
    return 13
  }

  if (card.rank === 'Q') {
    return 12
  }

  if (card.rank === 'J') {
    return 11
  }

  return Number(card.rank)
}

export type HiLoOdds = {
  higherCount: number
  lowerCount: number
  equalCount: number
  higherProbability: number
  lowerProbability: number
  higherStepMultiplier: number
  lowerStepMultiplier: number
}

export const getHiLoOdds = (deckCards: Card[], currentCard: Card | null): HiLoOdds => {
  const currentValue = getHiLoValue(currentCard)

  if (!currentCard || deckCards.length === 0 || currentValue === 0) {
    return {
      higherCount: 0,
      lowerCount: 0,
      equalCount: 0,
      higherProbability: 0,
      lowerProbability: 0,
      higherStepMultiplier: 1,
      lowerStepMultiplier: 1,
    }
  }

  const higherCount = deckCards.filter((card) => getHiLoValue(card) > currentValue).length
  const lowerCount = deckCards.filter((card) => getHiLoValue(card) < currentValue).length
  const equalCount = deckCards.length - higherCount - lowerCount
  const higherProbability = higherCount / deckCards.length
  const lowerProbability = lowerCount / deckCards.length

  return {
    higherCount,
    lowerCount,
    equalCount,
    higherProbability,
    lowerProbability,
    higherStepMultiplier: higherProbability > 0 ? Number((HILO_HOUSE_EDGE / higherProbability).toFixed(2)) : 0,
    lowerStepMultiplier: lowerProbability > 0 ? Number((HILO_HOUSE_EDGE / lowerProbability).toFixed(2)) : 0,
  }
}

// ---------- mines ----------

export const createMineIds = (mineCount: number) => {
  const mineIds = new Set<number>()

  while (mineIds.size < mineCount) {
    mineIds.add(randomInt(MINES_TILE_COUNT))
  }

  return Array.from(mineIds).sort((left, right) => left - right)
}

export const getMinesMultiplier = (safePickCount: number, mineCount: number) => {
  const clampedMineCount = Math.min(Math.max(Math.floor(mineCount), MINES_MIN_COUNT), MINES_MAX_COUNT)
  const maxSafePicks = MINES_TILE_COUNT - clampedMineCount
  const clampedSafePickCount = Math.min(Math.max(Math.floor(safePickCount), 0), maxSafePicks)

  if (clampedSafePickCount === 0) {
    return 1
  }

  // Standard provably-fair Mines payout (Stake/Rainbet): the fair multiplier is
  // the inverse of the odds of having cleared this many safe tiles, scaled by a
  // 1% house edge. multiplier = (1 - edge) * ∏ (tilesLeft / safeTilesLeft).
  let multiplier = MINES_EDGE

  for (let index = 0; index < clampedSafePickCount; index += 1) {
    const remainingTiles = MINES_TILE_COUNT - index
    const remainingSafeTiles = remainingTiles - clampedMineCount
    multiplier *= remainingTiles / remainingSafeTiles
  }

  return Number(multiplier.toFixed(2))
}

// ---------- dice ----------

const DICE_SUM_DISTRIBUTION = (() => {
  let counts = Array.from({ length: DICE_MAX_TOTAL + 1 }, () => 0)
  counts[0] = 1

  for (let dieIndex = 0; dieIndex < DICE_COUNT; dieIndex += 1) {
    const nextCounts = Array.from({ length: DICE_MAX_TOTAL + 1 }, () => 0)

    counts.forEach((count, total) => {
      if (!count) {
        return
      }

      for (let pip = 1; pip <= 6; pip += 1) {
        nextCounts[total + pip] += count
      }
    })

    counts = nextCounts
  }

  return counts
})()

const DICE_TOTAL_OUTCOMES = 6 ** DICE_COUNT
// Standard "dice" payout, same as Stake/Rainbet: fair odds minus a 1% house
// edge (99% RTP). multiplier = (1 - houseEdge) / winChance, so a ~50% bet pays
// ~2x and the edge is constant across the whole target range.
const DICE_HOUSE_EDGE = 0.01
const DICE_MIN_MULTIPLIER = 1.01

export const clampDiceTarget = (value: number) => Math.min(DICE_MAX_TOTAL, Math.max(DICE_MIN_TOTAL, Math.round(value)))

export const rollTwentyDice = () => Array.from({ length: DICE_COUNT }, () => randomInt(6) + 1)

export const getDiceTotal = (values: number[]) => values.reduce((sum, value) => sum + value, 0)

export const getDiceWinChance = (target: number, mode: DiceMode) => {
  const clampedTarget = clampDiceTarget(target)
  let favorableOutcomes = 0

  if (mode === 'lower') {
    for (let total = DICE_MIN_TOTAL; total < clampedTarget; total += 1) {
      favorableOutcomes += DICE_SUM_DISTRIBUTION[total] ?? 0
    }
  } else {
    for (let total = clampedTarget + 1; total <= DICE_MAX_TOTAL; total += 1) {
      favorableOutcomes += DICE_SUM_DISTRIBUTION[total] ?? 0
    }
  }

  return favorableOutcomes / DICE_TOTAL_OUTCOMES
}

export const getDiceMultiplier = (target: number, mode: DiceMode) => {
  const winChance = getDiceWinChance(target, mode)

  if (winChance <= 0) {
    return 0
  }

  const fairMultiplier = (1 - DICE_HOUSE_EDGE) / winChance
  const clamped = Math.min(DICE_MAX_MULTIPLIER, Math.max(DICE_MIN_MULTIPLIER, fairMultiplier))
  return Number(clamped.toFixed(2))
}

// ---------- roulette ----------

export const ROULETTE_WHEEL_ORDER: RoulettePocket[] = [
  0, 28, 9, 26, 30, 11, 7, 20, 32, 17, 5, 22, 34, 15, 3, 24, 36, 13, 1, '00', 27, 10, 25, 29, 12, 8, 19, 31, 18,
  6, 21, 33, 16, 4, 23, 35, 14, 2,
]

export const ROULETTE_RED_NUMBERS = new Set([
  '1', '3', '5', '7', '9', '12', '14', '16', '18', '19', '21', '23', '25', '27', '30', '32', '34', '36',
])

export const getRouletteBetDisplayLabel = (bet: RouletteBet | null) => {
  if (!bet) {
    return 'None'
  }

  if (bet.kind === 'number') {
    return `Number ${bet.value}`
  }

  if (bet.kind === 'color') {
    return bet.value === 'red' ? 'Red' : 'Black'
  }

  if (bet.kind === 'parity') {
    return bet.value === 'odd' ? 'Odd' : 'Even'
  }

  if (bet.kind === 'column') {
    return bet.value === 'column-1' ? '1st Row' : bet.value === 'column-2' ? '2nd Row' : '3rd Row'
  }

  if (bet.kind === 'range') {
    if (bet.value === '1-18') {
      return '1st Half'
    }

    if (bet.value === '19-36') {
      return '2nd Half'
    }
  }

  return bet.value
}

export const isSameRouletteBet = (left: RouletteBet, right: RouletteBet) =>
  left.kind === right.kind && left.value === right.value

const VALID_ROULETTE_VALUES: Record<RouletteBet['kind'], (value: unknown) => boolean> = {
  number: (value) => value === '00' || (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 36),
  color: (value) => value === 'red' || value === 'black',
  parity: (value) => value === 'odd' || value === 'even',
  range: (value) => ['1-18', '19-36', '1-12', '13-24', '25-36'].includes(value as string),
  column: (value) => ['column-1', 'column-2', 'column-3'].includes(value as string),
}

export const isValidRouletteBet = (bet: unknown): bet is RouletteBet => {
  const candidate = bet as { kind?: string; value?: unknown } | null
  return Boolean(
    candidate &&
      typeof candidate.kind === 'string' &&
      candidate.kind in VALID_ROULETTE_VALUES &&
      VALID_ROULETTE_VALUES[candidate.kind as RouletteBet['kind']](candidate.value),
  )
}

export const spinRoulettePocket = (): RoulettePocket => ROULETTE_WHEEL_ORDER[randomInt(ROULETTE_WHEEL_ORDER.length)]

// Settle a whole bet slip against the pocket the ball landed in.
export const settleRouletteBets = (
  bets: { bet: RouletteBet; amount: number }[],
  winningNumber: RoulettePocket,
): RoundResult => {
  // 0 and 00 are green: only a straight-up bet on them wins
  const numericWinningNumber = typeof winningNumber === 'number' && winningNumber !== 0 ? winningNumber : null
  const isRed = numericWinningNumber !== null && ROULETTE_RED_NUMBERS.has(String(numericWinningNumber))
  const isOdd = numericWinningNumber !== null && numericWinningNumber % 2 === 1
  let delta = 0
  let payout = 0

  const messages = bets.map((entry) => {
    const label = getRouletteBetDisplayLabel(entry.bet)

    if (entry.bet.kind === 'number') {
      const didWin = winningNumber === entry.bet.value
      delta += didWin ? entry.amount * 35 : -entry.amount
      payout += didWin ? entry.amount * 36 : 0
      return didWin ? `${label} hits for +$${entry.amount * 35}` : `${label} misses for -$${entry.amount}`
    }

    if (entry.bet.kind === 'color') {
      const didWin = numericWinningNumber !== null && entry.bet.value === (isRed ? 'red' : 'black')
      delta += didWin ? entry.amount : -entry.amount
      payout += didWin ? entry.amount * 2 : 0
      return didWin ? `${label} wins +$${entry.amount}` : `${label} loses -$${entry.amount}`
    }

    if (entry.bet.kind === 'parity') {
      const didWin = numericWinningNumber !== null && entry.bet.value === (isOdd ? 'odd' : 'even')
      delta += didWin ? entry.amount : -entry.amount
      payout += didWin ? entry.amount * 2 : 0
      return didWin ? `${label} wins +$${entry.amount}` : `${label} loses -$${entry.amount}`
    }

    if (entry.bet.kind === 'column') {
      const didWin =
        numericWinningNumber !== null &&
        ((entry.bet.value === 'column-1' && numericWinningNumber % 3 === 1) ||
          (entry.bet.value === 'column-2' && numericWinningNumber % 3 === 2) ||
          (entry.bet.value === 'column-3' && numericWinningNumber % 3 === 0))
      delta += didWin ? entry.amount * 2 : -entry.amount
      payout += didWin ? entry.amount * 3 : 0
      return didWin ? `${label} wins +$${entry.amount * 2}` : `${label} loses -$${entry.amount}`
    }

    const didWin =
      numericWinningNumber !== null &&
      ((entry.bet.value === '1-18' && numericWinningNumber >= 1 && numericWinningNumber <= 18) ||
        (entry.bet.value === '19-36' && numericWinningNumber >= 19 && numericWinningNumber <= 36) ||
        (entry.bet.value === '1-12' && numericWinningNumber >= 1 && numericWinningNumber <= 12) ||
        (entry.bet.value === '13-24' && numericWinningNumber >= 13 && numericWinningNumber <= 24) ||
        (entry.bet.value === '25-36' && numericWinningNumber >= 25 && numericWinningNumber <= 36))

    const payoutMultiplier =
      entry.bet.value === '1-12' || entry.bet.value === '13-24' || entry.bet.value === '25-36' ? 2 : 1

    delta += didWin ? entry.amount * payoutMultiplier : -entry.amount
    payout += didWin ? entry.amount * (payoutMultiplier + 1) : 0
    return didWin ? `${label} wins +$${entry.amount * payoutMultiplier}` : `${label} loses -$${entry.amount}`
  })

  return {
    message: `Ball lands on ${winningNumber}. ${messages.join('. ')}.`,
    delta,
    payout,
  }
}

// ---------- slots ----------

export const SLOT_PAYTABLE: Record<SlotRegularSymbol, { 3: number; 4: number; 5: number }> = {
  dragon: { 3: 8, 4: 20, 5: 60 },
  crown: { 3: 5, 4: 12, 5: 30 },
  gem: { 3: 4, 4: 10, 5: 22 },
  lotus: { 3: 3, 4: 8, 5: 18 },
  moon: { 3: 2, 4: 6, 5: 14 },
}

export const SLOT_SYMBOL_LABELS: Record<SlotRegularSymbol, string> = {
  dragon: 'DR',
  crown: 'CR',
  gem: 'GM',
  lotus: 'LT',
  moon: 'MN',
}

export const SLOT_SYMBOL_POOL: SlotRegularSymbol[] = [
  'dragon', 'dragon', 'crown', 'crown', 'gem', 'gem', 'lotus', 'lotus', 'moon', 'moon',
]

export const getSlotJackpotValues = (betAmount: number) => ({
  mini: Math.max(20, betAmount * 10),
  minor: Math.max(100, betAmount * 30),
  major: Math.max(500, betAmount * 120),
  grand: Math.max(5000, betAmount * 1000),
})

export const createInitialSlotsGrid = (): SlotCell[][] =>
  Array.from({ length: SLOT_ROWS }, (_, rowIndex) =>
    Array.from({ length: SLOT_COLUMNS }, (_, columnIndex) => ({
      kind: 'symbol' as const,
      symbol: SLOT_SYMBOL_POOL[(rowIndex + columnIndex) % SLOT_SYMBOL_POOL.length],
    })),
  )

export const getRandomSlotSymbol = () => SLOT_SYMBOL_POOL[randomInt(SLOT_SYMBOL_POOL.length)]

export const getRandomSlotOrb = (betAmount: number): SlotCell => {
  const jackpotRoll = random()

  if (jackpotRoll < 0.03) {
    return { kind: 'orb', value: 0, jackpot: 'mini' }
  }

  if (jackpotRoll < 0.045) {
    return { kind: 'orb', value: 0, jackpot: 'minor' }
  }

  if (jackpotRoll < 0.052) {
    return { kind: 'orb', value: 0, jackpot: 'major' }
  }

  const orbMultipliers = [1, 2, 2, 3, 4, 5, 8, 10, 15]
  const multiplier = orbMultipliers[randomInt(orbMultipliers.length)]

  return {
    kind: 'orb',
    value: betAmount * multiplier,
    jackpot: null,
  }
}

const createSlotsSpinTopRow = (betAmount: number): SlotCell[] =>
  Array.from({ length: SLOT_COLUMNS }, () =>
    random() < 0.24 ? getRandomSlotOrb(betAmount) : { kind: 'symbol' as const, symbol: getRandomSlotSymbol() },
  )

export const createSlotsFinalGrid = (betAmount: number): SlotCell[][] =>
  Array.from({ length: SLOT_ROWS }, () => createSlotsSpinTopRow(betAmount))

export const getSlotsWinningCells = (grid: SlotCell[][]): boolean[][] => {
  const winning = Array.from({ length: SLOT_ROWS }, () => Array.from({ length: SLOT_COLUMNS }, () => false))

  for (let rowIndex = 0; rowIndex < SLOT_ROWS; rowIndex += 1) {
    const firstCell = grid[rowIndex][0]

    if (firstCell.kind !== 'symbol') {
      continue
    }

    let matchCount = 1

    for (let columnIndex = 1; columnIndex < SLOT_COLUMNS; columnIndex += 1) {
      const cell = grid[rowIndex][columnIndex]

      if (cell.kind === 'symbol' && cell.symbol === firstCell.symbol) {
        matchCount += 1
      } else {
        break
      }
    }

    if (matchCount >= 3) {
      for (let columnIndex = 0; columnIndex < matchCount; columnIndex += 1) {
        winning[rowIndex][columnIndex] = true
      }
    }
  }

  return winning
}

export const countSlotsBonusSymbols = (grid: SlotCell[][]) => grid.flat().filter((cell) => cell.kind === 'orb').length

export const calculateSlotsLinePayout = (grid: SlotCell[][], betAmount: number) => {
  const winningLines: string[] = []
  let totalPayout = 0

  for (let rowIndex = 0; rowIndex < SLOT_ROWS; rowIndex += 1) {
    const firstCell = grid[rowIndex][0]

    if (firstCell.kind !== 'symbol') {
      continue
    }

    let matchCount = 1

    for (let columnIndex = 1; columnIndex < SLOT_COLUMNS; columnIndex += 1) {
      const currentCell = grid[rowIndex][columnIndex]

      if (currentCell.kind === 'symbol' && currentCell.symbol === firstCell.symbol) {
        matchCount += 1
      } else {
        break
      }
    }

    if (matchCount >= 3) {
      const payoutMultiplier = SLOT_PAYTABLE[firstCell.symbol][matchCount as 3 | 4 | 5]
      const linePayout = betAmount * payoutMultiplier
      totalPayout += linePayout
      winningLines.push(`${SLOT_SYMBOL_LABELS[firstCell.symbol]} x${matchCount} pays $${linePayout}`)
    }
  }

  return { totalPayout, winningLines }
}

export const createSlotsBonusGridFromSpin = (grid: SlotCell[][]): (SlotCell | null)[][] =>
  grid.map((row) => row.map((cell) => (cell.kind === 'orb' ? cell : null)))

export const respinSlotsBonusGrid = (
  currentGrid: (SlotCell | null)[][],
  betAmount: number,
): { nextGrid: (SlotCell | null)[][]; newOrbCount: number } => {
  const nextGrid = currentGrid.map((row) => [...row])
  const emptySpots: Array<{ rowIndex: number; columnIndex: number }> = []

  for (let rowIndex = 0; rowIndex < SLOT_ROWS; rowIndex += 1) {
    for (let columnIndex = 0; columnIndex < SLOT_COLUMNS; columnIndex += 1) {
      if (!nextGrid[rowIndex][columnIndex]) {
        emptySpots.push({ rowIndex, columnIndex })
      }
    }
  }

  let newOrbCount = 0

  emptySpots.forEach(({ rowIndex, columnIndex }) => {
    if (random() < 0.16) {
      nextGrid[rowIndex][columnIndex] = getRandomSlotOrb(betAmount)
      newOrbCount += 1
    }
  })

  if (newOrbCount === 0 && emptySpots.length > 0 && random() < 0.35) {
    const guaranteedSpot = emptySpots[randomInt(emptySpots.length)]
    nextGrid[guaranteedSpot.rowIndex][guaranteedSpot.columnIndex] = getRandomSlotOrb(betAmount)
    newOrbCount = 1
  }

  return { nextGrid, newOrbCount }
}

export const calculateSlotsBonusPayout = (bonusGrid: (SlotCell | null)[][], betAmount: number) => {
  const jackpots = getSlotJackpotValues(betAmount)
  let totalPayout = 0
  let miniCount = 0
  let minorCount = 0
  let majorCount = 0
  let orbValueTotal = 0
  let filledCount = 0

  bonusGrid.flat().forEach((cell) => {
    if (!cell || cell.kind !== 'orb') {
      return
    }

    filledCount += 1
    orbValueTotal += cell.value
    totalPayout += cell.value

    if (cell.jackpot === 'mini') {
      miniCount += 1
      totalPayout += jackpots.mini
    }

    if (cell.jackpot === 'minor') {
      minorCount += 1
      totalPayout += jackpots.minor
    }

    if (cell.jackpot === 'major') {
      majorCount += 1
      totalPayout += jackpots.major
    }
  })

  const hitGrand = filledCount === SLOT_ROWS * SLOT_COLUMNS

  if (hitGrand) {
    totalPayout += jackpots.grand
  }

  return { totalPayout, orbValueTotal, miniCount, minorCount, majorCount, hitGrand }
}

// ---------- plinko ----------

export const getPlinkoCenterBiasForWinStreak = (winStreak: number) => {
  if (winStreak < 2) {
    return 0
  }

  if (winStreak === 2) {
    return 0.1
  }

  if (winStreak === 3) {
    return 0.16
  }

  return 0.22
}

// ---------- daily bonus ----------

const DAILY_REWARD_WEEK_ONE = [10, 20, 35, 55, 80, 100, 250]

export const getDailyRewardAmountForDay = (streakDay: number) => {
  const normalizedDay = Math.max(1, Math.floor(streakDay))
  const weekIndex = Math.floor((normalizedDay - 1) / 7)
  const dayIndex = (normalizedDay - 1) % 7

  if (weekIndex === 0) {
    return DAILY_REWARD_WEEK_ONE[dayIndex]
  }

  const weekStart = 125 + (weekIndex - 1) * 55
  const weekSchedule = [
    weekStart,
    weekStart + 20,
    weekStart + 45,
    weekStart + 75,
    weekStart + 110,
    weekStart + 150,
    weekStart + 325,
  ]

  return weekSchedule[dayIndex]
}

export const isDateKey = (value: unknown): value is string =>
  typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)

// Days between two YYYY-MM-DD keys, calendar-wise (no time zone drift).
export const getDateKeyDistance = (leftKey: string, rightKey: string) => {
  const [leftYear, leftMonth, leftDay] = leftKey.split('-').map(Number)
  const [rightYear, rightMonth, rightDay] = rightKey.split('-').map(Number)
  const left = Date.UTC(leftYear, leftMonth - 1, leftDay)
  const right = Date.UTC(rightYear, rightMonth - 1, rightDay)
  return Math.round((left - right) / (24 * 60 * 60 * 1000))
}

// What the next claim is worth, given the player's last claim and streak.
export const getDailyRewardState = (todayKey: string, lastClaimKey: string | null, streak: number) => {
  const daysSinceLastClaim = lastClaimKey ? getDateKeyDistance(todayKey, lastClaimKey) : null
  const activeStreak = daysSinceLastClaim === null ? 0 : daysSinceLastClaim <= 1 ? streak : 0
  const canClaim = daysSinceLastClaim !== 0
  const nextDay = activeStreak + 1
  return { daysSinceLastClaim, activeStreak, canClaim, nextDay, nextAmount: getDailyRewardAmountForDay(nextDay) }
}
