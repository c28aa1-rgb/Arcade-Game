// Game rules that decide who gets paid: blackjack, poker hands and pots, and
// the daily bonus.
import { describe, expect, it } from 'vitest'
import * as C from '../src/shared/casino'
import { buildPokerPots, comparePokerScores, evaluateBestPokerHand, type PokerRoomState } from '../src/shared/poker'

const cards = (text: string): C.Card[] =>
  text.split(' ').map((token) => ({ rank: token.slice(0, -1), suit: token.slice(-1) }))

describe('blackjack payouts', () => {
  it('a natural pays 3 to 2', () => {
    expect(C.getRoundResult([cards('A♠ K♥')], cards('9♦ 8♣'), [10]).payout).toBe(25)
  })

  it('a natural beats a dealer 21 made of three cards', () => {
    expect(C.getRoundResult([cards('A♠ K♥')], cards('7♦ 7♣ 7♥'), [10]).payout).toBe(25)
  })

  it('two naturals push', () => {
    expect(C.getRoundResult([cards('A♠ K♥')], cards('A♦ Q♣'), [10]).payout).toBe(10)
  })

  it('a dealer natural beats a player 21', () => {
    expect(C.getRoundResult([cards('7♠ 7♥ 7♦')], cards('A♦ Q♣'), [10]).payout).toBe(0)
  })

  it('21 after a split is not a blackjack', () => {
    const result = C.getRoundResult([cards('A♠ K♥'), cards('A♣ 9♥')], cards('10♦ 8♣'), [10, 10])
    // A-K wins even money, A-9 (20) beats 18 too
    expect(result.payout).toBe(40)
  })

  it('the dealer stands on soft 17', () => {
    const { finalDealerHand } = C.finishDealerHand(cards('A♠ 6♥'), cards('5♦ 5♣'))
    expect(finalDealerHand).toHaveLength(2)
  })

  it('a pushed hand returns the bet', () => {
    expect(C.getRoundResult([cards('10♠ 8♥')], cards('9♦ 9♣'), [10]).payout).toBe(10)
  })

  it('the shoe holds six full decks', () => {
    const shoe = C.createBlackjackShoe()
    expect(shoe).toHaveLength(52 * C.BLACKJACK_DECKS)
    expect(shoe.filter((card) => card.rank === 'A' && card.suit === '♠')).toHaveLength(C.BLACKJACK_DECKS)
  })
})

