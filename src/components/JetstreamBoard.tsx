import { useEffect, useRef } from 'react'
import { JET_SPEEDS, type JetFlight } from './jetstreamLogic'

// Jetstream — 2D flight renderer modeled on Aviamasters.
// A red prop plane rolls off a carrier, flies through pickups and rockets, then
// either catches the arrestor wire on the next carrier or ends up in the sea.
// The outcome is decided before takeoff; this component only performs it.
// Motion is a pure function of time since takeoff, so the flight plays out the
// same at any frame rate.

export type JetstreamStatus = 'idle' | 'flying' | 'landed' | 'splashed'

type JetstreamBoardProps = {
  status: JetstreamStatus
  flight: JetFlight | null
  bet: number
  onFinish: (flightId: string) => void
}

// ---- layout (virtual units, 720 tall) ----
const VH = 720
const SEA_Y = 560
const DECK_Y = 500
const PLANE_DECK_Y = DECK_Y - 30
const START_X = -120
const DECK_END = 300
const FIRST_X = 760
const GAP = 320
const TAKEOFF_S = 1.0

// ---- theme: "Flight Deck Noon" ----
const C = {
  skyTop: '#2f9ef0',
  skyMid: '#7cc7f6',
  haze: '#d4efff',
  sea: '#1a7fd0',
  seaDeep: '#073b6e',
  red: '#e6332a',
  redHi: '#ff5a4e',
  redLo: '#a8201a',
  cream: '#fff2d6',
  hull: '#6d7a8a',
  hullLo: '#46525f',
  deck: '#3c4652',
  paint: '#ffd23f',
  gold: '#ffc928',
  goldDeep: '#b8860b',
  cobalt: '#3b6dff',
  navy: '#10345a',
  mint: '#3ee39a',
}

type Ending = 'landed' | 'short' | 'downed'
type Pt = { x: number; y: number; dive?: boolean }
type Plan = {
  pts: Pt[]
  eventX: number[]
  eventY: number[]
  reach: number
  ending: Ending
  landingX: number
  touchX: number
  stopX: number
  endX: number
  v: number
  tCruiseStart: number
  xCruiseStart: number
  tTouch: number
  tBrake: number
  tEnd: number
}
type Particle = {
  kind: 'spark' | 'smoke' | 'fire' | 'drop' | 'coin' | 'puff'
  x: number
  y: number
  vx: number
  vy: number
  life: number
  max: number
  size: number
  color?: string
}
type Popup = { text: string; color: string; x: number; y: number; t0: number }

function planFlight(f: JetFlight): Plan {
  const v = JET_SPEEDS[f.speed].cruise
  const eventX = f.events.map((_, i) => FIRST_X + i * GAP)
  const eventY = f.events.map((e) => 170 + e.lift * 210)
  const reach = f.downedAt ?? f.events.length - 1
  const lastX = f.events.length ? eventX[eventX.length - 1] : FIRST_X - GAP
  const landingX = lastX + 900
  const touchX = landingX - 210
  const stopX = landingX + 40

  const pts: Pt[] = [
    { x: START_X, y: PLANE_DECK_Y },
    { x: DECK_END, y: PLANE_DECK_Y },
  ]
  for (let i = 0; i <= reach; i += 1) pts.push({ x: eventX[i], y: eventY[i] })

  let ending: Ending
  let endX: number
  if (f.downedAt !== null) {
    ending = 'downed'
    endX = eventX[f.downedAt] + 380
    pts.push({ x: endX, y: SEA_Y + 34, dive: true })
  } else if (f.landed) {
    ending = 'landed'
    endX = stopX
    pts.push({ x: landingX - 660, y: 330 })
    pts.push({ x: touchX, y: PLANE_DECK_Y })
    pts.push({ x: stopX, y: PLANE_DECK_Y })
  } else {
    ending = 'short'
    endX = landingX - 520
    pts.push({ x: landingX - 720, y: 330 })
    pts.push({ x: endX, y: SEA_Y + 34, dive: true })
  }

  const xCruiseStart = START_X + 0.5 * v * TAKEOFF_S
  const tCruiseStart = TAKEOFF_S
  const cruiseTo = ending === 'landed' ? touchX : endX
  const tTouch = tCruiseStart + (cruiseTo - xCruiseStart) / v
  const tBrake = ending === 'landed' ? (2 * (stopX - touchX)) / v : 0
  const tEnd = tTouch + tBrake

  return { pts, eventX, eventY, reach, ending, landingX, touchX, stopX, endX, v, tCruiseStart, xCruiseStart, tTouch, tBrake, tEnd }
}

function xAt(p: Plan, t: number): number {
  if (t < TAKEOFF_S) return START_X + 0.5 * (p.v / TAKEOFF_S) * t * t
  if (t < p.tTouch) return p.xCruiseStart + p.v * (t - p.tCruiseStart)
  if (p.ending === 'landed') {
    const tau = Math.min(t - p.tTouch, p.tBrake)
    return p.touchX + p.v * tau - 0.5 * (p.v / p.tBrake) * tau * tau
  }
  // after hitting the water the wreck drifts a little further and stops
  return p.endX + Math.min(46, (t - p.tTouch) * p.v * 0.25)
}

