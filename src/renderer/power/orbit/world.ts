// 관계도 장면 상태 — 카메라·궤도·점·효과 목록을 만들고, 노드·위성·혜성의 자리를 구한다(시안 orbit3 의 init · place · cometPath).
// DOM·캔버스 없음. 한 프레임 진행은 step.ts, 그리기는 scene.ts(잔상 층) · overlay.ts(또렷한 층)가 이 상태를 읽기만 한다.
// 시간은 모두 장면 시계 w.t(초).
import type { ScreenEvent } from '../events'
import { CAM_D, CENTER_DROP, TILT, near, projectTo, type Cam, type Proj } from './camera'
import { CORE_Y, FLOOR_Y, layoutOrbits, orbitRA, worldTo, type Orbit } from './layout'
import { FALLBACK_AGENT, FALLBACK_FONTS } from './palette'

export type Who = { id: string; name: string; color: string }
export type Vec3 = [number, number, number]
/** 화면 위 노드 자리 — s 카드 배율 · z 앞쪽 정도(0~1) · o 밝기 */
export type NodePos = { x: number; y: number; s: number; z: number; o: number }
export type Pt = { x: number; y: number }

export type Comet = { from: string; to: string; t0: number; T: number; color: string; small: boolean; trail: Pt[]; text: string | null }
export type Shard = { id: string; t0: number; T: number; color: string }
export type Spark = { x: number; y: number; z: number; vx: number; vy: number; vz: number; t0: number; color: string }
export type Ripple = { id: string; t0: number; color: string }
export type Float = { id: string; t0: number; color: string; text: string; dx: number }
export type Bubble = { id: string; t0: number; from: string; text: string }
export type Leaf = { id: string; ang: number; t0: number; label: string; color: string }
export type Sat = { name: string; parent: string; a: number; w: number }
export type Moon = { w: number; ph: number; r: number; tilt: number }
export type Star = { x: number; y: number; s: number; tw: number }
export type Gyro = { ax: number; az: number; sp: number; r: number }
/** 동기화가 장면에 얹는 값 — 차분 모드면 모두 0 */
export type Boost = { b: number; orbit: number; yaw: number; tilt: number; zoom: number; shake: number; galaxy: number; fade: number; bloom: number; streak: boolean }

export type World = {
  W: number
  H: number
  RA: number
  cx0: number
  cy0: number
  cam: Cam
  /** 장면 시계(초) */
  t: number
  last: number | null
  /** 궤도 시계 — 동기화 때 빨라진다 */
  tt: number
  galSpin: number
  calm: boolean
  rand: () => number
  fonts: { mono: string; ui: string }
  core: Who
  who: Map<string, Who>
  orbits: Orbit[]
  orbitById: Map<string, Orbit>
  wpos: Map<string, Vec3>
  pos: Map<string, NodePos>
  sats: Sat[]
  moons: Map<string, Moon[]>
  stars: Star[]
  gal: { r: Float32Array; a: Float32Array; y: Float32Array; om: Float32Array; c: Uint8Array }
  disk: { r: Float32Array; a: Float32Array; y: Float32Array; sp: Float32Array }
  gyros: Gyro[]
  comets: Comet[]
  shards: Shard[]
  sparks: Spark[]
  ripples: Ripple[]
  floats: Float[]
  bubbles: Bubble[]
  leaves: Leaf[]
  queue: { at: number; ev: ScreenEvent }[]
  wave: number[]
  act: number
  energy: number
  flare: number
  sync: { t0: number; next: number }
  syncing: boolean
  toast: { t0: number; text: string } | null
  boost: Boost
  /** 카드를 번쩍일 에이전트 — OrbitMap 이 프레임마다 비운다 */
  hits: string[]
  nextAmb: number
}

/** 궤도 한 바퀴 70초 */
const OMEGA = (Math.PI * 2) / 70
/** 전체 동기화 — sec 동안, every 초마다(첫 번은 first 초 뒤) */
export const SYNC = { sec: 2.0, every: [17, 24] as [number, number], first: [8, 11] as [number, number] }
const FAKE_SATS = ['탐색 1', '탐색 2', '점검', '조사']
const MAX_SATS = 8
/** 점 개수 상한(시안 값) */
export const COUNTS = { galaxy: 1300, disc: 240, stars: 90 } as const
const GYROS: Gyro[] = [
  { ax: 0.1, az: 0, sp: 0.9, r: 92 },
  { ax: 1.1, az: 0.35, sp: -1.35, r: 106 },
  { ax: -0.95, az: 1.25, sp: 1.7, r: 120 },
]
/** 효과 수명(초) */
export const LIFE = { ripple: 1, float: 1.5, bubble: 2.9, leaf: 2.6, spark: 0.9, toast: 2.6, flare: 1.1 } as const
const WAVE_N = 96
/** 서브에이전트 위성 궤도(RA 배수) · 높이 */
export const SAT_R = 0.56
export const SAT_Y = 8

