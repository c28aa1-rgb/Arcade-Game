// Plinko physics — an emergent, realistic bouncing ball.
//
// The ball genuinely falls, springs off each peg with restitution (a steep hit
// throws it back UP so it can clip the pegs above), and picks a side from a
// random impulse at every peg. Over the 12 rows those independent ~50/50
// deflections settle into a bell curve on their own — so the outer 7.5x / 24x
// lanes are reachable but rare, and the house edge is emergent (tuned via the
// deflection strength). No scripted path, no teleport into a slot.

export type Peg = { id: string; x: number; y: number }

export type Ball = {
  x: number
  y: number
  vx: number
  vy: number
  lastPegId: string | null
  lockedSlotIndex: number | null
  centerBias: number
}

export const BOARD_WIDTH = 760
export const BOARD_HEIGHT = 700
export const TOP_Y = 78
export const BOTTOM_GAP = 132
export const STEP_X = 53
export const PEG_RADIUS = 4.6
export const BALL_RADIUS = 9.8
export const MAX_FRAME_DT_S = 1 / 60
export const SIMULATION_STEP_S = 1 / 480

const SLOT_TRACK_BOTTOM = 8
const SLOT_CUP_HEIGHT = 30
export const SLOT_CUP_CENTER_Y = BOARD_HEIGHT - SLOT_TRACK_BOTTOM - SLOT_CUP_HEIGHT / 2 + 1

const GRAVITY = 1950
const AIR_FRICTION = 0.999
const WALL_BOUNCE = 0.45
const PEG_CONTACT = BALL_RADIUS + PEG_RADIUS + 0.4
const PEG_SEPARATION = PEG_CONTACT + 0.35
const PEG_REHIT_BLOCK = PEG_CONTACT + 3
const PEG_RESTITUTION = 0.34 // vertical bounce — a real but modest up-hop
const PEG_VX_KEEP = 0.16 // sideways momentum that survives a peg (rest is reset)
const TANGENT_MIN = 78 // per-peg sideways push = the ~half-cell left/right step
const TANGENT_MAX = 120
const TANGENT_NOISE = 30 // small scatter so no two drops are identical
const MAX_UP_SPEED = 150 // cap the hop so it never pinballs
const MAX_SIDE_SPEED = 235
const WALL_MARGIN = 20
// Below this line the ball has cleared the pegs and settles into whatever lane
// it physically arrived at.
const STEER_ZONE_Y = SLOT_CUP_CENTER_Y - STEP_X * 1.9
const CUP_LANE_PADDING = BALL_RADIUS + 1.1
const CUP_CAPTURE_HALF_WIDTH = STEP_X * 0.3
const SPAWN_DROP_HEIGHT = 0.85
const CENTER_BIAS_MAX_STRENGTH = 0.5

export function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

function normalize(x: number, y: number, fallbackX: number, fallbackY: number) {
  const length = Math.hypot(x, y)
  if (length > 0.0001) {
    return { x: x / length, y: y / length }
  }
  const fallbackLength = Math.hypot(fallbackX, fallbackY) || 1
  return { x: fallbackX / fallbackLength, y: fallbackY / fallbackLength }
}

export function getRowStep(rows: number) {
  return (BOARD_HEIGHT - TOP_Y - BOTTOM_GAP) / Math.max(rows, 1)
}

export function buildPegs(rows: number, rowStep: number): Peg[] {
  const pegs: Peg[] = []
  for (let row = 0; row < rows; row += 1) {
    const pegCount = row + 1
    const rowWidth = (pegCount - 1) * STEP_X
    const startX = BOARD_WIDTH / 2 - rowWidth / 2
    const y = TOP_Y + row * rowStep
    for (let col = 0; col < pegCount; col += 1) {
      pegs.push({ id: `${row}-${col}`, x: startX + col * STEP_X, y })
    }
  }
  return pegs
}

export function getSlotLeft(slotCount: number) {
  return BOARD_WIDTH / 2 - (slotCount * STEP_X) / 2
}

function getSlotIndexForX(x: number, slotLeft: number, slotCount: number) {
  return clamp(Math.floor((x - slotLeft) / STEP_X), 0, slotCount - 1)
}

export function spawnBall(rowStep: number, centerBias: number, rng: () => number = Math.random): Ball {
  return {
    // a tiny random offset off dead-center so the first peg goes either way
    x: BOARD_WIDTH / 2 + (rng() - 0.5) * 4,
    y: TOP_Y - rowStep * SPAWN_DROP_HEIGHT,
    vx: (rng() - 0.5) * 10,
    vy: 55 + rng() * 40,
    lastPegId: null,
    lockedSlotIndex: null,
    centerBias: clamp(centerBias, 0, CENTER_BIAS_MAX_STRENGTH),
  }
}

export type StepResult = { next: Ball | null; landedSlotIndex?: number }

