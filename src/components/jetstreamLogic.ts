// Jetstream — an Aviamasters-style carrier game.
//
// The seaplane launches from a carrier and hops carrier to carrier. Between
// carriers it flies through nodes — × multipliers and ÷2 dividers — that build
// up a running multiplier. At any carrier you can LAND (cash out at the current
// multiplier) or FLY ON toward a bigger one, risking a splash into the sea.
//
// Fairness is the same model as Chicken Cross: the chance of reaching carrier i
// is S_i = RTP / M_i, so the expected value of landing at ANY carrier equals RTP
// (constant house edge). Per-hop survival s_i = M_{i-1} / M_i, with a virtual
// M_0 = RTP baked into the first hop. The nodes genuinely produce M_i (each hop
// nets a gain), so the numbers you see are the numbers that matter.

export type JetNodeType = 'mult' | 'div'
export interface JetNode {
  type: JetNodeType
  value: number
  label: string
}
export interface JetRound {
  carriers: number
  multipliers: number[] // M at carrier i+1 (index 0 = first carrier)
  survival: number[] // chance of surviving the hop that reaches carrier i+1
  nodes: JetNode[][] // nodes flown through on the hop that reaches carrier i+1
}

export const JET_RTP = 0.97
export const JET_CARRIERS = 12
export const JET_FLIGHT_MS = 1050

const MULT_VALUES = [1.3, 1.5, 1.8, 2, 2.5, 3]
const FIRST_HOP = [1.1, 1.15, 1.2]

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}

export function generateRound(): JetRound {
  const multipliers: number[] = []
  const survival: number[] = []
  const nodes: JetNode[][] = []
  let m = 1
  let previous = JET_RTP // virtual M_0 → house edge lands on the launch hop

  for (let i = 0; i < JET_CARRIERS; i += 1) {
    const seg: JetNode[] = []

    if (i === 0) {
      const k = pick(FIRST_HOP)
      seg.push({ type: 'mult', value: k, label: `×${k}` })
    } else {
      const useDivider = Math.random() < 0.25
      if (useDivider) seg.push({ type: 'div', value: 2, label: '÷2' })
      const boosts = useDivider ? 2 : Math.random() < 0.45 ? 2 : 1
      for (let b = 0; b < boosts; b += 1) {
        const k = pick(MULT_VALUES)
        seg.push({ type: 'mult', value: k, label: `×${k}` })
      }
    }

    let product = 1
    for (const node of seg) product *= node.type === 'div' ? 1 / node.value : node.value
    if (product <= 1.05) {
      seg.push({ type: 'mult', value: 1.5, label: '×1.5' })
      product *= 1.5
    }

    const nextM = round2(m * product)
    multipliers.push(nextM)
    survival.push(Math.min(1, Math.max(0, previous / nextM)))
    nodes.push(seg)
    previous = nextM
    m = nextM
  }

  return { carriers: JET_CARRIERS, multipliers, survival, nodes }
}

// true = the plane survives the hop onto carrier (carrierIndex is 1-based).
export function rollJetHop(round: JetRound, carrierIndex: number): boolean {
  const chance = round.survival[carrierIndex - 1] ?? 0
  return Math.random() < chance
}

export function formatMultiplier(value: number): string {
  if (value >= 1000) {
    return `${value.toLocaleString('en-US', { maximumFractionDigits: 2 })}x`
  }
  return `${value.toFixed(2)}x`
}
