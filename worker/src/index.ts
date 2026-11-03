// Front door of the casino server. Every request:
//  1. must come from the casino's own pages (CORS allow-list),
//  2. must carry the browser's Firebase session (verified against Google),
//  3. is handed to that player's vault (or a poker table) to run.
// POST /api/<area>/<action>  body: { playerId, ...params }
import { isDeveloperClaims, verifyFirebaseToken } from './auth'
import type { Env } from './firestore'
import { createPokerRoomCode } from '../../src/shared/poker'
import type { PokerAction } from './table'
import type { Caller, PlayerVault } from './vault'

export { PlayerVault } from './vault'
export { PokerTable } from './table'
export { UsageMonitor } from './usage'

const usageMonitor = (env: Env) => env.MONITOR.get(env.MONITOR.idFromName('global'))

const PLAYER_ID_PATTERN = /^player-[a-z0-9]{6,24}$/
const ROOM_CODE_PATTERN = /^[A-Z0-9]{4}$/

const corsHeaders = (request: Request, env: Env) => {
  const origin = request.headers.get('Origin') ?? ''
  const allowed = env.ALLOWED_ORIGINS.split(',').map((entry) => entry.trim())
  return {
    'Access-Control-Allow-Origin': allowed.includes(origin) ? origin : allowed[0],
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Developer-Token',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  }
}

const json = (request: Request, env: Env, body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...corsHeaders(request, env) },
  })

type GameCall = (vault: DurableObjectStub<PlayerVault>, caller: Caller, body: Record<string, unknown>) => Promise<unknown>

const PLAYER_ROUTES: Record<string, GameCall> = {
  'player/me': (vault, caller) => vault.me(caller),
  'player/leave': (vault, caller, body) =>
    vault.leaveGame(caller, body.game as 'blackjack' | 'hilo' | 'mines' | 'chicken' | 'slots'),
  'daily/claim': (vault, caller, body) => vault.claimDaily(caller, body.todayKey),
  'dice/roll': (vault, caller, body) => vault.diceRoll(caller, body as never),
  'roulette/spin': (vault, caller, body) => vault.rouletteSpin(caller, body as never),
  'slots/spin': (vault, caller, body) => vault.slotsSpin(caller, body as never),
  'slots/respin': (vault, caller) => vault.slotsRespin(caller),
  'plinko/drop': (vault, caller, body) => vault.plinkoDrop(caller, body as never),
  'jetstream/launch': (vault, caller, body) => vault.jetstreamLaunch(caller, body as never),
  'chicken/start': (vault, caller, body) => vault.chickenStart(caller, body as never),
  'chicken/step': (vault, caller) => vault.chickenStep(caller),
  'chicken/cashout': (vault, caller) => vault.chickenCashout(caller),
  'hilo/start': (vault, caller, body) => vault.hiloStart(caller, body as never),
  'hilo/guess': (vault, caller, body) => vault.hiloGuess(caller, body as never),
  'hilo/cashout': (vault, caller) => vault.hiloCashout(caller),
  'mines/start': (vault, caller, body) => vault.minesStart(caller, body as never),
  'mines/reveal': (vault, caller, body) => vault.minesReveal(caller, body as never),
  'mines/cashout': (vault, caller) => vault.minesCashout(caller),
  'blackjack/deal': (vault, caller, body) => vault.blackjackDeal(caller, body as never),
  'blackjack/act': (vault, caller, body) => vault.blackjackAct(caller, body as never),
}