function yAt(p: Plan, x: number): number {
  const pts = p.pts
  if (x <= pts[0].x) return pts[0].y
  for (let i = 0; i < pts.length - 1; i += 1) {
    const a = pts[i]
    const b = pts[i + 1]
    if (x <= b.x) {
      const t = (x - a.x) / (b.x - a.x || 1)
      const k = b.dive ? t * t : (1 - Math.cos(Math.PI * t)) / 2
      return a.y + (b.y - a.y) * k
    }
  }
  return pts[pts.length - 1].y
}

function easeOutBack(t: number) {
  const c1 = 1.70158
  const c3 = c1 + 1
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2)
}

// ---------- art ----------

function drawPlane(ctx: CanvasRenderingContext2D, x: number, y: number, angle: number, now: number, hook: boolean, alpha = 1) {
  ctx.save()
  ctx.globalAlpha = alpha
  ctx.translate(x, y)
  ctx.rotate(angle)
  ctx.scale(0.92, 0.92)
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'
  const ink = 'rgba(16,30,48,0.85)'

  // fixed landing gear
  ctx.strokeStyle = '#2b2f36'
  ctx.lineWidth = 3.5
  ctx.beginPath()
  ctx.moveTo(12, 12)
  ctx.lineTo(6, 28)
  ctx.moveTo(30, 12)
  ctx.lineTo(32, 28)
  ctx.moveTo(-56, 8)
  ctx.lineTo(-60, 15)
  ctx.stroke()
  for (const [wx, r] of [
    [6, 7.5],
    [32, 7.5],
    [-60, 4],
  ] as const) {
    ctx.fillStyle = '#1d2026'
    ctx.beginPath()
    ctx.arc(wx, wx < 0 ? 17 : 30, r, 0, Math.PI * 2)
    ctx.fill()
    ctx.fillStyle = '#9aa4b2'
    ctx.beginPath()
    ctx.arc(wx, wx < 0 ? 17 : 30, r * 0.38, 0, Math.PI * 2)
    ctx.fill()
  }
  if (hook) {
    ctx.strokeStyle = '#2b2f36'
    ctx.lineWidth = 3
    ctx.beginPath()
    ctx.moveTo(-50, 8)
    ctx.lineTo(-68, 24)
    ctx.stroke()
  }

  // tail fin
  ctx.fillStyle = C.red
  ctx.strokeStyle = ink
  ctx.lineWidth = 2.4
  ctx.beginPath()
  ctx.moveTo(-70, -6)
  ctx.lineTo(-64, -48)
  ctx.lineTo(-50, -48)
  ctx.lineTo(-38, -10)
  ctx.closePath()
  ctx.fill()
  ctx.stroke()
  ctx.fillStyle = C.cream
  ctx.beginPath()
  ctx.moveTo(-64, -48)
  ctx.lineTo(-50, -48)
  ctx.lineTo(-48, -40)
  ctx.lineTo(-65, -40)
  ctx.closePath()
  ctx.fill()

  // fuselage
  const body = ctx.createLinearGradient(0, -24, 0, 18)
  body.addColorStop(0, C.redHi)
  body.addColorStop(0.5, C.red)
  body.addColorStop(1, C.redLo)
  ctx.fillStyle = body
  ctx.beginPath()
  ctx.moveTo(-70, -8)
  ctx.quadraticCurveTo(-40, -27, 10, -23)
  ctx.quadraticCurveTo(54, -21, 66, -7)
  ctx.quadraticCurveTo(71, 4, 62, 12)
  ctx.quadraticCurveTo(10, 21, -42, 10)
  ctx.quadraticCurveTo(-70, 6, -70, -8)
  ctx.closePath()
  ctx.fill()
  ctx.stroke()

  // cream speed stripe
  ctx.strokeStyle = C.cream
  ctx.lineWidth = 5
  ctx.beginPath()
  ctx.moveTo(-62, -2)
  ctx.quadraticCurveTo(10, 3, 62, 0)
  ctx.stroke()

  // roundel
  ctx.fillStyle = C.cream
  ctx.beginPath()
  ctx.arc(-26, -9, 8, 0, Math.PI * 2)
  ctx.fill()
  ctx.fillStyle = C.navy
  ctx.beginPath()
  ctx.arc(-26, -9, 4.4, 0, Math.PI * 2)
  ctx.fill()

  // canopy + pilot
  ctx.fillStyle = '#7a4b2a'
  ctx.beginPath()
  ctx.arc(6, -27, 7, 0, Math.PI * 2)
  ctx.fill()
  const glass = ctx.createLinearGradient(0, -38, 0, -18)
  glass.addColorStop(0, 'rgba(225,246,255,0.92)')
  glass.addColorStop(1, 'rgba(74,163,216,0.75)')
  ctx.fillStyle = glass
  ctx.strokeStyle = ink
  ctx.lineWidth = 2.2
  ctx.beginPath()
  ctx.ellipse(8, -22, 21, 13, 0, Math.PI, Math.PI * 2)
  ctx.closePath()
  ctx.fill()
  ctx.stroke()
  ctx.strokeStyle = 'rgba(255,255,255,0.8)'
  ctx.lineWidth = 2.5
  ctx.beginPath()
  ctx.moveTo(-2, -29)
  ctx.quadraticCurveTo(4, -33, 12, -32)
  ctx.stroke()

  // wing
  ctx.fillStyle = '#fbf7ee'
  ctx.strokeStyle = ink
  ctx.lineWidth = 2.2
  ctx.beginPath()
  ctx.roundRect(-20, 4, 60, 9, 5)
  ctx.fill()
  ctx.stroke()
  ctx.fillStyle = 'rgba(16,30,48,0.18)'
  ctx.fillRect(-16, 10, 52, 2)

  // cowling + spinner
  ctx.fillStyle = '#2b2f36'
  ctx.beginPath()
  ctx.roundRect(58, -13, 11, 24, 4)
  ctx.fill()
  ctx.fillStyle = C.red
  ctx.beginPath()
  ctx.moveTo(69, -7)
  ctx.quadraticCurveTo(82, -1, 69, 5)
  ctx.closePath()
  ctx.fill()

  // propeller: motion-blurred disc with two ghost blades
  ctx.fillStyle = 'rgba(255,255,255,0.32)'
  ctx.beginPath()
  ctx.ellipse(73, -1, 3.5, 30, 0, 0, Math.PI * 2)
  ctx.fill()
  ctx.strokeStyle = 'rgba(30,34,42,0.55)'
  ctx.lineWidth = 3
  const ph = now / 22
  for (const off of [0, Math.PI]) {
    const yy = Math.sin(ph + off) * 28
    ctx.beginPath()
    ctx.moveTo(73, -1)
    ctx.lineTo(73, -1 + yy)
    ctx.stroke()
  }
  ctx.restore()
}

