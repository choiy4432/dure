// 관계도 한 프레임 — 들어온 사건 꺼내기 · 전체 동기화 · 카메라 · 혜성·조각·불꽃 진행(시안 orbit3.frame 앞부분 · comet · handoff · tool · hot).
// 프레임 사이를 MAX_DT 로 잘라 장면 시계에 쌓으니 창이 숨었다 돌아와도 튀지 않는다. DOM·캔버스 없음.
import type { ScreenEvent } from '../events'
import { SHAKE_PX, TILT, ZOOM, type Proj } from './camera'
import { LIFE, NO_BOOST, SYNC, baseName, colorOf, cometPoint, place, trunc, type Boost, type Comet, type World } from './world'

const YAW_SPEED = 0.05
const MAX_DT = 0.05
const TOASTS = ['전체 동기화 · 넘긴 일 정리 중', '전체 동기화 · 맥락 압축 중', '전체 동기화 · 결과 모으는 중']
const MAX_LEAVES = 16
const MAX_COMETS = 80
const MAX_QUEUE = 200
/** 한 틱(250ms) 에 몰려 온 사건을 그 사이에 고르게 흩는다 */
const SPREAD = 0.24
const BUBBLE_MAX = 34
const LEAF_MAX = 26

const P: Proj = { x: 0, y: 0, f: 0, d: 0 }
/** 이번 프레임에 닿은 넘김 — 프레임마다 새로 만들지 않는다 */
const arrived: Comet[] = []

/** 동기화 진행 k(0~1, 밖이면 아무것도 없음) → 얹는 값. 차분 모드면 흔들림·급회전·당기기·은하 줄무늬 없이 */
export function syncBoost(calm: boolean, k: number): Boost {
  const b = k >= 0 && k < 1 ? Math.sin(Math.PI * k) : 0
  if (calm || b === 0) return { ...NO_BOOST, b }
  return { b, orbit: b * 5, yaw: b * 1.7, tilt: b * TILT.syncDip, zoom: b * ZOOM.sync, shake: b * SHAKE_PX, galaxy: b * 8, fade: b * 0.09, bloom: b * 0.3, streak: b > 0.05 }
}

/** 화면 사건을 받는다 — 모르는 에이전트는 버리고, 다음 틱 전까지 흩어서 꺼낸다 */
export function intake(w: World, ev: ScreenEvent): void {
  if (ev.kind === 'tool' ? !w.who.has(ev.agentId) : !w.who.has(ev.from) || !w.who.has(ev.to) || ev.from === ev.to) return
  if (w.queue.length >= MAX_QUEUE) w.queue.shift()
  w.queue.push({ at: w.t + w.rand() * SPREAD, ev })
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

/** 넘김이 닿았다 — 물결 · '+N.Nk 토큰' · 말풍선 · 카드 번쩍 · 불꽃 */
function arrive(w: World, c: Comet): void {
  const R = (a: number, b: number) => a + w.rand() * (b - a)
  const { from, to } = c
  w.ripples.push({ id: to, t0: w.t, color: colorOf(w, from) })
  w.floats.push({ id: to, t0: w.t, color: colorOf(w, to), text: `+${R(0.4, 3.2).toFixed(1)}k 토큰`, dx: R(-24, 24) })
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

function beginSync(w: World): void {
  const R = (a: number, b: number) => a + w.rand() * (b - a)
  w.sync.t0 = w.t
  w.sync.next = w.t + R(...SYNC.every)
  w.toast = { t0: w.t, text: TOASTS[Math.floor(w.rand() * TOASTS.length)] }
  w.flare = w.t
  // 차분 모드는 알림과 은은한 빛만 — 출력 폭발·카드 번쩍·폭죽 혜성 없이
  if (w.calm) return
  w.energy = 1
  w.act = 1
  for (const id of w.who.keys()) w.hits.push(id)
  if (w.orbits.length)
    for (let i = 0; i < 14; i++) comet(w, w.core.id, w.orbits[Math.floor(w.rand() * w.orbits.length)].id, { small: true, delay: i * 0.055, T: R(0.6, 0.9) })
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

  // 때가 된 사건을 꺼낸다(적용은 queue 를 건드리지 않아 제자리에서 걸러도 된다)
  prune(w.queue, ({ at, ev }) => {
    if (at > t) return true
    if (ev.kind === 'tool') applyTool(w, ev.agentId, ev.tool, ev.target)
    else applyHandoff(w, ev.from, ev.to, ev.text)
    return false
  })

  if (t >= w.sync.next) beginSync(w)
  const k = (t - w.sync.t0) / SYNC.sec
  w.syncing = k >= 0 && k < 1
  const B = (w.boost = syncBoost(w.calm, k))

  // 카메라 — 천천히 돌고, 기울기·당기기가 숨 쉬듯. 동기화면 급회전·흔들림
  w.tt += dt * (1 + B.orbit)
  w.cam.yaw += dt * (YAW_SPEED + B.yaw)
  w.cam.e = TILT.base + TILT.swing * Math.sin(t * 0.13) - B.tilt
  w.cam.zoom = 1 + ZOOM.swing * Math.sin(t * 0.17) + B.zoom
  w.cam.cx = w.cx0 + Math.sin(t * 61) * B.shake
  w.cam.cy = w.cy0 + Math.cos(t * 53) * B.shake
  w.galSpin += dt * (1 + B.galaxy)
  w.energy += (0.58 - w.energy) * dt * 0.25
  w.act = Math.max(0.12, w.act * Math.pow(0.35, dt))
  if (dt > 0) {
    w.wave.push(w.act * (0.35 + 0.65 * w.rand()))
    w.wave.shift()
  }
  place(w)

  // 늘 도는 잔잔한 혜성 — 핵 ↔ 궤도
  if (w.orbits.length && t >= w.nextAmb) {
    w.nextAmb = t + 0.07 + w.rand() * 0.15
    const id = w.orbits[Math.floor(w.rand() * w.orbits.length)].id
    const out = w.rand() < 0.5
    comet(w, out ? w.core.id : id, out ? id : w.core.id, { small: true, T: 0.8 + w.rand() * 0.5 })
  }

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

  prune(w.shards, s => {
    if (t - s.t0 < s.T) return true
    w.energy = Math.min(1, w.energy + 0.05) // 조각이 핵에 닿으면 출력이 오른다
    return false
  })
  prune(w.sparks, s => {
    if (t - s.t0 >= LIFE.spark) return false
    s.x += s.vx * dt
    s.y += s.vy * dt
    s.z += s.vz * dt
    s.vy -= 260 * dt
    return true
  })
  prune(w.ripples, r => t - r.t0 < LIFE.ripple)
  prune(w.floats, f => t - f.t0 < LIFE.float)
  prune(w.bubbles, b => t - b.t0 < LIFE.bubble)
  prune(w.leaves, l => t - l.t0 < LIFE.leaf)
  if (w.toast && t - w.toast.t0 >= LIFE.toast) w.toast = null
}
