import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { formatChickenMultiplier } from './chickenLogic'

export type ChickenStatus = 'idle' | 'playing' | 'dead' | 'cashed'

type ChickenSceneProps = {
  multipliers: number[]
  currentLane: number
  status: ChickenStatus
  deathLane: number | null
}

const LANE_W = 3
const ROAD_HALF_DEPTH = 11 // how far out cars travel / lanes are marked
const ROAD_VISUAL_DEPTH = 120 // asphalt width (z), extends past traffic to the screen edges
const SIDEWALK_X0 = -6
const HOP_MS = 380
const CRASH_CAR_MS = 430 // time for the car to reach the chicken after it lands
const CRASH_HIT_MS = 700 // knockback settle
const CAR_COLORS = [0xff5b6a, 0x4dd2ff, 0xffd23e, 0x8a7bff, 0x57e08a, 0xff9a3e, 0xff6ad5]
// Traffic flows left (-Z) to right (+Z). The protective wall sits just to the
// chicken's left, between it and the oncoming cars.
const WALL_LEFT_Z = -2.6

type CrashPhase = 'none' | 'hop' | 'car' | 'hit' | 'done'

function laneCenterX(lane: number): number {
  if (lane <= 0) return SIDEWALK_X0 / 2
  return (lane - 0.5) * LANE_W
}

function easeInOut(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2
}

function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3)
}

// ---------- model builders ----------

function buildChicken(): THREE.Group {
  const g = new THREE.Group()
  const body = new THREE.Mesh(
    new THREE.SphereGeometry(0.55, 24, 20),
    new THREE.MeshStandardMaterial({ color: 0xfaf6ec, roughness: 0.6 }),
  )
  body.scale.set(1, 0.92, 1.15)
  body.position.y = 0.62
  body.castShadow = true
  g.add(body)

  const head = new THREE.Mesh(
    new THREE.SphereGeometry(0.34, 20, 16),
    new THREE.MeshStandardMaterial({ color: 0xfffaf0, roughness: 0.55 }),
  )
  head.position.set(0.28, 1.12, 0)
  head.castShadow = true
  g.add(head)

  const combMat = new THREE.MeshStandardMaterial({ color: 0xe23b4a, roughness: 0.5 })
  for (let i = 0; i < 3; i += 1) {
    const c = new THREE.Mesh(new THREE.SphereGeometry(0.1 - i * 0.012, 10, 8), combMat)
    c.position.set(0.24 + i * 0.03, 1.42, 0)
    g.add(c)
  }
  const wattle = new THREE.Mesh(new THREE.SphereGeometry(0.08, 10, 8), combMat)
  wattle.position.set(0.5, 0.98, 0)
  g.add(wattle)

  const beak = new THREE.Mesh(
    new THREE.ConeGeometry(0.11, 0.28, 12),
    new THREE.MeshStandardMaterial({ color: 0xff9d2e, roughness: 0.4 }),
  )
  beak.rotation.z = -Math.PI / 2
  beak.position.set(0.62, 1.12, 0)
  g.add(beak)

  const eyeMat = new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.3 })
  for (const z of [-0.18, 0.18]) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.055, 8, 8), eyeMat)
    eye.position.set(0.42, 1.2, z)
    g.add(eye)
  }

  const wingMat = new THREE.MeshStandardMaterial({ color: 0xece4d2, roughness: 0.6 })
  for (const z of [-0.5, 0.5]) {
    const wing = new THREE.Mesh(new THREE.SphereGeometry(0.28, 14, 12), wingMat)
    wing.scale.set(0.7, 0.9, 0.35)
    wing.position.set(-0.02, 0.66, z)
    g.add(wing)
  }

  const tail = new THREE.Mesh(new THREE.ConeGeometry(0.26, 0.6, 4), wingMat)
  tail.rotation.z = Math.PI / 2.4
  tail.position.set(-0.55, 0.9, 0)
  g.add(tail)

  const legMat = new THREE.MeshStandardMaterial({ color: 0xef8c22, roughness: 0.5 })
  for (const z of [-0.18, 0.18]) {
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.4, 8), legMat)
    leg.position.set(0.05, 0.2, z)
    g.add(leg)
    const foot = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.05, 0.16), legMat)
    foot.position.set(0.1, 0.02, z)
    g.add(foot)
  }

  return g
}