describe('blackjack house edge', () => {
  // standard multi-deck, dealer-stands-on-17 basic strategy (no surrender)
  const value = (rank: string) => (rank === 'A' ? 11 : ['K', 'Q', 'J'].includes(rank) ? 10 : Number(rank))
  const isSoft = (hand: C.Card[]) => {
    let total = hand.reduce((sum, card) => sum + value(card.rank), 0)
    let aces = hand.filter((card) => card.rank === 'A').length
    while (total > 21 && aces > 0) {
      total -= 10
      aces -= 1
    }
    return aces > 0
  }
  const decide = (hand: C.Card[], up: number, canSplit: boolean): 'H' | 'S' | 'D' | 'P' => {
    const total = C.getHandValue(hand)
    const canDouble = hand.length === 2
    if (canSplit && hand.length === 2 && hand[0].rank === hand[1].rank) {
      const pair = value(hand[0].rank)
      if (pair === 11 || pair === 8) return 'P'
      if (pair === 9 && ![7, 10, 11].includes(up)) return 'P'
      if ((pair === 7 || pair === 3 || pair === 2) && up <= 7) return 'P'
      if (pair === 6 && up <= 6) return 'P'
      if (pair === 4 && (up === 5 || up === 6)) return 'P'
    }
    if (isSoft(hand)) {
      if (total >= 19) return total === 19 && up === 6 && canDouble ? 'D' : 'S'
      if (total === 18) return up <= 6 ? (canDouble ? 'D' : 'S') : up <= 8 ? 'S' : 'H'
      const doubleSoft =
        (total === 17 && up >= 3 && up <= 6) ||
        ((total === 15 || total === 16) && up >= 4 && up <= 6) ||
        ((total === 13 || total === 14) && up >= 5 && up <= 6)
      return canDouble && doubleSoft ? 'D' : 'H'
    }
    if (total >= 17) return 'S'
    if (total >= 13) return up <= 6 ? 'S' : 'H'
    if (total === 12) return up >= 4 && up <= 6 ? 'S' : 'H'
    if (total === 11) return canDouble ? 'D' : 'H'
    if (total === 10) return up <= 9 && canDouble ? 'D' : 'H'
    if (total === 9) return up >= 3 && up <= 6 && canDouble ? 'D' : 'H'
    return 'H'
  }

  it('is about 0.4% with basic strategy, like a Las Vegas table', () => {
    let shoe = C.createBlackjackShoe()
    const draw = () => {
      const { drawnCards, remainingDeck } = C.drawCards(shoe, 1)
      shoe = remainingDeck
      return drawnCards[0]
    }
    let wagered = 0
    let returned = 0
    for (let round = 0; round < 250_000; round += 1) {
      if (shoe.length < C.BLACKJACK_RESHUFFLE_AT) {
        shoe = C.createBlackjackShoe()
      }
      const [p1, d1, p2, d2] = [draw(), draw(), draw(), draw()]
      const hands = [[p1, p2]]
      const bets = [1]
      const done = [false]
      if (C.isBlackjackNatural([p1, p2]) || C.isBlackjackNatural([d1, d2])) {
        wagered += 1
        returned += C.getRoundResult(hands, [d1, d2], bets).payout
        continue
      }
      for (let index = 0; index < hands.length; index += 1) {
        while (!done[index]) {
          const move = decide(hands[index], value(d1.rank), hands.length < C.BLACKJACK_MAX_HANDS)
          if (move === 'S') break
          if (move === 'P') {
            const [left, right] = hands[index]
            hands.splice(index, 1, [left, draw()], [right, draw()])
            bets.splice(index, 1, bets[index], bets[index])
            done.splice(index, 1, left.rank === 'A', left.rank === 'A')
            continue
          }
          hands[index] = [...hands[index], draw()]
          if (move === 'D') {
            bets[index] *= 2
            break
          }
          if (C.getHandValue(hands[index]) > 21) break
        }
      }
      const dealer = hands.some((hand) => C.getHandValue(hand) <= 21)
        ? C.finishDealerHand([d1, d2], shoe)
        : { finalDealerHand: [d1, d2], remainingDeck: shoe }
      shoe = dealer.remainingDeck
      wagered += bets.reduce((sum, bet) => sum + bet, 0)
      returned += C.getRoundResult(hands, dealer.finalDealerHand, bets).payout
    }
    const rtp = returned / wagered
    expect(rtp).toBeGreaterThan(0.985)
    expect(rtp).toBeLessThan(1.005)
  }, 30_000)
})

describe('poker hand ranking', () => {
  const beats = (left: string, right: string) =>
    comparePokerScores(evaluateBestPokerHand(cards(left)), evaluateBestPokerHand(cards(right)))

  it.each([
    ['a 6-high straight beats the wheel', '6♠ 2♥ 3♦ 4♣ 5♠ K♥ 9♦', 'A♠ 2♥ 3♦ 4♣ 5♠ K♥ 9♦'],
    ['pair of aces: K kicker beats Q kicker', 'A♠ A♥ K♦ 4♣ 5♠ 9♥ 2♦', 'A♣ A♦ Q♦ 4♣ 5♠ 9♥ 2♦'],
    ['two pair KK99: the ace kicker wins', 'K♣ K♦ 4♥ 4♠ 9♠ 9♥ A♦', 'K♠ K♥ 4♦ 4♣ 9♠ 9♥ 2♦'],
    ['full house 777AA beats 777KK', '7♠ 7♥ 7♦ A♣ A♠ 2♥ 3♦', '7♠ 7♥ 7♦ K♣ K♠ Q♥ Q♦'],
    ['flush A-K-9-4-3 beats A-K-9-4-2', 'A♥ K♥ 9♥ 4♥ 3♥ 2♠ 5♠', 'A♥ K♥ 9♥ 4♥ 2♥ 3♠ 5♠'],
    ['quads with a K kicker beat a 9 kicker', '5♥ 5♠ 5♦ 5♣ 2♥ 3♠ K♠', '5♥ 5♠ 5♦ 5♣ 2♥ 3♠ 9♠'],
    ['a straight flush beats four of a kind', '5♥ 6♥ 7♥ 8♥ 9♥ 9♠ 9♦', 'A♥ A♠ A♦ A♣ K♥ Q♠ J♦'],
    ['a flush beats a straight', '2♣ 7♣ 9♣ J♣ K♣ Q♦ 10♦', '9♠ 10♥ J♦ Q♣ K♠ 2♥ 3♦'],
  ])('%s', (_, winner, loser) => {
    expect(beats(winner, loser)).toBeGreaterThan(0)
  })

  it('finds the same hand category as an independent checker on random hands', () => {
    const rank = (card: C.Card) => ({ A: 14, K: 13, Q: 12, J: 11 } as Record<string, number>)[card.rank] ?? Number(card.rank)
    const hasStraight = (values: number[]) => {
      const set = new Set(values)
      if (set.has(14)) set.add(1)
      for (let high = 14; high >= 5; high -= 1) {
        if ([0, 1, 2, 3, 4].every((step) => set.has(high - step))) return true
      }
      return false
    }
    const category = (hand: C.Card[]) => {
      const suits: Record<string, number[]> = {}
      const counts: Record<number, number> = {}
      for (const card of hand) {
        ;(suits[card.suit] ??= []).push(rank(card))
        counts[rank(card)] = (counts[rank(card)] ?? 0) + 1
      }
      const flush = Object.values(suits).find((values) => values.length >= 5)
      const groups = Object.values(counts).sort((a, b) => b - a)
      if (flush && hasStraight(flush)) return 8
      if (groups[0] === 4) return 7
      if (groups[0] === 3 && groups[1] >= 2) return 6
      if (flush) return 5
      if (hasStraight(hand.map(rank))) return 4
      if (groups[0] === 3) return 3
      if (groups[0] === 2 && groups[1] === 2) return 2
      if (groups[0] === 2) return 1
      return 0
    }
    for (let index = 0; index < 20_000; index += 1) {
      const hand = C.createShuffledDeck().slice(0, 7)
      expect(evaluateBestPokerHand(hand)[0]).toBe(category(hand))
    }
  })
})

