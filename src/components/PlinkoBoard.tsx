import { useEffect, useMemo, useRef, useState } from 'react'
import {
  BALL_RADIUS,
  BOARD_HEIGHT,
  BOARD_WIDTH,
  buildPegs,
  getRowStep,
  getSlotLeft,
  MAX_FRAME_DT_S,
  PEG_RADIUS,
  SIMULATION_STEP_S,
  SLOT_CUP_CENTER_Y,
  spawnBall,
  stepBall,
  STEP_X,
  TOP_Y,
  type Ball,
  type Peg,
} from './plinkoPhysics'
import { seededRandom } from '../shared/random'

type PendingPlinkoDrop = {
  id: string
  bet: number
  centerBias: number
  // the server's drop: replaying it from this seed lands in the same slot
  seed: number
}

type PlinkoBoardProps = {
  rows: number
  multipliers: number[]
  pendingDrops: PendingPlinkoDrop[]
  onBallSettled?: (dropId: string, slotIndex: number) => void | Promise<void>
}

type ActiveBall = Ball & { id: string; color: string; rng: () => number }

const PEG_DRAW_RADIUS = PEG_RADIUS + 0.4
const PEG_VISUAL_Y_SCALE = 0.988

function getBallColor(dropId: string) {
  const palette = ['#3ee8ff', '#ff3ea5', '#ffc93e', '#8a5cff', '#4dff88', '#ff6a4d']
  let hash = 0
  for (const char of dropId) {
    hash = (hash + char.charCodeAt(0)) % palette.length
  }
  return palette[hash]
}

// Visual-only trail buffer so balls leave a fading neon streak.
const BALL_TRAILS = new Map<string, { x: number; y: number }[]>()
const TRAIL_LENGTH = 9

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
  bgGradient.addColorStop(0, '#0a1024')
  bgGradient.addColorStop(0.55, '#070b1a')
  bgGradient.addColorStop(1, '#05070f')
  ctx.fillStyle = bgGradient
  ctx.fillRect(0, 0, BOARD_WIDTH, BOARD_HEIGHT)

  // holo-grid floor
  ctx.strokeStyle = 'rgba(62, 232, 255, 0.045)'
  ctx.lineWidth = 1
  for (let gx = 20; gx < BOARD_WIDTH - 18; gx += 37) {
    ctx.beginPath()
    ctx.moveTo(gx, 18)
    ctx.lineTo(gx, BOARD_HEIGHT - 18)
    ctx.stroke()
  }
  for (let gy = 18; gy < BOARD_HEIGHT - 16; gy += 37) {
    ctx.beginPath()
    ctx.moveTo(20, gy)
    ctx.lineTo(BOARD_WIDTH - 20, gy)
    ctx.stroke()
  }

  // double neon frame
  ctx.strokeStyle = 'rgba(62, 232, 255, 0.4)'
  ctx.lineWidth = 1.5
  ctx.strokeRect(14, 14, BOARD_WIDTH - 28, BOARD_HEIGHT - 28)
  ctx.strokeStyle = 'rgba(255, 62, 165, 0.18)'
  ctx.lineWidth = 1
  ctx.strokeRect(19, 19, BOARD_WIDTH - 38, BOARD_HEIGHT - 38)

  ctx.save()
  ctx.shadowColor = 'rgba(62, 232, 255, 0.75)'
  ctx.shadowBlur = 10
  for (const peg of pegs) {
    const visualY = getVisualPegY(peg.y)
    ctx.beginPath()
    ctx.fillStyle = 'rgba(190, 246, 255, 0.95)'
    ctx.arc(peg.x, visualY, PEG_DRAW_RADIUS, 0, Math.PI * 2)
    ctx.fill()
    ctx.beginPath()
    ctx.fillStyle = 'rgba(255, 255, 255, 0.9)'
    ctx.arc(peg.x, visualY, PEG_DRAW_RADIUS * 0.4, 0, Math.PI * 2)
    ctx.fill()
  }
  ctx.restore()

  const laneTop = pegs[pegs.length - multipliers.length + 1]?.y ?? TOP_Y
  const laneBottom = SLOT_CUP_CENTER_Y - BALL_RADIUS * 1.05
  ctx.strokeStyle = 'rgba(138, 92, 255, 0.35)'
  for (let index = 0; index <= multipliers.length; index += 1) {
    const laneX = slotLeft + index * STEP_X
    ctx.beginPath()
    ctx.moveTo(laneX, laneTop)
    ctx.lineTo(laneX, laneBottom)
    ctx.stroke()
  }

  // fading neon trails, then the balls with white-hot cores
  const activeIds = new Set(activeBalls.map((ball) => ball.id))
  for (const trailId of BALL_TRAILS.keys()) {
    if (!activeIds.has(trailId)) {
      BALL_TRAILS.delete(trailId)
    }
  }

  for (const ball of activeBalls) {
    const trail = BALL_TRAILS.get(ball.id) ?? []
    trail.push({ x: ball.x, y: ball.y })
    if (trail.length > TRAIL_LENGTH) {
      trail.shift()
    }
    BALL_TRAILS.set(ball.id, trail)

    for (let index = 0; index < trail.length - 1; index += 1) {
      const point = trail[index]
      const strength = (index + 1) / trail.length
      ctx.beginPath()
      ctx.fillStyle = ball.color
      ctx.globalAlpha = strength * 0.22
      ctx.arc(point.x, point.y, BALL_RADIUS * (0.35 + strength * 0.5), 0, Math.PI * 2)
      ctx.fill()
    }
    ctx.globalAlpha = 1

    ctx.save()
    ctx.shadowColor = ball.color
    ctx.shadowBlur = 20
    ctx.beginPath()
    ctx.fillStyle = ball.color
    ctx.arc(ball.x, ball.y, BALL_RADIUS, 0, Math.PI * 2)
    ctx.fill()
    ctx.beginPath()
    ctx.fillStyle = 'rgba(255, 255, 255, 0.85)'
    ctx.arc(ball.x - BALL_RADIUS * 0.25, ball.y - BALL_RADIUS * 0.3, BALL_RADIUS * 0.38, 0, Math.PI * 2)
    ctx.fill()
    ctx.restore()
  }
}

