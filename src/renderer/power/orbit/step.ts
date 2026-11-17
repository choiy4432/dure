// 관계도 한 프레임 — 들어온 진짜 사건 꺼내기 · 전체 동기화 · 방 옮기기 전환 · 카메라 · 혜성·조각·불꽃 진행(시안 orbit3.frame 앞부분 · comet · handoff · tool · hot).
// 혜성은 진짜 넘김에서만, 조각·잎·핵 밝기는 진짜 도구 사용에서만, 동기화는 진짜 차례 끝(done)에서만 나온다(떠도는 혜성·시간으로 터지는 동기화는 없다).
// 동기화('끝남')와 방 옮기기의 도약은 세기 값 하나(boost.b = 둘 중 큰 쪽)로 같은 연출(급회전·당기기·흔들림·은하 줄무늬)을 쓴다.
// 프레임 사이를 MAX_DT 로 잘라 장면 시계에 쌓으니 창이 숨었다 돌아와도 튀지 않는다. DOM·캔버스 없음.
import type { AgentState, ScreenEvent } from '../events'
import { SHAKE_PX, TILT, ZOOM, type Proj } from './camera'
import { TR, beforeSwap, jumpK, startTransition, stepTransition } from './transition'
import {
  ACT_FLOOR,
  ENERGY,
  LIFE,
  NO_BOOST,
  SYNC,
  TOAST_IN,
  baseName,
  colorOf,
  cometPoint,
  place,
  setNodes,
  setSatellites,
  setStates,
  trunc,
  type Boost,
  type Comet,
  type SubLabel,
  type Who,
  type World,
} from './world'

const YAW_SPEED = 0.05
const MAX_DT = 0.05
/** 알림 — 이름(head) + 꼬리(tail). 이름은 길이 상한이 없는 사용자 글이라 자르기는 그리는 쪽이 잰 너비로(overlay.toast) */
const toastOf = (t0: number, head: string, tail: string) => ({ t0, text: head + tail, head, tail })
const MAX_LEAVES = 16
const MAX_COMETS = 80
const MAX_QUEUE = 200
/** 한꺼번에 몰려 온 사건을 조금씩 흩는다 */
const SPREAD = 0.24
const BUBBLE_MAX = 34
const LEAF_MAX = 26

const P: Proj = { x: 0, y: 0, f: 0, d: 0 }
/** 이번 프레임에 닿은 넘김 — 프레임마다 새로 만들지 않는다 */
const arrived: Comet[] = []

/** 세기 b(0~1) → 장면에 얹는 값 — 동기화와 도약이 함께 쓴다. 차분 모드면 흔들림·급회전·당기기·은하 줄무늬 없이 */
export function boostOf(calm: boolean, b: number): Boost {
  if (calm || b <= 0) return { ...NO_BOOST, b: Math.max(0, b) }
  return { b, orbit: b * 5, yaw: b * 1.7, tilt: b * TILT.syncDip, zoom: b * ZOOM.sync, shake: b * SHAKE_PX, galaxy: b * 8, fade: b * 0.09, bloom: b * 0.3, streak: b > 0.05 }
}

/** 동기화 진행 k(0~1, 밖이면 0) → 세기 — 종 모양 */
const syncK = (k: number): number => (k >= 0 && k < 1 ? Math.sin(Math.PI * k) : 0)

/** 동기화 진행 k(0~1, 밖이면 아무것도 없음) → 얹는 값 */
export function syncBoost(calm: boolean, k: number): Boost {
  return boostOf(calm, syncK(k))
}

/**
 * 화면 사건을 받는다 — 도구·넘김·차례 끝만, 모르는 에이전트는 버린다. 도구·넘김은 조금씩 흩어서, 차례 끝은 다음 프레임에 꺼낸다.
 * 방을 옮기는 중이면 새 방 사건을 버리지 않고 쥐었다가 전환이 끝난 뒤에 받는다(카드가 자리 잡은 뒤에 그려지게 · '끝남' 연출도 그 뒤로)
 */
