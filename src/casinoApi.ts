// Talks to the casino game server (a Cloudflare Worker). Every bet goes
// through here: the server decides the outcome and keeps the balance, and the
// page just plays the animation for the result it gets back.
import { getDeveloperIdToken, getPlayerIdToken } from './firebase'

export const CASINO_API_URL = (import.meta.env.VITE_CASINO_API_URL as string | undefined) ?? 'https://ues-casino.c28aa1-rgb.workers.dev'

export class CasinoError extends Error {
  balance?: number

  constructor(message: string, balance?: number) {
    super(message)
    this.balance = balance
  }
}

export type CasinoResponse<T> = T & { ok: true; balance: number }

export const casinoCall = async <T = Record<string, unknown>>(
  route: string,
  body: Record<string, unknown>,
): Promise<CasinoResponse<T>> => {
  const [playerToken, developerToken] = await Promise.all([getPlayerIdToken(), getDeveloperIdToken().catch(() => null)])
  if (!playerToken) {
    throw new CasinoError('Could not connect to the casino. Reload the page.')
  }

  let response: Response
  try {
    response = await fetch(`${CASINO_API_URL}/api/${route}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${playerToken}`,
        ...(developerToken ? { 'X-Developer-Token': developerToken } : {}),
      },
      body: JSON.stringify(body),
    })
  } catch {
    throw new CasinoError('Could not reach the casino. Check your connection and try again.')
  }

  const payload = (await response.json().catch(() => null)) as
    | (CasinoResponse<T> & { ok: true })
    | { ok: false; error?: string; balance?: number }
    | null

  if (!payload || !payload.ok) {
    throw new CasinoError(
      (payload && 'error' in payload && payload.error) || 'The casino had a problem. Try again.',
      payload && typeof payload.balance === 'number' ? payload.balance : undefined,
    )
  }

  return payload
}

// Wakes nothing (Workers are always on) but checks the server is reachable.
export const casinoHealth = () => fetch(`${CASINO_API_URL}/health`).then((response) => response.ok).catch(() => false)
