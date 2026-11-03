// One PokerTable per room code. It holds the real table (deck and everyone's
// hole cards), runs every action one at a time, moves buy-ins and cash-outs
// through each player's vault, and publishes what players may see:
//   pokerRooms/{code}             the table, with no deck and hidden hands
//   pokerRooms/{code}/hands/{id}  each player's own two cards
import { DurableObject } from 'cloudflare:workers'
import {
  confirmPokerBuyIn,
  createPokerRoom,
  declinePokerBuyIn,
  DEFAULT_SMALL_BLIND,
  joinPokerRoom,
  leavePokerTable,
  pokerCallOrCheck,
  pokerFold,
  pokerRaise,
  type PokerResult,
  type PokerRoomState,
  publicPokerRoom,
  requestPokerStart,
  setPokerBlinds,
  setPokerBuyIn,
} from '../../src/shared/poker'
import { commitWrites, type Env, type FirestoreWrite } from './firestore'
import type { Caller } from './vault'

export type PokerAction =
  | 'join'
  | 'buyIn'
  | 'blinds'
  | 'start'
  | 'confirmBuyIn'
  | 'declineBuyIn'
  | 'leave'
  | 'fold'
  | 'call'
  | 'raise'

const cleanName = (value: unknown) => String(value ?? '').trim().slice(0, 24)

export class PokerTable extends DurableObject<Env> {
  private room: PokerRoomState | null = null
  private owners: Record<string, string> = {}
  private loaded = false
  private publishChain: Promise<unknown> = Promise.resolve()

  private async load() {
    if (!this.loaded) {
      this.room = (await this.ctx.storage.get<PokerRoomState>('room')) ?? null
      this.owners = (await this.ctx.storage.get<Record<string, string>>('owners')) ?? {}
      this.loaded = true
    }
  }

  private vault(playerId: string) {
    return this.env.PLAYERS.get(this.env.PLAYERS.idFromName(playerId))
  }

  private async persist(room: PokerRoomState | null, dealt: boolean) {
    this.room = room
    await this.ctx.storage.put('room', room)
    await this.ctx.storage.put('owners', this.owners)
    if (!room) {
      return
    }

    const writes: FirestoreWrite[] = [
      { kind: 'set', path: `pokerRooms/${room.code}`, data: { ...publicPokerRoom(room), updatedAt: new Date().toISOString() } },
    ]
    if (dealt && room.game) {
      for (const [playerId, player] of Object.entries(room.game.players)) {
        writes.push({
          kind: 'set',
          path: `pokerRooms/${room.code}/hands/${playerId}`,
          data: { ownerUid: this.owners[playerId] ?? '', handId: room.game.handId ?? room.game.actionId, cards: player.holeCards },
        })
      }
    }
    this.publishChain = this.publishChain
      .then(() => commitWrites(this.env, writes))
      .catch((error) => console.error('poker publish failed', error))
  }

  private view(caller: Caller, extra: Record<string, unknown> = {}) {
    const room = this.room
    const me = room?.game?.players[caller.playerId]
    return {
      ok: true as const,
      room: room ? publicPokerRoom(room) : null,
      hand: me ? { handId: room!.game!.handId ?? room!.game!.actionId, cards: me.holeCards } : null,
      allHands:
        caller.isDeveloper && room?.game
          ? Object.fromEntries(Object.entries(room.game.players).map(([id, player]) => [id, player.holeCards]))
          : undefined,
      ...extra,
    }
  }

  async exists() {
    await this.load()
    return Boolean(this.room)
  }

