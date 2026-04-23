import { useEffect, useMemo, useRef, useState } from 'react'

type PendingPlinkoDrop = {
  id: string
  bet: number
  centerBias: number
}

type PlinkoBoardProps = {
  rows: number
  multipliers: number[]
  pendingDrops: PendingPlinkoDrop[]
  onBallSettled?: (dropId: string, slotIndex: number) => void | Promise<void>
}

type Peg = {
  id: string
  x: number
  y: number
}

type ActiveBall = {
  id: string
  x: number
  y: number
  vx: number
  vy: number
  driftVx: number
  settleMs: number
  color: string
  lastPegId: string | null
  pegCooldownMs: number
  topPegDirection: -1 | 1
  topPegLane: 'inside' | 'outside'
  topPegResolved: boolean
  lastBounceDirection: -1 | 1 | null
  lockedSlotIndex: number | null
  centerBias: number
}

const BOARD_WIDTH = 760
const BOARD_HEIGHT = 700
const TOP_Y = 78
const BOTTOM_GAP = 132
const STEP_X = 53
const PEG_RADIUS = 4.6
const BALL_RADIUS = 9.8
const MAX_FRAME_DT_S = 1 / 60
const SIMULATION_STEP_S = 1 / 480
const SLOT_TRACK_BOTTOM = 8
const SLOT_CUP_HEIGHT = 30
const SLOT_CUP_CENTER_Y = BOARD_HEIGHT - SLOT_TRACK_BOTTOM - SLOT_CUP_HEIGHT / 2 + 1

const GRAVITY = 1600
const DESCENT_DAMPING = 0.9985
const ASCENT_SIDE_DAMPING = 0.86
const WALL_BOUNCE = 0.3
const MAX_SIDE_SPEED = 58
const ASCENT_MAX_SIDE_SPEED = 3.2
const PEG_CONTACT_DISTANCE = BALL_RADIUS + PEG_RADIUS + 0.7
const PEG_VISUAL_RADIUS = PEG_CONTACT_DISTANCE - BALL_RADIUS
const PEG_VISUAL_Y_SCALE = 0.988
const PEG_RESTITUTION = 1.22
const PEG_SEPARATION_DISTANCE = PEG_CONTACT_DISTANCE + 1.34
const PEG_REHIT_BLOCK_DISTANCE = PEG_CONTACT_DISTANCE + 10
const PEG_SWEEP_CONTACT_DISTANCE = PEG_CONTACT_DISTANCE + 0.8
const PEG_TANGENT_DAMPING = 0.94
const PEG_RANDOM_TANGENT = 0.04
const PEG_MIN_TANGENT_SPEED = 1.4
const PEG_ANGLE_JITTER_DEG = 1.1
const PEG_MIN_RELEASE_SPEED = 144
const PEG_MAX_UPWARD_SPEED = 205
const PEG_MIN_DOWNWARD_SPEED = 0
const PEG_SIDE_PUSH = 0.42
const PEG_SIDE_NUDGE_MIN = 7.5
const PEG_SIDE_NUDGE_MAX = 15.5
const PEG_BOUNCE_UPWARD_MIN = 150
const PEG_BOUNCE_UPWARD_MAX = 230
const PEG_DRIFT_IMPULSE_MIN = 12
const PEG_DRIFT_IMPULSE_MAX = 22
const PEG_DRIFT_DECAY = 0.975
const PEG_DRIFT_MAX = 52
const PEG_DIRECTION_REPEAT_CHANCE = 0.8
const TOP_PEG_ID = '0-0'
const TOP_DROP_HIT_OFFSET_INSIDE_MIN = PEG_RADIUS * 0.08
const TOP_DROP_HIT_OFFSET_INSIDE_MAX = PEG_RADIUS * 0.22
const TOP_PEG_CENTER_BIAS = PEG_RADIUS * 0.48
const TOP_PEG_OUTSIDE_CHANCE = 0.94
const TOP_PEG_INSIDE_NUDGE_MIN = 2.8
const TOP_PEG_INSIDE_NUDGE_MAX = 5.3
const TOP_PEG_OUTSIDE_NUDGE_MIN = 15
const TOP_PEG_OUTSIDE_NUDGE_MAX = 24
const TOP_PEG_INSIDE_RELEASE_MULTIPLIER = 1.12
const TOP_PEG_OUTSIDE_RELEASE_MULTIPLIER = 2.35
const TOP_PEG_SEPARATION_DISTANCE = PEG_CONTACT_DISTANCE + 1.38
const TOP_PEG_MIN_DOWNWARD_SPEED = 72
const TOP_PEG_MAX_SIDE_SPEED = 68
const SPAWN_DROP_HEIGHT = 1.45
const SPAWN_INITIAL_DOWN_SPEED_MIN = 48
const SPAWN_INITIAL_DOWN_SPEED_MAX = 90
const CUP_WALL_TOP_Y = SLOT_CUP_CENTER_Y - STEP_X * 1.2
const CUP_ENTRY_Y = SLOT_CUP_CENTER_Y - SLOT_CUP_HEIGHT / 2 - BALL_RADIUS * 0.28
const CUP_LANE_PADDING = BALL_RADIUS + 1.1
const CUP_CAPTURE_HALF_WIDTH = STEP_X * 0.28
const CUP_PULL_STEP = 1.05
const CENTER_BIAS_DRIFT_PULL = 1.6
const CENTER_BIAS_VELOCITY_PULL = 0.3

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