describe('poker side pots', () => {
  // start = stacks when the hand was dealt, left = stacks now
  const room = (start: Record<string, number>, left: Record<string, number>, folded: string[] = []) =>
    ({
      handStartChips: start,
      game: {
        pot: Object.keys(start).reduce((sum, id) => sum + start[id] - left[id], 0),
        players: Object.fromEntries(Object.keys(start).map((id) => [id, { chips: left[id], folded: folded.includes(id) }])),
      },
    }) as unknown as PokerRoomState
  const pots = (state: PokerRoomState, showdown: string[]) =>
    buildPokerPots(state, showdown).map((pot) => `${pot.amount}:${pot.eligibleIds.join('+')}`)

  it('a short all-in stack can only win what it covered', () => {
    expect(pots(room({ a: 50, b: 1000, c: 1000 }, { a: 0, b: 500, c: 500 }), ['a', 'b', 'c'])).toEqual([
      '150:a+b+c',
      '900:b+c',
    ])
  })

  it('an uncalled bet goes back to whoever made it', () => {
    expect(pots(room({ a: 100, b: 1000 }, { a: 0, b: 700 }), ['a', 'b'])).toEqual(['200:a+b', '200:b'])
  })

  it("a folded player's chips stay in the pots", () => {
    expect(pots(room({ a: 50, b: 1000, c: 1000 }, { a: 0, b: 800, c: 900 }, ['c']), ['a', 'b'])).toEqual([
      '150:a+b',
      '200:b',
    ])
  })

  it('equal stacks make one pot', () => {
    expect(pots(room({ a: 500, b: 500 }, { a: 300, b: 300 }), ['a', 'b'])).toEqual(['400:a+b'])
  })
})

describe('daily bonus', () => {
  it('pays the first-week schedule, then keeps growing', () => {
    expect([1, 2, 3, 4, 5, 6, 7].map(C.getDailyRewardAmountForDay)).toEqual([10, 20, 35, 55, 80, 100, 250])
    expect(C.getDailyRewardAmountForDay(8)).toBe(125)
  })

  it('a missed day resets the streak, and today can only be claimed once', () => {
    expect(C.getDailyRewardState('2026-11-05', '2026-11-04', 3)).toMatchObject({ canClaim: true, nextDay: 4 })
    expect(C.getDailyRewardState('2026-11-06', '2026-11-04', 3)).toMatchObject({ canClaim: true, nextDay: 1 })
    expect(C.getDailyRewardState('2026-11-04', '2026-11-04', 3)).toMatchObject({ canClaim: false })
  })
})
