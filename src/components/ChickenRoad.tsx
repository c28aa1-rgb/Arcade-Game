import { useEffect, useRef } from 'react'
import type { ChickenDifficulty } from './chickenLogic'

// Chicken Cross — 2D street renderer modeled on Rainbet's Chicken Cross.
// Top-down night road; the chicken hops lane to lane over manhole covers that
// carry the multipliers. A safe hop drops a striped barricade in front of the
// chicken and the next car screeches to a stop behind it. A bad hop gets hit.
//
// Everything is drawn in a 720-unit-tall virtual space and scaled to the
// canvas, so the scene keeps its proportions at any size.

export type ChickenStatus = 'idle' | 'playing' | 'dead' | 'cashed'

type ChickenRoadProps = {
  multipliers: number[]
  currentLane: number
  status: ChickenStatus
  deathLane: number | null
  difficulty: ChickenDifficulty
}

// ---- layout (virtual units) ----
const VH = 720
const LANE_W = 150
const WALK_W = 300
const FINISH_W = 340
const ROW_Y = 474 // manhole centre / chicken's feet
const BARRIER_Y = 346 // barricade centre, between the chicken and oncoming cars
const STOP_LINE = BARRIER_Y - 24 // a stopping car's front bumper rests here
const HOP_MS = 360
const DROP_MS = 300
const SETTLE_MS = 200
const A_BRAKE = 2400

// ---- theme: "Midnight Asphalt" ----
const C = {
  night: '#0d0f15',
  asphalt: '#262a35',
  paint: '#f1ead8',
  walk: '#525764',
  walkSeam: '#454a56',
  curb: '#8b8f9c',
  gold: '#ffc93e',
  goldDeep: '#c98f12',
  mint: '#3ee39a',
  red: '#ff4b55',
  ink: '#1b1712',
  iron: '#1c1f27',
  ironRim: '#3b404d',
}

const TRAFFIC_SPEED: Record<ChickenDifficulty, number> = {
  easy: 520,
  medium: 620,
  hard: 740,
  daredevil: 880,
}
const CAR_COLORS = ['#4f8cff', '#ff6b6b', '#eef0f4', '#2ec4b6', '#9b5de5', '#3a3f4b', '#ff9f43']

type CarKind = 'sedan' | 'taxi' | 'truck' | 'sport'
type CarState = 'drive' | 'brake' | 'stopped' | 'exit' | 'killer'
type Car = {
  y: number
  v: number
  cruise: number
  kind: CarKind
  color: string
  len: number
  state: CarState
  decel: number
  skidFrom: number | null
}
type Skid = { lane: number; from: number; to: number }
type Barrier = { state: 'none' | 'pending' | 'dropping' | 'down' | 'lifting'; t: number }
type Particle = {
  kind: 'feather' | 'dust' | 'coin' | 'steam'
  x: number
  y: number
  vx: number
  vy: number
  rot: number
  vr: number
  life: number
  max: number
  size: number
}

function laneX(lane: number): number {
  return lane <= 0 ? WALK_W - 120 : WALK_W + (lane - 0.5) * LANE_W
}

function easeInOut(t: number) {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2
}
function easeOutBack(t: number) {
  const c1 = 1.70158
  const c3 = c1 + 1
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2)
}
function clamp01(t: number) {
  return Math.max(0, Math.min(1, t))
}

function compactMultiplier(v: number): string {
  if (v >= 1e6) return `${(v / 1e6).toFixed(2)}Mx`
  if (v >= 1e4) return `${(v / 1e3).toFixed(1)}Kx`
  if (v >= 1000) return `${(v / 1e3).toFixed(2)}Kx`
  if (v >= 100) return `${v.toFixed(0)}x`
  return `${v.toFixed(2)}x`
}

function newCar(base: number, offscreen = true): Car {
  const roll = Math.random()
  const kind: CarKind = roll < 0.16 ? 'truck' : roll < 0.32 ? 'taxi' : roll < 0.46 ? 'sport' : 'sedan'
  const len = kind === 'truck' ? 222 : kind === 'sport' ? 138 : 152
  const cruise = base * (kind === 'truck' ? 0.82 : kind === 'sport' ? 1.22 : 0.9 + Math.random() * 0.25)
  return {
    y: offscreen ? -len / 2 - 120 - Math.random() * 1200 : Math.random() * VH,
    v: cruise,
    cruise,
    kind,
    color: kind === 'taxi' ? '#ffd23f' : CAR_COLORS[Math.floor(Math.random() * CAR_COLORS.length)],
    len,
    state: 'drive',
    decel: 0,
    skidFrom: null,
  }
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath()
  ctx.roundRect(x, y, w, h, r)
}

// ---------- art ----------

function makeAsphaltPattern(): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.width = 240
  c.height = 240
  const g = c.getContext('2d')!
  g.fillStyle = C.asphalt
  g.fillRect(0, 0, 240, 240)
  for (let i = 0; i < 1400; i += 1) {
    const light = Math.random() < 0.5
    g.fillStyle = light ? `rgba(255,255,255,${0.02 + Math.random() * 0.05})` : `rgba(0,0,0,${0.06 + Math.random() * 0.1})`
    const s = 0.6 + Math.random() * 1.8
    g.fillRect(Math.random() * 240, Math.random() * 240, s, s)
  }
  // a couple of hairline cracks
  g.strokeStyle = 'rgba(0,0,0,0.22)'
  g.lineWidth = 1
  for (let k = 0; k < 3; k += 1) {
    let x = Math.random() * 240
    let y = Math.random() * 240
    g.beginPath()
    g.moveTo(x, y)
    for (let s = 0; s < 6; s += 1) {
      x += (Math.random() - 0.5) * 26
      y += 8 + Math.random() * 12
      g.lineTo(x, y)
    }
    g.stroke()
  }
  return c
}

