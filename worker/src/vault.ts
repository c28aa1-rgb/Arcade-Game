// One PlayerVault per player: the only place their money can change. It owns
// the balance, the daily-bonus streak and any game in progress (blackjack
// hand, hi-lo deck, mines board, chicken run, slots bonus), so hidden state
// like mine positions and upcoming cards never reaches the browser.
//
// Requests for one player are handled one at a time, so two quick bets can
// never spend the same money twice.
import { DurableObject } from 'cloudflare:workers'
import {
  BANKROLL,
  type Card,
  type DiceMode,
  type RouletteBet,
  type RoundResult,
  type SlotCell,
  calculateSlotsBonusPayout,
  calculateSlotsLinePayout,
  clampDiceTarget,
  countSlotsBonusSymbols,
  BLACKJACK_MAX_HANDS,
  BLACKJACK_RESHUFFLE_AT,
  createBlackjackShoe,
  createMineIds,
  createShuffledDeck,
  createSlotsBonusGridFromSpin,
  createSlotsFinalGrid,
  drawCards,
  drawRandomCard,
  finishDealerHand,
  floorMultiplier,
  getDailyRewardState,
  getDateKeyDistance,
  getDiceMultiplier,
  getDiceTotal,
  getHandValue,
  getHiLoOdds,
  getHiLoValue,
  getMinesMultiplier,
  getRoundResult,
  isBlackjackNatural,
  isDateKey,
  isValidRouletteBet,
  MIN_BET,
  MINES_MAX_COUNT,
  MINES_MIN_COUNT,
  MINES_TILE_COUNT,
  normalizeBankroll,
  PLINKO_MULTIPLIERS,
  PLINKO_ROWS,
  removeCardFromDeck,
  respinSlotsBonusGrid,
  rollTwentyDice,
  roundMoney,
  settleRouletteBets,
  SLOT_BONUS_TRIGGER,
  SLOT_COLUMNS,
  SLOT_ROWS,
  spinRoulettePocket,
} from '../../src/shared/casino'
import { randomSeed, seededRandom } from '../../src/shared/random'
import { CHICKEN_LANES, type ChickenDifficulty, getChickenConfig, rollChickenHop } from '../../src/components/chickenLogic'
import { generateFlight, JET_SPEEDS, type JetSpeed } from '../../src/components/jetstreamLogic'
import { simulateSlot } from '../../src/components/plinkoPhysics'
import { commitWrites, type Env, getDocument } from './firestore'

export type Caller = { playerId: string; uid: string; isDeveloper: boolean }

type BlackjackRound = {
  playerHands: Card[][]
  handBets: number[]
  completedHands: boolean[]
  activeHandIndex: number
  dealerHand: Card[]
}

type HiLoRound = { bet: number; deck: Card[]; current: Card; upcoming: Card | null; streak: number; multiplier: number }
type MinesRound = { bet: number; mineCount: number; mineIds: number[]; revealed: number[] }
type ChickenRun = { bet: number; difficulty: ChickenDifficulty; lane: number }
type SlotsBonus = { bet: number; basePayout: number; grid: (SlotCell | null)[][]; respins: number }

type VaultState = {
  playerId: string
  ownerUid: string
  balance: number
  dailyStreak: number
  lastDailyClaim: string | null
  plinkoWinStreak: number
  blackjackDeck: Card[]
  blackjack?: BlackjackRound
  hilo?: HiLoRound
  mines?: MinesRound
  chicken?: ChickenRun
  slots?: SlotsBonus
}

type OpenGame = 'blackjack' | 'hilo' | 'mines' | 'chicken' | 'slots'

export type VaultResponse = { ok: true; balance: number; [key: string]: unknown } | { ok: false; error: string; balance?: number }

class VaultError extends Error {}

const fail = (message: string): never => {
  throw new VaultError(message)
}

const HIDDEN_CARD: Card = { rank: '', suit: '' }

// The daily bonus runs on New York time, decided here and not by the
// browser: accepting the browser's date (even within a day) let a player claim
// "yesterday", "today" and "tomorrow" back to back.
const todayKeyNewYork = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(
    new Date(),
  )

const LEADERBOARD_SYNC_MS = 10_000
const RATE_WINDOW_MS = 10_000
const RATE_LIMIT = 25

