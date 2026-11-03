import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type SetStateAction } from 'react'
import { createPortal } from 'react-dom'
import { collection, deleteDoc, doc, getDoc, onSnapshot, setDoc } from 'firebase/firestore'
import {
  DEVELOPER_EMAIL,
  developerFirestore,
  ensurePlayerSession,
  firebaseConfigError,
  firestore,
  isFirebaseConfigured,
  signInAsDeveloper,
  signOutDeveloper,
  watchDeveloperSession,
} from './firebase'
import PlinkoBoard from './components/PlinkoBoard'
import ChickenRoad, { type ChickenStatus } from './components/ChickenRoad'
import CardFace from './components/CardFace'
import { GemIcon, MineIcon } from './components/MinesIcons'
import SlotSymbol from './components/SlotSymbol'
import RouletteWheel from './components/RouletteWheel'
import JetstreamBoard, { type JetstreamStatus } from './components/JetstreamBoard'
import {
  formatMultiplier as formatJetMultiplier,
  generateFlight as generateJetFlight,
  JET_LAND_CHANCE,
  JET_SPEEDS,
  JET_SPEED_ORDER,
  type JetFlight,
  type JetSpeed,
} from './components/jetstreamLogic'
import {
  CHICKEN_DIFFICULTIES,
  CHICKEN_DIFFICULTY_ORDER,
  CHICKEN_LANES,
  formatChickenMultiplier,
  getChickenConfig,
  rollChickenHop,
  type ChickenDifficulty,
} from './components/chickenLogic'

type RoulettePocket = number | '00'

const MIN_BET = 10
const BANKROLL = 1000
const DICE_COUNT = 20
const DICE_ROW_COUNT = 10
const DICE_MIN_TOTAL = DICE_COUNT
const DICE_MAX_TOTAL = DICE_COUNT * 6
const DICE_MAX_MULTIPLIER = 1000
const MINES_GRID_SIZE = 5
const MINES_TILE_COUNT = MINES_GRID_SIZE * MINES_GRID_SIZE
const MINES_MIN_COUNT = 5
const MINES_MAX_COUNT = 24
const DEFAULT_MINES_COUNT = 5
const MINES_EDGE = 0.99
const HILO_HOUSE_EDGE = 0.99
const DEV_MODE_TRIGGER_KEY = '-'
const DEV_MODE_SESSION_KEY = 'dalton-casino-dev-mode'
const PLAYER_ID_STORAGE_KEY = 'dalton-casino-player-id'
const PLAYER_PROFILE_STORAGE_PREFIX = 'dalton-casino-player-profile:'
const PLAYER_PENDING_CASHOUT_STORAGE_PREFIX = 'dalton-casino-pending-cashout:'
const PLAYER_DAILY_STATS_STORAGE_PREFIX = 'dalton-casino-player-daily-stats:'
const CASINO_DAILY_STATS_STORAGE_KEY = 'codex-casino-daily-stats'
const CASINO_GAME_DAILY_STATS_STORAGE_PREFIX = 'codex-casino-game-daily-stats:'
const PLINKO_ROWS = 12
const PLINKO_MULTIPLIERS = [24, 7.5, 3.8, 1.4, 0.8, 0.6, 0.35, 0.6, 0.8, 1.4, 3.8, 7.5, 24]
const SLOT_ROWS = 3
const SLOT_COLUMNS = 5
const SUITS = ['♠', '♥', '♦', '♣']
const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K']
const ROULETTE_WHEEL_ORDER: RoulettePocket[] = [
  0, 28, 9, 26, 30, 11, 7, 20, 32, 17, 5, 22, 34, 15, 3, 24, 36, 13, 1, '00', 27, 10,
  25, 29, 12, 8, 19, 31, 18, 6, 21, 33, 16, 4, 23, 35, 14, 2,
]
const ROULETTE_NUMBERS = [
  '1',
  '4',
  '7',
  '10',
  '13',
  '16',
  '19',
  '22',
  '25',
  '28',
  '31',
  '34',
  '2',
  '5',
  '8',
  '11',
  '14',
  '17',
  '20',
  '23',
  '26',
  '29',
  '32',
  '35',
  '3',
  '6',
  '9',
  '12',
  '15',
  '18',
  '21',
  '24',
  '27',
  '30',
  '33',
  '36',
]
const ROULETTE_RED_NUMBERS = new Set([
  '1',
  '3',
  '5',
  '7',
  '9',
  '12',
  '14',
  '16',
  '18',
  '19',
  '21',
  '23',
  '25',
  '27',
  '30',
  '32',
  '34',
  '36',
])

const ROULETTE_COLUMNS = [
  { label: '1st Row', value: 'column-1' as const },
  { label: '2nd Row', value: 'column-2' as const },
  { label: '3rd Row', value: 'column-3' as const },
]

const ROULETTE_DOZENS = [
  { label: '1st 3rd', value: '1-12' as const },
  { label: '2nd 3rd', value: '13-24' as const },
  { label: '3rd 3rd', value: '25-36' as const },
]

const ROULETTE_WHEEL_GRADIENT = (() => {
  const sliceSize = 360 / ROULETTE_WHEEL_ORDER.length

  return `conic-gradient(${ROULETTE_WHEEL_ORDER.map((value, index) => {
    const start = (index * sliceSize).toFixed(4)
    const end = ((index + 1) * sliceSize).toFixed(4)
    const color =
      value === 0 || value === '00'
        ? '#1f9655'
        : ROULETTE_RED_NUMBERS.has(String(value))
          ? '#d23b59'
          : '#101010'

    return `${color} ${start}deg ${end}deg`
  }).join(', ')})`
})()

// Roulette spin choreography. The wheel turns clockwise and decelerates while
// the ball runs counter-clockwise on the outer track, spirals in, rattles, and
// then rides the wheel to rest in the winning pocket. Everything is sampled up
// front into Web Animations keyframes, so the spin never re-renders React.
// radii as fractions of the wheel's half-width (see RouletteWheel geometry)
const ROULETTE_TRACK_RADIUS = 0.88
const ROULETTE_POCKET_RADIUS = 0.58

type RouletteSpinPose = { wheel: number; ball: number; radius: number }

// 50cqw is the wheel's half-width, so the ball scales with the wheel
const rouletteBallTransform = (angle: number, radiusFrac: number) =>
  `translate(-50%, -50%) rotate(${angle}deg) translateY(${(-radiusFrac * 50).toFixed(3)}cqw)`

const runRouletteSpin = (
  wheel: HTMLElement,
  ball: HTMLElement,
  from: RouletteSpinPose,
  pocketAngle: number,
  durationMs: number,
): RouletteSpinPose => {
  const w0 = from.wheel
  const w1 = w0 + 720 + Math.random() * 300
  const rel0 = from.ball - w0
  let relEnd = pocketAngle
  while (relEnd > rel0 - 1500) relEnd -= 360 // four-plus laps against the wheel

  // tLand: ball reaches the pocket ring. Before it, a short spiral down off the
  // track; after it, a few small decaying hops off the frets, then it rides the wheel.
  const tLand = 0.7
  const tSpiral = 0.14
  const samples = Math.round(durationMs / 16)
  const wheelFrames: Keyframe[] = []
  const ballFrames: Keyframe[] = []
  const easeOut = (t: number, p: number) => 1 - Math.pow(1 - t, p)

  for (let i = 0; i <= samples; i += 1) {
    const t = i / samples
    const w = w0 + (w1 - w0) * easeOut(t, 2.6)
    let rel: number
    let radius: number
    if (t < tLand) {
      rel = rel0 + (relEnd - rel0) * easeOut(t / tLand, 2.2)
    } else {
      const s = ((t - tLand) * durationMs) / 1000 // seconds since landing
      const decay = Math.exp(-s * 4.5)
      rel = relEnd + 5 * decay * Math.sin(2 * Math.PI * 2.4 * s) // nudged a few degrees either way
    }
    if (t < tLand - tSpiral) {
      radius = from.radius + (ROULETTE_TRACK_RADIUS - from.radius) * easeOut(Math.min(1, t / 0.06), 2)
    } else if (t < tLand) {
      const k = (t - (tLand - tSpiral)) / tSpiral
      radius = ROULETTE_TRACK_RADIUS + (ROULETTE_POCKET_RADIUS - ROULETTE_TRACK_RADIUS) * k * k
    } else {
      const s = ((t - tLand) * durationMs) / 1000
      radius = ROULETTE_POCKET_RADIUS + 0.045 * Math.exp(-s * 5) * Math.abs(Math.sin(2 * Math.PI * 2.4 * s))
    }
    wheelFrames.push({ transform: `rotate(${w}deg)` })
    ballFrames.push({ transform: rouletteBallTransform(w + rel, radius) })
  }

  const end: RouletteSpinPose = {
    wheel: w1 % 360,
    ball: (((w1 + relEnd) % 360) + 360) % 360,
    radius: ROULETTE_POCKET_RADIUS,
  }
  const wheelEnd = `rotate(${end.wheel}deg)`
  const ballEnd = rouletteBallTransform(end.ball, end.radius)

  const wheelAnim = wheel.animate(wheelFrames, { duration: durationMs, easing: 'linear', fill: 'forwards' })
  const ballAnim = ball.animate(ballFrames, { duration: durationMs, easing: 'linear', fill: 'forwards' })
  wheelAnim.onfinish = () => {
    wheel.style.transform = wheelEnd
    wheelAnim.cancel()
  }
  ballAnim.onfinish = () => {
    ball.style.transform = ballEnd
    ballAnim.cancel()
  }
  return end
}

const rouletteSpinTransforms = (pose: RouletteSpinPose) => ({
  wheel: `rotate(${pose.wheel}deg)`,
  ball: rouletteBallTransform(pose.ball, pose.radius),
})

const getRouletteBallAngleForPocket = (value: RoulettePocket) => {
  const sliceSize = 360 / ROULETTE_WHEEL_ORDER.length
  const index = ROULETTE_WHEEL_ORDER.indexOf(value)

  if (index === -1) {
    return 0
  }

  return index * sliceSize + sliceSize / 2
}

const normalizeRotation = (value: number) => {
  const normalized = value % 360
  return normalized < 0 ? normalized + 360 : normalized
}

const getRouletteBetDisplayLabel = (bet: RouletteBet | null) => {
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
    return bet.value === 'column-1'
      ? '1st Row'
      : bet.value === 'column-2'
        ? '2nd Row'
        : '3rd Row'
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

const isSameRouletteBet = (left: RouletteBet, right: RouletteBet) =>
  left.kind === right.kind && left.value === right.value

const normalizeBankroll = (value: number) => Math.max(0, Math.round(value))
const roundSignedMoney = (value: number) => Math.round(value)

type Card = {
  rank: string
  suit: string
}

type RoundResult = {
  message: string
  delta: number
  payout: number
}

type LocalPlayerProfile = {
  id: string
  name: string
  nameLocked: boolean
  skipStartScreen: boolean
  dailyRewardStreak: number
  lastDailyRewardClaimDate: string | null
  bankroll: number
  createdAt: string
  updatedAt: string
}

type PendingCashout = {
  playerId: string
  amount: number
  createdAt: string
}

type CasinoDailyStat = {
  date: string
  amount: number
}

type CasinoStatsRange = '7d' | '14d' | '1m' | '3m' | '6m' | '1y'
type CasinoTrackedGame = 'blackjack' | 'roulette' | 'hilo' | 'mines' | 'plinko' | 'slots' | 'dice' | 'chicken' | 'jetstream'

type SlotRegularSymbol = 'dragon' | 'moon' | 'gem' | 'crown' | 'lotus'
type SlotJackpot = 'mini' | 'minor' | 'major'
type SlotCell =
  | { kind: 'symbol'; symbol: SlotRegularSymbol }
  | { kind: 'orb'; value: number; jackpot?: SlotJackpot | null }

type PendingPlinkoDrop = {
  id: string
  bet: number
  centerBias: number
}

type PlinkoRound = {
  id: string
  bet: number
  slotIndex: number
  multiplier: number
  payout: number
  net: number
}

type ChickenRound = {
  id: string
  bet: number
  difficulty: ChickenDifficulty
  lane: number
  multiplier: number
  payout: number
  net: number
  cashed: boolean
}

type JetstreamRound = {
  id: string
  bet: number
  multiplier: number
  payout: number
  net: number
  cashed: boolean
}

type RouletteBet =
  | { kind: 'number'; value: RoulettePocket }
  | { kind: 'color'; value: 'red' | 'black' }
  | { kind: 'parity'; value: 'odd' | 'even' }
  | { kind: 'range'; value: '1-18' | '19-36' | '1-12' | '13-24' | '25-36' }
  | { kind: 'column'; value: 'column-1' | 'column-2' | 'column-3' }

type RouletteBetSlip = {
  id: string
  bet: RouletteBet
  amount: number
  input: string
}

type MinesTile = {
  id: number
  isMine: boolean
  revealed: boolean
  hit?: boolean // the mine the player actually stepped on
  multiplier?: number // multiplier earned by this safe pick
}

type DiceMode = 'lower' | 'higher'

type PokerSeat = {
  id: string
  name: string
}

type PokerStreet = 'preflop' | 'flop' | 'turn' | 'river' | 'showdown'

type PokerPlayerState = {
  chips: number
  holeCards: Card[]
  folded: boolean
  allIn: boolean
  committed: number
  acted: boolean
}

type PokerContribution = {
  playerId: string
  amount: number
}

type PokerActionType = 'start' | 'blind' | 'check' | 'call' | 'raise' | 'fold' | 'street' | 'showdown'

type PokerGameState = {
  street: PokerStreet
  activeSeatIndex: number
  currentBet: number
  pot: number
  communityCards: Card[]
  deck: Card[]
  players: Record<string, PokerPlayerState>
  actionId: number
  lastActorId: string | null
  lastActionType: PokerActionType
  lastContributions: PokerContribution[]
  lastAction: string
  winnerMessage: string | null
}

type PokerAnnouncementKind = 'info' | 'check' | 'call' | 'bet' | 'raise' | 'fold' | 'allin' | 'street' | 'win'

type PokerAnnouncement = {
  id: string
  text: string
  kind: PokerAnnouncementKind
  tag?: string
}

type PokerPendingStart = {
  buyIn: number
  playerIds: string[]
  confirmedPlayerIds: string[]
}

type PokerRoomState = {
  code: string
  buyIn: number
  smallBlind: number
  bigBlind: number
  hostId: string
  dealerSeatIndex: number
  playerChips: Record<string, number>
  seats: (PokerSeat | null)[]
  game: PokerGameState | null
  pendingStart: PokerPendingStart | null
}

const POKER_PLAYER_SESSION_KEY = 'dalton-casino-poker-player-id'
const DEFAULT_SMALL_BLIND = 5
const DEFAULT_BIG_BLIND = 10
const POKER_CHIP_DENOMINATIONS = [
  { value: 500, color: 'purple' },
  { value: 100, color: 'black' },
  { value: 25, color: 'green' },
  { value: 10, color: 'blue' },
  { value: 5, color: 'red' },
  { value: 1, color: 'white' },
] as const

const getCardValue = (rank: string) => {
  if (rank === 'A') {
    return 11
  }

  if (['K', 'Q', 'J'].includes(rank)) {
    return 10
  }

  return Number(rank)
}

const getSuitColorClass = (suit: string) =>
  suit === '♥' || suit === '♦' ? 'playing-card__suit--red' : 'playing-card__suit--black'

const getHandValue = (hand: Card[]) => {
  let total = hand.reduce((sum, card) => sum + getCardValue(card.rank), 0)
  let aces = hand.filter((card) => card.rank === 'A').length

  while (total > 21 && aces > 0) {
    total -= 10
    aces -= 1
  }

  return total
}

const createShuffledDeck = () => {
  const deck: Card[] = []

  for (const suit of SUITS) {
    for (const rank of RANKS) {
      deck.push({ rank, suit })
    }
  }

  for (let index = deck.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1))
    ;[deck[index], deck[swapIndex]] = [deck[swapIndex], deck[index]]
  }

  return deck
}

const drawCards = (currentDeck: Card[], count: number) => {
  let workingDeck = [...currentDeck]

  if (workingDeck.length < count) {
    workingDeck = createShuffledDeck()
  }

  return {
    drawnCards: workingDeck.slice(0, count),
    remainingDeck: workingDeck.slice(count),
  }
}

const drawRandomCard = (currentDeck: Card[]) => {
  let workingDeck = [...currentDeck]

  if (workingDeck.length === 0) {
    workingDeck = createShuffledDeck()
  }

  const randomIndex = Math.floor(Math.random() * workingDeck.length)
  const drawnCard = workingDeck[randomIndex]
  const remainingDeck = workingDeck.filter((_, index) => index !== randomIndex)

  return { drawnCard, remainingDeck }
}

const removeCardFromDeck = (currentDeck: Card[], targetCard: Card) => {
  const matchingCardIndex = currentDeck.findIndex(
    (card) => card.rank === targetCard.rank && card.suit === targetCard.suit,
  )

  if (matchingCardIndex === -1) {
    return [...currentDeck]
  }

  return currentDeck.filter((_, index) => index !== matchingCardIndex)
}

const createLocalPlayerId = () => `player-${Math.random().toString(36).slice(2, 12)}`