function drawCar(ctx: CanvasRenderingContext2D, car: Car, cx: number, now: number) {
  const w = car.kind === 'sport' ? 88 : car.kind === 'truck' ? 100 : 94
  const L = car.len
  const top = car.y - L / 2
  const braking = car.state === 'brake' || car.state === 'stopped'

  // headlight pools on the road ahead (night)
  const beam = ctx.createLinearGradient(0, car.y + L / 2, 0, car.y + L / 2 + 170)
  beam.addColorStop(0, 'rgba(255,240,200,0.20)')
  beam.addColorStop(1, 'rgba(255,240,200,0)')
  ctx.fillStyle = beam
  ctx.beginPath()
  ctx.moveTo(cx - w * 0.42, car.y + L / 2 - 4)
  ctx.lineTo(cx + w * 0.42, car.y + L / 2 - 4)
  ctx.lineTo(cx + w * 0.62, car.y + L / 2 + 170)
  ctx.lineTo(cx - w * 0.62, car.y + L / 2 + 170)
  ctx.closePath()
  ctx.fill()

  // speed streaks for fast movers
  if (car.v > 700) {
    ctx.strokeStyle = 'rgba(241,234,216,0.10)'
    ctx.lineWidth = 3
    for (const dx of [-28, 0, 28]) {
      ctx.beginPath()
      ctx.moveTo(cx + dx, top - 10)
      ctx.lineTo(cx + dx, top - 10 - Math.min(160, (car.v - 600) * 0.25))
      ctx.stroke()
    }
  }

  // drop shadow
  ctx.fillStyle = 'rgba(0,0,0,0.42)'
  roundRect(ctx, cx - w / 2 + 6, top + 9, w, L, 24)
  ctx.fill()

  if (car.kind === 'truck') {
    // cargo box (rear) + cab (front)
    const boxL = L - 72
    const box = ctx.createLinearGradient(cx - w / 2, 0, cx + w / 2, 0)
    box.addColorStop(0, '#9aa1ad')
    box.addColorStop(0.5, '#e7e9ee')
    box.addColorStop(1, '#9aa1ad')
    ctx.fillStyle = box
    roundRect(ctx, cx - w / 2, top, w, boxL, 10)
    ctx.fill()
    ctx.strokeStyle = 'rgba(27,23,18,0.25)'
    ctx.lineWidth = 2
    for (let r = 1; r < 5; r += 1) {
      ctx.beginPath()
      ctx.moveTo(cx - w / 2 + 8, top + (boxL / 5) * r)
      ctx.lineTo(cx + w / 2 - 8, top + (boxL / 5) * r)
      ctx.stroke()
    }
    const cab = ctx.createLinearGradient(cx - w / 2, 0, cx + w / 2, 0)
    cab.addColorStop(0, shade(car.color, -0.35))
    cab.addColorStop(0.5, car.color)
    cab.addColorStop(1, shade(car.color, -0.35))
    ctx.fillStyle = cab
    roundRect(ctx, cx - w / 2 + 4, top + boxL + 4, w - 8, 66, 18)
    ctx.fill()
    ctx.fillStyle = '#16202c'
    roundRect(ctx, cx - w / 2 + 14, top + boxL + 36, w - 28, 18, 6)
    ctx.fill()
  } else {
    const body = ctx.createLinearGradient(cx - w / 2, 0, cx + w / 2, 0)
    body.addColorStop(0, shade(car.color, -0.38))
    body.addColorStop(0.22, car.color)
    body.addColorStop(0.5, shade(car.color, 0.18))
    body.addColorStop(0.78, car.color)
    body.addColorStop(1, shade(car.color, -0.38))
    ctx.fillStyle = body
    roundRect(ctx, cx - w / 2, top, w, L, 26)
    ctx.fill()

    // mirrors
    ctx.fillStyle = shade(car.color, -0.3)
    roundRect(ctx, cx - w / 2 - 7, top + L * 0.6, 9, 14, 4)
    ctx.fill()
    roundRect(ctx, cx + w / 2 - 2, top + L * 0.6, 9, 14, 4)
    ctx.fill()

    // rear window, roof, windshield (front = bottom)
    const glass = ctx.createLinearGradient(0, top, 0, top + L)
    glass.addColorStop(0, '#2a3a52')
    glass.addColorStop(1, '#0f1826')
    ctx.fillStyle = glass
    roundRect(ctx, cx - w / 2 + 14, top + L * 0.16, w - 28, L * 0.12, 8)
    ctx.fill()
    ctx.fillStyle = shade(car.color, car.kind === 'sport' ? -0.25 : 0.08)
    roundRect(ctx, cx - w / 2 + 12, top + L * 0.3, w - 24, L * 0.3, 12)
    ctx.fill()
    ctx.fillStyle = glass
    ctx.beginPath()
    ctx.moveTo(cx - w / 2 + 12, top + L * 0.62)
    ctx.lineTo(cx + w / 2 - 12, top + L * 0.62)
    ctx.lineTo(cx + w / 2 - 18, top + L * 0.78)
    ctx.lineTo(cx - w / 2 + 18, top + L * 0.78)
    ctx.closePath()
    ctx.fill()
    // windshield glint
    ctx.strokeStyle = 'rgba(255,255,255,0.28)'
    ctx.lineWidth = 3
    ctx.beginPath()
    ctx.moveTo(cx - w / 2 + 22, top + L * 0.66)
    ctx.lineTo(cx - w / 2 + 34, top + L * 0.74)
    ctx.stroke()

    if (car.kind === 'taxi') {
      ctx.fillStyle = '#fff6d6'
      roundRect(ctx, cx - 16, top + L * 0.4, 32, 12, 3)
      ctx.fill()
      ctx.fillStyle = C.ink
      for (let i = 0; i < 6; i += 1) {
        if (i % 2 === 0) {
          ctx.fillRect(cx - w / 2 + 1, top + L * 0.32 + i * 8, 4, 8)
          ctx.fillRect(cx + w / 2 - 5, top + L * 0.32 + i * 8, 4, 8)
        }
      }
    }
    if (car.kind === 'sport') {
      ctx.fillStyle = 'rgba(255,255,255,0.75)'
      ctx.fillRect(cx - 10, top + 4, 7, L - 8)
      ctx.fillRect(cx + 3, top + 4, 7, L - 8)
    }
  }

  // headlights
  ctx.fillStyle = '#fff4cf'
  roundRect(ctx, cx - w / 2 + 10, top + L - 8, 18, 6, 3)
  ctx.fill()
  roundRect(ctx, cx + w / 2 - 28, top + L - 8, 18, 6, 3)
  ctx.fill()

  // tail lights (glow when braking)
  ctx.fillStyle = braking ? '#ff3b3b' : '#a3262c'
  if (braking) {
    ctx.shadowColor = 'rgba(255,59,59,0.9)'
    ctx.shadowBlur = 18 + Math.sin(now / 90) * 4
  }
  roundRect(ctx, cx - w / 2 + 10, top + 2, 18, 6, 3)
  ctx.fill()
  roundRect(ctx, cx + w / 2 - 28, top + 2, 18, 6, 3)
  ctx.fill()
  ctx.shadowBlur = 0
}

function shade(hex: string, amt: number): string {
  const n = parseInt(hex.slice(1), 16)
  let r = (n >> 16) & 255
  let g = (n >> 8) & 255
  let b = n & 255
  const t = amt < 0 ? 0 : 255
  const p = Math.abs(amt)
  r = Math.round((t - r) * p + r)
  g = Math.round((t - g) * p + g)
  b = Math.round((t - b) * p + b)
  return `rgb(${r},${g},${b})`
}

