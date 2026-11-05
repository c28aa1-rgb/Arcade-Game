// House-edge checks for every game. Exact where the math allows it, otherwise
// a simulation big enough that the bounds are several standard deviations
// wide. If one of these fails after a tweak, that game now pays out more (or
// far less) than a real casino's version.
import { describe, expect, it } from 'vitest'
import * as C from '../src/shared/casino'
import { CHICKEN_DIFFICULTIES, CHICKEN_LANES } from '../src/components/chickenLogic'
import { generateFlight, JET_SPEED_ORDER } from '../src/components/jetstreamLogic'
import { simulateSlot } from '../src/components/plinkoPhysics'
import { randomSeed, seededRandom } from '../src/shared/random'

describe('dice', () => {
  it('returns at most 99% on every target, and refuses near-certain bets', () => {
    for (const mode of ['lower', 'higher'] as const) {
      for (let target = C.DICE_MIN_TOTAL; target <= C.DICE_MAX_TOTAL; target += 1) {
        const chance = C.getDiceWinChance(target, mode)
        const multiplier = C.getDiceMultiplier(target, mode)
        if (chance > C.DICE_MAX_WIN_CHANCE || chance === 0) {
          expect(multiplier).toBe(0)
          continue
        }
        expect(chance * multiplier).toBeLessThanOrEqual(0.99 + 1e-9)
        // tiny chances are capped at 1000x, so only check the normal range
        if (chance > 0.002) {
          expect(chance * multiplier).toBeGreaterThan(0.97)
        }
      }
    }
  })
})

describe('roulette (American, 0 and 00)', () => {
  const bets: C.RouletteBet[] = [
    { kind: 'number', value: 17 },
    { kind: 'number', value: 0 },
    { kind: 'number', value: '00' },
    { kind: 'color', value: 'red' },
    { kind: 'color', value: 'black' },
    { kind: 'parity', value: 'odd' },
    { kind: 'parity', value: 'even' },
    { kind: 'range', value: '1-18' },
    { kind: 'range', value: '19-36' },
    { kind: 'range', value: '1-12' },
    { kind: 'range', value: '13-24' },
    { kind: 'range', value: '25-36' },
    { kind: 'column', value: 'column-1' },
    { kind: 'column', value: 'column-2' },
    { kind: 'column', value: 'column-3' },
  ]

  it('has 38 distinct pockets and 18 reds', () => {
    expect(new Set(C.ROULETTE_WHEEL_ORDER.map(String)).size).toBe(38)
    expect(C.ROULETTE_RED_NUMBERS.size).toBe(18)
  })

  it.each(bets.map((bet) => [`${bet.kind} ${bet.value}`, bet] as const))('%s returns exactly 36/38', (_, bet) => {
    const paid = C.ROULETTE_WHEEL_ORDER.reduce(
      (sum, pocket) => sum + C.settleRouletteBets([{ bet, amount: 10 }], pocket).payout,
      0,
    )
    expect(paid / (10 * 38)).toBeCloseTo(36 / 38, 12)
  })

  it('0 and 00 lose every outside bet', () => {
    for (const pocket of [0, '00'] as const) {
      for (const bet of bets.filter((entry) => entry.kind !== 'number')) {
        expect(C.settleRouletteBets([{ bet, amount: 10 }], pocket).payout).toBe(0)
      }
    }
  })
})

describe('mines', () => {
  it('returns 98.4–99% for every mine count and every cash-out point', () => {
    for (let mines = C.MINES_MIN_COUNT; mines <= C.MINES_MAX_COUNT; mines += 1) {
      let survive = 1
      for (let picks = 1; picks <= C.MINES_TILE_COUNT - mines; picks += 1) {
        survive *= (C.MINES_TILE_COUNT - mines - (picks - 1)) / (C.MINES_TILE_COUNT - (picks - 1))
        const rtp = survive * C.getMinesMultiplier(picks, mines)
        expect(rtp).toBeLessThanOrEqual(0.99 + 1e-9)
        expect(rtp).toBeGreaterThan(0.98)
      }
    }
  })
})

