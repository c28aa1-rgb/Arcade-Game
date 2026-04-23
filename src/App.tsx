import { useEffect, useRef, useState, type SetStateAction } from 'react'
import { collection, deleteDoc, doc, getDoc, onSnapshot, setDoc } from 'firebase/firestore'
import { firebaseConfigError, firestore, isFirebaseConfigured } from './firebase'
import PlinkoBoard from './components/PlinkoBoard'

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
const SUITS = ['■', '●', '▲', '★']
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
type CasinoTrackedGame = 'blackjack' | 'roulette' | 'hilo' | 'mines' | 'plinko' | 'slots' | 'dice'

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
  `${suit === '■' || suit === '▲' ? 'playing-card__suit--red' : 'playing-card__suit--black'}${
    suit === '●' ? ' playing-card__suit--circle' : ''
  }`

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

  ;(['blackjack', 'roulette', 'hilo', 'mines', 'plinko', 'slots', 'dice'] as CasinoTrackedGame[]).forEach((entry) => {
    window.localStorage.removeItem(getCasinoGameDailyStatsStorageKey(entry))
  })
}

const aggregateCasinoDailyStatsFromGames = (statsByGame: Record<CasinoTrackedGame, CasinoDailyStat[]>) => {
  const totalsByDate = new Map<string, number>()

  ;(['blackjack', 'roulette', 'hilo', 'mines', 'plinko', 'slots', 'dice'] as CasinoTrackedGame[]).forEach((game) => {
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
const formatPoints = (value: number) => `${Math.round(value).toLocaleString()} pts`
const formatSignedPoints = (value: number) => {
  if (value === 0) {
    return '0 pts'
  }

  return `${value > 0 ? '+' : '-'}${Math.abs(Math.round(value)).toLocaleString()} pts`
}

const verifyDevAccessCode = async (code: string) => {
  const response = await fetch('/api/verify-dev-code', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ code }),
  })

  const payload = (await response.json().catch(() => null)) as { success?: boolean; error?: string } | null

  if (!response.ok || !payload?.success) {
    throw new Error(payload?.error || 'Unable to verify code')
  }
}

const getScoreChangeLabel = (value: number) =>
  value === 0 ? 'Score unchanged' : `Score ${formatSignedPoints(value)}`

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

const SLOT_SYMBOL_ICONS: Record<SlotRegularSymbol, string> = {
  dragon: '🐉',
  crown: '👑',
  gem: '💎',
  lotus: '🪷',
  moon: '🌙',
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

const createSlotsBonusSpinDisplayGrid = (
  currentGrid: (SlotCell | null)[][],
  betAmount: number,
): (SlotCell | null)[][] =>
  currentGrid.map((row) =>
    row.map((cell) => {
      if (cell) {
        return cell
      }

      return Math.random() < 0.3 ? getRandomSlotOrb(betAmount) : null
    }),
  )

const createSlotsBonusSpinTopRow = (betAmount: number): (SlotCell | null)[] =>
  Array.from({ length: SLOT_COLUMNS }, () => (Math.random() < 0.3 ? getRandomSlotOrb(betAmount) : null))

const resolveSlotsVisibleGrid = (grid: (SlotCell | null)[][]): SlotCell[][] =>
  grid.map((row, rowIndex) =>
    row.map(
      (cell, columnIndex) =>
        cell ?? {
          kind: 'symbol' as const,
          symbol: SLOT_SYMBOL_POOL[(columnIndex + rowIndex) % SLOT_SYMBOL_POOL.length],
        },
    ),
  )

const shiftSlotsGridDown = <T,>(grid: T[][], topRow: T[]): T[][] => [
  [...topRow],
  [...grid[0]],
  [...grid[1]],
]

const shiftSlotsGridDownWithStops = <T,>(grid: T[][], topRow: T[], stoppedColumns: boolean[]): T[][] =>
  Array.from({ length: SLOT_ROWS }, (_, rowIndex) =>
    Array.from({ length: SLOT_COLUMNS }, (_, columnIndex) => {
      if (stoppedColumns[columnIndex]) {
        return grid[rowIndex][columnIndex]
      }

      if (rowIndex === 0) {
        return topRow[columnIndex]
      }

      return grid[rowIndex - 1][columnIndex]
    }),
  )

const SLOTS_SPIN_TRAIL_LIMIT = Math.ceil(5000 / 140) + 2
const getRandomSlotsSpinSteps = () => 32 + Math.floor(Math.random() * 8)
const SLOTS_SPIN_BASE_STEP_MS = 90
const SLOTS_SPIN_SETTLE_BUFFER_MS = 40
const SLOTS_COLUMN_STOP_DELAYS_MS = [0, 1000, 1000, 1000, 3000]
const SLOTS_COLUMN_STOP_CUMULATIVE_MS = SLOTS_COLUMN_STOP_DELAYS_MS.reduce<number[]>(
  (delays, delay, index) => {
    delays.push(delay + (delays[index - 1] ?? 0))
    return delays
  },
  [],
)

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

  let multiplier = MINES_EDGE

  for (let index = 0; index < clampedSafePickCount; index += 1) {
    const remainingTiles = MINES_TILE_COUNT - index
    const remainingSafeTiles = remainingTiles - clampedMineCount
    const exactStepMultiplier = remainingTiles / remainingSafeTiles

    // Start with gentler growth, then converge toward the true risk curve
    // as the board gets thinner and each safe click becomes less likely.
    const progress = maxSafePicks > 1 ? index / (maxSafePicks - 1) : 1
    const currentMineRisk = clampedMineCount / remainingTiles
    const stepWeight = Math.min(1, 0.24 + progress * 0.5 + currentMineRisk * 1.25)
    const softenedStepMultiplier = 1 + (exactStepMultiplier - 1) * stepWeight

    multiplier *= softenedStepMultiplier
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
const DICE_MULTIPLIER_CURVE = [
  { winChance: 1, multiplier: 1.01 },
  { winChance: 0.999, multiplier: 1.02 },
  { winChance: 0.99, multiplier: 1.12 },
  { winChance: 0.95, multiplier: 1.45 },
  { winChance: 0.9, multiplier: 2.1 },
  { winChance: 0.8, multiplier: 3.8 },
  { winChance: 0.7, multiplier: 6.5 },
  { winChance: 0.6, multiplier: 9.5 },
  { winChance: 0.5, multiplier: 13.5 },
  { winChance: 0.4, multiplier: 20 },
  { winChance: 0.3, multiplier: 35 },
  { winChance: 0.2, multiplier: 70 },
  { winChance: 0.1, multiplier: 160 },
  { winChance: 0.05, multiplier: 300 },
  { winChance: 0.01, multiplier: 700 },
  { winChance: 0, multiplier: DICE_MAX_MULTIPLIER },
] as const

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

  for (let index = 0; index < DICE_MULTIPLIER_CURVE.length - 1; index += 1) {
    const upper = DICE_MULTIPLIER_CURVE[index]
    const lower = DICE_MULTIPLIER_CURVE[index + 1]

    if (winChance <= upper.winChance && winChance >= lower.winChance) {
      const span = upper.winChance - lower.winChance
      const ratio = span === 0 ? 0 : (upper.winChance - winChance) / span
      const interpolatedMultiplier = upper.multiplier + (lower.multiplier - upper.multiplier) * ratio
      return Number(interpolatedMultiplier.toFixed(2))
    }
  }

  return DICE_MAX_MULTIPLIER
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

  if (percent > 99.99) {
    return '>99.99%'
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

    if (playerTotal > 21) {
      summaries.push(`${label} goes over with ${playerTotal}.`)
      return
    }

    if (dealerTotal > 21) {
      summaries.push(`${label} clears it. Lead hand goes over with ${dealerTotal}.`)
      payout += wager * 2
      return
    }

    if (playerTotal > dealerTotal) {
      summaries.push(`${label} wins ${playerTotal} to ${dealerTotal}.`)
      payout += wager * 2
      return
    }

    if (playerTotal < dealerTotal) {
      summaries.push(`${label} loses ${playerTotal} to ${dealerTotal}.`)
      return
    }

    summaries.push(`${label} ties at ${playerTotal}.`)
    payout += wager
  })

  const totalWager = handBets.reduce((sum, wager) => sum + wager, 0)
  const delta = payout - totalWager

  return { message: summaries.join(' '), delta, payout }
}