function drawCarrier(
  ctx: CanvasRenderingContext2D,
  cx: number,
  islandSide: -1 | 1,
  now: number,
  lights: number, // 0 = idle, >0 = celebration chase running
  wireAt: number | null,
) {
  ctx.save()
  ctx.lineJoin = 'round'
  // hull
  const hull = ctx.createLinearGradient(0, DECK_Y, 0, SEA_Y + 40)
  hull.addColorStop(0, C.hull)
  hull.addColorStop(1, C.hullLo)
  ctx.fillStyle = hull
  ctx.beginPath()
  ctx.moveTo(cx - 300, DECK_Y + 8)
  ctx.lineTo(cx + 300, DECK_Y + 8)
  ctx.lineTo(cx + 352, DECK_Y - 2)
  ctx.lineTo(cx + 300, SEA_Y + 40)
  ctx.lineTo(cx - 288, SEA_Y + 40)
  ctx.closePath()
  ctx.fill()
  // portholes
  ctx.fillStyle = 'rgba(16,30,48,0.55)'
  for (let px = cx - 270; px < cx + 170; px += 30) {
    ctx.beginPath()
    ctx.arc(px, DECK_Y + 20, 3, 0, Math.PI * 2)
    ctx.fill()
  }
  // hull number, painted on the bow above the waterline
  ctx.fillStyle = 'rgba(255,255,255,0.92)'
  ctx.font = '400 26px "Titan One", "Archivo", sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText('07', cx + 236, DECK_Y + 30)
  // anti-fouling waterline
  ctx.fillStyle = '#a23a2c'
  ctx.fillRect(cx - 290, SEA_Y - 5, 592, 10)

  // flight deck
  ctx.fillStyle = C.deck
  ctx.fillRect(cx - 320, DECK_Y - 4, 676, 14)
  ctx.fillStyle = '#6f7d8e'
  ctx.fillRect(cx - 320, DECK_Y - 8, 676, 5)
  ctx.fillStyle = C.paint
  for (let px = cx - 300; px < cx + 330; px += 40) ctx.fillRect(px, DECK_Y - 7, 20, 2.5)

  // deck lights (chase when a plane lands)
  for (let i = 0; i < 12; i += 1) {
    const lx = cx - 300 + i * 56
    let col = 'rgba(255,248,220,0.55)'
    if (lights > 0) {
      const phase = Math.floor(now / 90) % 12
      col = (i - phase + 12) % 12 < 3 ? C.mint : 'rgba(62,227,154,0.3)'
    }
    ctx.fillStyle = col
    ctx.beginPath()
    ctx.arc(lx, DECK_Y + 2, 2.6, 0, Math.PI * 2)
    ctx.fill()
  }

  // island superstructure
  const ix = cx + islandSide * 232
  ctx.fillStyle = '#7d8a9b'
  ctx.strokeStyle = 'rgba(16,30,48,0.35)'
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.roundRect(ix - 34, DECK_Y - 62, 68, 56, 4)
  ctx.fill()
  ctx.stroke()
  ctx.fillStyle = '#8c99aa'
  ctx.beginPath()
  ctx.roundRect(ix - 42, DECK_Y - 86, 84, 26, 4)
  ctx.fill()
  ctx.stroke()
  ctx.fillStyle = '#ffe9a8'
  for (let w = 0; w < 5; w += 1) ctx.fillRect(ix - 34 + w * 15, DECK_Y - 79, 9, 8)
  // mast, radar, pennant
  ctx.strokeStyle = '#3c4652'
  ctx.lineWidth = 3
  ctx.beginPath()
  ctx.moveTo(ix, DECK_Y - 86)
  ctx.lineTo(ix, DECK_Y - 142)
  ctx.moveTo(ix - 16, DECK_Y - 122)
  ctx.lineTo(ix + 16, DECK_Y - 122)
  ctx.stroke()
  ctx.fillStyle = '#c5ced9'
  ctx.beginPath()
  ctx.ellipse(ix, DECK_Y - 104, 4 + Math.abs(Math.cos(now / 520)) * 14, 4, 0, 0, Math.PI * 2)
  ctx.fill()
  ctx.fillStyle = C.red
  const wave = Math.sin(now / 180) * 3
  ctx.beginPath()
  ctx.moveTo(ix, DECK_Y - 142)
  ctx.quadraticCurveTo(ix + 12, DECK_Y - 140 + wave, ix + 24, DECK_Y - 136)
  ctx.lineTo(ix, DECK_Y - 130)
  ctx.closePath()
  ctx.fill()

  // arrestor wire anchor posts
  if (wireAt !== null) {
    ctx.fillStyle = '#2b2f36'
    ctx.fillRect(wireAt - 3, DECK_Y - 16, 6, 10)
  }

  // bow foam
  ctx.strokeStyle = 'rgba(255,255,255,0.75)'
  ctx.lineWidth = 3
  ctx.beginPath()
  for (let k = 0; k < 6; k += 1) {
    const fx = cx + 300 - k * 22
    const fy = SEA_Y + Math.sin(now / 240 + k) * 2.5
    if (k === 0) ctx.moveTo(fx, fy)
    else ctx.lineTo(fx, fy)
  }
  ctx.stroke()
  ctx.restore()
}

