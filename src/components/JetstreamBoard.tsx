import { useEffect, useRef, type MutableRefObject } from 'react'
import { formatMultiplier, JET_FLIGHT_MS, type JetRound } from './jetstreamLogic'

export type JetstreamStatus = 'idle' | 'flying' | 'cashed' | 'splashed'

type JetstreamBoardProps = {
  status: JetstreamStatus
  round: JetRound | null
  carrier: number // 0 = launch carrier, 1..N = landed on carrier i
  splashSegment: number | null
  multiplierRef: MutableRefObject<{ value: number }>
}

const CARRIER_GAP = 300
const LAND_MS = 700
const SPLASH_MS = 900

function carrierWorldX(i: number): number {
  return i * CARRIER_GAP
}

function easeInOut(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2
}

function drawPlane(ctx: CanvasRenderingContext2D, x: number, y: number, scale: number, tilt: number, alpha: number) {
  ctx.save()
  ctx.globalAlpha = alpha
  ctx.translate(x, y)
  ctx.rotate(tilt)
  ctx.scale(scale, scale)

  ctx.fillStyle = '#2c3550'
  ctx.beginPath()
  ctx.roundRect(-26, 12, 46, 7, 3)
  ctx.fill()
  ctx.strokeStyle = '#4a5675'
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.moveTo(-14, 12)
  ctx.lineTo(-10, 4)
  ctx.moveTo(8, 12)
  ctx.lineTo(6, 4)
  ctx.stroke()

  const body = ctx.createLinearGradient(0, -8, 0, 8)
  body.addColorStop(0, '#eaf2ff')
  body.addColorStop(1, '#9fb6dd')
  ctx.fillStyle = body
  ctx.beginPath()
  ctx.moveTo(-24, 2)
  ctx.quadraticCurveTo(-24, -6, -8, -7)
  ctx.lineTo(20, -5)
  ctx.quadraticCurveTo(30, -2, 20, 3)
  ctx.lineTo(-8, 6)
  ctx.quadraticCurveTo(-24, 8, -24, 2)
  ctx.closePath()
  ctx.fill()

  ctx.fillStyle = '#5eb3ff'
  ctx.beginPath()
  ctx.moveTo(-24, 1)
  ctx.lineTo(-32, -12)
  ctx.lineTo(-20, -3)
  ctx.closePath()
  ctx.fill()

  ctx.fillStyle = '#c2d4f2'
  ctx.beginPath()
  ctx.roundRect(-6, -2, 22, 5, 2)
  ctx.fill()

  ctx.fillStyle = '#1b2740'
  ctx.beginPath()
  ctx.ellipse(10, -2, 5, 3, 0, 0, Math.PI * 2)
  ctx.fill()

  ctx.strokeStyle = 'rgba(233,239,255,0.7)'
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.moveTo(26, -6)
  ctx.lineTo(26, 6)
  ctx.stroke()

  ctx.restore()
}

function drawCarrier(ctx: CanvasRenderingContext2D, cx: number, deckY: number, active: boolean) {
  ctx.save()
  // hull
  ctx.fillStyle = '#39435c'
  ctx.beginPath()
  ctx.moveTo(cx - 74, deckY)
  ctx.lineTo(cx + 74, deckY)
  ctx.lineTo(cx + 58, deckY + 26)
  ctx.lineTo(cx - 58, deckY + 26)
  ctx.closePath()
  ctx.fill()
  // deck
  ctx.fillStyle = active ? '#3c4a63' : '#333c52'
  ctx.fillRect(cx - 74, deckY - 8, 148, 10)
  // deck stripe
  ctx.strokeStyle = active ? 'rgba(255,206,84,0.9)' : 'rgba(233,239,255,0.35)'
  ctx.lineWidth = 2
  ctx.setLineDash([10, 8])
  ctx.beginPath()
  ctx.moveTo(cx - 64, deckY - 3)
  ctx.lineTo(cx + 64, deckY - 3)
  ctx.stroke()
  ctx.setLineDash([])
  // island tower
  ctx.fillStyle = '#4a5675'
  ctx.fillRect(cx + 40, deckY - 26, 18, 18)
  ctx.restore()
}

