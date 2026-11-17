// 관계도 장면 상태 — 카메라·궤도·점·효과 목록을 만들고, 노드·위성·혜성의 자리를 구한다(시안 orbit3 의 init · place · cometPath).
// DOM·캔버스 없음. 한 프레임 진행은 step.ts, 그리기는 scene.ts(잔상 층) · overlay.ts(또렷한 층)가 이 상태를 읽기만 한다.
// 방을 옮길 때의 전환(transition.ts)은 노드마다 궤도 반지름·각·크기·불투명도 배수(fly)로 자리 잡기에 얹힌다.
// 시간은 모두 장면 시계 w.t(초).
import { easeOut5 } from '../../lib/motion'
import type { AgentState, ScreenEvent } from '../events'
import { CAM_D, CENTER_DROP, TILT, near, projectTo, type Cam, type Proj } from './camera'
import { CORE_Y, FLOOR_Y, layoutOrbits, orbitRA, worldTo, type Orbit } from './layout'
import { FALLBACK_AGENT, FALLBACK_FONTS } from './palette'
import { IDLE, beforeSwap, inK, landK, outK, type Transition } from './transition'

export type Who = { id: string; name: string; color: string }
export type Vec3 = [number, number, number]
/** 화면 위 노드 자리 — s 카드 배율 · z 앞쪽 정도(0~1) · o 밝기 · a 불투명도(방을 옮길 때만 1 아래) */
export type NodePos = { x: number; y: number; s: number; z: number; o: number; a: number }
/**
 * 방을 옮길 때 노드 하나에 얹는 배수 — r 궤도 반지름 · da 더 도는 각 · s 카드 크기 · a 카드 불투명도 · fx 딸린 것(달·위성·잎·물결·말풍선)의 불투명도.
 * r0·da0·s0·a0 은 빨려 들기를 시작한 순간의 값(펼치던 중에 또 옮기면 그 자리에서 이어 빨려 든다). 평소엔 1 · 0 · 1 · 1 · 1
 */
export type Fly = { r: number; da: number; s: number; a: number; fx: number; r0: number; da0: number; s0: number; a0: number }
/** 바꿔 끼울 새 방 — 전환이 그 자리에 이르면 이 노드·위성·상태로. tag 는 화면이 그 방을 아는 번호(RoomChange.n) */
export type NextRoom = { agents: Who[]; satellites: SubLabel[]; states: Record<string, AgentState>; tag: number }
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
  /** 방 옮기기 전환(transition.ts) — 쉬는 중이면 IDLE */
  tr: Transition
  /** 지금 노드가 그리는 방의 번호(RoomChange.n) — 바꿔 끼우면 새 방 것 */
  tag: number
  /** 바꿔 끼울 새 방(전환 중, 바꿔 끼우기 전에만) */
  next: NextRoom | null
  /** 전환 중에 온 사건 — 버리지 않고 전환이 끝난 뒤에 그린다(queue 와 같은 상한) */
  held: ScreenEvent[]
  /** 노드마다 전환 배수 — 자리 잡기(place)가 진행도에서 구한다 */
  fly: Map<string, Fly>
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
/** 알림이 다 나타나기까지(수명의 몫) — 그 앞은 흐려졌다 나타난다 */
export const TOAST_IN = 0.1
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
  /** 이 노드들이 그리는 방의 번호(RoomChange.n) */
  tag?: number
}): World {
  const rand = o.rand ?? Math.random
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
    core: { id: '', name: '', color: FALLBACK_AGENT },
    who: new Map(),
    states: o.states ?? {},
    orbits: [],
    orbitById: new Map(),
    wpos: new Map(),
    pos: new Map(),
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
    tr: IDLE,
    tag: o.tag ?? 0,
    next: null,
    held: [],
    fly: new Map(),
  }
  setNodes(w, o.agents)
  setSatellites(w, o.satellites ?? [])
  resizeWorld(w, o.W, o.H)
  return w
}

const restFly = (): Fly => ({ r: 1, da: 0, s: 1, a: 1, fx: 1, r0: 1, da0: 0, s0: 1, a0: 1 })

/**
 * 노드를 이 에이전트들로 — 첫째가 핵, 나머지가 돈다(0명이면 노드 없음). 처음 지을 때와 방을 옮겨 바꿔 끼울 때 · 같은 방에서 목록이 줄 때.
 * 옛 노드에 딸린 효과(혜성·조각·불꽃·물결·말풍선·잎·아직 안 꺼낸 사건)는 버린다 — 없는 노드를 가리키지 않게. 위성은 setSatellites 로 다시
 */