export function intake(w: World, ev: ScreenEvent): void {
  if (ev.kind !== 'tool' && ev.kind !== 'done' && ev.kind !== 'handoff') return
  if (w.tr.phase !== 'idle') {
    if (w.held.length >= MAX_QUEUE) w.held.shift()
    w.held.push(ev)
    return
  }
  if (ev.kind === 'handoff') {
    if (!w.who.has(ev.from) || !w.who.has(ev.to) || ev.from === ev.to) return
  } else if (!w.who.has(ev.agentId)) return
  if (w.queue.length >= MAX_QUEUE) w.queue.shift()
  w.queue.push({ at: ev.kind === 'done' ? w.t : w.t + w.rand() * SPREAD, ev })
}

function comet(w: World, from: string, to: string, o: { small?: boolean; delay?: number; T?: number; text?: string } = {}): void {
  if (w.comets.length >= MAX_COMETS) return
  w.comets.push({ from, to, t0: w.t + (o.delay ?? 0), T: o.T ?? 0.9 + w.rand() * 0.5, color: colorOf(w, from), small: !!o.small, trail: [], text: o.text ?? null })
}

function applyTool(w: World, id: string, tool: string, target: string): void {
  const color = colorOf(w, id)
  w.leaves.push({ id, ang: w.rand() * Math.PI * 2, t0: w.t, label: trunc(`${tool} ${baseName(target)}`.trim(), LEAF_MAX), color })
  if (w.leaves.length > MAX_LEAVES) w.leaves.shift()
  w.act = Math.min(1, w.act + 0.14)
  w.energy = Math.min(1, w.energy + ENERGY.tool) // 핵 밝기는 최근 진짜 도구 사용 빈도를 따른다
  // 핵이 쓴 도구는 잎만 — 조각은 궤도에서 핵으로 빨려 든다
  if (id !== w.core.id) w.shards.push({ id, t0: w.t, T: 1.4 + w.rand() * 0.6, color })
}

function applyHandoff(w: World, from: string, to: string, text: string): void {
  comet(w, from, to, { text: trunc(text, BUBBLE_MAX) })
  if (w.rand() < 0.4) {
    const n = 2 + Math.floor(w.rand() * 3)
    for (let i = 1; i <= n; i++) comet(w, from, to, { small: true, delay: i * 0.09 })
  }
}

/** 넘김이 닿았다 — 물결 · 말풍선 · 카드 번쩍 · 불꽃 */
function arrive(w: World, c: Comet): void {
  const R = (a: number, b: number) => a + w.rand() * (b - a)
  const { from, to } = c
  w.ripples.push({ id: to, t0: w.t, color: colorOf(w, from) })
  w.bubbles = w.bubbles.filter(b => b.id !== to)
  w.bubbles.push({ id: to, t0: w.t, from, text: c.text ?? '' })
  w.hits.push(to)
  w.act = Math.min(1, w.act + 0.45)
  const wp = w.wpos.get(to)!
  for (let i = 0; i < 18; i++) {
    const a = R(0, Math.PI * 2)
    const v = R(50, 150)
    w.sparks.push({ x: wp[0], y: wp[1], z: wp[2], vx: Math.cos(a) * v, vy: R(40, 150), vz: Math.sin(a) * v, t0: w.t, color: colorOf(w, w.rand() < 0.5 ? from : to) })
  }
}

/** 에이전트가 진짜로 한 차례를 끝냈다 — 동기화 연출(지난 동기화에서 SYNC.gap 초가 안 지났으면 아무것도 안 한다) */
function finished(w: World, id: string): void {
  if (w.t - w.sync.t0 < SYNC.gap) return
  beginSync(w, w.who.get(id)?.name ?? '')
}