function drawManhole(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  label: string,
  face: 'iron' | 'coin',
  flipScale: number,
  glow: number,
  now: number,
) {
  const R = 52
  ctx.save()
  ctx.translate(cx, cy)

  // gold halo for the next / current lane
  if (glow > 0) {
    const halo = ctx.createRadialGradient(0, 0, R * 0.8, 0, 0, R * 1.7)
    halo.addColorStop(0, `rgba(255,201,62,${0.45 * glow})`)
    halo.addColorStop(1, 'rgba(255,201,62,0)')
    ctx.fillStyle = halo
    ctx.beginPath()
    ctx.arc(0, 0, R * 1.7, 0, Math.PI * 2)
    ctx.fill()
  }

  ctx.scale(Math.max(0.04, flipScale), 1)

  if (face === 'iron') {
    ctx.fillStyle = 'rgba(0,0,0,0.45)'
    ctx.beginPath()
    ctx.arc(3, 5, R + 3, 0, Math.PI * 2)
    ctx.fill()
    ctx.fillStyle = C.ironRim
    ctx.beginPath()
    ctx.arc(0, 0, R, 0, Math.PI * 2)
    ctx.fill()
    const iron = ctx.createRadialGradient(-14, -16, 6, 0, 0, R)
    iron.addColorStop(0, '#2b2f3a')
    iron.addColorStop(1, C.iron)
    ctx.fillStyle = iron
    ctx.beginPath()
    ctx.arc(0, 0, R - 6, 0, Math.PI * 2)
    ctx.fill()
    // cast-iron grid
    ctx.save()
    ctx.beginPath()
    ctx.arc(0, 0, R - 9, 0, Math.PI * 2)
    ctx.clip()
    ctx.strokeStyle = 'rgba(255,255,255,0.05)'
    ctx.lineWidth = 2
    for (let i = -R; i <= R; i += 11) {
      ctx.beginPath()
      ctx.moveTo(i, -R)
      ctx.lineTo(i, R)
      ctx.moveTo(-R, i)
      ctx.lineTo(R, i)
      ctx.stroke()
    }
    ctx.restore()
    if (glow > 0) {
      ctx.strokeStyle = `rgba(255,201,62,${0.55 + 0.45 * glow})`
      ctx.lineWidth = 4
      ctx.beginPath()
      ctx.arc(0, 0, R - 2, 0, Math.PI * 2)
      ctx.stroke()
    }
  } else {
    ctx.fillStyle = 'rgba(0,0,0,0.4)'
    ctx.beginPath()
    ctx.arc(3, 5, R + 2, 0, Math.PI * 2)
    ctx.fill()
    const coin = ctx.createRadialGradient(-16, -18, 4, 0, 0, R)
    coin.addColorStop(0, '#fff0b8')
    coin.addColorStop(0.45, C.gold)
    coin.addColorStop(1, C.goldDeep)
    ctx.fillStyle = coin
    ctx.beginPath()
    ctx.arc(0, 0, R, 0, Math.PI * 2)
    ctx.fill()
    ctx.strokeStyle = 'rgba(122,82,8,0.55)'
    ctx.lineWidth = 3
    ctx.beginPath()
    ctx.arc(0, 0, R - 8, 0, Math.PI * 2)
    ctx.stroke()
    // sweeping shine
    const sweep = ((now / 1400) % 1) * Math.PI * 2
    ctx.strokeStyle = 'rgba(255,255,255,0.45)'
    ctx.lineWidth = 4
    ctx.beginPath()
    ctx.arc(0, 0, R - 15, sweep, sweep + 0.6)
    ctx.stroke()
  }

  // multiplier label
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  let size = 27
  ctx.font = `400 ${size}px "Lilita One", "Archivo", sans-serif`
  while (ctx.measureText(label).width > R * 1.62 && size > 15) {
    size -= 1
    ctx.font = `400 ${size}px "Lilita One", "Archivo", sans-serif`
  }
  if (face === 'iron') {
    ctx.fillStyle = 'rgba(0,0,0,0.55)'
    ctx.fillText(label, 0, 3)
    ctx.fillStyle = glow > 0 ? '#fff3cf' : C.paint
  } else {
    ctx.fillStyle = 'rgba(255,255,255,0.5)'
    ctx.fillText(label, 0, 2)
    ctx.fillStyle = '#3b2a05'
  }
  ctx.fillText(label, 0, 1)
  ctx.restore()
}

function drawBarricade(ctx: CanvasRenderingContext2D, cx: number, cy: number, scale: number, squash: number, alpha: number, now: number) {
  const w = LANE_W - 22
  const h = 26
  ctx.save()
  ctx.globalAlpha = alpha
  // shadow grows tighter as it nears the ground
  const lift = scale - 1
  ctx.fillStyle = `rgba(0,0,0,${0.45 - lift * 0.3})`
  roundRect(ctx, cx - (w / 2) * (1 + lift * 0.3) + 5 + lift * 30, cy - h / 2 + 8 + lift * 40, w * (1 + lift * 0.3), h, 8)
  ctx.fill()

  ctx.translate(cx, cy)
  ctx.scale(scale, scale * squash)
  // feet
  ctx.fillStyle = '#2a2d36'
  roundRect(ctx, -w / 2 + 6, -h / 2 - 7, 16, h + 14, 4)
  ctx.fill()
  roundRect(ctx, w / 2 - 22, -h / 2 - 7, 16, h + 14, 4)
  ctx.fill()
  // board with hazard stripes
  ctx.save()
  roundRect(ctx, -w / 2, -h / 2, w, h, 7)
  ctx.clip()
  ctx.fillStyle = C.gold
  ctx.fillRect(-w / 2, -h / 2, w, h)
  ctx.fillStyle = C.ink
  for (let x = -w / 2 - h; x < w / 2 + h; x += 26) {
    ctx.beginPath()
    ctx.moveTo(x, h / 2)
    ctx.lineTo(x + 13, h / 2)
    ctx.lineTo(x + 13 + h, -h / 2)
    ctx.lineTo(x + h, -h / 2)
    ctx.closePath()
    ctx.fill()
  }
  ctx.fillStyle = 'rgba(255,255,255,0.22)'
  ctx.fillRect(-w / 2, -h / 2, w, 5)
  ctx.restore()
  ctx.strokeStyle = 'rgba(27,23,18,0.8)'
  ctx.lineWidth = 2
  roundRect(ctx, -w / 2, -h / 2, w, h, 7)
  ctx.stroke()
  // blinking warning lamp
  const on = Math.sin(now / 260) > 0
  ctx.fillStyle = on ? '#ffb020' : '#7a4d10'
  if (on) {
    ctx.shadowColor = 'rgba(255,176,32,0.9)'
    ctx.shadowBlur = 16
  }
  ctx.beginPath()
  ctx.arc(0, 0, 6, 0, Math.PI * 2)
  ctx.fill()
  ctx.restore()
}

