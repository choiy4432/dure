// 잔상 층 — 지우지 않고 조금씩 흐리게 덮어, 움직이는 모든 것이 꼬리를 남긴다(시안 orbit3.frame 의 잔상 층).
// 바닥 격자 · 은하 · 원반 · 궤도와 지나온 길 · 눈금 고리 · 핵(빛·빛기둥·이중 나선·자이로) · 달 · 위성 · 데이터 조각 · 불꽃 · 동기화 빛.
// 상태는 읽기만 한다(바꾸는 건 world.stepWorld).
import { near, projectTo, type Proj } from './camera'
import { CORE_Y, FLOOR_Y } from './layout'
import { GALAXY_RGB, RGB, SHARD_CORE, WHITE, hexA, rgbOf, shade } from './palette'
import { LIFE, colorOf, orbitPoint, orbitTurn, satPoint, type World } from './world'

/** 잔상 층 세기(시안 S) */
const S = 0.24
/** 잔상 흐리기 알파 — 동기화 중엔 boost.fade 만큼 덜 지워 꼬리가 길어진다(0.11 까지) */
const FADE = 0.2
/** 차분 모드의 동기화 빛 세기 */
const FLARE_CALM = 0.35
const TAU = Math.PI * 2
const DASH_LINK = [4, 9]
const DASH_SAT = [2, 5]
const NO_DASH: number[] = []

const P: Proj = { x: 0, y: 0, f: 0, d: 0 }
const Q: Proj = { x: 0, y: 0, f: 0, d: 0 }

function line(x: CanvasRenderingContext2D, ax: number, ay: number, bx: number, by: number): void {
  x.beginPath()
  x.moveTo(ax, ay)
  x.lineTo(bx, by)
  x.stroke()
}

/** 바닥과 나란한 고리 — 앞쪽일수록 a1 에 가깝게 진하다 */
function ring(x: CanvasRenderingContext2D, w: World, r: number, y: number, n: number, rgb: string, a0: number, a1: number, lw: number): void {
  x.lineWidth = lw
  projectTo(Q, w.cam, r, y, 0)
  for (let i = 1; i <= n; i++) {
    const a = (i / n) * TAU
    projectTo(P, w.cam, Math.cos(a) * r, y, Math.sin(a) * r)
    x.strokeStyle = shade(rgb, a0 + (a1 - a0) * near(P, r + 1))
    line(x, Q.x, Q.y, P.x, P.y)
    Q.x = P.x
    Q.y = P.y
  }
}

export function drawScene(x: CanvasRenderingContext2D, w: World, k: number): void {
  const { W, H } = w
  if (!W || !H) return
  x.setTransform(k, 0, 0, k, 0, 0)
  x.globalCompositeOperation = 'destination-out'
  x.fillStyle = shade(RGB.erase, FADE - w.boost.fade)
  x.fillRect(0, 0, W, H)
  x.globalCompositeOperation = 'lighter'
  stars(x, w)
  floor(x, w)
  galaxy(x, w)
  disc(x, w)
  orbits(x, w)
  ticks(x, w)
  core(x, w)
  moons(x, w)
  satellites(x, w)
  shards(x, w)
  sparks(x, w)
  x.globalCompositeOperation = 'source-over'
}

function stars(x: CanvasRenderingContext2D, w: World): void {
  for (const s of w.stars) {
    x.fillStyle = shade(RGB.star, S * (0.2 + 0.5 * (0.5 + 0.5 * Math.sin(w.t * 1.8 + s.tw))))
    x.fillRect(s.x, s.y, s.s, s.s)
  }
}