export class PlayerVault extends DurableObject<Env> {
  private state: VaultState | null = null
  private recentRequests: number[] = []

  // ---------- plumbing ----------

  private async load(caller: Caller): Promise<VaultState> {
    if (!this.state) {
      this.state = (await this.ctx.storage.get<VaultState>('state')) ?? null
    }

    if (!this.state) {
      // First visit to the server: pick up the player's existing record.
      const record = await getDocument(this.env, `players/${caller.playerId}`)
      const recordOwner = typeof record?.ownerUid === 'string' ? record.ownerUid : ''
      if (recordOwner && recordOwner !== caller.uid && !caller.isDeveloper) {
        fail('This player belongs to a different browser.')
      }
      this.state = {
        playerId: caller.playerId,
        // a developer edit never claims someone else's player
        ownerUid: recordOwner || (caller.isDeveloper ? '' : caller.uid),
        balance: normalizeBankroll(typeof record?.bankroll === 'number' ? record.bankroll : BANKROLL),
        dailyStreak: typeof record?.dailyRewardStreak === 'number' ? record.dailyRewardStreak : 0,
        lastDailyClaim: isDateKey(record?.lastDailyRewardClaimDate) ? record.lastDailyRewardClaimDate : null,
        plinkoWinStreak: 0,
        blackjackDeck: [],
      }
      await this.save(this.state)
    }

    if (!this.state.ownerUid && !caller.isDeveloper) {
      // an unclaimed record belongs to the first browser that plays it
      this.state = { ...this.state, ownerUid: caller.uid }
      await this.save(this.state)
    }

    if (this.state.ownerUid !== caller.uid && !caller.isDeveloper) {
      fail('This player belongs to a different browser.')
    }

    return this.state
  }