function moveToward(current: number, target: number, maxDelta: number) {
  if (Math.abs(target - current) <= maxDelta) {
    return target
  }

  return current + Math.sign(target - current) * maxDelta
}

function randomBetween(min: number, max: number) {
  return min + Math.random() * (max - min)
}

function closestPointOnSegment(ax: number, ay: number, bx: number, by: number, px: number, py: number) {
  const abx = bx - ax
  const aby = by - ay
  const denom = abx * abx + aby * aby

  if (denom < 0.0001) {
    return { x: ax, y: ay }
  }

  const t = clamp(((px - ax) * abx + (py - ay) * aby) / denom, 0, 1)
  return {
    x: ax + abx * t,
    y: ay + aby * t,
  }
}

function normalize(x: number, y: number, fallbackX: number, fallbackY: number) {
  const length = Math.hypot(x, y)
  if (length > 0.0001) {
    return { x: x / length, y: y / length }
  }

  const fallbackLength = Math.hypot(fallbackX, fallbackY) || 1
  return {
    x: fallbackX / fallbackLength,
    y: fallbackY / fallbackLength,
  }
}

function rotateVector(x: number, y: number, radians: number) {
  const cos = Math.cos(radians)
  const sin = Math.sin(radians)
  return {
    x: x * cos - y * sin,
    y: x * sin + y * cos,
  }
}

function buildPegs(rows: number, rowStep: number): Peg[] {
  const pegs: Peg[] = []

  for (let row = 0; row < rows; row += 1) {
    const pegCount = row + 1
    const rowWidth = (pegCount - 1) * STEP_X
    const startX = BOARD_WIDTH / 2 - rowWidth / 2
    const y = TOP_Y + row * rowStep

    for (let col = 0; col < pegCount; col += 1) {
      pegs.push({
        id: `${row}-${col}`,
        x: startX + col * STEP_X,
        y,
      })
    }
  }

  return pegs
}

function getBallColor(dropId: string) {
  const palette = ['#ff5c87', '#ff7a5a', '#ffcf5a', '#8cf87d', '#7fd8ff', '#d68cff']
  let hash = 0

  for (const char of dropId) {
    hash = (hash + char.charCodeAt(0)) % palette.length
  }

  return palette[hash]
}