/** 바닥 격자(홀로그램) + 바깥으로 퍼지는 맥박 */
function floor(x: CanvasRenderingContext2D, w: World): void {
  const { RA } = w
  for (let k = 1; k <= 7; k++) ring(x, w, RA * 0.3 * k, FLOOR_Y, 72, RGB.floor, 0.01, S * 0.5, 1)
  x.lineWidth = 1
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * TAU
    const ca = Math.cos(a)
    const sa = Math.sin(a)
    projectTo(Q, w.cam, ca * RA * 0.3, FLOOR_Y, sa * RA * 0.3)
    for (let k = 2; k <= 7; k++) {
      projectTo(P, w.cam, ca * RA * 0.3 * k, FLOOR_Y, sa * RA * 0.3 * k)
      x.strokeStyle = shade(RGB.floor, 0.01 + S * 0.4 * near(P, RA * 2.1))
      line(x, Q.x, Q.y, P.x, P.y)
      Q.x = P.x
      Q.y = P.y
    }
  }
  const pk = (w.t % 2.4) / 2.4
  ring(x, w, RA * 2.1 * pk, FLOOR_Y, 90, RGB.pulse, 0, 0.5 * (1 - pk), 1.6)
}

/** 은하 — 세 팔 소용돌이. 동기화 땐 빨리 돌고 진해져 줄무늬가 된다 */
function galaxy(x: CanvasRenderingContext2D, w: World): void {
  const g = w.gal
  const R2 = w.RA * 2.2
  const gain = w.boost.streak ? 1 : S * 1.6
  for (let i = 0; i < g.r.length; i++) {
    const a = g.a[i] + w.galSpin * g.om[i]
    const r = g.r[i]
    projectTo(P, w.cam, Math.cos(a) * r, g.y[i], Math.sin(a) * r)
    x.fillStyle = shade(GALAXY_RGB[g.c[i]], (0.12 + near(P, R2) * 0.5) * gain)
    x.fillRect(P.x, P.y, 1.3 * P.f, 1.3 * P.f)
  }
}

/** 원반 — 핵 둘레를 빠르게 */
function disc(x: CanvasRenderingContext2D, w: World): void {
  const d = w.disk
  for (let i = 0; i < d.r.length; i++) {
    const a = d.a[i] + w.t * d.sp[i]
    const r = d.r[i]
    projectTo(P, w.cam, Math.cos(a) * r, CORE_Y + d.y[i], Math.sin(a) * r)
    x.fillStyle = shade(RGB.disc, 0.25 + near(P, 120) * 0.5)
    x.fillRect(P.x, P.y, 1.4, 1.4)
  }
}

/** 에이전트마다 제 궤도(기울기가 다르다) + 지나온 길 + 핵으로 가는 점선 + 바닥으로 내린 선 */
function orbits(x: CanvasRenderingContext2D, w: World): void {
  const N = 96
  const turn = orbitTurn(w)
  const c = w.pos.get(w.core.id)!
  for (const o of w.orbits) {
    const rgb = rgbOf(colorOf(w, o.id))
    let v = orbitPoint(w, o, turn)
    projectTo(Q, w.cam, v[0], v[1], v[2])
    for (let i = 1; i <= N; i++) {
      v = orbitPoint(w, o, turn + (i / N) * TAU)
      projectTo(P, w.cam, v[0], v[1], v[2])
      const back = 1 - i / N
      const tail = back < 0.2 ? 1 - back / 0.2 : 0
      const nr = near(P, w.RA)
      x.strokeStyle = shade(rgb, S * (0.18 + 0.5 * nr) + tail * 0.5 * (0.4 + 0.6 * nr))
      x.lineWidth = 1 + tail * 2.2
      line(x, Q.x, Q.y, P.x, P.y)
      Q.x = P.x
      Q.y = P.y
    }
    const p = w.pos.get(o.id)!
    x.strokeStyle = shade(rgb, S * (0.3 + p.z * 0.7))
    x.lineWidth = 1
    x.setLineDash(DASH_LINK)
    x.lineDashOffset = -w.t * 40
    line(x, c.x, c.y, p.x, p.y)
    x.setLineDash(NO_DASH)
    const wp = w.wpos.get(o.id)!
    projectTo(P, w.cam, wp[0], FLOOR_Y, wp[2])
    x.strokeStyle = shade(rgb, S * 0.9)
    line(x, p.x, p.y, P.x, P.y)
    x.fillStyle = shade(rgb, 0.5)
    x.beginPath()
    x.ellipse(P.x, P.y, 7 * P.f, 7 * P.f * Math.sin(w.cam.e), 0, 0, TAU)
    x.fill()
  }
}