export default function PlinkoBoard({ rows, multipliers, pendingDrops, onBallSettled }: PlinkoBoardProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const activeBallsRef = useRef<ActiveBall[]>([])
  const onBallSettledRef = useRef(onBallSettled)
  const spawnedDropIdsRef = useRef<Set<string>>(new Set())
  const [activeBalls, setActiveBalls] = useState<ActiveBall[]>([])
  const [activeHit, setActiveHit] = useState<{ slotIndex: number; token: number } | null>(null)

  const rowStep = useMemo(() => getRowStep(rows), [rows])
  const pegs = useMemo(() => buildPegs(rows, rowStep), [rows, rowStep])
  const slotTrackWidth = multipliers.length * STEP_X
  const slotLeft = getSlotLeft(multipliers.length)

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
        const rng = seededRandom(drop.seed)
        const ball = spawnBall(rowStep, drop.centerBias ?? 0, rng)
        next.push({ ...ball, id: drop.id, color: getBallColor(drop.id), rng })
        spawnedDropIdsRef.current.add(drop.id)
      })

      activeBallsRef.current = next
      return next
    })
  }, [pendingDrops, rowStep])

  useEffect(() => {
    let rafId = 0
    let lastTs = performance.now()
    let accumulated = 0

    const tick = (ts: number) => {
      const dt = Math.min(MAX_FRAME_DT_S, Math.max(0.001, (ts - lastTs) / 1000))
      lastTs = ts

      const current = activeBallsRef.current
      if (current.length > 0) {
        const landed: { id: string; slotIndex: number }[] = []
        let stepBalls = current
        // fixed-size steps, exactly like the server's simulation, so each
        // ball traces the same path it was dealt
        accumulated += dt
        const steps = Math.floor(accumulated / SIMULATION_STEP_S)
        accumulated -= steps * SIMULATION_STEP_S

        for (let step = 0; step < steps; step += 1) {
          const nextStepBalls: ActiveBall[] = []

          for (const ball of stepBalls) {
            const result = stepBall(ball, SIMULATION_STEP_S, pegs, slotLeft, multipliers.length, ball.rng)
            if (result.next) {
              // stepBall spreads the ball, so id + color are preserved
              nextStepBalls.push(result.next as ActiveBall)
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
      } else {
        accumulated = 0
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