function buildCar(color: number): THREE.Group {
  const g = new THREE.Group()
  const body = new THREE.Mesh(
    new THREE.BoxGeometry(1.4, 0.5, 2.3),
    new THREE.MeshStandardMaterial({ color, roughness: 0.35, metalness: 0.3 }),
  )
  body.position.y = 0.42
  body.castShadow = true
  g.add(body)

  const cabin = new THREE.Mesh(
    new THREE.BoxGeometry(1.15, 0.42, 1.1),
    new THREE.MeshStandardMaterial({ color: 0x11151f, roughness: 0.2, metalness: 0.4 }),
  )
  cabin.position.set(0, 0.82, -0.1)
  g.add(cabin)

  const wheelGeo = new THREE.CylinderGeometry(0.24, 0.24, 0.2, 14)
  const wheelMat = new THREE.MeshStandardMaterial({ color: 0x0c0c10, roughness: 0.8 })
  for (const x of [-0.72, 0.72]) {
    for (const z of [-0.72, 0.72]) {
      const w = new THREE.Mesh(wheelGeo, wheelMat)
      w.rotation.z = Math.PI / 2
      w.position.set(x, 0.24, z)
      g.add(w)
    }
  }

  const lightMat = new THREE.MeshStandardMaterial({ color: 0xfff4c2, emissive: 0xffe89a, emissiveIntensity: 1.4 })
  for (const x of [-0.42, 0.42]) {
    const l = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.16, 0.08), lightMat)
    l.position.set(x, 0.42, 1.18)
    g.add(l)
  }
  const tailMat = new THREE.MeshStandardMaterial({ color: 0xff2a2a, emissive: 0xff2a2a, emissiveIntensity: 0.8 })
  for (const x of [-0.42, 0.42]) {
    const l = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.14, 0.06), tailMat)
    l.position.set(x, 0.42, -1.18)
    g.add(l)
  }

  return g
}

// Protective gate that drops across the lane on the chicken's left after a safe
// crossing — perpendicular to traffic, so it actually blocks oncoming cars.
function buildWall(): THREE.Group {
  const g = new THREE.Group()
  const panel = new THREE.Mesh(
    new THREE.BoxGeometry(LANE_W - 0.12, 1.4, 0.34),
    new THREE.MeshStandardMaterial({ color: 0x323a52, roughness: 0.55, metalness: 0.35 }),
  )
  panel.position.y = 0.7
  panel.castShadow = true
  g.add(panel)
  const rim = new THREE.Mesh(
    new THREE.BoxGeometry(LANE_W - 0.02, 0.16, 0.46),
    new THREE.MeshStandardMaterial({ color: 0xffce54, emissive: 0xffb63a, emissiveIntensity: 0.65, roughness: 0.4 }),
  )
  rim.position.y = 1.44
  g.add(rim)
  return g
}