/** 눈금 고리 — 6칸마다 긴 눈금(숫자는 또렷한 층) */
function ticks(x: CanvasRenderingContext2D, w: World): void {
  const r0 = w.RA * 1.16
  ring(x, w, r0, 0, 180, RGB.tickRing, S * 0.2, S * 1.4, 1.2)
  for (let i = 0; i < 72; i++) {
    const a = (i / 72) * TAU
    const big = i % 6 === 0
    const half = (big ? 16 : 6) / 2
    const ca = Math.cos(a)
    const sa = Math.sin(a)
    projectTo(Q, w.cam, ca * (r0 - half), 0, sa * (r0 - half))
    projectTo(P, w.cam, ca * (r0 + half), 0, sa * (r0 + half))
    x.strokeStyle = shade(RGB.tick, S * ((big ? 0.5 : 0.2) + near(P, w.RA) * (big ? 1.6 : 0.9)))
    x.lineWidth = big ? 1.4 : 1
    line(x, Q.x, Q.y, P.x, P.y)
  }
}

/** 핵 — 빛(동기화 땐 터지는 빛과 충격파), 빛기둥, 이중 나선, 자이로 고리 셋 */
function core(x: CanvasRenderingContext2D, w: World): void {
  const t = w.t
  const c = w.pos.get(w.core.id)!
  const fk = (t - w.flare) / 1.1
  const fl = (fk >= 0 && fk < 1 ? 1 - fk : 0) * (w.calm ? FLARE_CALM : 1)
  const cr = 130 + w.energy * 70 + fl * 130
  const gr = x.createRadialGradient(c.x, c.y, 6, c.x, c.y, cr)
  gr.addColorStop(0, shade(RGB.glow, S * (0.5 + w.energy * 0.5 + fl)))
  gr.addColorStop(1, shade(RGB.glowEdge, 0))
  x.fillStyle = gr
  x.beginPath()
  x.arc(c.x, c.y, cr, 0, TAU)
  x.fill()
  if (fl && !w.calm) for (let j = 0; j < 3; j++) ring(x, w, 50 + (fk + j * 0.12) * w.RA * 1.6, FLOOR_Y + 20, 100, RGB.flare, 0, 0.7 * fl, 2.4 - j * 0.6)

  projectTo(Q, w.cam, 0, FLOOR_Y, 0)
  projectTo(P, w.cam, 0, 190, 0)
  const pg = x.createLinearGradient(Q.x, Q.y, P.x, P.y)
  pg.addColorStop(0, shade(RGB.pillar, S * 1.2))
  pg.addColorStop(1, shade(RGB.pillar, 0))
  x.strokeStyle = pg
  x.lineWidth = 3 + w.energy * 4
  line(x, Q.x, Q.y, P.x, P.y)

  for (let s = 0; s < 2; s++)
    for (let i = 0; i < 26; i++) {
      const u = (i / 26 + t * 0.22) % 1
      const h = FLOOR_Y + u * 230
      const an = h * 0.055 + s * Math.PI + t * 1.4
      const rad = 15 + u * 9
      projectTo(P, w.cam, Math.cos(an) * rad, h, Math.sin(an) * rad)
      x.fillStyle = shade(s ? RGB.helixB : RGB.helixA, (1 - u) * 0.85)
      x.fillRect(P.x - 0.9, P.y - 0.9, 1.8, 1.8)
    }

  for (const g of w.gyros) {
    const ax = g.ax + Math.sin(t * 0.3 + g.r) * 0.25
    const az = g.az + t * 0.1
    const cX = Math.cos(ax)
    const sX = Math.sin(ax)
    const cZ = Math.cos(az)
    const sZ = Math.sin(az)
    let fx = 0
    let fy = 0
    for (let i = 0; i <= 64; i++) {
      const a = (i / 64) * TAU + t * g.sp
      const gx = Math.cos(a) * g.r
      const gz = Math.sin(a) * g.r
      const y1 = -gz * sX
      projectTo(P, w.cam, gx * cZ - y1 * sZ, gx * sZ + y1 * cZ + CORE_Y, gz * cX)
      if (i) {
        const n = near(P, 140)
        x.strokeStyle = shade(RGB.gyro, S * (0.4 + n * 1.8))
        x.lineWidth = 1 + n * 1.2
        line(x, Q.x, Q.y, P.x, P.y)
      } else {
        fx = P.x
        fy = P.y
      }
      Q.x = P.x
      Q.y = P.y
    }
    x.fillStyle = WHITE
    x.beginPath()
    x.arc(fx, fy, 2.4, 0, TAU)
    x.fill()
  }
}