function App() {
  const ROULETTE_SPIN_DURATION_MS = 7000
  const TRACKED_CASINO_GAMES: CasinoTrackedGame[] = ['blackjack', 'roulette', 'hilo', 'mines', 'plinko', 'slots', 'dice']
  const getCasinoTrackedGameLabel = (game: CasinoTrackedGame) =>
    ({
      blackjack: 'Twenty-One',
      roulette: 'Color Wheel',
      hilo: 'Up Down',
      mines: 'Safe Steps',
      plinko: 'Peg Drop',
      slots: 'Symbol Spin',
      dice: 'Dice Path',
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
  const [hiLoDeck, setHiLoDeck] = useState<Card[]>([])
  const [hiLoCurrentCard, setHiLoCurrentCard] = useState<Card | null>(null)
  const [hiLoUpcomingCard, setHiLoUpcomingCard] = useState<Card | null>(null)
  const [hiLoNextCard, setHiLoNextCard] = useState<Card | null>(null)
  const [hiLoGuess, setHiLoGuess] = useState<'higher' | 'lower' | null>(null)
  const [hiLoResult, setHiLoResult] = useState<RoundResult | null>(null)
  const [hiLoStreak, setHiLoStreak] = useState(0)
  const [hiLoMultiplier, setHiLoMultiplier] = useState(1)
  const [hiLoMessage, setHiLoMessage] = useState('Set your play amount, then reveal the first card.')
  const [hiLoResolving, setHiLoResolving] = useState(false)
  const [hiLoSliding, setHiLoSliding] = useState(false)
  const [minesBoard, setMinesBoard] = useState<MinesTile[]>([])
  const [minesCount, setMinesCount] = useState(DEFAULT_MINES_COUNT)
  const [minesCountInput, setMinesCountInput] = useState(String(DEFAULT_MINES_COUNT))
  const [minesSafePicks, setMinesSafePicks] = useState(0)
  const [minesResult, setMinesResult] = useState<RoundResult | null>(null)
  const [minesMessage, setMinesMessage] = useState('Set your play amount, then start the safe-step board.')
  const [minesRoundActive, setMinesRoundActive] = useState(false)
  const [pendingPlinkoDrops, setPendingPlinkoDrops] = useState<PendingPlinkoDrop[]>([])
  const [plinkoHistory, setPlinkoHistory] = useState<PlinkoRound[]>([])
  const [plinkoInFlightDrops, setPlinkoInFlightDrops] = useState(0)
  const [plinkoMessage, setPlinkoMessage] = useState('Set your play amount, then drop a ball down the board.')
  const [plinkoResult, setPlinkoResult] = useState<PlinkoRound | null>(null)
  const [plinkoWinStreak, setPlinkoWinStreak] = useState(0)
  const [slotsGrid, setSlotsGrid] = useState<SlotCell[][]>(() => createInitialSlotsGrid())
  const [slotsBonusGrid, setSlotsBonusGrid] = useState<(SlotCell | null)[][]>(() =>
    createSlotsBonusGridFromSpin(createInitialSlotsGrid()),
  )
  const [slotsMessage, setSlotsMessage] = useState('Set your play amount, then spin the reels.')
  const [slotsResult, setSlotsResult] = useState<RoundResult | null>(null)
  const [slotsSpinning, setSlotsSpinning] = useState(false)
  const [slotsStopping, setSlotsStopping] = useState(false)
  const [slotsSpinAnimationMs, setSlotsSpinAnimationMs] = useState(140)
  const [slotsStoppedColumns, setSlotsStoppedColumns] = useState<boolean[]>(
    () => Array.from({ length: SLOT_COLUMNS }, () => false),
  )
  const [slotsSpinTrailRows, setSlotsSpinTrailRows] = useState<(SlotCell | null)[][]>([])
  const [slotsSpinFromGrid, setSlotsSpinFromGrid] = useState<(SlotCell | null)[][] | null>(null)
  const [slotsSpinDisplayGrid, setSlotsSpinDisplayGrid] = useState<(SlotCell | null)[][] | null>(null)
  const [slotsSpinFrame, setSlotsSpinFrame] = useState(0)
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
  const [devModeInput, setDevModeInput] = useState('')
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
  const slotsSpinIntervalRef = useRef<number | null>(null)
  const slotsSpinDisplayGridRef = useRef<(SlotCell | null)[][] | null>(null)
  const slotsStoppedColumnsRef = useRef<boolean[]>(Array.from({ length: SLOT_COLUMNS }, () => false))
  const slotsSpinTrailRowsRef = useRef<(SlotCell | null)[][]>([])
  const slotsColumnStopTimeoutsRef = useRef<number[]>([])
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

  const syncRemotePlayerProfile = async (nextProfile: LocalPlayerProfile) => {
    const profileRef = getPlayerProfileDocRef(nextProfile.id)

    if (!profileRef) {
      return
    }

    try {
      await setDoc(profileRef, nextProfile)
    } catch (error) {
      console.error('Failed to sync player profile', error)
    }
  }

  const persistLocalPlayerProfile = (nextProfile: LocalPlayerProfile) => {
    writeLocalPlayerProfile(nextProfile)
    syncSettingsPlayers()
    void syncRemotePlayerProfile(nextProfile)

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
  const slotsAnimatedFromGrid = slotsSpinFromGrid ?? slotsSpinDisplayGrid ?? slotsBaseGrid
  const slotsAnimatedToGrid = slotsSpinDisplayGrid ?? slotsBaseGrid
  const slotsDisplayedColumns = Array.from({ length: SLOT_COLUMNS }, (_, columnIndex) => ({
    from: Array.from(
      { length: SLOT_ROWS },
      (_, rowIndex) => slotsAnimatedFromGrid[rowIndex]?.[columnIndex] ?? null,
    ),
    to: Array.from({ length: SLOT_ROWS }, (_, rowIndex) => slotsAnimatedToGrid[rowIndex]?.[columnIndex] ?? null),
  }))
  const getSlotsCellClassName = (cell: SlotCell | null) =>
    `slots-machine__reel${
      cell?.kind === 'orb' ? ' slots-machine__reel--orb' : ''
    }${cell?.kind === 'orb' && cell.jackpot ? ` slots-machine__reel--${cell.jackpot}` : ''}${
      slotsSpinning ? ' slots-machine__reel--spinning' : ''
    }${slotsBonusActive && !cell ? ' slots-machine__reel--empty' : ''}`;
  const getSlotsFallbackCell = (columnIndex: number, rowIndex: number): SlotCell => ({
    kind: 'symbol',
    symbol: SLOT_SYMBOL_POOL[(columnIndex + rowIndex) % SLOT_SYMBOL_POOL.length],
  })
  const getSlotsColumnTrackCells = (
    columnIndex: number,
    column: { from: (SlotCell | null)[]; to: (SlotCell | null)[] },
  ) => [
    column.to[0] ?? null,
    column.from[0] ?? null,
    column.from[1] ?? null,
    column.from[2] ?? null,
    ...slotsSpinTrailRows.map((row) => row[columnIndex] ?? null),
  ]
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

    return <span className="slots-machine__symbol-mark">{SLOT_SYMBOL_ICONS[displayCell.symbol]}</span>
  }

  useEffect(() => {
    slotsSpinDisplayGridRef.current = slotsSpinDisplayGrid
  }, [slotsSpinDisplayGrid])

  useEffect(() => {
    slotsStoppedColumnsRef.current = slotsStoppedColumns
  }, [slotsStoppedColumns])

  useEffect(() => {
    slotsSpinTrailRowsRef.current = slotsSpinTrailRows
  }, [slotsSpinTrailRows])

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
          setDevModeInput('')
          setDevModeError('')
          setDevModeVerifying(false)
          return
        }

        setDevModePromptOpen(true)
        setDevModeInput('')
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

  const handleSubmitDevModeCode = async () => {
    if (!devModeInput.trim()) {
      setDevModeError('Enter a code first')
      return
    }

    setDevModeVerifying(true)
    setDevModeError('')

    try {
      await verifyDevAccessCode(devModeInput.trim())
      setDevMode((currentMode) => !currentMode)
      setDevModePromptOpen(false)
      setDevModeInput('')
      setDevModeError('')
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to verify code'
      setDevModeError(message)
    } finally {
      setDevModeVerifying(false)
    }
  }

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
        }, 950)
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
      }, 880),
      window.setTimeout(() => {
        setPokerPotPulse(false)
      }, 640),
    ]
  }, [pokerGame, pokerSeats])

  useEffect(() => {
    if (!pokerGame || pokerGame.lastActionType !== 'check' || !pokerGame.lastActorId) {
      return
    }

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
    }, 3200)
  }, [pokerGame])

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

    if (slotsSpinIntervalRef.current) {
      window.clearTimeout(slotsSpinIntervalRef.current)
      slotsSpinIntervalRef.current = null
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
    setHiLoMessage('Set your play amount, then reveal the first card.')
    setMinesBoard([])
    setMinesSafePicks(0)
    setMinesCountInput(String(minesCount))
    setMinesResult(null)
    setMinesMessage('Set your bet, then start the minefield.')
    setMinesRoundActive(false)
    setPendingPlinkoDrops([])
    setPlinkoInFlightDrops(0)
    setPlinkoMessage('Set your bet, then drop a ball down the board.')
    setPlinkoResult(null)
    setSlotsGrid(createInitialSlotsGrid())
    setSlotsBonusGrid(createSlotsBonusGridFromSpin(createInitialSlotsGrid()))
    setSlotsMessage('Set your bet, then spin the reels.')
    setSlotsResult(null)
    setSlotsSpinning(false)
    setSlotsStopping(false)
    setSlotsSpinAnimationMs(140)
    setSlotsStoppedColumns(Array.from({ length: SLOT_COLUMNS }, () => false))
    setSlotsSpinTrailRows([])
    setSlotsSpinFromGrid(null)
    setSlotsSpinDisplayGrid(null)
    setSlotsSpinFrame(0)
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
      setBetInputError(`Play amount cannot be more than your score of ${formatPoints(bankroll)}.`)
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
      setBetInputError(`Play amount cannot be more than your score of ${formatPoints(bankroll)}.`)
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

  const handleSpinSlots = () => {
    if (slotsSpinning) {
      return
    }

    if (slotsBonusActive) {
      const currentBet = slotsBonusBet || bet
      const currentBonusGrid = slotsBonusGrid.map((row) => [...row])
      const initialBonusSpinGrid = shiftSlotsGridDown(
        currentBonusGrid,
        createSlotsBonusSpinTopRow(currentBet),
      )
      const bonusSpinSteps = getRandomSlotsSpinSteps()
      let completedSpinSteps = 1
      let stopSequenceStarted = false
      let finalized = false
      let stopSequenceStartedAt = 0
      setSlotsSpinning(true)
      setSlotsStopping(false)
      setSlotsSpinAnimationMs(SLOTS_SPIN_BASE_STEP_MS)
      setSlotsStoppedColumns(Array.from({ length: SLOT_COLUMNS }, () => false))
      setSlotsSpinTrailRows([])
      setSlotsSpinFromGrid(currentBonusGrid)
      setSlotsSpinDisplayGrid(initialBonusSpinGrid)
      setSlotsSpinFrame(1)
      setSlotsResult(null)
      setSlotsMessage(`Hold & spin in progress. ${slotsBonusRespins} respin${slotsBonusRespins === 1 ? '' : 's'} left.`)

      if (slotsSpinIntervalRef.current) {
        window.clearTimeout(slotsSpinIntervalRef.current)
      }
      slotsColumnStopTimeoutsRef.current.forEach((timeoutId) => {
        window.clearTimeout(timeoutId)
      })
      slotsColumnStopTimeoutsRef.current = []

      const runBonusSpinStep = (gridAtStep: (SlotCell | null)[][]) => {
        const stepDuration = SLOTS_SPIN_BASE_STEP_MS
        const now = Date.now()
        const nextStoppedColumns = stopSequenceStarted
          ? SLOTS_COLUMN_STOP_CUMULATIVE_MS.map((delay) => now - stopSequenceStartedAt >= delay)
          : Array.from({ length: SLOT_COLUMNS }, () => false)
        const nextTrailRows = [gridAtStep[2], ...slotsSpinTrailRowsRef.current].slice(
          0,
          SLOTS_SPIN_TRAIL_LIMIT,
        )
        const nextSpinGrid = shiftSlotsGridDownWithStops(
          gridAtStep,
          createSlotsBonusSpinTopRow(currentBet),
          nextStoppedColumns,
        )

        setSlotsStopping(stopSequenceStarted)
        setSlotsSpinAnimationMs(stepDuration)
        setSlotsSpinFromGrid(gridAtStep)
        setSlotsSpinTrailRows(nextTrailRows)
        setSlotsStoppedColumns(nextStoppedColumns)
        setSlotsSpinDisplayGrid(nextSpinGrid)
        setSlotsSpinFrame((currentFrame) => currentFrame + 1)
        completedSpinSteps += 1

        if (!stopSequenceStarted && completedSpinSteps >= bonusSpinSteps) {
          stopSequenceStarted = true
          stopSequenceStartedAt = Date.now()
          setSlotsStopping(true)
        }

        if (stopSequenceStarted && nextStoppedColumns.every(Boolean)) {
          if (finalized) {
            return
          }

          finalized = true
          slotsResolveTimeoutRef.current = window.setTimeout(() => {
            const finalGrid = (slotsSpinDisplayGridRef.current ?? nextSpinGrid) as (SlotCell | null)[][]
            const filledCount = finalGrid.flat().filter(Boolean).length
            const orbCount = finalGrid.flat().filter((cell) => cell?.kind === 'orb').length
            const nextRespins = orbCount >= 6 ? 3 : slotsBonusRespins - 1

            setSlotsBonusGrid(finalGrid)
            setSlotsSpinning(false)
            setSlotsStopping(false)
            setSlotsSpinAnimationMs(SLOTS_SPIN_BASE_STEP_MS)
            setSlotsStoppedColumns(Array.from({ length: SLOT_COLUMNS }, () => false))
            setSlotsSpinTrailRows([])
            setSlotsSpinFromGrid(null)
            setSlotsSpinDisplayGrid(null)
            setSlotsSpinFrame(0)

            if (filledCount === SLOT_ROWS * SLOT_COLUMNS || nextRespins <= 0) {
              const bonusPayout = calculateSlotsBonusPayout(finalGrid, currentBet)
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
              slotsResolveTimeoutRef.current = null
              return
            }

            setSlotsBonusRespins(nextRespins)
            setSlotsMessage(
              orbCount >= 6
                ? `${orbCount} orb${orbCount === 1 ? '' : 's'} landed. Respins reset to 3.`
                : `No new orb this spin. ${nextRespins} respin${nextRespins === 1 ? '' : 's'} left.`,
            )
            slotsResolveTimeoutRef.current = null
          }, stepDuration + SLOTS_SPIN_SETTLE_BUFFER_MS)
          return
        }

        slotsSpinIntervalRef.current = window.setTimeout(() => {
          runBonusSpinStep(nextSpinGrid)
        }, stepDuration)
      }

      slotsSpinIntervalRef.current = window.setTimeout(() => {
        runBonusSpinStep(initialBonusSpinGrid)
      }, SLOTS_SPIN_BASE_STEP_MS)

      return
    }

    if (!canPlaceBets) {
      setBetInputError('You are out of points.')
      return
    }

    if (bet > bankroll) {
      setBetInputError(`Play amount cannot be more than your score of ${formatPoints(bankroll)}.`)
      return
    }

    setBankroll((currentBankroll) => currentBankroll - bet)
    const initialSpinGrid = shiftSlotsGridDown(slotsGrid, createSlotsSpinTopRow(bet))
    const baseSpinSteps = getRandomSlotsSpinSteps()
    let completedSpinSteps = 1
    let stopSequenceStarted = false
    let finalized = false
    let stopSequenceStartedAt = 0
    setSlotsSpinning(true)
    setSlotsStopping(false)
    setSlotsSpinAnimationMs(SLOTS_SPIN_BASE_STEP_MS)
    setSlotsStoppedColumns(Array.from({ length: SLOT_COLUMNS }, () => false))
    setSlotsSpinTrailRows([])
    setSlotsSpinFromGrid(slotsGrid)
    setSlotsSpinDisplayGrid(initialSpinGrid)
    setSlotsSpinFrame(1)
    setSlotsResult(null)
    setSlotsBonusBasePayout(0)
    setSlotsBonusBet(0)
    setSlotsBonusGrid(createSlotsBonusGridFromSpin(createInitialSlotsGrid()))
    setSlotsMessage('Reels are spinning...')
    setBetInputError('')

    if (slotsSpinIntervalRef.current) {
      window.clearTimeout(slotsSpinIntervalRef.current)
    }
    slotsColumnStopTimeoutsRef.current.forEach((timeoutId) => {
      window.clearTimeout(timeoutId)
    })
    slotsColumnStopTimeoutsRef.current = []

    const runBaseSpinStep = (gridAtStep: SlotCell[][]) => {
        const stepDuration = SLOTS_SPIN_BASE_STEP_MS
        const now = Date.now()
        const nextStoppedColumns = stopSequenceStarted
          ? SLOTS_COLUMN_STOP_CUMULATIVE_MS.map((delay) => now - stopSequenceStartedAt >= delay)
          : Array.from({ length: SLOT_COLUMNS }, () => false)
        const nextTrailRows = [gridAtStep[2], ...slotsSpinTrailRowsRef.current].slice(
          0,
          SLOTS_SPIN_TRAIL_LIMIT,
        )
        const nextSpinGrid = shiftSlotsGridDownWithStops(
          gridAtStep,
          createSlotsSpinTopRow(bet),
          nextStoppedColumns,
        )

        setSlotsStopping(stopSequenceStarted)
        setSlotsSpinAnimationMs(stepDuration)
        setSlotsSpinFromGrid(gridAtStep)
        setSlotsSpinTrailRows(nextTrailRows)
        setSlotsStoppedColumns(nextStoppedColumns)
        setSlotsSpinDisplayGrid(nextSpinGrid)
        setSlotsSpinFrame((currentFrame) => currentFrame + 1)
        completedSpinSteps += 1

        if (!stopSequenceStarted && completedSpinSteps >= baseSpinSteps) {
          stopSequenceStarted = true
          stopSequenceStartedAt = Date.now()
          setSlotsStopping(true)
        }

        if (stopSequenceStarted && nextStoppedColumns.every(Boolean)) {
          if (finalized) {
            return
          }

          finalized = true
          slotsResolveTimeoutRef.current = window.setTimeout(() => {
            const settledGrid = (slotsSpinDisplayGridRef.current ?? nextSpinGrid) as SlotCell[][]
            const finalGrid = resolveSlotsVisibleGrid(settledGrid)
            const orbCount = countSlotsBonusSymbols(finalGrid)
            const { totalPayout, winningLines } = calculateSlotsLinePayout(finalGrid, bet)

            setSlotsGrid(finalGrid)
            setSlotsSpinning(false)
            setSlotsStopping(false)
            setSlotsSpinAnimationMs(SLOTS_SPIN_BASE_STEP_MS)
            setSlotsStoppedColumns(Array.from({ length: SLOT_COLUMNS }, () => false))
            setSlotsSpinTrailRows([])
            setSlotsSpinFromGrid(null)
            setSlotsSpinDisplayGrid(null)
            setSlotsSpinFrame(0)

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
              slotsResolveTimeoutRef.current = null
              return
            }

            const result: RoundResult = {
              message:
                totalPayout > 0
                  ? `${winningLines.join('. ')}.`
                  : 'No line hit this spin.',
              delta: totalPayout - bet,
              payout: totalPayout,
            }

            setSlotsResult(result)
            setSlotsMessage(
              totalPayout > 0 ? `${result.message} You win $${totalPayout}.` : 'No hit this time. Spin again.',
            )
            if (totalPayout > 0) {
              setBankroll((currentBankroll) => currentBankroll + result.payout)
            }
            applyPlayerDailyDelta(result.delta)
            applyCasinoDailyDelta(result.delta)
            applyCasinoGameDailyDelta('slots', result.delta)
            slotsResolveTimeoutRef.current = null
          }, stepDuration + SLOTS_SPIN_SETTLE_BUFFER_MS)
          return
        }

        slotsSpinIntervalRef.current = window.setTimeout(() => {
          runBaseSpinStep(nextSpinGrid)
        }, stepDuration)
      }

    slotsSpinIntervalRef.current = window.setTimeout(() => {
      runBaseSpinStep(initialSpinGrid)
    }, SLOTS_SPIN_BASE_STEP_MS)
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

    const profileRef = getPlayerProfileDocRef(selectedSettingsPlayer.id)

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
    if (!casinoStatsResetInput.trim()) {
      setCasinoStatsResetError('Enter a code first')
      return
    }

    setCasinoStatsResetVerifying(true)
    setCasinoStatsResetError('')

    try {
      await verifyDevAccessCode(casinoStatsResetInput.trim())
      setCasinoStatsResetPromptOpen(false)
      setCasinoStatsResetConfirmOpen(true)
      setCasinoStatsResetInput('')
      setCasinoStatsResetError('')
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to verify code'
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
      setBetInputError(`Play amount cannot be more than your score of ${formatPoints(bankroll)}.`)
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
    setPendingPlinkoDrops((currentDrops) => {
      const settledDrop = currentDrops.find((drop) => drop.id === dropId)

      if (!settledDrop) {
        return currentDrops
      }

      const multiplier = PLINKO_MULTIPLIERS[slotIndex]
      const payout = roundMoney(settledDrop.bet * multiplier)
      const net = roundMoney(payout - settledDrop.bet)
      const round: PlinkoRound = {
        id: dropId,
        bet: settledDrop.bet,
        slotIndex,
        multiplier,
        payout,
        net,
      }

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

      return currentDrops.filter((drop) => drop.id !== dropId)
    })
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
      setBetInputError(`Entry points cannot be more than your score of ${formatPoints(bankroll)}.`)
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
      setBetInputError('Small marker must be greater than 0 pts.')
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
        lastActorId: room.game.lastActionType === 'check' ? room.game.lastActorId : null,
        lastActionType:
          room.game.lastActionType === 'check'
            ? ('check' as PokerActionType)
            : ('street' as PokerActionType),
        lastContributions: [],
        lastAction: `${nextStreet.charAt(0).toUpperCase()}${nextStreet.slice(1)} card(s) are out.`,
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
      setBetInputError('You do not have enough score to start another play.')
      return
    }

    setRouletteBets((currentBets) => {
      const existingBet = currentBets.find((entry) => isSameRouletteBet(entry.bet, nextBet))

      if (existingBet) {
        return currentBets.filter((entry) => entry.id !== existingBet.id)
      }

      const nextTotal = currentBets.reduce((sum, entry) => sum + entry.amount, 0) + MIN_BET

      if (nextTotal > bankroll) {
        setBetInputError(`Total wheel picks cannot be more than your score of ${formatPoints(bankroll)}.`)
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
      setBetInputError(`Total wheel picks cannot be more than your score of ${formatPoints(bankroll)}.`)
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
    setRouletteBallAngle(
      (currentRotation) => {
        const currentNormalized = normalizeRotation(currentRotation)
        const delta = normalizeRotation(targetRotation - currentNormalized)
        return currentRotation + 1080 + delta
      },
    )
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
      setBetInputError(`Play amount cannot be more than your score of ${formatPoints(bankroll)}.`)
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

    setHiLoGuess(guess)
    setHiLoNextCard(nextCard)
    setHiLoResolving(true)
    setHiLoSliding(false)

    hiLoResolveTimeoutRef.current = window.setTimeout(() => {
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
      }, 420)
    }, 700)
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
      setBetInputError(`Play amount cannot be more than your score of ${formatPoints(bankroll)}.`)
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
        tile.isMine || tile.id === tileId ? { ...tile, revealed: true } : tile,
      )
      const result: RoundResult = {
        message: 'Hazard hit. The whole play is gone.',
        delta: -bet,
        payout: 0,
      }

      setMinesBoard(nextBoard)
      setMinesResult(result)
      setMinesRoundActive(false)
      setMinesMessage('Hazard hit. Start another round to try again.')
      applyPlayerDailyDelta(result.delta)
      applyCasinoDailyDelta(result.delta)
      applyCasinoGameDailyDelta('mines', result.delta)
      return
    }

    const nextBoard = minesBoard.map((tile) =>
      tile.id === tileId ? { ...tile, revealed: true } : tile,
    )
    const nextSafePicks = minesSafePicks + 1
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
      setBetInputError(`Play amount cannot be more than your score of ${formatPoints(bankroll)}.`)
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
          <section className="hero">
            <div className="hero__glow hero__glow--left" />
            <div className="hero__glow hero__glow--right" />
            <div className="hero__inner">
              <header className="hero__header">
                <div>
                  <p className="eyebrow">Lumex Arcade</p>
                </div>
              </header>
            </div>
            <div className="balance-pill">
              <div className="balance-pill__inner">
                <span className="balance-pill__label">Score</span>
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
                    {formatPoints(bankroll)}
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

          <div className={`shell${selectedGame === 'lobby' ? ' shell--with-sidepanels' : ''}`}>
            {selectedGame === 'lobby' ? (
              <aside className="leaderboard-panel" aria-label="Leaderboard">
                <p className="bet-panel__label">Leaderboard</p>
                <h3>Top Scores</h3>
                <div className="leaderboard-list">
                  {leaderboardPlayers.map((profile, index) => (
                    <article className="leaderboard-row" key={profile.id}>
                      <span className="leaderboard-row__rank">{index + 1}</span>
                      <strong>{profile.name || 'Unnamed player'}</strong>
                      <span>{formatPoints(profile.bankroll)}</span>
                    </article>
                  ))}
                  <article className="leaderboard-row leaderboard-row--you">
                    <span className="leaderboard-row__rank">You</span>
                    <strong>{playerProfile.name || 'Unnamed player'}</strong>
                    <span>{formatPoints(bankroll)}</span>
                  </article>
                </div>
              </aside>
            ) : null}
            {selectedGame === 'lobby' ? (
              <aside className="daily-reward-panel" aria-label="Daily bonus">
                <p className="bet-panel__label">Daily Bonus</p>
                <h3>{canClaimDailyReward ? 'Ready to collect' : 'Collected today'}</h3>
                <div className="daily-reward-panel__streak">
                  <span>Streak</span>
                  <strong>{activeDailyRewardStreak} day{activeDailyRewardStreak === 1 ? '' : 's'}</strong>
                </div>
                {canClaimDailyReward ? (
                  <button
                    type="button"
                    className="action-button action-button--primary daily-reward-panel__button"
                    onClick={handleClaimDailyReward}
                  >
                    {`Collect ${formatPoints(nextDailyRewardAmount)}`}
                  </button>
                ) : null}
                <div className="daily-reward-list">
                  {dailyRewardDays.map((entry) => (
                    <article
                      className={`daily-reward-row${entry.current ? ' daily-reward-row--current' : ''}${
                        entry.claimed ? ' daily-reward-row--claimed' : ''
                      }`}
                      key={entry.dayNumber}
                    >
                      <span>
                        Day {entry.dayNumber}
                        {entry.claimed ? <em className="daily-reward-row__check">Claimed</em> : null}
                      </span>
                      <strong>{formatPoints(entry.reward)}</strong>
                    </article>
                  ))}
                </div>
              </aside>
            ) : null}
            <section
              className={`games-panel${selectedGame === 'poker' ? ' games-panel--poker' : ''}`}
              aria-label="Games"
            >
          <div className="games-panel__header">
            <div>
              <p className="eyebrow">Games</p>
              <h2>
                {selectedGame === 'blackjack'
                  ? 'Twenty-One'
                  : selectedGame === 'options'
                    ? 'Options'
                  : selectedGame === 'roulette'
                    ? 'Color Wheel'
                    : selectedGame === 'poker'
                      ? 'Table Match'
                    : selectedGame === 'mines'
                      ? 'Safe Steps'
                    : selectedGame === 'hilo'
                      ? 'Up Down'
                    : selectedGame === 'dice'
                        ? 'Dice Path'
                      : selectedGame === 'slots'
                        ? 'Symbol Spin'
                      : selectedGame === 'plinko'
                        ? 'Peg Drop'
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
            {selectedGame !== 'lobby' ? (
              <button
                type="button"
                className="status-badge status-badge--button"
                onClick={handleBackToGames}
              >
                Back to games
              </button>
            ) : (
              <span className="status-badge">Pick a challenge</span>
            )}
          </div>

          {selectedGame === 'lobby' ? (
            <div className="game-grid">
              <button
                type="button"
                className="game-card game-card--active"
                onClick={handleOpenBlackjack}
              >
                <span className="game-card__eyebrow">Target 21</span>
                <strong>Twenty-One</strong>
                <span className="game-card__copy">
                  Build a hand toward 21, choose hit or stand, and try to finish closer than the lead hand.
                </span>
              </button>
              <button
                type="button"
                className="game-card game-card--roulette"
                onClick={handleOpenRoulette}
              >
                <span className="game-card__eyebrow">Color Track</span>
                <strong>Color Wheel</strong>
                <span className="game-card__copy">
                  Pick colors, ranges, or exact spaces, then watch the wheel settle on a target.
                </span>
              </button>
              <button
                type="button"
                className="game-card game-card--hilo"
                onClick={handleOpenHiLo}
              >
                <span className="game-card__eyebrow">Prediction Run</span>
                <strong>Up Down</strong>
                <span className="game-card__copy">
                  Predict whether the next shape is higher or lower, then bank your run before it breaks.
                </span>
              </button>
              <button
                type="button"
                className="game-card game-card--mines"
                onClick={handleOpenMines}
              >
                <span className="game-card__eyebrow">Safe Path</span>
                <strong>Safe Steps</strong>
                <span className="game-card__copy">
                  Open safe tiles on the 5x5 board, grow your score multiplier, and avoid hidden hazards.
                </span>
              </button>
              <button
                type="button"
                className="game-card game-card--poker"
                onClick={handleOpenPoker}
              >
                <span className="game-card__eyebrow">Shared Match</span>
                <strong>Table Match</strong>
                <span className="game-card__copy">
                  Create a room or join by code and take turns building the best shared hand with friends.
                </span>
              </button>
              <button
                type="button"
                className="game-card game-card--dice"
                onClick={handleOpenDice}
              >
                <span className="game-card__eyebrow">20 Dice Run</span>
                <strong>Dice Path</strong>
                <span className="game-card__copy">
                  Set a target from 20 to 120, pick over or under, and roll all 20 dice at once.
                </span>
              </button>
              <button
                type="button"
                className="game-card game-card--slots"
                onClick={handleOpenSlots}
              >
                <span className="game-card__eyebrow">Orb Bonus</span>
                <strong>Symbol Spin</strong>
                <span className="game-card__copy">
                  Spin the 5-reel board, match symbol lines, and trigger the orb bonus round.
                </span>
              </button>
              <button
                type="button"
                className="game-card game-card--plinko"
                onClick={handleOpenPlinko}
              >
                <span className="game-card__eyebrow">Peg Drop</span>
                <strong>Peg Drop</strong>
                <span className="game-card__copy">
                  Send tokens through the peg board and aim for the stronger multiplier lanes at the edges.
                </span>
              </button>
              <button
                type="button"
                className="game-card game-card--options"
                onClick={handleOpenOptions}
              >
                <span className="game-card__eyebrow">Profile & Stats</span>
                <strong>Options</strong>
                <span className="game-card__copy">
                  Manage your player profile, start-screen preferences, and personal statistics.
                </span>
              </button>
              {devMode ? (
                <button
                  type="button"
                  className="game-card game-card--settings"
                  onClick={handleOpenSettings}
                >
                  <span className="game-card__eyebrow">Developer Tools</span>
                  <strong>Dev Options</strong>
                  <span className="game-card__copy">
                    Open internal tools for player controls, statistics, and debugging features.
                  </span>
                </button>
              ) : null}
            </div>
          ) : selectedGame === 'options' ? (
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
                          <span>Score</span>
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
                              : '0 pts'}
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
                          <span>Score</span>
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

                      <p className="bet-panel__label settings-player-detail__label">Score</p>
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
                            placeholder="Set score"
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
                      aria-label="Roll lower"
                    >
                      ←
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
                      aria-label="Roll higher"
                    >
                      →
                    </button>
                  </div>

                  <div className="dice-board__row">
                    {diceBottomRow.map((value, index) =>
                      renderAnimatedDiceFace(value, `bottom-${index}`, diceRolling, diceRollFrame),
                    )}
                  </div>
                </div>

                <div className="round-result round-result--roulette dice-result">
                  <strong>{diceTotal !== null ? `Total ${diceTotal}` : 'Roll to reveal the total.'}</strong>
                  <span>
                    {diceResult
                      ? `Net ${formatSignedPoints(diceResult.delta)}`
                      : `${Math.round(diceWinChance * 1000) / 10}% to score at x${diceMultiplier.toFixed(2)}`}
                  </span>
                </div>
              </div>

              <div className="roulette-panel">
                <div className="roulette-panel__card">
                  <p className="bet-panel__label">Dice Path</p>
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
                      <span>Current play</span>
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
                    <p className="bet-panel__label">Violet Loop</p>
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
                    {slotsBonusActive ? 'Orb Bonus' : 'Lumex Arcade Symbol Spin'}
                  </div>
                  <div className="slots-machine__window">
                    {slotsDisplayedColumns.map((columnCells, columnIndex) => (
                      <div className="slots-machine__column" key={columnIndex}>
                        {slotsSpinning && !slotsStoppedColumns[columnIndex] ? (
                          <div
                            className="slots-machine__column-scroll"
                            key={`${columnIndex}-${slotsSpinFrame}`}
                            style={
                              {
                                animationDuration: `${slotsSpinAnimationMs}ms`,
                              }
                            }
                            >
                            <div className="slots-machine__column-track">
                              {getSlotsColumnTrackCells(columnIndex, columnCells).map((cell, rowIndex) => {
                                const displayCell = cell ?? getSlotsFallbackCell(columnIndex, rowIndex)

                                return (
                                <div className={getSlotsCellClassName(displayCell)} key={`track-${columnIndex}-${rowIndex}`}>
                                  {renderSlotsCellContent(displayCell)}
                                </div>
                                )
                              })}
                            </div>
                          </div>
                        ) : (
                          <div className="slots-machine__column-face">
                            {columnCells.to.map((cell, rowIndex) => {
                              const displayCell = cell ?? getSlotsFallbackCell(columnIndex, rowIndex)

                              return (
                              <div className={getSlotsCellClassName(displayCell)} key={`rest-${columnIndex}-${rowIndex}`}>
                                {renderSlotsCellContent(displayCell)}
                              </div>
                              )
                            })}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                  {slotsBonusActive ? (
                    <div className="slots-machine__bonus-banner">
                      <strong>{slotsBonusRespins} Free Bonus Respins</strong>
                      <span>No extra play amount is needed while the bonus is active.</span>
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
                  <p className="bet-panel__label">Violet Loop</p>
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
                      <span>Current play</span>
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
                              : '0 pts'}
                        </strong>
                      </div>
                    ) : null}
                  </div>
                </div>
              </div>
            </div>
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
                  <p className="bet-panel__label">Peg Drop</p>
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
                      <span>Current play</span>
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
                            <span>Play {formatPoints(round.bet)}</span>
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
                        <strong>{plinkoResult ? formatPoints(plinkoResult.payout) : '0 pts'}</strong>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          ) : selectedGame === 'blackjack' ? (
            <div className="blackjack-table">
              <div className="blackjack-table__felt">
                <div className="table-spot table-spot--dealer">
                  <span className="table-spot__label">Lead Hand</span>
                  <div className="card-row">
                    {dealerHand.length === 0 ? (
                      <div className="empty-seat">Waiting to start</div>
                    ) : (
                      dealerHand.map((card, index) =>
                        index === 1 && !dealerRevealed && !devMode ? (
                          <div className="playing-card playing-card--back" key="dealer-hidden" />
                        ) : (
                          <div className="playing-card" key={`${card.rank}-${card.suit}-${index}`}>
                            <span>{card.rank}</span>
                            <small className={getSuitColorClass(card.suit)}>{card.suit}</small>
                          </div>
                        ),
                      )
                    )}
                  </div>
                </div>

                <div className="table-center">
                  <p className="table-center__title">Lumex Arcade Twenty-One</p>
                  <p className="table-center__rules">Reach 21 without going over</p>
                  <p className="table-center__rules">Face cards count as 10</p>
                  {roundResult ? (
                    <div className="round-result">
                      <strong>{roundResult.message}</strong>
                      <span>{getScoreChangeLabel(roundResult.delta)}</span>
                    </div>
                  ) : null}
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
                              >
                                <span>{card.rank}</span>
                                <small className={getSuitColorClass(card.suit)}>{card.suit}</small>
                              </div>
                            ))}
                          </div>
                          <div className="player-hand__meta">
                            <span>{playerHands.length > 1 ? `Hand ${index + 1}` : 'Main Hand'}</span>
                            <strong>
                              {getHandValue(hand)} • Play {formatPoints(handBets[index] ?? bet)}
                            </strong>
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                  <div className="bet-ring">
                    <span>{playerHands.length > 1 ? 'Total Play' : 'Current Play'}</span>
                    <strong>{formatPoints(playerHands.length > 0 ? totalWager : bet)}</strong>
                  </div>
                </div>
              </div>

              <div className="blackjack-controls">
                <div className="bet-panel">
                  <p className="bet-panel__label">Play Amount</p>
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
                        Set play
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
                      {dealerRevealed ? 'Start Next Round' : 'Start Round'}
                    </button>
                  ) : (
                    <>
                      <button type="button" className="action-button" onClick={handleHit}>
                        Draw
                      </button>
                      <button type="button" className="action-button" onClick={handleStand}>
                        Hold
                      </button>
                      <button
                        type="button"
                        className="action-button"
                        onClick={handleDouble}
                        disabled={!canDouble}
                      >
                        Boost
                      </button>
                      {canSplit && (
                        <button type="button" className="action-button" onClick={handleSplit}>
                          Divide
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
                    <p className="bet-panel__label">Color Wheel</p>
                    <p className="roulette-stage__status">
                      {rouletteIsSpinning
                        ? 'Wheel is spinning...'
                        : rouletteWinningNumber !== null
                          ? `Last landing spot: ${rouletteWinningNumber}`
                          : 'Pick one or more targets, then spin'}
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

                <div className="roulette-wheel">
                  <div
                    className="roulette-wheel__outer"
                    style={{
                      backgroundImage: ROULETTE_WHEEL_GRADIENT,
                    }}
                  >
                    {ROULETTE_WHEEL_ORDER.map((value: RoulettePocket, index) => {
                      const sliceSize = 360 / ROULETTE_WHEEL_ORDER.length
                      const angle = sliceSize * index + sliceSize / 2
                      return (
                        <button
                          type="button"
                          className={`roulette-wheel__number ${
                            value === 0 || value === '00'
                              ? 'roulette-wheel__number--green'
                              : ROULETTE_RED_NUMBERS.has(String(value))
                                ? 'roulette-wheel__number--red'
                                : 'roulette-wheel__number--black'
                          } ${
                            rouletteBets.some(
                              (entry) => entry.bet.kind === 'number' && entry.bet.value === value,
                            )
                              ? 'roulette-wheel__number--selected'
                              : ''
                          } ${
                            rouletteWinningNumber === value
                              ? 'roulette-wheel__number--winning'
                              : ''
                          }`}
                          key={value}
                          onClick={() => {
                            handleSelectRouletteBet({ kind: 'number', value })
                          }}
                          disabled={rouletteIsSpinning}
                          style={{
                            transform: `translate(-50%, -50%) rotate(${angle}deg) translateY(-138px) rotate(0deg)`,
                          }}
                        >
                          {value}
                        </button>
                      )
                    })}
                    <div className="roulette-wheel__center" />
                  </div>
                  <div
                    className="roulette-wheel__ball"
                    style={{
                      transform: `translate(-50%, -50%) rotate(${rouletteBallAngle}deg) translateY(-150px)`,
                    }}
                  />
                </div>

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
                    <span>Straight Up / 0 / 00</span>
                    <strong>35:1</strong>
                  </div>
                  <div className="roulette-payouts__item">
                    <span>Rows</span>
                    <strong>2:1</strong>
                  </div>
                  <div className="roulette-payouts__item">
                    <span>1st 3rd / 2nd 3rd / 3rd 3rd</span>
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
                    <span>1st Half / 2nd Half</span>
                    <strong>1:1</strong>
                  </div>
                </div>
              </div>

              <div className="roulette-panel">
                <div className="roulette-panel__card">
                  {rouletteBets.length > 0 ? (
                    <>
                      <p className="bet-panel__label">Wheel Picks</p>
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
                              🗑
                            </button>
                            <p className="bet-panel__label">Wheel Pick</p>
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
                                        `Total wheel picks cannot be more than your score of ${formatPoints(bankroll)}.`,
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
                                <span>Current play</span>
                                <strong>{formatPoints(entry.amount)}</strong>
                              </div>
                            </div>
                          </article>
                        ))}
                      </div>
                      {betInputError ? <p className="bet-panel__error">{betInputError}</p> : null}
                      <div className="roulette-summary">
                        <div className="roulette-summary__row">
                          <span>Total play</span>
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
                      <p className="bet-panel__label">Color Wheel</p>
                      <h3>Build your pick list</h3>
                      <p className="roulette-panel__copy">
                        Click any number, or pick Red, Black, Odd, Even, 1-18, or 19-36. Each
                        click adds a new pick card here, and every card can have its own play amount.
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
                    <p className="bet-panel__label">Safe Steps Grid</p>
                    <p className="roulette-stage__status">{minesMessage}</p>
                  </div>
                </div>

                <div className="mines-board">
                  {minesBoard.length > 0 ? (
                    minesBoard.map((tile) => (
                      <button
                        type="button"
                        key={tile.id}
                        className={`mines-cell ${
                          tile.revealed
                            ? tile.isMine
                              ? 'mines-cell--mine'
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
                            {tile.isMine ? 'HAZARD' : `x${minesMultiplier.toFixed(2)}`}
                          </span>
                        ) : devMode && tile.isMine ? (
                          <span className="mines-cell__content mines-cell__content--dev-mine">
                            HAZARD
                          </span>
                        ) : (
                          <span className="mines-cell__cover" />
                        )}
                      </button>
                    ))
                  ) : (
                    <div className="mines-board__empty">
                      Start a round to load the 5x5 field.
                    </div>
                  )}
                </div>

                {minesResult ? (
                  <div className="round-result round-result--roulette">
                    <strong>{minesResult.message}</strong>
                    <span>
                      {getScoreChangeLabel(minesResult.delta)}
                    </span>
                  </div>
                ) : null}
              </div>

              <div className="roulette-panel">
                <div className="roulette-panel__card">
                  <p className="bet-panel__label">Safe Steps</p>
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
                        Set Hazards
                      </button>
                    </div>
                  </div>
                  {betInputError ? <p className="bet-panel__error">{betInputError}</p> : null}
                  <div className="roulette-summary">
                    <div className="roulette-summary__row">
                      <span>Current play</span>
                      <strong>{formatPoints(bet)}</strong>
                    </div>
                    <div className="roulette-summary__row">
                      <span>Hazards</span>
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
                      <strong>{minesSafePicks > 0 ? formatPoints(minesCashOutAmount) : '0 pts'}</strong>
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
                    <p className="bet-panel__label">{pokerScreen === 'table' ? 'Table Match' : 'Match Lobby'}</p>
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

                      <div className="poker-felt">
                        {pokerPotAnimations.map((animation) => (
                          <div
                            className={`poker-pot-animation poker-pot-animation--seat-${animation.seatIndex + 1}${
                              pokerGame?.communityCards.length ? ' poker-pot-animation--board' : ' poker-pot-animation--preboard'
                            }`}
                            key={animation.id}
                          >
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
                                            <div className="playing-card poker-seat__card" key={`${seat.id}-${index}`}>
                                              <span>{card.rank}</span>
                                              <small className={getSuitColorClass(card.suit)}>{card.suit}</small>
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
                          <p className="table-center__title">Shape Match</p>
                          <p className="table-center__rules">
                            {pokerGame
                              ? `Center ${formatPoints(pokerGame.pot)} • Current play ${formatPoints(pokerGame.currentBet)}`
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
                                    <span>{card.rank}</span>
                                    <small className={getSuitColorClass(card.suit)}>{card.suit}</small>
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
                              <div className="playing-card poker-your-hand__card" key={`you-${index}`}>
                                <span>{card.rank}</span>
                                <small className={getSuitColorClass(card.suit)}>{card.suit}</small>
                              </div>
                            ))}
                          </div>
                        </div>
                      ) : null}

                      {!pokerGame ? (
                        <>
                          <div className="poker-buyin poker-blinds">
                            <p className="bet-panel__label">Start Markers</p>
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
                                    <span>Small marker</span>
                                    <strong>{formatPoints(pokerSmallBlind)}</strong>
                                  </div>
                                  <div className="roulette-summary__row">
                                    <span>Big marker</span>
                                    <strong>{formatPoints(pokerBigBlind)}</strong>
                                  </div>
                                </div>
                              </>
                            ) : (
                              <div className="roulette-summary poker-buyin__summary">
                                <div className="roulette-summary__row">
                                  <span>Small marker</span>
                                  <strong>{formatPoints(pokerSmallBlind)}</strong>
                                </div>
                                <div className="roulette-summary__row">
                                  <span>Big marker</span>
                                  <strong>{formatPoints(pokerBigBlind)}</strong>
                                </div>
                              </div>
                            )}
                          </div>

                          <div className="poker-buyin">
                            <p className="bet-panel__label">Entry Points</p>
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
                              <span>Score</span>
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
                                <p className="poker-controls__raise-label">Set next play amount</p>
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
                                  Enter the total play amount you want to make.
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
                    <p className="bet-panel__label">Entry Confirm</p>
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
                    <p className="bet-panel__label">Entry Error</p>
                    <h3>Not enough points</h3>
                    <p className="roulette-panel__copy">
                      You did not have enough score to cover the table entry, so you were sent
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
                    <p className="bet-panel__label">Up Down Board</p>
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
                        <span>{hiLoCurrentCard.rank}</span>
                        <small className={getSuitColorClass(hiLoCurrentCard.suit)}>{hiLoCurrentCard.suit}</small>
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
                            <span>{hiLoUpcomingCard.rank}</span>
                            <small className={getSuitColorClass(hiLoUpcomingCard.suit)}>
                              {hiLoUpcomingCard.suit}
                            </small>
                          </div>
                        ) : (
                          <div className="playing-card playing-card--back hilo-card hilo-card--base" />
                        )}
                        {hiLoNextCard ? (
                          <div className={`playing-card hilo-card hilo-card--overlay${hiLoSliding ? ' hilo-card--slide' : ''}`}>
                            <span>{hiLoNextCard.rank}</span>
                            <small className={getSuitColorClass(hiLoNextCard.suit)}>{hiLoNextCard.suit}</small>
                          </div>
                        ) : null}
                      </div>
                    ) : (
                      <div className="empty-seat">Hidden</div>
                    )}
                  </div>
                </div>

                {hiLoResult ? (
                  <div className="round-result round-result--roulette">
                    <strong>{hiLoResult.message}</strong>
                    <span>
                      {getScoreChangeLabel(hiLoResult.delta)}
                    </span>
                  </div>
                ) : null}
              </div>

              <div className="roulette-panel">
                <div className="roulette-panel__card">
                  <p className="bet-panel__label">Up Down</p>
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
                        Set play
                      </button>
                    </div>
                  </div>
                  {betInputError ? <p className="bet-panel__error">{betInputError}</p> : null}
                  <div className="roulette-summary">
                    <div className="roulette-summary__row">
                      <span>Current play</span>
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
                      <strong>{hiLoStreak > 0 ? formatPoints(hiLoCashOutAmount) : '0 pts'}</strong>
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
                    <div className="action-row action-row--trio">
                      <button
                        type="button"
                        className="action-button action-button--primary"
                        onClick={() => {
                          handleGuessHiLo('higher')
                        }}
                        disabled={hiLoOdds.higherStepMultiplier <= 0 || hiLoResolving}
                      >
                        <span>Higher</span>
                        <small>
                          {hiLoOdds.higherStepMultiplier > 0
                            ? `x${(hiLoMultiplier * hiLoOdds.higherStepMultiplier).toFixed(2)}`
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
                        <span>Lower</span>
                        <small>
                          {hiLoOdds.lowerStepMultiplier > 0
                            ? `x${(hiLoMultiplier * hiLoOdds.lowerStepMultiplier).toFixed(2)}`
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
                        <small>{hiLoStreak > 0 ? formatPoints(hiLoCashOutAmount) : '0 pts'}</small>
                      </button>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
            </section>
          </div>
        </div>
      {devModePromptOpen ? (
        <div className="poker-modal">
          <div className="poker-modal__card poker-modal__card--dev">
            <p className="bet-panel__label">Developer Access</p>
            <h3>Enter access code</h3>
            <div className="bet-entry poker-modal__entry">
              <div className="bet-entry__form">
                <input
                  type="password"
                  value={devModeInput}
                  onChange={(event) => {
                    setDevModeInput(event.target.value)
                    setDevModeError('')
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      handleSubmitDevModeCode()
                    }

                    if (event.key === 'Escape') {
                      setDevModePromptOpen(false)
                      setDevModeInput('')
                      setDevModeError('')
                      setDevModeVerifying(false)
                    }
                  }}
                  placeholder="Enter code"
                  autoFocus
                />
              </div>
            </div>
            {devModeError ? <p className="bet-panel__error">{devModeError}</p> : null}
            <div className="poker-modal__actions">
              <button
                type="button"
                className="action-button action-button--primary"
                onClick={handleSubmitDevModeCode}
                disabled={devModeVerifying}
              >
                {devModeVerifying ? 'Checking...' : 'Confirm'}
              </button>
              <button
                type="button"
                className="action-button"
                onClick={() => {
                  setDevModePromptOpen(false)
                  setDevModeInput('')
                  setDevModeError('')
                  setDevModeVerifying(false)
                }}
                disabled={devModeVerifying}
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
            <h3>Enter dev password for {casinoStatsResetScopeLabel}</h3>
            <div className="bet-entry poker-modal__entry">
              <div className="bet-entry__form">
                <input
                  type="password"
                  value={casinoStatsResetInput}
                  onChange={(event) => {
                    setCasinoStatsResetInput(event.target.value)
                    setCasinoStatsResetError('')
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      handleVerifyCasinoStatsReset()
                    }

                    if (event.key === 'Escape') {
                      handleCancelCasinoStatsReset()
                    }
                  }}
                  placeholder="Enter code"
                  autoFocus
                />
              </div>
            </div>
            {casinoStatsResetError ? <p className="bet-panel__error">{casinoStatsResetError}</p> : null}
            <div className="poker-modal__actions">
              <button
                type="button"
                className="action-button action-button--primary"
                onClick={handleVerifyCasinoStatsReset}
                disabled={casinoStatsResetVerifying}
              >
                {casinoStatsResetVerifying ? 'Checking...' : 'Continue'}
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