function getSlotStyle(multiplier: number) {
  if (multiplier >= 4) {
    return 'slot-chip hot'
  }

  if (multiplier >= 2) {
    return 'slot-chip warm'
  }

  if (multiplier <= 1) {
    return 'slot-chip cold'
  }

  return 'slot-chip'
}

function formatMultiplier(multiplier: number) {
  return Number.isInteger(multiplier) ? `${multiplier}x` : `${multiplier.toFixed(1)}x`
}

function getSlotIndexForX(x: number, slotLeft: number, slotCount: number) {
  return clamp(Math.floor((x - slotLeft) / STEP_X), 0, slotCount - 1)
}

function getVisualPegY(y: number) {
  return TOP_Y + (y - TOP_Y) * PEG_VISUAL_Y_SCALE
}

function drawBoard(
  ctx: CanvasRenderingContext2D,
  pegs: Peg[],
  multipliers: number[],
  activeBalls: ActiveBall[],
  slotLeft: number,
) {
  ctx.clearRect(0, 0, BOARD_WIDTH, BOARD_HEIGHT)

  const bgGradient = ctx.createLinearGradient(0, 0, 0, BOARD_HEIGHT)
  bgGradient.addColorStop(0, '#110817')
  bgGradient.addColorStop(0.52, '#17092a')
  bgGradient.addColorStop(1, '#0a040f')
  ctx.fillStyle = bgGradient
  ctx.fillRect(0, 0, BOARD_WIDTH, BOARD_HEIGHT)

  ctx.strokeStyle = 'rgba(183, 109, 255, 0.25)'
  ctx.lineWidth = 1
  ctx.strokeRect(16, 16, BOARD_WIDTH - 32, BOARD_HEIGHT - 32)

  ctx.save()
  ctx.shadowColor = 'rgba(151, 111, 255, 0.55)'
  ctx.shadowBlur = 12
  for (const peg of pegs) {
    const visualY = getVisualPegY(peg.y)
    ctx.beginPath()
    ctx.fillStyle = 'rgba(213, 163, 255, 0.95)'
    ctx.arc(peg.x, visualY, PEG_VISUAL_RADIUS, 0, Math.PI * 2)
    ctx.fill()
  }
  ctx.restore()

  const laneTop = pegs[pegs.length - multipliers.length + 1]?.y ?? TOP_Y
  const laneBottom = SLOT_CUP_CENTER_Y - BALL_RADIUS * 1.05
  ctx.strokeStyle = 'rgba(205, 166, 255, 0.32)'
  for (let index = 0; index <= multipliers.length; index += 1) {
    const laneX = slotLeft + index * STEP_X
    ctx.beginPath()
    ctx.moveTo(laneX, laneTop)
    ctx.lineTo(laneX, laneBottom)
    ctx.stroke()
  }

  for (const ball of activeBalls) {
    ctx.save()
    ctx.shadowColor = ball.color
    ctx.shadowBlur = 18
    ctx.beginPath()
    ctx.fillStyle = ball.color
    ctx.arc(ball.x, ball.y, BALL_RADIUS, 0, Math.PI * 2)
    ctx.fill()
    ctx.restore()
  }
}