function nodeColors(type: 'mult' | 'div') {
  return type === 'div'
    ? { fill: '#7a1f2b', stroke: '#ff5b6a', text: '#ffd7db' }
    : { fill: '#123a2a', stroke: '#57e08a', text: '#d6ffe8' }
}

type SceneState = {
  status: JetstreamStatus
  round: JetRound | null
  carrier: number
  splashSegment: number | null
  planeX: number
  planeY: number
  fromX: number
  toX: number
  tweenStart: number
  tweening: boolean
  landStart: number
  landing: boolean
  splashStart: number
  splashing: boolean
  camX: number
  displayMult: number
  prevCarrier: number
}

export default function JetstreamBoard({ status, round, carrier, splashSegment, multiplierRef }: JetstreamBoardProps) {
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const sizeRef = useRef({ w: 900, h: 480, dpr: 1 })
  const sRef = useRef<SceneState>({
    status: 'idle',
    round: null,
    carrier: 0,
    splashSegment: null,
    planeX: 0,
    planeY: 0,
    fromX: 0,
    toX: 0,
    tweenStart: 0,
    tweening: false,
    landStart: 0,
    landing: false,
    splashStart: 0,
    splashing: false,
    camX: 0,
    displayMult: 1,
    prevCarrier: 0,
  })

  useEffect(() => {
    const s = sRef.current
    const prevStatus = s.status
    s.round = round
    s.splashSegment = splashSegment

    // new round
    if (status === 'flying' && prevStatus !== 'flying' && carrier === 0) {
      s.planeX = carrierWorldX(0)
      s.camX = carrierWorldX(0)
      s.displayMult = 1
      s.landing = false
      s.splashing = false
    }

    // hop onto a new carrier
    if (status === 'flying' && carrier !== s.carrier) {
      s.fromX = s.planeX
      s.toX = carrierWorldX(carrier)
      s.tweenStart = performance.now()
      s.tweening = true
      s.landing = false
    }

    if (status === 'cashed' && prevStatus !== 'cashed') {
      s.landStart = performance.now()
      s.landing = true
    }

    if (status === 'splashed' && prevStatus !== 'splashed') {
      const target = splashSegment ?? s.carrier + 1
      s.fromX = s.planeX
      s.toX = carrierWorldX(target)
      s.splashStart = performance.now()
      s.splashing = true
      s.tweening = false
    }

    s.prevCarrier = s.carrier
    s.carrier = carrier
    s.status = status
  }, [status, round, carrier, splashSegment])

  useEffect(() => {
    const wrap = wrapRef.current
    const canvas = canvasRef.current
    if (!wrap || !canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const resize = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1)
      const w = wrap.clientWidth || 900
      const h = wrap.clientHeight || 480
      canvas.width = Math.round(w * dpr)
      canvas.height = Math.round(h * dpr)
      canvas.style.width = `${w}px`
      canvas.style.height = `${h}px`
      sizeRef.current = { w, h, dpr }
    }
    resize()
    const ro = new ResizeObserver(resize)
    ro.observe(wrap)

    let raf = 0
    let lastNodeMult = 1

    const render = (now: number) => {
      const s = sRef.current
      const { w, h, dpr } = sizeRef.current
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

      const waterY = h * 0.7
      const cruiseY = waterY - 132
      const screenX = (worldX: number) => worldX - s.camX + w * 0.3

      // ---- update plane ----
      let tilt = -0.12
      if (s.tweening) {
        const p = Math.min(1, (now - s.tweenStart) / JET_FLIGHT_MS)
        const e = easeInOut(p)
        s.planeX = s.fromX + (s.toX - s.fromX) * e
        s.planeY = cruiseY - Math.sin(p * Math.PI) * 64
        tilt = -0.32 + p * 0.5
        if (p >= 1) {
          s.tweening = false
          s.planeY = cruiseY
        }
      } else if (s.splashing) {
        const p = Math.min(1, (now - s.splashStart) / SPLASH_MS)
        s.planeX = s.fromX + (s.toX - s.fromX) * 0.55 * Math.min(1, p * 1.6)
        s.planeY = cruiseY + (waterY + 14 - cruiseY) * easeInOut(p)
        tilt = 0.2 + p * 1.0
      } else if (s.landing) {
        const p = Math.min(1, (now - s.landStart) / LAND_MS)
        s.planeX = carrierWorldX(s.carrier)
        s.planeY = cruiseY + (waterY - 22 - cruiseY) * easeInOut(p)
        tilt = -0.12 + p * 0.12
      } else {
        s.planeY = cruiseY + Math.sin(now / 500) * 4
      }

      // ---- running multiplier ----
      if (s.tweening && s.round) {
        const seg = s.carrier - 1
        const nodes = s.round.nodes[seg] ?? []
        const startMult = seg > 0 ? s.round.multipliers[seg - 1] : 1
        const endMult = s.round.multipliers[seg] ?? 1
        const span = s.toX - s.fromX || 1
        const progressX = (s.planeX - s.fromX) / span
        // apply node effects as the plane passes them
        let val = startMult
        for (let n = 0; n < nodes.length; n += 1) {
          const nodeFrac = (n + 1) / (nodes.length + 1)
          if (progressX >= nodeFrac) {
            val = nodes[n].type === 'div' ? val / nodes[n].value : val * nodes[n].value
          }
        }
        if (progressX >= 0.999) val = endMult
        s.displayMult = val
      } else if (s.status === 'flying' || s.status === 'cashed') {
        s.displayMult = s.carrier > 0 && s.round ? s.round.multipliers[s.carrier - 1] : 1
      } else if (s.status === 'idle') {
        s.displayMult = 1
      }
      lastNodeMult = s.displayMult
      multiplierRef.current.value = s.displayMult

      // ---- camera ----
      s.camX += (s.planeX - s.camX) * Math.min(1, 0.05)

      // ---- draw ----
      const sky = ctx.createLinearGradient(0, 0, 0, h)
      sky.addColorStop(0, '#0a1633')
      sky.addColorStop(0.6, '#123a63')
      sky.addColorStop(1, '#1c5081')
      ctx.fillStyle = sky
      ctx.fillRect(0, 0, w, h)

      // sun glow
      const glow = ctx.createRadialGradient(w * 0.5, waterY, 10, w * 0.5, waterY, w * 0.6)
      glow.addColorStop(0, 'rgba(255,214,140,0.18)')
      glow.addColorStop(1, 'rgba(255,214,140,0)')
      ctx.fillStyle = glow
      ctx.fillRect(0, 0, w, waterY)

      // water
      const water = ctx.createLinearGradient(0, waterY, 0, h)
      water.addColorStop(0, '#12406b')
      water.addColorStop(1, '#08203a')
      ctx.fillStyle = water
      ctx.fillRect(0, waterY, w, h - waterY)
      ctx.strokeStyle = 'rgba(150,200,255,0.25)'
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.moveTo(0, waterY)
      ctx.lineTo(w, waterY)
      ctx.stroke()

      const first = Math.max(0, Math.floor((s.camX - w * 0.3) / CARRIER_GAP) - 1)
      const last = s.round ? Math.min(s.round.carriers, first + Math.ceil(w / CARRIER_GAP) + 3) : first

      // carriers
      for (let i = first; i <= last; i += 1) {
        const sx = screenX(carrierWorldX(i))
        if (sx < -120 || sx > w + 120) continue
        drawCarrier(ctx, sx, waterY, i === s.carrier)
        if (i >= 1 && s.round) {
          const reached = i <= s.carrier
          ctx.save()
          ctx.textAlign = 'center'
          ctx.font = '700 16px "Segoe UI", system-ui, sans-serif'
          ctx.fillStyle = reached ? '#57e08a' : 'rgba(233,239,255,0.85)'
          ctx.shadowColor = 'rgba(0,0,0,0.6)'
          ctx.shadowBlur = 8
          ctx.fillText(formatMultiplier(s.round.multipliers[i - 1]), sx, waterY - 30)
          ctx.restore()
        }
      }

      // nodes for the current / upcoming hop
      if (s.round) {
        for (let seg = Math.max(0, s.carrier - 1); seg <= Math.min(s.round.carriers - 1, s.carrier + 1); seg += 1) {
          const nodes = s.round.nodes[seg] ?? []
          const ax = carrierWorldX(seg)
          const bx = carrierWorldX(seg + 1)
          for (let n = 0; n < nodes.length; n += 1) {
            const frac = (n + 1) / (nodes.length + 1)
            const wx = ax + (bx - ax) * frac
            const sx = screenX(wx)
            if (sx < -60 || sx > w + 60) continue
            const ny = cruiseY - 26 + (n % 2 === 0 ? -20 : 26)
            const passed = seg < s.carrier || (seg === s.carrier - 1 && !s.tweening)
            const collected = s.planeX >= wx && seg === s.carrier - 1
            const c = nodeColors(nodes[n].type)
            ctx.save()
            ctx.globalAlpha = passed && !collected ? 0.28 : 1
            ctx.fillStyle = c.fill
            ctx.strokeStyle = c.stroke
            ctx.lineWidth = 2
            ctx.beginPath()
            ctx.roundRect(sx - 26, ny - 15, 52, 30, 15)
            ctx.fill()
            ctx.stroke()
            ctx.fillStyle = c.text
            ctx.font = '700 15px "Segoe UI", system-ui, sans-serif'
            ctx.textAlign = 'center'
            ctx.textBaseline = 'middle'
            ctx.fillText(nodes[n].label, sx, ny)
            ctx.restore()
          }
        }
      }

      // splash ring
      if (s.splashing) {
        const p = Math.min(1, (now - s.splashStart) / SPLASH_MS)
        if (p > 0.45) {
          const sx = screenX(s.planeX)
          ctx.strokeStyle = `rgba(180,220,255,${1 - (p - 0.45) / 0.55})`
          ctx.lineWidth = 3
          ctx.beginPath()
          ctx.ellipse(sx, waterY + 6, 20 + (p - 0.45) * 90, 8 + (p - 0.45) * 26, 0, 0, Math.PI * 2)
          ctx.stroke()
        }
      }

      // plane
      if (s.status !== 'idle') {
        const alpha = s.splashing ? Math.max(0.15, 1 - Math.max(0, (now - s.splashStart) / SPLASH_MS - 0.55)) : 1
        drawPlane(ctx, screenX(s.planeX), s.planeY, 1.25, tilt, alpha)
      } else {
        drawPlane(ctx, screenX(carrierWorldX(0)), cruiseY, 1.25, -0.12, 1)
      }

      // counter
      const crashed = s.status === 'splashed'
      const cashed = s.status === 'cashed'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillStyle = crashed ? '#ff6a7a' : cashed ? '#7bf0a8' : '#ffffff'
      ctx.font = `800 ${Math.round(Math.min(w, h) * 0.13)}px "Segoe UI", system-ui, sans-serif`
      ctx.shadowColor = 'rgba(0,0,0,0.55)'
      ctx.shadowBlur = 16
      ctx.fillText(crashed ? 'SPLASH' : formatMultiplier(lastNodeMult), w / 2, h * 0.24)
      ctx.shadowBlur = 0
      if (cashed) {
        ctx.fillStyle = '#7bf0a8'
        ctx.font = '700 20px "Segoe UI", system-ui, sans-serif'
        ctx.fillText('LANDED', w / 2, h * 0.24 + Math.min(w, h) * 0.1)
      } else if (s.status === 'idle') {
        ctx.fillStyle = 'rgba(233,239,255,0.55)'
        ctx.font = '600 17px "Segoe UI", system-ui, sans-serif'
        ctx.fillText('Place a bet and launch', w / 2, h * 0.24 + Math.min(w, h) * 0.1)
      }

      raf = requestAnimationFrame(render)
    }
    raf = requestAnimationFrame(render)
    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
    }
  }, [multiplierRef])

  return (
    <div ref={wrapRef} className="jet-canvas-wrap">
      <canvas ref={canvasRef} className="jet-canvas" />
    </div>
  )
}