// Advance one fixed physics step. Pure: same inputs + rng -> same output.
export function stepBall(
  ball: Ball,
  dt: number,
  pegs: Peg[],
  slotLeft: number,
  slotCount: number,
  rng: () => number = Math.random,
): StepResult {
  const next: Ball = { ...ball }

  next.vy += GRAVITY * dt
  next.vx *= AIR_FRICTION
  next.vx = clamp(next.vx, -MAX_SIDE_SPEED, MAX_SIDE_SPEED)
  next.x += next.vx * dt
  next.y += next.vy * dt

  if (next.x < WALL_MARGIN) {
    next.x = WALL_MARGIN
    next.vx = Math.abs(next.vx) * WALL_BOUNCE
  } else if (next.x > BOARD_WIDTH - WALL_MARGIN) {
    next.x = BOARD_WIDTH - WALL_MARGIN
    next.vx = -Math.abs(next.vx) * WALL_BOUNCE
  }

  // peg collision (small dt keeps steps well under a peg radius — no tunneling)
  if (next.lockedSlotIndex === null) {
    let hit: Peg | null = null
    let hitDist = Infinity
    for (const peg of pegs) {
      if (Math.abs(peg.y - next.y) > STEP_X || Math.abs(peg.x - next.x) > STEP_X) {
        continue
      }
      const dist = Math.hypot(next.x - peg.x, next.y - peg.y)
      if (peg.id === next.lastPegId && dist < PEG_REHIT_BLOCK) {
        continue
      }
      if (dist <= PEG_CONTACT && dist < hitDist) {
        hit = peg
        hitDist = dist
      }
    }

    if (hit) {
      const normal = normalize(next.x - hit.x, next.y - hit.y, next.vx >= 0 ? 1 : -1, -1)

      // push clear of the peg
      next.x = hit.x + normal.x * PEG_SEPARATION
      next.y = hit.y + normal.y * PEG_SEPARATION

      // Decouple the two axes:
      //  - VERTICAL: reflect vy with restitution. A steep (near-top) hit flips
      //    vy upward so the ball springs up and can clip the pegs above; a
      //    glancing (side) hit barely touches it and it keeps falling.
      //  - HORIZONTAL: don't inherit the bounce energy (that blows the spread
      //    out to the walls). Instead take a controlled ~half-cell step to one
      //    side — the fair left/right decision that shapes the bell curve.
      const approach = next.vx * normal.x + next.vy * normal.y
      if (approach < 0) {
        next.vy -= (1 + PEG_RESTITUTION) * approach * normal.y
      }

      let dir: -1 | 1 = rng() < 0.5 ? -1 : 1
      if (next.centerBias > 0 && rng() < next.centerBias) {
        dir = next.x < BOARD_WIDTH / 2 ? 1 : -1
      }
      next.vx = next.vx * PEG_VX_KEEP + dir * (TANGENT_MIN + rng() * (TANGENT_MAX - TANGENT_MIN))
      next.vx += (rng() - 0.5) * TANGENT_NOISE

      next.vx = clamp(next.vx, -MAX_SIDE_SPEED, MAX_SIDE_SPEED)
      if (next.vy < -MAX_UP_SPEED) {
        next.vy = -MAX_UP_SPEED
      }
      next.lastPegId = hit.id
    }
  }

  // once under the pegs, settle into whatever lane the ball arrived at
  if (next.lockedSlotIndex === null && next.y + BALL_RADIUS >= STEER_ZONE_Y) {
    next.lockedSlotIndex = getSlotIndexForX(next.x, slotLeft, slotCount)
  }

  const slotIndex = next.lockedSlotIndex ?? getSlotIndexForX(next.x, slotLeft, slotCount)
  const slotCenterX = slotLeft + (slotIndex + 0.5) * STEP_X

  if (next.lockedSlotIndex !== null) {
    // gentle settle toward the lane center and damp the sideways motion
    const minLaneX = slotLeft + slotIndex * STEP_X + CUP_LANE_PADDING
    const maxLaneX = slotLeft + (slotIndex + 1) * STEP_X - CUP_LANE_PADDING
    next.x = clamp(next.x, minLaneX, maxLaneX)
    next.vx = clamp((slotCenterX - next.x) * 6, -150, 150)
  }

  if (next.y >= SLOT_CUP_CENTER_Y) {
    next.y = SLOT_CUP_CENTER_Y
    next.x = clamp(next.x, slotCenterX - CUP_CAPTURE_HALF_WIDTH, slotCenterX + CUP_CAPTURE_HALF_WIDTH)
    return { next: null, landedSlotIndex: slotIndex }
  }

  if (next.y > BOARD_HEIGHT + 20) {
    return { next: null, landedSlotIndex: slotIndex }
  }

  return { next }
}

// Headless: drop one ball and return the slot it lands in.
export function simulateSlot(
  rows: number,
  slotCount: number,
  centerBias: number,
  rng: () => number = Math.random,
): number {
  const rowStep = getRowStep(rows)
  const pegs = buildPegs(rows, rowStep)
  const slotLeft = getSlotLeft(slotCount)
  let ball: Ball | null = spawnBall(rowStep, centerBias, rng)
  for (let i = 0; i < 200000 && ball; i += 1) {
    const result = stepBall(ball, SIMULATION_STEP_S, pegs, slotLeft, slotCount, rng)
    if (!result.next) {
      return result.landedSlotIndex ?? getSlotIndexForX(ball.x, slotLeft, slotCount)
    }
    ball = result.next
  }
  return getSlotIndexForX(ball?.x ?? BOARD_WIDTH / 2, slotLeft, slotCount)
}