/** 달 — 에이전트 둘레를 빠르게(혼자면 핵 둘레) */
function moons(x: CanvasRenderingContext2D, w: World): void {
  for (const [id, list] of w.moons) {
    const wp = w.wpos.get(id)!
    const z = w.pos.get(id)!.z
    x.fillStyle = hexA(colorOf(w, id), 0.5 + z * 0.5)
    for (const m of list) {
      const an = m.ph + w.t * m.w
      projectTo(P, w.cam, wp[0] + Math.cos(an) * m.r, wp[1] + Math.sin(an) * m.r * m.tilt, wp[2] + Math.sin(an) * m.r)
      x.beginPath()
      x.arc(P.x, P.y, 2.4 * P.f, 0, TAU)
      x.fill()
    }
  }
}

/** 서브에이전트 위성 — 핵 둘레를 돌며 부모 카드와 점선으로 이어진다(이름은 또렷한 층) */
function satellites(x: CanvasRenderingContext2D, w: World): void {
  x.lineWidth = 1
  for (const s of w.sats) {
    satPoint(w, s, P)
    const q = w.pos.get(s.parent)!
    const col = colorOf(w, s.parent)
    x.strokeStyle = hexA(col, S * 0.9)
    x.setLineDash(DASH_SAT)
    x.lineDashOffset = -w.t * 30
    line(x, P.x, P.y, q.x, q.y)
    x.setLineDash(NO_DASH)
    x.fillStyle = hexA(col, 0.95)
    x.beginPath()
    x.arc(P.x, P.y, 3.2 * P.f, 0, TAU)
    x.fill()
  }
}

/** 데이터 조각 — 도구를 쓴 에이전트에서 궤도를 따라 감기며 핵으로 빨려 든다 */
function shards(x: CanvasRenderingContext2D, w: World): void {
  const turn = orbitTurn(w)
  for (const s of w.shards) {
    const o = w.orbitById.get(s.id)
    if (!o) continue
    const k = Math.min(1, (w.t - s.t0) / s.T)
    const e = k * k * (3 - 2 * k)
    const v = orbitPoint(w, o, turn + e * 2.6)
    const sc = 1 - e
    projectTo(P, w.cam, v[0] * sc, v[1] * sc + CORE_Y * e + Math.sin(Math.PI * e) * 30, v[2] * sc)
    x.fillStyle = hexA(s.color, 0.95)
    x.beginPath()
    x.arc(P.x, P.y, 1.9, 0, TAU)
    x.fill()
    x.fillStyle = SHARD_CORE
    x.fillRect(P.x - 0.6, P.y - 0.6, 1.2, 1.2)
  }
}

/** 불꽃 — 넘김을 받은 자리에서 튀어 바닥으로 떨어진다 */
function sparks(x: CanvasRenderingContext2D, w: World): void {
  for (const s of w.sparks) {
    const k = (w.t - s.t0) / LIFE.spark
    projectTo(P, w.cam, s.x, Math.max(FLOOR_Y, s.y), s.z)
    x.fillStyle = hexA(s.color, 1 - k)
    x.fillRect(P.x - 0.9, P.y - 0.9, 1.8, 1.8)
  }
}