const getCasinoStatDateKey = (date = new Date()) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`

const readCasinoDailyStats = () => {
  if (typeof window === 'undefined') {
    return []
  }

  const savedStats = window.localStorage.getItem(CASINO_DAILY_STATS_STORAGE_KEY)

  if (!savedStats) {
    return []
  }

  try {
    const parsedStats = JSON.parse(savedStats) as CasinoDailyStat[]
    return parsedStats
      .map((entry) => ({
        date: entry.date,
        amount: roundSignedMoney(entry.amount),
      }))
      .sort((left, right) => left.date.localeCompare(right.date))
  } catch {
    return []
  }
}

const writeCasinoDailyStats = (stats: CasinoDailyStat[]) => {
  if (typeof window === 'undefined') {
    return
  }

  window.localStorage.setItem(
    CASINO_DAILY_STATS_STORAGE_KEY,
    JSON.stringify(
      stats
        .map((entry) => ({
          date: entry.date,
          amount: roundSignedMoney(entry.amount),
        }))
        .sort((left, right) => left.date.localeCompare(right.date)),
    ),
  )
}

const getCasinoGameDailyStatsStorageKey = (game: CasinoTrackedGame) =>
  `${CASINO_GAME_DAILY_STATS_STORAGE_PREFIX}${game}`

const readCasinoGameDailyStats = (game: CasinoTrackedGame) => {
  if (typeof window === 'undefined') {
    return []
  }

  const savedStats = window.localStorage.getItem(getCasinoGameDailyStatsStorageKey(game))

  if (!savedStats) {
    return []
  }

  try {
    const parsedStats = JSON.parse(savedStats) as CasinoDailyStat[]
    return parsedStats
      .map((entry) => ({
        date: entry.date,
        amount: roundSignedMoney(entry.amount),
      }))
      .sort((left, right) => left.date.localeCompare(right.date))
  } catch {
    return []
  }
}

const writeCasinoGameDailyStats = (game: CasinoTrackedGame, stats: CasinoDailyStat[]) => {
  if (typeof window === 'undefined') {
    return
  }

  window.localStorage.setItem(
    getCasinoGameDailyStatsStorageKey(game),
    JSON.stringify(
      stats
        .map((entry) => ({
          date: entry.date,
          amount: roundSignedMoney(entry.amount),
        }))
        .sort((left, right) => left.date.localeCompare(right.date)),
    ),
  )
}

const readPlayerDailyStats = (playerId: string) => {
  if (typeof window === 'undefined') {
    return []
  }

  const savedStats = window.localStorage.getItem(getPlayerDailyStatsStorageKey(playerId))

  if (!savedStats) {
    return []
  }

  try {
    const parsedStats = JSON.parse(savedStats) as CasinoDailyStat[]
    return parsedStats
      .map((entry) => ({
        date: entry.date,
        amount: roundSignedMoney(entry.amount),
      }))
      .sort((left, right) => left.date.localeCompare(right.date))
  } catch {
    return []
  }
}

const writePlayerDailyStats = (playerId: string, stats: CasinoDailyStat[]) => {
  if (typeof window === 'undefined') {
    return
  }

  window.localStorage.setItem(
    getPlayerDailyStatsStorageKey(playerId),
    JSON.stringify(
      stats
        .map((entry) => ({
          date: entry.date,
          amount: roundSignedMoney(entry.amount),
        }))
        .sort((left, right) => left.date.localeCompare(right.date)),
    ),
  )
}

const recordPlayerDailyDelta = (playerId: string, playerDelta: number) => {
  if (typeof window === 'undefined') {
    return
  }

  const roundedDelta = roundSignedMoney(playerDelta)

  if (roundedDelta === 0) {
    return
  }

  const dateKey = getCasinoStatDateKey()
  const currentStats = readPlayerDailyStats(playerId)
  const existingIndex = currentStats.findIndex((entry) => entry.date === dateKey)

  if (existingIndex === -1) {
    currentStats.push({ date: dateKey, amount: roundedDelta })
  } else {
    currentStats[existingIndex] = {
      ...currentStats[existingIndex],
      amount: roundSignedMoney(currentStats[existingIndex].amount + roundedDelta),
    }
  }

  writePlayerDailyStats(playerId, currentStats)
}

const clearCasinoDailyStats = () => {
  if (typeof window === 'undefined') {
    return
  }

  window.localStorage.removeItem(CASINO_DAILY_STATS_STORAGE_KEY)
}

const recordCasinoDailyDelta = (playerDelta: number) => {
  if (typeof window === 'undefined') {
    return
  }

  const casinoDelta = roundSignedMoney(-playerDelta)

  if (casinoDelta === 0) {
    return
  }

  const dateKey = getCasinoStatDateKey()
  const currentStats = readCasinoDailyStats()
  const existingIndex = currentStats.findIndex((entry) => entry.date === dateKey)

  if (existingIndex === -1) {
    currentStats.push({ date: dateKey, amount: casinoDelta })
  } else {
    currentStats[existingIndex] = {
      ...currentStats[existingIndex],
      amount: roundSignedMoney(currentStats[existingIndex].amount + casinoDelta),
    }
  }

  writeCasinoDailyStats(currentStats)
}

const clearCasinoGameDailyStats = (game?: CasinoTrackedGame) => {
  if (typeof window === 'undefined') {
    return
  }

  if (game) {
    window.localStorage.removeItem(getCasinoGameDailyStatsStorageKey(game))
    return
  }

  ;(['blackjack', 'roulette', 'hilo', 'mines', 'plinko', 'slots', 'dice', 'chicken', 'jetstream'] as CasinoTrackedGame[]).forEach((entry) => {
    window.localStorage.removeItem(getCasinoGameDailyStatsStorageKey(entry))
  })
}

const aggregateCasinoDailyStatsFromGames = (statsByGame: Record<CasinoTrackedGame, CasinoDailyStat[]>) => {
  const totalsByDate = new Map<string, number>()

  ;(['blackjack', 'roulette', 'hilo', 'mines', 'plinko', 'slots', 'dice', 'chicken', 'jetstream'] as CasinoTrackedGame[]).forEach((game) => {
    statsByGame[game].forEach((entry) => {
      totalsByDate.set(entry.date, roundSignedMoney((totalsByDate.get(entry.date) ?? 0) + entry.amount))
    })
  })

  return Array.from(totalsByDate.entries())
    .map(([date, amount]) => ({ date, amount }))
    .sort((left, right) => left.date.localeCompare(right.date))
}

const readAllCasinoGameDailyStats = (): Record<CasinoTrackedGame, CasinoDailyStat[]> => ({
  blackjack: readCasinoGameDailyStats('blackjack'),
  roulette: readCasinoGameDailyStats('roulette'),
  hilo: readCasinoGameDailyStats('hilo'),
  mines: readCasinoGameDailyStats('mines'),
  plinko: readCasinoGameDailyStats('plinko'),
  slots: readCasinoGameDailyStats('slots'),
  dice: readCasinoGameDailyStats('dice'),
  chicken: readCasinoGameDailyStats('chicken'),
  jetstream: readCasinoGameDailyStats('jetstream'),
})

const syncCasinoDailyStatsWithGames = () => {
  const aggregatedStats = aggregateCasinoDailyStatsFromGames(readAllCasinoGameDailyStats())
  writeCasinoDailyStats(aggregatedStats)
  return aggregatedStats
}

const recordCasinoGameDailyDelta = (game: CasinoTrackedGame, playerDelta: number) => {
  if (typeof window === 'undefined') {
    return
  }

  const casinoDelta = roundSignedMoney(-playerDelta)

  if (casinoDelta === 0) {
    return
  }

  const dateKey = getCasinoStatDateKey()
  const currentStats = readCasinoGameDailyStats(game)
  const existingIndex = currentStats.findIndex((entry) => entry.date === dateKey)

  if (existingIndex === -1) {
    currentStats.push({ date: dateKey, amount: casinoDelta })
  } else {
    currentStats[existingIndex] = {
      ...currentStats[existingIndex],
      amount: roundSignedMoney(currentStats[existingIndex].amount + casinoDelta),
    }
  }

  writeCasinoGameDailyStats(game, currentStats)
}

const getCasinoStatsRangeStart = (range: CasinoStatsRange) => {
  const date = new Date()

  if (range === '7d') {
    date.setDate(date.getDate() - 6)
    return date
  }

  if (range === '14d') {
    date.setDate(date.getDate() - 13)
    return date
  }

  if (range === '1m') {
    date.setMonth(date.getMonth() - 1)
    date.setDate(date.getDate() + 1)
    return date
  }

  if (range === '3m') {
    date.setMonth(date.getMonth() - 3)
    date.setDate(date.getDate() + 1)
    return date
  }

  if (range === '6m') {
    date.setMonth(date.getMonth() - 6)
    date.setDate(date.getDate() + 1)
    return date
  }

  date.setFullYear(date.getFullYear() - 1)
  date.setDate(date.getDate() + 1)
  return date
}

const filterCasinoDailyStats = (stats: CasinoDailyStat[], range: CasinoStatsRange) => {
  const startKey = getCasinoStatDateKey(getCasinoStatsRangeStart(range))
  return stats.filter((entry) => entry.date >= startKey)
}

const getLocalPlayerProfileStorageKey = (playerId: string) =>
  `${PLAYER_PROFILE_STORAGE_PREFIX}${playerId}`

const getPendingCashoutStorageKey = (playerId: string) =>
  `${PLAYER_PENDING_CASHOUT_STORAGE_PREFIX}${playerId}`

const getPlayerDailyStatsStorageKey = (playerId: string) =>
  `${PLAYER_DAILY_STATS_STORAGE_PREFIX}${playerId}`

const getPlayerProfileDocRef = (playerId: string) => {
  if (!firestore) {
    return null
  }

  return doc(firestore, 'players', playerId)
}

// developer edits to other players go through the Google-signed-in session,
// which is the only one the Firestore rules let touch someone else's record
const getDeveloperPlayerDocRef = (playerId: string) => {
  if (!developerFirestore) {
    return null
  }

  return doc(developerFirestore, 'players', playerId)
}

const readLocalPlayerProfile = (playerId: string) => {
  if (typeof window === 'undefined') {
    return null
  }

  const savedProfile = window.localStorage.getItem(getLocalPlayerProfileStorageKey(playerId))

  if (!savedProfile) {
    return null
  }

  try {
    const profile = JSON.parse(savedProfile) as LocalPlayerProfile
    return {
      ...profile,
      name: typeof profile.name === 'string' ? profile.name : '',
      nameLocked: Boolean((profile as LocalPlayerProfile & { nameLocked?: boolean }).nameLocked),
      skipStartScreen: Boolean(profile.skipStartScreen),
      dailyRewardStreak: Number.isFinite(profile.dailyRewardStreak) ? Math.max(0, Math.floor(profile.dailyRewardStreak)) : 0,
      lastDailyRewardClaimDate:
        typeof profile.lastDailyRewardClaimDate === 'string' ? profile.lastDailyRewardClaimDate : null,
      bankroll: normalizeBankroll(profile.bankroll),
    }
  } catch {
    return null
  }
}

const writeLocalPlayerProfile = (profile: LocalPlayerProfile) => {
  if (typeof window === 'undefined') {
    return
  }

  window.localStorage.setItem(
    getLocalPlayerProfileStorageKey(profile.id),
    JSON.stringify({
      ...profile,
      bankroll: normalizeBankroll(profile.bankroll),
    }),
  )
}

const deleteLocalPlayerProfile = (playerId: string) => {
  if (typeof window === 'undefined') {
    return
  }

  window.localStorage.removeItem(getLocalPlayerProfileStorageKey(playerId))
}

const readPendingCashout = (playerId: string) => {
  if (typeof window === 'undefined') {
    return null
  }

  const savedPendingCashout = window.localStorage.getItem(getPendingCashoutStorageKey(playerId))

  if (!savedPendingCashout) {
    return null
  }

  try {
    return JSON.parse(savedPendingCashout) as PendingCashout
  } catch {
    return null
  }
}

const writePendingCashout = (pendingCashout: PendingCashout) => {
  if (typeof window === 'undefined') {
    return
  }

  window.localStorage.setItem(
    getPendingCashoutStorageKey(pendingCashout.playerId),
    JSON.stringify(pendingCashout),
  )
}

const clearPendingCashout = (playerId: string) => {
  if (typeof window === 'undefined') {
    return
  }

  window.localStorage.removeItem(getPendingCashoutStorageKey(playerId))
}

const listLocalPlayerProfiles = () => {
  if (typeof window === 'undefined') {
    return []
  }

  return Object.keys(window.localStorage)
    .filter((key) => key.startsWith(PLAYER_PROFILE_STORAGE_PREFIX))
    .map((key) => {
      try {
        const profile = JSON.parse(window.localStorage.getItem(key) ?? '') as LocalPlayerProfile
        return {
          ...profile,
          name: typeof profile.name === 'string' ? profile.name : '',
          nameLocked: Boolean((profile as LocalPlayerProfile & { nameLocked?: boolean }).nameLocked),
          skipStartScreen: Boolean(profile.skipStartScreen),
          dailyRewardStreak: Number.isFinite(profile.dailyRewardStreak) ? Math.max(0, Math.floor(profile.dailyRewardStreak)) : 0,
          lastDailyRewardClaimDate:
            typeof profile.lastDailyRewardClaimDate === 'string' ? profile.lastDailyRewardClaimDate : null,
          bankroll: normalizeBankroll(profile.bankroll),
        }
      } catch {
        return null
      }
    })
    .filter(Boolean) as LocalPlayerProfile[]
}

const getOrCreateLocalPlayerProfile = (): LocalPlayerProfile => {
  if (typeof window === 'undefined') {
    const timestamp = new Date().toISOString()
    return {
      id: createLocalPlayerId(),
      name: '',
      nameLocked: false,
      skipStartScreen: false,
      dailyRewardStreak: 0,
      lastDailyRewardClaimDate: null,
      bankroll: normalizeBankroll(BANKROLL),
      createdAt: timestamp,
      updatedAt: timestamp,
    }
  }

  const existingPlayerId = window.localStorage.getItem(PLAYER_ID_STORAGE_KEY)

  if (existingPlayerId) {
    const existingProfile = readLocalPlayerProfile(existingPlayerId)

    if (existingProfile) {
      return existingProfile
    }
  }

  const timestamp = new Date().toISOString()
  const nextProfile: LocalPlayerProfile = {
    id: createLocalPlayerId(),
    name: '',
    nameLocked: false,
    skipStartScreen: false,
    dailyRewardStreak: 0,
    lastDailyRewardClaimDate: null,
    bankroll: normalizeBankroll(BANKROLL),
    createdAt: timestamp,
    updatedAt: timestamp,
  }

  window.localStorage.setItem(PLAYER_ID_STORAGE_KEY, nextProfile.id)
  writeLocalPlayerProfile(nextProfile)
  return nextProfile
}

const getHiLoOdds = (
  deckCards: Card[],
  currentCard: Card | null,
  getCardNumericValue: (card: Card | null) => number,
) => {
  const currentValue = getCardNumericValue(currentCard)

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

  const higherCount = deckCards.filter((card) => getCardNumericValue(card) > currentValue).length
  const lowerCount = deckCards.filter((card) => getCardNumericValue(card) < currentValue).length
  const equalCount = deckCards.length - higherCount - lowerCount
  const higherProbability = higherCount / deckCards.length
  const lowerProbability = lowerCount / deckCards.length

  return {
    higherCount,
    lowerCount,
    equalCount,
    higherProbability,
    lowerProbability,
    higherStepMultiplier:
      higherProbability > 0 ? Number((HILO_HOUSE_EDGE / higherProbability).toFixed(2)) : 0,
    lowerStepMultiplier:
      lowerProbability > 0 ? Number((HILO_HOUSE_EDGE / lowerProbability).toFixed(2)) : 0,
  }
}

const roundMoney = (value: number) => Number(value.toFixed(2))
const formatPoints = (value: number) => `$${Math.round(value).toLocaleString()}`
const formatSignedPoints = (value: number) => {
  if (value === 0) {
    return '$0'
  }

  return `${value > 0 ? '+' : '-'}$${Math.abs(Math.round(value)).toLocaleString()}`
}

const getScoreChangeLabel = (value: number) =>
  value === 0 ? 'Bankroll unchanged' : `Bankroll ${formatSignedPoints(value)}`

// Layout position of an element within a positioned ancestor, via the offset
// chain. Transform-independent (ignores animation transforms), so it can be
// read mid-animation to aim a card at its real destination.
const offsetWithin = (element: HTMLElement | null, ancestor: Element | null) => {
  let x = 0
  let y = 0
  let node: HTMLElement | null = element
  while (node && node !== ancestor) {
    x += node.offsetLeft
    y += node.offsetTop
    node = node.offsetParent as HTMLElement | null
  }
  return { x, y }
}

// Ref callback for a blackjack card: point its deal keyframe at the shoe so it
// flips on the deck, then slides to where it actually sits in the hand.
const aimCardFromDeck = (element: HTMLElement | null) => {
  if (!element) {
    return
  }
  const felt = element.closest('.blackjack-table__felt') as HTMLElement | null
  const deck = felt?.querySelector('.blackjack-deck') as HTMLElement | null
  if (!felt || !deck) {
    return
  }
  const card = offsetWithin(element, felt)
  const shoe = offsetWithin(deck, felt)
  element.style.setProperty('--deal-dx', `${shoe.x - card.x}px`)
  element.style.setProperty('--deal-dy', `${shoe.y - card.y}px`)
}

const AnimatedMoney = ({ value }: { value: number }) => {
  const [display, setDisplay] = useState(value)
  const displayRef = useRef(value)
  const previousRef = useRef(value)
  const rafRef = useRef(0)
  const deltaIdRef = useRef(0)
  const [deltas, setDeltas] = useState<{ id: number; amount: number }[]>([])

  useEffect(() => {
    const from = displayRef.current
    const change = value - previousRef.current
    previousRef.current = value

    if (Math.abs(change) >= 1) {
      deltaIdRef.current += 1
      const id = deltaIdRef.current
      setDeltas((current) => [...current.slice(-3), { id, amount: change }])
      window.setTimeout(() => {
        setDeltas((current) => current.filter((delta) => delta.id !== id))
      }, 1400)
    }

    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (reduceMotion || Math.abs(value - from) < 1) {
      displayRef.current = value
      setDisplay(value)
      return
    }

    const start = performance.now()
    const duration = 650
    const tick = (now: number) => {
      const progress = Math.min(1, (now - start) / duration)
      const eased = 1 - Math.pow(1 - progress, 3)
      const next = from + (value - from) * eased
      displayRef.current = next
      setDisplay(next)
      if (progress < 1) {
        rafRef.current = window.requestAnimationFrame(tick)
      }
    }
    rafRef.current = window.requestAnimationFrame(tick)
    return () => window.cancelAnimationFrame(rafRef.current)
  }, [value])

  return (
    <span className="animated-money">
      {formatPoints(display)}
      <span className="animated-money__deltas" aria-hidden="true">
        {deltas.map((delta) => (
          <em
            key={delta.id}
            className={`money-delta ${delta.amount >= 0 ? 'money-delta--win' : 'money-delta--loss'}`}
          >
            {formatSignedPoints(delta.amount)}
          </em>
        ))}
      </span>
    </span>
  )
}

const SLOT_PAYTABLE: Record<SlotRegularSymbol, { 3: number; 4: number; 5: number }> = {
  dragon: { 3: 8, 4: 20, 5: 60 },
  crown: { 3: 5, 4: 12, 5: 30 },
  gem: { 3: 4, 4: 10, 5: 22 },
  lotus: { 3: 3, 4: 8, 5: 18 },
  moon: { 3: 2, 4: 6, 5: 14 },
}

const SLOT_SYMBOL_LABELS: Record<SlotRegularSymbol, string> = {
  dragon: 'DR',
  crown: 'CR',
  gem: 'GM',
  lotus: 'LT',
  moon: 'MN',
}

const SLOT_SYMBOL_POOL: SlotRegularSymbol[] = [
  'dragon',
  'dragon',
  'crown',
  'crown',
  'gem',
  'gem',
  'lotus',
  'lotus',
  'moon',
  'moon',
]

const getSlotJackpotValues = (betAmount: number) => ({
  mini: Math.max(20, betAmount * 10),
  minor: Math.max(100, betAmount * 30),
  major: Math.max(500, betAmount * 120),
  grand: Math.max(5000, betAmount * 1000),
})

const createInitialSlotsGrid = (): SlotCell[][] =>
  Array.from({ length: SLOT_ROWS }, (_, rowIndex) =>
    Array.from({ length: SLOT_COLUMNS }, (_, columnIndex) => ({
      kind: 'symbol' as const,
      symbol: SLOT_SYMBOL_POOL[(rowIndex + columnIndex) % SLOT_SYMBOL_POOL.length],
    })),
  )

const getRandomSlotSymbol = () => SLOT_SYMBOL_POOL[Math.floor(Math.random() * SLOT_SYMBOL_POOL.length)]

const getRandomSlotOrb = (betAmount: number): SlotCell => {
  const jackpotRoll = Math.random()

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
  const multiplier = orbMultipliers[Math.floor(Math.random() * orbMultipliers.length)]

  return {
    kind: 'orb',
    value: betAmount * multiplier,
    jackpot: null,
  }
}

const createSlotsSpinGrid = (betAmount: number): SlotCell[][] =>
  Array.from({ length: SLOT_ROWS }, () =>
    Array.from({ length: SLOT_COLUMNS }, () =>
      Math.random() < 0.24 ? getRandomSlotOrb(betAmount) : { kind: 'symbol' as const, symbol: getRandomSlotSymbol() },
    ),
  )

const createSlotsSpinTopRow = (betAmount: number): SlotCell[] =>
  Array.from({ length: SLOT_COLUMNS }, () =>
    Math.random() < 0.24 ? getRandomSlotOrb(betAmount) : { kind: 'symbol' as const, symbol: getRandomSlotSymbol() },
  )

// Reel choreography: the final grid is decided before the animation starts,
// so what the reels settle on is always exactly what pays out.
const SLOTS_REEL_STOP_DELAYS_MS = [1050, 1600, 2150, 2700, 3450]
const SLOTS_REEL_SETTLE_MS = 640
const SLOTS_REEL_LOOP_CELLS = 6

const createSlotsFinalGrid = (betAmount: number): SlotCell[][] =>
  Array.from({ length: SLOT_ROWS }, () => createSlotsSpinTopRow(betAmount))

const createSlotsReelFiller = (): SlotCell[] =>
  Array.from({ length: SLOTS_REEL_LOOP_CELLS }, () => ({
    kind: 'symbol' as const,
    symbol: getRandomSlotSymbol(),
  }))

const getSlotsWinningCells = (grid: SlotCell[][]): boolean[][] => {
  const winning = Array.from({ length: SLOT_ROWS }, () =>
    Array.from({ length: SLOT_COLUMNS }, () => false),
  )

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

const countSlotsBonusSymbols = (grid: SlotCell[][]) =>
  grid.flat().filter((cell) => cell.kind === 'orb').length

const calculateSlotsLinePayout = (grid: SlotCell[][], betAmount: number) => {
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

const createSlotsBonusGridFromSpin = (grid: SlotCell[][]): (SlotCell | null)[][] =>
  grid.map((row) => row.map((cell) => (cell.kind === 'orb' ? cell : null)))

const respinSlotsBonusGrid = (
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
    if (Math.random() < 0.16) {
      nextGrid[rowIndex][columnIndex] = getRandomSlotOrb(betAmount)
      newOrbCount += 1
    }
  })

  if (newOrbCount === 0 && emptySpots.length > 0 && Math.random() < 0.35) {
    const guaranteedSpot = emptySpots[Math.floor(Math.random() * emptySpots.length)]
    nextGrid[guaranteedSpot.rowIndex][guaranteedSpot.columnIndex] = getRandomSlotOrb(betAmount)
    newOrbCount = 1
  }

  return { nextGrid, newOrbCount }
}

const calculateSlotsBonusPayout = (
  bonusGrid: (SlotCell | null)[][],
  betAmount: number,
) => {
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

  return {
    totalPayout,
    orbValueTotal,
    miniCount,
    minorCount,
    majorCount,
    hitGrand,
  }
}

const CasinoStatisticsChart = ({ stats }: { stats: CasinoDailyStat[] }) => {
  const [hoveredPoint, setHoveredPoint] = useState<{
    date: string
    amount: number
    x: number
    y: number
  } | null>(null)
  const chartStats =
    stats.length > 0
      ? stats
      : [
          {
            date: getCasinoStatDateKey(),
            amount: 0,
          },
        ]
  const width = 760
  const height = 280
  const paddingX = 34
  const paddingY = 26
  const usableWidth = width - paddingX * 2
  const usableHeight = height - paddingY * 2
  const halfHeight = usableHeight / 2
  const maxAbs = Math.max(1, ...chartStats.map((entry) => Math.abs(entry.amount)))

  const points = chartStats.map((entry, index) => {
    const x =
      chartStats.length === 1
        ? width / 2
        : paddingX + (usableWidth * index) / (chartStats.length - 1)
    const y = paddingY + halfHeight - (entry.amount / maxAbs) * halfHeight
    return { ...entry, x, y }
  })

  const zeroY = paddingY + halfHeight
  const getPointColor = (amount: number) =>
    amount > 0 ? '#50d68a' : amount < 0 ? '#e0626f' : '#e5a84e'

  return (
    <div className="casino-stats">
      <div className="casino-stats__legend">
        <span className="casino-stats__legend-item casino-stats__legend-item--positive">Positive</span>
        <span className="casino-stats__legend-item casino-stats__legend-item--zero">Zero</span>
        <span className="casino-stats__legend-item casino-stats__legend-item--negative">Negative</span>
      </div>
      <div className="casino-stats__chart-wrap">
        {hoveredPoint ? (
          <div
            className="casino-stats__tooltip"
            style={{
              left: `${(hoveredPoint.x / width) * 100}%`,
              top: `${(hoveredPoint.y / height) * 100}%`,
            }}
          >
            <strong>{hoveredPoint.date}</strong>
            <span>
              {hoveredPoint.amount > 0
                ? `House +$${Math.abs(hoveredPoint.amount).toLocaleString()}`
                : hoveredPoint.amount < 0
                  ? `House -$${Math.abs(hoveredPoint.amount).toLocaleString()}`
                  : 'House $0'}
            </span>
          </div>
        ) : null}
        <svg
          viewBox={`0 0 ${width} ${height}`}
          className="casino-stats__chart"
          role="img"
          aria-label="Casino profit by day"
        >
          <line
            x1={paddingX}
            y1={zeroY}
            x2={width - paddingX}
            y2={zeroY}
            className="casino-stats__zero-line"
          />
          <line
            x1={paddingX}
            y1={paddingY}
            x2={paddingX}
            y2={height - paddingY}
            className="casino-stats__axis"
          />
          {points.map((point, index) => {
            if (index === 0) {
              return null
            }

            const previous = points[index - 1]

            if (previous.amount === point.amount) {
              return (
                <line
                  key={`${previous.date}-${point.date}`}
                  x1={previous.x}
                  y1={previous.y}
                  x2={point.x}
                  y2={point.y}
                  stroke={getPointColor(point.amount)}
                  strokeWidth="4"
                  strokeLinecap="round"
                />
              )
            }

            if (
              (previous.amount >= 0 && point.amount >= 0) ||
              (previous.amount <= 0 && point.amount <= 0)
            ) {
              return (
                <line
                  key={`${previous.date}-${point.date}`}
                  x1={previous.x}
                  y1={previous.y}
                  x2={point.x}
                  y2={point.y}
                  stroke={getPointColor((previous.amount + point.amount) / 2)}
                  strokeWidth="4"
                  strokeLinecap="round"
                />
              )
            }

            const ratio = Math.abs(previous.amount) / (Math.abs(previous.amount) + Math.abs(point.amount))
            const midX = previous.x + (point.x - previous.x) * ratio

            return (
              <g key={`${previous.date}-${point.date}`}>
                <line
                  x1={previous.x}
                  y1={previous.y}
                  x2={midX}
                  y2={zeroY}
                  stroke={getPointColor(previous.amount)}
                  strokeWidth="4"
                  strokeLinecap="round"
                />
                <line
                  x1={midX}
                  y1={zeroY}
                  x2={point.x}
                  y2={point.y}
                  stroke={getPointColor(point.amount)}
                  strokeWidth="4"
                  strokeLinecap="round"
                />
              </g>
            )
          })}
          {points.map((point) => (
            <g
              key={point.date}
              onMouseEnter={() => {
                setHoveredPoint(point)
              }}
              onMouseLeave={() => {
                setHoveredPoint((current) => (current?.date === point.date ? null : current))
              }}
            >
              <circle cx={point.x} cy={point.y} r="6" fill={getPointColor(point.amount)} />
              <circle cx={point.x} cy={point.y} r="14" fill="transparent" />
              <text x={point.x} y={height - 6} textAnchor="middle" className="casino-stats__date-label">
                {point.date.slice(5)}
              </text>
            </g>
          ))}
          <text x={10} y={paddingY + 10} className="casino-stats__axis-label">
            +
          </text>
          <text x={10} y={zeroY + 5} className="casino-stats__axis-label">
            0
          </text>
          <text x={10} y={height - paddingY} className="casino-stats__axis-label">
            -
          </text>
        </svg>
      </div>
    </div>
  )
}

const getPlinkoCenterBiasForWinStreak = (winStreak: number) => {
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

const createPokerRoomCode = () =>
  Array.from({ length: 4 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.floor(Math.random() * 32)]).join('')

const getPokerRoomDocRef = (code: string) => {
  if (!firestore) {
    return null
  }

  return doc(firestore, 'pokerRooms', code)
}

const readPokerRoom = async (code: string) => {
  const roomRef = getPokerRoomDocRef(code)

  if (!roomRef) {
    return null
  }

  const roomSnapshot = await getDoc(roomRef)
  return roomSnapshot.exists() ? (roomSnapshot.data() as PokerRoomState) : null
}

const writePokerRoom = async (room: PokerRoomState) => {
  const roomRef = getPokerRoomDocRef(room.code)

  if (!roomRef) {
    return
  }

  // the rules only accept poker writes from a signed-in (silent) session
  await ensurePlayerSession()
  await setDoc(roomRef, room)
}

const getPokerRoomMessage = (playerCount: number) =>
  playerCount >= 2
    ? 'Enough players are seated to start.'
    : `Waiting for ${2 - playerCount} more player${2 - playerCount === 1 ? '' : 's'} to join before the game can start.`

const getPokerRankValue = (rank: string) => {
  if (rank === 'A') {
    return 14
  }

  if (rank === 'K') {
    return 13
  }

  if (rank === 'Q') {
    return 12
  }

  if (rank === 'J') {
    return 11
  }

  return Number(rank)
}

const comparePokerScores = (left: number[], right: number[]) => {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0)

    if (difference !== 0) {
      return difference
    }
  }

  return 0
}

const getStraightHighCard = (values: number[]) => {
  const uniqueValues = Array.from(new Set(values)).sort((left, right) => right - left)

  if (uniqueValues.includes(14)) {
    uniqueValues.push(1)
  }

  for (let index = 0; index <= uniqueValues.length - 5; index += 1) {
    const window = uniqueValues.slice(index, index + 5)

    if (window[0] - window[4] === 4) {
      return window[0] === 1 ? 5 : window[0]
    }
  }

  return 0
}

const evaluateFiveCardPokerHand = (cards: Card[]) => {
  const values = cards.map((card) => getPokerRankValue(card.rank)).sort((left, right) => right - left)
  const suitCounts = cards.reduce<Record<string, number>>((counts, card) => {
    counts[card.suit] = (counts[card.suit] ?? 0) + 1
    return counts
  }, {})
  const isFlush = Object.values(suitCounts).some((count) => count === 5)
  const straightHigh = getStraightHighCard(values)
  const counts = values.reduce<Record<number, number>>((result, value) => {
    result[value] = (result[value] ?? 0) + 1
    return result
  }, {})
  const groupedValues = Object.entries(counts)
    .map(([value, count]) => ({ value: Number(value), count }))
    .sort((left, right) => {
      if (right.count !== left.count) {
        return right.count - left.count
      }

      return right.value - left.value
    })

  if (isFlush && straightHigh > 0) {
    return [8, straightHigh]
  }

  if (groupedValues[0]?.count === 4) {
    return [7, groupedValues[0].value, groupedValues[1].value]
  }

  if (groupedValues[0]?.count === 3 && groupedValues[1]?.count === 2) {
    return [6, groupedValues[0].value, groupedValues[1].value]
  }

  if (isFlush) {
    return [5, ...values]
  }

  if (straightHigh > 0) {
    return [4, straightHigh]
  }

  if (groupedValues[0]?.count === 3) {
    return [3, groupedValues[0].value, ...groupedValues.slice(1).map((entry) => entry.value)]
  }

  if (groupedValues[0]?.count === 2 && groupedValues[1]?.count === 2) {
    const highPair = Math.max(groupedValues[0].value, groupedValues[1].value)
    const lowPair = Math.min(groupedValues[0].value, groupedValues[1].value)
    return [2, highPair, lowPair, groupedValues[2].value]
  }

  if (groupedValues[0]?.count === 2) {
    return [1, groupedValues[0].value, ...groupedValues.slice(1).map((entry) => entry.value)]
  }

  return [0, ...values]
}

const evaluateBestPokerHand = (cards: Card[]) => {
  let bestScore: number[] = [-1]

  for (let first = 0; first < cards.length - 4; first += 1) {
    for (let second = first + 1; second < cards.length - 3; second += 1) {
      for (let third = second + 1; third < cards.length - 2; third += 1) {
        for (let fourth = third + 1; fourth < cards.length - 1; fourth += 1) {
          for (let fifth = fourth + 1; fifth < cards.length; fifth += 1) {
            const nextScore = evaluateFiveCardPokerHand([
              cards[first],
              cards[second],
              cards[third],
              cards[fourth],
              cards[fifth],
            ])

            if (comparePokerScores(nextScore, bestScore) > 0) {
              bestScore = nextScore
            }
          }
        }
      }
    }
  }

  return bestScore
}

const getOccupiedPokerSeatIndexes = (seats: (PokerSeat | null)[]) =>
  seats.reduce<number[]>((indexes, seat, index) => {
    if (seat) {
      indexes.push(index)
    }

    return indexes
  }, [])

const getNextPokerSeatIndex = (
  seats: (PokerSeat | null)[],
  startIndex: number,
  predicate: (seat: PokerSeat | null, index: number) => boolean,
) => {
  for (let step = 1; step <= seats.length; step += 1) {
    const nextIndex = (startIndex + step) % seats.length

    if (predicate(seats[nextIndex], nextIndex)) {
      return nextIndex
    }
  }

  return -1
}

const getPokerBlindSeatIndexes = (
  seats: (PokerSeat | null)[],
  dealerSeatIndex: number,
  players: Record<string, PokerPlayerState>,
) => {
  const occupiedIndexes = getOccupiedPokerSeatIndexes(seats)

  if (dealerSeatIndex < 0 || occupiedIndexes.length === 0) {
    return {
      smallBlindSeatIndex: -1,
      bigBlindSeatIndex: -1,
    }
  }

  if (occupiedIndexes.length === 2) {
    return {
      smallBlindSeatIndex: dealerSeatIndex,
      bigBlindSeatIndex: getNextPokerSeatIndex(seats, dealerSeatIndex, (seat) =>
        Boolean(seat && players[seat.id]),
      ),
    }
  }

  const smallBlindSeatIndex = getNextPokerSeatIndex(seats, dealerSeatIndex, (seat) =>
    Boolean(seat && players[seat.id]),
  )
  const bigBlindSeatIndex =
    occupiedIndexes.length > 2
      ? getNextPokerSeatIndex(seats, smallBlindSeatIndex, (seat) => Boolean(seat && players[seat.id]))
      : smallBlindSeatIndex

  return {
    smallBlindSeatIndex,
    bigBlindSeatIndex,
  }
}

const getPokerAmountToCall = ({
  seats,
  dealerSeatIndex,
  players,
  currentBet,
  street,
  smallBlind,
  seatIndex,
  seatId,
}: {
  seats: (PokerSeat | null)[]
  dealerSeatIndex: number
  players: Record<string, PokerPlayerState>
  currentBet: number
  street: PokerStreet
  smallBlind: number
  seatIndex: number
  seatId: string
}) => {
  const playerState = players[seatId]

  if (!playerState) {
    return 0
  }

  const occupiedIndexes = getOccupiedPokerSeatIndexes(seats)
  const standardAmountToCall = Math.max(0, currentBet - playerState.committed)

  if (occupiedIndexes.length !== 2 || street !== 'preflop') {
    return standardAmountToCall
  }

  const { smallBlindSeatIndex } = getPokerBlindSeatIndexes(seats, dealerSeatIndex, players)

  if (seatIndex !== smallBlindSeatIndex) {
    return standardAmountToCall
  }

  const expectedSmallBlindCommit = Math.min(smallBlind, playerState.committed + playerState.chips)
  const effectiveCommitted = Math.max(playerState.committed, expectedSmallBlindCommit)

  return Math.max(0, currentBet - effectiveCommitted)
}

const getPokerChipTokens = (amount: number) => {
  let remaining = Math.max(0, Math.round(amount))
  const chips: { color: string; label: string }[] = []

  for (const denomination of POKER_CHIP_DENOMINATIONS) {
    while (remaining >= denomination.value && chips.length < 8) {
      chips.push({ color: denomination.color, label: String(denomination.value) })
      remaining -= denomination.value
    }
  }

  if (chips.length === 0 && amount > 0) {
    chips.push({ color: 'white', label: String(amount) })
  }

  return chips
}

const startPokerHand = (room: PokerRoomState) => {
  const occupiedIndexes = getOccupiedPokerSeatIndexes(room.seats)
  const nextDealerSeatIndex =
    room.dealerSeatIndex >= 0
      ? getNextPokerSeatIndex(room.seats, room.dealerSeatIndex, (seat) => Boolean(seat))
      : occupiedIndexes[0] ?? -1
  const freshDeck = createShuffledDeck()
  const players: Record<string, PokerPlayerState> = {}
  let workingDeck = [...freshDeck]

  occupiedIndexes.forEach((seatIndex) => {
    const seat = room.seats[seatIndex]

    if (!seat) {
      return
    }

    const { drawnCards, remainingDeck } = drawCards(workingDeck, 2)
    workingDeck = remainingDeck
    players[seat.id] = {
      chips: room.playerChips[seat.id] ?? 0,
      holeCards: drawnCards,
      folded: false,
      allIn: false,
      committed: 0,
      acted: false,
    }
  })

  const { smallBlindSeatIndex, bigBlindSeatIndex } = getPokerBlindSeatIndexes(
    room.seats,
    nextDealerSeatIndex,
    players,
  )

  let pot = 0
  let currentBet = 0

  if (smallBlindSeatIndex !== -1) {
    const smallBlindSeat = room.seats[smallBlindSeatIndex]

    if (smallBlindSeat) {
      const postedSmallBlind = Math.min(room.smallBlind, players[smallBlindSeat.id].chips)
      players[smallBlindSeat.id] = {
        ...players[smallBlindSeat.id],
        chips: players[smallBlindSeat.id].chips - postedSmallBlind,
        committed: postedSmallBlind,
        allIn: players[smallBlindSeat.id].chips === postedSmallBlind,
      }
      pot += postedSmallBlind
      currentBet = postedSmallBlind
    }
  }

  if (bigBlindSeatIndex !== -1) {
    const bigBlindSeat = room.seats[bigBlindSeatIndex]

    if (bigBlindSeat) {
      const postedBigBlind = Math.min(room.bigBlind, players[bigBlindSeat.id].chips)
      players[bigBlindSeat.id] = {
        ...players[bigBlindSeat.id],
        chips: players[bigBlindSeat.id].chips - postedBigBlind,
        committed: postedBigBlind,
        allIn: players[bigBlindSeat.id].chips === postedBigBlind,
      }
      pot += postedBigBlind
      currentBet = Math.max(currentBet, postedBigBlind)
    }
  }

  const activeSeatIndex = getNextPokerSeatIndex(
    room.seats,
    bigBlindSeatIndex === -1 ? nextDealerSeatIndex : bigBlindSeatIndex,
    (seat) => Boolean(seat && players[seat.id] && players[seat.id].chips > 0),
  )

  return {
    ...room,
    playerChips: Object.fromEntries(
      room.seats
        .filter(Boolean)
        .map((seat) => [seat!.id, players[seat!.id]?.chips ?? room.playerChips[seat!.id] ?? 0]),
    ),
    dealerSeatIndex: nextDealerSeatIndex,
    game: {
      street: 'preflop' as PokerStreet,
      activeSeatIndex,
      currentBet,
      pot,
      communityCards: [],
      deck: workingDeck,
      players,
      actionId: (room.game?.actionId ?? 0) + 1,
      lastActorId: null,
      lastActionType: 'blind' as PokerActionType,
      lastContributions: [
        ...(smallBlindSeatIndex !== -1 && room.seats[smallBlindSeatIndex]
          ? [{ playerId: room.seats[smallBlindSeatIndex]!.id, amount: Math.min(room.smallBlind, room.playerChips[room.seats[smallBlindSeatIndex]!.id] ?? 0) }]
          : []),
        ...(bigBlindSeatIndex !== -1 && room.seats[bigBlindSeatIndex]
          ? [{ playerId: room.seats[bigBlindSeatIndex]!.id, amount: Math.min(room.bigBlind, room.playerChips[room.seats[bigBlindSeatIndex]!.id] ?? 0) }]
          : []),
      ].filter((entry) => entry.amount > 0),
      lastAction: `Blinds posted: small blind $${room.smallBlind}, big blind $${room.bigBlind}.`,
      winnerMessage: null,
    },
  }
}

const createMinesBoard = (mineCount: number) => {
  const mineIds = new Set<number>()

  while (mineIds.size < mineCount) {
    mineIds.add(Math.floor(Math.random() * MINES_TILE_COUNT))
  }

  return Array.from({ length: MINES_TILE_COUNT }, (_, index) => ({
    id: index,
    isMine: mineIds.has(index),
    revealed: false,
  }))
}

const getMinesMultiplier = (safePickCount: number, mineCount: number) => {
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

const clampDiceTarget = (value: number) =>
  Math.min(DICE_MAX_TOTAL, Math.max(DICE_MIN_TOTAL, Math.round(value)))

const rollTwentyDice = () => Array.from({ length: DICE_COUNT }, () => Math.floor(Math.random() * 6) + 1)

const getDiceTotal = (values: number[]) => values.reduce((sum, value) => sum + value, 0)

const getDiceWinChance = (target: number, mode: DiceMode) => {
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

const getDiceMultiplier = (target: number, mode: DiceMode) => {
  const winChance = getDiceWinChance(target, mode)

  if (winChance <= 0) {
    return 0
  }

  const fairMultiplier = (1 - DICE_HOUSE_EDGE) / winChance
  const clamped = Math.min(DICE_MAX_MULTIPLIER, Math.max(DICE_MIN_MULTIPLIER, fairMultiplier))
  return Number(clamped.toFixed(2))
}

const getDiceWinChanceLabel = (winChance: number) => {
  const percent = winChance * 100

  if (percent <= 0) {
    return '0.00%'
  }

  if (percent < 0.01) {
    return '<0.01%'
  }

  if (percent < 1) {
    return `${percent.toFixed(3)}%`
  }

  // You can always lose, so never show a full 100% — cap the display at 99.9%.
  if (percent >= 99.9) {
    return '99.90%'
  }

  if (percent > 99) {
    return `${percent.toFixed(3)}%`
  }

  return `${percent.toFixed(2)}%`
}

const getDailyRewardAmountForDay = (streakDay: number) => {
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

const getDateKeyDistance = (leftKey: string, rightKey: string) => {
  const [leftYear, leftMonth, leftDay] = leftKey.split('-').map(Number)
  const [rightYear, rightMonth, rightDay] = rightKey.split('-').map(Number)
  const leftDate = new Date(leftYear, leftMonth - 1, leftDay)
  const rightDate = new Date(rightYear, rightMonth - 1, rightDay)
  const millisecondsPerDay = 24 * 60 * 60 * 1000

  return Math.round((leftDate.getTime() - rightDate.getTime()) / millisecondsPerDay)
}

const DICE_PIPS_BY_VALUE: Record<number, number[]> = {
  1: [5],
  2: [1, 9],
  3: [1, 5, 9],
  4: [1, 3, 7, 9],
  5: [1, 3, 5, 7, 9],
  6: [1, 3, 4, 6, 7, 9],
}

const DAILY_REWARD_WEEK_ONE = [10, 20, 35, 55, 80, 100, 250]

const renderDiceFace = (value: number, key: string) => {
  const activePips = DICE_PIPS_BY_VALUE[value] ?? []

  return (
    <div className={`dice-face${value ? '' : ' dice-face--hidden'}`} key={key}>
      <div className="dice-face__grid">
        {Array.from({ length: 9 }, (_, index) => (
          <span
            className={`dice-face__pip${activePips.includes(index + 1) ? ' dice-face__pip--active' : ''}`}
            key={`${key}-${index}`}
          />
        ))}
      </div>
      {value ? <strong className="dice-face__value">{value}</strong> : null}
    </div>
  )
}

const renderAnimatedDiceFace = (value: number, key: string, rolling: boolean, frame: number) => (
  <div className={rolling ? 'dice-face-wrap dice-face-wrap--rolling' : 'dice-face-wrap'} key={key}>
    {renderDiceFace(value, `${key}-${frame}`)}
  </div>
)

const finishDealerHand = (startingHand: Card[], currentDeck: Card[]) => {
  let dealerCards = [...startingHand]
  let deckAfterDraw = [...currentDeck]

  while (getHandValue(dealerCards) < 17) {
    const { drawnCards, remainingDeck } = drawCards(deckAfterDraw, 1)
    dealerCards = [...dealerCards, drawnCards[0]]
    deckAfterDraw = remainingDeck
  }

  return { finalDealerHand: dealerCards, remainingDeck: deckAfterDraw }
}

const getRoundResult = (
  playerHands: Card[][],
  dealer: Card[],
  handBets: number[],
): RoundResult => {
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

// Google's four-colour "G", drawn inline for the sign-in buttons
function GoogleMark() {
  return (
    <svg className="dev-auth__mark" viewBox="0 0 48 48" aria-hidden="true" focusable="false">
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
    </svg>
  )
}

function App() {
  const ROULETTE_SPIN_DURATION_MS = 7000
  const TRACKED_CASINO_GAMES: CasinoTrackedGame[] = ['blackjack', 'roulette', 'hilo', 'mines', 'plinko', 'slots', 'dice', 'chicken', 'jetstream']
  const getCasinoTrackedGameLabel = (game: CasinoTrackedGame) =>
    ({
      blackjack: 'Blackjack',
      roulette: 'Roulette',
      hilo: 'Hi-Lo',
      mines: 'Mines',
      plinko: 'Plinko',
      slots: 'Slots',
      dice: 'Dice',
      chicken: 'Chicken Cross',
      jetstream: 'Jetstream',
    })[game]

  const [playerProfile, setPlayerProfile] = useState<LocalPlayerProfile>(() =>
    getOrCreateLocalPlayerProfile(),
  )
  const [bet, setBet] = useState(MIN_BET)
  const [selectedGame, setSelectedGame] = useState<
    | 'lobby'
    | 'options'
    | 'blackjack'
    | 'roulette'
    | 'hilo'
    | 'mines'
    | 'poker'
    | 'settings'
    | 'settings-players'
    | 'settings-player-detail'
    | 'settings-statistics'
    | 'settings-statistics-game'
    | 'slots'
    | 'plinko'
    | 'dice'
    | 'chicken'
    | 'jetstream'
  >(() => 'lobby')
  const [bankroll, setBankrollState] = useState(() =>
    normalizeBankroll(getOrCreateLocalPlayerProfile().bankroll),
  )
  const [optionsNameInput, setOptionsNameInput] = useState(() => getOrCreateLocalPlayerProfile().name || '')
  const [optionsTab, setOptionsTab] = useState<'settings' | 'statistics'>('settings')
  const [playerHands, setPlayerHands] = useState<Card[][]>([])
  const [handBets, setHandBets] = useState<number[]>([])
  const [completedHands, setCompletedHands] = useState<boolean[]>([])
  const [activeHandIndex, setActiveHandIndex] = useState(0)
  const [dealerHand, setDealerHand] = useState<Card[]>([])
  const [deck, setDeck] = useState<Card[]>([])
  const [dealerRevealed, setDealerRevealed] = useState(false)
  const [roundResult, setRoundResult] = useState<RoundResult | null>(null)
  const [betInput, setBetInput] = useState(String(MIN_BET))
  const [betInputError, setBetInputError] = useState('')
  const [rouletteBets, setRouletteBets] = useState<RouletteBetSlip[]>([])
  const [rouletteWinningNumber, setRouletteWinningNumber] = useState<RoulettePocket | null>(null)
  const [rouletteResult, setRouletteResult] = useState<RoundResult | null>(null)
  const [rouletteBallAngle, setRouletteBallAngle] = useState(0)
  const [rouletteIsSpinning, setRouletteIsSpinning] = useState(false)
  const rouletteWheelRef = useRef<HTMLDivElement | null>(null)
  const rouletteBallRef = useRef<HTMLDivElement | null>(null)
  const rouletteSpinPoseRef = useRef<RouletteSpinPose>({ wheel: 0, ball: 0, radius: ROULETTE_TRACK_RADIUS })
  const [hiLoDeck, setHiLoDeck] = useState<Card[]>([])
  const [hiLoCurrentCard, setHiLoCurrentCard] = useState<Card | null>(null)
  const [hiLoUpcomingCard, setHiLoUpcomingCard] = useState<Card | null>(null)
  const [hiLoNextCard, setHiLoNextCard] = useState<Card | null>(null)
  const [hiLoGuess, setHiLoGuess] = useState<'higher' | 'lower' | null>(null)
  const [hiLoResult, setHiLoResult] = useState<RoundResult | null>(null)
  const [hiLoStreak, setHiLoStreak] = useState(0)
  const [hiLoMultiplier, setHiLoMultiplier] = useState(1)
  const [hiLoMessage, setHiLoMessage] = useState('Set your bet, then reveal the first card.')
  const [hiLoResolving, setHiLoResolving] = useState(false)
  const [hiLoSliding, setHiLoSliding] = useState(false)
  const [minesBoard, setMinesBoard] = useState<MinesTile[]>([])
  const [minesCount, setMinesCount] = useState(DEFAULT_MINES_COUNT)
  const [minesCountInput, setMinesCountInput] = useState(String(DEFAULT_MINES_COUNT))
  const [minesSafePicks, setMinesSafePicks] = useState(0)
  const [minesResult, setMinesResult] = useState<RoundResult | null>(null)
  const [minesMessage, setMinesMessage] = useState('Set your bet, then step onto the minefield.')
  const [minesRoundActive, setMinesRoundActive] = useState(false)
  const [pendingPlinkoDrops, setPendingPlinkoDrops] = useState<PendingPlinkoDrop[]>([])
  const [plinkoHistory, setPlinkoHistory] = useState<PlinkoRound[]>([])
  const [plinkoInFlightDrops, setPlinkoInFlightDrops] = useState(0)
  const [plinkoMessage, setPlinkoMessage] = useState('Set your bet, then drop a ball down the board.')
  const [plinkoResult, setPlinkoResult] = useState<PlinkoRound | null>(null)
  const [plinkoWinStreak, setPlinkoWinStreak] = useState(0)
  const [chickenDifficulty, setChickenDifficulty] = useState<ChickenDifficulty>('easy')
  const [chickenStatus, setChickenStatus] = useState<ChickenStatus>('idle')
  const [chickenLane, setChickenLane] = useState(0)
  const [chickenBet, setChickenBet] = useState(0)
  const [chickenDeathLane, setChickenDeathLane] = useState<number | null>(null)
  const [chickenMessage, setChickenMessage] = useState('Pick a difficulty, set your bet, and start crossing.')
  const [chickenResult, setChickenResult] = useState<ChickenRound | null>(null)
  const [chickenHistory, setChickenHistory] = useState<ChickenRound[]>([])
  const [fullscreenTopOffset, setFullscreenTopOffset] = useState(64)
  const chickenHopLockRef = useRef(false)

  // Keep fullscreen game overlays (chicken, jetstream) docked below the top header.
  useEffect(() => {
    if (selectedGame !== 'chicken' && selectedGame !== 'jetstream') return
    const measure = () => {
      const hero = document.querySelector('.hero') as HTMLElement | null
      const bottom = hero ? hero.getBoundingClientRect().bottom : 64
      setFullscreenTopOffset(Math.max(0, Math.round(bottom)))
    }
    measure()
    window.addEventListener('resize', measure)
    const raf = window.requestAnimationFrame(measure)
    return () => {
      window.removeEventListener('resize', measure)
      window.cancelAnimationFrame(raf)
    }
  }, [selectedGame])
  const [jetstreamStatus, setJetstreamStatus] = useState<JetstreamStatus>('idle')
  const [jetstreamBet, setJetstreamBet] = useState(0)
  const [jetstreamSpeed, setJetstreamSpeed] = useState<JetSpeed>('normal')
  const [jetstreamFlight, setJetstreamFlight] = useState<JetFlight | null>(null)
  const [jetstreamMessage, setJetstreamMessage] = useState('Pick a speed, set your bet and press Play.')
  const [jetstreamResult, setJetstreamResult] = useState<JetstreamRound | null>(null)
  const [jetstreamHistory, setJetstreamHistory] = useState<JetstreamRound[]>([])
  // the flight in the air and its stake; settled exactly once
  const jetstreamPendingRef = useRef<{ flight: JetFlight; bet: number } | null>(null)
  const [slotsGrid, setSlotsGrid] = useState<SlotCell[][]>(() => createInitialSlotsGrid())
  const [slotsBonusGrid, setSlotsBonusGrid] = useState<(SlotCell | null)[][]>(() =>
    createSlotsBonusGridFromSpin(createInitialSlotsGrid()),
  )
  const [slotsMessage, setSlotsMessage] = useState('Set your bet, then spin the reels.')
  const [slotsResult, setSlotsResult] = useState<RoundResult | null>(null)
  const [slotsSpinning, setSlotsSpinning] = useState(false)
  const [slotsStoppedColumns, setSlotsStoppedColumns] = useState<boolean[]>(
    () => Array.from({ length: SLOT_COLUMNS }, () => false),
  )
  const [slotsSpinTarget, setSlotsSpinTarget] = useState<{
    token: number
    fromGrid: (SlotCell | null)[][]
    finalGrid: (SlotCell | null)[][]
    fillers: SlotCell[][]
  } | null>(null)
  const [slotsWinningCells, setSlotsWinningCells] = useState<boolean[][] | null>(null)
  const [slotsBonusActive, setSlotsBonusActive] = useState(false)
  const [slotsBonusRespins, setSlotsBonusRespins] = useState(3)
  const [slotsBonusBasePayout, setSlotsBonusBasePayout] = useState(0)
  const [slotsBonusBet, setSlotsBonusBet] = useState(0)
  const [diceValues, setDiceValues] = useState<number[]>([])
  const [diceMode, setDiceMode] = useState<DiceMode>('lower')
  const [diceTarget, setDiceTarget] = useState(70)
  const [diceResult, setDiceResult] = useState<RoundResult | null>(null)
  const [diceMessage, setDiceMessage] = useState('Pick a side, move the target, then roll all 20 dice.')
  const [diceRolling, setDiceRolling] = useState(false)
  const [diceRollFrame, setDiceRollFrame] = useState(0)
  const [pokerPlayerId] = useState(() => {
    if (typeof window === 'undefined') {
      return `player-${Math.random().toString(36).slice(2, 10)}`
    }

    const existingPlayerId = window.sessionStorage.getItem(POKER_PLAYER_SESSION_KEY)

    if (existingPlayerId) {
      return existingPlayerId
    }

    const nextPlayerId = `player-${Math.random().toString(36).slice(2, 10)}`
    window.sessionStorage.setItem(POKER_PLAYER_SESSION_KEY, nextPlayerId)
    return nextPlayerId
  })
  const [pokerMode, setPokerMode] = useState<'choose' | 'join' | 'create'>('choose')
  const [pokerScreen, setPokerScreen] = useState<'entry' | 'table'>('entry')
  const [pokerName, setPokerName] = useState('')
  const [pokerCode, setPokerCode] = useState('')
  const [pokerRoomCode, setPokerRoomCode] = useState('')
  const [pokerHostId, setPokerHostId] = useState('')
  const [pokerDealerSeatIndex, setPokerDealerSeatIndex] = useState(-1)
  const [pokerPlayerChips, setPokerPlayerChips] = useState<Record<string, number>>({})
  const [pokerSeats, setPokerSeats] = useState<(PokerSeat | null)[]>(Array.from({ length: 6 }, () => null))
  const [pokerGame, setPokerGame] = useState<PokerGameState | null>(null)
  const [pokerPendingStart, setPokerPendingStart] = useState<PokerPendingStart | null>(null)
  const [pokerBuyIn, setPokerBuyIn] = useState(1000)
  const [pokerBuyInInput, setPokerBuyInInput] = useState('1000')
  const [pokerSmallBlind, setPokerSmallBlind] = useState(DEFAULT_SMALL_BLIND)
  const [pokerSmallBlindInput, setPokerSmallBlindInput] = useState(String(DEFAULT_SMALL_BLIND))
  const [pokerBigBlind, setPokerBigBlind] = useState(DEFAULT_BIG_BLIND)
  const [pokerRaiseInput, setPokerRaiseInput] = useState('20')
  const [pokerActionError, setPokerActionError] = useState('')
  const [pokerInsufficientFundsModal, setPokerInsufficientFundsModal] = useState(false)
  const [pokerFoldAnimations, setPokerFoldAnimations] = useState<Record<string, boolean>>({})
  const [pokerCheckAnimations, setPokerCheckAnimations] = useState<Record<string, boolean>>({})
  const [pokerPotAnimations, setPokerPotAnimations] = useState<
    Array<{ id: string; seatIndex: number; chips: { color: string; label: string }[] }>
  >([])
  const [pokerPotPulse, setPokerPotPulse] = useState(false)
  // what just happened at the table: a tag over the actor's seat and a running
  // log for the hand
  const [pokerActionPops, setPokerActionPops] = useState<Record<string, PokerAnnouncement>>({})
  const [pokerHandLog, setPokerHandLog] = useState<PokerAnnouncement[]>([])
  const [pokerMessage, setPokerMessage] = useState(
    'Choose whether you want to create a table or join one with a room code.',
  )
  const [devMode, setDevMode] = useState(() => {
    if (typeof window === 'undefined') {
      return false
    }

    return window.sessionStorage.getItem(DEV_MODE_SESSION_KEY) === 'true'
  })
  const [devModePromptOpen, setDevModePromptOpen] = useState(false)
  const [devModeError, setDevModeError] = useState('')
  const [devModeVerifying, setDevModeVerifying] = useState(false)
  const [settingsPlayerSearch, setSettingsPlayerSearch] = useState('')
  const [settingsPlayers, setSettingsPlayers] = useState<LocalPlayerProfile[]>(() =>
    listLocalPlayerProfiles(),
  )
  const [selectedSettingsPlayerId, setSelectedSettingsPlayerId] = useState('')
  const [settingsPlayerDetailName, setSettingsPlayerDetailName] = useState('')
  const [settingsPlayerDetailBankroll, setSettingsPlayerDetailBankroll] = useState('')
  const [settingsPlayerDetailNameLocked, setSettingsPlayerDetailNameLocked] = useState(false)
  const [settingsPlayerDetailError, setSettingsPlayerDetailError] = useState('')
  const [playerDailyStats, setPlayerDailyStats] = useState<CasinoDailyStat[]>(() =>
    readPlayerDailyStats(getOrCreateLocalPlayerProfile().id),
  )
  const [casinoDailyStats, setCasinoDailyStats] = useState<CasinoDailyStat[]>(() =>
    syncCasinoDailyStatsWithGames(),
  )
  const [casinoGameDailyStats, setCasinoGameDailyStats] = useState<Record<CasinoTrackedGame, CasinoDailyStat[]>>(
    () => readAllCasinoGameDailyStats(),
  )
  const [casinoStatsRange, setCasinoStatsRange] = useState<CasinoStatsRange>('7d')
  const [selectedCasinoStatsGame, setSelectedCasinoStatsGame] = useState<CasinoTrackedGame>('blackjack')
  const [casinoStatsResetPromptOpen, setCasinoStatsResetPromptOpen] = useState(false)
  const [casinoStatsResetConfirmOpen, setCasinoStatsResetConfirmOpen] = useState(false)
  const [casinoStatsResetInput, setCasinoStatsResetInput] = useState('')
  const [casinoStatsResetError, setCasinoStatsResetError] = useState('')
  const [casinoStatsResetVerifying, setCasinoStatsResetVerifying] = useState(false)
  const previousPokerFoldStateRef = useRef<Record<string, boolean>>({})
  const pokerFoldAnimationTimeoutsRef = useRef<Record<string, number>>({})
  const previousPokerActionIdRef = useRef<number | null>(null)
  const pokerPotAnimationTimeoutsRef = useRef<number[]>([])
  const pokerCheckAnimationTimeoutsRef = useRef<Record<string, number>>({})
  const hiLoResolveTimeoutRef = useRef<number | null>(null)
  const diceResolveTimeoutRef = useRef<number | null>(null)
  const diceRollIntervalRef = useRef<number | null>(null)
  const slotsResolveTimeoutRef = useRef<number | null>(null)
  const slotsSpinTokenRef = useRef(0)
  const slotsColumnStopTimeoutsRef = useRef<number[]>([])
  const pendingPlinkoDropsRef = useRef<PendingPlinkoDrop[]>([])
  const settledPlinkoIdsRef = useRef<Set<string>>(new Set())
  const autoCashoutSnapshotRef = useRef({
    playerProfileId: playerProfile.id,
    bankroll,
    hiLoActive: false,
    hiLoCashOutAmount: 0,
    minesActive: false,
    minesCashOutAmount: 0,
  })
  const setBankroll = (value: SetStateAction<number>) => {
    setBankrollState((currentBankroll) => {
      const nextBankroll = normalizeBankroll(
        typeof value === 'function' ? value(currentBankroll) : value,
      )

      setPlayerProfile((currentProfile) => {
        if (currentProfile.bankroll === nextBankroll) {
          return currentProfile
        }

        const nextProfile = {
          ...currentProfile,
          bankroll: nextBankroll,
          updatedAt: new Date().toISOString(),
        }

        writeLocalPlayerProfile(nextProfile)
        void syncRemotePlayerProfile(nextProfile)
        return nextProfile
      })

      return nextBankroll
    })
  }

  const syncSettingsPlayers = () => {
    setSettingsPlayers(listLocalPlayerProfiles())
  }

  // Your own record is stamped with this browser's silent-session uid; the
  // Firestore rules only let that uid change it. Someone else's record can only
  // be changed by the developer session, and keeps its owner untouched.
  const syncRemotePlayerProfile = async (nextProfile: LocalPlayerProfile, asDeveloper = false) => {
    try {
      if (asDeveloper) {
        const developerRef = getDeveloperPlayerDocRef(nextProfile.id)
        if (developerRef) {
          const { ownerUid: _ownerUid, ...fields } = nextProfile as LocalPlayerProfile & { ownerUid?: string }
          await setDoc(developerRef, fields, { merge: true })
        }
        return
      }

      const profileRef = getPlayerProfileDocRef(nextProfile.id)
      const ownerUid = profileRef ? await ensurePlayerSession() : null
      if (!profileRef || !ownerUid) {
        return
      }
      await setDoc(profileRef, { ...nextProfile, ownerUid })
    } catch (error) {
      console.error('Failed to sync player profile', error)
    }
  }

  const persistLocalPlayerProfile = (nextProfile: LocalPlayerProfile) => {
    writeLocalPlayerProfile(nextProfile)
    syncSettingsPlayers()
    void syncRemotePlayerProfile(nextProfile, nextProfile.id !== playerProfile.id)

    if (nextProfile.id === playerProfile.id) {
      setPlayerProfile(nextProfile)
      setBankroll(nextProfile.bankroll)
      setOptionsNameInput(nextProfile.name || '')
    }
  }

  const totalWager = handBets.reduce((sum, handBet) => sum + handBet, 0)
  const canPlaceBets = bankroll > 0
  const currentHand = playerHands[activeHandIndex] ?? []
  const currentHandBet = handBets[activeHandIndex] ?? bet
  const isHandActive = playerHands.length > 0 && !dealerRevealed
  const canSplit =
    isHandActive &&
    currentHand.length === 2 &&
    currentHand[0]?.rank === currentHand[1]?.rank &&
    bankroll >= currentHandBet
  const canDouble = isHandActive && bankroll >= currentHandBet
  const minesMultiplier = getMinesMultiplier(minesSafePicks, minesCount)
  const minesCashOutAmount = minesSafePicks > 0 ? Math.round(bet * minesMultiplier) : 0
  const minesSafeTiles = MINES_TILE_COUNT - minesCount
  const minesNextStepMultiplier =
    minesSafePicks < minesSafeTiles
      ? Number(
          (getMinesMultiplier(minesSafePicks + 1, minesCount) / getMinesMultiplier(minesSafePicks, minesCount)).toFixed(2),
        )
      : 0
  const pokerPlayerCount = pokerSeats.filter(Boolean).length
  const pokerYouSeatIndex = pokerSeats.findIndex((seat) => seat?.id === pokerPlayerId)
  const pokerYouSeat = pokerYouSeatIndex === -1 ? null : pokerSeats[pokerYouSeatIndex]
  const pokerYouState =
    pokerYouSeat && pokerGame ? pokerGame.players[pokerYouSeat.id] ?? null : null
  const pokerNeedsBuyInConfirmation =
    Boolean(
      pokerPendingStart &&
        pokerYouSeat &&
        pokerPendingStart.playerIds.includes(pokerPlayerId) &&
        !pokerPendingStart.confirmedPlayerIds.includes(pokerPlayerId),
    )
  const pokerCallAmount =
    pokerYouState && pokerGame && pokerYouSeat
      ? getPokerAmountToCall({
          seats: pokerSeats,
          dealerSeatIndex: pokerDealerSeatIndex,
          players: pokerGame.players,
          currentBet: pokerGame.currentBet,
          street: pokerGame.street,
          smallBlind: pokerSmallBlind,
          seatIndex: pokerYouSeatIndex,
          seatId: pokerYouSeat.id,
        })
      : 0
  const pokerActiveSeat = pokerGame && pokerGame.activeSeatIndex >= 0 ? pokerSeats[pokerGame.activeSeatIndex] : null
  const { smallBlindSeatIndex: pokerSmallBlindSeatIndex, bigBlindSeatIndex: pokerBigBlindSeatIndex } =
    pokerGame
      ? getPokerBlindSeatIndexes(pokerSeats, pokerDealerSeatIndex, pokerGame.players)
      : { smallBlindSeatIndex: -1, bigBlindSeatIndex: -1 }
  const pokerCanCashOut = Boolean(pokerYouSeat && (!pokerGame || pokerGame.street === 'showdown'))
  const pokerCanAct =
    Boolean(
      pokerGame &&
        pokerGame.street !== 'showdown' &&
        pokerYouSeat &&
        pokerGame.activeSeatIndex === pokerYouSeatIndex &&
        pokerYouState &&
        !pokerYouState.folded &&
        !pokerYouState.allIn,
    )
  const pokerPotChips = pokerGame ? getPokerChipTokens(pokerGame.pot) : []
  const filteredSettingsPlayers = settingsPlayers
    .filter((profile) =>
      `${profile.name} ${profile.id}`.toLowerCase().includes(settingsPlayerSearch.trim().toLowerCase()),
    )
    .sort((left, right) =>
      (left.name || left.id).localeCompare(right.name || right.id, undefined, { sensitivity: 'base' }),
    )
  const selectedSettingsPlayer =
    settingsPlayers.find((profile) => profile.id === selectedSettingsPlayerId) ?? null
  const leaderboardPlayers = [...settingsPlayers]
    .sort((left, right) => {
      if (right.bankroll !== left.bankroll) {
        return right.bankroll - left.bankroll
      }

      return (left.name || left.id).localeCompare(right.name || right.id, undefined, {
        sensitivity: 'base',
      })
    })
    .slice(0, 3)
  const todayDateKey = getCasinoStatDateKey()
  const rewardDaysSinceLastClaim = playerProfile.lastDailyRewardClaimDate
    ? getDateKeyDistance(todayDateKey, playerProfile.lastDailyRewardClaimDate)
    : null
  const activeDailyRewardStreak =
    rewardDaysSinceLastClaim === null
      ? 0
      : rewardDaysSinceLastClaim <= 1
        ? playerProfile.dailyRewardStreak
        : 0
  const canClaimDailyReward = rewardDaysSinceLastClaim !== 0
  const nextDailyRewardDay = activeDailyRewardStreak + 1
  const nextDailyRewardAmount = getDailyRewardAmountForDay(nextDailyRewardDay)
  const dailyRewardWeekStart = Math.floor((nextDailyRewardDay - 1) / 7) * 7 + 1
  const dailyRewardDays = Array.from({ length: 7 }, (_, index) => {
    const dayNumber = dailyRewardWeekStart + index
    return {
      dayNumber,
      reward: getDailyRewardAmountForDay(dayNumber),
      claimed: activeDailyRewardStreak >= dayNumber,
      current: dayNumber === nextDailyRewardDay,
    }
  })
  const filteredPlayerDailyStats = filterCasinoDailyStats(playerDailyStats, '7d')
  const lifetimePlayerProfit = playerDailyStats.reduce((sum, entry) => sum + entry.amount, 0)
  const hasSavedPlayerName = playerProfile.name.trim().length > 0
  const filteredCasinoDailyStats = filterCasinoDailyStats(casinoDailyStats, casinoStatsRange)
  const lifetimeCasinoProfit = casinoDailyStats.reduce((sum, entry) => sum + entry.amount, 0)
  const selectedCasinoGameStats = casinoGameDailyStats[selectedCasinoStatsGame] ?? []
  const filteredSelectedCasinoGameStats = filterCasinoDailyStats(selectedCasinoGameStats, casinoStatsRange)
  const lifetimeSelectedCasinoGameProfit = selectedCasinoGameStats.reduce((sum, entry) => sum + entry.amount, 0)
  const casinoStatsResetScopeLabel =
    selectedGame === 'settings-statistics-game'
      ? getCasinoTrackedGameLabel(selectedCasinoStatsGame)
      : 'All'
  const slotsJackpots = getSlotJackpotValues(slotsBonusActive ? slotsBonusBet || bet : bet)
  const diceWinChance = getDiceWinChance(diceTarget, diceMode)
  const diceMultiplier = getDiceMultiplier(diceTarget, diceMode)
  const dicePayout = Math.round(bet * diceMultiplier)
  const diceWinChanceLabel = getDiceWinChanceLabel(diceWinChance)
  const diceTopRow = (diceValues.length ? diceValues : Array.from({ length: DICE_COUNT }, () => 0)).slice(0, DICE_ROW_COUNT)
  const diceBottomRow = (diceValues.length ? diceValues : Array.from({ length: DICE_COUNT }, () => 0)).slice(DICE_ROW_COUNT)
  const diceTotal = diceValues.length === DICE_COUNT ? getDiceTotal(diceValues) : null
  const slotsBaseGrid = slotsBonusActive ? slotsBonusGrid : slotsGrid
  const slotsFinalGrid = slotsSpinTarget?.finalGrid ?? slotsBaseGrid
  const slotsFromGrid = slotsSpinTarget?.fromGrid ?? slotsBaseGrid
  const slotsColumns = Array.from({ length: SLOT_COLUMNS }, (_, columnIndex) => ({
    final: Array.from({ length: SLOT_ROWS }, (_, rowIndex) => slotsFinalGrid[rowIndex]?.[columnIndex] ?? null),
    previous: Array.from({ length: SLOT_ROWS }, (_, rowIndex) => slotsFromGrid[rowIndex]?.[columnIndex] ?? null),
    filler: slotsSpinTarget?.fillers[columnIndex] ?? [],
  }))
  const getSlotsCellClassName = (cell: SlotCell | null, rowIndex?: number, columnIndex?: number) =>
    `slots-machine__reel${
      cell?.kind === 'orb' ? ' slots-machine__reel--orb' : ''
    }${cell?.kind === 'orb' && cell.jackpot ? ` slots-machine__reel--${cell.jackpot}` : ''}${
      !cell ? ' slots-machine__reel--empty' : ''
    }${
      rowIndex !== undefined && columnIndex !== undefined && slotsWinningCells?.[rowIndex]?.[columnIndex]
        ? ' slots-machine__reel--win'
        : ''
    }`
  const renderSlotsCellContent = (cell: SlotCell | null, fallbackCell?: SlotCell) => {
    const displayCell = cell ?? fallbackCell ?? null

    if (!displayCell) {
      return <span className="slots-machine__empty-dot" aria-hidden="true" />
    }

    if (displayCell.kind === 'orb') {
      return (
        <>
          <span className="slots-machine__orb-label">
            {displayCell.jackpot ? displayCell.jackpot.toUpperCase() : 'LINK'}
          </span>
          <strong className="slots-machine__orb-value">
            {displayCell.jackpot
              ? `$${slotsJackpots[displayCell.jackpot].toLocaleString()}`
              : `$${displayCell.value}`}
          </strong>
        </>
      )
    }

    return (
      <span className="slots-machine__symbol-mark">
        <SlotSymbol symbol={displayCell.symbol} />
      </span>
    )
  }

  useEffect(() => {
    autoCashoutSnapshotRef.current = {
      playerProfileId: playerProfile.id,
      bankroll,
      hiLoActive: Boolean(hiLoCurrentCard && !hiLoResult && hiLoStreak > 0),
      hiLoCashOutAmount: hiLoStreak > 0 ? Math.round(bet * hiLoMultiplier) : 0,
      minesActive: Boolean(minesRoundActive && !minesResult && minesSafePicks > 0),
      minesCashOutAmount,
    }
  }, [
    bankroll,
    bet,
    hiLoCurrentCard,
    hiLoMultiplier,
    hiLoResult,
    hiLoStreak,
    minesCashOutAmount,
    minesResult,
    minesRoundActive,
    minesSafePicks,
    playerProfile.id,
  ])

  useEffect(() => {
    if (!isFirebaseConfigured || !firestore) {
      setSettingsPlayers(listLocalPlayerProfiles())
      return
    }

    const playersCollection = collection(firestore, 'players')
    const unsubscribe = onSnapshot(playersCollection, (snapshot) => {
      const remotePlayers = snapshot.docs
        .map((entry) => entry.data() as LocalPlayerProfile)
        .map((profile) => ({
          ...profile,
          name: typeof profile.name === 'string' ? profile.name : '',
          nameLocked: Boolean(profile.nameLocked),
          skipStartScreen: Boolean(profile.skipStartScreen),
          dailyRewardStreak: Number.isFinite(profile.dailyRewardStreak)
            ? Math.max(0, Math.floor(profile.dailyRewardStreak))
            : 0,
          lastDailyRewardClaimDate:
            typeof profile.lastDailyRewardClaimDate === 'string' ? profile.lastDailyRewardClaimDate : null,
          bankroll: normalizeBankroll(profile.bankroll),
        }))

      const localPlayers = listLocalPlayerProfiles()
      const mergedPlayers = new Map<string, LocalPlayerProfile>()

      localPlayers.forEach((profile) => {
        mergedPlayers.set(profile.id, profile)
      })

      remotePlayers.forEach((profile) => {
        if (profile.id) {
          mergedPlayers.set(profile.id, profile)
        }
      })

      const allPlayers = Array.from(mergedPlayers.values())

      if (allPlayers.length > 0) {
        setSettingsPlayers(allPlayers)

        const currentRemoteProfile = allPlayers.find((profile) => profile.id === playerProfile.id)

        if (currentRemoteProfile) {
          writeLocalPlayerProfile(currentRemoteProfile)
          setPlayerProfile(currentRemoteProfile)
          setBankrollState(currentRemoteProfile.bankroll)
        }

        return
      }

      setSettingsPlayers(localPlayers)
    }, (error) => {
      console.error('Failed to subscribe to shared player profiles', error)
      setSettingsPlayers(listLocalPlayerProfiles())
    })

    return () => {
      unsubscribe()
    }
  }, [playerProfile.id])

  useEffect(() => {
    pendingPlinkoDropsRef.current = pendingPlinkoDrops
  }, [pendingPlinkoDrops])

  // Hi-Lo reveal: once the revealed card has mounted in the "Next" slot, flip it
  // face-up in place then slide it exactly onto the current card. Driven by the
  // Web Animations API with the measured distance baked in (a CSS var in a
  // keyframe is resolved at animation-creation time in some engines, which left
  // the card landing short — WAAPI avoids that entirely).
  useLayoutEffect(() => {
    if (!hiLoNextCard) {
      return
    }
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      return
    }
    const overlay = document.querySelector('.hilo-card--overlay') as HTMLElement | null
    const base = document.querySelector('.hilo-card--base') as HTMLElement | null
    const currentCard = document
      .querySelectorAll('.hilo-card-slot')[0]
      ?.querySelector('.playing-card') as HTMLElement | null
    if (!overlay || !base || !currentCard) {
      return
    }
    // base sits exactly where the overlay rests, so the delta from base -> current
    // is how far the overlay must travel to cover the current card.
    const rest = base.getBoundingClientRect()
    const target = currentCard.getBoundingClientRect()
    const dx = target.left - rest.left
    const dy = target.top - rest.top
    overlay.animate(
      [
        { transform: 'translate(0px, 0px) rotateY(-92deg)', easing: 'cubic-bezier(0.3, 0.7, 0.3, 1)' },
        { transform: 'translate(0px, 0px) rotateY(0deg)', offset: 0.32, easing: 'linear' },
        { transform: 'translate(0px, 0px) rotateY(0deg)', offset: 0.46, easing: 'cubic-bezier(0.34, 0.86, 0.3, 1)' },
        { transform: `translate(${dx}px, ${dy}px) rotateY(0deg)` },
      ],
      { duration: 660, fill: 'forwards' },
    )
  }, [hiLoNextCard])

  useEffect(() => {
    void syncRemotePlayerProfile(playerProfile)
  }, [playerProfile.id])

  useEffect(() => {
    setOptionsNameInput(playerProfile.name || '')
  }, [playerProfile.name])

  useEffect(() => {
    if (!selectedSettingsPlayer) {
      setSettingsPlayerDetailName('')
      setSettingsPlayerDetailBankroll('')
      setSettingsPlayerDetailNameLocked(false)
      setSettingsPlayerDetailError('')
      return
    }

    setSettingsPlayerDetailName(selectedSettingsPlayer.name || '')
    setSettingsPlayerDetailBankroll(String(selectedSettingsPlayer.bankroll))
    setSettingsPlayerDetailNameLocked(selectedSettingsPlayer.nameLocked)
    setSettingsPlayerDetailError('')
  }, [selectedSettingsPlayer])

  useEffect(() => {
    setPlayerDailyStats(readPlayerDailyStats(playerProfile.id))
  }, [playerProfile.id])

  useEffect(() => {
    const pendingCashout = readPendingCashout(playerProfile.id)

    if (!pendingCashout || pendingCashout.amount <= 0) {
      return
    }

    clearPendingCashout(playerProfile.id)
    setBankroll((currentBankroll) => currentBankroll + pendingCashout.amount)
  }, [playerProfile.id])

  useEffect(() => {
    const handleAutoCashoutOnClose = () => {
      const snapshot = autoCashoutSnapshotRef.current
      const autoCashoutAmount =
        (snapshot.hiLoActive ? snapshot.hiLoCashOutAmount : 0) +
        (snapshot.minesActive ? snapshot.minesCashOutAmount : 0)

      if (autoCashoutAmount <= 0) {
        return
      }
      
      writePendingCashout({
        playerId: snapshot.playerProfileId,
        amount: autoCashoutAmount,
        createdAt: new Date().toISOString(),
      })
    }

    const handleBeforeUnload = () => {
      handleAutoCashoutOnClose()
    }

    const handleUnload = () => {
      handleAutoCashoutOnClose()
    }

    window.addEventListener('pagehide', handleAutoCashoutOnClose)
    window.addEventListener('beforeunload', handleBeforeUnload)
    window.addEventListener('unload', handleUnload)

    return () => {
      window.removeEventListener('pagehide', handleAutoCashoutOnClose)
      window.removeEventListener('beforeunload', handleBeforeUnload)
      window.removeEventListener('unload', handleUnload)
    }
  }, [])

  useEffect(() => {
    const handleStorageUpdate = (event: StorageEvent) => {
      if (event.key !== getLocalPlayerProfileStorageKey(playerProfile.id) || !event.newValue) {
        return
      }

      try {
        const nextProfile = JSON.parse(event.newValue) as LocalPlayerProfile
        setPlayerProfile(nextProfile)
        setBankroll(nextProfile.bankroll)
      } catch {
        // Ignore malformed external updates.
      }
    }

    window.addEventListener('storage', handleStorageUpdate)

    return () => {
      window.removeEventListener('storage', handleStorageUpdate)
    }
  }, [playerProfile.id])

  useEffect(() => {
    if (typeof window === 'undefined') {
      return
    }

    window.sessionStorage.setItem(DEV_MODE_SESSION_KEY, String(devMode))
  }, [devMode])

  useEffect(() => {
    const handleDevModeKeydown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null

      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        target?.isContentEditable
      ) {
        return
      }

      const key = event.key.toLowerCase()

      if (key === DEV_MODE_TRIGGER_KEY) {
        event.preventDefault()

        if (devMode) {
          setDevMode(false)
          setDevModePromptOpen(false)
          setDevModeError('')
          setDevModeVerifying(false)
          void signOutDeveloper()
          return
        }

        setDevModePromptOpen(true)
        setDevModeError('')
        setDevModeVerifying(false)
        return
      }
    }

    window.addEventListener('keydown', handleDevModeKeydown)

    return () => {
      window.removeEventListener('keydown', handleDevModeKeydown)
    }
  }, [devMode])

  // Developer mode is unlocked by signing in with Google as DEVELOPER_EMAIL.
  const handleDeveloperSignIn = async () => {
    setDevModeVerifying(true)
    setDevModeError('')

    try {
      await signInAsDeveloper()
      setDevMode(true)
      setDevModePromptOpen(false)
      setDevModeError('')
    } catch (error) {
      setDevModeError(error instanceof Error ? error.message : 'Google sign-in failed. Try again.')
    } finally {
      setDevModeVerifying(false)
    }
  }

  // start this browser's silent player session early, so saves are ready
  useEffect(() => {
    void ensurePlayerSession()
  }, [])

  // a remembered dev session only counts while that Google account is signed in
  useEffect(() => watchDeveloperSession((isDeveloper) => {
    if (!isDeveloper) {
      setDevMode(false)
    }
  }), [])

  const handleSavePlayerOptions = () => {
    if (playerProfile.nameLocked) {
      setBetInputError('Your player name is locked.')
      return
    }

    const trimmedName = optionsNameInput.trim()

    if (!trimmedName) {
      setBetInputError('Enter your name first.')
      return
    }

    const nextProfile = {
      ...playerProfile,
      name: trimmedName,
      updatedAt: new Date().toISOString(),
    }

    persistLocalPlayerProfile(nextProfile)
    setBetInputError('')
  }

  const handleClaimDailyReward = () => {
    if (!canClaimDailyReward) {
      return
    }

    const nextProfile = {
      ...playerProfile,
      bankroll: normalizeBankroll(bankroll + nextDailyRewardAmount),
      dailyRewardStreak: nextDailyRewardDay,
      lastDailyRewardClaimDate: todayDateKey,
      updatedAt: new Date().toISOString(),
    }

    persistLocalPlayerProfile(nextProfile)
    setBankroll(nextProfile.bankroll)
  }

  const handleAdjustDevBankroll = (amount: number) => {
    if (!devMode) {
      return
    }

    setBankroll((currentBankroll) => Math.max(0, currentBankroll + amount))
  }

  useEffect(() => {
    if (!pokerRoomCode) {
      return
    }

    const roomRef = getPokerRoomDocRef(pokerRoomCode)

    if (!roomRef) {
      setPokerMessage(firebaseConfigError ?? 'Firebase is not configured.')
      return
    }

    const unsubscribe = onSnapshot(roomRef, (roomSnapshot) => {
      if (!roomSnapshot.exists()) {
        setPokerScreen('entry')
        setPokerMode('choose')
        setPokerRoomCode('')
        setPokerDealerSeatIndex(-1)
        setPokerPlayerChips({})
        setPokerSeats(Array.from({ length: 6 }, () => null))
        setPokerPendingStart(null)
        setPokerMessage('That poker room is no longer active.')
        return
      }

      const activeRoom = roomSnapshot.data() as PokerRoomState
      setPokerSeats(activeRoom.seats)
      setPokerHostId(activeRoom.hostId)
      setPokerDealerSeatIndex(activeRoom.dealerSeatIndex)
      setPokerPlayerChips(activeRoom.playerChips)
      setPokerGame(activeRoom.game)
      setPokerPendingStart(activeRoom.pendingStart)
      setPokerBuyIn(activeRoom.buyIn)
      setPokerBuyInInput(String(activeRoom.buyIn))
      setPokerSmallBlind(activeRoom.smallBlind)
      setPokerSmallBlindInput(String(activeRoom.smallBlind))
      setPokerBigBlind(activeRoom.bigBlind)
      setPokerMessage(
        activeRoom.pendingStart
          ? `Waiting for players to confirm the ${formatPoints(activeRoom.pendingStart.buyIn)} entry.`
          : activeRoom.game?.winnerMessage ?? activeRoom.game?.lastAction ?? getPokerRoomMessage(activeRoom.seats.filter(Boolean).length),
      )
    })

    return () => {
      unsubscribe()
    }
  }, [pokerRoomCode])

  useEffect(() => {
    if (!pokerGame) {
      previousPokerFoldStateRef.current = {}
      setPokerFoldAnimations({})
      setPokerCheckAnimations({})
      Object.values(pokerFoldAnimationTimeoutsRef.current).forEach((timeoutId) => {
        window.clearTimeout(timeoutId)
      })
      pokerFoldAnimationTimeoutsRef.current = {}
      Object.values(pokerCheckAnimationTimeoutsRef.current).forEach((timeoutId) => {
        window.clearTimeout(timeoutId)
      })
      pokerCheckAnimationTimeoutsRef.current = {}
      return
    }

    const nextFoldState = Object.fromEntries(
      Object.entries(pokerGame.players).map(([playerId, playerState]) => [playerId, playerState.folded]),
    )

    Object.entries(nextFoldState).forEach(([playerId, folded]) => {
      if (playerId === pokerPlayerId) {
        return
      }

      if (folded && !previousPokerFoldStateRef.current[playerId]) {
        setPokerFoldAnimations((current) => ({ ...current, [playerId]: true }))

        if (pokerFoldAnimationTimeoutsRef.current[playerId]) {
          window.clearTimeout(pokerFoldAnimationTimeoutsRef.current[playerId])
        }

        pokerFoldAnimationTimeoutsRef.current[playerId] = window.setTimeout(() => {
          setPokerFoldAnimations((current) => {
            const nextAnimations = { ...current }
            delete nextAnimations[playerId]
            return nextAnimations
          })
          delete pokerFoldAnimationTimeoutsRef.current[playerId]
        }, 620)
      }

      if (!folded && previousPokerFoldStateRef.current[playerId]) {
        setPokerFoldAnimations((current) => {
          const nextAnimations = { ...current }
          delete nextAnimations[playerId]
          return nextAnimations
        })
      }
    })

    previousPokerFoldStateRef.current = nextFoldState
  }, [pokerGame, pokerPlayerId])

  useEffect(() => {
    if (!pokerGame) {
      previousPokerActionIdRef.current = null
      setPokerPotAnimations([])
      setPokerPotPulse(false)
      pokerPotAnimationTimeoutsRef.current.forEach((timeoutId) => {
        window.clearTimeout(timeoutId)
      })
      pokerPotAnimationTimeoutsRef.current = []
      return
    }

    const currentActionId = pokerGame.actionId ?? 0
    const currentContributions = pokerGame.lastContributions ?? []

    if (previousPokerActionIdRef.current === null) {
      previousPokerActionIdRef.current = currentActionId
      return
    }

    if (currentActionId === previousPokerActionIdRef.current) {
      return
    }

    previousPokerActionIdRef.current = currentActionId

    if (currentContributions.length === 0) {
      return
    }

    const nextAnimations = currentContributions
      .map((contribution, index) => {
        const seatIndex = pokerSeats.findIndex((seat) => seat?.id === contribution.playerId)

        if (seatIndex === -1 || contribution.amount <= 0) {
          return null
        }

        return {
          id: `${currentActionId}-${contribution.playerId}-${index}`,
          seatIndex,
          chips: getPokerChipTokens(contribution.amount),
        }
      })
      .filter(Boolean) as Array<{ id: string; seatIndex: number; chips: { color: string; label: string }[] }>

    if (nextAnimations.length === 0) {
      return
    }

    setPokerPotAnimations(nextAnimations)
    setPokerPotPulse(true)

    pokerPotAnimationTimeoutsRef.current.forEach((timeoutId) => {
      window.clearTimeout(timeoutId)
    })

    pokerPotAnimationTimeoutsRef.current = [
      window.setTimeout(() => {
        setPokerPotAnimations([])
      }, 720),
      window.setTimeout(() => {
        setPokerPotPulse(false)
      }, 640),
    ]
  }, [pokerGame, pokerSeats])

  const pokerCheckActionIdRef = useRef<number | null>(null)

  useEffect(() => {
    if (!pokerGame || pokerGame.lastActionType !== 'check' || !pokerGame.lastActorId) {
      return
    }
    // snapshots re-arrive for the same action; only knock once per check
    if (pokerCheckActionIdRef.current === pokerGame.actionId) {
      return
    }
    pokerCheckActionIdRef.current = pokerGame.actionId

    const playerId = pokerGame.lastActorId
    setPokerCheckAnimations((current) => ({ ...current, [playerId]: true }))

    if (pokerCheckAnimationTimeoutsRef.current[playerId]) {
      window.clearTimeout(pokerCheckAnimationTimeoutsRef.current[playerId])
    }

    pokerCheckAnimationTimeoutsRef.current[playerId] = window.setTimeout(() => {
      setPokerCheckAnimations((current) => {
        const nextAnimations = { ...current }
        delete nextAnimations[playerId]
        return nextAnimations
      })
      delete pokerCheckAnimationTimeoutsRef.current[playerId]
    }, 1500)
  }, [pokerGame])

  // Table talk: turn each new action into a seat tag and a log line.
  const pokerAnnounceRef = useRef<{
    actionId: number | null
    currentBet: number
    street: PokerStreet | null
    folded: Record<string, boolean>
    activeSeatIndex: number
    pot: number
  }>({ actionId: null, currentBet: 0, street: null, folded: {}, activeSeatIndex: -1, pot: 0 })
  const pokerPopTimeoutsRef = useRef<Record<string, number>>({})

  useEffect(() => {
    if (!pokerGame) {
      pokerAnnounceRef.current = { actionId: null, currentBet: 0, street: null, folded: {}, activeSeatIndex: -1, pot: 0 }
      setPokerHandLog([])
      setPokerActionPops({})
      return
    }
    const previous = pokerAnnounceRef.current
    const actionId = pokerGame.actionId ?? 0
    if (previous.actionId === actionId) {
      return
    }
    const folded = Object.fromEntries(
      Object.entries(pokerGame.players).map(([playerId, player]) => [playerId, player.folded]),
    )
    pokerAnnounceRef.current = {
      actionId,
      currentBet: pokerGame.currentBet,
      street: pokerGame.street,
      folded,
      activeSeatIndex: pokerGame.activeSeatIndex,
      pot: pokerGame.pot,
    }
    // joining mid-hand: start from here, don't replay
    if (previous.actionId === null) {
      return
    }

    const nameOf = (playerId: string | null) =>
      pokerSeats.find((seat) => seat?.id === playerId)?.name ?? 'Someone'
    const entries: PokerAnnouncement[] = []
    const add = (text: string, kind: PokerAnnouncementKind, actorId?: string | null, tag?: string) => {
      entries.push({ id: `${actionId}-${entries.length}`, text, kind, tag })
      if (actorId && tag) {
        const popId = `${actionId}-${actorId}`
        setPokerActionPops((current) => ({ ...current, [actorId]: { id: popId, text, kind, tag } }))
        window.clearTimeout(pokerPopTimeoutsRef.current[actorId])
        pokerPopTimeoutsRef.current[actorId] = window.setTimeout(() => {
          setPokerActionPops((current) => {
            const next = { ...current }
            delete next[actorId]
            return next
          })
        }, 1600)
      }
    }

    const type = pokerGame.lastActionType
    const actorId = pokerGame.lastActorId
    const actorName = nameOf(actorId)
    const paid = pokerGame.lastContributions?.find((entry) => entry.playerId === actorId)?.amount ?? 0
    const allIn = actorId ? Boolean(pokerGame.players[actorId]?.allIn) : false
    const newHand = type === 'blind' || type === 'start'

    if (newHand) {
      setPokerHandLog([])
      add(`New hand · blinds $${pokerSmallBlind} / $${pokerBigBlind}`, 'info')
    } else if (type === 'check' && actorId) {
      add(`${actorName} checks`, 'check', actorId, 'Check')
    } else if (type === 'call' && actorId) {
      add(
        allIn ? `${actorName} calls $${paid} and is all in` : `${actorName} calls $${paid}`,
        allIn ? 'allin' : 'call',
        actorId,
        allIn ? 'All in' : `Call $${paid}`,
      )
    } else if (type === 'raise' && actorId) {
      const to = pokerGame.currentBet
      const by = to - previous.currentBet
      if (previous.currentBet <= 0) {
        add(allIn ? `${actorName} bets $${to} — all in` : `${actorName} bets $${to}`, allIn ? 'allin' : 'bet', actorId, allIn ? 'All in' : `Bet $${to}`)
      } else {
        add(
          `${actorName} raises to $${to} (+$${by})${allIn ? ' — all in' : ''}`,
          allIn ? 'allin' : 'raise',
          actorId,
          allIn ? 'All in' : `Raise +$${by}`,
        )
      }
    }

    // folds are read from the players, so a fold that ends the hand still shows
    if (!newHand) {
      Object.entries(folded).forEach(([playerId, isFolded]) => {
        if (isFolded && !previous.folded[playerId]) {
          add(`${nameOf(playerId)} folds`, 'fold', playerId, 'Fold')
        }
      })
    }

    if (pokerGame.street !== previous.street && ['flop', 'turn', 'river'].includes(pokerGame.street)) {
      const shown = pokerGame.street === 'flop' ? pokerGame.communityCards.slice(0, 3) : pokerGame.communityCards.slice(-1)
      const label = pokerGame.street.charAt(0).toUpperCase() + pokerGame.street.slice(1)
      add(`${label}: ${shown.map((card) => `${card.rank}${card.suit}`).join(' ')}`, 'street')
    }

    // the move that ended the hand is replaced by the result, so rebuild it from
    // whose turn it was and what happened to the pot
    if (type === 'showdown' && previous.street !== 'showdown') {
      const closer = pokerSeats[previous.activeSeatIndex]
      if (closer && !(folded[closer.id] && !previous.folded[closer.id])) {
        const added = pokerGame.pot - previous.pot
        if (added > 0) {
          add(`${closer.name} calls $${added}`, 'call', closer.id, `Call $${added}`)
        } else {
          add(`${closer.name} checks`, 'check', closer.id, 'Check')
        }
      }
    }

    if (pokerGame.street === 'showdown' && previous.street !== 'showdown' && pokerGame.winnerMessage) {
      add(pokerGame.winnerMessage.replace(/\.$/, ''), 'win')
    }

    if (entries.length === 0) {
      return
    }
    const newestFirst = [...entries].reverse()
    setPokerHandLog((current) => [...newestFirst, ...current].slice(0, 12))
  }, [pokerGame, pokerSeats, pokerSmallBlind, pokerBigBlind])

  // Poker motion. Every flight on the felt (deal, bet, fold, pot to the winner)
  // is measured from the live layout, so it lands right at any table size.
  const pokerShowdownRef = useRef<{ street: PokerStreet | null; chips: Record<string, number> }>({
    street: null,
    chips: {},
  })

  const getPokerFeltGeometry = () => {
    const felt = document.querySelector('.poker-felt') as HTMLElement | null
    if (!felt) {
      return null
    }
    const potEl = felt.querySelector('.poker-pot-chips') as HTMLElement | null
    const potBox = (potEl ?? felt).getBoundingClientRect()
    const feltBox = felt.getBoundingClientRect()
    return {
      felt,
      potEl,
      pot: { x: potBox.left + potBox.width / 2, y: potBox.top + potBox.height / 2 },
      // absolute children are placed against the felt's padding box
      origin: { x: feltBox.left + felt.clientLeft, y: feltBox.top + felt.clientTop },
    }
  }

  const getPokerCenter = (element: Element) => {
    const box = element.getBoundingClientRect()
    return { x: box.left + box.width / 2, y: box.top + box.height / 2 }
  }

  const pokerMotionReduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches

  // deal: fresh hole cards fly out from the pot, one card per seat per lap
  useLayoutEffect(() => {
    const geometry = pokerGame ? getPokerFeltGeometry() : null
    if (!geometry) {
      return
    }
    const groups = Array.from(
      document.querySelectorAll<HTMLElement>('.poker-seat__cards, .poker-your-hand__cards'),
    ).filter((group) =>
      group.querySelector('.poker-seat__card.playing-card--back:not([data-dealt]), .poker-your-hand__card:not([data-dealt])'),
    )
    groups.forEach((group, groupIndex) => {
      Array.from(
        group.querySelectorAll<HTMLElement>('.poker-seat__card.playing-card--back, .poker-your-hand__card'),
      ).forEach((card, cardIndex) => {
        if (card.dataset.dealt) {
          return
        }
        card.dataset.dealt = 'true'
        if (pokerMotionReduced()) {
          return
        }
        const from = getPokerCenter(card)
        card.animate(
          [
            {
              transform: `translate(${geometry.pot.x - from.x}px, ${geometry.pot.y - from.y}px) rotate(-14deg) scale(0.55)`,
              opacity: 0,
            },
            { opacity: 1, offset: 0.2 },
            { transform: 'none', opacity: 1 },
          ],
          {
            duration: 440,
            delay: (cardIndex * groups.length + groupIndex) * 80,
            easing: 'cubic-bezier(0.2, 0, 0, 1)',
            fill: 'backwards',
          },
        )
      })
    })
  }, [pokerGame])

  // board: each street burns a card (tossed face-down off to the side), then
  // deals the new card(s) face-down to their spots and turns them over
  const pokerBoardCountRef = useRef<number | null>(null)

  useLayoutEffect(() => {
    const count = pokerGame?.communityCards.length ?? 0
    const previous = pokerBoardCountRef.current
    pokerBoardCountRef.current = count
    const geometry = getPokerFeltGeometry()
    const cards = Array.from(document.querySelectorAll<HTMLElement>('.poker-community__card'))
    const fresh = cards.filter((card) => !card.dataset.dealt)
    fresh.forEach((card) => {
      card.dataset.dealt = 'true'
    })
    // nothing new, joining mid-hand, or motion turned off: just show the board
    if (!geometry || fresh.length === 0 || previous === null || count <= previous || pokerMotionReduced()) {
      return
    }

    const board = document.querySelector('.poker-community') as HTMLElement | null
    if (!board) {
      return
    }
    const boardBox = board.getBoundingClientRect()
    const firstBox = cards[0].getBoundingClientRect()
    const cardW = firstBox.width
    const cardH = firstBox.height
    // the "deck" sits just off the left end of the board
    const deck = { x: boardBox.left - cardW * 0.9, y: firstBox.top - cardH * 0.35 }

    const makeBack = (left: number, top: number) => {
      const back = document.createElement('div')
      back.className = 'playing-card playing-card--back poker-community__card poker-board-ghost'
      back.style.left = `${left - geometry.origin.x}px`
      back.style.top = `${top - geometry.origin.y}px`
      back.style.width = `${cardW}px`
      back.style.height = `${cardH}px`
      geometry.felt.appendChild(back)
      return back
    }

    // 1. burn: off the deck, tossed down and away, gone
    const burn = makeBack(deck.x, deck.y)
    const burnAnim = burn.animate(
      [
        { transform: 'translate(0, 0) rotate(-6deg) scale(0.9)', opacity: 0 },
        { transform: 'translate(0, 0) rotate(-6deg) scale(1)', opacity: 1, offset: 0.14, easing: 'cubic-bezier(0.4, 0, 0.7, 0.4)' },
        { transform: `translate(${-cardW * 0.35}px, ${cardH * 0.7}px) rotate(-32deg) scale(0.9)`, opacity: 1, offset: 0.8 },
        { transform: `translate(${-cardW * 0.4}px, ${cardH * 0.78}px) rotate(-34deg) scale(0.9)`, opacity: 0 },
      ],
      { duration: 560, easing: 'linear', fill: 'both' },
    )
    burnAnim.onfinish = () => burn.remove()
    burnAnim.oncancel = () => burn.remove()

    // 2. deal each new card face-down, then turn it over
    fresh.forEach((card, index) => {
      const slot = card.getBoundingClientRect()
      const back = makeBack(slot.left, slot.top)
      const dx = deck.x - slot.left
      const dy = deck.y - slot.top
      const delay = 380 + index * 170
      const slide = 360
      const halfFlip = 150
      const backAnim = back.animate(
        [
          { transform: `perspective(600px) translate(${dx}px, ${dy}px) rotate(-6deg)`, opacity: 0 },
          { transform: `perspective(600px) translate(${dx * 0.92}px, ${dy * 0.92}px) rotate(-5deg)`, opacity: 1, offset: 0.08, easing: 'cubic-bezier(0.2, 0, 0, 1)' },
          { transform: 'perspective(600px) translate(0, 0) rotate(0deg) rotateY(0deg)', opacity: 1, offset: slide / (slide + halfFlip), easing: 'cubic-bezier(0.4, 0, 1, 1)' },
          { transform: 'perspective(600px) translate(0, 0) rotate(0deg) rotateY(90deg)', opacity: 1 },
        ],
        { duration: slide + halfFlip, delay, fill: 'both' },
      )
      backAnim.onfinish = () => back.remove()
      backAnim.oncancel = () => back.remove()
      card.animate(
        [
          { transform: 'perspective(600px) rotateY(-90deg)', opacity: 0 },
          { transform: 'perspective(600px) rotateY(-90deg)', opacity: 1, offset: 0.01, easing: 'cubic-bezier(0, 0, 0.2, 1)' },
          { transform: 'perspective(600px) rotateY(8deg)', opacity: 1, offset: 0.75 },
          { transform: 'perspective(600px) rotateY(0deg)', opacity: 1 },
        ],
        { duration: 260, delay: delay + slide + halfFlip, fill: 'backwards' },
      )
    })
  }, [pokerGame?.communityCards.length])

  // bets: each contribution's chips slide from the seat into the pot, which
  // gives a small bump as they land
  useLayoutEffect(() => {
    const geometry = pokerPotAnimations.length > 0 ? getPokerFeltGeometry() : null
    if (!geometry) {
      return
    }
    let landed = false
    geometry.felt.querySelectorAll<HTMLElement>('.poker-pot-animation[data-seat]:not([data-flown])').forEach((flyer) => {
      flyer.dataset.flown = 'true'
      const badge = geometry.felt.querySelector(`.poker-seat--${Number(flyer.dataset.seat) + 1} .poker-seat__badge`)
      if (!badge || pokerMotionReduced()) {
        flyer.style.visibility = 'hidden'
        return
      }
      const seat = getPokerCenter(badge)
      // start just off the seat, on the way to the pot
      const start = { x: seat.x + (geometry.pot.x - seat.x) * 0.2, y: seat.y + (geometry.pot.y - seat.y) * 0.2 }
      flyer.style.left = `${start.x - geometry.origin.x - flyer.offsetWidth / 2}px`
      flyer.style.top = `${start.y - geometry.origin.y - flyer.offsetHeight / 2}px`
      const dx = geometry.pot.x - start.x
      const dy = geometry.pot.y - start.y
      flyer.animate(
        [
          { transform: 'translate(0, 0) scale(0.7)', opacity: 0 },
          { transform: `translate(${dx * 0.08}px, ${dy * 0.08}px) scale(1)`, opacity: 1, offset: 0.18 },
          { transform: `translate(${dx}px, ${dy}px) scale(0.9)`, opacity: 1, offset: 0.9 },
          { transform: `translate(${dx}px, ${dy}px) scale(0.9)`, opacity: 0 },
        ],
        { duration: 620, easing: 'cubic-bezier(0.3, 0, 0.2, 1)', fill: 'forwards' },
      )
      landed = true
    })
    if (landed && geometry.potEl) {
      geometry.potEl.animate(
        [{ transform: 'scale(1)' }, { transform: 'scale(1.14)', offset: 0.4 }, { transform: 'scale(1)' }],
        { duration: 300, delay: 540, easing: 'ease-out' },
      )
    }
  }, [pokerPotAnimations])

  // folds: the two cards tip toward the middle of the table and fade
  useLayoutEffect(() => {
    const geometry = Object.keys(pokerFoldAnimations).length > 0 ? getPokerFeltGeometry() : null
    if (!geometry || pokerMotionReduced()) {
      return
    }
    geometry.felt
      .querySelectorAll<HTMLElement>('.poker-seat__cards--folding .poker-seat__card:not([data-folded])')
      .forEach((card) => {
        card.dataset.folded = 'true'
        const isSecond = card.previousElementSibling !== null
        const from = getPokerCenter(card)
        card.animate(
          [
            { transform: 'none', opacity: 1 },
            {
              transform: `translate(${(geometry.pot.x - from.x) * 0.35}px, ${(geometry.pot.y - from.y) * 0.35}px) rotate(${isSecond ? 16 : -16}deg) scale(0.85)`,
              opacity: 0,
            },
          ],
          { duration: 460, delay: isSecond ? 60 : 0, easing: 'cubic-bezier(0.4, 0, 1, 1)', fill: 'forwards' },
        )
      })
  }, [pokerFoldAnimations])

  // showdown: once the cards are up, the pot slides to the winner(s) and their
  // seat glows gold
  useLayoutEffect(() => {
    const previous = pokerShowdownRef.current
    const street = pokerGame?.street ?? null
    if (street !== 'showdown') {
      pokerShowdownRef.current = { street, chips: { ...pokerPlayerChips } }
      return
    }
    if (previous.street === 'showdown' || previous.street === null) {
      pokerShowdownRef.current = { ...previous, street }
      return
    }
    pokerShowdownRef.current = { street, chips: { ...pokerPlayerChips } }

    const geometry = getPokerFeltGeometry()
    if (!geometry?.potEl || pokerMotionReduced()) {
      return
    }
    let winnerIds = Object.keys(pokerPlayerChips).filter(
      (playerId) => (pokerPlayerChips[playerId] ?? 0) > (previous.chips[playerId] ?? Number.POSITIVE_INFINITY),
    )
    if (winnerIds.length === 0 && pokerGame?.lastActorId) {
      winnerIds = [pokerGame.lastActorId]
    }
    const potCenter = geometry.pot
    winnerIds.forEach((winnerId) => {
      const seatIndex = pokerSeats.findIndex((seat) => seat?.id === winnerId)
      const badge = geometry.felt.querySelector(`.poker-seat--${seatIndex + 1} .poker-seat__badge`) as HTMLElement | null
      if (seatIndex === -1 || !badge) {
        return
      }
      const flyer = geometry.potEl!.cloneNode(true) as HTMLElement
      flyer.className = 'poker-pot-chips poker-pot-flyer'
      geometry.felt.appendChild(flyer)
      flyer.style.left = `${potCenter.x - geometry.origin.x - flyer.offsetWidth / 2}px`
      flyer.style.top = `${potCenter.y - geometry.origin.y - flyer.offsetHeight / 2}px`
      const seat = getPokerCenter(badge)
      const flight = flyer.animate(
        [
          { transform: 'translate(0, 0) scale(1)', opacity: 1 },
          { transform: `translate(${seat.x - potCenter.x}px, ${seat.y - potCenter.y}px) scale(0.8)`, opacity: 1, offset: 0.88 },
          { transform: `translate(${seat.x - potCenter.x}px, ${seat.y - potCenter.y}px) scale(0.8)`, opacity: 0 },
        ],
        { duration: 760, delay: 520, easing: 'cubic-bezier(0.3, 0, 0.2, 1)', fill: 'both' },
      )
      flight.onfinish = () => flyer.remove()
      flight.oncancel = () => flyer.remove()
      badge.animate(
        [
          { boxShadow: '0 0 0 0 rgba(255, 201, 62, 0)' },
          { boxShadow: '0 0 0 5px rgba(255, 201, 62, 0.35), 0 0 34px rgba(255, 201, 62, 0.55)', offset: 0.35 },
          { boxShadow: '0 0 0 0 rgba(255, 201, 62, 0)' },
        ],
        { duration: 1500, delay: 1180, easing: 'ease-out' },
      )
    })
  }, [pokerGame, pokerPlayerChips, pokerSeats])

  const resetRound = () => {
    if (hiLoResolveTimeoutRef.current) {
      window.clearTimeout(hiLoResolveTimeoutRef.current)
      hiLoResolveTimeoutRef.current = null
    }

    if (diceResolveTimeoutRef.current) {
      window.clearTimeout(diceResolveTimeoutRef.current)
      diceResolveTimeoutRef.current = null
    }

    if (diceRollIntervalRef.current) {
      window.clearInterval(diceRollIntervalRef.current)
      diceRollIntervalRef.current = null
    }

    if (slotsResolveTimeoutRef.current) {
      window.clearTimeout(slotsResolveTimeoutRef.current)
      slotsResolveTimeoutRef.current = null
    }

    slotsColumnStopTimeoutsRef.current.forEach((timeoutId) => {
      window.clearTimeout(timeoutId)
    })
    slotsColumnStopTimeoutsRef.current = []

    setPlayerHands([])
    setHandBets([])
    setCompletedHands([])
    setActiveHandIndex(0)
    setDealerHand([])
    setDealerRevealed(false)
    setRoundResult(null)
    setRouletteBets([])
    setRouletteWinningNumber(null)
    setRouletteResult(null)
    setRouletteIsSpinning(false)
    setHiLoDeck([])
    setHiLoCurrentCard(null)
    setHiLoUpcomingCard(null)
    setHiLoNextCard(null)
    setHiLoGuess(null)
    setHiLoResult(null)
    setHiLoStreak(0)
    setHiLoMultiplier(1)
    setHiLoResolving(false)
    setHiLoSliding(false)
    setHiLoMessage('Set your bet, then reveal the first card.')
    setMinesBoard([])
    setMinesSafePicks(0)
    setMinesCountInput(String(minesCount))
    setMinesResult(null)
    setMinesMessage('Set your bet, then start the minefield.')
    setMinesRoundActive(false)
    setPendingPlinkoDrops([])
    settledPlinkoIdsRef.current.clear()
    setPlinkoInFlightDrops(0)
    setPlinkoMessage('Set your bet, then drop a ball down the board.')
    setPlinkoResult(null)
    setSlotsGrid(createInitialSlotsGrid())
    setSlotsBonusGrid(createSlotsBonusGridFromSpin(createInitialSlotsGrid()))
    setSlotsMessage('Set your bet, then spin the reels.')
    setSlotsResult(null)
    setSlotsSpinning(false)
    setSlotsStoppedColumns(Array.from({ length: SLOT_COLUMNS }, () => false))
    setSlotsSpinTarget(null)
    setSlotsWinningCells(null)
    setSlotsBonusActive(false)
    setSlotsBonusRespins(3)
    setSlotsBonusBasePayout(0)
    setSlotsBonusBet(0)
    setDiceValues([])
    setDiceMode('lower')
    setDiceTarget(70)
    setDiceResult(null)
    setDiceMessage('Pick a side, move the target, then roll all 20 dice.')
    setDiceRolling(false)
    setDiceRollFrame(0)
    setPokerGame(null)
    setPokerPendingStart(null)
    setPokerActionError('')
  }

  const settleCashoutBeforeExit = () => {
    if (selectedGame === 'hilo' && hiLoCurrentCard && !hiLoResult && hiLoStreak > 0) {
      setBankroll((currentBankroll) => currentBankroll + hiLoCashOutAmount)
      applyPlayerDailyDelta(hiLoCashOutAmount - bet)
      applyCasinoDailyDelta(hiLoCashOutAmount - bet)
      applyCasinoGameDailyDelta('hilo', hiLoCashOutAmount - bet)
      return
    }

    if (selectedGame === 'mines' && minesRoundActive && !minesResult && minesSafePicks > 0) {
      setBankroll((currentBankroll) => currentBankroll + minesCashOutAmount)
      applyPlayerDailyDelta(minesCashOutAmount - bet)
      applyCasinoDailyDelta(minesCashOutAmount - bet)
      applyCasinoGameDailyDelta('mines', minesCashOutAmount - bet)
    }
  }

  const applyTypedBet = () => {
    const parsedBet = Number(betInput)

    if (!Number.isFinite(parsedBet) || parsedBet < MIN_BET) {
      setBetInputError(`Bet must be at least $${MIN_BET}.`)
      return
    }

    if (!canPlaceBets) {
      setBetInputError('You are out of points.')
      return
    }

    if (parsedBet > bankroll) {
      setBetInputError(`Bet cannot be more than your bankroll of ${formatPoints(bankroll)}.`)
      return
    }

    setBet(parsedBet)
    setBetInputError('')
  }

  const handleOpenBlackjack = () => {
    setSelectedGame('blackjack')
    resetRound()
    setBetInput(String(bet))
    setBetInputError('')
  }

  const handleBackToGames = () => {
    settleCashoutBeforeExit()
    setSelectedGame('lobby')
    resetRound()
    setBetInput(String(bet))
    setBetInputError('')
  }

  const handleOpenRoulette = () => {
    setSelectedGame('roulette')
    resetRound()
    setBetInput(String(bet))
    setBetInputError('')
  }

  const handleOpenHiLo = () => {
    setSelectedGame('hilo')
    resetRound()
    setBetInput(String(bet))
    setBetInputError('')
  }

  const handleOpenMines = () => {
    setSelectedGame('mines')
    resetRound()
    setBetInput(String(bet))
    setMinesCountInput(String(minesCount))
    setBetInputError('')
  }

  const handleOpenOptions = () => {
    setSelectedGame('options')
    setOptionsTab('settings')
    resetRound()
    setBetInputError('')
    setOptionsNameInput(playerProfile.name || '')
  }

  const handleOpenPoker = () => {
    setSelectedGame('poker')
    if (!isFirebaseConfigured) {
      setPokerScreen('entry')
      setPokerMode('choose')
      setPokerMessage(firebaseConfigError ?? 'Firebase is not configured.')
    } else if (!pokerRoomCode) {
      setPokerScreen('entry')
      setPokerMode('choose')
      setPokerMessage('Choose whether you want to create a table or join one with a room code.')
    } else {
      setPokerScreen('table')
    }
    setBetInputError('')
    setPokerActionError('')
  }

  const handleOpenSlots = () => {
    setSelectedGame('slots')
    resetRound()
    setBetInput(String(bet))
    setBetInputError('')
  }

  const handleOpenDice = () => {
    setSelectedGame('dice')
    resetRound()
    setBetInput(String(bet))
    setBetInputError('')
  }

  const handleRollDice = () => {
    if (diceRolling || !canPlaceBets) {
      return
    }

    if (bet > bankroll) {
      setBetInputError(`Bet cannot be more than your bankroll of ${formatPoints(bankroll)}.`)
      return
    }

    const nextDiceValues = rollTwentyDice()
    const total = getDiceTotal(nextDiceValues)
    const won = diceMode === 'lower' ? total < diceTarget : total > diceTarget
    const payout = won ? dicePayout : 0
    const delta = won ? payout - bet : -bet
    const result: RoundResult = {
      message: won
        ? `${total} lands ${diceMode === 'lower' ? 'below' : 'above'} ${diceTarget}.`
        : `${total} misses the ${diceMode} target of ${diceTarget}.`,
      delta,
      payout,
    }

    setDiceRolling(true)
    setDiceResult(null)
    setDiceMessage('Rolling 20 dice across the table...')
    setBankroll((currentBankroll) => currentBankroll - bet)
    setDiceValues(rollTwentyDice())
    setDiceRollFrame(0)

    if (diceRollIntervalRef.current) {
      window.clearInterval(diceRollIntervalRef.current)
    }

    diceRollIntervalRef.current = window.setInterval(() => {
      setDiceValues(rollTwentyDice())
      setDiceRollFrame((currentFrame) => currentFrame + 1)
    }, 130)

    diceResolveTimeoutRef.current = window.setTimeout(() => {
      if (diceRollIntervalRef.current) {
        window.clearInterval(diceRollIntervalRef.current)
        diceRollIntervalRef.current = null
      }

      setDiceValues(nextDiceValues)
      setDiceResult(result)
      setDiceMessage(
        won
          ? `20 dice total ${total}. You win $${delta}.`
          : `20 dice total ${total}. The table keeps the bet.`,
      )

      if (result.payout > 0) {
        setBankroll((currentBankroll) => currentBankroll + result.payout)
      }

      applyPlayerDailyDelta(result.delta)
      applyCasinoDailyDelta(result.delta)
      applyCasinoGameDailyDelta('dice', result.delta)
      setDiceRolling(false)
      setDiceRollFrame(0)
      diceResolveTimeoutRef.current = null
    }, 1400)
  }

  const beginSlotsSpin = (
    fromGrid: (SlotCell | null)[][],
    finalGrid: (SlotCell | null)[][],
    onSettled: () => void,
  ) => {
    slotsColumnStopTimeoutsRef.current.forEach((timeoutId) => {
      window.clearTimeout(timeoutId)
    })
    slotsColumnStopTimeoutsRef.current = []

    if (slotsResolveTimeoutRef.current) {
      window.clearTimeout(slotsResolveTimeoutRef.current)
      slotsResolveTimeoutRef.current = null
    }

    setSlotsResult(null)
    setSlotsWinningCells(null)

    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      onSettled()
      return
    }

    slotsSpinTokenRef.current += 1
    setSlotsSpinTarget({
      token: slotsSpinTokenRef.current,
      fromGrid,
      finalGrid,
      fillers: Array.from({ length: SLOT_COLUMNS }, () => createSlotsReelFiller()),
    })
    setSlotsSpinning(true)
    setSlotsStoppedColumns(Array.from({ length: SLOT_COLUMNS }, () => false))

    SLOTS_REEL_STOP_DELAYS_MS.forEach((delay, columnIndex) => {
      const isLastColumn = columnIndex === SLOT_COLUMNS - 1
      const timeoutId = window.setTimeout(() => {
        setSlotsStoppedColumns((current) =>
          current.map((stopped, index) => (index === columnIndex ? true : stopped)),
        )

        // Resolve only after the last reel has had its full settle animation,
        // measured from when its stop actually happened (not wall-clock), so
        // the settled symbols are never cut over to the final face mid-motion.
        if (isLastColumn) {
          slotsResolveTimeoutRef.current = window.setTimeout(() => {
            setSlotsSpinning(false)
            setSlotsSpinTarget(null)
            setSlotsStoppedColumns(Array.from({ length: SLOT_COLUMNS }, () => false))
            slotsResolveTimeoutRef.current = null
            onSettled()
          }, SLOTS_REEL_SETTLE_MS + 140)
        }
      }, delay)
      slotsColumnStopTimeoutsRef.current.push(timeoutId)
    })
  }

  const handleSpinSlots = () => {
    if (slotsSpinning) {
      return
    }

    if (slotsBonusActive) {
      const currentBet = slotsBonusBet || bet
      const previousBonusGrid = slotsBonusGrid.map((row) => [...row])
      const { nextGrid, newOrbCount } = respinSlotsBonusGrid(previousBonusGrid, currentBet)
      const respinsLeft = slotsBonusRespins

      setSlotsMessage(
        `Hold & spin in progress. ${respinsLeft} respin${respinsLeft === 1 ? '' : 's'} left.`,
      )
      beginSlotsSpin(previousBonusGrid, nextGrid, () => {
        const filledCount = nextGrid.flat().filter(Boolean).length
        const nextRespins = newOrbCount > 0 ? 3 : respinsLeft - 1

        setSlotsBonusGrid(nextGrid)

        if (filledCount === SLOT_ROWS * SLOT_COLUMNS || nextRespins <= 0) {
          const bonusPayout = calculateSlotsBonusPayout(nextGrid, currentBet)
          const totalPayout = slotsBonusBasePayout + bonusPayout.totalPayout
          const result: RoundResult = {
            message: `Bonus complete. You collected $${bonusPayout.totalPayout}.`,
            delta: totalPayout - currentBet,
            payout: bonusPayout.totalPayout,
          }

          setSlotsBonusActive(false)
          setSlotsBonusRespins(0)
          setSlotsResult(result)
          setSlotsMessage(
            `${result.message} ${
              bonusPayout.hitGrand
                ? `Grand jackpot lands for $${slotsJackpots.grand}.`
                : bonusPayout.majorCount > 0 || bonusPayout.minorCount > 0 || bonusPayout.miniCount > 0
                  ? 'Jackpot orb hits included.'
                  : `Orb total $${bonusPayout.orbValueTotal}.`
            }`,
          )
          setBankroll((currentBankroll) => currentBankroll + result.payout)
          applyPlayerDailyDelta(result.delta)
          applyCasinoDailyDelta(result.delta)
          applyCasinoGameDailyDelta('slots', result.delta)
          return
        }

        setSlotsBonusRespins(nextRespins)
        setSlotsMessage(
          newOrbCount > 0
            ? `${newOrbCount} new orb${newOrbCount === 1 ? '' : 's'} locked in. Respins reset to 3.`
            : `No new orb this spin. ${nextRespins} respin${nextRespins === 1 ? '' : 's'} left.`,
        )
      })
      return
    }

    if (!canPlaceBets) {
      setBetInputError('Your bankroll is empty.')
      return
    }

    if (bet > bankroll) {
      setBetInputError(`Bet cannot be more than your bankroll of ${formatPoints(bankroll)}.`)
      return
    }

    setBankroll((currentBankroll) => currentBankroll - bet)
    setBetInputError('')

    const previousGrid = slotsGrid.map((row) => [...row])
    const finalGrid = createSlotsFinalGrid(bet)

    setSlotsBonusBasePayout(0)
    setSlotsBonusBet(0)
    setSlotsBonusGrid(createSlotsBonusGridFromSpin(createInitialSlotsGrid()))
    setSlotsMessage('Reels are spinning...')

    beginSlotsSpin(previousGrid, finalGrid, () => {
      const orbCount = countSlotsBonusSymbols(finalGrid)
      const { totalPayout, winningLines } = calculateSlotsLinePayout(finalGrid, bet)

      setSlotsGrid(finalGrid)

      if (orbCount >= 6) {
        setSlotsBonusActive(true)
        setSlotsBonusGrid(createSlotsBonusGridFromSpin(finalGrid))
        setSlotsBonusRespins(3)
        setSlotsBonusBasePayout(totalPayout)
        setSlotsBonusBet(bet)
        if (totalPayout > 0) {
          setBankroll((currentBankroll) => currentBankroll + totalPayout)
        }
        setSlotsMessage(
          `${orbCount} link orbs trigger the bonus. ${
            totalPayout > 0 ? `$${totalPayout} line win banked. ` : ''
          }Press the bonus button to respin.`,
        )
        return
      }

      const result: RoundResult = {
        message: totalPayout > 0 ? `${winningLines.join('. ')}.` : 'No line hit this spin.',
        delta: totalPayout - bet,
        payout: totalPayout,
      }

      setSlotsResult(result)
      setSlotsWinningCells(totalPayout > 0 ? getSlotsWinningCells(finalGrid) : null)
      setSlotsMessage(
        totalPayout > 0 ? `${result.message} You win $${totalPayout}.` : 'No hit this time. Spin again.',
      )
      if (totalPayout > 0) {
        setBankroll((currentBankroll) => currentBankroll + result.payout)
      }
      applyPlayerDailyDelta(result.delta)
      applyCasinoDailyDelta(result.delta)
      applyCasinoGameDailyDelta('slots', result.delta)
    })
  }

  const handleOpenSettings = () => {
    setSelectedGame('settings')
    resetRound()
    setBetInputError('')
  }

  const handleOpenSettingsPlayers = () => {
    setSelectedGame('settings-players')
    resetRound()
    setBetInputError('')
  }

  const handleOpenSettingsPlayerDetail = (profile: LocalPlayerProfile) => {
    setSelectedSettingsPlayerId(profile.id)
    setSelectedGame('settings-player-detail')
    resetRound()
    setBetInputError('')
    setSettingsPlayerDetailError('')
  }

  const handleAdjustSettingsPlayerBankroll = (amount: number) => {
    if (!selectedSettingsPlayer) {
      return
    }

    const nextBankroll = normalizeBankroll(selectedSettingsPlayer.bankroll + amount)
    const nextProfile = {
      ...selectedSettingsPlayer,
      bankroll: nextBankroll,
      updatedAt: new Date().toISOString(),
    }

    persistLocalPlayerProfile(nextProfile)
  }

  const handleSaveSettingsPlayerDetail = () => {
    if (!selectedSettingsPlayer) {
      return
    }

    const trimmedName = settingsPlayerDetailName.trim()
    const parsedBankroll = Number(settingsPlayerDetailBankroll)

    if (!trimmedName) {
      setSettingsPlayerDetailError('Enter a player name first.')
      return
    }

    if (!Number.isFinite(parsedBankroll) || parsedBankroll < 0) {
      setSettingsPlayerDetailError('Enter a valid score amount.')
      return
    }

    const nextProfile = {
      ...selectedSettingsPlayer,
      name: trimmedName,
      nameLocked: settingsPlayerDetailNameLocked,
      bankroll: normalizeBankroll(parsedBankroll),
      updatedAt: new Date().toISOString(),
    }

    persistLocalPlayerProfile(nextProfile)
    setSettingsPlayerDetailError('')
  }

  const handleDeleteSettingsPlayer = async () => {
    if (!selectedSettingsPlayer) {
      return
    }

    if (selectedSettingsPlayer.id === playerProfile.id) {
      setSettingsPlayerDetailError('You cannot delete the account currently in use.')
      return
    }

    deleteLocalPlayerProfile(selectedSettingsPlayer.id)
    clearPendingCashout(selectedSettingsPlayer.id)

    const profileRef = getDeveloperPlayerDocRef(selectedSettingsPlayer.id)

    if (profileRef) {
      try {
        await deleteDoc(profileRef)
      } catch (error) {
        console.error('Failed to delete player profile', error)
        setSettingsPlayerDetailError('Could not delete that player right now.')
        return
      }
    }

    setSettingsPlayers((currentPlayers) =>
      currentPlayers.filter((profile) => profile.id !== selectedSettingsPlayer.id),
    )
    setSelectedSettingsPlayerId('')
    setSettingsPlayerDetailError('')
    setSelectedGame('settings-players')
  }

  const handleOpenSettingsStatistics = () => {
    setSelectedGame('settings-statistics')
    resetRound()
    setCasinoGameDailyStats(readAllCasinoGameDailyStats())
    setCasinoDailyStats(syncCasinoDailyStatsWithGames())
    setBetInputError('')
  }

  const handleOpenGameStatistics = (game: CasinoTrackedGame) => {
    setSelectedCasinoStatsGame(game)
    setSelectedGame('settings-statistics-game')
    resetRound()
    setCasinoGameDailyStats(readAllCasinoGameDailyStats())
    setCasinoDailyStats(syncCasinoDailyStatsWithGames())
    setBetInputError('')
  }

  const applyCasinoDailyDelta = (playerDelta: number) => {
    recordCasinoDailyDelta(playerDelta)
    setCasinoDailyStats(readCasinoDailyStats())
  }

  const applyPlayerDailyDelta = (playerDelta: number) => {
    recordPlayerDailyDelta(playerProfile.id, playerDelta)
    setPlayerDailyStats(readPlayerDailyStats(playerProfile.id))
  }

  const applyCasinoGameDailyDelta = (game: CasinoTrackedGame, playerDelta: number) => {
    recordCasinoGameDailyDelta(game, playerDelta)
    const nextGameStats = readAllCasinoGameDailyStats()
    setCasinoGameDailyStats(nextGameStats)
    setCasinoDailyStats(aggregateCasinoDailyStatsFromGames(nextGameStats))
  }

  const handleOpenCasinoStatsReset = () => {
    setCasinoStatsResetPromptOpen(true)
    setCasinoStatsResetConfirmOpen(false)
    setCasinoStatsResetInput('')
    setCasinoStatsResetError('')
  }

  const handleVerifyCasinoStatsReset = async () => {
    setCasinoStatsResetVerifying(true)
    setCasinoStatsResetError('')

    try {
      await signInAsDeveloper()
      setCasinoStatsResetPromptOpen(false)
      setCasinoStatsResetConfirmOpen(true)
      setCasinoStatsResetInput('')
      setCasinoStatsResetError('')
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Google sign-in failed. Try again.'
      setCasinoStatsResetError(message)
    } finally {
      setCasinoStatsResetVerifying(false)
    }
  }

  const handleConfirmCasinoStatsReset = () => {
    if (selectedGame === 'settings-statistics-game') {
      clearCasinoGameDailyStats(selectedCasinoStatsGame)
      const nextGameStats = readAllCasinoGameDailyStats()
      setCasinoGameDailyStats(nextGameStats)
      setCasinoDailyStats(syncCasinoDailyStatsWithGames())
    } else {
      clearCasinoDailyStats()
      clearCasinoGameDailyStats()
      setCasinoDailyStats([])
      setCasinoGameDailyStats({
        blackjack: [],
        roulette: [],
        hilo: [],
        mines: [],
        plinko: [],
        slots: [],
        dice: [],
        chicken: [],
        jetstream: [],
      })
    }
    setCasinoStatsResetConfirmOpen(false)
    setCasinoStatsResetPromptOpen(false)
    setCasinoStatsResetInput('')
    setCasinoStatsResetError('')
    setCasinoStatsResetVerifying(false)
  }

  const handleCancelCasinoStatsReset = () => {
    setCasinoStatsResetPromptOpen(false)
    setCasinoStatsResetConfirmOpen(false)
    setCasinoStatsResetInput('')
    setCasinoStatsResetError('')
  }

  const handleOpenPlinko = () => {
    setSelectedGame('plinko')
    resetRound()
    setBetInput(String(bet))
    setBetInputError('')
  }

  const applyMinesCount = () => {
    const parsedMinesCount = Number(minesCountInput)

    if (
      !Number.isFinite(parsedMinesCount) ||
      !Number.isInteger(parsedMinesCount) ||
      parsedMinesCount < MINES_MIN_COUNT ||
      parsedMinesCount > MINES_MAX_COUNT
    ) {
      setBetInputError(`Mines must be a whole number between ${MINES_MIN_COUNT} and ${MINES_MAX_COUNT}.`)
      return
    }

    setMinesCount(parsedMinesCount)
    setBetInputError('')
  }

  const handleStartPlinkoDrop = () => {
    if (!canPlaceBets) {
      setBetInputError('You are out of points.')
      return
    }

    if (bet > bankroll) {
      setBetInputError(`Bet cannot be more than your bankroll of ${formatPoints(bankroll)}.`)
      return
    }

    const nextDrop: PendingPlinkoDrop = {
      id: `plinko-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      bet,
      centerBias: getPlinkoCenterBiasForWinStreak(plinkoWinStreak),
    }

    setBankroll((currentBankroll) => currentBankroll - bet)
    setPendingPlinkoDrops((currentDrops) => [...currentDrops, nextDrop])
    setPlinkoInFlightDrops((currentDrops) => currentDrops + 1)
    setPlinkoResult(null)
    setPlinkoMessage('Ball is in the air...')
    setBetInputError('')
  }

  const handleSettlePlinkoDrop = (dropId: string, slotIndex: number) => {
    // Settle each ball exactly once. The side effects live OUT here (not inside
    // a setState updater) so React StrictMode's double-invoked updaters can't
    // pay out or decrement the live count twice.
    if (settledPlinkoIdsRef.current.has(dropId)) {
      return
    }

    const settledDrop = pendingPlinkoDropsRef.current.find((drop) => drop.id === dropId)
    if (!settledDrop) {
      return
    }

    settledPlinkoIdsRef.current.add(dropId)

    const multiplier = PLINKO_MULTIPLIERS[slotIndex]
    const payout = roundMoney(settledDrop.bet * multiplier)
    const net = roundMoney(payout - settledDrop.bet)
    const round: PlinkoRound = { id: dropId, bet: settledDrop.bet, slotIndex, multiplier, payout, net }

    setBankroll((currentBankroll) => currentBankroll + payout)
    applyPlayerDailyDelta(net)
    applyCasinoDailyDelta(net)
    applyCasinoGameDailyDelta('plinko', net)
    setPlinkoResult(round)
    setPlinkoHistory((currentHistory) => [round, ...currentHistory].slice(0, 4))
    setPlinkoInFlightDrops((currentCount) => Math.max(0, currentCount - 1))
    setPlinkoWinStreak((currentStreak) => (payout > settledDrop.bet ? currentStreak + 1 : 0))
    setPlinkoMessage(
      `Ball lands in ${multiplier}x. ${
        net >= 0 ? `You win $${net.toFixed(2)}.` : `You lose $${Math.abs(net).toFixed(2)}.`
      }`,
    )
    setPendingPlinkoDrops((currentDrops) => currentDrops.filter((drop) => drop.id !== dropId))
  }

  const resetChickenRun = () => {
    chickenHopLockRef.current = false
    setChickenStatus('idle')
    setChickenLane(0)
    setChickenBet(0)
    setChickenDeathLane(null)
    setChickenResult(null)
    setChickenMessage('Pick a difficulty, set your bet, and start crossing.')
  }

  const handleOpenChicken = () => {
    setSelectedGame('chicken')
    resetRound()
    resetChickenRun()
    setBetInput(String(bet))
    setBetInputError('')
  }

  const resetJetstreamRound = () => {
    setJetstreamStatus('idle')
    setJetstreamFlight(null)
    setJetstreamResult(null)
    setJetstreamMessage('Pick a speed, set your bet and press Play.')
  }

  const handleOpenJetstream = () => {
    setSelectedGame('jetstream')
    resetRound()
    resetJetstreamRound()
    setBetInput(String(bet))
    setBetInputError('')
  }

  const handleSelectJetSpeed = (speed: JetSpeed) => {
    if (jetstreamStatus === 'flying') {
      return
    }
    setJetstreamSpeed(speed)
  }

  // Pay out (or not) the flight in the air. Runs once per flight: when the
  // board reports the landing/splash, or right away if the player leaves.
  const settleJetstreamFlight = () => {
    const pending = jetstreamPendingRef.current
    if (!pending) {
      return
    }
    jetstreamPendingRef.current = null
    const { flight, bet: stake } = pending
    const payout = roundMoney(stake * flight.payoutMultiplier)
    const net = roundMoney(payout - stake)
    const round: JetstreamRound = {
      id: flight.id,
      bet: stake,
      multiplier: flight.payoutMultiplier,
      payout,
      net,
      cashed: flight.landed,
    }
    if (payout > 0) {
      setBankroll((currentBankroll) => currentBankroll + payout)
    }
    applyPlayerDailyDelta(net)
    applyCasinoDailyDelta(net)
    applyCasinoGameDailyDelta('jetstream', net)
    setJetstreamResult(round)
    setJetstreamHistory((current) => [round, ...current].slice(0, 8))
    setJetstreamStatus(flight.landed ? 'landed' : 'splashed')
    setJetstreamMessage(
      flight.landed
        ? `Landed at ${formatJetMultiplier(flight.payoutMultiplier)} — ${formatPoints(payout)} (+$${net.toFixed(2)}).`
        : `Splash! The plane went into the sea. You lose $${stake.toFixed(2)}.`,
    )
  }

  const handleJetstreamFinish = (flightId: string) => {
    if (jetstreamPendingRef.current?.flight.id === flightId) {
      settleJetstreamFlight()
    }
  }

  const handleLaunchJetstream = () => {
    if (jetstreamStatus === 'flying' || jetstreamPendingRef.current) {
      return
    }
    if (!canPlaceBets) {
      setBetInputError('You are out of points.')
      return
    }
    if (bet > bankroll) {
      setBetInputError(`Bet cannot be more than your bankroll of ${formatPoints(bankroll)}.`)
      return
    }

    const flight = generateJetFlight(jetstreamSpeed)
    setBankroll((currentBankroll) => currentBankroll - bet)
    jetstreamPendingRef.current = { flight, bet }
    setJetstreamBet(bet)
    setJetstreamFlight(flight)
    setJetstreamResult(null)
    setJetstreamStatus('flying')
    setBetInputError('')
    setJetstreamMessage(`${JET_SPEEDS[jetstreamSpeed].label} flight in the air — it has to reach the carrier.`)
  }

  // Leaving the table mid-flight still settles the bet (the outcome was fixed at takeoff).
  useEffect(() => {
    if (selectedGame !== 'jetstream') {
      settleJetstreamFlight()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedGame])

  const handleSelectChickenDifficulty = (difficulty: ChickenDifficulty) => {
    if (chickenStatus === 'playing') {
      return
    }
    setChickenDifficulty(difficulty)
    resetChickenRun()
  }

  const handleStartChickenRun = () => {
    if (chickenStatus === 'playing') {
      return
    }
    if (!canPlaceBets) {
      setBetInputError('You are out of points.')
      return
    }
    if (bet > bankroll) {
      setBetInputError(`Bet cannot be more than your bankroll of ${formatPoints(bankroll)}.`)
      return
    }

    setBankroll((currentBankroll) => currentBankroll - bet)
    chickenHopLockRef.current = false
    setChickenBet(bet)
    setChickenLane(0)
    setChickenDeathLane(null)
    setChickenResult(null)
    setChickenStatus('playing')
    setChickenMessage('Tap Cross to hop into traffic — cash out any time.')
    setBetInputError('')
  }

  const settleChickenRound = (round: ChickenRound) => {
    applyPlayerDailyDelta(round.net)
    applyCasinoDailyDelta(round.net)
    applyCasinoGameDailyDelta('chicken', round.net)
    setChickenResult(round)
    setChickenHistory((currentHistory) => [round, ...currentHistory].slice(0, 4))
  }

  const handleChickenStep = () => {
    if (chickenStatus !== 'playing' || chickenHopLockRef.current) {
      return
    }

    const nextLane = chickenLane + 1
    if (nextLane > CHICKEN_LANES) {
      return
    }

    const config = getChickenConfig(chickenDifficulty)
    chickenHopLockRef.current = true

    if (rollChickenHop(config, nextLane - 1)) {
      setChickenLane(nextLane)
      const multiplier = config.multipliers[nextLane - 1]
      setChickenMessage(
        nextLane >= CHICKEN_LANES
          ? `Final lane! ${formatChickenMultiplier(multiplier)} — cash out now.`
          : `Lane ${nextLane}: ${formatChickenMultiplier(multiplier)}. Cash out or push on.`,
      )
      window.setTimeout(() => {
        chickenHopLockRef.current = false
      }, 380)
    } else {
      setChickenDeathLane(nextLane)
      setChickenStatus('dead')
      const round: ChickenRound = {
        id: `chicken-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        bet: chickenBet,
        difficulty: chickenDifficulty,
        lane: nextLane,
        multiplier: 0,
        payout: 0,
        net: roundMoney(-chickenBet),
        cashed: false,
      }
      settleChickenRound(round)
      setChickenMessage(`Splat! A car got you on lane ${nextLane}. You lose $${chickenBet.toFixed(2)}.`)
    }
  }

  const handleChickenCashout = () => {
    if (chickenStatus !== 'playing' || chickenLane < 1) {
      return
    }

    const config = getChickenConfig(chickenDifficulty)
    const multiplier = config.multipliers[chickenLane - 1]
    const payout = roundMoney(chickenBet * multiplier)
    const net = roundMoney(payout - chickenBet)

    setBankroll((currentBankroll) => currentBankroll + payout)
    chickenHopLockRef.current = false
    setChickenStatus('cashed')
    settleChickenRound({
      id: `chicken-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      bet: chickenBet,
      difficulty: chickenDifficulty,
      lane: chickenLane,
      multiplier,
      payout,
      net,
      cashed: true,
    })
    setChickenMessage(`Cashed out at ${formatChickenMultiplier(multiplier)} for ${formatPoints(payout)} (+$${net.toFixed(2)}).`)
  }

  const handleChoosePokerMode = (mode: 'join' | 'create') => {
    setPokerScreen('entry')
    setPokerMode(mode)
    setPokerMessage(
      mode === 'join'
        ? hasSavedPlayerName
          ? `Enter the 4 character room code to join an existing poker table as ${playerProfile.name}.`
          : 'Enter your name and the 4 character room code to join an existing poker table.'
        : hasSavedPlayerName
          ? `Create a new poker table as ${playerProfile.name} and share the room code with friends.`
          : 'Enter your name, then create a new poker table and share the room code with friends.',
    )
    setBetInputError('')
    setPokerActionError('')
  }

  const handleResetPokerMode = () => {
    setPokerScreen('entry')
    setPokerMode('choose')
    setPokerMessage('Choose whether you want to create a table or join one with a room code.')
    setBetInputError('')
    setPokerActionError('')
  }

  const handleSubmitPoker = async (mode: 'join' | 'create') => {
    const trimmedName = hasSavedPlayerName ? playerProfile.name.trim() : pokerName.trim()
    const trimmedCode = pokerCode.trim().toUpperCase()

    if (!isFirebaseConfigured) {
      setBetInputError(firebaseConfigError ?? 'Firebase is not configured.')
      return
    }

    if (!trimmedName) {
      setBetInputError('Enter your name first.')
      return
    }

    if (mode === 'join') {
      if (!/^[A-Z0-9]{4}$/.test(trimmedCode)) {
        setBetInputError('Join codes must be exactly 4 letters or numbers.')
        return
      }

      const nextRoom = await readPokerRoom(trimmedCode)

      if (!nextRoom) {
        setBetInputError('That room code is not active.')
        return
      }

      const existingSeatIndex = nextRoom.seats.findIndex((seat) => seat?.id === pokerPlayerId)
      const nextOpenSeat = nextRoom.seats.findIndex((seat) => seat === null)

      if (existingSeatIndex === -1 && nextOpenSeat === -1) {
        setBetInputError('That table is already full.')
        return
      }

      const updatedSeats = [...nextRoom.seats]
      updatedSeats[existingSeatIndex === -1 ? nextOpenSeat : existingSeatIndex] = {
        id: pokerPlayerId,
        name: trimmedName,
      }

      await writePokerRoom({ ...nextRoom, seats: updatedSeats })
      setPokerCode(trimmedCode)
      setPokerRoomCode(trimmedCode)
      setPokerHostId(nextRoom.hostId)
      setPokerDealerSeatIndex(nextRoom.dealerSeatIndex)
      setPokerPlayerChips(nextRoom.playerChips)
      setPokerSeats(updatedSeats)
      setPokerGame(nextRoom.game)
      setPokerBuyIn(nextRoom.buyIn)
      setPokerBuyInInput(String(nextRoom.buyIn))
      setPokerScreen('table')
      setPokerMessage(
        nextRoom.game?.winnerMessage ?? nextRoom.game?.lastAction ?? getPokerRoomMessage(updatedSeats.filter(Boolean).length),
      )
      setBetInputError('')
      setPokerActionError('')
      return
    }

    let nextCode = createPokerRoomCode()

    while (await readPokerRoom(nextCode)) {
      nextCode = createPokerRoomCode()
    }

    const nextSeats = Array.from({ length: 6 }, (_, index) =>
      index === 4 ? { id: pokerPlayerId, name: trimmedName } : null,
    )
    const nextRoom = {
      code: nextCode,
      buyIn: pokerBuyIn,
      smallBlind: pokerSmallBlind,
      bigBlind: pokerBigBlind,
      hostId: pokerPlayerId,
      dealerSeatIndex: -1,
      playerChips: {},
      seats: nextSeats,
      game: null,
      pendingStart: null,
    }

    await writePokerRoom(nextRoom)
    setPokerRoomCode(nextCode)
    setPokerHostId(pokerPlayerId)
    setPokerDealerSeatIndex(nextRoom.dealerSeatIndex)
    setPokerPlayerChips(nextRoom.playerChips)
    setPokerCode(nextCode)
    setPokerSeats(nextSeats)
    setPokerGame(null)
    setPokerPendingStart(null)
    setPokerScreen('table')
    setPokerMessage(getPokerRoomMessage(nextSeats.filter(Boolean).length))
    setBetInputError('')
    setPokerActionError('')
  }

  const applyPokerBuyIn = async () => {
    const parsedBuyIn = Number(pokerBuyInInput)

    if (!Number.isFinite(parsedBuyIn) || parsedBuyIn < MIN_BET) {
      setBetInputError(`Buy in must be at least $${MIN_BET}.`)
      return
    }

    if (parsedBuyIn > bankroll) {
      setBetInputError(`Buy-in cannot be more than your bankroll of ${formatPoints(bankroll)}.`)
      return
    }

    if (pokerRoomCode) {
      const activeRoom = await readPokerRoom(pokerRoomCode)

      if (activeRoom) {
        await writePokerRoom({ ...activeRoom, buyIn: parsedBuyIn })
      }
    }

    setPokerBuyIn(parsedBuyIn)
    setPokerBuyInInput(String(parsedBuyIn))
    setBetInputError('')
  }

  const applyPokerBlinds = async () => {
    const parsedSmallBlind = Number(pokerSmallBlindInput)

    if (!Number.isFinite(parsedSmallBlind) || parsedSmallBlind <= 0) {
      setBetInputError('Small blind must be greater than $0.')
      return
    }

    const parsedBigBlind = parsedSmallBlind * 2

    if (pokerRoomCode) {
      const activeRoom = await readPokerRoom(pokerRoomCode)

      if (activeRoom) {
        await writePokerRoom({
          ...activeRoom,
          smallBlind: parsedSmallBlind,
          bigBlind: parsedBigBlind,
        })
      }
    }

    setPokerSmallBlind(parsedSmallBlind)
    setPokerSmallBlindInput(String(parsedSmallBlind))
    setPokerBigBlind(parsedBigBlind)
    setBetInputError('')
  }

  const updatePokerRoom = async (updater: (room: PokerRoomState) => PokerRoomState | null) => {
    if (!pokerRoomCode) {
      return
    }

    const activeRoom = await readPokerRoom(pokerRoomCode)

    if (!activeRoom) {
      setPokerActionError('That poker room is no longer active.')
      return
    }

    const nextRoom = updater(activeRoom)

    if (!nextRoom) {
      return
    }

    await writePokerRoom(nextRoom)
    setPokerSeats(nextRoom.seats)
    setPokerHostId(nextRoom.hostId)
    setPokerDealerSeatIndex(nextRoom.dealerSeatIndex)
    setPokerPlayerChips(nextRoom.playerChips)
    setPokerGame(nextRoom.game)
    setPokerPendingStart(nextRoom.pendingStart)
    setPokerBuyIn(nextRoom.buyIn)
    setPokerBuyInInput(String(nextRoom.buyIn))
    setPokerSmallBlind(nextRoom.smallBlind)
    setPokerSmallBlindInput(String(nextRoom.smallBlind))
    setPokerBigBlind(nextRoom.bigBlind)
    setPokerMessage(
      nextRoom.pendingStart
        ? `Waiting for players to confirm the ${formatPoints(nextRoom.pendingStart.buyIn)} entry.`
        : nextRoom.game?.winnerMessage ?? nextRoom.game?.lastAction ?? getPokerRoomMessage(nextRoom.seats.filter(Boolean).length),
    )
  }

  const resolvePokerShowdown = (room: PokerRoomState): PokerRoomState => {
    if (!room.game) {
      return room
    }

    const eligibleSeats = room.seats
      .map((seat, index) => ({ seat, index }))
      .filter(
        ({ seat }) =>
          seat &&
          room.game &&
          room.game.players[seat.id] &&
          !room.game.players[seat.id].folded,
      ) as { seat: PokerSeat; index: number }[]

    const scores = eligibleSeats.map(({ seat }) => ({
      seat,
      score: evaluateBestPokerHand([
        ...room.game!.communityCards,
        ...room.game!.players[seat.id].holeCards,
      ]),
    }))

    const bestScore = scores.reduce<number[]>(
      (best, entry) => (comparePokerScores(entry.score, best) > 0 ? entry.score : best),
      [-1],
    )
    const winners = scores.filter((entry) => comparePokerScores(entry.score, bestScore) === 0)
    const splitAmount = winners.length > 0 ? Math.floor(room.game.pot / winners.length) : 0
    const remainder = winners.length > 0 ? room.game.pot % winners.length : 0
    const nextPlayerChips = { ...room.playerChips }

    winners.forEach((winner, index) => {
      nextPlayerChips[winner.seat.id] =
        (nextPlayerChips[winner.seat.id] ?? room.buyIn) + splitAmount + (index === 0 ? remainder : 0)
    })

    return {
      ...room,
      playerChips: nextPlayerChips,
      game: {
        ...room.game,
        street: 'showdown',
        activeSeatIndex: -1,
        actionId: room.game.actionId + 1,
        lastActorId: winners.length === 1 ? winners[0].seat.id : null,
        lastActionType: 'showdown' as PokerActionType,
        lastContributions: [],
        winnerMessage:
          winners.length === 1
            ? `${winners[0].seat.name} wins the pot of $${room.game.pot}.`
            : `${winners.map((winner) => winner.seat.name).join(' and ')} split the pot of $${room.game.pot}.`,
        lastAction: 'Hand complete.',
      },
    }
  }

  const advancePokerStreet = (room: PokerRoomState): PokerRoomState => {
    if (!room.game) {
      return room
    }

    const remainingPlayers = room.seats
      .map((seat) => (seat ? room.game!.players[seat.id] : null))
      .filter(Boolean) as PokerPlayerState[]

    if (remainingPlayers.filter((player) => !player.folded).length <= 1) {
      const winningSeat = room.seats.find((seat) => seat && !room.game!.players[seat.id].folded)

      if (!winningSeat) {
        return room
      }

      return {
        ...room,
        playerChips: {
          ...room.playerChips,
          [winningSeat.id]: (room.playerChips[winningSeat.id] ?? room.buyIn) + room.game.pot,
        },
        game: {
          ...room.game,
          street: 'showdown',
          activeSeatIndex: -1,
          actionId: room.game.actionId + 1,
          lastActorId: winningSeat.id,
          lastActionType: 'showdown' as PokerActionType,
          lastContributions: [],
          winnerMessage: `${winningSeat.name} wins the pot of $${room.game.pot}.`,
          lastAction: 'Hand complete.',
        },
      }
    }

    const activePlayers = room.seats
      .map((seat, index) => ({ seat, index }))
      .filter(
        ({ seat }) =>
          seat &&
          room.game &&
          room.game.players[seat.id] &&
          !room.game.players[seat.id].folded &&
          !room.game.players[seat.id].allIn,
      ) as { seat: PokerSeat; index: number }[]

    const everyoneMatched =
      activePlayers.length === 0 ||
      activePlayers.every(
        ({ seat }) =>
          room.game!.players[seat.id].acted &&
          room.game!.players[seat.id].committed === room.game!.currentBet,
      )

    if (!everyoneMatched) {
      return room
    }

    let nextStreet: PokerStreet = room.game.street
    let cardsToDraw = 0

    if (room.game.street === 'preflop') {
      nextStreet = 'flop'
      cardsToDraw = 3
    } else if (room.game.street === 'flop') {
      nextStreet = 'turn'
      cardsToDraw = 1
    } else if (room.game.street === 'turn') {
      nextStreet = 'river'
      cardsToDraw = 1
    } else {
      return resolvePokerShowdown(room)
    }

    const { drawnCards, remainingDeck } = drawCards(room.game.deck, cardsToDraw)
    const nextPlayers = Object.fromEntries(
      Object.entries(room.game.players).map(([playerId, playerState]) => [
        playerId,
        { ...playerState, committed: 0, acted: playerState.allIn },
      ]),
    ) as Record<string, PokerPlayerState>
    const nextActiveSeatIndex = getNextPokerSeatIndex(
      room.seats,
      room.dealerSeatIndex,
      (seat) =>
        Boolean(
          seat &&
            nextPlayers[seat.id] &&
            !nextPlayers[seat.id].folded &&
            !nextPlayers[seat.id].allIn,
        ),
    )

    const nextRoom = {
      ...room,
      game: {
        ...room.game,
        street: nextStreet,
        currentBet: 0,
        activeSeatIndex: nextActiveSeatIndex,
        communityCards: [...room.game.communityCards, ...drawnCards],
        deck: remainingDeck,
        players: nextPlayers,
        actionId: room.game.actionId + 1,
        // keep the action that closed the round, so everyone still sees it
        lastActorId: room.game.lastActorId,
        lastActionType: room.game.lastActorId ? room.game.lastActionType : ('street' as PokerActionType),
        lastContributions: room.game.lastContributions ?? [],
        lastAction: `${room.game.lastActorId ? `${room.game.lastAction} ` : ''}${nextStreet.charAt(0).toUpperCase()}${nextStreet.slice(1)} card(s) are out.`,
        winnerMessage: null,
      },
    }

    const allRemainingAreAllIn = room.seats.every((seat) => {
      if (!seat) {
        return true
      }

      const playerState = nextPlayers[seat.id]
      return playerState.folded || playerState.allIn
    })

    return allRemainingAreAllIn ? advancePokerStreet(nextRoom) : nextRoom
  }

  const handleStartPokerGame = () => {
    updatePokerRoom((room) => {
      if (room.hostId !== pokerPlayerId || room.seats.filter(Boolean).length < 2) {
        setPokerActionError('Only the host can start the game once 2 or more players are seated.')
        return null
      }

      const playersNeedingBuyIn = room.seats
        .filter(Boolean)
        .map((seat) => seat as PokerSeat)
        .filter((seat) => (room.playerChips[seat.id] ?? 0) <= 0)
        .map((seat) => seat.id)

      setPokerActionError('')

      if (playersNeedingBuyIn.length === 0) {
        return startPokerHand(room)
      }

      return {
        ...room,
        game: null,
        pendingStart: {
          buyIn: room.buyIn,
          playerIds: playersNeedingBuyIn,
          confirmedPlayerIds: [],
        },
      }
    })
  }

  const handleConfirmPokerBuyIn = () => {
    updatePokerRoom((room) => {
      if (!room.pendingStart || !pokerYouSeat) {
        return null
      }

      if ((room.playerChips[pokerPlayerId] ?? 0) <= 0 && bankroll < room.pendingStart.buyIn) {
        const nextSeats = room.seats.map((seat) => (seat?.id === pokerPlayerId ? null : seat))
        const nextPlayerChips = { ...room.playerChips }
        delete nextPlayerChips[pokerPlayerId]
        const remainingSeats = nextSeats.filter(Boolean) as PokerSeat[]
        const nextHostId =
          room.hostId === pokerPlayerId ? remainingSeats[0]?.id ?? '' : room.hostId
        const nextPendingStart = {
          ...room.pendingStart,
          playerIds: room.pendingStart.playerIds.filter((playerId) => playerId !== pokerPlayerId),
          confirmedPlayerIds: room.pendingStart.confirmedPlayerIds.filter(
            (playerId) => playerId !== pokerPlayerId,
          ),
        }

        setSelectedGame('lobby')
        setPokerScreen('entry')
        setPokerRoomCode('')
        setPokerHostId('')
        setPokerDealerSeatIndex(-1)
        setPokerPlayerChips({})
        setPokerSeats(Array.from({ length: 6 }, () => null))
        setPokerGame(null)
        setPokerPendingStart(null)
        setPokerMessage(`You need at least ${formatPoints(room.pendingStart.buyIn)} to join and were removed from the table.`)
        setPokerInsufficientFundsModal(true)
        setBetInputError('')
        setPokerActionError('')

        return {
          ...room,
          hostId: nextHostId,
          seats: nextSeats,
          playerChips: nextPlayerChips,
          pendingStart:
            remainingSeats.length >= 2 && nextPendingStart.playerIds.length > 0
              ? nextPendingStart
              : null,
          game: null,
        }
      }

      const confirmedPlayerIds = room.pendingStart.confirmedPlayerIds.includes(pokerPlayerId)
        ? room.pendingStart.confirmedPlayerIds
        : [...room.pendingStart.confirmedPlayerIds, pokerPlayerId]
      const nextPlayerChips = { ...room.playerChips }
      const needsDeposit = (nextPlayerChips[pokerPlayerId] ?? 0) <= 0

      if (needsDeposit) {
        nextPlayerChips[pokerPlayerId] = room.pendingStart.buyIn
        setBankroll((currentBankroll) => currentBankroll - room.pendingStart!.buyIn)
      }

      const confirmationsNeeded = room.pendingStart.playerIds.length

      if (confirmedPlayerIds.length < confirmationsNeeded) {
        setPokerActionError('')
        return {
          ...room,
          playerChips: nextPlayerChips,
          pendingStart: {
            ...room.pendingStart,
            confirmedPlayerIds,
          },
        }
      }

      setPokerActionError('')
      return startPokerHand({
        ...room,
        playerChips: nextPlayerChips,
        pendingStart: null,
      })
    })
  }

  const handleDeclinePokerBuyIn = () => {
    updatePokerRoom((room) => {
      if (!pokerYouSeat) {
        return null
      }

      const nextSeats = room.seats.map((seat) => (seat?.id === pokerPlayerId ? null : seat))
      const nextPlayerChips = { ...room.playerChips }
      delete nextPlayerChips[pokerPlayerId]
      const remainingSeats = nextSeats.filter(Boolean) as PokerSeat[]
      const nextHostId =
        room.hostId === pokerPlayerId ? remainingSeats[0]?.id ?? '' : room.hostId
      const nextPendingStart = room.pendingStart
        ? {
            ...room.pendingStart,
            confirmedPlayerIds: room.pendingStart.confirmedPlayerIds.filter(
              (playerId) => playerId !== pokerPlayerId,
            ),
          }
        : null

      const nextRoom = {
        ...room,
        hostId: nextHostId,
        seats: nextSeats,
        playerChips: nextPlayerChips,
        pendingStart:
          remainingSeats.length >= 2
            ? nextPendingStart
            : null,
        game: null,
      }

      setSelectedGame('lobby')
      setPokerScreen('entry')
      setPokerRoomCode('')
      setPokerHostId('')
      setPokerDealerSeatIndex(-1)
      setPokerPlayerChips({})
      setPokerSeats(Array.from({ length: 6 }, () => null))
      setPokerGame(null)
      setPokerPendingStart(null)
      setPokerMessage('You skipped the entry step and left the table.')
      setBetInputError('')
      setPokerActionError('')

      return nextRoom
    })
  }

  const handleCashOutPoker = () => {
    updatePokerRoom((room) => {
      if (!pokerYouSeat) {
        return null
      }

      if (room.game && room.game.street !== 'showdown') {
      setPokerActionError('You can leave after the current hand ends.')
        return null
      }

      const cashOutAmount = room.playerChips[pokerPlayerId] ?? 0
      const nextSeats = room.seats.map((seat) => (seat?.id === pokerPlayerId ? null : seat))
      const nextPlayerChips = { ...room.playerChips }
      delete nextPlayerChips[pokerPlayerId]
      const remainingSeats = nextSeats.filter(Boolean) as PokerSeat[]
      const nextHostId =
        room.hostId === pokerPlayerId ? remainingSeats[0]?.id ?? '' : room.hostId
      const nextPendingStart = room.pendingStart
        ? {
            ...room.pendingStart,
            playerIds: room.pendingStart.playerIds.filter((playerId) => playerId !== pokerPlayerId),
            confirmedPlayerIds: room.pendingStart.confirmedPlayerIds.filter(
              (playerId) => playerId !== pokerPlayerId,
            ),
          }
        : null

      setBankroll((currentBankroll) => currentBankroll + cashOutAmount)
      setSelectedGame('lobby')
      setPokerScreen('entry')
      setPokerRoomCode('')
      setPokerHostId('')
      setPokerDealerSeatIndex(-1)
      setPokerPlayerChips({})
      setPokerSeats(Array.from({ length: 6 }, () => null))
      setPokerGame(null)
      setPokerPendingStart(null)
      setPokerMessage(
        cashOutAmount > 0
          ? `You cashed out $${cashOutAmount} and left the poker table.`
          : 'You left the poker table.',
      )
      setBetInputError('')
      setPokerActionError('')

      return {
        ...room,
        hostId: nextHostId,
        seats: nextSeats,
        playerChips: nextPlayerChips,
        pendingStart:
          remainingSeats.length >= 2 && nextPendingStart && nextPendingStart.playerIds.length > 0
            ? nextPendingStart
            : null,
        game: null,
      }
    })
  }

  const handlePokerFold = () => {
    updatePokerRoom((room) => {
      if (!room.game || pokerYouSeatIndex === -1 || room.game.activeSeatIndex !== pokerYouSeatIndex || !pokerYouSeat) {
        return null
      }

      const nextPlayers = {
        ...room.game.players,
        [pokerYouSeat.id]: { ...room.game.players[pokerYouSeat.id], folded: true, acted: true },
      }
      const nextActiveSeatIndex = getNextPokerSeatIndex(
        room.seats,
        pokerYouSeatIndex,
        (seat) =>
          Boolean(
            seat &&
              nextPlayers[seat.id] &&
              !nextPlayers[seat.id].folded &&
              !nextPlayers[seat.id].allIn,
          ),
      )

      setPokerActionError('')
      return advancePokerStreet({
        ...room,
        game: {
          ...room.game,
          players: nextPlayers,
          activeSeatIndex: nextActiveSeatIndex,
          actionId: room.game.actionId + 1,
          lastActorId: pokerYouSeat.id,
          lastActionType: 'fold' as PokerActionType,
          lastContributions: [],
          lastAction: `${pokerYouSeat.name} folds.`,
          winnerMessage: null,
        },
      })
    })
  }

  const handlePokerCallOrCheck = () => {
    updatePokerRoom((room) => {
      if (!room.game || pokerYouSeatIndex === -1 || room.game.activeSeatIndex !== pokerYouSeatIndex || !pokerYouSeat) {
        return null
      }

      const playerState = room.game.players[pokerYouSeat.id]
      const amountToCall = getPokerAmountToCall({
        seats: room.seats,
        dealerSeatIndex: room.dealerSeatIndex,
        players: room.game.players,
        currentBet: room.game.currentBet,
        street: room.game.street,
        smallBlind: room.smallBlind,
        seatIndex: pokerYouSeatIndex,
        seatId: pokerYouSeat.id,
      })
      const payment = Math.min(amountToCall, playerState.chips)
      const nextPlayers = {
        ...room.game.players,
        [pokerYouSeat.id]: {
          ...playerState,
          chips: playerState.chips - payment,
          committed: playerState.committed + payment,
          acted: true,
          allIn: playerState.chips === payment,
        },
      }
      const nextPlayerChips = {
        ...room.playerChips,
        [pokerYouSeat.id]: playerState.chips - payment,
      }
      const nextActiveSeatIndex = getNextPokerSeatIndex(
        room.seats,
        pokerYouSeatIndex,
        (seat) =>
          Boolean(
            seat &&
              nextPlayers[seat.id] &&
              !nextPlayers[seat.id].folded &&
              !nextPlayers[seat.id].allIn,
          ),
      )

      setPokerActionError('')
      return advancePokerStreet({
        ...room,
        playerChips: nextPlayerChips,
        game: {
          ...room.game,
          pot: room.game.pot + payment,
          players: nextPlayers,
          activeSeatIndex: nextActiveSeatIndex,
          actionId: room.game.actionId + 1,
          lastActorId: pokerYouSeat.id,
          lastActionType: (amountToCall > 0 ? 'call' : 'check') as PokerActionType,
          lastContributions: payment > 0 ? [{ playerId: pokerYouSeat.id, amount: payment }] : [],
          lastAction: amountToCall > 0 ? `${pokerYouSeat.name} calls $${payment}.` : `${pokerYouSeat.name} checks.`,
          winnerMessage: null,
        },
      })
    })
  }

  const handlePokerRaise = () => {
    updatePokerRoom((room) => {
      if (!room.game || pokerYouSeatIndex === -1 || room.game.activeSeatIndex !== pokerYouSeatIndex || !pokerYouSeat) {
        return null
      }

      const raiseTarget = Number(pokerRaiseInput)

      if (!Number.isFinite(raiseTarget) || raiseTarget <= room.game.currentBet) {
        setPokerActionError('Raise amount must be higher than the current bet.')
        return null
      }

      const playerState = room.game.players[pokerYouSeat.id]
      const additionalAmount = raiseTarget - playerState.committed

      if (additionalAmount > playerState.chips) {
        setPokerActionError('You do not have enough markers for that raise.')
        return null
      }

      const nextPlayers = Object.fromEntries(
        Object.entries(room.game.players).map(([playerId, state]) => [
          playerId,
          { ...state, acted: playerId === pokerYouSeat.id },
        ]),
      ) as Record<string, PokerPlayerState>
      nextPlayers[pokerYouSeat.id] = {
        ...nextPlayers[pokerYouSeat.id],
        chips: playerState.chips - additionalAmount,
        committed: raiseTarget,
        allIn: playerState.chips === additionalAmount,
      }

      const nextActiveSeatIndex = getNextPokerSeatIndex(
        room.seats,
        pokerYouSeatIndex,
        (seat) =>
          Boolean(
            seat &&
              nextPlayers[seat.id] &&
              !nextPlayers[seat.id].folded &&
              !nextPlayers[seat.id].allIn,
          ),
      )

      setPokerActionError('')
      return {
        ...room,
        playerChips: {
          ...room.playerChips,
          [pokerYouSeat.id]: playerState.chips - additionalAmount,
        },
        game: {
          ...room.game,
          pot: room.game.pot + additionalAmount,
          currentBet: raiseTarget,
          players: nextPlayers,
          activeSeatIndex: nextActiveSeatIndex,
          actionId: room.game.actionId + 1,
          lastActorId: pokerYouSeat.id,
          lastActionType: 'raise' as PokerActionType,
          lastContributions: additionalAmount > 0 ? [{ playerId: pokerYouSeat.id, amount: additionalAmount }] : [],
          lastAction: `${pokerYouSeat.name} raises to $${raiseTarget}.`,
          winnerMessage: null,
        },
      }
    })
  }

  const handleSelectRouletteBet = (nextBet: RouletteBet) => {
    if (rouletteIsSpinning) {
      return
    }

    if (!canPlaceBets || bankroll < MIN_BET) {
      setBetInputError('Your bankroll cannot cover another bet.')
      return
    }

    setRouletteBets((currentBets) => {
      const existingBet = currentBets.find((entry) => isSameRouletteBet(entry.bet, nextBet))

      if (existingBet) {
        return currentBets.filter((entry) => entry.id !== existingBet.id)
      }

      const nextTotal = currentBets.reduce((sum, entry) => sum + entry.amount, 0) + MIN_BET

      if (nextTotal > bankroll) {
        setBetInputError(`Total bets cannot be more than your bankroll of ${formatPoints(bankroll)}.`)
        return currentBets
      }

      return [
        ...currentBets,
        {
          id: `${nextBet.kind}-${nextBet.value}`,
          bet: nextBet,
          amount: MIN_BET,
          input: String(MIN_BET),
        },
      ]
    })
    setRouletteResult(null)
    setBetInputError('')
  }

  const handleSpinRoulette = () => {
    if (!canPlaceBets) {
      setBetInputError('You are out of points.')
      return
    }

    if (rouletteBets.length === 0) {
      setBetInputError('Pick at least one roulette bet first.')
      return
    }

    if (rouletteIsSpinning) {
      return
    }

    const invalidBet = rouletteBets.find((entry) => !Number.isFinite(entry.amount) || entry.amount < MIN_BET)

    if (invalidBet) {
      setBetInputError(`Each roulette bet must be at least $${MIN_BET}.`)
      return
    }

    if (rouletteTotalBet > bankroll) {
      setBetInputError(`Total bets cannot be more than your bankroll of ${formatPoints(bankroll)}.`)
      return
    }

    const winningNumber: RoulettePocket =
      ROULETTE_WHEEL_ORDER[Math.floor(Math.random() * ROULETTE_WHEEL_ORDER.length)]
    const numericWinningNumber = typeof winningNumber === 'number' ? winningNumber : null
    const isRed = numericWinningNumber !== null && ROULETTE_RED_NUMBERS.has(String(numericWinningNumber))
    const isOdd = numericWinningNumber !== null && numericWinningNumber % 2 === 1
    const result: RoundResult = (() => {
      let delta = 0
      let payout = 0
      const messages = rouletteBets.map((entry) => {
        const label = getRouletteBetDisplayLabel(entry.bet)

        if (entry.bet.kind === 'number') {
          const didWin = winningNumber === entry.bet.value
          delta += didWin ? entry.amount * 35 : -entry.amount
          payout += didWin ? entry.amount * 36 : 0
          return didWin
            ? `${label} hits for +$${entry.amount * 35}`
            : `${label} misses for -$${entry.amount}`
        }

        if (entry.bet.kind === 'color') {
          const didWin =
            numericWinningNumber !== null && entry.bet.value === (isRed ? 'red' : 'black')
          delta += didWin ? entry.amount : -entry.amount
          payout += didWin ? entry.amount * 2 : 0
          return didWin
            ? `${label} wins +$${entry.amount}`
            : `${label} loses -$${entry.amount}`
        }

        if (entry.bet.kind === 'parity') {
          const didWin =
            numericWinningNumber !== null && entry.bet.value === (isOdd ? 'odd' : 'even')
          delta += didWin ? entry.amount : -entry.amount
          payout += didWin ? entry.amount * 2 : 0
          return didWin
            ? `${label} wins +$${entry.amount}`
            : `${label} loses -$${entry.amount}`
        }

        if (entry.bet.kind === 'column') {
          const didWin =
            numericWinningNumber !== null &&
            ((entry.bet.value === 'column-1' && numericWinningNumber % 3 === 1) ||
              (entry.bet.value === 'column-2' && numericWinningNumber % 3 === 2) ||
              (entry.bet.value === 'column-3' && numericWinningNumber % 3 === 0))
          delta += didWin ? entry.amount * 2 : -entry.amount
          payout += didWin ? entry.amount * 3 : 0
          return didWin
            ? `${label} wins +$${entry.amount * 2}`
            : `${label} loses -$${entry.amount}`
        }

        const didWin =
          numericWinningNumber !== null &&
          ((entry.bet.value === '1-18' &&
            numericWinningNumber >= 1 &&
            numericWinningNumber <= 18) ||
            (entry.bet.value === '19-36' &&
              numericWinningNumber >= 19 &&
              numericWinningNumber <= 36) ||
            (entry.bet.value === '1-12' &&
              numericWinningNumber >= 1 &&
              numericWinningNumber <= 12) ||
            (entry.bet.value === '13-24' &&
              numericWinningNumber >= 13 &&
              numericWinningNumber <= 24) ||
            (entry.bet.value === '25-36' &&
              numericWinningNumber >= 25 &&
              numericWinningNumber <= 36))

        const payoutMultiplier =
          entry.bet.value === '1-12' ||
          entry.bet.value === '13-24' ||
          entry.bet.value === '25-36'
            ? 2
            : 1

        delta += didWin ? entry.amount * payoutMultiplier : -entry.amount
        payout += didWin ? entry.amount * (payoutMultiplier + 1) : 0
        return didWin
          ? `${label} wins +$${entry.amount * payoutMultiplier}`
          : `${label} loses -$${entry.amount}`
      })

      return {
        message: `Ball lands on ${winningNumber}. ${messages.join('. ')}.`,
        delta,
        payout,
      }
    })()

    const targetRotation = getRouletteBallAngleForPocket(winningNumber)
    setRouletteWinningNumber(null)
    setRouletteResult(null)
    setRouletteIsSpinning(true)
    setBankroll((currentBankroll) => currentBankroll - rouletteTotalBet)
    if (rouletteWheelRef.current && rouletteBallRef.current) {
      rouletteSpinPoseRef.current = runRouletteSpin(
        rouletteWheelRef.current,
        rouletteBallRef.current,
        rouletteSpinPoseRef.current,
        targetRotation,
        ROULETTE_SPIN_DURATION_MS,
      )
    }
    setBetInputError('')

    window.setTimeout(() => {
      setRouletteWinningNumber(winningNumber)
      setRouletteResult(result)
      setBankroll((currentBankroll) => currentBankroll + result.payout)
      applyPlayerDailyDelta(result.delta)
      applyCasinoDailyDelta(result.delta)
      applyCasinoGameDailyDelta('roulette', result.delta)
      setRouletteIsSpinning(false)
    }, ROULETTE_SPIN_DURATION_MS)
  }

  const rouletteTotalBet = rouletteBets.reduce((sum, entry) => sum + entry.amount, 0)

  const getHiLoValue = (card: Card | null) => {
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

  const hiLoOdds = getHiLoOdds(hiLoDeck, hiLoCurrentCard, getHiLoValue)
  const hiLoCashOutAmount = hiLoStreak > 0 ? Math.round(bet * hiLoMultiplier) : 0
  const hiLoHigherNextAmount =
    hiLoCurrentCard && hiLoOdds.higherStepMultiplier > 0
      ? Math.round(bet * hiLoMultiplier * hiLoOdds.higherStepMultiplier)
      : 0
  const hiLoLowerNextAmount =
    hiLoCurrentCard && hiLoOdds.lowerStepMultiplier > 0
      ? Math.round(bet * hiLoMultiplier * hiLoOdds.lowerStepMultiplier)
      : 0

  const handleStartHiLo = () => {
    if (hiLoResolveTimeoutRef.current) {
      window.clearTimeout(hiLoResolveTimeoutRef.current)
      hiLoResolveTimeoutRef.current = null
    }

    if (!canPlaceBets) {
      setBetInputError('You are out of points.')
      return
    }

    if (bet > bankroll) {
      setBetInputError(`Bet cannot be more than your bankroll of ${formatPoints(bankroll)}.`)
      return
    }

    const freshDeck = createShuffledDeck()
    const { drawnCard, remainingDeck } = drawRandomCard(freshDeck)
    const { drawnCard: nextUpcomingCard } = drawRandomCard(remainingDeck)
    setBankroll((currentBankroll) => currentBankroll - bet)
    setHiLoCurrentCard(drawnCard)
    setHiLoUpcomingCard(nextUpcomingCard)
    setHiLoNextCard(null)
    setHiLoDeck(remainingDeck)
    setHiLoGuess(null)
    setHiLoResult(null)
    setHiLoStreak(0)
    setHiLoMultiplier(1)
    setHiLoResolving(false)
    setHiLoSliding(false)
    setHiLoMessage('Guess whether the next card will be higher or lower.')
    setBetInputError('')
  }

  const handleGuessHiLo = (guess: 'higher' | 'lower') => {
    if (!hiLoCurrentCard || hiLoResult || hiLoResolving) {
      return
    }

    const stepMultiplier =
      guess === 'higher' ? hiLoOdds.higherStepMultiplier : hiLoOdds.lowerStepMultiplier

    if (stepMultiplier <= 0) {
      setHiLoMessage(`No cards are left that can go ${guess} from here.`)
      return
    }

    const nextCard = hiLoUpcomingCard ?? drawRandomCard(hiLoDeck).drawnCard
    const remainingDeck = removeCardFromDeck(hiLoDeck, nextCard)
    const currentValue = getHiLoValue(hiLoCurrentCard)
    const nextValue = getHiLoValue(nextCard)
    const isPush = currentValue === nextValue
    const didWin = guess === 'higher' ? nextValue > currentValue : nextValue < currentValue

    // Reveal: the next card mounts and slides in from the right (CSS keyframe on
    // .hilo-card--overlay), covering the back. Once it has settled we commit it
    // as the new current card. One timer, so the reveal always plays.
    setHiLoGuess(guess)
    setHiLoNextCard(nextCard)
    setHiLoResolving(true)
    setHiLoSliding(true)

    hiLoResolveTimeoutRef.current = window.setTimeout(() => {
      const nextUpcomingCard =
        remainingDeck.length > 0 ? drawRandomCard(remainingDeck).drawnCard : null

      setHiLoCurrentCard(nextCard)
      setHiLoUpcomingCard(nextUpcomingCard)
      setHiLoNextCard(null)
      setHiLoDeck(remainingDeck)
      setHiLoResolving(false)
      setHiLoSliding(false)

      if (isPush) {
        setHiLoMessage(`Push. Multiplier stays at x${hiLoMultiplier.toFixed(2)}. Keep going.`)
        hiLoResolveTimeoutRef.current = null
        return
      }

      if (didWin) {
        const nextStreak = hiLoStreak + 1
        const nextMultiplier = Number((hiLoMultiplier * stepMultiplier).toFixed(2))
        const nextCashOut = Math.round(bet * nextMultiplier)
        setHiLoStreak(nextStreak)
        setHiLoMultiplier(nextMultiplier)
        setHiLoMessage(
          `Correct. Multiplier is now x${nextMultiplier.toFixed(2)}. Cash out for $${nextCashOut} or keep going.`,
        )
        hiLoResolveTimeoutRef.current = null
        return
      }

      const result: RoundResult = {
        message: `${nextCard.rank}${nextCard.suit} is not ${guess}. You lose.`,
        delta: -bet,
        payout: 0,
      }

      setHiLoResult(result)
      setHiLoMessage(result.message)
      applyPlayerDailyDelta(result.delta)
      applyCasinoDailyDelta(result.delta)
      applyCasinoGameDailyDelta('hilo', result.delta)
      hiLoResolveTimeoutRef.current = null
    }, 880)
  }

  const handleCashOutHiLo = () => {
    if (!hiLoCurrentCard || hiLoResult || hiLoStreak === 0 || hiLoResolving) {
      return
    }

    const winnings = Math.round(bet * hiLoMultiplier)
    const result: RoundResult = {
      message: `Cashed out after ${hiLoStreak} correct guess${
        hiLoStreak === 1 ? '' : 'es'
      }.`,
      delta: winnings - bet,
      payout: winnings,
    }

    setHiLoNextCard(null)
    setHiLoUpcomingCard(null)
    setHiLoResult(result)
    setHiLoSliding(false)
    setHiLoMessage(`${result.message} You banked $${winnings}.`)
    setBankroll((currentBankroll) => currentBankroll + result.payout)
    applyPlayerDailyDelta(result.delta)
    applyCasinoDailyDelta(result.delta)
    applyCasinoGameDailyDelta('hilo', result.delta)
  }

  const handleStartMines = () => {
    if (!canPlaceBets) {
      setBetInputError('You are out of points.')
      return
    }

    if (bet > bankroll) {
      setBetInputError(`Bet cannot be more than your bankroll of ${formatPoints(bankroll)}.`)
      return
    }

    setBankroll((currentBankroll) => currentBankroll - bet)
    setMinesBoard(createMinesBoard(minesCount))
    setMinesSafePicks(0)
    setMinesResult(null)
    setMinesRoundActive(true)
    setMinesMessage(
      `Pick a tile. ${minesCount} mines are hidden in the 5x5 field, and each safe pick compounds your multiplier.`,
    )
    setBetInputError('')
  }

  const handleRevealMinesTile = (tileId: number) => {
    if (!minesRoundActive || minesResult) {
      return
    }

    const nextTile = minesBoard.find((tile) => tile.id === tileId)

    if (!nextTile || nextTile.revealed) {
      return
    }

    if (nextTile.isMine) {
      const nextBoard = minesBoard.map((tile) =>
        tile.id === tileId
          ? { ...tile, revealed: true, hit: true }
          : tile.isMine
            ? { ...tile, revealed: true }
            : tile,
      )
      const result: RoundResult = {
        message: 'Mine hit. The whole bet is gone.',
        delta: -bet,
        payout: 0,
      }

      setMinesBoard(nextBoard)
      setMinesResult(result)
      setMinesRoundActive(false)
      setMinesMessage('Mine hit. Start another round to try again.')
      applyPlayerDailyDelta(result.delta)
      applyCasinoDailyDelta(result.delta)
      applyCasinoGameDailyDelta('mines', result.delta)
      return
    }

    const nextSafePicks = minesSafePicks + 1
    const nextBoard = minesBoard.map((tile) =>
      tile.id === tileId
        ? { ...tile, revealed: true, multiplier: getMinesMultiplier(nextSafePicks, minesCount) }
        : tile,
    )
    const nextCashOutAmount = Math.round(bet * getMinesMultiplier(nextSafePicks, minesCount))

    setMinesBoard(nextBoard)
    setMinesSafePicks(nextSafePicks)

    if (nextSafePicks === minesSafeTiles) {
      const result: RoundResult = {
        message: 'Every safe tile is cleared. You swept the whole board.',
        delta: nextCashOutAmount - bet,
        payout: nextCashOutAmount,
      }

      setMinesResult(result)
      setMinesRoundActive(false)
      setMinesMessage(`Board cleared. You banked $${nextCashOutAmount}.`)
      setBankroll((currentBankroll) => currentBankroll + result.payout)
      applyPlayerDailyDelta(result.delta)
      applyCasinoDailyDelta(result.delta)
      applyCasinoGameDailyDelta('mines', result.delta)
      return
    }

    setMinesMessage(
      `Safe pick ${nextSafePicks}. Multiplier is x${getMinesMultiplier(
        nextSafePicks,
        minesCount,
      ).toFixed(2)} and the current collect value is ${formatPoints(nextCashOutAmount)}.`,
    )
  }

  const handleCashOutMines = () => {
    if (!minesRoundActive || minesSafePicks === 0) {
      return
    }

    const result: RoundResult = {
      message: `Cashed out after ${minesSafePicks} safe pick${minesSafePicks === 1 ? '' : 's'}.`,
      delta: minesCashOutAmount - bet,
      payout: minesCashOutAmount,
    }

    setMinesResult(result)
    setMinesRoundActive(false)
    setMinesMessage(`You banked $${minesCashOutAmount}. Start another round whenever you're ready.`)
    setBankroll((currentBankroll) => currentBankroll + result.payout)
    applyPlayerDailyDelta(result.delta)
    applyCasinoDailyDelta(result.delta)
    applyCasinoGameDailyDelta('mines', result.delta)
  }

  const advanceOrResolveRound = (
    nextHands: Card[][],
    nextHandBets: number[],
    nextCompletedHands: boolean[],
    nextDeck: Card[],
  ) => {
    const nextOpenHand = nextCompletedHands.findIndex((isCompleted) => !isCompleted)

    if (nextOpenHand !== -1) {
      setPlayerHands(nextHands)
      setHandBets(nextHandBets)
      setCompletedHands(nextCompletedHands)
      setActiveHandIndex(nextOpenHand)
      setDeck(nextDeck)
      return
    }

    const hasLiveHand = nextHands.some((hand) => getHandValue(hand) <= 21)
    const dealerResolution = hasLiveHand
      ? finishDealerHand(dealerHand, nextDeck)
      : { finalDealerHand: dealerHand, remainingDeck: nextDeck }
    const result = getRoundResult(nextHands, dealerResolution.finalDealerHand, nextHandBets)

    setPlayerHands(nextHands)
    setHandBets(nextHandBets)
    setCompletedHands(nextCompletedHands)
    setActiveHandIndex(Math.max(0, nextHands.length - 1))
    setDealerHand(dealerResolution.finalDealerHand)
    setDeck(dealerResolution.remainingDeck)
    setDealerRevealed(true)
    setRoundResult(result)
    setBankroll((currentBankroll) => currentBankroll + result.payout)
    applyPlayerDailyDelta(result.delta)
    applyCasinoDailyDelta(result.delta)
    applyCasinoGameDailyDelta('blackjack', result.delta)
  }

  const handleDeal = () => {
    if (!canPlaceBets) {
      setBetInputError('You are out of points.')
      return
    }

    if (bet > bankroll) {
      setBetInputError(`Bet cannot be more than your bankroll of ${formatPoints(bankroll)}.`)
      return
    }

    const { drawnCards, remainingDeck } = drawCards(deck, 4)
    const [playerFirstCard, dealerFirstCard, playerSecondCard, dealerSecondCard] = drawnCards

    setBankroll((currentBankroll) => currentBankroll - bet)
    setPlayerHands([[playerFirstCard, playerSecondCard]])
    setHandBets([bet])
    setCompletedHands([false])
    setActiveHandIndex(0)
    setDealerHand([dealerFirstCard, dealerSecondCard])
    setDeck(remainingDeck)
    setDealerRevealed(false)
    setRoundResult(null)
    setBetInput(String(bet))
    setBetInputError('')
  }

  const handleHit = () => {
    const { drawnCards, remainingDeck } = drawCards(deck, 1)
    const nextHands = playerHands.map((hand, index) =>
      index === activeHandIndex ? [...hand, drawnCards[0]] : hand,
    )
    const nextCompletedHands = [...completedHands]

    if (getHandValue(nextHands[activeHandIndex]) > 21) {
      nextCompletedHands[activeHandIndex] = true
      advanceOrResolveRound(nextHands, handBets, nextCompletedHands, remainingDeck)
      return
    }

    setPlayerHands(nextHands)
    setDeck(remainingDeck)
  }

  const handleStand = () => {
    const nextCompletedHands = [...completedHands]
    nextCompletedHands[activeHandIndex] = true
    advanceOrResolveRound(playerHands, handBets, nextCompletedHands, deck)
  }

  const handleDouble = () => {
    if (!canDouble) {
      return
    }

    setBankroll((currentBankroll) => currentBankroll - currentHandBet)
    const { drawnCards, remainingDeck } = drawCards(deck, 1)
    const nextHands = playerHands.map((hand, index) =>
      index === activeHandIndex ? [...hand, drawnCards[0]] : hand,
    )
    const nextHandBets = handBets.map((handBet, index) =>
      index === activeHandIndex ? handBet * 2 : handBet,
    )
    const nextCompletedHands = [...completedHands]
    nextCompletedHands[activeHandIndex] = true

    advanceOrResolveRound(nextHands, nextHandBets, nextCompletedHands, remainingDeck)
  }

  const handleSplit = () => {
    if (!canSplit) {
      return
    }

    setBankroll((currentBankroll) => currentBankroll - currentHandBet)
    const { drawnCards, remainingDeck } = drawCards(deck, 2)
    const splitHandLeft = [currentHand[0], drawnCards[0]]
    const splitHandRight = [currentHand[1], drawnCards[1]]
    const nextHands = [...playerHands]
    nextHands.splice(activeHandIndex, 1, splitHandLeft, splitHandRight)

    const nextHandBets = [...handBets]
    nextHandBets.splice(activeHandIndex, 1, currentHandBet, currentHandBet)

    const nextCompletedHands = [...completedHands]
    nextCompletedHands.splice(activeHandIndex, 1, false, false)

    setPlayerHands(nextHands)
    setHandBets(nextHandBets)
    setCompletedHands(nextCompletedHands)
    setActiveHandIndex(activeHandIndex)
    setDeck(remainingDeck)
  }

  const dealerVisibleHand =
    dealerRevealed || dealerHand.length < 2 ? dealerHand : [dealerHand[0]]
  const dealerTotal = getHandValue(dealerVisibleHand)

  return (
    <main className={devMode ? 'dev-mode' : undefined}>
      <div className="app-stage">
          {selectedGame !== 'lobby' ? (
          <section className="hero">
            <div className="hero__glow hero__glow--left" />
            <div className="hero__glow hero__glow--right" />
            <div className="hero__inner">
              <header className="hero__header">
                <div>
                  <p className="eyebrow">UES Underground Casino</p>
                </div>
              </header>
            </div>
            <div className="balance-pill">
              <div className="balance-pill__inner">
                <span className="balance-pill__label">Bankroll</span>
                <div className="balance-pill__value">
                  {devMode ? (
                    <button
                      type="button"
                      className="balance-pill__adjust"
                      onClick={() => {
                        handleAdjustDevBankroll(-100)
                      }}
                    >
                      -
                    </button>
                  ) : null}
                  <strong>
                    <AnimatedMoney value={bankroll} />
                    {devMode ? <span className="balance-pill__mode"> Dev Mode</span> : null}
                  </strong>
                  {devMode ? (
                    <button
                      type="button"
                      className="balance-pill__reset"
                      onClick={() => {
                        setBankroll(BANKROLL)
                      }}
                    >
                      Reset
                    </button>
                  ) : null}
                  {devMode ? (
                    <button
                      type="button"
                      className="balance-pill__adjust"
                      onClick={() => {
                        handleAdjustDevBankroll(100)
                      }}
                    >
                      +
                    </button>
                  ) : null}
                </div>
              </div>
            </div>
          </section>
          ) : null}

          <div className={`shell shell--${selectedGame}`}>
            {selectedGame === 'lobby' ? (
              <div className="home" aria-label="Casino floor">
                <header className="home__marquee">
                  <p className="home__kicker">✦&nbsp;&nbsp;Fake-money floor&nbsp;&nbsp;✦</p>
                  <h1 className="home__brand">UES Underground Casino</h1>
                  <p className="home__tag">Eleven tables, one bankroll — play the house with friends.</p>
                </header>

                <section className="home__cage" aria-label="Bankroll and rewards">
                  <article className="home__panel home__daily">
                    <p className="home__panel-label">Daily Bonus</p>
                    <div className="home__streak">
                      <span>Streak</span>
                      <strong>
                        {activeDailyRewardStreak} day{activeDailyRewardStreak === 1 ? '' : 's'}
                      </strong>
                    </div>
                    <div className="home__daytrack">
                      {dailyRewardDays.map((entry) => (
                        <span
                          key={entry.dayNumber}
                          className={`home__day${entry.current ? ' home__day--current' : ''}${
                            entry.claimed ? ' home__day--claimed' : ''
                          }`}
                          title={`Day ${entry.dayNumber} · ${formatPoints(entry.reward)}`}
                        >
                          {entry.dayNumber}
                        </span>
                      ))}
                    </div>
                    {canClaimDailyReward ? (
                      <button type="button" className="home__collect" onClick={handleClaimDailyReward}>
                        Collect {formatPoints(nextDailyRewardAmount)}
                      </button>
                    ) : (
                      <p className="home__panel-note">Collected — back tomorrow.</p>
                    )}
                  </article>

                  <article className="home__bankroll">
                    <p className="home__bankroll-label">Your Bankroll</p>
                    <div className="home__bankroll-value">
                      {devMode ? (
                        <button
                          type="button"
                          className="home__dev"
                          onClick={() => handleAdjustDevBankroll(-100)}
                          aria-label="Remove 100"
                        >
                          –
                        </button>
                      ) : null}
                      <strong>
                        <AnimatedMoney value={bankroll} />
                      </strong>
                      {devMode ? (
                        <button
                          type="button"
                          className="home__dev"
                          onClick={() => handleAdjustDevBankroll(100)}
                          aria-label="Add 100"
                        >
                          +
                        </button>
                      ) : null}
                    </div>
                    {devMode ? <p className="home__bankroll-sub">Dev mode active</p> : null}
                  </article>

                  <article className="home__panel home__rollers">
                    <p className="home__panel-label">High Rollers</p>
                    <ol className="home__standings">
                      {leaderboardPlayers.slice(0, 4).map((profile, index) => (
                        <li key={profile.id}>
                          <span className="home__rank">{index + 1}</span>
                          <span className="home__name">{profile.name || 'Unnamed'}</span>
                          <span className="home__chips">{formatPoints(profile.bankroll)}</span>
                        </li>
                      ))}
                      <li className="home__you">
                        <span className="home__rank">You</span>
                        <span className="home__name">{playerProfile.name || 'Unnamed'}</span>
                        <span className="home__chips">{formatPoints(bankroll)}</span>
                      </li>
                    </ol>
                  </article>
                </section>

                <section className="home__floor" aria-label="Games">
                  <div className="home__floor-head">
                    <h2>Choose your table</h2>
                    <span className="home__floor-rule" />
                    <span className="home__floor-count">
                      {devMode ? '11 games + tools' : '11 games'}
                    </span>
                  </div>
                  <div className="home__grid">
                    {[
                      { cls: 'blackjack', wing: 'parlor', tag: 'Beat the dealer', name: 'Blackjack', onClick: handleOpenBlackjack },
                      { cls: 'roulette', wing: 'parlor', tag: 'Red or black', name: 'Roulette', onClick: handleOpenRoulette },
                      { cls: 'hilo', wing: 'parlor', tag: 'Higher or lower', name: 'Hi-Lo', onClick: handleOpenHiLo },
                      { cls: 'poker', wing: 'parlor', tag: 'Live table', name: 'Poker', onClick: handleOpenPoker },
                      { cls: 'dice', wing: 'parlor', tag: 'Roll the bones', name: 'Dice', onClick: handleOpenDice },
                      { cls: 'mines', wing: 'neon', tag: 'Dodge the mines', name: 'Mines', onClick: handleOpenMines },
                      { cls: 'slots', wing: 'neon', tag: 'Triple jackpot', name: 'Slots', onClick: handleOpenSlots },
                      { cls: 'plinko', wing: 'neon', tag: 'Neon arcade', name: 'Plinko', onClick: handleOpenPlinko },
                      { cls: 'chicken', wing: 'neon', tag: 'Beat the traffic', name: 'Chicken Cross', onClick: handleOpenChicken },
                      { cls: 'jetstream', wing: 'neon', tag: 'Cash out before it flies', name: 'Jetstream', onClick: handleOpenJetstream },
                      { cls: 'options', wing: 'muted', tag: 'Profile & stats', name: 'Options', onClick: handleOpenOptions },
                      ...(devMode
                        ? [{ cls: 'settings', wing: 'muted', tag: 'Developer tools', name: 'Dev Options', onClick: handleOpenSettings }]
                        : []),
                    ].map((game) => (
                      <button
                        key={game.cls}
                        type="button"
                        className={`home-tile home-tile--${game.cls} home-tile--${game.wing}`}
                        onClick={game.onClick}
                      >
                        <span className="home-tile__tag">{game.tag}</span>
                        <strong className="home-tile__name">{game.name}</strong>
                        <span className="home-tile__go" aria-hidden="true">Play →</span>
                      </button>
                    ))}
                  </div>
                </section>
              </div>
            ) : (
            <section
              className={`games-panel games-panel--${selectedGame}`}
              aria-label="Games"
            >
          <div className="games-panel__header">
            <div>
              <p className="eyebrow">Games</p>
              <h2>
                {selectedGame === 'blackjack'
                  ? 'Blackjack'
                  : selectedGame === 'options'
                    ? 'Options'
                  : selectedGame === 'roulette'
                    ? 'Roulette'
                    : selectedGame === 'poker'
                      ? 'Poker'
                    : selectedGame === 'mines'
                      ? 'Mines'
                    : selectedGame === 'hilo'
                      ? 'Hi-Lo'
                    : selectedGame === 'dice'
                        ? 'Dice'
                      : selectedGame === 'slots'
                        ? 'Slots'
                      : selectedGame === 'plinko'
                        ? 'Plinko'
                      : selectedGame === 'chicken'
                        ? 'Chicken Cross'
                      : selectedGame === 'jetstream'
                        ? 'Jetstream'
                      : selectedGame === 'settings'
                        ? 'Dev Options'
                        : selectedGame === 'settings-players'
                          ? 'Players'
                          : selectedGame === 'settings-player-detail'
                            ? 'Player Details'
                          : selectedGame === 'settings-statistics'
                            ? 'Statistics'
                            : selectedGame === 'settings-statistics-game'
                              ? `${getCasinoTrackedGameLabel(selectedCasinoStatsGame)} Statistics`
                    : 'Choose your game'}
              </h2>
            </div>
            <button
              type="button"
              className="status-badge status-badge--button"
              onClick={handleBackToGames}
            >
              Back to games
            </button>
          </div>

          {selectedGame === 'options' ? (
            <div className="settings-room">
              <div className="roulette-stage settings-stage">
                <div className="roulette-stage__header">
                  <div>
                    <p className="bet-panel__label">Player Options</p>
                    <p className="roulette-stage__status">
                      Settings for the current player profile on this device.
                    </p>
                  </div>
                </div>

                <div className="options-tabs">
                  <button
                    type="button"
                    className={`settings-link options-tabs__button${
                      optionsTab === 'settings' ? ' options-tabs__button--active' : ''
                    }`}
                    onClick={() => {
                      setOptionsTab('settings')
                    }}
                  >
                    Settings
                  </button>
                  <button
                    type="button"
                    className={`settings-link options-tabs__button${
                      optionsTab === 'statistics' ? ' options-tabs__button--active' : ''
                    }`}
                    onClick={() => {
                      setOptionsTab('statistics')
                    }}
                  >
                    Statistics
                  </button>
                </div>

                <div className="settings-grid">
                  {optionsTab === 'settings' ? (
                    <div className="roulette-panel__card">
                      <p className="bet-panel__label">Profile</p>
                      <h3>{playerProfile.name || 'Unnamed player'}</h3>
                      <div className="bet-entry roulette-panel__bet-entry">
                        <div className="bet-entry__form">
                        <input
                          type="text"
                          value={optionsNameInput}
                          onChange={(event) => {
                            setOptionsNameInput(event.target.value)
                            setBetInputError('')
                          }}
                          placeholder="Enter your player name"
                          disabled={playerProfile.nameLocked}
                        />
                        <button
                          type="button"
                          className="bet-entry__apply"
                          onClick={handleSavePlayerOptions}
                          disabled={playerProfile.nameLocked}
                        >
                          {playerProfile.nameLocked ? 'Name Locked' : 'Save Name'}
                        </button>
                      </div>
                    </div>
                      {betInputError ? <p className="bet-panel__error">{betInputError}</p> : null}
                      <div className="roulette-summary">
                        <div className="roulette-summary__row">
                          <span>Player name</span>
                          <strong>{playerProfile.name || 'Not set'}</strong>
                        </div>
                        <div className="roulette-summary__row">
                          <span>Name status</span>
                          <strong>{playerProfile.nameLocked ? 'Locked' : 'Editable'}</strong>
                        </div>
                        <div className="roulette-summary__row">
                          <span>Player ID</span>
                          <strong>{playerProfile.id}</strong>
                        </div>
                        <div className="roulette-summary__row">
                          <span>Bankroll</span>
                          <strong>{formatPoints(bankroll)}</strong>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="casino-stats-card">
                      <div className="casino-stats-total">
                        <span className="casino-stats-total__label">Lifetime Progress</span>
                        <strong
                          className={
                            lifetimePlayerProfit > 0
                              ? 'casino-stats-total__value casino-stats-total__value--positive'
                              : lifetimePlayerProfit < 0
                                ? 'casino-stats-total__value casino-stats-total__value--negative'
                                : 'casino-stats-total__value casino-stats-total__value--zero'
                          }
                        >
                          {lifetimePlayerProfit > 0
                            ? formatSignedPoints(lifetimePlayerProfit)
                            : lifetimePlayerProfit < 0
                              ? formatSignedPoints(lifetimePlayerProfit)
                              : '$0'}
                        </strong>
                      </div>
                      <p className="roulette-stage__status options-stats__note">
                        Last 7 days of score change history.
                      </p>
                      <CasinoStatisticsChart stats={filteredPlayerDailyStats} />
                    </div>
                  )}
                </div>
              </div>
            </div>
          ) : selectedGame === 'settings' ? (
            <div className="settings-room">
              <div className="roulette-stage settings-stage">
                <div className="roulette-stage__header">
                  <div>
                    <p className="bet-panel__label">Dev Options</p>
                    <p className="roulette-stage__status">
                      This menu is only visible while dev mode is active.
                    </p>
                  </div>
                </div>

                <button
                  type="button"
                  className="settings-link"
                  onClick={handleOpenSettingsPlayers}
                >
                  Players
                </button>
                <button
                  type="button"
                  className="settings-link"
                  onClick={handleOpenSettingsStatistics}
                >
                  Statistics
                </button>
              </div>
            </div>
          ) : selectedGame === 'settings-players' ? (
            <div className="settings-room">
              <div className="roulette-stage settings-stage">
                <div className="roulette-stage__header">
                  <div>
                    <p className="bet-panel__label">Players</p>
                    <p className="roulette-stage__status">
                      This page is ready for player tools and profile controls.
                    </p>
                  </div>
                </div>

                <div className="settings-grid">
                  <div className="settings-players">
                    <div className="bet-entry settings-players__search">
                      <div className="bet-entry__form">
                        <input
                          type="text"
                          value={settingsPlayerSearch}
                          onChange={(event) => {
                            setSettingsPlayerSearch(event.target.value)
                          }}
                          placeholder="Search players"
                        />
                      </div>
                    </div>

                    <div className="settings-player-list">
                      {filteredSettingsPlayers.length > 0 ? (
                        filteredSettingsPlayers.map((profile) => (
                          <button
                            type="button"
                            className="settings-player-row"
                            key={profile.id}
                            onClick={() => {
                              handleOpenSettingsPlayerDetail(profile)
                            }}
                          >
                            <strong>{profile.name || 'Unnamed player'}</strong>
                            <span>{formatPoints(profile.bankroll)}</span>
                            <span>{new Date(profile.updatedAt).toLocaleDateString()}</span>
                          </button>
                        ))
                      ) : (
                        <div className="settings-player-empty">No players match that search.</div>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          ) : selectedGame === 'settings-player-detail' ? (
            <div className="settings-room">
              <div className="roulette-stage settings-stage">
                <div className="roulette-stage__header">
                  <div>
                    <p className="bet-panel__label">Player Details</p>
                    <p className="roulette-stage__status">
                      Manage this player profile directly from dev options.
                    </p>
                  </div>
                  <button
                    type="button"
                    className="status-badge status-badge--button"
                    onClick={() => {
                      setSelectedGame('settings-players')
                      setSettingsPlayerDetailError('')
                    }}
                  >
                    Back to player list
                  </button>
                </div>

                {selectedSettingsPlayer ? (
                  <div className="settings-grid">
                    <div className="casino-stats-card">
                      <div className="roulette-summary">
                        <div className="roulette-summary__row">
                          <span>Player name</span>
                          <strong>{selectedSettingsPlayer.name || 'Unnamed player'}</strong>
                        </div>
                        <div className="roulette-summary__row">
                          <span>Player ID</span>
                          <strong>{selectedSettingsPlayer.id}</strong>
                        </div>
                        <div className="roulette-summary__row">
                          <span>Bankroll</span>
                          <strong>{formatPoints(selectedSettingsPlayer.bankroll)}</strong>
                        </div>
                      </div>
                    </div>

                    <div className="casino-stats-card">
                      <p className="bet-panel__label">Name</p>
                      <div className="bet-entry">
                        <div className="bet-entry__form">
                          <input
                            type="text"
                            value={settingsPlayerDetailName}
                            onChange={(event) => {
                              setSettingsPlayerDetailName(event.target.value)
                              setSettingsPlayerDetailError('')
                            }}
                            placeholder="Enter player name"
                          />
                        </div>
                      </div>

                      <div className="roulette-summary__row settings-player-detail__lock-row">
                        <span>Lock player name</span>
                        <label className="options-toggle">
                          <input
                            type="checkbox"
                            checked={settingsPlayerDetailNameLocked}
                            onChange={(event) => {
                              setSettingsPlayerDetailNameLocked(event.target.checked)
                            }}
                          />
                          <span className="options-toggle__slider" />
                        </label>
                      </div>

                      <p className="bet-panel__label settings-player-detail__label">Bankroll</p>
                      <div className="bet-entry">
                        <div className="bet-entry__form">
                          <input
                            type="number"
                            min="0"
                            step="1"
                            value={settingsPlayerDetailBankroll}
                            onChange={(event) => {
                              setSettingsPlayerDetailBankroll(event.target.value)
                              setSettingsPlayerDetailError('')
                            }}
                            placeholder="Set bankroll"
                          />
                        </div>
                      </div>

                      <div className="settings-player-detail__bankroll-actions">
                        <button
                          type="button"
                          className="action-button"
                          onClick={() => {
                            handleAdjustSettingsPlayerBankroll(-100)
                          }}
                        >
                          -$100
                        </button>
                        <button
                          type="button"
                          className="action-button"
                          onClick={() => {
                            handleAdjustSettingsPlayerBankroll(100)
                          }}
                        >
                          +$100
                        </button>
                      </div>

                      <button
                        type="button"
                        className="action-button action-button--primary settings-player-detail__save"
                        onClick={handleSaveSettingsPlayerDetail}
                      >
                        Save Player
                      </button>

                      <button
                        type="button"
                        className="settings-player-detail__delete"
                        onClick={() => {
                          void handleDeleteSettingsPlayer()
                        }}
                      >
                        Delete Account
                      </button>

                      {settingsPlayerDetailError ? (
                        <p className="bet-panel__error">{settingsPlayerDetailError}</p>
                      ) : null}
                    </div>
                  </div>
                ) : (
                  <div className="settings-player-empty">That player could not be found.</div>
                )}
              </div>
            </div>
          ) : selectedGame === 'settings-statistics' ? (
            <div className="settings-room">
              <div className="roulette-stage settings-stage">
                <div className="roulette-stage__header">
                  <div>
                    <p className="bet-panel__label">Statistics</p>
                    <p className="roulette-stage__status">
                      Casino daily profit and loss, centered around zero.
                    </p>
                  </div>
                </div>

                <div className="settings-grid">
                  <div className="casino-stats-card">
                    <div className="casino-stats-total">
                      <span className="casino-stats-total__label">Lifetime House Profit</span>
                      <strong
                        className={
                          lifetimeCasinoProfit > 0
                            ? 'casino-stats-total__value casino-stats-total__value--positive'
                            : lifetimeCasinoProfit < 0
                              ? 'casino-stats-total__value casino-stats-total__value--negative'
                              : 'casino-stats-total__value casino-stats-total__value--zero'
                        }
                      >
                        {lifetimeCasinoProfit > 0
                          ? `+$${Math.abs(lifetimeCasinoProfit).toLocaleString()}`
                          : lifetimeCasinoProfit < 0
                            ? `-$${Math.abs(lifetimeCasinoProfit).toLocaleString()}`
                            : '$0'}
                      </strong>
                    </div>
                    <div className="casino-stats-toolbar">
                      <button
                        type="button"
                        className="casino-stats-toolbar__reset"
                        onClick={handleOpenCasinoStatsReset}
                      >
                        Reset Statistics
                      </button>
                      <div className="casino-stats-toolbar__range">
                        <label className="casino-stats-toolbar__label" htmlFor="casino-stats-range">
                          Time range
                        </label>
                        <select
                          id="casino-stats-range"
                          className="casino-stats-toolbar__select"
                          value={casinoStatsRange}
                          onChange={(event) => {
                            setCasinoStatsRange(event.target.value as CasinoStatsRange)
                          }}
                        >
                          <option value="7d">1 Week</option>
                          <option value="14d">2 Weeks</option>
                          <option value="1m">1 Month</option>
                          <option value="3m">3 Months</option>
                          <option value="6m">6 Months</option>
                          <option value="1y">1 Year</option>
                        </select>
                      </div>
                    </div>
                    <CasinoStatisticsChart stats={filteredCasinoDailyStats} />
                    <div className="casino-game-grid">
                      {TRACKED_CASINO_GAMES.map((game) => (
                        <button
                          key={game}
                          type="button"
                          className="settings-link casino-game-link"
                          onClick={() => {
                            handleOpenGameStatistics(game)
                          }}
                        >
                          {getCasinoTrackedGameLabel(game)}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          ) : selectedGame === 'settings-statistics-game' ? (
            <div className="settings-room">
              <div className="roulette-stage settings-stage">
                <div className="roulette-stage__header">
                  <div>
                    <p className="bet-panel__label">{getCasinoTrackedGameLabel(selectedCasinoStatsGame)}</p>
                    <p className="roulette-stage__status">
                      Individual daily house profit and loss for {getCasinoTrackedGameLabel(selectedCasinoStatsGame)}.
                    </p>
                  </div>
                </div>

                <div className="settings-grid">
                  <div className="casino-stats-card">
                    <div className="casino-stats-total">
                      <span className="casino-stats-total__label">
                        Lifetime {getCasinoTrackedGameLabel(selectedCasinoStatsGame)} Profit
                      </span>
                      <strong
                        className={
                          lifetimeSelectedCasinoGameProfit > 0
                            ? 'casino-stats-total__value casino-stats-total__value--positive'
                            : lifetimeSelectedCasinoGameProfit < 0
                              ? 'casino-stats-total__value casino-stats-total__value--negative'
                              : 'casino-stats-total__value casino-stats-total__value--zero'
                        }
                      >
                        {lifetimeSelectedCasinoGameProfit > 0
                          ? `+$${Math.abs(lifetimeSelectedCasinoGameProfit).toLocaleString()}`
                          : lifetimeSelectedCasinoGameProfit < 0
                            ? `-$${Math.abs(lifetimeSelectedCasinoGameProfit).toLocaleString()}`
                            : '$0'}
                      </strong>
                    </div>
                    <div className="casino-stats-toolbar">
                      <button
                        type="button"
                        className="casino-stats-toolbar__reset"
                        onClick={handleOpenCasinoStatsReset}
                      >
                        Reset Statistics
                      </button>
                      <div className="casino-stats-toolbar__range">
                        <label className="casino-stats-toolbar__label" htmlFor="casino-stats-game-range">
                          Time range
                        </label>
                        <select
                          id="casino-stats-game-range"
                          className="casino-stats-toolbar__select"
                          value={casinoStatsRange}
                          onChange={(event) => {
                            setCasinoStatsRange(event.target.value as CasinoStatsRange)
                          }}
                        >
                          <option value="7d">1 Week</option>
                          <option value="14d">2 Weeks</option>
                          <option value="1m">1 Month</option>
                          <option value="3m">3 Months</option>
                          <option value="6m">6 Months</option>
                          <option value="1y">1 Year</option>
                        </select>
                      </div>
                    </div>
                    <CasinoStatisticsChart stats={filteredSelectedCasinoGameStats} />
                    <div className="casino-game-grid">
                      <button
                        type="button"
                        className="settings-link casino-game-link"
                        onClick={handleOpenSettingsStatistics}
                      >
                        All
                      </button>
                      {TRACKED_CASINO_GAMES.filter((game) => game !== selectedCasinoStatsGame).map((game) => (
                        <button
                          key={game}
                          type="button"
                          className="settings-link casino-game-link"
                          onClick={() => {
                            handleOpenGameStatistics(game)
                          }}
                        >
                          {getCasinoTrackedGameLabel(game)}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          ) : selectedGame === 'dice' ? (
            <div className="dice-room">
              <div className="roulette-stage dice-stage">
                <div className="roulette-stage__header">
                  <div>
                    <p className="bet-panel__label">20 Dice</p>
                    <p className="roulette-stage__status">{diceMessage}</p>
                  </div>
                </div>

                <div className="dice-board">
                  <div className="dice-board__row">
                    {diceTopRow.map((value, index) =>
                      renderAnimatedDiceFace(value, `top-${index}`, diceRolling, diceRollFrame),
                    )}
                  </div>

                  <div className="dice-controls">
                    <button
                      type="button"
                      className={`dice-controls__mode${
                        diceMode === 'lower' ? ' dice-controls__mode--active' : ''
                      }`}
                      onClick={() => {
                        setDiceMode('lower')
                        setDiceResult(null)
                      }}
                      disabled={diceRolling}
                      aria-label="Roll under the target"
                      aria-pressed={diceMode === 'lower'}
                    >
                      <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 16L3 7h14z" fill="currentColor" /></svg>
                      <span>Under</span>
                    </button>

                    <div className="dice-controls__target">
                      <span className="bet-panel__label">Target</span>
                      <strong>{diceTarget}</strong>
                      <input
                        type="range"
                        min={DICE_MIN_TOTAL}
                        max={DICE_MAX_TOTAL}
                        step={1}
                        value={diceTarget}
                        onChange={(event) => {
                          setDiceTarget(clampDiceTarget(Number(event.target.value)))
                          setDiceResult(null)
                        }}
                        disabled={diceRolling}
                      />
                      <div className="dice-controls__range">
                        <span>{DICE_MIN_TOTAL}</span>
                        <span>{DICE_MAX_TOTAL}</span>
                      </div>
                    </div>

                    <button
                      type="button"
                      className={`dice-controls__mode${
                        diceMode === 'higher' ? ' dice-controls__mode--active' : ''
                      }`}
                      onClick={() => {
                        setDiceMode('higher')
                        setDiceResult(null)
                      }}
                      disabled={diceRolling}
                      aria-label="Roll over the target"
                      aria-pressed={diceMode === 'higher'}
                    >
                      <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 4l7 9H3z" fill="currentColor" /></svg>
                      <span>Over</span>
                    </button>
                  </div>

                  <div className="dice-board__row">
                    {diceBottomRow.map((value, index) =>
                      renderAnimatedDiceFace(value, `bottom-${index}`, diceRolling, diceRollFrame),
                    )}
                  </div>
                </div>

                <div
                  className={`round-result round-result--roulette dice-result${
                    diceResult ? (diceResult.delta > 0 ? ' round-result--win' : ' round-result--loss') : ''
                  }`}
                  key={diceResult ? 'settled' : 'pending'}
                >
                  <strong>{diceRolling ? 'Rolling…' : diceTotal !== null ? `Total ${diceTotal}` : 'Roll to reveal the total.'}</strong>
                  <span>
                    {diceResult
                      ? `Net ${formatSignedPoints(diceResult.delta)}`
                      : `${Math.min(99.9, Math.round(diceWinChance * 1000) / 10)}% to score at x${diceMultiplier.toFixed(2)}`}
                  </span>
                </div>
              </div>

              <div className="roulette-panel">
                <div className="roulette-panel__card">
                  <p className="bet-panel__label">Dice</p>
                  <h3>{diceRolling ? 'Rolling all 20 dice' : 'Set the line and roll'}</h3>
                  <div className="bet-entry roulette-panel__bet-entry">
                    <div className="bet-entry__form">
                      <input
                        type="number"
                        min={MIN_BET}
                        value={betInput}
                        onChange={(event) => {
                          setBetInput(event.target.value)
                          setBetInputError('')
                        }}
                        disabled={diceRolling}
                      />
                      <button
                        type="button"
                        className="bet-entry__apply"
                        onClick={applyTypedBet}
                        disabled={diceRolling || !canPlaceBets}
                      >
                        Set bet
                      </button>
                    </div>
                  </div>
                  {betInputError ? <p className="bet-panel__error">{betInputError}</p> : null}
                  <div className="roulette-summary">
                    <div className="roulette-summary__row">
                      <span>Current bet</span>
                      <strong>{formatPoints(bet)}</strong>
                    </div>
                    <div className="roulette-summary__row">
                      <span>Direction</span>
                      <strong>{diceMode === 'lower' ? `< ${diceTarget}` : `> ${diceTarget}`}</strong>
                    </div>
                    <div className="roulette-summary__row">
                      <span>Win chance</span>
                      <strong>{diceWinChanceLabel}</strong>
                    </div>
                    <div className="roulette-summary__row">
                      <span>Multiplier</span>
                      <strong>x{diceMultiplier.toFixed(2)}</strong>
                    </div>
                    <div className="roulette-summary__row">
                      <span>Total return</span>
                      <strong>{formatPoints(dicePayout)}</strong>
                    </div>
                  </div>
                  <button
                    type="button"
                    className="action-button action-button--primary roulette-stage__spin dice-roll-button"
                    onClick={handleRollDice}
                    disabled={diceRolling || !canPlaceBets || bet > bankroll}
                  >
                    {diceRolling ? 'Rolling...' : 'Roll 20 Dice'}
                  </button>
                </div>
              </div>
            </div>
          ) : selectedGame === 'slots' ? (
            <div className="slots-room">
              <div className="slots-stage">
                <div className="roulette-stage__header">
                  <div>
                    <p className="bet-panel__label">Lucky Reels</p>
                    <p className="roulette-stage__status">
                      {slotsMessage}
                    </p>
                  </div>
                </div>

                <div className="slots-jackpots">
                  <article className="slots-jackpot slots-jackpot--mini">
                    <span>Mini</span>
                    <strong>${slotsJackpots.mini.toLocaleString()}</strong>
                  </article>
                  <article className="slots-jackpot slots-jackpot--minor">
                    <span>Minor</span>
                    <strong>${slotsJackpots.minor.toLocaleString()}</strong>
                  </article>
                  <article className="slots-jackpot slots-jackpot--major">
                    <span>Major</span>
                    <strong>${slotsJackpots.major.toLocaleString()}</strong>
                  </article>
                  <article className="slots-jackpot slots-jackpot--grand">
                    <span>Grand</span>
                    <strong>${slotsJackpots.grand.toLocaleString()}</strong>
                  </article>
                </div>

                <div className="slots-machine-wrap">
                <div className="slots-machine">
                  <div className="slots-machine__top">
                    {slotsBonusActive ? 'Jackpot Bonus' : 'UES Underground Casino Slots'}
                  </div>
                  <div className="slots-machine__window">
                    {slotsColumns.map((column, columnIndex) => {
                      const columnStopped = slotsStoppedColumns[columnIndex]
                      const columnSpinning = slotsSpinning && !columnStopped

                      if (slotsBonusActive) {
                        return (
                          <div className="slots-machine__column" key={columnIndex}>
                            <div className="slots-machine__column-face">
                              {column.final.map((cell, rowIndex) => {
                                const heldCell = column.previous[rowIndex]
                                const isRespinning = columnSpinning && !heldCell
                                const showCell = columnSpinning ? heldCell : cell
                                const justLanded =
                                  slotsSpinning && columnStopped && !heldCell && Boolean(cell)

                                return (
                                  <div
                                    className={`${getSlotsCellClassName(showCell ?? null)}${
                                      isRespinning ? ' slots-machine__reel--respin' : ''
                                    }${justLanded ? ' slots-machine__reel--landed' : ''}`}
                                    key={`bonus-${columnIndex}-${rowIndex}`}
                                  >
                                    {isRespinning ? (
                                      <span className="slots-machine__respin-glow" aria-hidden="true" />
                                    ) : (
                                      renderSlotsCellContent(showCell ?? null)
                                    )}
                                  </div>
                                )
                              })}
                            </div>
                          </div>
                        )
                      }

                      return (
                        <div className="slots-machine__column" key={columnIndex}>
                          {columnSpinning ? (
                            <div className="slots-reel" key={`loop-${slotsSpinTarget?.token}-${columnIndex}`}>
                              <div
                                className="slots-reel__strip slots-reel__strip--loop"
                                style={{ animationDelay: `${columnIndex * -73}ms` }}
                              >
                                {[...column.filler, ...column.filler].map((cell, cellIndex) => (
                                  <div
                                    className="slots-machine__reel slots-machine__reel--blur"
                                    key={`loop-${columnIndex}-${cellIndex}`}
                                  >
                                    {renderSlotsCellContent(cell)}
                                  </div>
                                ))}
                              </div>
                            </div>
                          ) : slotsSpinning ? (
                            <div className="slots-reel" key={`settle-${slotsSpinTarget?.token}-${columnIndex}`}>
                              <div className="slots-reel__strip slots-reel__strip--settle">
                                {[...column.final, ...column.filler.slice(0, 3)].map((cell, cellIndex) => (
                                  <div
                                    className={getSlotsCellClassName(cell ?? null)}
                                    key={`settle-${columnIndex}-${cellIndex}`}
                                  >
                                    {renderSlotsCellContent(cell ?? null)}
                                  </div>
                                ))}
                              </div>
                            </div>
                          ) : (
                            <div className="slots-machine__column-face">
                              {column.final.map((cell, rowIndex) => (
                                <div
                                  className={getSlotsCellClassName(cell ?? null, rowIndex, columnIndex)}
                                  key={`rest-${columnIndex}-${rowIndex}`}
                                >
                                  {renderSlotsCellContent(cell ?? null)}
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                  {slotsBonusActive ? (
                    <div className="slots-machine__bonus-banner">
                      <strong>{slotsBonusRespins} Free Bonus Respins</strong>
                      <span>No extra bet is needed while the bonus is active.</span>
                    </div>
                  ) : null}
                  <div className="slots-machine__footer">
                    <span>Ways 5</span>
                    <strong>{slotsBonusActive ? 'Free Bonus Active' : slotsSpinning ? 'Spinning' : 'Ready to Spin'}</strong>
                  </div>
                </div>
                  <button
                    type="button"
                    className={`slots-machine__lever${slotsSpinning ? ' slots-machine__lever--active' : ''}`}
                    onClick={handleSpinSlots}
                    disabled={slotsSpinning || (!slotsBonusActive && (!canPlaceBets || bet > bankroll))}
                    aria-label={
                      slotsBonusActive
                        ? slotsSpinning
                          ? 'Respinning bonus'
                          : 'Respin bonus'
                        : slotsSpinning
                          ? 'Spinning reels'
                          : 'Spin reels'
                    }
                  >
                    <span className="slots-machine__lever-stem" />
                    <span className="slots-machine__lever-knob" />
                    <span className="slots-machine__lever-base" />
                  </button>
                </div>
              </div>

              <div className="roulette-panel">
                <div className="roulette-panel__card">
                  <p className="bet-panel__label">Lucky Reels</p>
                  <h3>{slotsBonusActive ? 'Bonus in play' : 'Machine ready'}</h3>
                  <div className="bet-entry roulette-panel__bet-entry">
                    <div className="bet-entry__form">
                      <input
                        type="number"
                        min={MIN_BET}
                        value={betInput}
                        onChange={(event) => {
                          setBetInput(event.target.value)
                          setBetInputError('')
                        }}
                      />
                      <button
                        type="button"
                        className="bet-entry__apply"
                        onClick={applyTypedBet}
                        disabled={!canPlaceBets}
                      >
                        Set bet
                      </button>
                    </div>
                  </div>
                  {betInputError ? <p className="bet-panel__error">{betInputError}</p> : null}
                  <div className="roulette-summary">
                    <div className="roulette-summary__row">
                      <span>Current bet</span>
                      <strong>{formatPoints(bet)}</strong>
                    </div>
                    <div className="roulette-summary__row">
                      <span>Bonus trigger</span>
                      <strong>6 Orbs</strong>
                    </div>
                    <div className="roulette-summary__row">
                      <span>Status</span>
                      <strong>
                        {slotsBonusActive
                          ? `${slotsBonusRespins} free respins`
                          : slotsSpinning
                            ? 'Spinning'
                            : 'Base Game'}
                      </strong>
                    </div>
                    {slotsResult ? (
                      <div className="roulette-summary__row">
                        <span>Last result</span>
                        <strong>
                          {slotsResult.delta > 0
                            ? formatSignedPoints(slotsResult.delta)
                            : slotsResult.delta < 0
                              ? formatSignedPoints(slotsResult.delta)
                              : '$0'}
                        </strong>
                      </div>
                    ) : null}
                  </div>
                  <button
                    type="button"
                    className="action-button action-button--primary slots-spin-button"
                    onClick={handleSpinSlots}
                    disabled={slotsSpinning || (!slotsBonusActive && (!canPlaceBets || bet > bankroll))}
                  >
                    {slotsSpinning ? 'Spinning…' : slotsBonusActive ? 'Respin' : 'Spin'}
                  </button>
                </div>
              </div>
            </div>
          ) : selectedGame === 'jetstream' ? (
            createPortal(
              <div className="jet-fs" style={{ top: `${fullscreenTopOffset}px` }}>
                <div className="jet-fs__scene">
                  <JetstreamBoard
                    status={jetstreamStatus}
                    flight={jetstreamFlight}
                    bet={jetstreamStatus === 'idle' ? bet : jetstreamBet}
                    onFinish={handleJetstreamFinish}
                  />

                  <p className="jet-fs__status" role="status">{jetstreamMessage}</p>

                  {jetstreamHistory.length > 0 ? (
                    <div className="jet-fs__recent" aria-label="Recent flights">
                      {jetstreamHistory.map((round) => (
                        <span
                          key={round.id}
                          className={`jet-chip${round.cashed ? ' is-win' : ' is-loss'}`}
                        >
                          {round.cashed ? formatJetMultiplier(round.multiplier) : 'Splash'}
                        </span>
                      ))}
                    </div>
                  ) : null}

                  <button type="button" className="jet-fs__back" onClick={handleBackToGames}>
                    ← Lobby
                  </button>
                </div>

                <div className="jet-fs__bar">
                  <div className="jet-fs__field">
                    <label htmlFor="jet-bet">Bet</label>
                    <div className="bet-entry__form">
                      <input
                        id="jet-bet"
                        type="number"
                        min={MIN_BET}
                        value={betInput}
                        disabled={jetstreamStatus === 'flying'}
                        onChange={(event) => {
                          setBetInput(event.target.value)
                          setBetInputError('')
                        }}
                      />
                      <button
                        type="button"
                        className="bet-entry__apply"
                        onClick={applyTypedBet}
                        disabled={!canPlaceBets || jetstreamStatus === 'flying'}
                      >
                        Set
                      </button>
                    </div>
                  </div>

                  <div className="jet-fs__speeds" role="radiogroup" aria-label="Flight speed">
                    {JET_SPEED_ORDER.map((speed) => {
                      const cfg = JET_SPEEDS[speed]
                      return (
                        <button
                          key={speed}
                          type="button"
                          role="radio"
                          aria-checked={jetstreamSpeed === speed}
                          className={`jet-fs__speed${jetstreamSpeed === speed ? ' is-active' : ''}`}
                          onClick={() => handleSelectJetSpeed(speed)}
                          disabled={jetstreamStatus === 'flying'}
                        >
                          <strong>{cfg.label}</strong>
                          <span className="jet-fs__risk" aria-label={`Risk ${cfg.risk} of 4`}>
                            {[1, 2, 3, 4].map((n) => (
                              <i key={n} className={n <= cfg.risk ? 'is-on' : undefined} />
                            ))}
                          </span>
                        </button>
                      )
                    })}
                  </div>

                  <div className="jet-fs__meta">
                    <span>Landing odds</span>
                    <strong>{Math.round(JET_LAND_CHANCE[jetstreamSpeed] * 100)}%</strong>
                    {jetstreamResult ? (
                      <em className={jetstreamResult.cashed ? 'is-win' : 'is-loss'}>
                        {jetstreamResult.cashed
                          ? `+${formatPoints(jetstreamResult.payout)}`
                          : formatSignedPoints(jetstreamResult.net)}
                      </em>
                    ) : null}
                  </div>

                  {betInputError ? <p className="jet-fs__error">{betInputError}</p> : null}

                  <div className="jet-fs__actions">
                    <button
                      type="button"
                      className="action-button action-button--primary jet-fs__go"
                      onClick={handleLaunchJetstream}
                      disabled={jetstreamStatus === 'flying' || !canPlaceBets || bet > bankroll}
                    >
                      {jetstreamStatus === 'flying' ? 'In flight…' : jetstreamStatus === 'idle' ? 'Play' : 'Play again'}
                    </button>
                  </div>
                </div>
              </div>,
              document.body,
            )
          ) : selectedGame === 'chicken' ? (
            createPortal(
              <div className="chicken-fs" style={{ top: `${fullscreenTopOffset}px` }}>
                <div className="chicken-fs__scene">
                  <ChickenRoad
                    multipliers={getChickenConfig(chickenDifficulty).multipliers}
                    currentLane={chickenLane}
                    status={chickenStatus}
                    deathLane={chickenDeathLane}
                    difficulty={chickenDifficulty}
                  />

                  <div className="chicken-fs__hud">
                    <span className="chicken-fs__eyebrow">
                      Chicken Cross · {getChickenConfig(chickenDifficulty).label}
                    </span>
                    <p className="chicken-fs__status">{chickenMessage}</p>
                  </div>

                  <div className="chicken-fs__cashout">
                    <span>Cash out</span>
                    <strong>
                      {chickenLane >= 1 && (chickenStatus === 'playing' || chickenStatus === 'cashed')
                        ? formatPoints(roundMoney(chickenBet * getChickenConfig(chickenDifficulty).multipliers[chickenLane - 1]))
                        : formatPoints(0)}
                    </strong>
                    {chickenResult ? (
                      <em className={chickenResult.cashed ? 'is-win' : 'is-loss'}>
                        {chickenResult.cashed
                          ? `${formatChickenMultiplier(chickenResult.multiplier)} · ${formatSignedPoints(chickenResult.net)}`
                          : `Splat · ${formatSignedPoints(chickenResult.net)}`}
                      </em>
                    ) : null}
                  </div>

                  <button type="button" className="chicken-fs__back" onClick={handleBackToGames}>
                    ← Lobby
                  </button>
                </div>

                <div className="chicken-fs__bar">
                  <div className="chicken-fs__diffs">
                    {CHICKEN_DIFFICULTY_ORDER.map((difficulty) => {
                      const config = CHICKEN_DIFFICULTIES[difficulty]
                      return (
                        <button
                          key={difficulty}
                          type="button"
                          className={`chicken-fs__diff${chickenDifficulty === difficulty ? ' is-active' : ''}`}
                          onClick={() => handleSelectChickenDifficulty(difficulty)}
                          disabled={chickenStatus === 'playing'}
                        >
                          <strong>{config.label}</strong>
                          <span>{formatChickenMultiplier(config.max)}</span>
                        </button>
                      )
                    })}
                  </div>

                  <div className="chicken-fs__bet">
                    <label>Bet</label>
                    <div className="bet-entry__form">
                      <input
                        type="number"
                        min={MIN_BET}
                        value={betInput}
                        disabled={chickenStatus === 'playing'}
                        onChange={(event) => {
                          setBetInput(event.target.value)
                          setBetInputError('')
                        }}
                      />
                      <button
                        type="button"
                        className="bet-entry__apply"
                        onClick={applyTypedBet}
                        disabled={!canPlaceBets || chickenStatus === 'playing'}
                      >
                        Set
                      </button>
                    </div>
                    <span className="chicken-fs__lane">
                      Lane {chickenLane}/{CHICKEN_LANES}
                      {betInputError ? <em className="chicken-fs__error"> · {betInputError}</em> : null}
                    </span>
                  </div>

                  <div className="chicken-fs__actions">
                    {chickenStatus === 'playing' ? (
                      <>
                        <button
                          type="button"
                          className="action-button chicken-fs__cash"
                          onClick={handleChickenCashout}
                          disabled={chickenLane < 1}
                        >
                          Cash Out
                        </button>
                        <button
                          type="button"
                          className="action-button action-button--primary chicken-fs__go"
                          onClick={handleChickenStep}
                          disabled={chickenLane >= CHICKEN_LANES}
                        >
                          {chickenLane >= CHICKEN_LANES
                            ? 'Max reached'
                            : `Cross → ${formatChickenMultiplier(getChickenConfig(chickenDifficulty).multipliers[chickenLane])}`}
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        className="action-button action-button--primary chicken-fs__go"
                        onClick={handleStartChickenRun}
                        disabled={!canPlaceBets || bet > bankroll}
                      >
                        {chickenStatus === 'idle' ? 'Start Crossing' : 'Play Again'}
                      </button>
                    )}
                  </div>
                </div>
              </div>,
              document.body,
            )
          ) : selectedGame === 'plinko' ? (
            <div className="plinko-room">
              <div className="plinko-stage">
                <div className="roulette-stage__header">
                  <div>
                    <p className="bet-panel__label">Plinko Board</p>
                    <p className="roulette-stage__status">{plinkoMessage}</p>
                  </div>
                </div>

                <PlinkoBoard
                  rows={PLINKO_ROWS}
                  multipliers={PLINKO_MULTIPLIERS}
                  pendingDrops={pendingPlinkoDrops}
                  onBallSettled={handleSettlePlinkoDrop}
                />
              </div>

              <div className="roulette-panel">
                <div className="roulette-panel__card">
                  <p className="bet-panel__label">Plinko</p>
                  <h3>{plinkoInFlightDrops > 0 ? 'Ball in motion' : 'Ready to drop'}</h3>
                  <div className="bet-entry roulette-panel__bet-entry">
                    <div className="bet-entry__form">
                      <input
                        type="number"
                        min={MIN_BET}
                        value={betInput}
                        onChange={(event) => {
                          setBetInput(event.target.value)
                          setBetInputError('')
                        }}
                      />
                      <button
                        type="button"
                        className="bet-entry__apply"
                        onClick={applyTypedBet}
                        disabled={!canPlaceBets}
                      >
                        Set bet
                      </button>
                    </div>
                  </div>
                  {betInputError ? <p className="bet-panel__error">{betInputError}</p> : null}
                  <div className="roulette-summary">
                    <div className="roulette-summary__row">
                      <span>Current bet</span>
                      <strong>{formatPoints(bet)}</strong>
                    </div>
                    <div className="roulette-summary__row">
                      <span>Rows</span>
                      <strong>{PLINKO_ROWS}</strong>
                    </div>
                    <div className="roulette-summary__row">
                      <span>Hot slots</span>
                      <strong>{PLINKO_MULTIPLIERS[0]}x / {PLINKO_MULTIPLIERS[PLINKO_MULTIPLIERS.length - 1]}x</strong>
                    </div>
                    <div className="roulette-summary__row">
                      <span>Win streak</span>
                      <strong>{plinkoWinStreak}</strong>
                    </div>
                  </div>
                  <button
                    type="button"
                    className="action-button action-button--primary roulette-stage__spin"
                    onClick={handleStartPlinkoDrop}
                    disabled={!canPlaceBets || bet > bankroll}
                  >
                    {plinkoInFlightDrops > 0 ? `Drop Another (${plinkoInFlightDrops} Live)` : 'Drop Ball'}
                  </button>

                  <div className="plinko-history">
                    <p className="bet-panel__label">Recent Drops</p>
                    {plinkoHistory.length > 0 ? (
                      <div className="plinko-history__list">
                        {plinkoHistory.map((round) => (
                          <article className="plinko-history__item" key={round.id}>
                            <strong>{Number.isInteger(round.multiplier) ? `${round.multiplier}x` : `${round.multiplier.toFixed(1)}x`}</strong>
                            <span>Bet {formatPoints(round.bet)}</span>
                            <span>{formatSignedPoints(round.net)}</span>
                          </article>
                        ))}
                      </div>
                    ) : (
                      <p className="plinko-history__empty">No drops yet.</p>
                    )}
                    <div className="roulette-summary plinko-result">
                      <div className="roulette-summary__row">
                        <span>Last return</span>
                        <strong>{plinkoResult ? formatPoints(plinkoResult.payout) : '$0'}</strong>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          ) : selectedGame === 'blackjack' ? (
            <div className="blackjack-table">
              <div className="blackjack-table__felt">
                <div className="blackjack-deck" aria-hidden="true">
                  <span className="blackjack-deck__card" />
                  <span className="blackjack-deck__card" />
                  <span className="blackjack-deck__card" />
                  <span className="blackjack-deck__card" />
                </div>
                <div className="table-spot table-spot--dealer">
                  <span className="table-spot__label">
                    Dealer
                    {dealerHand.length > 0 ? (
                      <b className="table-spot__total" key={dealerRevealed ? 'full' : 'up'}>
                        {getHandValue(dealerRevealed || devMode ? dealerHand : dealerHand.slice(0, 1))}
                      </b>
                    ) : null}
                  </span>
                  <div className="card-row">
                    {dealerHand.length === 0 ? (
                      <div className="empty-seat">Waiting to start</div>
                    ) : (
                      dealerHand.map((card, index) =>
                        index === 1 && !devMode ? (
                          // hole card: deals in as a back, then flips face-up in
                          // place on reveal (stable key so it never re-deals)
                          <div
                            className={`playing-card blackjack-hole${dealerRevealed ? ' blackjack-hole--up' : ''}`}
                            key="dealer-hole"
                            ref={aimCardFromDeck}
                          >
                            <div className="blackjack-hole__inner">
                              <div className="blackjack-hole__face blackjack-hole__front">
                                <CardFace rank={card.rank} suit={card.suit} />
                              </div>
                              <span className="blackjack-hole__face blackjack-hole__back" />
                            </div>
                          </div>
                        ) : (
                          <div className="playing-card" key={`${card.rank}-${card.suit}-${index}`} ref={aimCardFromDeck}>
                            <CardFace rank={card.rank} suit={card.suit} />
                          </div>
                        ),
                      )
                    )}
                  </div>
                </div>

                <div className="table-center">
                  {roundResult ? (
                    <div
                      className={`round-result round-result--${
                        roundResult.delta > 0 ? 'win' : roundResult.delta < 0 ? 'loss' : 'push'
                      }`}
                      key={roundResult.message}
                      role="status"
                    >
                      <strong>{roundResult.message}</strong>
                      <span>{getScoreChangeLabel(roundResult.delta)}</span>
                    </div>
                  ) : (
                    <>
                      <p className="table-center__title">UES Underground Casino Blackjack</p>
                      <p className="table-center__rules">Reach 21 without going over · Face cards count as 10</p>
                    </>
                  )}
                </div>

                <div className="table-spot table-spot--player">
                  <span className="table-spot__label">Your Hand</span>
                  <div className="player-hands">
                    {playerHands.length === 0 ? (
                      <div className="empty-seat">Tap start to begin</div>
                    ) : (
                      playerHands.map((hand, index) => (
                        <div
                          className={`player-hand${
                            index === activeHandIndex && isHandActive ? ' player-hand--active' : ''
                          }${completedHands[index] ? ' player-hand--complete' : ''}`}
                          key={`hand-${index}`}
                        >
                          <div className="card-row">
                            {hand.map((card, cardIndex) => (
                              <div
                                className="playing-card"
                                key={`${card.rank}-${card.suit}-${index}-${cardIndex}`}
                                ref={aimCardFromDeck}
                              >
                                <CardFace rank={card.rank} suit={card.suit} />
                              </div>
                            ))}
                          </div>
                          <div className="player-hand__meta">
                            <span>{playerHands.length > 1 ? `Hand ${index + 1}` : 'Main Hand'}</span>
                            <strong>
                              {getHandValue(hand)} • Bet {formatPoints(handBets[index] ?? bet)}
                            </strong>
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                  <div className="bet-ring">
                    <span>{playerHands.length > 1 ? 'Total Bet' : 'Current Bet'}</span>
                    <strong>{formatPoints(playerHands.length > 0 ? totalWager : bet)}</strong>
                  </div>
                </div>
              </div>

              <div className="blackjack-controls">
                <div className="bet-panel">
                  <p className="bet-panel__label">Bet Amount</p>
                  <div className="bet-entry">
                    <div className="bet-entry__form">
                      <input
                        type="number"
                        min={MIN_BET}
                        value={betInput}
                        onChange={(event) => {
                          setBetInput(event.target.value)
                          setBetInputError('')
                        }}
                        disabled={isHandActive}
                      />
                      <button
                        type="button"
                        className="bet-entry__apply"
                        onClick={applyTypedBet}
                        disabled={isHandActive || !canPlaceBets}
                      >
                        Set bet
                      </button>
                    </div>
                  </div>
                  {betInputError ? <p className="bet-panel__error">{betInputError}</p> : null}
                </div>

                <div className="action-row">
                  {!isHandActive ? (
                    <button
                      type="button"
                      className="action-button action-button--primary action-button--single"
                      onClick={handleDeal}
                      disabled={!canPlaceBets || bet > bankroll}
                    >
                      {dealerRevealed ? 'Deal Again' : 'Deal'}
                    </button>
                  ) : (
                    <>
                      <button type="button" className="action-button" onClick={handleHit}>
                        Hit
                      </button>
                      <button type="button" className="action-button" onClick={handleStand}>
                        Stand
                      </button>
                      <button
                        type="button"
                        className="action-button"
                        onClick={handleDouble}
                        disabled={!canDouble}
                      >
                        Double
                      </button>
                      {canSplit && (
                        <button type="button" className="action-button" onClick={handleSplit}>
                          Split
                        </button>
                      )}
                    </>
                  )}
                </div>
              </div>
            </div>
          ) : selectedGame === 'roulette' ? (
            <div className="roulette-room">
              <div className="roulette-stage">
                <div className="roulette-stage__header">
                  <div>
                    <p className="bet-panel__label">Roulette</p>
                    <p className="roulette-stage__status">
                      {rouletteIsSpinning
                        ? 'Wheel is spinning...'
                        : rouletteWinningNumber !== null
                          ? `Last number: ${rouletteWinningNumber}`
                          : 'Place your bets, then spin'}
                    </p>
                  </div>
                  <button
                    type="button"
                    className="action-button action-button--primary roulette-stage__spin"
                    onClick={handleSpinRoulette}
                    disabled={
                      rouletteIsSpinning ||
                      rouletteBets.length === 0 ||
                      !canPlaceBets ||
                      rouletteTotalBet > bankroll
                    }
                  >
                    {rouletteIsSpinning ? 'Spinning...' : 'Spin'}
                  </button>
                </div>

                <RouletteWheel
                  order={ROULETTE_WHEEL_ORDER}
                  redNumbers={ROULETTE_RED_NUMBERS}
                  winning={rouletteWinningNumber}
                  spinning={rouletteIsSpinning}
                  rotorRef={rouletteWheelRef}
                  ballRef={rouletteBallRef}
                  rotorTransform={rouletteSpinTransforms(rouletteSpinPoseRef.current).wheel}
                  ballTransform={rouletteSpinTransforms(rouletteSpinPoseRef.current).ball}
                />

                <div className="roulette-table">
                  <div className="roulette-table__greens">
                    <button
                      type="button"
                      className={`roulette-table__zero ${
                        rouletteBets.some(
                          (entry) => entry.bet.kind === 'number' && entry.bet.value === 0,
                        )
                          ? 'roulette-table__zero--selected'
                          : ''
                      } ${rouletteWinningNumber === 0 ? 'roulette-table__zero--winning' : ''}`}
                      onClick={() => {
                        handleSelectRouletteBet({ kind: 'number', value: 0 })
                      }}
                      disabled={rouletteIsSpinning}
                    >
                      0
                    </button>
                    <button
                      type="button"
                      className={`roulette-table__zero ${
                        rouletteBets.some(
                          (entry) => entry.bet.kind === 'number' && entry.bet.value === '00',
                        )
                          ? 'roulette-table__zero--selected'
                          : ''
                      } ${rouletteWinningNumber === '00' ? 'roulette-table__zero--winning' : ''}`}
                      onClick={() => {
                        handleSelectRouletteBet({ kind: 'number', value: '00' })
                      }}
                      disabled={rouletteIsSpinning}
                    >
                      00
                    </button>
                  </div>
                  <div className="roulette-table__numbers">
                    {ROULETTE_NUMBERS.map((value) => (
                      <button
                        type="button"
                        className={`roulette-table__cell ${
                          ROULETTE_RED_NUMBERS.has(value)
                            ? 'roulette-table__cell--red'
                            : 'roulette-table__cell--black'
                        } ${
                          rouletteBets.some(
                            (entry) =>
                              entry.bet.kind === 'number' && entry.bet.value === Number(value),
                          )
                            ? 'roulette-table__cell--selected'
                            : ''
                        } ${
                          rouletteWinningNumber === Number(value)
                            ? 'roulette-table__cell--winning'
                            : ''
                        }`}
                        key={value}
                        onClick={() => {
                          handleSelectRouletteBet({ kind: 'number', value: Number(value) })
                        }}
                        disabled={rouletteIsSpinning}
                      >
                        {value}
                      </button>
                    ))}
                  </div>
                  <div className="roulette-bets roulette-bets--dozens">
                    {ROULETTE_DOZENS.map((dozen) => (
                      <button
                        type="button"
                        className={`roulette-bets__chip ${
                          rouletteBets.some(
                            (entry) => entry.bet.kind === 'range' && entry.bet.value === dozen.value,
                          )
                            ? 'roulette-bets__chip--active'
                            : ''
                        }`}
                        key={dozen.value}
                        onClick={() => {
                          handleSelectRouletteBet({ kind: 'range', value: dozen.value })
                        }}
                        disabled={rouletteIsSpinning}
                      >
                        {dozen.label}
                      </button>
                    ))}
                  </div>
                  <div className="roulette-bets roulette-bets--columns">
                    {ROULETTE_COLUMNS.map((column) => (
                      <button
                        type="button"
                        className={`roulette-bets__chip ${
                          rouletteBets.some(
                            (entry) => entry.bet.kind === 'column' && entry.bet.value === column.value,
                          )
                            ? 'roulette-bets__chip--active'
                            : ''
                        }`}
                        key={column.value}
                        onClick={() => {
                          handleSelectRouletteBet({ kind: 'column', value: column.value })
                        }}
                        disabled={rouletteIsSpinning}
                      >
                        {column.label}
                      </button>
                    ))}
                  </div>
                  <div className="roulette-bets">
                    <button
                      type="button"
                      className={`roulette-bets__chip ${
                        rouletteBets.some(
                          (entry) => entry.bet.kind === 'color' && entry.bet.value === 'red',
                        )
                          ? 'roulette-bets__chip--active'
                          : ''
                      }`}
                      onClick={() => {
                        handleSelectRouletteBet({ kind: 'color', value: 'red' })
                      }}
                      disabled={rouletteIsSpinning}
                    >
                      Red
                    </button>
                    <button
                      type="button"
                      className={`roulette-bets__chip ${
                        rouletteBets.some(
                          (entry) => entry.bet.kind === 'color' && entry.bet.value === 'black',
                        )
                          ? 'roulette-bets__chip--active'
                          : ''
                      }`}
                      onClick={() => {
                        handleSelectRouletteBet({ kind: 'color', value: 'black' })
                      }}
                      disabled={rouletteIsSpinning}
                    >
                      Black
                    </button>
                    <button
                      type="button"
                      className={`roulette-bets__chip ${
                        rouletteBets.some(
                          (entry) => entry.bet.kind === 'parity' && entry.bet.value === 'odd',
                        )
                          ? 'roulette-bets__chip--active'
                          : ''
                      }`}
                      onClick={() => {
                        handleSelectRouletteBet({ kind: 'parity', value: 'odd' })
                      }}
                      disabled={rouletteIsSpinning}
                    >
                      Odd
                    </button>
                    <button
                      type="button"
                      className={`roulette-bets__chip ${
                        rouletteBets.some(
                          (entry) => entry.bet.kind === 'parity' && entry.bet.value === 'even',
                        )
                          ? 'roulette-bets__chip--active'
                          : ''
                      }`}
                      onClick={() => {
                        handleSelectRouletteBet({ kind: 'parity', value: 'even' })
                      }}
                      disabled={rouletteIsSpinning}
                    >
                      Even
                    </button>
                    <button
                      type="button"
                      className={`roulette-bets__chip ${
                        rouletteBets.some(
                          (entry) => entry.bet.kind === 'range' && entry.bet.value === '1-18',
                        )
                          ? 'roulette-bets__chip--active'
                          : ''
                      }`}
                      onClick={() => {
                        handleSelectRouletteBet({ kind: 'range', value: '1-18' })
                      }}
                      disabled={rouletteIsSpinning}
                    >
                      1-18
                    </button>
                    <button
                      type="button"
                      className={`roulette-bets__chip ${
                        rouletteBets.some(
                          (entry) => entry.bet.kind === 'range' && entry.bet.value === '19-36',
                        )
                          ? 'roulette-bets__chip--active'
                          : ''
                      }`}
                      onClick={() => {
                        handleSelectRouletteBet({ kind: 'range', value: '19-36' })
                      }}
                      disabled={rouletteIsSpinning}
                    >
                      19-36
                    </button>
                  </div>
                </div>

                <div className="roulette-payouts">
                  <div className="roulette-payouts__item">
                    <span>Straight up</span>
                    <strong>35:1</strong>
                  </div>
                  <div className="roulette-payouts__item">
                    <span>Rows</span>
                    <strong>2:1</strong>
                  </div>
                  <div className="roulette-payouts__item">
                    <span>Dozens</span>
                    <strong>2:1</strong>
                  </div>
                  <div className="roulette-payouts__item">
                    <span>Red / Black</span>
                    <strong>1:1</strong>
                  </div>
                  <div className="roulette-payouts__item">
                    <span>Odd / Even</span>
                    <strong>1:1</strong>
                  </div>
                  <div className="roulette-payouts__item">
                    <span>1–18 / 19–36</span>
                    <strong>1:1</strong>
                  </div>
                </div>
              </div>

              <div className="roulette-panel">
                <div className="roulette-panel__card">
                  {rouletteBets.length > 0 ? (
                    <>
                      <p className="bet-panel__label">Bets</p>
                      <h3>{rouletteBets.length} pick{rouletteBets.length === 1 ? '' : 's'} ready</h3>
                      <div className="roulette-bet-list">
                        {rouletteBets.map((entry) => (
                          <article className="roulette-bet-card" key={entry.id}>
                            <button
                              type="button"
                              className="roulette-delete"
                              onClick={() => {
                                if (rouletteIsSpinning) {
                                  return
                                }

                                setRouletteBets((currentBets) =>
                                  currentBets.filter((currentBet) => currentBet.id !== entry.id),
                                )
                                setRouletteResult(null)
                                setBetInputError('')
                              }}
                              disabled={rouletteIsSpinning}
                              aria-label={`Delete ${getRouletteBetDisplayLabel(entry.bet)} bet`}
                            >
                              <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                                <path d="M4 7h16M9.5 7V4.8c0-.44.36-.8.8-.8h3.4c.44 0 .8.36.8.8V7M6.5 7l.85 11.6c.06.8.73 1.4 1.53 1.4h6.24c.8 0 1.47-.6 1.53-1.4L17.5 7M10 11v5M14 11v5" />
                              </svg>
                            </button>
                            <p className="bet-panel__label">Bet</p>
                            <h3>{getRouletteBetDisplayLabel(entry.bet)}</h3>
                            <div className="bet-entry roulette-panel__bet-entry">
                              <div className="bet-entry__form">
                                <input
                                  type="number"
                                  min={MIN_BET}
                                  value={entry.input}
                                  onChange={(event) => {
                                    const nextInput = event.target.value
                                    setRouletteBets((currentBets) =>
                                      currentBets.map((currentBet) =>
                                        currentBet.id === entry.id
                                          ? { ...currentBet, input: nextInput }
                                          : currentBet,
                                      ),
                                    )
                                    setBetInputError('')
                                  }}
                                  disabled={rouletteIsSpinning}
                                />
                                <button
                                  type="button"
                                  className="bet-entry__apply"
                                  onClick={() => {
                                    const parsedBet = Number(entry.input)

                                    if (!Number.isFinite(parsedBet) || parsedBet < MIN_BET) {
                                      setBetInputError(`Each roulette bet must be at least $${MIN_BET}.`)
                                      return
                                    }

                                    const nextTotal = rouletteBets.reduce(
                                      (sum, currentBet) =>
                                        sum +
                                        (currentBet.id === entry.id ? parsedBet : currentBet.amount),
                                      0,
                                    )

                                    if (nextTotal > bankroll) {
                                      setBetInputError(
                                        `Total bets cannot be more than your bankroll of ${formatPoints(bankroll)}.`,
                                      )
                                      return
                                    }

                                    setRouletteBets((currentBets) =>
                                      currentBets.map((currentBet) =>
                                        currentBet.id === entry.id
                                          ? {
                                              ...currentBet,
                                              amount: parsedBet,
                                              input: String(parsedBet),
                                            }
                                          : currentBet,
                                      ),
                                    )
                                    setBetInputError('')
                                  }}
                                  disabled={rouletteIsSpinning}
                                >
                                  Set bet
                                </button>
                              </div>
                            </div>
                            <div className="roulette-summary">
                              <div className="roulette-summary__row">
                                <span>Current bet</span>
                                <strong>{formatPoints(entry.amount)}</strong>
                              </div>
                            </div>
                          </article>
                        ))}
                      </div>
                      {betInputError ? <p className="bet-panel__error">{betInputError}</p> : null}
                      <div className="roulette-summary">
                        <div className="roulette-summary__row">
                          <span>Total bet</span>
                          <strong>{formatPoints(rouletteTotalBet)}</strong>
                        </div>
                        <div className="roulette-summary__row">
                          <span>Selections</span>
                          <strong>{rouletteBets.length}</strong>
                        </div>
                        {rouletteResult ? (
                          <div className="roulette-summary__row">
                            <span>Last result</span>
                            <strong>{formatSignedPoints(rouletteResult.delta)}</strong>
                          </div>
                        ) : null}
                      </div>
                    </>
                  ) : (
                    <>
                      <p className="bet-panel__label">Roulette</p>
                      <h3>Build your bet slip</h3>
                      <p className="roulette-panel__copy">
                        Click any number, or bet Red, Black, Odd, Even, 1-18, or 19-36. Each
                        click adds a bet to the slip, and every bet can have its own amount.
                      </p>
                    </>
                  )}
                </div>
              </div>
            </div>
          ) : selectedGame === 'mines' ? (
            <div className="mines-room">
              <div className="mines-stage">
                <div className="roulette-stage__header">
                  <div>
                    <p className="bet-panel__label">Minefield</p>
                    <p className="roulette-stage__status">{minesMessage}</p>
                  </div>
                </div>

                <div className={`mines-board${minesBoard.length > 0 ? '' : ' mines-board--idle'}`}>
                  {minesBoard.length > 0 ? (
                    minesBoard.map((tile, index) => (
                      <button
                        type="button"
                        key={tile.id}
                        style={{ '--i': index } as CSSProperties}
                        className={`mines-cell ${
                          tile.revealed
                            ? tile.isMine
                              ? tile.hit
                                ? 'mines-cell--mine mines-cell--hit'
                                : 'mines-cell--mine mines-cell--exposed'
                              : 'mines-cell--safe'
                            : ''
                        }`}
                        onClick={() => {
                          handleRevealMinesTile(tile.id)
                        }}
                        disabled={!minesRoundActive || tile.revealed}
                      >
                        {tile.revealed ? (
                          <span className="mines-cell__content">
                            {tile.isMine ? (
                              <MineIcon className="mines-cell__art" />
                            ) : (
                              <>
                                <GemIcon className="mines-cell__art" />
                                <small className="mines-cell__mult">
                                  x{(tile.multiplier ?? minesMultiplier).toFixed(2)}
                                </small>
                              </>
                            )}
                          </span>
                        ) : devMode && tile.isMine ? (
                          <span className="mines-cell__content mines-cell__content--dev-mine">
                            MINE
                          </span>
                        ) : (
                          <span className="mines-cell__cover" />
                        )}
                      </button>
                    ))
                  ) : (
                    <>
                      {Array.from({ length: 25 }, (_, index) => (
                        <span key={index} className="mines-cell mines-cell--idle" aria-hidden="true">
                          <span className="mines-cell__cover" />
                        </span>
                      ))}
                      <p className="mines-board__empty">Press Start Round</p>
                    </>
                  )}
                </div>

                {minesResult ? (
                  <div
                    className={`round-result round-result--roulette round-result--${
                      minesResult.delta > 0 ? 'win' : minesResult.delta < 0 ? 'loss' : 'push'
                    }`}
                    key={minesResult.message}
                    role="status"
                  >
                    <strong>{minesResult.message}</strong>
                    <span>
                      {getScoreChangeLabel(minesResult.delta)}
                    </span>
                  </div>
                ) : null}
              </div>

              <div className="roulette-panel">
                <div className="roulette-panel__card">
                  <p className="bet-panel__label">Mines</p>
                  <h3>{minesRoundActive ? 'Keep going or collect now' : 'Start a round'}</h3>
                  <div className="bet-entry roulette-panel__bet-entry">
                    <div className="bet-entry__form">
                      <input
                        type="number"
                        min={MIN_BET}
                        value={betInput}
                        onChange={(event) => {
                          setBetInput(event.target.value)
                          setBetInputError('')
                        }}
                        disabled={minesRoundActive}
                      />
                      <button
                        type="button"
                        className="bet-entry__apply"
                        onClick={applyTypedBet}
                        disabled={minesRoundActive || !canPlaceBets}
                      >
                        Set bet
                      </button>
                    </div>
                  </div>
                  <div className="bet-entry roulette-panel__bet-entry">
                    <div className="bet-entry__form">
                      <input
                        type="number"
                        min={MINES_MIN_COUNT}
                        max={MINES_MAX_COUNT}
                        value={minesCountInput}
                        onChange={(event) => {
                          setMinesCountInput(event.target.value)
                          setBetInputError('')
                        }}
                        disabled={minesRoundActive}
                      />
                      <button
                        type="button"
                        className="bet-entry__apply"
                        onClick={applyMinesCount}
                        disabled={minesRoundActive}
                      >
                        Set Mines
                      </button>
                    </div>
                  </div>
                  {betInputError ? <p className="bet-panel__error">{betInputError}</p> : null}
                  <div className="roulette-summary">
                    <div className="roulette-summary__row">
                      <span>Current bet</span>
                      <strong>{formatPoints(bet)}</strong>
                    </div>
                    <div className="roulette-summary__row">
                      <span>Mines</span>
                      <strong>{minesCount}</strong>
                    </div>
                    <div className="roulette-summary__row">
                      <span>Safe tiles</span>
                      <strong>{minesSafeTiles}</strong>
                    </div>
                    <div className="roulette-summary__row">
                      <span>Safe picks</span>
                      <strong>{minesSafePicks}</strong>
                    </div>
                    <div className="roulette-summary__row">
                      <span>Multiplier</span>
                      <strong>x{minesMultiplier.toFixed(2)}</strong>
                    </div>
                    <div className="roulette-summary__row">
                      <span>Next step</span>
                      <strong>{minesRoundActive ? `x${minesNextStepMultiplier.toFixed(2)}` : 'Ready'}</strong>
                    </div>
                    <div className="roulette-summary__row">
                      <span>Collect now</span>
                      <strong>{minesSafePicks > 0 ? formatPoints(minesCashOutAmount) : '$0'}</strong>
                    </div>
                  </div>
                  {!minesRoundActive ? (
                    <button
                      type="button"
                      className="action-button action-button--primary roulette-stage__spin"
                      onClick={handleStartMines}
                      disabled={!canPlaceBets || bet > bankroll}
                    >
                      {minesResult ? 'Start Next Round' : 'Start Round'}
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="action-button action-button--primary mines-cashout"
                      onClick={handleCashOutMines}
                      disabled={minesSafePicks === 0}
                    >
                      Collect
                    </button>
                  )}
                </div>
              </div>
            </div>
          ) : selectedGame === 'poker' ? (
            <div className="poker-room">
              <div className="poker-stage">
                <div className="roulette-stage__header">
                  <div>
                    <p className="bet-panel__label">{pokerScreen === 'table' ? 'Poker' : 'Poker Lobby'}</p>
                    <p className="roulette-stage__status">{pokerMessage}</p>
                  </div>
                </div>

                <div className="poker-entry">
                  {pokerScreen === 'table' ? (
                    <div className="poker-table">
                      {!pokerGame ? (
                        <>
                          <div className="poker-code poker-code--corner">
                            <span className="bet-panel__label">Room Code</span>
                            <strong>{pokerRoomCode}</strong>
                          </div>

                          <div className="roulette-summary poker-table__summary poker-table__summary--corner">
                            <div className="roulette-summary__row">
                              <span>Players</span>
                              <strong>{pokerPlayerCount}/6</strong>
                            </div>
                            <div className="roulette-summary__row">
                              <span>Status</span>
                              <strong>{pokerPlayerCount >= 2 ? 'Ready' : 'Need 2+'}</strong>
                            </div>
                          </div>
                        </>
                      ) : null}

                      <div
                        className={`poker-felt${pokerGame ? ' poker-felt--live' : ''}${
                          pokerGame?.street === 'showdown' ? ' poker-felt--showdown' : ''
                        }`}
                      >
                        {pokerPotAnimations.map((animation) => (
                          <div className="poker-pot-animation" data-seat={animation.seatIndex} key={animation.id}>
                            <div className="poker-chip-trail">
                              {animation.chips.map((chip, index) => (
                                <div
                                  className={`poker-chip poker-chip--${chip.color}`}
                                  key={`${animation.id}-${chip.color}-${index}`}
                                  style={{ zIndex: animation.chips.length - index }}
                                >
                                  <span>{chip.label}</span>
                                </div>
                              ))}
                            </div>
                          </div>
                        ))}
                        {[0, 1, 2, 3, 4, 5].map((seatIndex) => {
                          const seat = pokerSeats[seatIndex]
                          const seatState = seat && pokerGame ? pokerGame.players[seat.id] : null
                          const shouldRevealCards =
                            Boolean(seatState) &&
                            (seat?.id === pokerPlayerId ||
                              devMode ||
                              (pokerGame?.street === 'showdown' && !seatState?.folded))
                          const isYouSeat = seat?.id === pokerPlayerId
                          const isFoldAnimating = Boolean(seat && pokerFoldAnimations[seat.id])
                          const isCheckAnimating = Boolean(seat && pokerCheckAnimations[seat.id])
                          const showSeatCards = Boolean(
                            seat &&
                              seatState &&
                              seat.id !== pokerPlayerId &&
                              (!seatState.folded || isFoldAnimating),
                          )
                          const blindMarkers =
                            pokerGame?.street === 'preflop' && seat && seatState
                              ? [
                                  ...(seatIndex === pokerSmallBlindSeatIndex && !seatState.acted
                                    ? [{ label: 'SB', amount: pokerSmallBlind }]
                                    : []),
                                  ...(seatIndex === pokerBigBlindSeatIndex && !seatState.acted
                                    ? [{ label: 'BB', amount: pokerBigBlind }]
                                    : []),
                                ]
                              : []
                          return (
                            <div
                              className={`poker-seat poker-seat--${seatIndex + 1}${
                                seat?.id === pokerPlayerId ? ' poker-seat--you' : ''
                              }${
                                pokerGame?.activeSeatIndex === seatIndex ? ' poker-seat--active' : ''
                              }`}
                              key={seatIndex}
                            >
                              <div className={`poker-seat__badge${isCheckAnimating ? ' poker-seat__badge--checking' : ''}`}>
                                {isCheckAnimating ? (
                                  <div className="poker-seat__check-ripple" aria-hidden="true">
                                    <span className="poker-seat__check-ring poker-seat__check-ring--one" />
                                    <span className="poker-seat__check-ring poker-seat__check-ring--two" />
                                  </div>
                                ) : null}
                                {seat && pokerActionPops[seat.id] ? (
                                  <span
                                    className={`poker-seat__action-pop poker-seat__action-pop--${pokerActionPops[seat.id].kind}`}
                                    key={pokerActionPops[seat.id].id}
                                    aria-hidden="true"
                                  >
                                    {pokerActionPops[seat.id].tag}
                                  </span>
                                ) : null}
                                <span>{seat ? seat.name : 'Open Seat'}</span>
                                <strong>
                                  {seat
                                    ? seatState?.folded
                                      ? 'Folded'
                                      : seat.id === pokerPlayerId
                                        ? 'You'
                                        : formatPoints(seatState?.chips ?? pokerPlayerChips[seat.id] ?? 0)
                                    : 'Waiting'}
                                </strong>
                              </div>
                              {seat && seatState && (showSeatCards || blindMarkers.length > 0) ? (
                                <div className={`poker-seat__lower${isFoldAnimating ? ' poker-seat__lower--folding' : ''}`}>
                                  {isYouSeat && blindMarkers.length > 0 ? (
                                    <div className="poker-seat__markers poker-seat__markers--under">
                                      {blindMarkers.map((marker) => (
                                        <div className="poker-seat__marker" key={`${seatIndex}-${marker.label}`}>
                                          <span>{marker.label}</span>
                                          <strong>{formatPoints(marker.amount)}</strong>
                                        </div>
                                      ))}
                                    </div>
                                  ) : null}
                                  {showSeatCards ? (
                                    <div className={`poker-seat__cards${isFoldAnimating ? ' poker-seat__cards--folding' : ''}`}>
                                      {shouldRevealCards
                                        ? seatState.holeCards.map((card, index) => (
                                            <div
                                              className="playing-card poker-seat__card poker-seat__card--reveal"
                                              key={`${seat.id}-${card.rank}-${card.suit}`}
                                              style={{ animationDelay: `${index * 90}ms` }}
                                            >
                                              <CardFace rank={card.rank} suit={card.suit} />
                                            </div>
                                          ))
                                        : [0, 1].map((index) => (
                                            <div
                                              className="playing-card playing-card--back poker-seat__card"
                                              key={`${seat.id}-hidden-${index}`}
                                            />
                                          ))}
                                    </div>
                                  ) : null}
                                  {!isYouSeat && blindMarkers.length > 0 ? (
                                    <div className="poker-seat__markers poker-seat__markers--side">
                                      {blindMarkers.map((marker) => (
                                        <div className="poker-seat__marker" key={`${seatIndex}-${marker.label}`}>
                                          <span>{marker.label}</span>
                                          <strong>{formatPoints(marker.amount)}</strong>
                                        </div>
                                      ))}
                                    </div>
                                  ) : null}
                                </div>
                              ) : null}
                            </div>
                          )
                        })}

                        <div className="poker-center">
                          <p className="table-center__title">Texas Hold’em</p>
                          <p className="table-center__rules">
                            {pokerGame
                              ? `Pot ${formatPoints(pokerGame.pot)} • Current bet ${formatPoints(pokerGame.currentBet)}`
                              : pokerPlayerCount >= 2
                              ? 'Enough players are seated to start'
                              : `Waiting for ${2 - pokerPlayerCount} more player${2 - pokerPlayerCount === 1 ? '' : 's'}`}
                          </p>
                          {pokerGame?.communityCards.length ? (
                            <div className="poker-community">
                              {pokerGame.communityCards.map((card, index) => {
                                const animationDelay =
                                  pokerGame.street === 'flop' ? `${index * 120}ms` : '0ms'

                                return (
                                  <div
                                    className="playing-card poker-community__card poker-community__card--reveal"
                                    key={`community-${index}`}
                                    style={{ animationDelay }}
                                  >
                                    <CardFace rank={card.rank} suit={card.suit} />
                                  </div>
                                )
                              })}
                            </div>
                          ) : null}
                          {pokerGame ? (
                            <div className={`poker-pot-chips${pokerPotPulse ? ' poker-pot-chips--pulse' : ''}`}>
                              {pokerPotChips.map((chip, index) => (
                                <div
                                  className={`poker-chip poker-chip--${chip.color}`}
                                  key={`pot-${chip.color}-${index}`}
                                  style={{ zIndex: pokerPotChips.length - index }}
                                >
                                  <span>{chip.label}</span>
                                </div>
                              ))}
                            </div>
                          ) : null}
                          {!pokerGame && pokerPlayerCount >= 2 && pokerHostId === pokerPlayerId ? (
                            <button
                              type="button"
                              className="action-button action-button--primary poker-start"
                              onClick={handleStartPokerGame}
                            >
                              Start Game
                            </button>
                          ) : null}
                          {pokerGame?.street === 'showdown' && pokerHostId === pokerPlayerId ? (
                            <button
                              type="button"
                              className="action-button action-button--primary poker-start"
                              onClick={handleStartPokerGame}
                            >
                              Start Next Hand
                            </button>
                          ) : null}
                        </div>

                      </div>

                      {pokerGame && pokerYouState ? (
                        <div className="poker-your-hand">
                          <p className="bet-panel__label">Your Hand</p>
                          <div className="poker-your-hand__cards">
                            {pokerYouState.holeCards.map((card, index) => (
                              <div
                                className="playing-card poker-your-hand__card poker-deal"
                                key={`you-${card.rank}-${card.suit}`}
                                style={{ animationDelay: `${index * 110}ms` }}
                              >
                                <CardFace rank={card.rank} suit={card.suit} />
                              </div>
                            ))}
                          </div>
                        </div>
                      ) : null}

                      {!pokerGame ? (
                        <>
                          <div className="poker-buyin poker-blinds">
                            <p className="bet-panel__label">Blinds</p>
                            {pokerHostId === pokerPlayerId ? (
                              <>
                                <div className="bet-entry__form">
                                  <input
                                    type="number"
                                    min={1}
                                    value={pokerSmallBlindInput}
                                    onChange={(event) => {
                                      setPokerSmallBlindInput(event.target.value)
                                      setBetInputError('')
                                    }}
                                  />
                                  <button
                                    type="button"
                                    className="bet-entry__apply"
                                    onClick={applyPokerBlinds}
                                  >
                                    Set
                                  </button>
                                </div>
                                <div className="roulette-summary poker-buyin__summary">
                                  <div className="roulette-summary__row">
                                    <span>Small blind</span>
                                    <strong>{formatPoints(pokerSmallBlind)}</strong>
                                  </div>
                                  <div className="roulette-summary__row">
                                    <span>Big blind</span>
                                    <strong>{formatPoints(pokerBigBlind)}</strong>
                                  </div>
                                </div>
                              </>
                            ) : (
                              <div className="roulette-summary poker-buyin__summary">
                                <div className="roulette-summary__row">
                                  <span>Small blind</span>
                                  <strong>{formatPoints(pokerSmallBlind)}</strong>
                                </div>
                                <div className="roulette-summary__row">
                                  <span>Big blind</span>
                                  <strong>{formatPoints(pokerBigBlind)}</strong>
                                </div>
                              </div>
                            )}
                          </div>

                          <div className="poker-buyin">
                            <p className="bet-panel__label">Buy-In</p>
                            {pokerHostId === pokerPlayerId ? (
                              <div className="bet-entry__form">
                                <input
                                  type="number"
                                  min={MIN_BET}
                                  value={pokerBuyInInput}
                                  onChange={(event) => {
                                    setPokerBuyInInput(event.target.value)
                                    setBetInputError('')
                                  }}
                                />
                                <button
                                  type="button"
                                  className="bet-entry__apply"
                                  onClick={applyPokerBuyIn}
                                >
                                  Set
                                </button>
                              </div>
                            ) : null}
                            <div className="roulette-summary poker-buyin__summary">
                              <div className="roulette-summary__row">
                                <span>Table entry</span>
                                <strong>{formatPoints(pokerBuyIn)}</strong>
                              </div>
                            </div>
                          </div>

                          <div className="roulette-summary poker-bankroll">
                            <div className="roulette-summary__row">
                              <span>Bankroll</span>
                              <strong>{formatPoints(bankroll)}</strong>
                            </div>
                            {pokerYouSeat ? (
                              <button
                                type="button"
                                className="action-button poker-cashout"
                                onClick={handleCashOutPoker}
                              >
                                Leave Table
                              </button>
                            ) : null}
                          </div>
                        </>
                      ) : null}
                      {(betInputError || pokerActionError) ? (
                        <p className="bet-panel__error">{betInputError || pokerActionError}</p>
                      ) : null}
                      {pokerGame && pokerHandLog.length > 0 ? (
                        <div className="poker-log">
                          <p className="bet-panel__label">This hand</p>
                          <ol className="poker-log__list">
                            {pokerHandLog.map((entry) => (
                              <li className={`poker-log__item poker-log__item--${entry.kind}`} key={entry.id}>
                                {entry.text}
                              </li>
                            ))}
                          </ol>
                        </div>
                      ) : null}
                      {pokerGame ? (
                        <div className="poker-controls">
                          <div className="roulette-summary poker-controls__summary">
                            <div className="roulette-summary__row">
                              <span>Street</span>
                              <strong>{pokerGame.street}</strong>
                            </div>
                            <div className="roulette-summary__row">
                              <span>Turn</span>
                              <strong>{pokerActiveSeat?.name ?? 'None'}</strong>
                            </div>
                            {pokerYouState ? (
                              <div className="roulette-summary__row">
                                <span>Your markers</span>
                                <strong>{formatPoints(pokerYouState.chips)}</strong>
                              </div>
                            ) : null}
                            {pokerYouSeat ? (
                              <button
                                type="button"
                                className="action-button poker-cashout"
                                onClick={handleCashOutPoker}
                                disabled={!pokerCanCashOut}
                              >
                                {pokerCanCashOut ? 'Leave Table' : 'Leave After Hand'}
                              </button>
                            ) : null}
                          </div>
                          {pokerCanAct ? (
                            <div className="poker-controls__actions">
                              <button type="button" className="action-button" onClick={handlePokerFold}>
                                Fold
                              </button>
                              <button
                                type="button"
                                className="action-button action-button--primary"
                                onClick={handlePokerCallOrCheck}
                              >
                                {pokerCallAmount > 0 ? `Match ${formatPoints(pokerCallAmount)}` : 'Check'}
                              </button>
                              <div className="poker-controls__raise-card">
                                <p className="poker-controls__raise-label">Set your raise</p>
                                <div className="bet-entry__form poker-controls__raise">
                                  <input
                                    type="number"
                                    min={(pokerGame.currentBet || MIN_BET) + 1}
                                    value={pokerRaiseInput}
                                    placeholder={`Raise to ${formatPoints((pokerGame.currentBet || MIN_BET) + 1)}+`}
                                    onChange={(event) => {
                                      setPokerRaiseInput(event.target.value)
                                      setPokerActionError('')
                                    }}
                                  />
                                  <button
                                    type="button"
                                    className="bet-entry__apply"
                                    onClick={handlePokerRaise}
                                  >
                                    Raise To
                                  </button>
                                </div>
                                <p className="poker-controls__raise-hint">
                                  Enter the total amount you want to bet.
                                </p>
                              </div>
                            </div>
                          ) : (
                            <div className="roulette-summary poker-controls__waiting">
                              <div className="roulette-summary__row">
                                <span>Action</span>
                                <strong>
                                  {pokerGame.street === 'showdown'
                                    ? pokerGame.winnerMessage ?? 'Hand complete.'
                                    : pokerYouState?.folded
                                      ? 'You folded this hand.'
                                      : pokerActiveSeat
                                        ? `Waiting on ${pokerActiveSeat.name}`
                                        : 'Waiting for the next hand'}
                                </strong>
                              </div>
                            </div>
                          )}
                        </div>
                      ) : null}
                    </div>
                  ) : pokerMode === 'choose' ? (
                    <div className="poker-choice-grid">
                      <button
                        type="button"
                        className="poker-choice-card"
                        onClick={() => {
                          handleChoosePokerMode('join')
                        }}
                      >
                        <span className="game-card__eyebrow">Room code</span>
                        <strong>Join</strong>
                        <span className="game-card__copy">
                          Enter a 4 character code and jump into an existing table.
                        </span>
                      </button>
                      <button
                        type="button"
                        className="poker-choice-card poker-choice-card--create"
                        onClick={() => {
                          if (hasSavedPlayerName) {
                            handleSubmitPoker('create')
                            return
                          }

                          handleChoosePokerMode('create')
                        }}
                      >
                        <span className="game-card__eyebrow">New table</span>
                        <strong>Create</strong>
                        <span className="game-card__copy">
                          Start a fresh poker room and get it ready to share with friends.
                        </span>
                      </button>
                    </div>
                  ) : (
                    <div className="poker-form-card">
                      <button
                        type="button"
                        className="status-badge status-badge--button poker-back"
                        onClick={handleResetPokerMode}
                      >
                        Back
                      </button>
                      <div className="poker-form">
                        {hasSavedPlayerName ? (
                          <div className="roulette-summary">
                            <div className="roulette-summary__row">
                              <span>Player</span>
                              <strong>{playerProfile.name}</strong>
                            </div>
                          </div>
                        ) : (
                          <label className="poker-field">
                            <span>Name</span>
                            <input
                              type="text"
                              value={pokerName}
                              onChange={(event) => {
                                setPokerName(event.target.value)
                                setBetInputError('')
                              }}
                              placeholder="Enter your name"
                            />
                          </label>
                        )}
                        {pokerMode === 'join' ? (
                          <label className="poker-field">
                            <span>Room Code</span>
                            <input
                              type="text"
                              value={pokerCode}
                              onChange={(event) => {
                                setPokerCode(event.target.value.toUpperCase())
                                setBetInputError('')
                              }}
                              placeholder="4 character code"
                              maxLength={4}
                            />
                          </label>
                        ) : null}
                        {betInputError ? <p className="bet-panel__error">{betInputError}</p> : null}
                        <button
                          type="button"
                          className="action-button action-button--primary poker-submit"
                          onClick={() => {
                            handleSubmitPoker(pokerMode)
                          }}
                        >
                          {pokerMode === 'join' ? 'Join Table' : 'Create Table'}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </div>
              {pokerNeedsBuyInConfirmation && pokerPendingStart ? (
                <div className="poker-modal">
                  <div className="poker-modal__card">
                    <p className="bet-panel__label">Confirm Buy-In</p>
                    <h3>Do you want to spend {formatPoints(pokerPendingStart.buyIn)} to join?</h3>
                    <p className="roulette-panel__copy">
                      Choose `Yes` to stay at the table and continue into the hand. Choose `No`
                      to leave the table and return to the home screen.
                    </p>
                    <div className="poker-modal__actions">
                      <button
                        type="button"
                        className="action-button action-button--primary"
                        onClick={handleConfirmPokerBuyIn}
                      >
                        Yes
                      </button>
                      <button
                        type="button"
                        className="action-button"
                        onClick={handleDeclinePokerBuyIn}
                      >
                        No
                      </button>
                    </div>
                  </div>
                </div>
              ) : null}
              {pokerInsufficientFundsModal ? (
                <div className="poker-modal">
                  <div className="poker-modal__card">
                    <p className="bet-panel__label">Buy-In Error</p>
                    <h3>Not enough points</h3>
                    <p className="roulette-panel__copy">
                      You did not have enough chips to cover the buy-in, so you were sent
                      back to the home screen.
                    </p>
                    <div className="poker-modal__actions poker-modal__actions--single">
                      <button
                        type="button"
                        className="action-button action-button--primary"
                        onClick={() => {
                          setPokerInsufficientFundsModal(false)
                        }}
                      >
                        OK
                      </button>
                    </div>
                  </div>
                </div>
              ) : null}
            </div>
          ) : (
            <div className="hilo-room">
              <div className="hilo-stage">
                <div className="roulette-stage__header">
                  <div>
                    <p className="bet-panel__label">Hi-Lo Table</p>
                    <p className="roulette-stage__status">
                      {hiLoMessage}
                    </p>
                  </div>
                </div>

                <div className="hilo-board">
                  <div className="hilo-card-slot">
                    <span className="table-spot__label">Current Card</span>
                    {hiLoCurrentCard ? (
                      <div className="playing-card hilo-card">
                        <CardFace rank={hiLoCurrentCard.rank} suit={hiLoCurrentCard.suit} />
                      </div>
                    ) : (
                      <div className="empty-seat">Start to begin</div>
                    )}
                  </div>
                  <div className="hilo-card-slot">
                    <span className="table-spot__label">Next Card</span>
                    {hiLoCurrentCard && !hiLoResult ? (
                      <div className="hilo-card-stack">
                        {devMode && hiLoUpcomingCard ? (
                          <div className="playing-card hilo-card hilo-card--base">
                            <CardFace rank={hiLoUpcomingCard.rank} suit={hiLoUpcomingCard.suit} />
                          </div>
                        ) : (
                          <div className="playing-card playing-card--back hilo-card hilo-card--base" />
                        )}
                        {hiLoNextCard ? (
                          <div className={`playing-card hilo-card hilo-card--overlay${hiLoSliding ? ' hilo-card--slide' : ''}`}>
                            <CardFace rank={hiLoNextCard.rank} suit={hiLoNextCard.suit} />
                          </div>
                        ) : null}
                      </div>
                    ) : (
                      <div className="empty-seat">Hidden</div>
                    )}
                  </div>
                </div>

                {hiLoResult ? (
                  <div
                    className={`round-result round-result--roulette round-result--${
                      hiLoResult.delta > 0 ? 'win' : hiLoResult.delta < 0 ? 'loss' : 'push'
                    }`}
                    key={hiLoResult.message}
                    role="status"
                  >
                    <strong>{hiLoResult.message}</strong>
                    <span>
                      {getScoreChangeLabel(hiLoResult.delta)}
                    </span>
                  </div>
                ) : null}
              </div>

              <div className="roulette-panel">
                <div className="roulette-panel__card">
                  <p className="bet-panel__label">Hi-Lo</p>
                  <h3>{hiLoCurrentCard && !hiLoResult ? 'Make your guess' : 'Start a round'}</h3>
                  <div className="bet-entry roulette-panel__bet-entry">
                    <div className="bet-entry__form">
                      <input
                        type="number"
                        min={MIN_BET}
                        value={betInput}
                        onChange={(event) => {
                          setBetInput(event.target.value)
                          setBetInputError('')
                        }}
                        disabled={Boolean(hiLoCurrentCard && !hiLoResult)}
                      />
                      <button
                        type="button"
                        className="bet-entry__apply"
                        onClick={applyTypedBet}
                        disabled={Boolean(hiLoCurrentCard && !hiLoResult) || !canPlaceBets}
                      >
                        Set bet
                      </button>
                    </div>
                  </div>
                  {betInputError ? <p className="bet-panel__error">{betInputError}</p> : null}
                  <div className="roulette-summary">
                    <div className="roulette-summary__row">
                      <span>Current bet</span>
                      <strong>{formatPoints(bet)}</strong>
                    </div>
                    <div className="roulette-summary__row">
                      <span>Hits</span>
                      <strong>{hiLoStreak}</strong>
                    </div>
                    <div className="roulette-summary__row">
                      <span>Multiplier</span>
                      <strong>x{hiLoMultiplier.toFixed(2)}</strong>
                    </div>
                    <div className="roulette-summary__row">
                      <span>Collect now</span>
                      <strong>{hiLoStreak > 0 ? formatPoints(hiLoCashOutAmount) : '$0'}</strong>
                    </div>
                    {hiLoGuess ? (
                      <div className="roulette-summary__row">
                        <span>Last guess</span>
                        <strong>{hiLoGuess === 'higher' ? 'Higher' : 'Lower'}</strong>
                      </div>
                    ) : null}
                  </div>
                  {!hiLoCurrentCard || hiLoResult ? (
                    <button
                      type="button"
                      className="action-button action-button--primary roulette-stage__spin"
                      onClick={handleStartHiLo}
                      disabled={!canPlaceBets || bet > bankroll}
                    >
                      {hiLoResult ? 'Start Next Round' : 'Reveal First Card'}
                    </button>
                  ) : (
                    <div className="action-row action-row--trio hilo-guess">
                      <button
                        type="button"
                        className="action-button action-button--primary"
                        onClick={() => {
                          handleGuessHiLo('higher')
                        }}
                        disabled={hiLoOdds.higherStepMultiplier <= 0 || hiLoResolving}
                      >
                        <span className="hilo-guess__label">
                          <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 4l7 9H3z" fill="currentColor" /></svg>
                          Higher
                        </span>
                        <small>
                          {hiLoOdds.higherStepMultiplier > 0
                            ? `${Math.round(hiLoOdds.higherProbability * 100)}% · x${(hiLoMultiplier * hiLoOdds.higherStepMultiplier).toFixed(2)}`
                            : 'No outs'}
                        </small>
                      </button>
                      <button
                        type="button"
                        className="action-button action-button--primary"
                        onClick={() => {
                          handleGuessHiLo('lower')
                        }}
                        disabled={hiLoOdds.lowerStepMultiplier <= 0 || hiLoResolving}
                      >
                        <span className="hilo-guess__label">
                          <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 16L3 7h14z" fill="currentColor" /></svg>
                          Lower
                        </span>
                        <small>
                          {hiLoOdds.lowerStepMultiplier > 0
                            ? `${Math.round(hiLoOdds.lowerProbability * 100)}% · x${(hiLoMultiplier * hiLoOdds.lowerStepMultiplier).toFixed(2)}`
                            : 'No outs'}
                        </small>
                      </button>
                      <button
                        type="button"
                        className="action-button action-button--cashout"
                        onClick={handleCashOutHiLo}
                        disabled={hiLoStreak === 0 || hiLoResolving}
                      >
                        <span>Collect</span>
                        <small>{hiLoStreak > 0 ? formatPoints(hiLoCashOutAmount) : '$0'}</small>
                      </button>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
            </section>
            )}
          </div>
        </div>
      {devModePromptOpen ? (
        <div className="poker-modal">
          <div className="poker-modal__card poker-modal__card--dev">
            <p className="bet-panel__label">Developer Access</p>
            <h3>Sign in with Google</h3>
            <p className="roulette-stage__status dev-auth__note">
              Developer mode is only for {DEVELOPER_EMAIL}.
            </p>
            {devModeError ? <p className="bet-panel__error">{devModeError}</p> : null}
            <div className="poker-modal__actions">
              <button
                type="button"
                className="action-button action-button--primary dev-auth__google"
                onClick={handleDeveloperSignIn}
                disabled={devModeVerifying}
                autoFocus
              >
                <GoogleMark />
                {devModeVerifying ? 'Waiting for Google…' : 'Continue with Google'}
              </button>
              <button
                type="button"
                className="action-button"
                onClick={() => {
                  setDevModePromptOpen(false)
                  setDevModeError('')
                  setDevModeVerifying(false)
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {casinoStatsResetPromptOpen ? (
        <div className="poker-modal">
          <div className="poker-modal__card poker-modal__card--dev">
            <p className="bet-panel__label">Reset Statistics</p>
            <h3>Sign in to reset {casinoStatsResetScopeLabel}</h3>
            <p className="roulette-stage__status dev-auth__note">
              Only {DEVELOPER_EMAIL} can reset statistics.
            </p>
            {casinoStatsResetError ? <p className="bet-panel__error">{casinoStatsResetError}</p> : null}
            <div className="poker-modal__actions">
              <button
                type="button"
                className="action-button action-button--primary dev-auth__google"
                onClick={handleVerifyCasinoStatsReset}
                disabled={casinoStatsResetVerifying}
                autoFocus
              >
                <GoogleMark />
                {casinoStatsResetVerifying ? 'Waiting for Google…' : 'Continue with Google'}
              </button>
              <button
                type="button"
                className="action-button"
                onClick={handleCancelCasinoStatsReset}
                disabled={casinoStatsResetVerifying}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {casinoStatsResetConfirmOpen ? (
        <div className="poker-modal">
          <div className="poker-modal__card poker-modal__card--dev">
            <p className="bet-panel__label">Confirm Reset</p>
            <h3>Delete {casinoStatsResetScopeLabel.toLowerCase()} historical statistics?</h3>
            <p className="roulette-stage__status">
              This will permanently remove the saved statistics history for {casinoStatsResetScopeLabel}.
            </p>
            <div className="poker-modal__actions">
              <button
                type="button"
                className="action-button action-button--primary"
                onClick={handleConfirmCasinoStatsReset}
              >
                Confirm Reset
              </button>
              <button
                type="button"
                className="action-button"
                onClick={handleCancelCasinoStatsReset}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </main>
  )
}

export default App