function makeTokenTexture(text: string, kind: 'future' | 'current' | 'passed'): THREE.CanvasTexture {
  const canvas = document.createElement('canvas')
  canvas.width = 320
  canvas.height = 160
  const ctx = canvas.getContext('2d')!
  const r = 30
  const w = canvas.width
  const h = canvas.height
  ctx.clearRect(0, 0, w, h)
  const bg =
    kind === 'current'
      ? { fill: '#ffce54', stroke: '#fff1c0', text: '#241703' }
      : kind === 'passed'
        ? { fill: '#1f7a45', stroke: '#57e08a', text: '#eafff2' }
        : { fill: 'rgba(14,20,34,0.92)', stroke: 'rgba(120,140,180,0.5)', text: '#e9efff' }
  ctx.beginPath()
  ctx.moveTo(r, 4)
  ctx.arcTo(w - 4, 4, w - 4, h - 4, r)
  ctx.arcTo(w - 4, h - 4, 4, h - 4, r)
  ctx.arcTo(4, h - 4, 4, 4, r)
  ctx.arcTo(4, 4, w - 4, 4, r)
  ctx.closePath()
  ctx.fillStyle = bg.fill
  ctx.fill()
  ctx.lineWidth = 6
  ctx.strokeStyle = bg.stroke
  ctx.stroke()
  ctx.fillStyle = bg.text
  ctx.font = '700 68px "Segoe UI", system-ui, sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(text, w / 2, h / 2 + 4)
  const tex = new THREE.CanvasTexture(canvas)
  tex.anisotropy = 4
  return tex
}

type LaneObjects = {
  tokens: { sprite: THREE.Sprite; value: number }[]
  walls: { group: THREE.Group; lane: number; drop: number }[]
  lines: THREE.Group | null
}

