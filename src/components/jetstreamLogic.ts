// Jetstream — modeled on Aviamasters (BGaming), the viral plane game on Rainbet.
//
// You pick a speed and press Play. A red prop plane launches off an aircraft
// carrier and flies on its own. Along the way it flies through pickups that
// grow your counter (+0.1x … +2x adds, ×1.5 … ×5 boosts) and gets clipped by
// rockets that halve it. The flight ends one of two ways: the plane lands on
// the next carrier and the counter is paid out, or it goes into the sea and the
// bet is lost. There is no cash-out button — the landing is the cash-out.
//
// Fairness: the flight path (pickups and rockets) is drawn first, then whether
// it lands is decided with a fixed probability per speed, land = RTP / E[C],
// where E[C] is the exact expected counter for that speed. Expected payout is
// therefore exactly RTP on every speed; faster speeds just swing harder
// (bigger pickups, more rockets, fewer landings).

export type JetSpeed = 'slow' | 'normal' | 'fast' | 'turbo'
export type JetEventType = 'add' | 'mult' | 'rocket'

export interface JetEvent {
  type: JetEventType
  value: number
  label: string
  lift: number // 0..1 flight altitude where the event sits
  counterAfter: number
}

export interface JetFlight {
  id: string
  speed: JetSpeed
  events: JetEvent[]
  landed: boolean
  // index of the rocket that knocks the plane into the sea mid-flight;
  // null means it reaches the landing carrier (and either lands or falls short)
  downedAt: number | null
  endCounter: number
  payoutMultiplier: number
}

type Weighted = [number, number][] // [value, probability]

interface SpeedConfig {
  label: string
  risk: number // 1..4, for the UI meter
  events: [number, number]
  weights: { add: number; mult: number; rocket: number }
  add: Weighted
  mult: Weighted
  cruise: number // plane speed in scene units per second
}

export const JET_RTP = 0.97
export const JET_MAX_MULTIPLIER = 250

export const JET_SPEED_ORDER: JetSpeed[] = ['slow', 'normal', 'fast', 'turbo']

export const JET_SPEEDS: Record<JetSpeed, SpeedConfig> = {
  slow: {
    label: 'Slow',
    risk: 1,
    events: [4, 6],
    weights: { add: 0.6, mult: 0.14, rocket: 0.26 },
    add: [[0.1, 0.4], [0.2, 0.35], [0.5, 0.2], [1, 0.05]],
    mult: [[1.5, 0.7], [2, 0.3]],
    cruise: 290,
  },
  normal: {
    label: 'Normal',
    risk: 2,
    events: [5, 7],
    weights: { add: 0.56, mult: 0.16, rocket: 0.28 },
    add: [[0.1, 0.32], [0.2, 0.34], [0.5, 0.24], [1, 0.1]],
    mult: [[1.5, 0.6], [2, 0.32], [3, 0.08]],
    cruise: 360,
  },
  fast: {
    label: 'Fast',
    risk: 3,
    events: [6, 8],
    weights: { add: 0.52, mult: 0.17, rocket: 0.31 },
    add: [[0.1, 0.25], [0.2, 0.35], [0.5, 0.28], [1, 0.12]],
    mult: [[1.5, 0.55], [2, 0.32], [3, 0.1], [5, 0.03]],
    cruise: 450,
  },
  turbo: {
    label: 'Turbo',
    risk: 4,
    events: [7, 9],
    weights: { add: 0.48, mult: 0.18, rocket: 0.34 },
    add: [[0.2, 0.3], [0.5, 0.35], [1, 0.25], [2, 0.1]],
    mult: [[1.5, 0.5], [2, 0.32], [3, 0.13], [5, 0.05]],
    cruise: 560,
  },
}

// Exact expected final counter for a speed (start at 1, linear recursion per event).
function expectedCounter(cfg: SpeedConfig): number {
  const eAdd = cfg.add.reduce((sum, [v, p]) => sum + v * p, 0)
  const eMult = cfg.mult.reduce((sum, [v, p]) => sum + v * p, 0)
  const a = cfg.weights.add + cfg.weights.mult * eMult + cfg.weights.rocket * 0.5
  const b = cfg.weights.add * eAdd
  let total = 0
  let count = 0
  for (let n = cfg.events[0]; n <= cfg.events[1]; n += 1) {
    let e = 1
    for (let i = 0; i < n; i += 1) e = a * e + b
    total += e
    count += 1
  }
  return total / count
}

export const JET_LAND_CHANCE: Record<JetSpeed, number> = {
  slow: Math.min(1, JET_RTP / expectedCounter(JET_SPEEDS.slow)),
  normal: Math.min(1, JET_RTP / expectedCounter(JET_SPEEDS.normal)),
  fast: Math.min(1, JET_RTP / expectedCounter(JET_SPEEDS.fast)),
  turbo: Math.min(1, JET_RTP / expectedCounter(JET_SPEEDS.turbo)),
}

function pick(table: Weighted): number {
  const r = Math.random()
  let acc = 0
  for (const [value, p] of table) {
    acc += p
    if (r < acc) return value
  }
  return table[table.length - 1][0]
}

function trimNumber(v: number): string {
  return Number.isInteger(v) ? String(v) : String(Math.round(v * 100) / 100)
}

export function generateFlight(speed: JetSpeed): JetFlight {
  const cfg = JET_SPEEDS[speed]
  const count = cfg.events[0] + Math.floor(Math.random() * (cfg.events[1] - cfg.events[0] + 1))
  const events: JetEvent[] = []
  let counter = 1
  let lift = 0.45
  for (let i = 0; i < count; i += 1) {
    // altitude wanders smoothly rather than jumping around
    lift = Math.max(0.05, Math.min(0.95, lift + (Math.random() - 0.5) * 0.7))
    const r = Math.random()
    if (r < cfg.weights.add) {
      const v = pick(cfg.add)
      counter += v
      events.push({ type: 'add', value: v, label: `+${trimNumber(v)}x`, lift, counterAfter: 0 })
    } else if (r < cfg.weights.add + cfg.weights.mult) {
      const v = pick(cfg.mult)
      counter *= v
      events.push({ type: 'mult', value: v, label: `×${trimNumber(v)}`, lift, counterAfter: 0 })
    } else {
      counter /= 2
      events.push({ type: 'rocket', value: 2, label: '÷2', lift, counterAfter: 0 })
    }
    counter = Math.min(JET_MAX_MULTIPLIER, counter)
    events[i].counterAfter = counter
  }

  const landed = Math.random() < JET_LAND_CHANCE[speed]
  let downedAt: number | null = null
  if (!landed) {
    const rockets = events.map((e, i) => (e.type === 'rocket' ? i : -1)).filter((i) => i >= 0)
    if (rockets.length > 0 && Math.random() < 0.45) {
      downedAt = rockets[Math.floor(Math.random() * rockets.length)]
    }
  }
  const lastReached = downedAt ?? events.length - 1
  const endCounter = lastReached >= 0 ? events[lastReached].counterAfter : 1

  return {
    id: `flight-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    speed,
    events,
    landed,
    downedAt,
    endCounter,
    payoutMultiplier: landed ? Math.round(endCounter * 100) / 100 : 0,
  }
}

export function formatMultiplier(value: number): string {
  return `${value.toFixed(2)}x`
}