export const trunc = (s: string, n: number): string => (s.length > n ? s.slice(0, n - 1) + '…' : s)
/** 경로의 마지막 조각 — 명령처럼 / 가 없으면 그대로 */
export const baseName = (p: string): string => p.split(/[\\/]/).pop() ?? p
/** 카드 상태 줄 '도구 · 파일' */
export const toolLine = (tool: string, target: string): string => (target ? `${tool} · ${baseName(target)}` : tool)

/** 서브에이전트 수 → 위성 이름. 0 이면 지어낸 넷(시안) */
export function satelliteNames(n: number): string[] {
  if (n <= 0) return [...FAKE_SATS]
  return Array.from({ length: Math.min(n, MAX_SATS) }, (_, i) => `서브 ${i + 1}`)
}

/** 동기화가 아무것도 얹지 않을 때 */
export const NO_BOOST: Boost = { b: 0, orbit: 0, yaw: 0, tilt: 0, zoom: 0, shake: 0, galaxy: 0, fade: 0, bloom: 0, streak: false }

const P: Proj = { x: 0, y: 0, f: 0, d: 0 }
const V: Vec3 = [0, 0, 0]

export function createWorld(o: {
  agents: Who[]
  W: number
  H: number
  calm: boolean
  rand?: () => number
  satellites?: string[]
  fonts?: { mono: string; ui: string }
}): World {
  const rand = o.rand ?? Math.random
  const R = (a: number, b: number) => a + rand() * (b - a)
  const { core, orbits } = layoutOrbits(o.agents.map(a => a.id))
  const who = new Map(o.agents.map(a => [a.id, a]))
  const w: World = {
    W: 0,
    H: 0,
    RA: 0,
    cx0: 0,
    cy0: 0,
    cam: { yaw: 0.2, e: TILT.base, D: CAM_D, zoom: 1, cx: 0, cy: 0 },
    t: 0,
    last: null,
    tt: 0,
    galSpin: 0,
    calm: o.calm,
    rand,
    fonts: o.fonts ?? FALLBACK_FONTS,
    core: who.get(core) ?? { id: core, name: '', color: FALLBACK_AGENT },
    who,
    orbits,
    orbitById: new Map(orbits.map(x => [x.id, x])),
    wpos: new Map(o.agents.map(a => [a.id, [0, CORE_Y, 0] as Vec3])),
    pos: new Map(o.agents.map(a => [a.id, { x: 0, y: 0, s: 1, z: 0.5, o: 1 }])),
    sats: [],
    moons: new Map(),
    stars: [],
    gal: { r: new Float32Array(0), a: new Float32Array(0), y: new Float32Array(0), om: new Float32Array(0), c: new Uint8Array(0) },
    disk: makeDisk(rand),
    gyros: GYROS,
    comets: [],
    shards: [],
    sparks: [],
    ripples: [],
    floats: [],
    bubbles: [],
    leaves: [],
    queue: [],
    wave: new Array<number>(WAVE_N).fill(0.1),
    act: 0.3,
    energy: 0.62,
    flare: -1e9,
    sync: { t0: -1e9, next: R(...SYNC.first) },
    syncing: false,
    toast: null,
    boost: NO_BOOST,
    hits: [],
    nextAmb: 0,
  }
  const moon = (r0: number, r1: number): Moon => ({ w: R(1.6, 2.6) * (rand() < 0.5 ? -1 : 1), ph: R(0, Math.PI * 2), r: R(r0, r1), tilt: R(-0.6, 0.6) })
  // 혼자면 핵 둘레를 달이 돈다(원반·자이로 밖으로)
  if (orbits.length === 0) w.moons.set(w.core.id, [moon(130, 150), moon(130, 150)])
  for (const x of orbits) w.moons.set(x.id, Array.from({ length: rand() < 0.5 ? 1 : 2 }, () => moon(54, 68)))
  setSatellites(w, o.satellites ?? FAKE_SATS)
  resizeWorld(w, o.W, o.H)
  return w
}

/** 칸 크기가 바뀌면 — 궤도 반지름·가운데·별·은하를 다시 */
export function resizeWorld(w: World, W: number, H: number): void {
  if (W === w.W && H === w.H) return
  const R = (a: number, b: number) => a + w.rand() * (b - a)
  w.W = W
  w.H = H
  w.RA = orbitRA(W, H)
  w.cx0 = W / 2
  w.cy0 = H / 2 + CENTER_DROP
  w.cam.cx = w.cx0
  w.cam.cy = w.cy0
  w.stars = Array.from({ length: COUNTS.stars }, () => ({ x: R(0, W), y: R(0, H), s: R(0.5, 1.3), tw: R(0, Math.PI * 2) }))
  w.gal = makeGalaxy(w.rand, w.RA)
  place(w)
}