function advanceBall(ball: ActiveBall, dt: number, pegs: Peg[], slotLeft: number, slotCount: number) {
  const next = { ...ball, pegCooldownMs: 0 }
  const prevX = next.x
  const prevY = next.y

  next.vy += GRAVITY * dt
  next.vx *= next.vy < 0 ? ASCENT_SIDE_DAMPING : DESCENT_DAMPING
  next.driftVx *= Math.pow(PEG_DRIFT_DECAY, dt * 60)
  next.vx += next.driftVx * dt * 60

  if (next.centerBias > 0 && next.lockedSlotIndex === null) {
    const centerOffset = clamp((BOARD_WIDTH / 2 - next.x) / STEP_X, -3.5, 3.5)
    const centerPull = centerOffset * next.centerBias
    next.driftVx = clamp(next.driftVx + centerPull * CENTER_BIAS_DRIFT_PULL, -PEG_DRIFT_MAX, PEG_DRIFT_MAX)
    next.vx += centerPull * CENTER_BIAS_VELOCITY_PULL
  }

  next.vx = clamp(next.vx, -(next.vy < 0 ? ASCENT_MAX_SIDE_SPEED : MAX_SIDE_SPEED), next.vy < 0 ? ASCENT_MAX_SIDE_SPEED : MAX_SIDE_SPEED)
  next.x += next.vx * dt
  next.y += next.vy * dt

  if (next.x < 20) {
    next.x = 20
    next.vx = Math.abs(next.vx) * WALL_BOUNCE
  } else if (next.x > BOARD_WIDTH - 20) {
    next.x = BOARD_WIDTH - 20
    next.vx = -Math.abs(next.vx) * WALL_BOUNCE
  }

  let collision: { peg: Peg; dx: number; dy: number; distance: number } | null = null

  for (const peg of pegs) {
    if (next.topPegResolved && peg.id === TOP_PEG_ID) {
      continue
    }

    if (Math.abs(peg.y - next.y) > STEP_X * 0.78 || Math.abs(peg.x - next.x) > STEP_X * 0.78) {
      continue
    }

    const directDx = next.x - peg.x
    const directDy = next.y - peg.y
    const directDistance = Math.hypot(directDx, directDy)
    const closestPoint = closestPointOnSegment(prevX, prevY, next.x, next.y, peg.x, peg.y)
    const dx = closestPoint.x - peg.x
    const dy = closestPoint.y - peg.y
    const distance = Math.hypot(dx, dy)

    if (peg.id === next.lastPegId && distance < PEG_REHIT_BLOCK_DISTANCE) {
      continue
    }

    if ((directDistance <= PEG_CONTACT_DISTANCE || distance <= PEG_SWEEP_CONTACT_DISTANCE) && (!collision || distance < collision.distance)) {
      collision = { peg, dx, dy, distance }
    }
  }

  if (collision) {
    const isTopPeg = collision.peg.id === TOP_PEG_ID
    let randomBounceDirection: -1 | 1 =
      next.lastBounceDirection && Math.random() < PEG_DIRECTION_REPEAT_CHANCE
        ? next.lastBounceDirection
        : Math.random() < 0.5
          ? -1
          : 1

    if (next.centerBias > 0) {
      const towardCenter: -1 | 1 = next.x < BOARD_WIDTH / 2 ? 1 : -1
      const distanceFactor = clamp(Math.abs(next.x - BOARD_WIDTH / 2) / (STEP_X * 2.6), 0.25, 1)
      if (Math.random() < next.centerBias * distanceFactor) {
        randomBounceDirection = towardCenter
      }
    }

    const topPegDirection = randomBounceDirection
    const topPegLane: 'inside' | 'outside' =
      isTopPeg && Math.random() < TOP_PEG_OUTSIDE_CHANCE * (1 - next.centerBias * 0.7)
        ? 'outside'
        : 'inside'
    const adjustedDx =
      isTopPeg && Math.abs(collision.dx) < TOP_PEG_CENTER_BIAS
        ? collision.dx + topPegDirection * TOP_PEG_CENTER_BIAS
        : collision.dx
    const fallbackX = Math.sign(next.vx) || topPegDirection
    const normal = normalize(adjustedDx, collision.dy, fallbackX * 0.16, -1)
    const tangent = { x: -normal.y, y: normal.x }
    const separationDistance = isTopPeg ? TOP_PEG_SEPARATION_DISTANCE : PEG_SEPARATION_DISTANCE

    if (!isTopPeg && collision.dy > PEG_RADIUS * 0.08) {
      next.y = Math.max(next.y, collision.peg.y + PEG_SEPARATION_DISTANCE * 0.55)
      next.vy = Math.max(next.vy, PEG_MIN_DOWNWARD_SPEED)
      return { next }
    }

    const normalSpeed = next.vx * normal.x + next.vy * normal.y
    if (normalSpeed >= -1) {
      return { next }
    }

    next.x = collision.peg.x + normal.x * separationDistance
    next.y = collision.peg.y + normal.y * separationDistance

    let tangentSpeed = next.vx * tangent.x + next.vy * tangent.y
    if (isTopPeg) {
      tangentSpeed += topPegDirection * randomBetween(
        topPegLane === 'outside' ? TOP_PEG_OUTSIDE_NUDGE_MIN : TOP_PEG_INSIDE_NUDGE_MIN,
        topPegLane === 'outside' ? TOP_PEG_OUTSIDE_NUDGE_MAX : TOP_PEG_INSIDE_NUDGE_MAX,
      )
    } else {
      tangentSpeed += randomBounceDirection * randomBetween(PEG_SIDE_NUDGE_MIN, PEG_SIDE_NUDGE_MAX)
    }

    const tangentDirection = Math.sign(tangentSpeed) || Math.sign(collision.dx) || Math.sign(next.vx) || topPegDirection
    const releaseSpeed =
      Math.max(-normalSpeed * PEG_RESTITUTION, PEG_MIN_RELEASE_SPEED) *
      (isTopPeg ? (topPegLane === 'outside' ? TOP_PEG_OUTSIDE_RELEASE_MULTIPLIER : TOP_PEG_INSIDE_RELEASE_MULTIPLIER) : 1)
    const bouncedTangentSpeed =
      tangentSpeed * PEG_TANGENT_DAMPING +
      tangentDirection * randomBetween(-PEG_RANDOM_TANGENT, PEG_RANDOM_TANGENT)
    const tangentMagnitude = Math.max(Math.abs(bouncedTangentSpeed), PEG_MIN_TANGENT_SPEED)

    next.vx =
      tangent.x * Math.sign(bouncedTangentSpeed || tangentDirection) * tangentMagnitude +
      normal.x * releaseSpeed +
      tangentDirection * PEG_SIDE_PUSH
    next.vy =
      tangent.y * Math.sign(bouncedTangentSpeed || tangentDirection) * tangentMagnitude +
      normal.y * releaseSpeed

    if (!isTopPeg) {
      next.vx += randomBounceDirection * randomBetween(PEG_SIDE_NUDGE_MIN, PEG_SIDE_NUDGE_MAX) * 0.35
      next.vy = Math.min(next.vy, -randomBetween(PEG_BOUNCE_UPWARD_MIN, PEG_BOUNCE_UPWARD_MAX))
    }

    const angleJitter = randomBetween(-PEG_ANGLE_JITTER_DEG, PEG_ANGLE_JITTER_DEG) * (Math.PI / 180)
    const rotatedVelocity = rotateVector(next.vx, next.vy, angleJitter)
    next.vx = rotatedVelocity.x
    next.vy = rotatedVelocity.y

    next.vx = clamp(next.vx, -(isTopPeg ? TOP_PEG_MAX_SIDE_SPEED : MAX_SIDE_SPEED), isTopPeg ? TOP_PEG_MAX_SIDE_SPEED : MAX_SIDE_SPEED)
    next.vy = isTopPeg
      ? Math.max(next.vy, TOP_PEG_MIN_DOWNWARD_SPEED)
      : clamp(next.vy, -PEG_MAX_UPWARD_SPEED, PEG_MIN_DOWNWARD_SPEED)

    const driftDirection = randomBounceDirection
    const driftCarryBoost = Math.sign(next.driftVx) === driftDirection ? 1.4 : 1
    const driftImpulse =
      randomBetween(PEG_DRIFT_IMPULSE_MIN, PEG_DRIFT_IMPULSE_MAX) *
      driftCarryBoost *
      (isTopPeg && topPegLane === 'outside' ? 1.35 : 1)
    next.driftVx = clamp(next.driftVx + driftDirection * driftImpulse, -PEG_DRIFT_MAX, PEG_DRIFT_MAX)

    next.lastPegId = collision.peg.id
    next.pegCooldownMs = 0
    next.topPegResolved = next.topPegResolved || isTopPeg
    next.lastBounceDirection = randomBounceDirection
  }

  if (next.y + BALL_RADIUS >= CUP_WALL_TOP_Y) {
    for (let dividerIndex = 1; dividerIndex < slotCount; dividerIndex += 1) {
      const wallX = slotLeft + dividerIndex * STEP_X
      if (Math.abs(next.x - wallX) >= BALL_RADIUS) {
        continue
      }

      const enteredFromLeft = prevX <= wallX
      next.x = wallX + (enteredFromLeft ? -BALL_RADIUS : BALL_RADIUS)
      next.vx = (enteredFromLeft ? -1 : 1) * Math.abs(next.vx) * 0.08
      next.driftVx *= 0.18
    }
  }

  const landingY = SLOT_CUP_CENTER_Y
  if (next.lockedSlotIndex === null && next.y + BALL_RADIUS >= CUP_ENTRY_Y) {
    next.lockedSlotIndex = getSlotIndexForX(next.x, slotLeft, slotCount)
  }

  const slotIndex = next.lockedSlotIndex ?? getSlotIndexForX(next.x, slotLeft, slotCount)
  const slotCenterX = slotLeft + (slotIndex + 0.5) * STEP_X
  const minLaneX = slotLeft + slotIndex * STEP_X + CUP_LANE_PADDING
  const maxLaneX = slotLeft + (slotIndex + 1) * STEP_X - CUP_LANE_PADDING
  const minCupX = Math.max(slotCenterX - CUP_CAPTURE_HALF_WIDTH, minLaneX)
  const maxCupX = Math.min(slotCenterX + CUP_CAPTURE_HALF_WIDTH, maxLaneX)

  if (next.lockedSlotIndex !== null) {
    next.x = clamp(next.x, minLaneX, maxLaneX)
    next.vx *= 0.35
    next.driftVx *= 0.1
  }

  if (next.y >= landingY) {
    next.y = landingY
    next.x = clamp(moveToward(next.x, slotCenterX, CUP_PULL_STEP), minCupX, maxCupX)
    return { next: null, landedSlotIndex: slotIndex }
  }

  if (next.y > BOARD_HEIGHT + 20) {
    return { next: null, landedSlotIndex: slotIndex }
  }

  return { next }
}