function drawChicken(
  ctx: CanvasRenderingContext2D,
  x: number,
  feetY: number,
  lift: number,
  sx: number,
  sy: number,
  wing: number,
  blink: boolean,
) {
  // ground shadow
  const shadowScale = 1 - Math.min(0.55, lift / 160)
  ctx.fillStyle = `rgba(0,0,0,${0.38 * shadowScale})`
  ctx.beginPath()
  ctx.ellipse(x + 4, feetY + 2, 34 * shadowScale, 10 * shadowScale, 0, 0, Math.PI * 2)
  ctx.fill()

  ctx.save()
  ctx.translate(x, feetY - lift)
  ctx.scale(sx, sy)
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'
  const ink = 'rgba(27,23,18,0.92)'

  // legs + toes
  ctx.strokeStyle = '#ff9a1f'
  ctx.lineWidth = 5
  ctx.beginPath()
  ctx.moveTo(-9, -22)
  ctx.lineTo(-11, -1)
  ctx.moveTo(9, -22)
  ctx.lineTo(10, -1)
  ctx.stroke()
  ctx.lineWidth = 3.5
  ctx.beginPath()
  ctx.moveTo(-18, 0)
  ctx.lineTo(-3, 0)
  ctx.moveTo(2, 0)
  ctx.lineTo(18, 0)
  ctx.stroke()

  // tail feathers
  ctx.fillStyle = '#f7f1e3'
  ctx.strokeStyle = ink
  ctx.lineWidth = 2.6
  for (const [tx, ty, r] of [
    [-34, -64, -0.7],
    [-38, -54, -0.35],
    [-36, -44, 0],
  ] as const) {
    ctx.save()
    ctx.translate(tx, ty)
    ctx.rotate(r)
    ctx.beginPath()
    ctx.ellipse(0, 0, 13, 7, 0, 0, Math.PI * 2)
    ctx.fill()
    ctx.stroke()
    ctx.restore()
  }

  // body
  const body = ctx.createLinearGradient(-30, -72, 26, -16)
  body.addColorStop(0, '#ffffff')
  body.addColorStop(1, '#ecdfc6')
  ctx.fillStyle = body
  ctx.beginPath()
  ctx.ellipse(0, -44, 34, 29, 0, 0, Math.PI * 2)
  ctx.fill()
  ctx.stroke()

  // wing (flaps in the air)
  ctx.save()
  ctx.translate(-6, -46)
  ctx.rotate(wing)
  ctx.fillStyle = '#f3e7cf'
  ctx.beginPath()
  ctx.ellipse(0, 4, 19, 13, 0.25, 0, Math.PI * 2)
  ctx.fill()
  ctx.stroke()
  ctx.strokeStyle = 'rgba(27,23,18,0.35)'
  ctx.lineWidth = 1.8
  ctx.beginPath()
  ctx.arc(-4, 8, 7, 0.2, 2.2)
  ctx.arc(5, 8, 7, 0.4, 2.4)
  ctx.stroke()
  ctx.restore()

  // head
  ctx.strokeStyle = ink
  ctx.lineWidth = 2.6
  ctx.fillStyle = '#ffffff'
  ctx.beginPath()
  ctx.arc(19, -79, 19, 0, Math.PI * 2)
  ctx.fill()
  ctx.stroke()

  // comb
  ctx.fillStyle = '#e8333f'
  for (const [cx, cy, r] of [
    [11, -98, 6.5],
    [19, -101, 7.5],
    [27, -97, 6],
  ] as const) {
    ctx.beginPath()
    ctx.arc(cx, cy, r, 0, Math.PI * 2)
    ctx.fill()
    ctx.stroke()
  }

  // beak + wattle
  ctx.fillStyle = '#ff9a1f'
  ctx.beginPath()
  ctx.moveTo(35, -84)
  ctx.lineTo(49, -79)
  ctx.lineTo(35, -73)
  ctx.closePath()
  ctx.fill()
  ctx.stroke()
  ctx.fillStyle = '#e8333f'
  ctx.beginPath()
  ctx.ellipse(34, -67, 4.5, 6.5, 0, 0, Math.PI * 2)
  ctx.fill()
  ctx.stroke()

  // cheek + eye
  ctx.fillStyle = 'rgba(255,120,120,0.35)'
  ctx.beginPath()
  ctx.ellipse(21, -72, 5, 3.4, 0, 0, Math.PI * 2)
  ctx.fill()
  if (blink) {
    ctx.strokeStyle = C.ink
    ctx.lineWidth = 2.4
    ctx.beginPath()
    ctx.moveTo(22.5, -84)
    ctx.lineTo(30, -84)
    ctx.stroke()
  } else {
    ctx.fillStyle = C.ink
    ctx.beginPath()
    ctx.arc(26.5, -84, 3.8, 0, Math.PI * 2)
    ctx.fill()
    ctx.fillStyle = '#ffffff'
    ctx.beginPath()
    ctx.arc(27.8, -85.6, 1.3, 0, Math.PI * 2)
    ctx.fill()
  }
  ctx.restore()
}

