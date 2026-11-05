// Texas Hold'em table rules, shared by the page (for display: amount to call,
// blind seats, chip stacks) and the game server (which runs every action).
// Each action is a pure function: (room, actor, ...) -> next room or an error.
import { type Card, createShuffledDeck, drawCards, MIN_BET } from './casino'
import { randomInt } from './random'

export type PokerSeat = {
  id: string
  name: string
}

export type PokerStreet = 'preflop' | 'flop' | 'turn' | 'river' | 'showdown'

export type PokerPlayerState = {
  chips: number
  holeCards: Card[]
  folded: boolean
  allIn: boolean
  committed: number
  acted: boolean
}

export type PokerContribution = {
  playerId: string
  amount: number
}

export type PokerActionType = 'start' | 'blind' | 'check' | 'call' | 'raise' | 'fold' | 'street' | 'showdown'

export type PokerGameState = {
  // identifies one deal; each player's private cards carry the same id
  handId?: number
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

export type PokerPendingStart = {
  buyIn: number
  playerIds: string[]
  confirmedPlayerIds: string[]
}

export type PokerRoomState = {
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
  // everyone's stack as the current hand was dealt (before blinds); if a table
  // is closed mid-hand, the hand is voided and these are what get returned
  handStartChips?: Record<string, number> | null
}

export type PokerResult = { room: PokerRoomState } | { error: string }

export const POKER_SEAT_COUNT = 6
export const DEFAULT_SMALL_BLIND = 5
export const DEFAULT_BIG_BLIND = 10

const POKER_CHIP_DENOMINATIONS = [
  { value: 500, color: 'purple' },
  { value: 100, color: 'black' },
  { value: 25, color: 'green' },
  { value: 10, color: 'blue' },
  { value: 5, color: 'red' },
  { value: 1, color: 'white' },
] as const

export const createPokerRoomCode = () =>
  Array.from({ length: 4 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[randomInt(32)]).join('')

export const getPokerRoomMessage = (playerCount: number) =>
  playerCount >= 2
    ? 'Enough players are seated to start.'
    : `Waiting for ${2 - playerCount} more player${2 - playerCount === 1 ? '' : 's'} to join before the game can start.`

// ---------- hand strength ----------

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

export const comparePokerScores = (left: number[], right: number[]) => {
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

export const evaluateBestPokerHand = (cards: Card[]) => {
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

// ---------- seats and blinds ----------

const getOccupiedPokerSeatIndexes = (seats: (PokerSeat | null)[]) =>
  seats.reduce<number[]>((indexes, seat, index) => {
    if (seat) {
      indexes.push(index)
    }

    return indexes
  }, [])

export const getNextPokerSeatIndex = (
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

export const getPokerBlindSeatIndexes = (
  seats: (PokerSeat | null)[],
  dealerSeatIndex: number,
  players: Record<string, PokerPlayerState>,
) => {
  const occupiedIndexes = getOccupiedPokerSeatIndexes(seats)

  if (dealerSeatIndex < 0 || occupiedIndexes.length === 0) {
    return { smallBlindSeatIndex: -1, bigBlindSeatIndex: -1 }
  }

  if (occupiedIndexes.length === 2) {
    return {
      smallBlindSeatIndex: dealerSeatIndex,
      bigBlindSeatIndex: getNextPokerSeatIndex(seats, dealerSeatIndex, (seat) => Boolean(seat && players[seat.id])),
    }
  }

  const smallBlindSeatIndex = getNextPokerSeatIndex(seats, dealerSeatIndex, (seat) => Boolean(seat && players[seat.id]))
  const bigBlindSeatIndex =
    occupiedIndexes.length > 2
      ? getNextPokerSeatIndex(seats, smallBlindSeatIndex, (seat) => Boolean(seat && players[seat.id]))
      : smallBlindSeatIndex

  return { smallBlindSeatIndex, bigBlindSeatIndex }
}

export const getPokerAmountToCall = ({
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

export const getPokerChipTokens = (amount: number) => {
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

// ---------- hand flow ----------

export const startPokerHand = (room: PokerRoomState): PokerRoomState => {
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

  const { smallBlindSeatIndex, bigBlindSeatIndex } = getPokerBlindSeatIndexes(room.seats, nextDealerSeatIndex, players)

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
    pendingStart: null,
    handStartChips: Object.fromEntries(
      room.seats.filter(Boolean).map((seat) => [seat!.id, room.playerChips[seat!.id] ?? 0]),
    ),
    game: {
      handId: (room.game?.actionId ?? 0) + 1,
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
          ? [
              {
                playerId: room.seats[smallBlindSeatIndex]!.id,
                amount: Math.min(room.smallBlind, room.playerChips[room.seats[smallBlindSeatIndex]!.id] ?? 0),
              },
            ]
          : []),
        ...(bigBlindSeatIndex !== -1 && room.seats[bigBlindSeatIndex]
          ? [
              {
                playerId: room.seats[bigBlindSeatIndex]!.id,
                amount: Math.min(room.bigBlind, room.playerChips[room.seats[bigBlindSeatIndex]!.id] ?? 0),
              },
            ]
          : []),
      ].filter((entry) => entry.amount > 0),
      lastAction: `Blinds posted: small blind $${room.smallBlind}, big blind $${room.bigBlind}.`,
      winnerMessage: null,
    },
  }
}

// After a pot is paid, every player's in-hand stack matches their table stack,
// so the seat badges and "Your markers" show the winnings straight away.
const settleHandChips = (players: Record<string, PokerPlayerState>, playerChips: Record<string, number>) =>
  Object.fromEntries(
    Object.entries(players).map(([playerId, player]) => [
      playerId,
      { ...player, chips: playerChips[playerId] ?? player.chips },
    ]),
  ) as Record<string, PokerPlayerState>

// Splits the pot into a main pot and side pots. Each player can only win, from
// each other player, as much as they put in themselves: someone all-in for $50
// can win $50 from each caller, and anything bet above that is a side pot for
// the players who covered it. A part only one player covered goes back to them.
export const buildPokerPots = (room: PokerRoomState, showdownIds: string[]) => {
  const game = room.game!
  const start = room.handStartChips ?? {}
  const contributions = Object.entries(game.players).map(([playerId, player]) => ({
    playerId,
    amount: Math.max(0, (start[playerId] ?? player.chips) - player.chips),
  }))
  const total = contributions.reduce((sum, entry) => sum + entry.amount, 0)

  // without the starting stacks (a hand from before this existed) fall back to
  // one pot for everyone still in
  if (total !== game.pot || !room.handStartChips) {
    return [{ amount: game.pot, eligibleIds: showdownIds }]
  }

  const levels = Array.from(
    new Set(contributions.filter((entry) => showdownIds.includes(entry.playerId)).map((entry) => entry.amount)),
  ).sort((left, right) => left - right)
  const pots: { amount: number; eligibleIds: string[] }[] = []
  let previous = 0

  levels.forEach((level, index) => {
    const isTop = index === levels.length - 1
    // the top pot also takes anything folded players put in above every level
    const amount = contributions.reduce(
      (sum, entry) => sum + (isTop ? Math.max(0, entry.amount - previous) : Math.max(0, Math.min(entry.amount, level) - previous)),
      0,
    )
    const eligibleIds = showdownIds.filter((playerId) =>
      contributions.some((entry) => entry.playerId === playerId && entry.amount >= level),
    )
    if (amount > 0) {
      pots.push({ amount, eligibleIds })
    }
    previous = level
  })

  return pots.length > 0 ? pots : [{ amount: game.pot, eligibleIds: showdownIds }]
}

const resolvePokerShowdown = (room: PokerRoomState): PokerRoomState => {
  if (!room.game) {
    return room
  }

  const game = room.game
  const eligibleSeats = room.seats
    .map((seat, index) => ({ seat, index }))
    .filter(({ seat }) => seat && game.players[seat.id] && !game.players[seat.id].folded) as {
    seat: PokerSeat
    index: number
  }[]

  const scores = eligibleSeats.map(({ seat }) => ({
    seat,
    score: evaluateBestPokerHand([...game.communityCards, ...game.players[seat.id].holeCards]),
  }))

  const pots = buildPokerPots(room, scores.map(({ seat }) => seat.id))
  const nextPlayerChips = { ...room.playerChips }
  const potWinners: { amount: number; winners: PokerSeat[] }[] = []

  pots.forEach((pot) => {
    const contenders = scores.filter((entry) => pot.eligibleIds.includes(entry.seat.id))
    const bestScore = contenders.reduce<number[]>(
      (best, entry) => (comparePokerScores(entry.score, best) > 0 ? entry.score : best),
      [-1],
    )
    const winners = contenders.filter((entry) => comparePokerScores(entry.score, bestScore) === 0)
    const splitAmount = Math.floor(pot.amount / winners.length)
    const remainder = pot.amount % winners.length

    winners.forEach((winner, index) => {
      nextPlayerChips[winner.seat.id] =
        (nextPlayerChips[winner.seat.id] ?? room.buyIn) + splitAmount + (index === 0 ? remainder : 0)
    })
    potWinners.push({ amount: pot.amount, winners: winners.map((entry) => entry.seat) })
  })

  const names = (seats: PokerSeat[]) => seats.map((seat) => seat.name).join(' and ')
  const describePot = ({ amount, winners }: { amount: number; winners: PokerSeat[] }, label: string) =>
    winners.length === 1 ? `${winners[0].name} wins ${label} of $${amount}.` : `${names(winners)} split ${label} of $${amount}.`
  // a pot only one player could win is just their own uncalled bet coming back
  const contested = potWinners.filter((entry, index) => index === 0 || pots[index].eligibleIds.length > 1)
  const winnerMessage =
    contested.length === 1
      ? describePot(contested[0], 'the pot')
      : contested.map((entry, index) => describePot(entry, index === 0 ? 'the main pot' : `side pot ${index}`)).join(' ')
  const allWinners = new Set(potWinners.flatMap((entry) => entry.winners.map((seat) => seat.id)))
  const winners = scores.filter((entry) => allWinners.has(entry.seat.id))

  return {
    ...room,
    playerChips: nextPlayerChips,
    handStartChips: null,
    game: {
      ...game,
      players: settleHandChips(game.players, nextPlayerChips),
      street: 'showdown',
      activeSeatIndex: -1,
      actionId: game.actionId + 1,
      lastActorId: winners.length === 1 ? winners[0].seat.id : null,
      lastActionType: 'showdown' as PokerActionType,
      lastContributions: [],
      winnerMessage,
      lastAction: 'Hand complete.',
    },
  }
}

const advancePokerStreet = (room: PokerRoomState): PokerRoomState => {
  if (!room.game) {
    return room
  }

  const game = room.game
  const remainingPlayers = room.seats
    .map((seat) => (seat ? game.players[seat.id] : null))
    .filter(Boolean) as PokerPlayerState[]

  if (remainingPlayers.filter((player) => !player.folded).length <= 1) {
    const winningSeat = room.seats.find((seat) => seat && game.players[seat.id] && !game.players[seat.id].folded)

    if (!winningSeat) {
      return room
    }

    const nextPlayerChips = {
      ...room.playerChips,
      [winningSeat.id]: (room.playerChips[winningSeat.id] ?? room.buyIn) + game.pot,
    }

    return {
      ...room,
      playerChips: nextPlayerChips,
      handStartChips: null,
      game: {
        ...game,
        players: settleHandChips(game.players, nextPlayerChips),
        street: 'showdown',
        activeSeatIndex: -1,
        actionId: game.actionId + 1,
        lastActorId: winningSeat.id,
        lastActionType: 'showdown' as PokerActionType,
        lastContributions: [],
        winnerMessage: `${winningSeat.name} wins the pot of $${game.pot}.`,
        lastAction: 'Hand complete.',
      },
    }
  }

  const activePlayers = room.seats
    .map((seat, index) => ({ seat, index }))
    .filter(
      ({ seat }) => seat && game.players[seat.id] && !game.players[seat.id].folded && !game.players[seat.id].allIn,
    ) as { seat: PokerSeat; index: number }[]

  const everyoneMatched =
    activePlayers.length === 0 ||
    activePlayers.every(
      ({ seat }) => game.players[seat.id].acted && game.players[seat.id].committed === game.currentBet,
    )

  if (!everyoneMatched) {
    return room
  }

  let nextStreet: PokerStreet = game.street
  let cardsToDraw = 0

  if (game.street === 'preflop') {
    nextStreet = 'flop'
    cardsToDraw = 3
  } else if (game.street === 'flop') {
    nextStreet = 'turn'
    cardsToDraw = 1
  } else if (game.street === 'turn') {
    nextStreet = 'river'
    cardsToDraw = 1
  } else {
    return resolvePokerShowdown(room)
  }

  const { drawnCards, remainingDeck } = drawCards(game.deck, cardsToDraw)
  const nextPlayers = Object.fromEntries(
    Object.entries(game.players).map(([playerId, playerState]) => [
      playerId,
      { ...playerState, committed: 0, acted: playerState.allIn },
    ]),
  ) as Record<string, PokerPlayerState>
  const nextActiveSeatIndex = getNextPokerSeatIndex(room.seats, room.dealerSeatIndex, (seat) =>
    Boolean(seat && nextPlayers[seat.id] && !nextPlayers[seat.id].folded && !nextPlayers[seat.id].allIn),
  )

  const nextRoom: PokerRoomState = {
    ...room,
    game: {
      ...game,
      street: nextStreet,
      currentBet: 0,
      activeSeatIndex: nextActiveSeatIndex,
      communityCards: [...game.communityCards, ...drawnCards],
      deck: remainingDeck,
      players: nextPlayers,
      actionId: game.actionId + 1,
      // keep the action that closed the round, so everyone still sees it
      lastActorId: game.lastActorId,
      lastActionType: game.lastActorId ? game.lastActionType : ('street' as PokerActionType),
      lastContributions: game.lastContributions ?? [],
      lastAction: `${game.lastActorId ? `${game.lastAction} ` : ''}${nextStreet.charAt(0).toUpperCase()}${nextStreet.slice(1)} card(s) are out.`,
      winnerMessage: null,
    },
  }

  const allRemainingAreAllIn = room.seats.every((seat) => {
    if (!seat) {
      return true
    }

    const playerState = nextPlayers[seat.id]
    return !playerState || playerState.folded || playerState.allIn
  })

  return allRemainingAreAllIn ? advancePokerStreet(nextRoom) : nextRoom
}

// ---------- table actions ----------

const seatOf = (room: PokerRoomState, playerId: string) => {
  const index = room.seats.findIndex((seat) => seat?.id === playerId)
  return { index, seat: index === -1 ? null : room.seats[index] }
}

const withoutPlayer = (room: PokerRoomState, playerId: string, keepPendingPlayerIds: boolean) => {
  const nextSeats = room.seats.map((seat) => (seat?.id === playerId ? null : seat))
  const nextPlayerChips = { ...room.playerChips }
  delete nextPlayerChips[playerId]
  const remainingSeats = nextSeats.filter(Boolean) as PokerSeat[]
  const nextHostId = room.hostId === playerId ? remainingSeats[0]?.id ?? '' : room.hostId
  const nextPendingStart = room.pendingStart
    ? {
        ...room.pendingStart,
        playerIds: keepPendingPlayerIds
          ? room.pendingStart.playerIds
          : room.pendingStart.playerIds.filter((id) => id !== playerId),
        confirmedPlayerIds: room.pendingStart.confirmedPlayerIds.filter((id) => id !== playerId),
      }
    : null

  return { nextSeats, nextPlayerChips, remainingSeats, nextHostId, nextPendingStart }
}

export const createPokerRoom = (
  code: string,
  host: PokerSeat,
  buyIn: number,
  smallBlind: number,
): PokerRoomState => ({
  code,
  buyIn,
  smallBlind,
  bigBlind: smallBlind * 2,
  hostId: host.id,
  dealerSeatIndex: -1,
  playerChips: {},
  seats: Array.from({ length: POKER_SEAT_COUNT }, (_, index) => (index === 4 ? host : null)),
  game: null,
  pendingStart: null,
})

export const joinPokerRoom = (room: PokerRoomState, player: PokerSeat): PokerResult => {
  const existingSeatIndex = room.seats.findIndex((seat) => seat?.id === player.id)
  const nextOpenSeat = room.seats.findIndex((seat) => seat === null)

  if (existingSeatIndex === -1 && nextOpenSeat === -1) {
    return { error: 'That table is already full.' }
  }

  const seats = [...room.seats]
  seats[existingSeatIndex === -1 ? nextOpenSeat : existingSeatIndex] = player
  return { room: { ...room, seats } }
}

export const setPokerBuyIn = (room: PokerRoomState, actorId: string, buyIn: number): PokerResult => {
  if (room.hostId !== actorId) {
    return { error: 'Only the host can change the buy-in.' }
  }

  if (!Number.isFinite(buyIn) || buyIn < MIN_BET) {
    return { error: `Buy in must be at least $${MIN_BET}.` }
  }

  return { room: { ...room, buyIn: Math.round(buyIn) } }
}

export const setPokerBlinds = (room: PokerRoomState, actorId: string, smallBlind: number): PokerResult => {
  if (room.hostId !== actorId) {
    return { error: 'Only the host can change the blinds.' }
  }

  if (!Number.isFinite(smallBlind) || smallBlind <= 0) {
    return { error: 'Small blind must be greater than $0.' }
  }

  const rounded = Math.round(smallBlind)
  return { room: { ...room, smallBlind: rounded, bigBlind: rounded * 2 } }
}

export const requestPokerStart = (room: PokerRoomState, actorId: string): PokerResult => {
  if (room.hostId !== actorId || room.seats.filter(Boolean).length < 2) {
    return { error: 'Only the host can start the game once 2 or more players are seated.' }
  }

  if (room.game && room.game.street !== 'showdown') {
    return { error: 'Finish the current hand first.' }
  }

  const playersNeedingBuyIn = (room.seats.filter(Boolean) as PokerSeat[])
    .filter((seat) => (room.playerChips[seat.id] ?? 0) <= 0)
    .map((seat) => seat.id)

  if (playersNeedingBuyIn.length === 0) {
    return { room: startPokerHand(room) }
  }

  return {
    room: {
      ...room,
      game: null,
      pendingStart: { buyIn: room.buyIn, playerIds: playersNeedingBuyIn, confirmedPlayerIds: [] },
    },
  }
}

// `deposited` is true once the server has taken the buy-in out of the
// player's bankroll; false means they could not cover it and must leave.
export const confirmPokerBuyIn = (
  room: PokerRoomState,
  actorId: string,
  deposited: boolean,
): PokerResult & { removed?: boolean } => {
  const { seat } = seatOf(room, actorId)

  if (!room.pendingStart || !seat) {
    return { error: 'There is no buy-in to confirm.' }
  }

  const needsDeposit = (room.playerChips[actorId] ?? 0) <= 0

  if (needsDeposit && !deposited) {
    const { nextSeats, nextPlayerChips, remainingSeats, nextHostId, nextPendingStart } = withoutPlayer(
      room,
      actorId,
      false,
    )

    return {
      removed: true,
      room: {
        ...room,
        hostId: nextHostId,
        seats: nextSeats,
        playerChips: nextPlayerChips,
        pendingStart:
          remainingSeats.length >= 2 && nextPendingStart && nextPendingStart.playerIds.length > 0
            ? nextPendingStart
            : null,
        game: null,
      },
    }
  }

  const confirmedPlayerIds = room.pendingStart.confirmedPlayerIds.includes(actorId)
    ? room.pendingStart.confirmedPlayerIds
    : [...room.pendingStart.confirmedPlayerIds, actorId]
  const nextPlayerChips = { ...room.playerChips }

  if (needsDeposit) {
    nextPlayerChips[actorId] = room.pendingStart.buyIn
  }

  if (confirmedPlayerIds.length < room.pendingStart.playerIds.length) {
    return {
      room: { ...room, playerChips: nextPlayerChips, pendingStart: { ...room.pendingStart, confirmedPlayerIds } },
    }
  }

  return { room: startPokerHand({ ...room, playerChips: nextPlayerChips, pendingStart: null }) }
}

export const declinePokerBuyIn = (room: PokerRoomState, actorId: string): PokerResult => {
  const { seat } = seatOf(room, actorId)

  if (!seat) {
    return { error: 'You are not seated at this table.' }
  }

  const { nextSeats, nextPlayerChips, remainingSeats, nextHostId, nextPendingStart } = withoutPlayer(
    room,
    actorId,
    true,
  )

  return {
    room: {
      ...room,
      hostId: nextHostId,
      seats: nextSeats,
      playerChips: nextPlayerChips,
      pendingStart: remainingSeats.length >= 2 ? nextPendingStart : null,
      game: null,
    },
  }
}

// Leaving returns the player's remaining chips to their bankroll.
export const leavePokerTable = (
  room: PokerRoomState,
  actorId: string,
): { room: PokerRoomState; cashOut: number } | { error: string } => {
  const { seat } = seatOf(room, actorId)

  if (!seat) {
    return { error: 'You are not seated at this table.' }
  }

  if (room.game && room.game.street !== 'showdown') {
    return { error: 'You can leave after the current hand ends.' }
  }

  const cashOut = room.playerChips[actorId] ?? 0
  const { nextSeats, nextPlayerChips, remainingSeats, nextHostId, nextPendingStart } = withoutPlayer(
    room,
    actorId,
    false,
  )

  return {
    cashOut,
    room: {
      ...room,
      hostId: nextHostId,
      seats: nextSeats,
      playerChips: nextPlayerChips,
      pendingStart:
        remainingSeats.length >= 2 && nextPendingStart && nextPendingStart.playerIds.length > 0
          ? nextPendingStart
          : null,
      game: null,
    },
  }
}

const requireTurn = (room: PokerRoomState, actorId: string) => {
  const { index, seat } = seatOf(room, actorId)

  if (!room.game || room.game.street === 'showdown' || index === -1 || !seat || room.game.activeSeatIndex !== index) {
    return null
  }

  return { game: room.game, index, seat }
}

const nextActingSeat = (room: PokerRoomState, fromIndex: number, players: Record<string, PokerPlayerState>) =>
  getNextPokerSeatIndex(room.seats, fromIndex, (seat) =>
    Boolean(seat && players[seat.id] && !players[seat.id].folded && !players[seat.id].allIn),
  )

export const pokerFold = (room: PokerRoomState, actorId: string): PokerResult => {
  const turn = requireTurn(room, actorId)

  if (!turn) {
    return { error: 'It is not your turn.' }
  }

  const players = {
    ...turn.game.players,
    [actorId]: { ...turn.game.players[actorId], folded: true, acted: true },
  }

  return {
    room: advancePokerStreet({
      ...room,
      game: {
        ...turn.game,
        players,
        activeSeatIndex: nextActingSeat(room, turn.index, players),
        actionId: turn.game.actionId + 1,
        lastActorId: actorId,
        lastActionType: 'fold' as PokerActionType,
        lastContributions: [],
        lastAction: `${turn.seat.name} folds.`,
        winnerMessage: null,
      },
    }),
  }
}

export const pokerCallOrCheck = (room: PokerRoomState, actorId: string): PokerResult => {
  const turn = requireTurn(room, actorId)

  if (!turn) {
    return { error: 'It is not your turn.' }
  }

  const playerState = turn.game.players[actorId]
  const amountToCall = getPokerAmountToCall({
    seats: room.seats,
    dealerSeatIndex: room.dealerSeatIndex,
    players: turn.game.players,
    currentBet: turn.game.currentBet,
    street: turn.game.street,
    smallBlind: room.smallBlind,
    seatIndex: turn.index,
    seatId: actorId,
  })
  const payment = Math.min(amountToCall, playerState.chips)
  const players = {
    ...turn.game.players,
    [actorId]: {
      ...playerState,
      chips: playerState.chips - payment,
      committed: playerState.committed + payment,
      acted: true,
      allIn: playerState.chips === payment,
    },
  }

  return {
    room: advancePokerStreet({
      ...room,
      playerChips: { ...room.playerChips, [actorId]: playerState.chips - payment },
      game: {
        ...turn.game,
        pot: turn.game.pot + payment,
        players,
        activeSeatIndex: nextActingSeat(room, turn.index, players),
        actionId: turn.game.actionId + 1,
        lastActorId: actorId,
        lastActionType: (amountToCall > 0 ? 'call' : 'check') as PokerActionType,
        lastContributions: payment > 0 ? [{ playerId: actorId, amount: payment }] : [],
        lastAction: amountToCall > 0 ? `${turn.seat.name} calls $${payment}.` : `${turn.seat.name} checks.`,
        winnerMessage: null,
      },
    }),
  }
}

export const pokerRaise = (room: PokerRoomState, actorId: string, raiseTarget: number): PokerResult => {
  const turn = requireTurn(room, actorId)

  if (!turn) {
    return { error: 'It is not your turn.' }
  }

  if (!Number.isFinite(raiseTarget) || raiseTarget <= turn.game.currentBet) {
    return { error: 'Raise amount must be higher than the current bet.' }
  }

  const target = Math.round(raiseTarget)
  const playerState = turn.game.players[actorId]
  const additionalAmount = target - playerState.committed

  if (additionalAmount > playerState.chips) {
    return { error: 'You do not have enough markers for that raise.' }
  }

  const players = Object.fromEntries(
    Object.entries(turn.game.players).map(([playerId, state]) => [playerId, { ...state, acted: playerId === actorId }]),
  ) as Record<string, PokerPlayerState>
  players[actorId] = {
    ...players[actorId],
    chips: playerState.chips - additionalAmount,
    committed: target,
    allIn: playerState.chips === additionalAmount,
  }

  return {
    room: {
      ...room,
      playerChips: { ...room.playerChips, [actorId]: playerState.chips - additionalAmount },
      game: {
        ...turn.game,
        pot: turn.game.pot + additionalAmount,
        currentBet: target,
        players,
        activeSeatIndex: nextActingSeat(room, turn.index, players),
        actionId: turn.game.actionId + 1,
        lastActorId: actorId,
        lastActionType: 'raise' as PokerActionType,
        lastContributions: additionalAmount > 0 ? [{ playerId: actorId, amount: additionalAmount }] : [],
        lastAction: `${turn.seat.name} raises to $${target}.`,
        winnerMessage: null,
      },
    },
  }
}

// What everyone at the table may see: no deck, and hole cards only for hands
// still in at showdown. Each player gets their own cards separately.
export const publicPokerRoom = (room: PokerRoomState): PokerRoomState => {
  if (!room.game) {
    return room
  }

  const atShowdown = room.game.street === 'showdown'
  const players = Object.fromEntries(
    Object.entries(room.game.players).map(([playerId, player]) => [
      playerId,
      { ...player, holeCards: atShowdown && !player.folded ? player.holeCards : [] },
    ]),
  )

  return { ...room, game: { ...room.game, deck: [], players } }
}