function beginSync(w: World, name: string): void {
  const R = (a: number, b: number) => a + w.rand() * (b - a)
  w.sync.t0 = w.t
  w.toast = toastOf(w.t, name, ' 끝남')
  w.flare = w.t
  // 차분 모드는 알림과 은은한 빛만 — 출력 폭발·카드 번쩍·폭죽 혜성 없이
  if (w.calm) return
  w.energy = 1
  w.act = 1
  for (const id of w.who.keys()) w.hits.push(id)
  if (w.orbits.length)
    for (let i = 0; i < 14; i++) comet(w, w.core.id, w.orbits[Math.floor(w.rand() * w.orbits.length)].id, { small: true, delay: i * 0.055, T: R(0.6, 0.9) })
}


/**
 * 방이 바뀌었다 — 지금 화면의 노드를 핵으로 빨아들이고(있으면) 도약한 뒤 새 방 노드를 펼친다(transition.ts).
 * 바꿔 끼우기 전에 또 바뀌면 진행은 그대로 갈 방만, 펼치는 중이면 지금 카드 자리에서 다시 빨려 든다.
 * 아직 안 꺼낸 옛 방 사건은 버리고, 그 뒤로 오는 사건은 전환이 끝날 때까지 쥔다(intake). 알림 `<이름> 방으로` 는 도약이 시작될 때
 */
export function changeRoom(w: World, o: { agents: Who[]; satellites: SubLabel[]; states: Record<string, AgentState>; tag: number; toRoom: string | null; name: string | null }): void {
  const fresh = !beforeSwap(w.tr)
  // 갈 방이 바뀌었으면 그 전에 갈 방이던 곳의 사건은 버린다 — 이제 그 방을 듣지 않는다(같은 방의 목록만 줄었으면 그대로)
  if (w.next?.tag !== o.tag) w.held.length = 0
  w.tr = startTransition(w.tr, { toRoom: o.toRoom, toName: o.name ?? '', hasOut: w.who.size > 0, hasIn: o.agents.length > 0 })
  w.next = { agents: o.agents, satellites: o.satellites, states: o.states, tag: o.tag }
  if (w.tr.phase === 'idle') {
    swapIn(w) // 화면에 카드도 없고 갈 방도 비었다 — 바로 바꾼다
    return
  }
  if (fresh) {
    w.queue.length = 0
    // 빨려 들기는 지금 카드 자리에서(펼치던 중이었으면 그 반지름·각·크기에서) 시작한다
    for (const f of w.fly.values()) {
      f.r0 = f.r
      f.da0 = f.da
      f.s0 = f.s
      f.a0 = f.a
    }
  }
  if (o.name === null) return
  // 이미 떠 있으면(도약 중에 또 옮겼다) 글만 바꾼다 — 다시 흐려졌다 나타나지 않게 지금 밝기에서 이어 간다(다 보였으면 수명을 처음부터)
  const s = w.toast
  const k = s ? (w.t - s.t0) / LIFE.toast : -1
  const wait = w.tr.phase === 'out' && !w.calm ? Math.max(0, TR.out - w.tr.t) : 0
  w.toast = toastOf(k >= 0 && k < 1 ? w.t - LIFE.toast * Math.min(k, TOAST_IN) : w.t + wait, o.name, ' 방으로')
}

/** 새 방 노드로 바꿔 끼운다 — 핵이 번쩍이고 그 자리에서 새 카드가 나온다 */
function swapIn(w: World): void {
  const n = w.next
  w.next = null
  if (!n) return // 빈 방에서 온 전환 — 노드는 이미 그 방 것
  setNodes(w, n.agents)
  setSatellites(w, n.satellites)
  setStates(w, n.states)
  w.tag = n.tag
  if (n.agents.length) w.flare = w.t
}

/** 전환이 끝났다 — 쥐고 있던 사건을 이제 받는다(바꿔 끼운 방의 에이전트 것만 남는다) */
function release(w: World): void {
  const held = w.held
  w.held = []
  for (const ev of held) intake(w, ev)
}

/** 배열에서 keep 이 거짓인 것을 제자리에서 뺀다(프레임마다 새 배열을 만들지 않는다) */
function prune<T>(xs: T[], keep: (x: T) => boolean): void {
  let j = 0
  for (let i = 0; i < xs.length; i++) if (keep(xs[i])) xs[j++] = xs[i]
  xs.length = j
}