function drawRoast(ctx: CanvasRenderingContext2D, x: number, feetY: number, lift: number, spin: number) {
  ctx.fillStyle = 'rgba(0,0,0,0.38)'
  ctx.beginPath()
  ctx.ellipse(x + 4, feetY + 2, 40, 11, 0, 0, Math.PI * 2)
  ctx.fill()

  ctx.save()
  ctx.translate(x, feetY - 26 - lift)
  ctx.rotate(spin)
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  const ink = 'rgba(27,23,18,0.9)'

  // drumsticks splayed outward: meaty bulb, short bone, double knob
  for (const side of [-1, 1]) {
    ctx.save()
    ctx.translate(side * 20, -10)
    ctx.rotate(side * 0.85)
    const meat = ctx.createLinearGradient(-12, 0, 12, 0)
    meat.addColorStop(0, '#7a3a12')
    meat.addColorStop(0.5, '#c8732b')
    meat.addColorStop(1, '#7a3a12')
    ctx.fillStyle = meat
    ctx.strokeStyle = ink
    ctx.lineWidth = 2.4
    ctx.beginPath()
    ctx.ellipse(0, -14, 12, 19, 0, 0, Math.PI * 2)
    ctx.fill()
    ctx.stroke()
    ctx.fillStyle = '#fff4e2'
    ctx.beginPath()
    ctx.roundRect(-3.5, -42, 7, 14, 3)
    ctx.fill()
    ctx.stroke()
    for (const dx of [-4.5, 4.5]) {
      ctx.beginPath()
      ctx.arc(dx, -44, 4.6, 0, Math.PI * 2)
      ctx.fill()
      ctx.stroke()
    }
    ctx.restore()
  }

  const roast = ctx.createRadialGradient(-12, -12, 4, 0, 0, 46)
  roast.addColorStop(0, '#e08a3a')
  roast.addColorStop(0.55, '#b5601e')
  roast.addColorStop(1, '#6d3210')
  ctx.fillStyle = roast
  ctx.strokeStyle = ink
  ctx.lineWidth = 2.6
  ctx.beginPath()
  ctx.ellipse(0, 0, 42, 27, 0, 0, Math.PI * 2)
  ctx.fill()
  ctx.stroke()
  // glaze highlights + crisp marks
  ctx.strokeStyle = 'rgba(255,230,180,0.55)'
  ctx.lineWidth = 4
  ctx.beginPath()
  ctx.arc(-6, -4, 24, 3.6, 4.6)
  ctx.stroke()
  ctx.strokeStyle = 'rgba(70,30,8,0.55)'
  ctx.lineWidth = 2
  for (const [a, b] of [
    [10, 4],
    [18, -6],
    [-18, 10],
  ]) {
    ctx.beginPath()
    ctx.moveTo(a - 5, b)
    ctx.lineTo(a + 5, b - 3)
    ctx.stroke()
  }
  ctx.restore()
}

function drawParticle(ctx: CanvasRenderingContext2D, p: Particle) {
  const t = p.life / p.max
  ctx.save()
  ctx.translate(p.x, p.y)
  ctx.rotate(p.rot)
  if (p.kind === 'feather') {
    ctx.globalAlpha = 1 - t * t
    ctx.fillStyle = '#fbf6ec'
    ctx.strokeStyle = 'rgba(27,23,18,0.55)'
    ctx.lineWidth = 1.4
    ctx.beginPath()
    ctx.ellipse(0, 0, p.size, p.size * 0.38, 0, 0, Math.PI * 2)
    ctx.fill()
    ctx.stroke()
    ctx.beginPath()
    ctx.moveTo(-p.size, 0)
    ctx.lineTo(p.size * 0.8, 0)
    ctx.stroke()
  } else if (p.kind === 'dust' || p.kind === 'steam') {
    // soft radial puff: dense core fading to nothing, never a hard disc
    const r = p.kind === 'dust' ? p.size * (0.7 + t * 1.2) : p.size * (0.6 + t * 1.8)
    const a = p.kind === 'dust' ? 0.32 * (1 - t) : 0.09 * Math.sin(Math.PI * t)
    const puff = ctx.createRadialGradient(0, 0, 0, 0, 0, r)
    puff.addColorStop(0, p.kind === 'dust' ? `rgba(196,198,206,${a})` : `rgba(232,236,244,${a})`)
    puff.addColorStop(1, 'rgba(232,236,244,0)')
    ctx.fillStyle = puff
    ctx.beginPath()
    ctx.arc(0, 0, r, 0, Math.PI * 2)
    ctx.fill()
  } else {
    ctx.globalAlpha = 1 - Math.max(0, t - 0.7) / 0.3
    ctx.scale(Math.abs(Math.cos(p.life * 9)) + 0.15, 1)
    const g = ctx.createRadialGradient(-3, -3, 1, 0, 0, p.size)
    g.addColorStop(0, '#fff0b8')
    g.addColorStop(0.5, C.gold)
    g.addColorStop(1, C.goldDeep)
    ctx.fillStyle = g
    ctx.beginPath()
    ctx.arc(0, 0, p.size, 0, Math.PI * 2)
    ctx.fill()
  }
  ctx.restore()
}

// ---------- component ----------

type Scene = {
  props: ChickenRoadProps
  prevStatus: ChickenStatus
  prevLane: number
  chickenX: number
  fromX: number
  toX: number
  hopStart: number
  hopping: boolean
  roast: boolean
  roastStart: number
  celebrateStart: number
  blinkAt: number
  cars: Car[]
  barriers: Barrier[]
  skids: Skid[]
  coinSince: number[]
  killerAt: number
  deadLane: number
  killerY0: number
  killerT0: number
  particles: Particle[]
  camX: number
  shake: number
  flash: number
  steamAt: number
}