/** 위성 다시 — 궤도 에이전트에게 돌아가며 붙고, 아무도 안 돌면 핵에 */
export function setSatellites(w: World, names: string[]): void {
  const list = names.slice(0, MAX_SATS)
  if (list.length === w.sats.length && list.every((n, i) => w.sats[i].name === n)) return
  w.sats = list.map((name, i) => ({
    name,
    parent: w.orbits.length ? w.orbits[i % w.orbits.length].id : w.core.id,
    a: (i * Math.PI * 2) / list.length + 0.9,
    w: 0.22 + w.rand() * 0.12,
  }))
}

function makeGalaxy(rand: () => number, RA: number): World['gal'] {
  const n = COUNTS.galaxy
  const g = { r: new Float32Array(n), a: new Float32Array(n), y: new Float32Array(n), om: new Float32Array(n), c: new Uint8Array(n) }
  for (let i = 0; i < n; i++) {
    const arm = i % 3
    const u = Math.pow(rand(), 0.8)
    const r = 46 + u * RA * 2.1
    g.r[i] = r
    g.a[i] = arm * 2.094 + r * 0.0125 + (rand() * 0.68 - 0.34)
    g.y[i] = FLOOR_Y * 0.3 + (rand() * 32 - 16) * (1 - u)
    g.om[i] = 0.11 * Math.pow(RA / (r + 40), 0.65)
    g.c[i] = u < 0.25 ? 0 : u < 0.7 ? 1 : rand() < 0.6 ? 2 : 3
  }
  return g
}

function makeDisk(rand: () => number): World['disk'] {
  const n = COUNTS.disc
  const d = { r: new Float32Array(n), a: new Float32Array(n), y: new Float32Array(n), sp: new Float32Array(n) }
  for (let i = 0; i < n; i++) {
    const r = 34 + rand() * 70
    d.r[i] = r
    d.a[i] = rand() * Math.PI * 2
    d.y[i] = rand() * 6 - 3
    d.sp[i] = 2.6 * Math.pow(60 / r, 1.2)
  }
  return d
}

/** 궤도 시계가 지금까지 돈 각 */
export const orbitTurn = (w: World): number => w.tt * OMEGA
export const colorOf = (w: World, id: string): string => w.who.get(id)?.color ?? w.core.color

/** 노드 자리 — 핵은 가운데, 궤도 에이전트는 제 궤도 위(시안 place) */
export function place(w: World): void {
  const c = w.pos.get(w.core.id)
  if (c) {
    projectTo(P, w.cam, 0, CORE_Y, 0)
    c.x = P.x
    c.y = P.y
    c.s = 1.1 * P.f
    c.z = 0.5
    c.o = 1
  }
  const turn = orbitTurn(w)
  for (const o of w.orbits) {
    const wp = worldTo(w.wpos.get(o.id)!, o, w.RA, turn)
    projectTo(P, w.cam, wp[0], wp[1], wp[2])
    const z = near(P, w.RA)
    const p = w.pos.get(o.id)!
    p.x = P.x
    p.y = P.y
    p.s = (0.76 + z * 0.3) * P.f
    p.z = z
    p.o = 0.48 + z * 0.52
  }
}

/** 위성 하나의 화면 자리 — 핵 둘레 RA·0.56 를 돈다 */
export function satPoint(w: World, s: Sat, out: Proj): Proj {
  const a = s.a + w.tt * s.w * 2.2
  return projectTo(out, w.cam, Math.cos(a) * w.RA * SAT_R, SAT_Y, Math.sin(a) * w.RA * SAT_R)
}

/** 혜성이 e(0~1) 만큼 간 화면 자리 — 두 노드 사이를 위로 솟는 3D 호(시안 cometPath) */
export function cometPoint(w: World, from: string, to: string, e: number, out: Proj): Proj {
  const a = w.wpos.get(from)!
  const b = w.wpos.get(to)!
  const dist = Math.hypot(b[0] - a[0], b[2] - a[2])
  return projectTo(out, w.cam, a[0] + (b[0] - a[0]) * e, a[1] + (b[1] - a[1]) * e + Math.sin(Math.PI * e) * (46 + dist * 0.32), a[2] + (b[2] - a[2]) * e)
}

/** 궤도 위 점(지나온 길 그리기용) — V 를 돌려쓴다 */
export function orbitPoint(w: World, o: Orbit, turn: number): Vec3 {
  return worldTo(V, o, w.RA, turn)
}