function drawPickup(ctx: CanvasRenderingContext2D, type: 'add' | 'mult', label: string, x: number, y: number, now: number) {
  ctx.save()
  ctx.translate(x, y + Math.sin(now / 340 + x) * 6)
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  if (type === 'add') {
    const halo = ctx.createRadialGradient(0, 0, 18, 0, 0, 52)
    halo.addColorStop(0, 'rgba(255,201,40,0.35)')
    halo.addColorStop(1, 'rgba(255,201,40,0)')
    ctx.fillStyle = halo
    ctx.beginPath()
    ctx.arc(0, 0, 52, 0, Math.PI * 2)
    ctx.fill()
    const coin = ctx.createRadialGradient(-9, -10, 3, 0, 0, 31)
    coin.addColorStop(0, '#fff3b8')
    coin.addColorStop(0.5, C.gold)
    coin.addColorStop(1, C.goldDeep)
    ctx.fillStyle = coin
    ctx.strokeStyle = 'rgba(107,74,0,0.8)'
    ctx.lineWidth = 2.5
    ctx.beginPath()
    ctx.arc(0, 0, 31, 0, Math.PI * 2)
    ctx.fill()
    ctx.stroke()
    ctx.strokeStyle = 'rgba(107,74,0,0.35)'
    ctx.beginPath()
    ctx.arc(0, 0, 24, 0, Math.PI * 2)
    ctx.stroke()
    ctx.fillStyle = '#5c3f00'
    ctx.font = '400 18px "Titan One", "Archivo", sans-serif'
    ctx.fillText(label, 0, 1)
  } else {
    ctx.save()
    ctx.rotate(Math.PI / 4)
    const gem = ctx.createLinearGradient(-24, -24, 24, 24)
    gem.addColorStop(0, '#7ea2ff')
    gem.addColorStop(1, '#2350d6')
    ctx.fillStyle = gem
    ctx.strokeStyle = C.gold
    ctx.lineWidth = 3.5
    ctx.beginPath()
    ctx.roundRect(-25, -25, 50, 50, 9)
    ctx.fill()
    ctx.stroke()
    ctx.restore()
    ctx.fillStyle = '#ffffff'
    ctx.strokeStyle = 'rgba(16,52,90,0.7)'
    ctx.lineWidth = 4
    ctx.font = '400 22px "Titan One", "Archivo", sans-serif'
    ctx.strokeText(label, 0, 1)
    ctx.fillText(label, 0, 1)
  }
  ctx.restore()
}

function drawRocket(ctx: CanvasRenderingContext2D, x: number, y: number, angle: number, now: number) {
  ctx.save()
  ctx.translate(x, y)
  ctx.rotate(angle)
  ctx.scale(1.45, 1.45)
  // exhaust flame (behind = -x)
  const flick = 0.8 + Math.sin(now / 30) * 0.2
  const flame = ctx.createLinearGradient(-70 * flick, 0, -18, 0)
  flame.addColorStop(0, 'rgba(255,120,30,0)')
  flame.addColorStop(0.5, 'rgba(255,170,40,0.85)')
  flame.addColorStop(1, '#fff3c0')
  ctx.fillStyle = flame
  ctx.beginPath()
  ctx.moveTo(-18, -6)
  ctx.lineTo(-70 * flick, 0)
  ctx.lineTo(-18, 6)
  ctx.closePath()
  ctx.fill()
  // body
  ctx.fillStyle = '#e9edf2'
  ctx.strokeStyle = 'rgba(16,30,48,0.85)'
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.roundRect(-20, -7, 38, 14, 5)
  ctx.fill()
  ctx.stroke()
  ctx.fillStyle = C.red
  ctx.beginPath()
  ctx.moveTo(18, -7)
  ctx.quadraticCurveTo(34, 0, 18, 7)
  ctx.closePath()
  ctx.fill()
  ctx.stroke()
  ctx.beginPath()
  ctx.moveTo(-20, -7)
  ctx.lineTo(-28, -15)
  ctx.lineTo(-12, -7)
  ctx.moveTo(-20, 7)
  ctx.lineTo(-28, 15)
  ctx.lineTo(-12, 7)
  ctx.fill()
  ctx.stroke()
  ctx.restore()
}

type Cloud = { x: number; y: number; s: number; par: number; blobs: [number, number, number][] }