  private async save(state: VaultState) {
    this.state = state
    await this.ctx.storage.put('state', state)
    // The leaderboard copy is written at most once per 10 seconds per player
    // (the latest numbers win), so a flood of bets can't burn through the
    // database's daily write allowance.
    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now() + LEADERBOARD_SYNC_MS)
    }
  }

  async alarm() {
    const state = this.state ?? (await this.ctx.storage.get<VaultState>('state')) ?? null
    if (!state) {
      return
    }
    try {
      await commitWrites(this.env, [
        {
          kind: 'merge',
          path: `players/${state.playerId}`,
          data: {
            bankroll: state.balance,
            ownerUid: state.ownerUid,
            dailyRewardStreak: state.dailyStreak,
            lastDailyRewardClaimDate: state.lastDailyClaim,
          },
        },
      ])
    } catch (error) {
      console.error('leaderboard sync failed; retrying', error)
      await this.ctx.storage.setAlarm(Date.now() + 60_000)
    }
  }

  // A person clicking plays a few rounds a second at most; a script firing
  // hundreds is turned away before it can use up the free daily limits.
  private checkRate() {
    const now = Date.now()
    this.recentRequests = this.recentRequests.filter((time) => now - time < RATE_WINDOW_MS)
    if (this.recentRequests.length >= RATE_LIMIT) {
      fail('Slow down a little and try again.')
    }
    this.recentRequests.push(now)
  }

  private requireBet(state: VaultState, bet: unknown) {
    const amount = Number(bet)
    if (!Number.isFinite(amount) || amount < MIN_BET) {
      fail(`Bet must be at least $${MIN_BET}.`)
    }
    if (amount > state.balance) {
      fail(`Bet cannot be more than your bankroll of $${state.balance.toLocaleString()}.`)
    }
    return roundMoney(amount)
  }

  // Runs one request start to finish before the next one is let in, on a copy
  // of the state, so a rejected bet never leaves half a change behind.
  private run(caller: Caller, action: (state: VaultState) => Record<string, unknown>): Promise<VaultResponse> {
    return this.ctx.blockConcurrencyWhile(async (): Promise<VaultResponse> => {
      try {
        this.checkRate()
        const state = await this.load(caller)
        const working: VaultState = structuredClone(state)
        const result = action(working)
        // balances are kept to the cent, so rounding can never be farmed
        working.balance = Math.max(0, roundMoney(working.balance))
        await this.save(working)
        return { ok: true, balance: working.balance, ...result }
      } catch (error) {
        // only the owner ever learns the balance, even on a rejected request
        const ownBalance =
          this.state && (this.state.ownerUid === caller.uid || caller.isDeveloper) ? this.state.balance : undefined
        if (error instanceof VaultError) {
          return { ok: false, error: error.message, balance: ownBalance }
        }
        console.error('vault error', error)
        return { ok: false, error: 'The table had a problem. Try again.', balance: ownBalance }
      }
    })
  }

  // ---------- session ----------

  // Just proves the caller owns this player (used before seating at poker).
  async authorize(caller: Caller): Promise<VaultResponse> {
    return this.ctx.blockConcurrencyWhile(async (): Promise<VaultResponse> => {
      try {
        this.checkRate()
        const state = await this.load(caller)
        return { ok: true, balance: state.balance }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : 'Unknown player.' }
      }
    })
  }

  // Called when the page loads: anything left open from a previous visit is
  // settled fairly first (cash out what was earned, stand on blackjack).
  async me(caller: Caller) {
    return this.run(caller, (state) => {
      const settled = (['blackjack', 'hilo', 'mines', 'chicken', 'slots'] as OpenGame[])
        .map((game) => this.settleOpen(state, game))
        .filter(Boolean)
      return {
        dailyStreak: state.dailyStreak,
        lastDailyClaim: state.lastDailyClaim,
        plinkoWinStreak: state.plinkoWinStreak,
        settled,
      }
    })
  }

  async leaveGame(caller: Caller, game: OpenGame) {
    return this.run(caller, (state) => ({ settled: this.settleOpen(state, game) }))
  }

  private settleOpen(state: VaultState, game: OpenGame): { game: OpenGame; payout: number } | null {
    if (game === 'hilo' && state.hilo) {
      const round = state.hilo
      state.hilo = undefined
      const payout = round.streak > 0 ? roundMoney(round.bet * round.multiplier) : 0
      state.balance += payout
      return { game, payout }
    }

    if (game === 'mines' && state.mines) {
      const round = state.mines
      state.mines = undefined
      const payout =
        round.revealed.length > 0 ? roundMoney(round.bet * getMinesMultiplier(round.revealed.length, round.mineCount)) : 0
      state.balance += payout
      return { game, payout }
    }

    if (game === 'chicken' && state.chicken) {
      const run = state.chicken
      state.chicken = undefined
      const payout =
        run.lane > 0 ? roundMoney(run.bet * getChickenConfig(run.difficulty).multipliers[run.lane - 1]) : 0
      state.balance += payout
      return { game, payout }
    }

    if (game === 'slots' && state.slots) {
      let bonus = state.slots
      while (true) {
        const { nextGrid, newOrbCount } = respinSlotsBonusGrid(bonus.grid, bonus.bet)
        const filled = nextGrid.flat().filter(Boolean).length
        const respins = newOrbCount > 0 ? 3 : bonus.respins - 1
        bonus = { ...bonus, grid: nextGrid, respins }
        if (filled === SLOT_ROWS * SLOT_COLUMNS || respins <= 0) {
          break
        }
      }
      state.slots = undefined
      const payout = calculateSlotsBonusPayout(bonus.grid, bonus.bet).totalPayout
      state.balance += payout
      return { game, payout }
    }

    if (game === 'blackjack' && state.blackjack) {
      // standing on every open hand is always a legal play
      const round = state.blackjack
      const resolved = this.resolveBlackjack(state, round.playerHands, round.handBets, round.completedHands.map(() => true))
      return { game, payout: (resolved.result as RoundResult).payout }
    }

    return null
  }

  async claimDaily(caller: Caller) {
    return this.run(caller, (state) => {
      const key = todayKeyNewYork()
      if (state.lastDailyClaim && getDateKeyDistance(key, state.lastDailyClaim) < 1) {
        fail('Already collected today. Come back tomorrow.')
      }
      const reward = getDailyRewardState(key, state.lastDailyClaim, state.dailyStreak)
      state.balance += reward.nextAmount
      state.dailyStreak = reward.nextDay
      state.lastDailyClaim = key
      return { amount: reward.nextAmount, dailyStreak: state.dailyStreak, lastDailyClaim: key }
    })
  }

  // ---------- one-shot games ----------

  async diceRoll(caller: Caller, params: { bet: unknown; mode: unknown; target: unknown }) {
    return this.run(caller, (state) => {
      const bet = this.requireBet(state, params.bet)
      const mode: DiceMode = params.mode === 'higher' ? 'higher' : 'lower'
      const target = clampDiceTarget(Number(params.target))
      const multiplier = getDiceMultiplier(target, mode)
      if (multiplier <= 0) {
        fail('That line cannot be bet. Keep the win chance between 0% and 98%.')
      }
      const values = rollTwentyDice()
      const total = getDiceTotal(values)
      const won = mode === 'lower' ? total < target : total > target
      const payout = won ? roundMoney(bet * multiplier) : 0
      state.balance += payout - bet
      return { values, total, won, payout, delta: payout - bet, target, mode, multiplier }
    })
  }

  async rouletteSpin(caller: Caller, params: { bets: unknown }) {
    return this.run(caller, (state) => {
      const slip = Array.isArray(params.bets) ? params.bets : []
      if (slip.length === 0 || slip.length > 60) {
        fail('Pick at least one roulette bet first.')
      }
      const bets = slip.map((entry) => {
        const candidate = entry as { bet?: unknown; amount?: unknown }
        const amount = Number(candidate.amount)
        if (!isValidRouletteBet(candidate.bet) || !Number.isFinite(amount) || amount < MIN_BET) {
          fail(`Each roulette bet must be at least $${MIN_BET}.`)
        }
        return { bet: candidate.bet as RouletteBet, amount: roundMoney(amount) }
      })
      const total = bets.reduce((sum, entry) => sum + entry.amount, 0)
      if (total > state.balance) {
        fail(`Total bets cannot be more than your bankroll of $${state.balance.toLocaleString()}.`)
      }
      const winningNumber = spinRoulettePocket()
      const result = settleRouletteBets(bets, winningNumber)
      state.balance += result.payout - total
      return { winningNumber, result, totalBet: total }
    })
  }

  async slotsSpin(caller: Caller, params: { bet: unknown }) {
    return this.run(caller, (state) => {
      if (state.slots) {
        fail('Finish your bonus respins first.')
      }
      const bet = this.requireBet(state, params.bet)
      const grid = createSlotsFinalGrid(bet)
      const orbCount = countSlotsBonusSymbols(grid)
      const { totalPayout, winningLines } = calculateSlotsLinePayout(grid, bet)
      state.balance += totalPayout - bet
      if (orbCount >= SLOT_BONUS_TRIGGER) {
        state.slots = { bet, basePayout: totalPayout, grid: createSlotsBonusGridFromSpin(grid), respins: 3 }
      }
      return {
        grid,
        orbCount,
        totalPayout,
        winningLines,
        bonus: state.slots ? { bet, basePayout: totalPayout, grid: state.slots.grid, respins: 3 } : null,
      }
    })
  }

  async slotsRespin(caller: Caller) {
    return this.run(caller, (state) => {
      const bonus = state.slots ?? fail('There is no bonus in progress.')
      const { nextGrid, newOrbCount } = respinSlotsBonusGrid(bonus.grid, bonus.bet)
      const filled = nextGrid.flat().filter(Boolean).length
      const respins = newOrbCount > 0 ? 3 : bonus.respins - 1

      if (filled === SLOT_ROWS * SLOT_COLUMNS || respins <= 0) {
        const bonusPayout = calculateSlotsBonusPayout(nextGrid, bonus.bet)
        state.balance += bonusPayout.totalPayout
        state.slots = undefined
        return {
          grid: nextGrid,
          newOrbCount,
          respins: 0,
          done: true,
          bet: bonus.bet,
          basePayout: bonus.basePayout,
          bonusPayout,
        }
      }

      state.slots = { ...bonus, grid: nextGrid, respins }
      return { grid: nextGrid, newOrbCount, respins, done: false, bet: bonus.bet, basePayout: bonus.basePayout }
    })
  }

  async plinkoDrop(caller: Caller, params: { bet: unknown }) {
    return this.run(caller, (state) => {
      const bet = this.requireBet(state, params.bet)
      // every drop is independent: no nudging toward the middle after a win
      // streak (that cut the return to 58%; real Plinko never does it)
      const centerBias = 0
      const seed = randomSeed()
      // the page replays this exact drop from the seed
      const slotIndex = simulateSlot(PLINKO_ROWS, PLINKO_MULTIPLIERS.length, centerBias, seededRandom(seed))
      const multiplier = PLINKO_MULTIPLIERS[slotIndex]
      const payout = roundMoney(bet * multiplier)
      state.plinkoWinStreak = payout > bet ? state.plinkoWinStreak + 1 : 0
      state.balance += payout - bet
      return { seed, centerBias, slotIndex, multiplier, payout, bet, net: roundMoney(payout - bet) }
    })
  }

  async jetstreamLaunch(caller: Caller, params: { bet: unknown; speed: unknown }) {
    return this.run(caller, (state) => {
      const speed = (typeof params.speed === 'string' && params.speed in JET_SPEEDS ? params.speed : null) as JetSpeed | null
      if (!speed) {
        fail('Pick a speed first.')
      }
      const bet = this.requireBet(state, params.bet)
      const flight = generateFlight(speed as JetSpeed)
      const payout = roundMoney(bet * flight.payoutMultiplier)
      state.balance += payout - bet
      return { flight, payout, bet, net: roundMoney(payout - bet) }
    })
  }

  // ---------- chicken cross ----------

  async chickenStart(caller: Caller, params: { bet: unknown; difficulty: unknown }) {
    return this.run(caller, (state) => {
      if (state.chicken) {
        this.settleOpen(state, 'chicken')
      }
      const difficulty = params.difficulty as ChickenDifficulty
      if (!['easy', 'medium', 'hard', 'daredevil'].includes(difficulty)) {
        fail('Pick a difficulty first.')
      }
      const bet = this.requireBet(state, params.bet)
      state.balance -= bet
      state.chicken = { bet, difficulty, lane: 0 }
      return { bet, difficulty }
    })
  }

  async chickenStep(caller: Caller) {
    return this.run(caller, (state) => {
      const run = state.chicken ?? fail('Start a run first.')
      const nextLane = run.lane + 1
      if (nextLane > CHICKEN_LANES) {
        fail('That is the last lane. Cash out!')
      }
      const config = getChickenConfig(run.difficulty)
      if (rollChickenHop(config, nextLane - 1)) {
        state.chicken = { ...run, lane: nextLane }
        return { survived: true, lane: nextLane, multiplier: config.multipliers[nextLane - 1] }
      }
      state.chicken = undefined
      return { survived: false, lane: nextLane, multiplier: 0, payout: 0, net: roundMoney(-run.bet), bet: run.bet }
    })
  }

  async chickenCashout(caller: Caller) {
    return this.run(caller, (state) => {
      const run = state.chicken ?? fail('Start a run first.')
      if (run.lane < 1) {
        fail('Cross at least one lane first.')
      }
      const multiplier = getChickenConfig(run.difficulty).multipliers[run.lane - 1]
      const payout = roundMoney(run.bet * multiplier)
      state.balance += payout
      state.chicken = undefined
      return { lane: run.lane, multiplier, payout, net: roundMoney(payout - run.bet), bet: run.bet }
    })
  }

  // ---------- hi-lo ----------

  async hiloStart(caller: Caller, params: { bet: unknown }) {
    return this.run(caller, (state) => {
      if (state.hilo) {
        this.settleOpen(state, 'hilo')
      }
      const bet = this.requireBet(state, params.bet)
      const { drawnCard: current, remainingDeck } = drawRandomCard(createShuffledDeck())
      const upcoming = drawRandomCard(remainingDeck).drawnCard
      state.balance -= bet
      state.hilo = { bet, deck: remainingDeck, current, upcoming, streak: 0, multiplier: 1 }
      return {
        bet,
        currentCard: current,
        odds: getHiLoOdds(remainingDeck, current),
        upcomingCard: caller.isDeveloper ? upcoming : undefined,
      }
    })
  }

  async hiloGuess(caller: Caller, params: { guess: unknown }) {
    return this.run(caller, (state) => {
      const round = state.hilo ?? fail('Reveal a first card to start.')
      const guess = params.guess === 'higher' ? 'higher' : 'lower'
      const odds = getHiLoOdds(round.deck, round.current)
      const stepMultiplier = guess === 'higher' ? odds.higherStepMultiplier : odds.lowerStepMultiplier
      if (stepMultiplier <= 0) {
        fail(`No cards are left that can go ${guess} from here.`)
      }

      const nextCard = round.upcoming ?? drawRandomCard(round.deck).drawnCard
      const remainingDeck = removeCardFromDeck(round.deck, nextCard)
      const nextUpcoming = remainingDeck.length > 0 ? drawRandomCard(remainingDeck).drawnCard : null
      const currentValue = getHiLoValue(round.current)
      const nextValue = getHiLoValue(nextCard)

      if (currentValue === nextValue) {
        state.hilo = { ...round, deck: remainingDeck, current: nextCard, upcoming: nextUpcoming }
        return {
          guess,
          nextCard,
          outcome: 'push',
          streak: round.streak,
          multiplier: round.multiplier,
          odds: getHiLoOdds(remainingDeck, nextCard),
          upcomingCard: caller.isDeveloper ? nextUpcoming : undefined,
        }
      }

      const didWin = guess === 'higher' ? nextValue > currentValue : nextValue < currentValue
      if (!didWin) {
        state.hilo = undefined
        return { guess, nextCard, outcome: 'lose', streak: round.streak, multiplier: round.multiplier, bet: round.bet }
      }

      const streak = round.streak + 1
      const multiplier = floorMultiplier(round.multiplier * stepMultiplier)
      state.hilo = { ...round, deck: remainingDeck, current: nextCard, upcoming: nextUpcoming, streak, multiplier }
      return {
        guess,
        nextCard,
        outcome: 'win',
        streak,
        multiplier,
        odds: getHiLoOdds(remainingDeck, nextCard),
        upcomingCard: caller.isDeveloper ? nextUpcoming : undefined,
      }
    })
  }

  async hiloCashout(caller: Caller) {
    return this.run(caller, (state) => {
      const round = state.hilo ?? fail('There is no round to cash out.')
      if (round.streak === 0) {
        fail('Win at least one guess before cashing out.')
      }
      const payout = roundMoney(round.bet * round.multiplier)
      state.balance += payout
      state.hilo = undefined
      return { payout, streak: round.streak, bet: round.bet }
    })
  }

  // ---------- mines ----------

  async minesStart(caller: Caller, params: { bet: unknown; mines: unknown }) {
    return this.run(caller, (state) => {
      if (state.mines) {
        this.settleOpen(state, 'mines')
      }
      const mineCount = Number(params.mines)
      if (!Number.isInteger(mineCount) || mineCount < MINES_MIN_COUNT || mineCount > MINES_MAX_COUNT) {
        fail(`Mines must be a whole number between ${MINES_MIN_COUNT} and ${MINES_MAX_COUNT}.`)
      }
      const bet = this.requireBet(state, params.bet)
      const mineIds = createMineIds(mineCount)
      state.balance -= bet
      state.mines = { bet, mineCount, mineIds, revealed: [] }
      return { bet, mineCount, mineIds: caller.isDeveloper ? mineIds : undefined }
    })
  }

  async minesReveal(caller: Caller, params: { tileId: unknown }) {
    return this.run(caller, (state) => {
      const round = state.mines ?? fail('Start a round first.')
      const tileId = Number(params.tileId)
      if (!Number.isInteger(tileId) || tileId < 0 || tileId >= MINES_TILE_COUNT || round.revealed.includes(tileId)) {
        fail('Pick a hidden tile.')
      }

      if (round.mineIds.includes(tileId)) {
        state.mines = undefined
        return { tileId, mine: true, mineIds: round.mineIds, payout: 0, bet: round.bet }
      }

      const revealed = [...round.revealed, tileId]
      const multiplier = getMinesMultiplier(revealed.length, round.mineCount)

      if (revealed.length === MINES_TILE_COUNT - round.mineCount) {
        const payout = roundMoney(round.bet * multiplier)
        state.balance += payout
        state.mines = undefined
        return {
          tileId,
          mine: false,
          safePicks: revealed.length,
          multiplier,
          cleared: true,
          payout,
          mineIds: round.mineIds,
          bet: round.bet,
        }
      }

      state.mines = { ...round, revealed }
      return { tileId, mine: false, safePicks: revealed.length, multiplier, cleared: false }
    })
  }

  async minesCashout(caller: Caller) {
    return this.run(caller, (state) => {
      const round = state.mines ?? fail('Start a round first.')
      if (round.revealed.length === 0) {
        fail('Pick at least one safe tile first.')
      }
      const multiplier = getMinesMultiplier(round.revealed.length, round.mineCount)
      const payout = roundMoney(round.bet * multiplier)
      state.balance += payout
      state.mines = undefined
      return { payout, safePicks: round.revealed.length, multiplier, mineIds: round.mineIds, bet: round.bet }
    })
  }

  // ---------- blackjack ----------

  private blackjackView(round: BlackjackRound) {
    return {
      playerHands: round.playerHands,
      handBets: round.handBets,
      completedHands: round.completedHands,
      activeHandIndex: round.activeHandIndex,
      // the hole card stays on the server until the dealer plays
      dealerHand: [round.dealerHand[0], HIDDEN_CARD],
      resolved: false,
    }
  }

  private resolveBlackjack(state: VaultState, playerHands: Card[][], handBets: number[], completedHands: boolean[]) {
    const round = state.blackjack!
    const hasLiveHand = playerHands.some((hand) => getHandValue(hand) <= 21)
    const dealerResolution = hasLiveHand
      ? finishDealerHand(round.dealerHand, state.blackjackDeck)
      : { finalDealerHand: round.dealerHand, remainingDeck: state.blackjackDeck }
    const result = getRoundResult(playerHands, dealerResolution.finalDealerHand, handBets)
    state.blackjackDeck = dealerResolution.remainingDeck
    state.balance += result.payout
    state.blackjack = undefined
    return {
      playerHands,
      handBets,
      completedHands,
      activeHandIndex: Math.max(0, playerHands.length - 1),
      dealerHand: dealerResolution.finalDealerHand,
      resolved: true,
      result,
    }
  }

  async blackjackDeal(caller: Caller, params: { bet: unknown }) {
    return this.run(caller, (state) => {
      if (state.blackjack) {
        fail('Finish your current hand first.')
      }
      const bet = this.requireBet(state, params.bet)
      // a fresh 6-deck shoe once three-quarters has been dealt (this also
      // replaces the single deck older saves were dealt from)
      if (state.blackjackDeck.length < BLACKJACK_RESHUFFLE_AT) {
        state.blackjackDeck = createBlackjackShoe()
      }
      const { drawnCards, remainingDeck } = drawCards(state.blackjackDeck, 4)
      const [playerFirst, dealerFirst, playerSecond, dealerSecond] = drawnCards
      state.blackjackDeck = remainingDeck
      state.balance -= bet
      state.blackjack = {
        playerHands: [[playerFirst, playerSecond]],
        handBets: [bet],
        completedHands: [false],
        activeHandIndex: 0,
        dealerHand: [dealerFirst, dealerSecond],
      }
      // the dealer checks for blackjack straight away, so a natural on either
      // side ends the hand before you can double or split into it
      if (isBlackjackNatural(state.blackjack.playerHands[0]) || isBlackjackNatural(state.blackjack.dealerHand)) {
        const round = state.blackjack
        const result = getRoundResult(round.playerHands, round.dealerHand, round.handBets)
        state.balance += result.payout
        state.blackjack = undefined
        return {
          playerHands: round.playerHands,
          handBets: round.handBets,
          completedHands: [true],
          activeHandIndex: 0,
          dealerHand: round.dealerHand,
          resolved: true,
          result,
        }
      }
      return this.blackjackView(state.blackjack)
    })
  }

  async blackjackAct(caller: Caller, params: { action: unknown }) {
    return this.run(caller, (state) => {
      const round = state.blackjack ?? fail('Deal a hand first.')
      const index = round.activeHandIndex
      const currentHand = round.playerHands[index]
      const currentHandBet = round.handBets[index]
      let playerHands = round.playerHands.map((hand) => [...hand])
      let handBets = [...round.handBets]
      let completedHands = [...round.completedHands]

      const advance = () => {
        const nextOpenHand = completedHands.findIndex((done) => !done)
        if (nextOpenHand !== -1) {
          state.blackjack = { ...round, playerHands, handBets, completedHands, activeHandIndex: nextOpenHand }
          return this.blackjackView(state.blackjack)
        }
        state.blackjack = { ...round, playerHands, handBets, completedHands }
        return this.resolveBlackjack(state, playerHands, handBets, completedHands)
      }

      if (params.action === 'hit') {
        const { drawnCards, remainingDeck } = drawCards(state.blackjackDeck, 1)
        state.blackjackDeck = remainingDeck
        playerHands[index] = [...currentHand, drawnCards[0]]
        if (getHandValue(playerHands[index]) > 21) {
          completedHands[index] = true
          return advance()
        }
        state.blackjack = { ...round, playerHands }
        return this.blackjackView(state.blackjack)
      }

      if (params.action === 'stand') {
        completedHands[index] = true
        return advance()
      }

      if (params.action === 'double') {
        if (currentHand.length !== 2) {
          fail('You can only double on your first two cards.')
        }
        if (state.balance < currentHandBet) {
          fail('You need enough money to match your bet to double.')
        }
        state.balance -= currentHandBet
        const { drawnCards, remainingDeck } = drawCards(state.blackjackDeck, 1)
        state.blackjackDeck = remainingDeck
        playerHands[index] = [...currentHand, drawnCards[0]]
        handBets[index] = currentHandBet * 2
        completedHands[index] = true
        return advance()
      }

      if (params.action === 'split') {
        if (currentHand.length !== 2 || currentHand[0].rank !== currentHand[1].rank) {
          fail('You can only split a pair.')
        }
        if (playerHands.length >= BLACKJACK_MAX_HANDS) {
          fail(`You can split up to ${BLACKJACK_MAX_HANDS} hands.`)
        }
        if (state.balance < currentHandBet) {
          fail('You need enough money to match your bet to split.')
        }
        state.balance -= currentHandBet
        const { drawnCards, remainingDeck } = drawCards(state.blackjackDeck, 2)
        state.blackjackDeck = remainingDeck
        playerHands.splice(index, 1, [currentHand[0], drawnCards[0]], [currentHand[1], drawnCards[1]])
        handBets.splice(index, 1, currentHandBet, currentHandBet)
        // split aces get one card each and stand
        const splitAces = currentHand[0].rank === 'A'
        completedHands.splice(index, 1, splitAces, splitAces)
        if (splitAces) {
          return advance()
        }
        state.blackjack = { ...round, playerHands, handBets, completedHands, activeHandIndex: index }
        return this.blackjackView(state.blackjack)
      }

      return fail('Unknown move.')
    })
  }

  // ---------- poker buy-ins (called by poker tables only) ----------

  async pokerDeposit(caller: Caller, amount: number) {
    return this.run(caller, (state) => {
      if (!Number.isFinite(amount) || amount <= 0 || amount > state.balance) {
        fail(`You need at least $${Math.round(amount)} to join.`)
      }
      state.balance -= amount
      return { amount }
    })
  }

  async pokerWithdraw(caller: Caller, amount: number) {
    return this.run(caller, (state) => {
      state.balance += Math.max(0, Number(amount) || 0)
      return { amount }
    })
  }

  // ---------- developer tools ----------

  async adminSetBalance(caller: Caller, value: number) {
    return this.run(caller, (state) => {
      state.balance = Math.max(0, Number(value) || 0)
      return {}
    })
  }

  async adminAdjust(caller: Caller, delta: number) {
    return this.run(caller, (state) => {
      state.balance = Math.max(0, state.balance + (Number(delta) || 0))
      return {}
    })
  }

  async adminDelete(caller: Caller) {
    this.state = null
    await this.ctx.storage.deleteAlarm()
    await this.ctx.storage.deleteAll()
    await commitWrites(this.env, [{ kind: 'delete', path: `players/${caller.playerId}` }]).catch((error) =>
      console.error('delete failed', error),
    )
    return { ok: true as const, balance: 0 }
  }
}
