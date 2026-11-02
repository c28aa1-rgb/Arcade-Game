import {
  buildPegs, getRowStep, getSlotLeft, spawnBall, stepBall,
  SIMULATION_STEP_S,
} from '../src/components/plinkoPhysics'

const MULTS = [24, 7.5, 3.8, 1.4, 0.8, 0.6, 0.35, 0.6, 0.8, 1.4, 3.8, 7.5, 24]
const ROWS = 12
const N = Number(process.argv[2] ?? 80000)
const bias = Number(process.argv[3] ?? 0)

const rowStep = getRowStep(ROWS)
const pegs = buildPegs(ROWS, rowStep)
const slotLeft = getSlotLeft(MULTS.length)

const counts = new Array(MULTS.length).fill(0)
let rtpSum = 0, stepSum = 0, maxSteps = 0, stuck = 0, upBounced = 0, upTotal = 0

for (let i = 0; i < N; i += 1) {
  let ball = spawnBall(rowStep, bias)
  let landed = 6, steps = 0, ups = 0, prevY = ball.y
  for (let s = 0; s < 8000; s += 1) {
    steps++
    const r = stepBall(ball, SIMULATION_STEP_S, pegs, slotLeft, MULTS.length)
    if (r.next && r.next.vy < -5) ups++
    prevY = r.next ? r.next.y : prevY
    if (!r.next) { landed = r.landedSlotIndex ?? 6; break }
    ball = r.next
  }
  if (steps >= 8000) stuck++
  if (ups > 0) { upBounced++; upTotal += ups }
  stepSum += steps; if (steps>maxSteps) maxSteps=steps
  counts[landed]++; rtpSum += MULTS[landed]
}

const binom=(n:number,k:number)=>{let c=1;for(let i=0;i<k;i++)c=(c*(n-i))/(i+1);return c}
const total=2**ROWS
console.log(`N=${N} bias=${bias}`)
counts.forEach((c,i)=>console.log(`${String(i).padStart(2)} ${String(MULTS[i]).padStart(5)}  sim ${((c/N)*100).toFixed(3).padStart(7)}%  fair ${((binom(ROWS,i)/total)*100).toFixed(3).padStart(7)}%${c===0?'  <-- NEVER':''}`))
console.log(`24x: ${(((counts[0]+counts[12])/N)*100).toFixed(3)}%  7.5x: ${(((counts[1]+counts[11])/N)*100).toFixed(3)}%  RTP: ${((rtpSum/N)*100).toFixed(1)}%`)
console.log(`drops that bounced UP at least once: ${((upBounced/N)*100).toFixed(1)}%  (avg ${(upTotal/Math.max(1,upBounced)).toFixed(1)} up-frames each)`)
console.log(`avg ${(stepSum/N/480).toFixed(2)}s  max ${(maxSteps/480).toFixed(2)}s  stuck: ${stuck}`)
