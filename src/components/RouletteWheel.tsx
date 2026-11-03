import type { MutableRefObject } from 'react'

// American roulette wheel, drawn as two SVG layers:
//  - a still bowl (wooden rim, polished ball track, brass deflector diamonds)
//  - a rotor that spins (numbered pockets, gold frets, brass turret)
// The ball and the result badge are separate elements on top. Spinning is
// driven imperatively (Web Animations) through the refs, never by re-render.
//
// Geometry is in a 400-unit viewBox. The ball track sits at 0.88 of the
// radius and the pocket floors at 0.58, matching ROULETTE_*_FRAC in App.

export type RoulettePocketValue = number | '00'

type RouletteWheelProps = {
  order: RoulettePocketValue[]
  redNumbers: Set<string>
  winning: RoulettePocketValue | null
  spinning: boolean
  rotorRef: MutableRefObject<HTMLDivElement | null>
  ballRef: MutableRefObject<HTMLDivElement | null>
  rotorTransform: string
  ballTransform: string
}

const C = 200
const R_NUM_OUT = 156
const R_NUM_IN = 129
const R_POCKET_IN = 104
const R_TRACK_OUT = 188

function polar(r: number, deg: number) {
  const a = (deg * Math.PI) / 180
  return { x: C + r * Math.sin(a), y: C - r * Math.cos(a) }
}

// annular wedge between two radii and two clockwise-from-top angles
function wedge(rOut: number, rIn: number, a0: number, a1: number) {
  const p0 = polar(rOut, a0)
  const p1 = polar(rOut, a1)
  const p2 = polar(rIn, a1)
  const p3 = polar(rIn, a0)
  return `M${p0.x} ${p0.y}A${rOut} ${rOut} 0 0 1 ${p1.x} ${p1.y}L${p2.x} ${p2.y}A${rIn} ${rIn} 0 0 0 ${p3.x} ${p3.y}Z`
}

function pocketColor(value: RoulettePocketValue, redNumbers: Set<string>) {
  if (value === 0 || value === '00') return 'green'
  return redNumbers.has(String(value)) ? 'red' : 'black'
}

const FILL = {
  red: { face: '#c2223a', floor: '#7d1224' },
  black: { face: '#16161a', floor: '#0a0a0c' },
  green: { face: '#1c8a4e', floor: '#0e5530' },
}