  async create(caller: Caller, code: string, params: { name: unknown; buyIn: unknown; smallBlind: unknown }) {
    return this.ctx.blockConcurrencyWhile(async () => {
      await this.load()
      if (this.room) {
        return { ok: false as const, error: 'That room code is taken.' }
      }
      const name = cleanName(params.name)
      if (!name) {
        return { ok: false as const, error: 'Enter your name first.' }
      }
      const buyIn = Math.max(10, Math.round(Number(params.buyIn) || 1000))
      const smallBlind = Math.max(1, Math.round(Number(params.smallBlind) || DEFAULT_SMALL_BLIND))
      this.owners = { [caller.playerId]: caller.uid }
      await this.persist(createPokerRoom(code, { id: caller.playerId, name }, buyIn, smallBlind), false)
      return this.view(caller)
    })
  }

  async act(caller: Caller, action: PokerAction, params: Record<string, unknown>) {
    return this.ctx.blockConcurrencyWhile(async () => {
      try {
        await this.load()
        const room = this.room
        if (!room) {
          return { ok: false as const, error: 'That room code is not active.' }
        }

        const apply = async (result: PokerResult, extra: Record<string, unknown> = {}) => {
          if ('error' in result) {
            return { ok: false as const, error: result.error, room: publicPokerRoom(room) }
          }
          const dealt = Boolean(result.room.game) && result.room.game!.handId !== room.game?.handId
          await this.persist(result.room, dealt)
          return this.view(caller, extra)
        }

        switch (action) {
          case 'join': {
            const name = cleanName(params.name)
            if (!name) {
              return { ok: false as const, error: 'Enter your name first.' }
            }
            this.owners[caller.playerId] = caller.uid
            return apply(joinPokerRoom(room, { id: caller.playerId, name }))
          }
          case 'buyIn':
            return apply(setPokerBuyIn(room, caller.playerId, Number(params.buyIn)))
          case 'blinds':
            return apply(setPokerBlinds(room, caller.playerId, Number(params.smallBlind)))
          case 'start':
            return apply(requestPokerStart(room, caller.playerId))
          case 'confirmBuyIn': {
            const needsDeposit = (room.playerChips[caller.playerId] ?? 0) <= 0
            let deposited = !needsDeposit
            let balance: number | undefined
            if (needsDeposit && room.pendingStart) {
              const deposit = await this.vault(caller.playerId).pokerDeposit(caller, room.pendingStart.buyIn)
              deposited = deposit.ok
              balance = deposit.balance
            }
            const result = confirmPokerBuyIn(room, caller.playerId, deposited)
            return apply(result, { removed: 'removed' in result ? Boolean(result.removed) : false, balance })
          }
          case 'declineBuyIn':
            return apply(declinePokerBuyIn(room, caller.playerId), { removed: true })
          case 'leave': {
            const result = leavePokerTable(room, caller.playerId)
            if ('error' in result) {
              return apply(result)
            }
            const payout = await this.vault(caller.playerId).pokerWithdraw(caller, result.cashOut)
            delete this.owners[caller.playerId]
            return apply({ room: result.room }, { removed: true, cashOut: result.cashOut, balance: payout.balance })
          }
          case 'fold':
            return apply(pokerFold(room, caller.playerId))
          case 'call':
            return apply(pokerCallOrCheck(room, caller.playerId))
          case 'raise':
            return apply(pokerRaise(room, caller.playerId, Number(params.target)))
          default:
            return { ok: false as const, error: 'Unknown poker action.' }
        }
      } catch (error) {
        console.error('poker table error', error)
        return { ok: false as const, error: 'The poker table had a problem. Try again.' }
      }
    })
  }

  // developer: close the table, returning everyone's chips to their bankrolls
  async close(caller: Caller) {
    return this.ctx.blockConcurrencyWhile(async () => {
      await this.load()
      if (this.room) {
        for (const [playerId, chips] of Object.entries(this.room.playerChips)) {
          if (chips > 0) {
            await this.vault(playerId).pokerWithdraw({ ...caller, playerId }, chips)
          }
        }
        await commitWrites(this.env, [{ kind: 'delete', path: `pokerRooms/${this.room.code}` }]).catch(() => false)
      }
      this.room = null
      this.owners = {}
      await this.ctx.storage.deleteAll()
      return { ok: true as const }
    })
  }
}