function makeClouds(): Cloud[] {
  const clouds: Cloud[] = []
  for (let i = 0; i < 16; i += 1) {
    const far = i % 2 === 0
    const blobs: [number, number, number][] = []
    const n = 4 + Math.floor(Math.random() * 3)
    for (let b = 0; b < n; b += 1) {
      blobs.push([b * 34 - n * 17 + Math.random() * 10, -Math.random() * 18 - (b % 2) * 10, 26 + Math.random() * 18])
    }
    clouds.push({
      x: Math.random() * 3600,
      y: far ? 70 + Math.random() * 120 : 120 + Math.random() * 230,
      s: far ? 0.55 + Math.random() * 0.25 : 0.85 + Math.random() * 0.4,
      par: far ? 0.18 : 0.5,
      blobs,
    })
  }
  return clouds
}

type Scene = {
  flight: JetFlight | null
  plan: Plan | null
  t0: number
  nextEvent: number
  counter: number
  counterPop: number
  counterTint: 'gain' | 'loss' | null
  finished: boolean
  finishedAt: number
  splashedAt: number
  landedAt: number
  hitAt: number
  particles: Particle[]
  popups: Popup[]
  camX: number
  shake: number
  bet: number
  status: JetstreamStatus
}

export default function JetstreamBoard({ status, flight, bet, onFinish }: JetstreamBoardProps) {
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const onFinishRef = useRef(onFinish)
  const sceneRef = useRef<Scene>({
    flight: null,
    plan: null,
    t0: 0,
    nextEvent: 0,
    counter: 1,
    counterPop: 0,
    counterTint: null,
    finished: false,
    finishedAt: 0,
    splashedAt: 0,
    landedAt: 0,
    hitAt: 0,
    particles: [],
    popups: [],
    camX: START_X - 380,
    shake: 0,
    bet,
    status,
  })

  useEffect(() => {
    onFinishRef.current = onFinish
  }, [onFinish])

  useEffect(() => {
    const s = sceneRef.current
    s.bet = bet
    s.status = status
    if (flight && flight !== s.flight) {
      s.flight = flight
      s.plan = planFlight(flight)
      s.t0 = performance.now()
      s.nextEvent = 0
      s.counter = 1
      s.counterPop = 0
      s.counterTint = null
      s.finished = false
      s.finishedAt = 0
      s.splashedAt = 0
      s.landedAt = 0
      s.hitAt = 0
      s.particles = []
      s.popups = []
    } else if (!flight && s.flight) {
      s.flight = null
      s.plan = null
      s.counter = 1
      s.particles = []
      s.popups = []
    }
  }, [status, flight, bet])

  useEffect(() => {
    const wrap = wrapRef.current
    const canvas = canvasRef.current
    if (!wrap || !canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const clouds = makeClouds()

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

    const burst = (kind: Particle['kind'], x: number, y: number, n: number, speed: number, up = 0, color?: string) => {
      const s = sceneRef.current
      for (let i = 0; i < n; i += 1) {
        const a = Math.random() * Math.PI * 2
        const sp = speed * (0.35 + Math.random() * 0.8)
        s.particles.push({
          kind,
          x,
          y,
          vx: Math.cos(a) * sp,
          vy: Math.sin(a) * sp - up,
          life: 0,
          max: kind === 'smoke' ? 1.1 + Math.random() * 0.6 : kind === 'drop' ? 1.1 : kind === 'coin' ? 1.6 : 0.6,
          size: kind === 'smoke' ? 14 + Math.random() * 12 : kind === 'fire' ? 16 + Math.random() * 10 : 4 + Math.random() * 5,
          color,
        })
      }
    }

    const frame = (now: number) => {
      const dt = Math.max(0, Math.min(0.05, (now - last) / 1000))
      last = now
      const s = sceneRef.current
      const scale = size.h / VH
      const VW = size.w / scale
      const plan = s.plan
      const f = s.flight

      // ---- simulate ----
      let px = START_X
      let py = PLANE_DECK_Y
      let angle = 0
      let planeAlpha = 1
      let hook = false
      let landingCenter: number | null = null

      if (plan && f) {
        const t = (now - s.t0) / 1000
        landingCenter = plan.landingX
        px = xAt(plan, t)
        py = yAt(plan, px)
        const ahead = yAt(plan, px + 6) - yAt(plan, px - 6)
        angle = Math.max(-0.5, Math.min(1.2, Math.atan2(ahead, 12)))
        hook = plan.ending === 'landed' && px > plan.touchX - 260

        // events the plane has flown through
        while (s.nextEvent <= plan.reach && px >= plan.eventX[s.nextEvent]) {
          const ev = f.events[s.nextEvent]
          const ex = plan.eventX[s.nextEvent]
          const ey = plan.eventY[s.nextEvent]
          s.counter = ev.counterAfter
          s.counterPop = now
          if (ev.type === 'rocket') {
            s.counterTint = 'loss'
            s.shake = 12
            s.hitAt = now
            burst('fire', ex, ey, 7, 120)
            burst('smoke', ex, ey, 8, 90)
            burst('spark', ex, ey, 12, 380, 0, '#ffd28a')
            s.popups.push({ text: ev.label, color: '#ff4b55', x: ex, y: ey - 50, t0: now })
          } else {
            s.counterTint = 'gain'
            burst('spark', ex, ey, 14, 300, 0, ev.type === 'add' ? C.gold : '#9db8ff')
            s.popups.push({ text: ev.label, color: ev.type === 'add' ? C.gold : '#c9d8ff', x: ex, y: ey - 50, t0: now })
          }
          s.nextEvent += 1
        }

        // trailing smoke once hit by the fatal rocket
        if (plan.ending === 'downed' && f.downedAt !== null && s.nextEvent > f.downedAt && py < SEA_Y) {
          if (Math.random() < dt * 30) {
            s.particles.push({ kind: 'smoke', x: px - 50, y: py, vx: -30, vy: -20, life: 0, max: 1.4, size: 12, color: '#3a3f48' })
          }
          angle += Math.sin(now / 90) * 0.18 + 0.25
        }

        // hitting the water
        if (plan.ending !== 'landed' && py >= SEA_Y - 4 && !s.splashedAt) {
          s.splashedAt = now
          s.shake = 10
          burst('drop', px + 30, SEA_Y, 34, 420, 380)
          burst('puff', px + 30, SEA_Y, 10, 160, 60)
        }
        if (s.splashedAt) {
          const k = Math.min(1, (now - s.splashedAt) / 900)
          py = SEA_Y + 6 + k * 26
          planeAlpha = 1 - k
        }

        // touchdown + wire catch
        if (plan.ending === 'landed' && t >= plan.tTouch && !s.landedAt) {
          s.landedAt = now
          burst('puff', px - 10, PLANE_DECK_Y + 30, 6, 120, 30)
        }
        if (s.landedAt && t >= plan.tEnd && !s.finishedAt) {
          s.finishedAt = now
          for (let i = 0; i < 26; i += 1) {
            const a = -Math.PI / 2 + (Math.random() - 0.5) * 1.5
            const sp = 420 + Math.random() * 420
            s.particles.push({
              kind: 'coin',
              x: px,
              y: PLANE_DECK_Y - 30,
              vx: Math.cos(a) * sp,
              vy: Math.sin(a) * sp,
              life: 0,
              max: 1.8,
              size: 9 + Math.random() * 6,
            })
          }
          s.counterPop = now
          s.counterTint = 'gain'
        }

        const done =
          (plan.ending === 'landed' && s.finishedAt && now - s.finishedAt > 650) ||
          (plan.ending !== 'landed' && s.splashedAt && now - s.splashedAt > 1000)
        if (done && !s.finished) {
          s.finished = true
          if (!s.finishedAt) s.finishedAt = now
          onFinishRef.current(f.id)
        }
      } else {
        py = PLANE_DECK_Y + Math.sin(now / 600) * 0.6
      }

      // particles
      s.particles = s.particles.filter((p) => {
        p.life += dt
        if (p.life >= p.max) return false
        p.x += p.vx * dt
        p.y += p.vy * dt
        if (p.kind === 'drop' || p.kind === 'coin') p.vy += 1500 * dt
        else if (p.kind === 'smoke' || p.kind === 'puff') {
          p.vx *= 1 - 1.8 * dt
          p.vy = p.vy * (1 - 1.8 * dt) - 24 * dt
        } else {
          p.vx *= 1 - 3 * dt
          p.vy *= 1 - 3 * dt
        }
        return true
      })
      s.popups = s.popups.filter((p) => now - p.t0 < 1000)

      // camera
      const camTarget = Math.max(START_X - VW * 0.34, px - VW * 0.36)
      s.camX += (camTarget - s.camX) * (1 - Math.exp(-dt * 4.5))
      s.shake = Math.max(0, s.shake - dt * 30)
      const shx = s.shake ? (Math.random() - 0.5) * s.shake : 0
      const shy = s.shake ? (Math.random() - 0.5) * s.shake : 0

      // ================= DRAW =================
      ctx.setTransform(size.dpr, 0, 0, size.dpr, 0, 0)
      ctx.save()
      ctx.scale(scale, scale)

      // sky
      const sky = ctx.createLinearGradient(0, 0, 0, SEA_Y)
      sky.addColorStop(0, C.skyTop)
      sky.addColorStop(0.62, C.skyMid)
      sky.addColorStop(1, C.haze)
      ctx.fillStyle = sky
      ctx.fillRect(0, 0, VW, SEA_Y)

      // sun
      const sunX = VW * 0.8
      const sunGlow = ctx.createRadialGradient(sunX, 120, 10, sunX, 120, 260)
      sunGlow.addColorStop(0, 'rgba(255,248,214,0.95)')
      sunGlow.addColorStop(0.25, 'rgba(255,248,214,0.35)')
      sunGlow.addColorStop(1, 'rgba(255,248,214,0)')
      ctx.fillStyle = sunGlow
      ctx.fillRect(sunX - 260, 0, 520, 400)
      ctx.fillStyle = '#fffbea'
      ctx.beginPath()
      ctx.arc(sunX, 120, 44, 0, Math.PI * 2)
      ctx.fill()

      // clouds (two parallax layers, wrapping)
      for (const cl of clouds) {
        const wrapW = 3600
        let cx = (cl.x - s.camX * cl.par - now * 0.004 * (cl.par > 0.3 ? 2 : 1)) % wrapW
        if (cx < -300) cx += wrapW
        if (cx > VW + 300) continue
        ctx.save()
        ctx.translate(cx, cl.y)
        ctx.scale(cl.s, cl.s)
        ctx.globalAlpha = cl.par > 0.3 ? 0.95 : 0.75
        ctx.fillStyle = '#dbeefa'
        for (const [bx, by, r] of cl.blobs) {
          ctx.beginPath()
          ctx.arc(bx + 4, by + 8, r, 0, Math.PI * 2)
          ctx.fill()
        }
        ctx.fillStyle = '#ffffff'
        for (const [bx, by, r] of cl.blobs) {
          ctx.beginPath()
          ctx.arc(bx, by, r, 0, Math.PI * 2)
          ctx.fill()
        }
        ctx.restore()
      }

      // distant islands
      ctx.fillStyle = 'rgba(70,120,140,0.45)'
      for (let i = 0; i < 4; i += 1) {
        const ix = ((i * 1100 + 300 - s.camX * 0.1) % 4400) - 200
        if (ix < -400 || ix > VW + 400) continue
        ctx.beginPath()
        ctx.moveTo(ix - 160, SEA_Y)
        ctx.quadraticCurveTo(ix - 60, SEA_Y - 46 - (i % 2) * 20, ix + 40, SEA_Y - 22)
        ctx.quadraticCurveTo(ix + 110, SEA_Y - 34, ix + 180, SEA_Y)
        ctx.closePath()
        ctx.fill()
      }

      // sea
      const sea = ctx.createLinearGradient(0, SEA_Y, 0, VH)
      sea.addColorStop(0, C.sea)
      sea.addColorStop(1, C.seaDeep)
      ctx.fillStyle = sea
      ctx.fillRect(0, SEA_Y, VW, VH - SEA_Y)
      ctx.fillStyle = 'rgba(255,255,255,0.5)'
      ctx.fillRect(0, SEA_Y, VW, 2)
      for (let k = 0; k < 9; k += 1) {
        const wy = SEA_Y + 12 + k * 6 + k * k * 1.7
        const spacing = 120 + k * 36
        const par = 0.55 + k * 0.07
        const off = ((s.camX * par + now * 0.012 * (k + 1)) % spacing + spacing) % spacing
        ctx.strokeStyle = `rgba(255,255,255,${0.1 + k * 0.012})`
        ctx.lineWidth = 2 + k * 0.25
        for (let x = -off; x < VW + spacing; x += spacing) {
          ctx.beginPath()
          ctx.moveTo(x, wy)
          ctx.quadraticCurveTo(x + 14 + k * 2, wy - 3, x + 28 + k * 4, wy)
          ctx.stroke()
        }
      }
      // sun glint
      for (let k = 0; k < 10; k += 1) {
        const gy = SEA_Y + 8 + k * 14
        const gw = 30 + k * 6 + Math.sin(now / 200 + k) * 10
        ctx.fillStyle = `rgba(255,250,220,${0.35 - k * 0.03})`
        ctx.fillRect(sunX - gw / 2 + Math.sin(now / 300 + k * 2) * 8, gy, gw, 2)
      }

      // ---- world space ----
      ctx.save()
      ctx.translate(-s.camX + shx, shy)

      // launch carrier
      drawCarrier(ctx, 0, -1, now, 0, null)
      // landing carrier
      if (landingCenter !== null && plan) {
        const lights = plan.ending === 'landed' && s.landedAt ? 1 : 0
        drawCarrier(ctx, landingCenter, 1, now, lights, plan.ending === 'landed' ? plan.touchX + 30 : null)
      }

      // pickups & rockets
      if (plan && f) {
        for (let i = 0; i < f.events.length; i += 1) {
          const ev = f.events[i]
          const ex = plan.eventX[i]
          const ey = plan.eventY[i]
          if (i < s.nextEvent) continue
          if (ex - s.camX < -120 || ex - s.camX > VW + 600) continue
          if (ev.type === 'rocket') {
            if (i > plan.reach) continue
            const lead = 600
            if (px < ex - lead) continue
            const k = Math.min(1, (px - (ex - lead)) / lead)
            const sx0 = ex + 460
            const sy0 = ey - 250
            const rx = sx0 + (ex - sx0) * k
            const ry = sy0 + (ey - sy0) * k
            drawRocket(ctx, rx, ry, Math.atan2(ey - sy0, ex - sx0), now)
          } else {
            drawPickup(ctx, ev.type, ev.label, ex, ey, now)
          }
        }
      }

      // arrestor wire stretching from the tail hook
      if (plan && plan.ending === 'landed' && s.landedAt && !s.finished) {
        const anchor = plan.touchX + 30
        const tailX = px - 58 * Math.cos(angle)
        if (tailX > anchor) {
          ctx.strokeStyle = '#1d2026'
          ctx.lineWidth = 2.5
          ctx.beginPath()
          ctx.moveTo(anchor, DECK_Y - 10)
          ctx.lineTo(tailX, py + 20)
          ctx.stroke()
        }
      }

      // particles behind the plane (smoke, fire)
      for (const p of s.particles) {
        if (p.kind !== 'smoke' && p.kind !== 'fire' && p.kind !== 'puff') continue
        const t = p.life / p.max
        const r = p.size * (0.6 + t * 1.6)
        const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r)
        if (p.kind === 'fire') {
          g.addColorStop(0, `rgba(255,244,190,${0.9 * (1 - t)})`)
          g.addColorStop(0.5, `rgba(255,150,40,${0.7 * (1 - t)})`)
          g.addColorStop(1, 'rgba(255,90,30,0)')
        } else if (p.kind === 'puff') {
          g.addColorStop(0, `rgba(255,255,255,${0.7 * (1 - t)})`)
          g.addColorStop(1, 'rgba(255,255,255,0)')
        } else {
          const c = p.color === '#3a3f48' ? '58,63,72' : '120,126,138'
          g.addColorStop(0, `rgba(${c},${0.55 * (1 - t)})`)
          g.addColorStop(1, `rgba(${c},0)`)
        }
        ctx.fillStyle = g
        ctx.beginPath()
        ctx.arc(p.x, p.y, r, 0, Math.PI * 2)
        ctx.fill()
      }

      // plane
      if (!(plan && s.splashedAt && now - s.splashedAt > 900)) {
        const wobble = s.hitAt && now - s.hitAt < 500 ? Math.sin((now - s.hitAt) / 30) * 0.12 * (1 - (now - s.hitAt) / 500) : 0
        drawPlane(ctx, px, py, angle + wobble, now, hook, planeAlpha)
      }

      // foreground particles
      for (const p of s.particles) {
        const t = p.life / p.max
        if (p.kind === 'spark') {
          ctx.fillStyle = p.color ?? C.gold
          ctx.globalAlpha = 1 - t
          ctx.beginPath()
          ctx.arc(p.x, p.y, p.size * (1 - t * 0.5), 0, Math.PI * 2)
          ctx.fill()
          ctx.globalAlpha = 1
        } else if (p.kind === 'drop') {
          ctx.fillStyle = `rgba(225,244,255,${1 - t})`
          ctx.beginPath()
          ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2)
          ctx.fill()
        } else if (p.kind === 'coin') {
          ctx.save()
          ctx.translate(p.x, p.y)
          ctx.scale(Math.abs(Math.cos(p.life * 10)) + 0.15, 1)
          ctx.globalAlpha = 1 - Math.max(0, t - 0.7) / 0.3
          const g = ctx.createRadialGradient(-3, -3, 1, 0, 0, p.size)
          g.addColorStop(0, '#fff3b8')
          g.addColorStop(0.5, C.gold)
          g.addColorStop(1, C.goldDeep)
          ctx.fillStyle = g
          ctx.beginPath()
          ctx.arc(0, 0, p.size, 0, Math.PI * 2)
          ctx.fill()
          ctx.restore()
        }
      }

      // splash rings
      if (s.splashedAt) {
        const k = Math.min(1, (now - s.splashedAt) / 1100)
        ctx.strokeStyle = `rgba(255,255,255,${0.8 * (1 - k)})`
        ctx.lineWidth = 3
        for (const m of [1, 0.6]) {
          ctx.beginPath()
          ctx.ellipse(px + 30, SEA_Y + 4, 30 + k * 150 * m, 6 + k * 22 * m, 0, 0, Math.PI * 2)
          ctx.stroke()
        }
      }

      // floating pickup labels
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      for (const pop of s.popups) {
        const k = (now - pop.t0) / 1000
        ctx.globalAlpha = 1 - k * k
        ctx.font = '400 30px "Titan One", "Archivo", sans-serif'
        ctx.lineWidth = 7
        ctx.strokeStyle = C.navy
        ctx.lineJoin = 'round'
        ctx.strokeText(pop.text, pop.x, pop.y - k * 70)
        ctx.fillStyle = pop.color
        ctx.fillText(pop.text, pop.x, pop.y - k * 70)
        ctx.globalAlpha = 1
      }
      ctx.restore()

      // ---- counter balance (screen space) ----
      const money = s.bet * s.counter
      const splashed = s.status === 'splashed'
      const landed = s.status === 'landed'
      const popK = s.counterPop ? Math.min(1, (now - s.counterPop) / 320) : 1
      const popScale = popK < 1 ? 1 + 0.16 * (1 - easeOutBack(popK) + (1 - popK) * 0.4) : 1
      const tintActive = s.counterPop && now - s.counterPop < 420
      ctx.save()
      ctx.translate(VW / 2, 92)
      ctx.scale(popScale, popScale)
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.lineJoin = 'round'
      ctx.font = '400 64px "Titan One", "Archivo", sans-serif'
      ctx.lineWidth = 12
      ctx.strokeStyle = C.navy
      const text = splashed ? '$0.00' : `$${money.toFixed(2)}`
      ctx.strokeText(text, 0, 0)
      ctx.fillStyle = splashed
        ? '#ff6a6a'
        : landed
          ? C.paint
          : tintActive && s.counterTint === 'gain'
            ? '#fff1a8'
            : tintActive && s.counterTint === 'loss'
              ? '#ffb0b0'
              : '#ffffff'
      ctx.fillText(text, 0, 0)
      ctx.restore()

      // multiplier pill / outcome banner
      ctx.save()
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.font = '400 22px "Titan One", "Archivo", sans-serif'
      let pill = `${s.counter.toFixed(2)}x`
      let pillBg = 'rgba(16,52,90,0.78)'
      let pillFg = '#ffffff'
      if (landed) {
        pill = `Landed · ${s.counter.toFixed(2)}x`
        pillBg = C.paint
        pillFg = C.navy
      } else if (splashed) {
        pill = 'Splash!'
        pillBg = '#e6332a'
      }
      const pw = ctx.measureText(pill).width + 34
      ctx.fillStyle = pillBg
      ctx.beginPath()
      ctx.roundRect(VW / 2 - pw / 2, 138, pw, 36, 18)
      ctx.fill()
      ctx.fillStyle = pillFg
      ctx.fillText(pill, VW / 2, 157)
      ctx.restore()

      ctx.restore()
      raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)
    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
    }
  }, [])

  return (
    <div ref={wrapRef} className="jet-canvas-wrap">
      <canvas ref={canvasRef} className="jet-canvas" />
    </div>
  )
}