const POKER_ACTIONS: PokerAction[] = [
  'join',
  'buyIn',
  'blinds',
  'start',
  'confirmBuyIn',
  'declineBuyIn',
  'leave',
  'fold',
  'call',
  'raise',
]

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(request, env) })
    }

    const url = new URL(request.url)
    if (url.pathname === '/health') {
      return json(request, env, { ok: true, writes: Boolean(env.FIREBASE_SERVICE_ACCOUNT) })
    }

    const route = url.pathname.replace(/^\/api\//, '')
    if (request.method !== 'POST' || route === url.pathname) {
      return json(request, env, { ok: false, error: 'Not found.' }, 404)
    }

    // the browser's silent Firebase session proves who is calling
    const token = (request.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '')
    const claims = token ? await verifyFirebaseToken(token, env.FIREBASE_PROJECT_ID) : null
    if (!claims) {
      return json(request, env, { ok: false, error: 'Your session expired. Reload the page.' }, 401)
    }

    const developerToken = request.headers.get('X-Developer-Token') ?? ''
    const isDeveloper = developerToken
      ? isDeveloperClaims(await verifyFirebaseToken(developerToken, env.FIREBASE_PROJECT_ID), env.DEVELOPER_EMAIL)
      : false

    let body: Record<string, unknown>
    try {
      body = (await request.json()) as Record<string, unknown>
    } catch {
      return json(request, env, { ok: false, error: 'Bad request.' }, 400)
    }

    const playerId = String(body.playerId ?? '')
    if (!PLAYER_ID_PATTERN.test(playerId)) {
      return json(request, env, { ok: false, error: 'Unknown player.' }, 400)
    }

    const caller: Caller = { playerId, uid: claims.sub, isDeveloper }
    const vaultFor = (id: string) => env.PLAYERS.get(env.PLAYERS.idFromName(id))

    // ---------- single-player games ----------
    const gameCall = PLAYER_ROUTES[route]
    if (gameCall) {
      return json(request, env, await gameCall(vaultFor(playerId), caller, body))
    }

    // ---------- poker ----------
    if (route.startsWith('poker/')) {
      // make sure the caller really owns this player before seating them
      const owner = await vaultFor(playerId).authorize(caller)
      if (!owner.ok) {
        return json(request, env, owner, 403)
      }

      const action = route.slice('poker/'.length)
      if (action === 'create') {
        for (let attempt = 0; attempt < 12; attempt += 1) {
          const code = createPokerRoomCode()
          const table = env.TABLES.get(env.TABLES.idFromName(code))
          if (!(await table.exists())) {
            return json(request, env, await table.create(caller, code, body as never))
          }
        }
        return json(request, env, { ok: false, error: 'Could not find a free room code. Try again.' })
      }

      const code = String(body.code ?? '').trim().toUpperCase()
      if (!ROOM_CODE_PATTERN.test(code)) {
        return json(request, env, { ok: false, error: 'Join codes must be exactly 4 letters or numbers.' })
      }
      const table = env.TABLES.get(env.TABLES.idFromName(code))
      if (action === 'close') {
        if (!isDeveloper) {
          return json(request, env, { ok: false, error: 'Developer only.' }, 403)
        }
        return json(request, env, await table.close(caller))
      }
      if (!POKER_ACTIONS.includes(action as PokerAction)) {
        return json(request, env, { ok: false, error: 'Not found.' }, 404)
      }
      return json(request, env, await table.act(caller, action as PokerAction, body))
    }

    // ---------- developer tools ----------
    if (route.startsWith('admin/')) {
      if (!isDeveloper) {
        return json(request, env, { ok: false, error: 'Developer only.' }, 403)
      }
      if (route === 'admin/usage') {
        return json(request, env, { ok: true, usage: await usageMonitor(env).latest() })
      }
      if (route === 'admin/usage-test') {
        return json(request, env, await usageMonitor(env).sendTest())
      }
      const targetId = String(body.targetPlayerId ?? '')
      if (!PLAYER_ID_PATTERN.test(targetId)) {
        return json(request, env, { ok: false, error: 'Unknown player.' }, 400)
      }
      const target = vaultFor(targetId)
      const adminCaller: Caller = { playerId: targetId, uid: claims.sub, isDeveloper: true }
      if (route === 'admin/set-balance') {
        return json(request, env, await target.adminSetBalance(adminCaller, Number(body.bankroll)))
      }
      if (route === 'admin/adjust') {
        return json(request, env, await target.adminAdjust(adminCaller, Number(body.amount)))
      }
      if (route === 'admin/delete-player') {
        return json(request, env, await target.adminDelete(adminCaller))
      }
    }

    return json(request, env, { ok: false, error: 'Not found.' }, 404)
  },

  // every 15 minutes: check the free-plan limits and alert if one is close
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(usageMonitor(env).check())
  },
}