export default function PlinkoBoard({ rows, multipliers, pendingDrops, onBallSettled }: PlinkoBoardProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const activeBallsRef = useRef<ActiveBall[]>([])
  const onBallSettledRef = useRef(onBallSettled)
  const spawnedDropIdsRef = useRef<Set<string>>(new Set())
  const [activeBalls, setActiveBalls] = useState<ActiveBall[]>([])
  const [activeHit, setActiveHit] = useState<{ slotIndex: number; token: number } | null>(null)

  const rowStep = useMemo(() => (BOARD_HEIGHT - TOP_Y - BOTTOM_GAP) / Math.max(rows, 1), [rows])
  const pegs = useMemo(() => buildPegs(rows, rowStep), [rows, rowStep])
  const slotTrackWidth = multipliers.length * STEP_X
  const slotLeft = BOARD_WIDTH / 2 - slotTrackWidth / 2

  useEffect(() => {
    activeBallsRef.current = activeBalls
  }, [activeBalls])

  useEffect(() => {
    onBallSettledRef.current = onBallSettled
  }, [onBallSettled])

  useEffect(() => {
    const dropsToSpawn = pendingDrops.filter((drop) => !spawnedDropIdsRef.current.has(drop.id))

    if (dropsToSpawn.length === 0) {
      return
    }

    setActiveBalls((current) => {
      const next = [...current]

      dropsToSpawn.forEach((drop) => {
        const spawnDirection: -1 | 1 = Math.random() < 0.5 ? -1 : 1
        const spawnOffset =
          spawnDirection * randomBetween(TOP_DROP_HIT_OFFSET_INSIDE_MIN, TOP_DROP_HIT_OFFSET_INSIDE_MAX)

        next.push({
          id: drop.id,
          x: BOARD_WIDTH / 2 + spawnOffset,
          y: TOP_Y - rowStep * SPAWN_DROP_HEIGHT,
          vx: 0,
          vy: randomBetween(SPAWN_INITIAL_DOWN_SPEED_MIN, SPAWN_INITIAL_DOWN_SPEED_MAX),
          driftVx: 0,
          settleMs: 0,
          color: getBallColor(drop.id),
          lastPegId: null,
          pegCooldownMs: 0,
          topPegDirection: spawnDirection,
          topPegLane: 'inside' as const,
          topPegResolved: false,
          lastBounceDirection: null,
          lockedSlotIndex: null,
          centerBias: drop.centerBias ?? 0,
        })
        spawnedDropIdsRef.current.add(drop.id)
      })

      activeBallsRef.current = next
      return next
    })
  }, [pendingDrops, rowStep])

  useEffect(() => {
    let rafId = 0
    let lastTs = performance.now()

    const tick = (ts: number) => {
      const dt = Math.min(MAX_FRAME_DT_S, Math.max(0.001, (ts - lastTs) / 1000))
      lastTs = ts

      const current = activeBallsRef.current
      if (current.length > 0) {
        const landed: { id: string; slotIndex: number }[] = []
        let stepBalls = current
        const steps = Math.max(1, Math.ceil(dt / SIMULATION_STEP_S))
        const stepDt = dt / steps

        for (let step = 0; step < steps; step += 1) {
          const nextStepBalls: ActiveBall[] = []

          for (const ball of stepBalls) {
            const result = advanceBall(ball, stepDt, pegs, slotLeft, multipliers.length)
            if (result.next) {
              nextStepBalls.push(result.next)
            } else if (typeof result.landedSlotIndex === 'number') {
              landed.push({ id: ball.id, slotIndex: result.landedSlotIndex })
            }
          }

          stepBalls = nextStepBalls
        }

        activeBallsRef.current = stepBalls
        setActiveBalls(stepBalls)

        if (landed.length > 0) {
          const lastLanded = landed[landed.length - 1]
          setActiveHit({ slotIndex: lastLanded.slotIndex, token: Date.now() })
          landed.forEach((entry) => {
            void onBallSettledRef.current?.(entry.id, entry.slotIndex)
          })
        }
      }

      rafId = window.requestAnimationFrame(tick)
    }

    rafId = window.requestAnimationFrame(tick)
    return () => {
      window.cancelAnimationFrame(rafId)
    }
  }, [multipliers.length, pegs, slotLeft])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) {
      return
    }

    const ctx = canvas.getContext('2d')
    if (!ctx) {
      return
    }

    drawBoard(ctx, pegs, multipliers, activeBalls, slotLeft)
  }, [activeBalls, multipliers, pegs, slotLeft])

  return (
    <div className="panel plinko-panel">
      <div className="plinko-canvas-wrap">
        <canvas ref={canvasRef} width={BOARD_WIDTH} height={BOARD_HEIGHT} className="plinko-canvas" />
        <div
          className="slot-track"
          style={{
            width: `${(slotTrackWidth / BOARD_WIDTH) * 100}%`,
            left: `${(slotLeft / BOARD_WIDTH) * 100}%`,
            gridTemplateColumns: `repeat(${multipliers.length}, minmax(0, 1fr))`,
          }}
        >
          {multipliers.map((multiplier, index) => (
            <div
              key={`slot-${index}-${activeHit?.slotIndex === index ? activeHit.token : 'idle'}`}
              className={`${getSlotStyle(multiplier)} ${activeHit?.slotIndex === index ? 'hit' : ''}`}
            >
              {formatMultiplier(multiplier)}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