export default function ChickenScene({ multipliers, currentLane, status, deathLane }: ChickenSceneProps) {
  const mountRef = useRef<HTMLDivElement | null>(null)
  const engineRef = useRef<{
    renderer: THREE.WebGLRenderer
    scene: THREE.Scene
    camera: THREE.PerspectiveCamera
    chicken: THREE.Group
    cars: { group: THREE.Group; lane: number; z: number; speed: number; dir: number }[]
    crashCar: THREE.Group
    lane: LaneObjects
    animLane: number
    fromX: number
    toX: number
    hopStart: number
    hopping: boolean
    crashPhase: CrashPhase
    crashLane: number | null
    crashStart: number
    hitStart: number
    shake: number
    camX: number
    prevStatus: ChickenStatus
    multipliers: number[]
    currentLane: number
    status: ChickenStatus
    deathLane: number | null
    dispose: () => void
  } | null>(null)

  // ---- mount: renderer + persistent objects ----
  useEffect(() => {
    const mount = mountRef.current
    if (!mount) return

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false })
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio))
    renderer.shadowMap.enabled = true
    renderer.shadowMap.type = THREE.PCFShadowMap
    renderer.setSize(mount.clientWidth || 800, mount.clientHeight || 500)
    mount.appendChild(renderer.domElement)

    const scene = new THREE.Scene()
    scene.background = new THREE.Color(0x0a1020)
    scene.fog = new THREE.Fog(0x0a1020, 26, 60)

    const camera = new THREE.PerspectiveCamera(50, (mount.clientWidth || 800) / (mount.clientHeight || 500), 0.1, 200)

    scene.add(new THREE.HemisphereLight(0x9fb8ff, 0x1b2436, 0.75))
    const sun = new THREE.DirectionalLight(0xfff2d6, 1.15)
    sun.position.set(-8, 18, 10)
    sun.castShadow = true
    sun.shadow.mapSize.set(1024, 1024)
    sun.shadow.camera.near = 1
    sun.shadow.camera.far = 80
    sun.shadow.camera.left = -40
    sun.shadow.camera.right = 40
    sun.shadow.camera.top = 30
    sun.shadow.camera.bottom = -30
    scene.add(sun)

    const road = new THREE.Mesh(
      new THREE.PlaneGeometry(400, ROAD_VISUAL_DEPTH),
      new THREE.MeshStandardMaterial({ color: 0x2a2f3d, roughness: 0.95 }),
    )
    road.rotation.x = -Math.PI / 2
    road.position.set(180, 0, 0)
    road.receiveShadow = true
    scene.add(road)

    const sidewalk = new THREE.Mesh(
      new THREE.BoxGeometry(-SIDEWALK_X0 + 4, 0.4, ROAD_VISUAL_DEPTH),
      new THREE.MeshStandardMaterial({ color: 0x3f8f57, roughness: 0.9 }),
    )
    sidewalk.position.set(SIDEWALK_X0 / 2 - 2, 0.2, 0)
    sidewalk.receiveShadow = true
    scene.add(sidewalk)
    const curb = new THREE.Mesh(
      new THREE.BoxGeometry(0.3, 0.5, ROAD_VISUAL_DEPTH),
      new THREE.MeshStandardMaterial({ color: 0xbfc6cf, roughness: 0.8 }),
    )
    curb.position.set(0, 0.25, 0)
    scene.add(curb)

    const chicken = buildChicken()
    chicken.position.set(laneCenterX(0), 0.4, 0)
    scene.add(chicken)

    const crashCar = buildCar(0xd21f2f)
    crashCar.visible = false
    scene.add(crashCar)

    const engine = {
      renderer,
      scene,
      camera,
      chicken,
      cars: [] as { group: THREE.Group; lane: number; z: number; speed: number; dir: number }[],
      crashCar,
      lane: { tokens: [], walls: [], lines: null } as LaneObjects,
      animLane: 0,
      fromX: laneCenterX(0),
      toX: laneCenterX(0),
      hopStart: 0,
      hopping: false,
      crashPhase: 'none' as CrashPhase,
      crashLane: null as number | null,
      crashStart: 0,
      hitStart: 0,
      shake: 0,
      camX: laneCenterX(0),
      prevStatus: 'idle' as ChickenStatus,
      multipliers,
      currentLane,
      status,
      deathLane,
      dispose: () => {},
    }
    engineRef.current = engine

    const handleResize = () => {
      const w = mount.clientWidth || 800
      const h = mount.clientHeight || 500
      renderer.setSize(w, h)
      camera.aspect = w / h
      camera.updateProjectionMatrix()
    }
    const ro = new ResizeObserver(handleResize)
    ro.observe(mount)

    let raf = 0
    let last = performance.now()
    const clock = { t: 0 }

    const render = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000)
      last = now
      clock.t += dt
      const s = engineRef.current
      if (!s) return

      // ---- chicken hop (identical for safe crossings and the fatal one) ----
      if (s.hopping) {
        const p = Math.min(1, (now - s.hopStart) / HOP_MS)
        const e = easeInOut(p)
        s.chicken.position.x = s.fromX + (s.toX - s.fromX) * e
        s.chicken.position.y = 0.4 + Math.sin(p * Math.PI) * 1.1
        s.chicken.rotation.z = Math.sin(p * Math.PI) * 0.25
        if (p >= 1) {
          s.hopping = false
          s.chicken.position.y = 0.4
          s.chicken.rotation.z = 0
          // the fatal hop has landed — now send in the car
          if (s.crashPhase === 'hop') {
            s.crashPhase = 'car'
            s.crashStart = now
          }
        }
      } else if (s.crashPhase === 'none') {
        s.chicken.position.y = 0.4 + Math.sin(clock.t * 3) * 0.04
      }

      // ---- crash: car drives in, then knocks the chicken ----
      if (s.crashPhase === 'car') {
        const p = Math.min(1, (now - s.crashStart) / CRASH_CAR_MS)
        s.crashCar.visible = true
        s.crashCar.position.set(s.toX, 0, -ROAD_HALF_DEPTH - 3 + (ROAD_HALF_DEPTH + 3) * p)
        if (p >= 1) {
          s.crashPhase = 'hit'
          s.hitStart = now
          s.shake = 0.5
        }
      } else if (s.crashPhase === 'hit') {
        const k = Math.min(1, (now - s.hitStart) / CRASH_HIT_MS)
        s.chicken.position.x = s.toX + k * 1.9
        s.chicken.position.y = 0.4 + Math.sin(k * Math.PI) * 1.3
        s.chicken.rotation.z = k * Math.PI * 1.4
        s.chicken.rotation.x = k * Math.PI * 0.55
        s.crashCar.position.z = k * 3.2
        if (k >= 1) s.crashPhase = 'done'
      }

      // ---- protective walls drop behind the chicken on each safe lane ----
      const safeLanes =
        s.status === 'dead'
          ? (s.deathLane ?? 1) - 1
          : s.status === 'cashed'
            ? s.currentLane
            : Math.round(s.animLane)
      for (const wall of s.lane.walls) {
        const target = wall.lane <= safeLanes ? 1 : 0
        wall.drop += (target - wall.drop) * Math.min(1, dt * 6)
        wall.group.visible = wall.drop > 0.004
        wall.group.position.y = (1 - easeOutCubic(wall.drop)) * 7
      }

      // ---- token colors ----
      for (let i = 0; i < s.lane.tokens.length; i += 1) {
        const t = s.lane.tokens[i]
        const lane = i + 1
        const kind: 'future' | 'current' | 'passed' =
          lane === s.currentLane && s.currentLane > 0
            ? 'current'
            : lane < Math.round(s.animLane) || (s.status === 'cashed' && lane <= s.currentLane)
              ? 'passed'
              : 'future'
        const desired = `${kind}:${t.value}`
        if ((t.sprite.userData.kind as string) !== desired) {
          t.sprite.userData.kind = desired
          const oldTex = (t.sprite.material as THREE.SpriteMaterial).map
          ;(t.sprite.material as THREE.SpriteMaterial).map = makeTokenTexture(formatChickenMultiplier(t.value), kind)
          ;(t.sprite.material as THREE.SpriteMaterial).needsUpdate = true
          oldTex?.dispose()
        }
        t.sprite.position.y = 3.05 + (kind === 'current' ? 0.15 + Math.sin(clock.t * 4) * 0.12 : 0)
      }

      // ---- ambient cars (only in lanes ahead that are still open) ----
      for (const c of s.cars) {
        const standing = Math.round(s.animLane) === c.lane && !s.hopping
        const passed = c.lane < Math.round(s.animLane)
        const hidden = standing || passed || s.status === 'idle'
        c.group.visible = !hidden
        if (hidden) continue
        c.z += c.speed * dt
        if (c.z > ROAD_HALF_DEPTH + 3) c.z = -ROAD_HALF_DEPTH - 3 - Math.random() * 6
        c.group.position.z = c.z
      }

      if (s.shake > 0) s.shake = Math.max(0, s.shake - dt * 1.6)

      // ---- camera follow ----
      // Camera sits behind + above the chicken looking straight down the
      // crossing axis, so lanes recede upward and traffic reads left -> right.
      const chickenX = s.chicken.position.x
      s.camX += (chickenX - s.camX) * Math.min(1, dt * 3.5)
      const shake = s.shake > 0 ? s.shake : 0
      s.camera.position.set(
        s.camX - 6.5 + (Math.random() - 0.5) * shake,
        7.8 + (Math.random() - 0.5) * shake,
        0.4,
      )
      s.camera.lookAt(s.camX + 9, 0.5, 0)

      renderer.render(scene, camera)
      raf = requestAnimationFrame(render)
    }
    raf = requestAnimationFrame(render)

    engine.dispose = () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      renderer.dispose()
      scene.traverse((obj) => {
        const anyObj = obj as unknown as { geometry?: THREE.BufferGeometry; material?: THREE.Material | THREE.Material[] }
        anyObj.geometry?.dispose?.()
        if (Array.isArray(anyObj.material)) anyObj.material.forEach((m) => m.dispose())
        else anyObj.material?.dispose?.()
      })
      if (renderer.domElement.parentNode === mount) mount.removeChild(renderer.domElement)
    }

    return () => engine.dispose()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ---- rebuild lane objects when the table changes ----
  useEffect(() => {
    const s = engineRef.current
    if (!s) return

    for (const t of s.lane.tokens) {
      s.scene.remove(t.sprite)
      ;(t.sprite.material as THREE.SpriteMaterial).map?.dispose()
      ;(t.sprite.material as THREE.SpriteMaterial).dispose()
    }
    for (const w of s.lane.walls) s.scene.remove(w.group)
    for (const c of s.cars) s.scene.remove(c.group)
    if (s.lane.lines) s.scene.remove(s.lane.lines)
    s.lane.tokens = []
    s.lane.walls = []
    s.cars = []

    const count = multipliers.length

    // dashed lane divider lines painted on the road
    const lines = new THREE.Group()
    const dashMat = new THREE.MeshStandardMaterial({
      color: 0xf4f6fb,
      emissive: 0x8a93a8,
      emissiveIntensity: 0.25,
      roughness: 0.6,
    })
    const dashGeo = new THREE.BoxGeometry(0.14, 0.02, 1.3)
    for (let b = 1; b <= count; b += 1) {
      const x = b * LANE_W
      for (let z = -24; z < 24; z += 2.4) {
        const dash = new THREE.Mesh(dashGeo, dashMat)
        dash.position.set(x, 0.02, z)
        lines.add(dash)
      }
    }
    s.scene.add(lines)
    s.lane.lines = lines

    for (let lane = 1; lane <= count; lane += 1) {
      const cx = laneCenterX(lane)
      const tex = makeTokenTexture(formatChickenMultiplier(multipliers[lane - 1]), 'future')
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: true }))
      sprite.scale.set(1.7, 0.85, 1)
      sprite.position.set(cx, 3.05, 0)
      sprite.userData.kind = 'init'
      s.scene.add(sprite)
      s.lane.tokens.push({ sprite, value: multipliers[lane - 1] })

      const wall = buildWall()
      wall.position.set(cx, 7, WALL_LEFT_Z)
      wall.visible = false
      s.scene.add(wall)
      s.lane.walls.push({ group: wall, lane, drop: 0 })

      // all traffic flows the same way (left -> right, i.e. +Z)
      const car = buildCar(CAR_COLORS[lane % CAR_COLORS.length])
      const z = (Math.random() * 2 - 1) * ROAD_HALF_DEPTH
      car.position.set(cx, 0, z)
      s.scene.add(car)
      s.cars.push({ group: car, lane, z, speed: 5 + Math.random() * 5, dir: 1 })
    }
    s.multipliers = multipliers
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [multipliers])

  // ---- react to gameplay prop changes ----
  useEffect(() => {
    const s = engineRef.current
    if (!s) return
    const prev = s.status
    s.deathLane = deathLane
    s.currentLane = currentLane

    const resetChicken = () => {
      s.chicken.rotation.set(0, 0, 0)
      s.chicken.position.set(laneCenterX(0), 0.4, 0)
      s.animLane = 0
      s.fromX = laneCenterX(0)
      s.toX = laneCenterX(0)
      s.hopping = false
      s.crashPhase = 'none'
      s.crashLane = null
      s.shake = 0
      s.crashCar.visible = false
    }

    if (status === 'idle' && prev !== 'idle') resetChicken()
    if (status === 'playing' && prev !== 'playing') resetChicken()

    // safe advance — normal hop
    if (status === 'playing' && currentLane !== Math.round(s.animLane)) {
      s.fromX = s.chicken.position.x
      s.toX = laneCenterX(currentLane)
      s.animLane = currentLane
      s.hopStart = performance.now()
      s.hopping = true
    }

    // death — SAME normal hop, then the car comes (crashPhase advances after landing)
    if (status === 'dead' && prev !== 'dead') {
      const target = deathLane ?? currentLane + 1
      s.fromX = s.chicken.position.x
      s.toX = laneCenterX(target)
      s.animLane = target
      s.hopStart = performance.now()
      s.hopping = true
      s.crashPhase = 'hop'
      s.crashLane = target
      s.crashCar.visible = false
    }

    s.status = status
    s.prevStatus = prev
  }, [currentLane, status, deathLane])

  return <div ref={mountRef} className="chicken-scene" />
}