export function setNodes(w: World, agents: Who[]): void {
  const R = (a: number, b: number) => a + w.rand() * (b - a)
  const { core, orbits } = layoutOrbits(agents.map(a => a.id))
  w.who = new Map(agents.map(a => [a.id, a]))
  w.core = w.who.get(core) ?? { id: core, name: '', color: FALLBACK_AGENT }
  w.orbits = orbits
  w.orbitById = new Map(orbits.map(x => [x.id, x]))
  w.wpos = new Map(agents.map(a => [a.id, [0, CORE_Y, 0] as Vec3]))
  w.pos = new Map(agents.map(a => [a.id, { x: 0, y: 0, s: 1, z: 0.5, o: 1, a: 1 }]))
  w.fly = new Map(agents.map(a => [a.id, restFly()]))
  w.moons = new Map()
  const moon = (r0: number, r1: number): Moon => ({ w: R(1.6, 2.6) * (w.rand() < 0.5 ? -1 : 1), ph: R(0, Math.PI * 2), r: R(r0, r1), tilt: R(-0.6, 0.6) })
  // 혼자면 핵 둘레를 달이 돈다(원반·자이로 밖으로)
  if (agents.length && orbits.length === 0) w.moons.set(w.core.id, [moon(130, 150), moon(130, 150)])
  for (const x of orbits) w.moons.set(x.id, Array.from({ length: w.rand() < 0.5 ? 1 : 2 }, () => moon(54, 68)))
  w.sats = []
  for (const xs of [w.comets, w.shards, w.sparks, w.ripples, w.bubbles, w.leaves, w.queue, w.hits] as unknown[][]) xs.length = 0
  place(w)
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
  const list = w.who.size ? subs.slice(0, MAX_SATS).map(s => ({ name: s.label, parent: w.who.has(s.agentId) ? s.agentId : w.core.id })) : []
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

const clamp01 = (v: number) => (v <= 0 ? 0 : v >= 1 ? 1 : v)
/** 빨려 들기 곡선 — 처음엔 제 궤도 근처를 돌다 핵에 가까울수록 빨리(끌려 드는 느낌) */
export const suck = (k: number): number => k * k
/** 펼치기 곡선 — 빨리 나와 제 자리에서 길게 멈춘다(앱의 관계도 맞춤 이동과 같은 곡선) */
const unfold = easeOut5
/** 펼칠 때 카드가 다 보이는 진행(이 앞에선 흐리다) · 딸린 것(달·위성)이 나오기 시작하는 진행 — 부모가 자리 잡은 뒤에 */
const SHOW_BY = 0.25
const FX_FROM = 0.7

/**
 * 노드마다 전환 배수를 진행도에서 — 빨려 들기: 반지름·크기·불투명도 × (1 − suck(outK)), 각 + outK·π(나선).
 * 펼치기: 핵부터 차례로 늦게 출발해(landK) 반지름·크기 × unfold, 각 − (1 − k)·π, 딸린 것은 자리 잡을 무렵부터.
 * 움직임 줄이기면 나선·반지름·크기는 그대로 불투명도만(제자리에서 흐려졌다 나타난다)
 */
function flyAll(w: World): void {
  const tr = w.tr
  if (tr.phase === 'idle') {
    for (const f of w.fly.values()) {
      f.r = 1
      f.da = 0
      f.s = 1
      f.a = 1
      f.fx = 1
    }
    return
  }
  if (beforeSwap(tr)) {
    const k = outK(tr)
    const e = w.calm ? k : suck(k)
    for (const f of w.fly.values()) {
      f.r = w.calm ? f.r0 : f.r0 * (1 - e)
      f.da = w.calm ? f.da0 : f.da0 + k * Math.PI
      f.s = w.calm ? f.s0 : f.s0 * (1 - e)
      f.a = f.a0 * (1 - e)
      f.fx = f.a
    }
    return
  }
  const k = inK(tr)
  const n = w.fly.size
  let i = 0
  for (const f of w.fly.values()) {
    const ki = w.calm ? k : landK(k, i++, n)
    const e = w.calm ? 1 : unfold(ki)
    f.r = e
    f.da = w.calm ? 0 : -(1 - ki) * Math.PI
    f.s = e
    f.a = w.calm ? ki : clamp01(ki / SHOW_BY)
    f.fx = w.calm ? ki : clamp01((ki - FX_FROM) / (1 - FX_FROM))
  }
}

/** 옛 방 효과(혜성·조각·불꽃)의 불투명도 — 빨려 들며 함께 사라진다 */
export const fxAlpha = (w: World): number => (beforeSwap(w.tr) ? 1 - outK(w.tr) : 1)
/** 노드에 딸린 것(달·위성·잎·물결·말풍선)의 불투명도 */
export const fxOf = (w: World, id: string): number => w.fly.get(id)?.fx ?? 1

/** 궤도 위 점을 out 에 — 방을 옮기는 중이면 그 노드의 배수만큼 핵 쪽으로(반지름 × r · 각 + da · 높이는 핵 높이로 다가간다) */
function flyTo(w: World, out: Vec3, o: Orbit, turn: number): Vec3 {
  const f = w.fly.get(o.id)
  if (!f || (f.r === 1 && f.da === 0)) return worldTo(out, o, w.RA, turn)
  worldTo(out, o, w.RA * f.r, turn + f.da)
  out[1] += (1 - f.r) * CORE_Y
  return out
}

/** 노드 자리 — 핵은 가운데, 궤도 에이전트는 제 궤도 위(시안 place). 방을 옮기는 중이면 전환 배수를 얹는다 */
export function place(w: World): void {
  if (!w.W || !w.H) return // 칸 크기 0 — 반지름이 0 이라 나눗셈이 NaN 이 된다
  flyAll(w)
  const c = w.pos.get(w.core.id)
  if (c) {
    const f = w.fly.get(w.core.id)!
    projectTo(P, w.cam, 0, CORE_Y, 0)
    c.x = P.x
    c.y = P.y
    c.s = 1.1 * P.f * f.s
    c.z = 0.5
    c.o = 1
    c.a = f.a
  }
  const turn = orbitTurn(w)
  for (const o of w.orbits) {
    const wp = flyTo(w, w.wpos.get(o.id)!, o, turn)
    projectTo(P, w.cam, wp[0], wp[1], wp[2])
    const z = near(P, w.RA)
    const p = w.pos.get(o.id)!
    const f = w.fly.get(o.id)!
    p.x = P.x
    p.y = P.y
    p.s = (0.76 + z * 0.3) * P.f * f.s
    p.z = z
    // 밝기(카드 전체의 brightness) — 먼 쪽도 0.8 까지만: 카드 글(이름·마지막 도구·승인 기다림)은 진짜 내용이라
    // 가장 밝은 번짐 위에서도 4.5:1 을 지킨다(0.48 까지 내리면 도구 줄이 2:1). 깊이는 크기·겹침 순서가 더 맡는다
    p.o = NODE_DIM + z * (1 - NODE_DIM)
    p.a = f.a
  }
}

/** 위성 하나의 화면 자리 — 핵 둘레 RA·0.56 를 돈다(빨려 드는 동안은 그 반지름도 핵으로) */
export function satPoint(w: World, s: Sat, out: Proj): Proj {
  const a = s.a + w.tt * s.w * 2.2
  const k = w.calm || !beforeSwap(w.tr) ? 1 : 1 - suck(outK(w.tr))
  const r = w.RA * SAT_R * k
  return projectTo(out, w.cam, Math.cos(a) * r, SAT_Y + (1 - k) * (CORE_Y - SAT_Y), Math.sin(a) * r)
}

/** 혜성이 e(0~1) 만큼 간 화면 자리 — 두 노드 사이를 위로 솟는 3D 호(시안 cometPath) */
export function cometPoint(w: World, from: string, to: string, e: number, out: Proj): Proj {
  const a = w.wpos.get(from)!
  const b = w.wpos.get(to)!
  const dist = Math.hypot(b[0] - a[0], b[2] - a[2])
  return projectTo(out, w.cam, a[0] + (b[0] - a[0]) * e, a[1] + (b[1] - a[1]) * e + Math.sin(Math.PI * e) * (46 + dist * 0.32), a[2] + (b[2] - a[2]) * e)
}

/** 궤도 위 점(지나온 길 · 조각 그리기용) — V 를 돌려쓴다. 방을 옮기는 중이면 그 궤도도 노드와 함께 줄고 는다 */
export function orbitPoint(w: World, o: Orbit, turn: number): Vec3 {
  return flyTo(w, V, o, turn)
}
