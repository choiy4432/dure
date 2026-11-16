// 관계도 장면 상태 — 카메라·궤도·점·효과 목록을 만들고, 노드·위성·혜성의 자리를 구한다(시안 orbit3 의 init · place · cometPath).
// DOM·캔버스 없음. 한 프레임 진행은 step.ts, 그리기는 scene.ts(잔상 층) · overlay.ts(또렷한 층)가 이 상태를 읽기만 한다.
// 시간은 모두 장면 시계 w.t(초).
import type { AgentState, ScreenEvent } from '../events'
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
export type Bubble = { id: string; t0: number; from: string; text: string }
export type Leaf = { id: string; ang: number; t0: number; label: string; color: string }
export type Sat = { name: string; parent: string; a: number; w: number }
/** 지금 도는 진짜 서브에이전트 — 맡긴 에이전트와 이름 */
export type SubLabel = { agentId: string; label: string }
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
  /** 에이전트의 진짜 상태(스토어) — 계기판의 일하는 중·기다림 */
  states: Record<string, AgentState>
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
  bubbles: Bubble[]
  leaves: Leaf[]
  queue: { at: number; ev: ScreenEvent }[]
  wave: number[]
  /** 활동(파형) — 진짜 도구·넘김에 오르고 쉬면 바닥(ACT_FLOOR)으로 */
  act: number
  /** 핵 밝기 — 진짜 도구 사용마다 오르고 쉬면 낮은 바탕(ENERGY.rest)으로 */
  energy: number
  flare: number
  /** 마지막 동기화 시작 시각 — 진짜 차례 끝(done)에서만, SYNC.gap 초에 한 번까지 */
  sync: { t0: number }
  syncing: boolean
  toast: { t0: number; text: string } | null
  boost: Boost
  /** 카드를 번쩍일 에이전트 — OrbitMap 이 프레임마다 비운다 */
  hits: string[]
}

/** 궤도 한 바퀴 70초 */
const OMEGA = (Math.PI * 2) / 70
/** 전체 동기화 — sec 동안. 시간으로는 터지지 않고 진짜 차례 끝(done)에서만, 연달아 오면 gap 초에 한 번까지 */
export const SYNC = { sec: 2.0, gap: 6 }
/** 핵 밝기 — 쉴 때 바탕 · 도구 한 번에 오르는 양 · 바탕으로 돌아가는 빠르기(초당) */
export const ENERGY = { rest: 0.15, tool: 0.08, decay: 0.25 } as const
/** 활동 파형의 바닥 — 일이 없으면 거의 평평하다 */
export const ACT_FLOOR = 0.05
const MAX_SATS = 8
/** 점 개수 상한(시안 값) */
export const COUNTS = { galaxy: 1300, disc: 240, stars: 90 } as const
const GYROS: Gyro[] = [
  { ax: 0.1, az: 0, sp: 0.9, r: 92 },
  { ax: 1.1, az: 0.35, sp: -1.35, r: 106 },
  { ax: -0.95, az: 1.25, sp: 1.7, r: 120 },
]
/** 효과 수명(초) */
export const LIFE = { ripple: 1, bubble: 2.9, leaf: 2.6, spark: 0.9, toast: 2.6, flare: 1.1 } as const
const WAVE_N = 96
/** 서브에이전트 위성 궤도(RA 배수) · 높이 */
/** 궤도 노드 카드의 가장 어두운 밝기(먼 쪽) — 카드 글 대비 4.5:1 을 지키는 바닥(place) */
const NODE_DIM = 0.8
export const SAT_R = 0.56
export const SAT_Y = 8

export const trunc = (s: string, n: number): string => (s.length > n ? s.slice(0, n - 1) + '…' : s)
/** 경로의 마지막 조각 — 명령처럼 / 가 없으면 그대로 */
export const baseName = (p: string): string => p.split(/[\\/]/).pop() ?? p
/** 카드 상태 줄 '도구 · 파일' */
export const toolLine = (tool: string, target: string): string => (target ? `${tool} · ${baseName(target)}` : tool)

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
  satellites?: SubLabel[]
  states?: Record<string, AgentState>
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
    states: o.states ?? {},
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
    bubbles: [],
    leaves: [],
    queue: [],
    wave: new Array<number>(WAVE_N).fill(ACT_FLOOR),
    act: ACT_FLOOR,
    energy: ENERGY.rest,
    flare: -1e9,
    sync: { t0: -1e9 },
    syncing: false,
    toast: null,
    boost: NO_BOOST,
    hits: [],
  }
  const moon = (r0: number, r1: number): Moon => ({ w: R(1.6, 2.6) * (rand() < 0.5 ? -1 : 1), ph: R(0, Math.PI * 2), r: R(r0, r1), tilt: R(-0.6, 0.6) })
  // 혼자면 핵 둘레를 달이 돈다(원반·자이로 밖으로)
  if (orbits.length === 0) w.moons.set(w.core.id, [moon(130, 150), moon(130, 150)])
  for (const x of orbits) w.moons.set(x.id, Array.from({ length: rand() < 0.5 ? 1 : 2 }, () => moon(54, 68)))
  setSatellites(w, o.satellites ?? [])
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

/** 위성 다시 — 진짜로 도는 서브에이전트만(없으면 위성도 없다). 부모는 맡긴 에이전트(모르는 id 면 핵) */
export function setSatellites(w: World, subs: SubLabel[]): void {
  const list = subs.slice(0, MAX_SATS).map(s => ({ name: s.label, parent: w.who.has(s.agentId) ? s.agentId : w.core.id }))
  if (list.length === w.sats.length && list.every((s, i) => w.sats[i].name === s.name && w.sats[i].parent === s.parent)) return
  w.sats = list.map((s, i) => ({
    ...s,
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

/** 에이전트 상태 다시 — 스토어의 진짜 상태(바뀔 때마다) */
export function setStates(w: World, states: Record<string, AgentState>): void {
  w.states = states
}

/** 계기판 값 — 일하는 중 · 기다리는 에이전트 수(이 방 에이전트만) */
export function stateCounts(w: World): { working: number; waiting: number; total: number } {
  let working = 0
  let waiting = 0
  for (const id of w.who.keys()) {
    const s = w.states[id]
    if (s === 'working') working++
    else if (s === 'awaiting') waiting++
  }
  return { working, waiting, total: w.who.size }
}

/** 궤도 시계가 지금까지 돈 각 */
export const orbitTurn = (w: World): number => w.tt * OMEGA
export const colorOf = (w: World, id: string): string => w.who.get(id)?.color ?? w.core.color
/** 지금 오가는 넘김 — 날아가는 진짜 넘김(글을 실은 혜성)만. 넘김을 따라가는 작은 혜성·동기화 폭죽(장식)과 도구 조각은 세지 않는다 */
export function inFlight(w: World): number {
  let n = 0
  for (const c of w.comets) if (c.text !== null) n++
  return n
}

/** 노드 자리 — 핵은 가운데, 궤도 에이전트는 제 궤도 위(시안 place) */
export function place(w: World): void {
  if (!w.W || !w.H) return // 칸 크기 0 — 반지름이 0 이라 나눗셈이 NaN 이 된다
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
    // 밝기(카드 전체의 brightness) — 먼 쪽도 0.8 까지만: 카드 글(이름·마지막 도구·승인 기다림)은 진짜 내용이라
    // 가장 밝은 번짐 위에서도 4.5:1 을 지킨다(0.48 까지 내리면 도구 줄이 2:1). 깊이는 크기·겹침 순서가 더 맡는다
    p.o = NODE_DIM + z * (1 - NODE_DIM)
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