export default function RouletteWheel({
  order,
  redNumbers,
  winning,
  spinning,
  rotorRef,
  ballRef,
  rotorTransform,
  ballTransform,
}: RouletteWheelProps) {
  const slice = 360 / order.length

  return (
    <div className="roulette-wheel" aria-label="Roulette wheel">
      {/* ---- still bowl ---- */}
      <svg className="roulette-wheel__bowl" viewBox="0 0 400 400" aria-hidden="true">
        <defs>
          <radialGradient id="rw-wood" cx="0.5" cy="0.45" r="0.55">
            <stop offset="0.8" stopColor="#6b3a1c" />
            <stop offset="1" stopColor="#2c1509" />
          </radialGradient>
          <radialGradient id="rw-track" cx="0.5" cy="0.42" r="0.5">
            <stop offset="0.78" stopColor="#3a1f0f" />
            <stop offset="0.9" stopColor="#7a4524" />
            <stop offset="1" stopColor="#4a2612" />
          </radialGradient>
          <linearGradient id="rw-brass" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#fff0b8" />
            <stop offset="0.5" stopColor="#d2a94e" />
            <stop offset="1" stopColor="#7d5a18" />
          </linearGradient>
        </defs>
        <circle cx={C} cy={C} r="199" fill="url(#rw-wood)" />
        <circle cx={C} cy={C} r="196" fill="none" stroke="url(#rw-brass)" strokeWidth="3" />
        <circle cx={C} cy={C} r={R_TRACK_OUT} fill="url(#rw-track)" stroke="rgba(0,0,0,0.5)" strokeWidth="2" />
        {/* polished sheen along the ball track */}
        <circle cx={C} cy={C} r="176" fill="none" stroke="rgba(255,220,170,0.12)" strokeWidth="10" />
        {Array.from({ length: 8 }, (_, i) => {
          const p = polar(166, i * 45 + 22.5)
          return (
            <path
              key={i}
              d={`M${p.x} ${p.y - 6}l4 6-4 6-4-6z`}
              transform={`rotate(${i * 45 + 22.5} ${p.x} ${p.y})`}
              fill="url(#rw-brass)"
              stroke="rgba(60,40,10,0.7)"
              strokeWidth="0.8"
            />
          )
        })}
      </svg>

      {/* ---- rotor ---- */}
      <div className="roulette-wheel__rotor" ref={rotorRef} style={{ transform: rotorTransform }}>
        <svg viewBox="0 0 400 400" aria-hidden="true">
          <defs>
            <radialGradient id="rw-cone" cx="0.5" cy="0.4" r="0.6">
              <stop offset="0" stopColor="#8a5128" />
              <stop offset="0.7" stopColor="#5a2f15" />
              <stop offset="1" stopColor="#3a1d0b" />
            </radialGradient>
            <radialGradient id="rw-turret" cx="0.4" cy="0.35" r="0.7">
              <stop offset="0" stopColor="#fff0b8" />
              <stop offset="0.55" stopColor="#d2a94e" />
              <stop offset="1" stopColor="#6e4c12" />
            </radialGradient>
          </defs>
          <circle cx={C} cy={C} r={R_NUM_OUT + 2} fill="#0b0b0d" />
          {order.map((value, i) => {
            const color = pocketColor(value, redNumbers)
            const a0 = i * slice
            const a1 = (i + 1) * slice
            const mid = a0 + slice / 2
            const isWin = !spinning && winning === value
            return (
              <g key={String(value)}>
                <path d={wedge(R_NUM_OUT, R_NUM_IN, a0, a1)} fill={FILL[color].face} />
                <path d={wedge(R_NUM_IN, R_POCKET_IN, a0, a1)} fill={FILL[color].floor} />
                {isWin ? (
                  <path className="roulette-wheel__win" d={wedge(R_NUM_OUT, R_POCKET_IN, a0, a1)} />
                ) : null}
                <text
                  x={C}
                  y={C - 142.5}
                  transform={`rotate(${mid} ${C} ${C})`}
                  className="roulette-wheel__label"
                >
                  {value}
                </text>
              </g>
            )
          })}
          {/* gold frets between pockets */}
          {order.map((_, i) => {
            const a = polar(R_NUM_OUT, i * slice)
            const b = polar(R_POCKET_IN, i * slice)
            return <line key={i} x1={a.x} y1={a.y} x2={b.x} y2={b.y} className="roulette-wheel__fret" />
          })}
          <circle cx={C} cy={C} r={R_NUM_OUT} fill="none" className="roulette-wheel__ring" />
          <circle cx={C} cy={C} r={R_NUM_IN} fill="none" className="roulette-wheel__ring roulette-wheel__ring--thin" />
          {/* cone + brass turret */}
          <circle cx={C} cy={C} r={R_POCKET_IN} fill="url(#rw-cone)" className="roulette-wheel__ring" />
          {Array.from({ length: 8 }, (_, i) => {
            const a = polar(96, i * 45)
            const b = polar(28, i * 45)
            return <line key={i} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="rgba(210,169,78,0.35)" strokeWidth="2" />
          })}
          {[0, 90, 180, 270].map((deg) => {
            const tip = polar(46, deg)
            return (
              <g key={deg}>
                <line x1={C} y1={C} x2={tip.x} y2={tip.y} stroke="url(#rw-turret)" strokeWidth="7" strokeLinecap="round" />
                <circle cx={tip.x} cy={tip.y} r="6.5" fill="url(#rw-turret)" stroke="rgba(60,40,10,0.7)" strokeWidth="1" />
              </g>
            )
          })}
          <circle cx={C} cy={C} r="20" fill="url(#rw-turret)" stroke="rgba(60,40,10,0.8)" strokeWidth="1.5" />
          <circle cx={C - 5} cy={C - 6} r="6" fill="rgba(255,255,255,0.35)" />
        </svg>
      </div>

      <div className="roulette-wheel__ball" ref={ballRef} style={{ transform: ballTransform }} />

      {winning !== null && !spinning ? (
        <div className={`roulette-wheel__result roulette-wheel__result--${pocketColor(winning, redNumbers)}`} key={String(winning)} aria-hidden="true">
          {winning}
        </div>
      ) : null}
    </div>
  )
}