describe('hi-lo', () => {
  it('one guess returns 98–99%, counting a tie as a push', () => {
    const deck = C.createShuffledDeck()
    for (const rank of C.RANKS) {
      const current = deck.find((card) => card.rank === rank)!
      const rest = deck.filter((card) => card !== current)
      const odds = C.getHiLoOdds(rest, current)
      const tie = odds.equalCount / rest.length
      for (const [win, multiplier] of [
        [odds.higherProbability, odds.higherStepMultiplier],
        [odds.lowerProbability, odds.lowerStepMultiplier],
      ]) {
        if (multiplier === 0) {
          continue
        }
        const ev = win * multiplier + tie
        expect(ev).toBeLessThanOrEqual(0.99 + 1e-9)
        expect(ev).toBeGreaterThan(0.98)
      }
    }
  })
})

describe('chicken cross', () => {
  it.each(Object.values(CHICKEN_DIFFICULTIES).map((config) => [config.label, config] as const))(
    '%s returns 98% wherever you cash out',
    (_, config) => {
      let reach = 1
      for (let lane = 0; lane < CHICKEN_LANES; lane += 1) {
        reach *= config.survival[lane]
        expect(reach * config.multipliers[lane]).toBeCloseTo(0.98, 9)
      }
    },
  )
})

describe('jetstream', () => {
  it.each(JET_SPEED_ORDER)('%s returns about 97%', (speed) => {
    const flights = 200_000
    let paid = 0
    for (let index = 0; index < flights; index += 1) {
      paid += generateFlight(speed).payoutMultiplier
    }
    expect(paid / flights).toBeGreaterThan(0.93)
    expect(paid / flights).toBeLessThan(0.995)
  })
})

describe('slots', () => {
  it('line wins return about 63% (exact)', () => {
    const p = (1 - C.SLOT_ORB_CHANCE) / 5
    const perRow = Object.values(C.SLOT_PAYTABLE).reduce(
      (sum, pay) => sum + p * (pay[3] * p ** 2 * (1 - p) + pay[4] * p ** 3 * (1 - p) + pay[5] * p ** 4),
      0,
    )
    expect(perRow * C.SLOT_ROWS).toBeCloseTo(0.6347, 3)
  })

  it('returns about 96% overall, including the bonus', () => {
    const bet = 10
    const spins = 300_000
    let paid = 0
    let bonuses = 0
    for (let index = 0; index < spins; index += 1) {
      const grid = C.createSlotsFinalGrid(bet)
      paid += C.calculateSlotsLinePayout(grid, bet).totalPayout
      if (C.countSlotsBonusSymbols(grid) >= C.SLOT_BONUS_TRIGGER) {
        bonuses += 1
        let bonusGrid = C.createSlotsBonusGridFromSpin(grid)
        let respins = 3
        while (bonusGrid.flat().some((cell) => !cell) && respins > 0) {
          const { nextGrid, newOrbCount } = C.respinSlotsBonusGrid(bonusGrid, bet)
          bonusGrid = nextGrid
          respins = newOrbCount > 0 ? 3 : respins - 1
        }
        paid += C.calculateSlotsBonusPayout(bonusGrid, bet).totalPayout
      }
    }
    const rtp = paid / (spins * bet)
    expect(rtp).toBeGreaterThan(0.92)
    expect(rtp).toBeLessThan(1)
    // the bonus should be an event, not every few spins
    expect(spins / bonuses).toBeGreaterThan(120)
  })
})

describe('plinko', () => {
  it('the table returns 99% on a fair bell curve (exact)', () => {
    const rows = C.PLINKO_ROWS
    let choose = 1
    let rtp = 0
    for (let slot = 0; slot <= rows; slot += 1) {
      rtp += (choose / 2 ** rows) * C.PLINKO_MULTIPLIERS[slot]
      choose = (choose * (rows - slot)) / (slot + 1)
    }
    expect(rtp).toBeLessThanOrEqual(0.99 + 1e-9)
    expect(rtp).toBeGreaterThan(0.985)
  })

  it('the physics lands close to that', () => {
    const drops = 8_000
    let paid = 0
    for (let index = 0; index < drops; index += 1) {
      paid += C.PLINKO_MULTIPLIERS[simulateSlot(C.PLINKO_ROWS, C.PLINKO_MULTIPLIERS.length, 0, seededRandom(randomSeed()))]
    }
    expect(paid / drops).toBeGreaterThan(0.94)
    expect(paid / drops).toBeLessThan(1.04)
  }, 30_000)
})
