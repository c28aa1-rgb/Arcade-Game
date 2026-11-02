// Chicken Cross (Rainbet "Chicken Road" / Roobet "Mission Uncrossable" style).
//
// The public game only advertises, per difficulty: a starting multiplier, a
// maximum multiplier at the final lane, and a rough per-lane collision chance.
// The exact per-lane multiplier table is not published, so we reconstruct a
// provably-fair table that hits the real anchors (start + max over 24 lanes)
// with a smooth exponential progression.
//
// Fairness model: the probability of reaching lane i is S[i] = RTP / m[i], so
// the expected value of cashing out at ANY lane equals RTP exactly, regardless
// of how far the player pushes. The per-step survival chance is therefore
// s[i] = S[i] / S[i-1] = m[i-1] / m[i] (with a virtual m[0] = RTP for the very
// first hop). This is the same math real provably-fair crash/chicken games use.

export type ChickenDifficulty = 'easy' | 'medium' | 'hard' | 'daredevil'

export const CHICKEN_LANES = 24
export const CHICKEN_RTP = 0.98

export interface ChickenDifficultyConfig {
  id: ChickenDifficulty
  label: string
  blurb: string
  // Advertised per-lane collision chance (used only for the info panel).
  hitLabel: string
  start: number
  max: number
  // multipliers[i] is the cash-out multiplier once the chicken stands on
  // lane (i + 1). Length === CHICKEN_LANES.
  multipliers: number[]
  // survival[i] is the chance of surviving the hop ONTO lane (i + 1).
  survival: number[]
}

// Round to 2 decimals, but keep large payouts readable.
function roundMultiplier(value: number): number {
  if (value >= 1000) {
    return Math.round(value * 100) / 100
  }
  return Math.round(value * 100) / 100
}

// Pure geometric progression from `start` to `max` across CHICKEN_LANES lanes.
function buildMultipliers(start: number, max: number): number[] {
  const ratio = Math.pow(max / start, 1 / (CHICKEN_LANES - 1))
  const table: number[] = []
  for (let lane = 0; lane < CHICKEN_LANES; lane += 1) {
    const raw = lane === CHICKEN_LANES - 1 ? max : start * Math.pow(ratio, lane)
    table.push(roundMultiplier(raw))
  }
  return table
}

// Per-step survival derived from the (rounded) multiplier table so the shown
// numbers and the real odds always agree.
function buildSurvival(multipliers: number[]): number[] {
  const survival: number[] = []
  for (let lane = 0; lane < multipliers.length; lane += 1) {
    const previous = lane === 0 ? CHICKEN_RTP : multipliers[lane - 1]
    const chance = previous / multipliers[lane]
    survival.push(Math.min(1, Math.max(0, chance)))
  }
  return survival
}

function buildConfig(
  id: ChickenDifficulty,
  label: string,
  blurb: string,
  hitLabel: string,
  start: number,
  max: number,
): ChickenDifficultyConfig {
  const multipliers = buildMultipliers(start, max)
  return { id, label, blurb, hitLabel, start, max, multipliers, survival: buildSurvival(multipliers) }
}

export const CHICKEN_DIFFICULTIES: Record<ChickenDifficulty, ChickenDifficultyConfig> = {
  easy: buildConfig('easy', 'Easy', 'Gentle traffic, steady climb.', '~4% / lane', 1.02, 24),
  medium: buildConfig('medium', 'Medium', 'Busier road, bigger jumps.', '~12% / lane', 1.09, 2208),
  hard: buildConfig('hard', 'Hard', 'Heavy traffic, brutal payouts.', '~20% / lane', 1.2, 51004.8),
  daredevil: buildConfig('daredevil', 'Daredevil', 'One nudge from a fortune.', '~40% / lane', 1.6, 3138009.6),
}

export const CHICKEN_DIFFICULTY_ORDER: ChickenDifficulty[] = ['easy', 'medium', 'hard', 'daredevil']

export function getChickenConfig(difficulty: ChickenDifficulty): ChickenDifficultyConfig {
  return CHICKEN_DIFFICULTIES[difficulty]
}

// Roll the hop onto `laneIndex` (0-based). Returns true if the chicken survives.
export function rollChickenHop(config: ChickenDifficultyConfig, laneIndex: number): boolean {
  const chance = config.survival[laneIndex] ?? 0
  return Math.random() < chance
}

export function formatChickenMultiplier(value: number): string {
  if (value >= 1000) {
    return `${value.toLocaleString('en-US', { maximumFractionDigits: 2 })}x`
  }
  return `${value.toFixed(2)}x`
}