/** 한 프레임 진행 — now 는 rAF 시각(ms) */
export function stepWorld(w: World, now: number): void {
  const dt = w.last === null ? 0 : Math.min(MAX_DT, Math.max(0, (now - w.last) / 1000))
  w.last = now
  w.t += dt
  const t = w.t

  // 방 옮기기 — 바꿔 끼울 때가 되면 새 방 노드로, 끝나면 쥐고 있던 사건을 받는다
  const tr = stepTransition(w.tr, dt, w.calm)
  w.tr = tr.tr
  if (tr.swap) swapIn(w)
  if (tr.done) release(w)

  // 때가 된 사건을 꺼낸다(적용은 queue 를 건드리지 않아 제자리에서 걸러도 된다)
  prune(w.queue, ({ at, ev }) => {
    if (at > t) return true
    if (ev.kind === 'tool') applyTool(w, ev.agentId, ev.tool, ev.target)
    else if (ev.kind === 'handoff') applyHandoff(w, ev.from, ev.to, ev.text)
    else if (ev.kind === 'done') finished(w, ev.agentId)
    return false
  })

  const k = (t - w.sync.t0) / SYNC.sec
  w.syncing = k >= 0 && k < 1
  // 세기 하나 — 동기화('끝남')와 도약 중 센 쪽
  const B = (w.boost = boostOf(w.calm, Math.max(syncK(k), jumpK(w.tr))))

  // 카메라 — 천천히 돌고, 기울기·당기기가 숨 쉬듯. 동기화·도약이면 급회전·흔들림
  w.tt += dt * (1 + B.orbit)
  w.cam.yaw += dt * (YAW_SPEED + B.yaw)
  w.cam.e = TILT.base + TILT.swing * Math.sin(t * 0.13) - B.tilt
  w.cam.zoom = 1 + ZOOM.swing * Math.sin(t * 0.17) + B.zoom
  w.cam.cx = w.cx0 + Math.sin(t * 61) * B.shake
  w.cam.cy = w.cy0 + Math.cos(t * 53) * B.shake
  w.galSpin += dt * (1 + B.galaxy)
  w.energy += (ENERGY.rest - w.energy) * Math.min(1, dt * ENERGY.decay)
  w.act = Math.max(ACT_FLOOR, w.act * Math.pow(0.35, dt))
  if (dt > 0) {
    w.wave.push(w.act * (0.35 + 0.65 * w.rand()))
    w.wave.shift()
  }
  place(w)

  // 혜성 — 꼬리 점을 쌓고, 닿으면 받는 쪽 효과
  arrived.length = 0
  prune(w.comets, c => {
    if (t < c.t0) return true
    const kk = Math.min(1, (t - c.t0) / c.T)
    const e = kk < 0.5 ? 2 * kk * kk : 1 - Math.pow(-2 * kk + 2, 2) / 2
    cometPoint(w, c.from, c.to, e, P)
    const max = c.small ? 9 : 18
    const pt = c.trail.length >= max ? c.trail.shift()! : { x: 0, y: 0 }
    pt.x = P.x
    pt.y = P.y
    c.trail.push(pt)
    if (kk < 1) return true
    if (c.text !== null) arrived.push(c)
    return false
  })
  for (const c of arrived) arrive(w, c)

  prune(w.shards, s => t - s.t0 < s.T)
  prune(w.sparks, s => {
    if (t - s.t0 >= LIFE.spark) return false
    s.x += s.vx * dt
    s.y += s.vy * dt
    s.z += s.vz * dt
    s.vy -= 260 * dt
    return true
  })
  prune(w.ripples, r => t - r.t0 < LIFE.ripple)
  prune(w.bubbles, b => t - b.t0 < LIFE.bubble)
  prune(w.leaves, l => t - l.t0 < LIFE.leaf)
  if (w.toast && t - w.toast.t0 >= LIFE.toast) w.toast = null
}