export default function ChickenRoad(props: ChickenRoadProps) {
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const sceneRef = useRef<Scene | null>(null)

  if (!sceneRef.current) {
    const base = TRAFFIC_SPEED[props.difficulty]
    sceneRef.current = {
      props,
      prevStatus: 'idle',
      prevLane: 0,
      chickenX: laneX(0),
      fromX: laneX(0),
      toX: laneX(0),
      hopStart: 0,
      hopping: false,
      roast: false,
      roastStart: 0,
      celebrateStart: 0,
      blinkAt: performance.now() + 2000,
      cars: Array.from({ length: props.multipliers.length + 1 }, () => newCar(base, false)),
      barriers: Array.from({ length: props.multipliers.length + 1 }, () => ({ state: 'none', t: 0 })),
      skids: [],
      coinSince: [],
      killerAt: 0,
      deadLane: 0,
      killerY0: 0,
      killerT0: 0,
      particles: [],
      camX: 0,
      shake: 0,
      flash: 0,
      steamAt: 0,
    }
  }

  // react to gameplay changes
  useEffect(() => {
    const s = sceneRef.current!
    const { status, currentLane, deathLane } = props
    const prev = s.prevStatus
    const now = performance.now()
    s.props = props

    const resetRun = () => {
      s.roast = false
      s.hopping = false
      s.chickenX = laneX(0)
      s.fromX = s.chickenX
      s.toX = s.chickenX
      s.coinSince = []
      s.skids = []
      s.particles = s.particles.filter((p) => p.kind === 'steam')
      s.killerAt = 0
      s.deadLane = 0
      s.prevLane = 0
      s.barriers.forEach((b, lane) => {
        if (b.state !== 'none') s.barriers[lane] = { state: 'lifting', t: now }
      })
      s.cars.forEach((car) => {
        if (car.state !== 'drive') {
          car.state = 'exit'
          car.skidFrom = null
        }
      })
    }

    const hopTo = (lane: number) => {
      s.fromX = s.chickenX
      s.toX = laneX(lane)
      s.hopStart = now
      s.hopping = true
    }

    if ((status === 'playing' && prev !== 'playing') || (status === 'idle' && prev !== 'idle')) {
      resetRun()
    }

    if (status === 'playing' && currentLane > s.prevLane) {
      const lane = currentLane
      hopTo(lane)
      // the lane being entered is safe: cars brake now, barricade lands mid-hop
      s.barriers[lane] = { state: 'pending', t: now + HOP_MS * 0.45 }
      const car = s.cars[lane]
      if (car) {
        const front = car.y + car.len / 2
        const rear = car.y - car.len / 2
        if (front > STOP_LINE - 4 && rear < ROW_Y + 80) {
          car.state = 'exit' // already past the line: it zips through, a near miss
        }
        // a car far up the road is pulled in so it arrives at the barricade on screen
        if (car.state === 'drive' && rear < -420) car.y = -car.len / 2 - 70 - Math.random() * 220
      }
      if (s.prevLane > 0) s.coinSince[s.prevLane] = now + HOP_MS * 0.5
      s.prevLane = lane
    }

    if (status === 'dead' && prev !== 'dead') {
      const lane = deathLane ?? currentLane + 1
      hopTo(lane)
      if (s.prevLane > 0) s.coinSince[s.prevLane] = now + HOP_MS * 0.5
      s.prevLane = lane
      s.killerAt = now + HOP_MS + 70
    }

    if (status === 'cashed' && prev !== 'cashed') {
      s.celebrateStart = now
      if (currentLane > 0) s.coinSince[currentLane] = now
      for (let i = 0; i < 18; i += 1) {
        const a = -Math.PI / 2 + (Math.random() - 0.5) * 1.6
        const sp = 380 + Math.random() * 420
        s.particles.push({
          kind: 'coin',
          x: s.chickenX,
          y: ROW_Y - 60,
          vx: Math.cos(a) * sp,
          vy: Math.sin(a) * sp,
          rot: 0,
          vr: 0,
          life: 0,
          max: 1.3 + Math.random() * 0.4,
          size: 9 + Math.random() * 5,
        })
      }
    }

    s.prevStatus = status
  }, [props])

  // render loop
  useEffect(() => {
    const wrap = wrapRef.current
    const canvas = canvasRef.current
    if (!wrap || !canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const asphalt = ctx.createPattern(makeAsphaltPattern(), 'repeat')

    let size = { w: 960, h: 540, dpr: 1 }
    const resize = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1)
      const w = wrap.clientWidth || 960
      const h = wrap.clientHeight || 540
      canvas.width = Math.round(w * dpr)
      canvas.height = Math.round(h * dpr)
      canvas.style.width = `${w}px`
      canvas.style.height = `${h}px`
      size = { w, h, dpr }
    }
    resize()
    const ro = new ResizeObserver(resize)
    ro.observe(wrap)

    let raf = 0
    let last = performance.now()

    const spawnBurst = (kind: Particle['kind'], x: number, y: number, n: number, speed: number) => {
      const s = sceneRef.current!
      for (let i = 0; i < n; i += 1) {
        const a = Math.random() * Math.PI * 2
        const sp = speed * (0.4 + Math.random() * 0.8)
        s.particles.push({
          kind,
          x,
          y,
          vx: Math.cos(a) * sp,
          vy: Math.sin(a) * sp - (kind === 'feather' ? 160 : 0),
          rot: Math.random() * Math.PI,
          vr: (Math.random() - 0.5) * 8,
          life: 0,
          max: kind === 'feather' ? 1.4 + Math.random() * 0.6 : 0.55,
          size: kind === 'feather' ? 9 + Math.random() * 7 : 10 + Math.random() * 8,
        })
      }
    }

    const frame = (now: number) => {
      const dt = Math.max(0, Math.min(0.05, (now - last) / 1000))
      last = now
      const s = sceneRef.current!
      const { multipliers, status, currentLane, difficulty } = s.props
      const lanes = multipliers.length
      const base = TRAFFIC_SPEED[difficulty]
      const scale = size.h / VH
      const VW = size.w / scale
      const roadEnd = WALK_W + lanes * LANE_W

      // ---- chicken hop ----
      let lift = 0
      let sx = 1
      let sy = 1
      let wing = 0
      if (s.hopping) {
        const p = clamp01((now - s.hopStart) / HOP_MS)
        if (p < 0.16) {
          const k = p / 0.16
          sx = 1 + 0.1 * k
          sy = 1 - 0.14 * k
        } else if (p < 0.84) {
          const q = (p - 0.16) / 0.68
          s.chickenX = s.fromX + (s.toX - s.fromX) * easeInOut(q)
          lift = Math.sin(Math.PI * q) * 74
          sx = 0.95
          sy = 1.08
          wing = Math.sin(now / 28) * 0.7
        } else {
          s.chickenX = s.toX
          const k = (p - 0.84) / 0.16
          sx = 1.1 - 0.1 * k
          sy = 0.88 + 0.12 * k
        }
        if (p >= 1) {
          s.hopping = false
          s.chickenX = s.toX
          spawnBurst('dust', s.chickenX, ROW_Y + 4, 5, 90)
        }
      } else if (!s.roast) {
        // idle breathing, celebration bounces
        sy = 1 + Math.sin(now / 420) * 0.025
        sx = 1 - Math.sin(now / 420) * 0.015
        if (s.celebrateStart && now - s.celebrateStart < 900) {
          const q = ((now - s.celebrateStart) % 450) / 450
          lift = Math.sin(Math.PI * q) * 34
          wing = Math.sin(now / 30) * 0.8
        }
      }
      if (now > s.blinkAt + 130) s.blinkAt = now + 2200 + Math.random() * 2600
      const blink = now > s.blinkAt && now < s.blinkAt + 130

      // ---- barricades ----
      s.barriers.forEach((b, lane) => {
        if (b.state === 'pending' && now >= b.t) {
          s.barriers[lane] = { state: 'dropping', t: now }
        } else if (b.state === 'dropping' && now - b.t >= DROP_MS) {
          s.barriers[lane] = { state: 'down', t: now }
          s.shake = Math.max(s.shake, 4)
          for (const side of [-1, 1]) {
            spawnBurst('dust', laneX(lane) + side * (LANE_W / 2 - 18), BARRIER_Y + 8, 4, 110)
          }
        } else if (b.state === 'lifting' && now - b.t >= 240) {
          s.barriers[lane] = { state: 'none', t: now }
        }
      })

      // ---- traffic ----
      for (let lane = 1; lane <= lanes; lane += 1) {
        const car = s.cars[lane]
        if (!car) continue
        const bstate = s.barriers[lane]?.state ?? 'none'
        const guarded = bstate === 'pending' || bstate === 'dropping' || bstate === 'down'
        const front = car.y + car.len / 2

        // after a crash, the fatal lane stays clear so nothing drives over the roast
        if (lane === s.deadLane && car.state !== 'killer') continue

        if (car.state === 'killer') {
          // time-based so the hit lands on the same beat at any frame rate
          car.y = s.killerY0 + (car.v * (now - s.killerT0)) / 1000
          if (!s.roast && car.y + car.len / 2 >= ROW_Y - 34 && lane === s.prevLane) {
            s.roast = true
            s.roastStart = now
            s.shake = 16
            s.flash = 1
            spawnBurst('feather', s.chickenX, ROW_Y - 50, 18, 360)
            s.skids.push({ lane, from: ROW_Y - 40, to: ROW_Y + 130 })
          }
          if (car.y - car.len / 2 > VH + 60) {
            Object.assign(car, newCar(base))
          }
          continue
        }

        if (car.state === 'exit') {
          car.v = Math.min(2300, Math.max(car.v, 900) + 2800 * dt)
          car.y += car.v * dt
          if (car.y - car.len / 2 > VH + 60) {
            Object.assign(car, newCar(base))
            if (guarded) car.y = -car.len / 2 - 60 - Math.random() * 260
          }
          continue
        }

        if (guarded) {
          if (car.state === 'stopped') continue
          if (car.state === 'brake') {
            car.v = Math.max(0, car.v - car.decel * dt)
            car.y += car.v * dt
            if (car.v <= 0 || car.y + car.len / 2 >= STOP_LINE) {
              car.v = 0
              car.y = STOP_LINE - car.len / 2
              car.state = 'stopped'
              if (car.skidFrom !== null) {
                s.skids.push({ lane, from: car.skidFrom, to: STOP_LINE - 18 })
                car.skidFrom = null
              }
              spawnBurst('dust', laneX(lane), STOP_LINE - 6, 3, 60)
            }
            continue
          }
          if (front > STOP_LINE + 2) {
            car.state = 'exit'
            continue
          }
          const d = STOP_LINE - front
          if (d <= (car.v * car.v) / (2 * A_BRAKE) + 6) {
            car.state = 'brake'
            car.decel = (car.v * car.v) / (2 * Math.max(d, 1))
            car.skidFrom = front - 10
          }
          car.y += car.v * dt
          continue
        }

        // open lane
        if (car.state !== 'drive') {
          car.state = 'drive'
          car.v = car.cruise
        }
        car.y += car.v * dt
        if (car.y - car.len / 2 > VH + 60) Object.assign(car, newCar(base))
      }

      // killer car for a fatal hop
      if (s.killerAt && now >= s.killerAt) {
        const lane = s.prevLane
        const car = s.cars[lane]
        if (car) {
          Object.assign(car, newCar(base))
          car.y = -car.len / 2 - 40
          car.v = Math.max(1650, base * 2.4)
          car.state = 'killer'
          s.killerY0 = car.y
          s.killerT0 = now
        }
        s.deadLane = lane
        s.killerAt = 0
      }

      // ---- ambient steam from manholes ahead ----
      if (now > s.steamAt) {
        s.steamAt = now + 260 + Math.random() * 380
        const ahead = Math.max(1, currentLane + 1 + Math.floor(Math.random() * 5))
        if (ahead <= lanes) {
          s.particles.push({
            kind: 'steam',
            x: laneX(ahead) + (Math.random() - 0.5) * 30,
            y: ROW_Y - 10,
            vx: (Math.random() - 0.5) * 14,
            vy: -26 - Math.random() * 20,
            rot: 0,
            vr: 0,
            life: 0,
            max: 2.2 + Math.random() * 1.4,
            size: 12 + Math.random() * 10,
          })
        }
      }

      // ---- particles ----
      s.particles = s.particles.filter((p) => {
        p.life += dt
        if (p.life >= p.max) return false
        p.x += p.vx * dt
        p.y += p.vy * dt
        p.rot += p.vr * dt
        if (p.kind === 'feather') {
          p.vx *= 1 - 2.2 * dt
          p.vy = p.vy * (1 - 2.4 * dt) + 120 * dt
          p.x += Math.sin(p.life * 7 + p.size) * 30 * dt
        } else if (p.kind === 'coin') {
          p.vy += 1500 * dt
        } else if (p.kind === 'dust') {
          p.vx *= 1 - 4 * dt
          p.vy *= 1 - 4 * dt
        }
        return true
      })

      // ---- camera ----
      const camTarget = Math.max(0, Math.min(roadEnd + FINISH_W - VW, s.chickenX - VW * 0.32))
      s.camX += (camTarget - s.camX) * (1 - Math.exp(-dt * 6))
      s.shake = Math.max(0, s.shake - dt * 40)
      s.flash = Math.max(0, s.flash - dt * 2.4)
      const shx = s.shake ? (Math.random() - 0.5) * s.shake : 0
      const shy = s.shake ? (Math.random() - 0.5) * s.shake : 0

      // ================= DRAW =================
      ctx.setTransform(size.dpr, 0, 0, size.dpr, 0, 0)
      ctx.fillStyle = C.night
      ctx.fillRect(0, 0, size.w, size.h)
      ctx.save()
      ctx.scale(scale, scale)
      ctx.translate(-s.camX + shx, shy)

      const viewL = s.camX - 40
      const viewR = s.camX + VW + 40

      // start sidewalk
      ctx.fillStyle = C.walk
      ctx.fillRect(-400, 0, WALK_W + 400, VH)
      ctx.strokeStyle = C.walkSeam
      ctx.lineWidth = 2
      for (let y = 0; y <= VH; y += 72) {
        ctx.beginPath()
        ctx.moveTo(-400, y)
        ctx.lineTo(WALK_W - 16, y)
        ctx.stroke()
      }
      for (let x = WALK_W - 16 - 72; x > -400; x -= 72) {
        ctx.beginPath()
        ctx.moveTo(x, 0)
        ctx.lineTo(x, VH)
        ctx.stroke()
      }
      // street lamp pools
      for (const ly of [150, 610]) {
        const pool = ctx.createRadialGradient(WALK_W - 70, ly, 10, WALK_W - 70, ly, 230)
        pool.addColorStop(0, 'rgba(255,214,140,0.22)')
        pool.addColorStop(1, 'rgba(255,214,140,0)')
        ctx.fillStyle = pool
        ctx.fillRect(WALK_W - 300, ly - 230, 460, 460)
        ctx.fillStyle = '#2d3039'
        ctx.beginPath()
        ctx.arc(WALK_W - 70, ly, 11, 0, Math.PI * 2)
        ctx.fill()
        ctx.fillStyle = '#ffe2a8'
        ctx.beginPath()
        ctx.arc(WALK_W - 70, ly, 5, 0, Math.PI * 2)
        ctx.fill()
      }
      // curb
      ctx.fillStyle = C.curb
      ctx.fillRect(WALK_W - 16, 0, 16, VH)
      ctx.fillStyle = 'rgba(255,255,255,0.18)'
      ctx.fillRect(WALK_W - 16, 0, 4, VH)

      // road
      if (asphalt) {
        ctx.fillStyle = asphalt
        ctx.fillRect(WALK_W, 0, roadEnd - WALK_W, VH)
      }
      // lane dividers
      ctx.fillStyle = 'rgba(241,234,216,0.55)'
      for (let lane = 1; lane < lanes; lane += 1) {
        const x = WALK_W + lane * LANE_W
        if (x < viewL || x > viewR) continue
        for (let y = -10; y < VH; y += 82) ctx.fillRect(x - 3, y, 6, 46)
      }
      ctx.fillStyle = 'rgba(241,234,216,0.7)'
      ctx.fillRect(WALK_W + 6, 0, 5, VH)
      ctx.fillRect(roadEnd - 11, 0, 5, VH)

      // finish sidewalk with chequered curb
      ctx.fillStyle = C.walk
      ctx.fillRect(roadEnd, 0, FINISH_W + 600, VH)
      for (let y = 0; y < VH; y += 20) {
        ctx.fillStyle = (y / 20) % 2 === 0 ? C.gold : C.ink
        ctx.fillRect(roadEnd, y, 10, 20)
        ctx.fillStyle = (y / 20) % 2 === 0 ? C.ink : C.gold
        ctx.fillRect(roadEnd + 10, y, 10, 20)
      }

      // skid marks
      ctx.strokeStyle = 'rgba(8,8,10,0.45)'
      ctx.lineWidth = 9
      ctx.lineCap = 'round'
      for (const sk of s.skids) {
        const x = laneX(sk.lane)
        if (x < viewL || x > viewR) continue
        for (const dx of [-29, 29]) {
          ctx.beginPath()
          ctx.moveTo(x + dx, sk.from)
          ctx.lineTo(x + dx, sk.to)
          ctx.stroke()
        }
      }
      // live skids while braking
      for (let lane = 1; lane <= lanes; lane += 1) {
        const car = s.cars[lane]
        if (car?.state === 'brake' && car.skidFrom !== null) {
          const x = laneX(lane)
          for (const dx of [-29, 29]) {
            ctx.beginPath()
            ctx.moveTo(x + dx, car.skidFrom)
            ctx.lineTo(x + dx, car.y + car.len / 2 - 18)
            ctx.stroke()
          }
        }
      }

      // manholes
      const nextLane = status === 'playing' ? currentLane + 1 : status === 'idle' ? 1 : -1
      for (let lane = 1; lane <= lanes; lane += 1) {
        const x = laneX(lane)
        if (x < viewL - 60 || x > viewR + 60) continue
        const since = s.coinSince[lane]
        let face: 'iron' | 'coin' = 'iron'
        let flip = 1
        if (since !== undefined && now >= since) {
          const t = clamp01((now - since) / 320)
          flip = Math.abs(Math.cos(Math.PI * t))
          face = t < 0.5 ? 'iron' : 'coin'
        }
        const isCurrent = lane === currentLane && status === 'playing' && !s.hopping
        const glow = lane === nextLane ? 0.55 + 0.45 * Math.sin(now / 240) : isCurrent ? 0.9 : 0
        drawManhole(ctx, x, ROW_Y, compactMultiplier(multipliers[lane - 1]), face, flip, glow, now)
      }

      // cars
      for (let lane = 1; lane <= lanes; lane += 1) {
        const car = s.cars[lane]
        const x = laneX(lane)
        if (!car || x < viewL - 80 || x > viewR + 80) continue
        if (car.y + car.len / 2 < -200 || car.y - car.len / 2 > VH + 200) continue
        drawCar(ctx, car, x, now)
      }

      // barricades
      s.barriers.forEach((b, lane) => {
        if (b.state === 'none' || b.state === 'pending') return
        const x = laneX(lane)
        if (x < viewL - 80 || x > viewR + 80) return
        if (b.state === 'dropping') {
          const p = clamp01((now - b.t) / DROP_MS)
          const fall = p * p
          drawBarricade(ctx, x, BARRIER_Y, 1 + 0.95 * (1 - fall), 1, Math.min(1, p * 3), now)
        } else if (b.state === 'down') {
          const k = clamp01((now - b.t) / SETTLE_MS)
          const squash = k < 1 ? 0.8 + 0.2 * easeOutBack(k) : 1
          drawBarricade(ctx, x, BARRIER_Y, 1, squash, 1, now)
        } else {
          const p = clamp01((now - b.t) / 240)
          drawBarricade(ctx, x, BARRIER_Y, 1 + p * 0.8, 1, 1 - p, now)
        }
      })

      // chicken / roast
      if (s.roast) {
        const t = (now - s.roastStart) / 1000
        const pop = t < 0.55 ? Math.sin((Math.PI * t) / 0.55) * 96 : 0
        const spin = t < 0.55 ? t * 9 : 0
        drawRoast(ctx, s.chickenX, ROW_Y + 6, pop, spin)
        if (Math.random() < dt * 9) {
          s.particles.push({
            kind: 'steam',
            x: s.chickenX + (Math.random() - 0.5) * 40,
            y: ROW_Y - 40,
            vx: (Math.random() - 0.5) * 10,
            vy: -40,
            rot: 0,
            vr: 0,
            life: 0,
            max: 1.6,
            size: 10,
          })
        }
      } else {
        drawChicken(ctx, s.chickenX, ROW_Y + 6, lift, sx, sy, wing, blink)
      }

      for (const p of s.particles) {
        if (p.x < viewL - 100 || p.x > viewR + 100) continue
        drawParticle(ctx, p)
      }
      ctx.restore()

      // ---- screen-space finish ----
      const vig = ctx.createRadialGradient(size.w / 2, size.h * 0.55, size.h * 0.35, size.w / 2, size.h * 0.55, size.w * 0.75)
      vig.addColorStop(0, 'rgba(5,6,10,0)')
      vig.addColorStop(1, 'rgba(5,6,10,0.55)')
      ctx.fillStyle = vig
      ctx.fillRect(0, 0, size.w, size.h)
      if (s.flash > 0) {
        ctx.fillStyle = `rgba(255,75,85,${0.32 * s.flash})`
        ctx.fillRect(0, 0, size.w, size.h)
      }

      raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)

    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
    }
  }, [])

  return (
    <div ref={wrapRef} className="chicken-road">
      <canvas ref={canvasRef} className="chicken-road__canvas" />
    </div>
  )
}
