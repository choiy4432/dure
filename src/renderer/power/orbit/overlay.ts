// 또렷한 층 — 매 프레임 지우고 다시 그린다(시안 orbit3.frame 끝부분 · hud 와 공통 drawLeaves · drawComets · drawRipples · drawFloats · drawBubbles).
// 번짐(잔상 층을 흐리게 한 번 더 얹기) · 눈금 숫자 · 위성 이름 · 잎 · 혜성 · 물결 · 토큰 · 말풍선 · 계기판 · 동기화 알림.
// 상태는 읽기만 한다.
import { near, projectTo, type Proj } from './camera'
import {
  BUBBLE_BG,
  BUBBLE_TEXT,
  HUD_BAR_HOT,
  HUD_BAR_OFF,
  HUD_BAR_ON,
  HUD_FRAME,
  HUD_KEY,
  HUD_VALUE,
  RGB,
  TOAST_BG,
  TOAST_LINE,
  TOAST_TEXT,
  WHITE,
  hexA,
  rgbOf,
  shade,
} from './palette'
import { LIFE, colorOf, orbitTurn, satPoint, trunc, type World } from './world'

/**
 * 번짐 — 흐림 반지름 · 알파(동기화 중엔 boost.bloom 만큼 더).
 * blur 는 시안의 2배 캔버스에서의 장치 픽셀 값이다 — 캔버스 filter 의 흐림은 setTransform 배율을 따르지 않고 장치 픽셀로 먹어서,
 * 해상도 k 에선 7·k/2 로 줄여야 시안과 같은 번짐(화면 기준 3.5px)이 된다.
 */
export const BLOOM = { blur: 7, alpha: 0.55, atRes: 2 } as const
/** 오른쪽 위 궤도 값은 이만큼까지(넘치면 '외 N') */
const HUD_ORBIT_ROWS = 8
const TAU = Math.PI * 2
const P: Proj = { x: 0, y: 0, f: 0, d: 0 }

const deg = (r: number) => Math.round((((r * 180) / Math.PI) % 360 + 360) % 360)
const nameOf = (w: World, id: string) => w.who.get(id)?.name ?? ''

/** trail 이 없으면(첫 프레임·시험) 번짐을 건너뛴다 */
export function drawOverlay(ctx: CanvasRenderingContext2D, w: World, trail: CanvasImageSource | null, k: number): void {
  const { W, H } = w
  if (!W || !H) return
  ctx.setTransform(k, 0, 0, k, 0, 0)
  ctx.clearRect(0, 0, W, H)
  if (trail) bloom(ctx, w, trail, k)
  tickLabels(ctx, w)
  satLabels(ctx, w)
  leaves(ctx, w)
  comets(ctx, w)
  ripples(ctx, w)
  floats(ctx, w)
  // 동기화 중엔 말풍선을 숨긴다 — 뒤쪽 카드와 겹쳐 읽히지 않는다
  if (!w.syncing) bubbles(ctx, w)
  hud(ctx, w)
  toast(ctx, w)
}

function bloom(ctx: CanvasRenderingContext2D, w: World, trail: CanvasImageSource, k: number): void {
  ctx.save()
  ctx.globalCompositeOperation = 'lighter'
  ctx.globalAlpha = BLOOM.alpha + w.boost.bloom
  ctx.filter = `blur(${((BLOOM.blur * k) / BLOOM.atRes).toFixed(2)}px)`
  ctx.drawImage(trail, 0, 0, w.W, w.H)
  ctx.restore()
}

function tickLabels(ctx: CanvasRenderingContext2D, w: World): void {
  const r = w.RA * 1.16 + 24
  ctx.font = `10px ${w.fonts.mono}`
  ctx.textAlign = 'center'
  for (let i = 0; i < 72; i += 6) {
    const a = (i / 72) * TAU
    projectTo(P, w.cam, Math.cos(a) * r, 0, Math.sin(a) * r)
    ctx.fillStyle = shade(RGB.tick, 0.15 + near(P, w.RA) * 0.6)
    ctx.fillText(String(i * 5).padStart(3, '0'), P.x, P.y + 3)
  }
  ctx.textAlign = 'start'
}

function satLabels(ctx: CanvasRenderingContext2D, w: World): void {
  ctx.font = `11px ${w.fonts.mono}`
  for (const s of w.sats) {
    satPoint(w, s, P)
    ctx.fillStyle = shade(RGB.label, 0.35 + near(P, w.RA) * 0.6)
    ctx.fillText(s.name, P.x + 8, P.y + 4)
  }
}

/** 잎 — 도구를 쓴 노드에서 '도구 파일' 이름표가 뻗어 나간다 */
function leaves(ctx: CanvasRenderingContext2D, w: World): void {
  ctx.font = `11px ${w.fonts.mono}`
  ctx.lineWidth = 1
  for (const l of w.leaves) {
    const k = (w.t - l.t0) / LIFE.leaf
    const p = w.pos.get(l.id)!
    const e = 1 - Math.pow(1 - k, 3)
    const ca = Math.cos(l.ang)
    const sa = Math.sin(l.ang)
    const sx = p.x + ca * 82
    const sy = p.y + sa * 30
    const lx = sx + ca * (24 + e * 74)
    const ly = sy + sa * (18 + e * 52)
    ctx.strokeStyle = hexA(l.color, (1 - k) * 0.5)
    ctx.beginPath()
    ctx.moveTo(sx, sy)
    ctx.lineTo(lx, ly)
    ctx.stroke()
    ctx.fillStyle = hexA(l.color, 1 - k)
    ctx.beginPath()
    ctx.arc(lx, ly, 2.8, 0, TAU)
    ctx.fill()
    ctx.fillStyle = shade(RGB.label, (1 - k) * 0.9)
    if (lx > w.W - 150) {
      ctx.textAlign = 'right'
      ctx.fillText(l.label, lx - 7, ly + 4)
      ctx.textAlign = 'start'
    } else ctx.fillText(l.label, lx + 7, ly + 4)
  }
}

/** 혜성 — 굵어지는 꼬리 + 빛나는 머리 */
function comets(ctx: CanvasRenderingContext2D, w: World): void {
  ctx.save()
  ctx.globalCompositeOperation = 'lighter'
  for (const c of w.comets) {
    const tr = c.trail
    const n = tr.length
    if (!n) continue
    const rgb = rgbOf(c.color)
    for (let i = 1; i < n; i++) {
      const a = i / n
      ctx.strokeStyle = shade(rgb, a * (c.small ? 0.5 : 0.95))
      ctx.lineWidth = (c.small ? 1.4 : 3.4) * a
      ctx.beginPath()
      ctx.moveTo(tr[i - 1].x, tr[i - 1].y)
      ctx.lineTo(tr[i].x, tr[i].y)
      ctx.stroke()
    }
    const h = tr[n - 1]
    ctx.shadowColor = c.color
    ctx.shadowBlur = c.small ? 6 : 18
    ctx.fillStyle = c.small ? shade(rgb, 0.8) : WHITE
    ctx.beginPath()
    ctx.arc(h.x, h.y, c.small ? 1.8 : 3.6, 0, TAU)
    ctx.fill()
    ctx.shadowBlur = 0
  }
  ctx.restore()
}

/** 물결 — 받는 노드에서 바닥과 나란히 세 겹 */
function ripples(ctx: CanvasRenderingContext2D, w: World): void {
  ctx.save()
  ctx.globalCompositeOperation = 'lighter'
  const ratio = Math.sin(w.cam.e)
  for (const r of w.ripples) {
    const k = (w.t - r.t0) / LIFE.ripple
    const p = w.pos.get(r.id)!
    for (let j = 0; j < 3; j++) {
      const kk = k - j * 0.16
      if (kk <= 0) continue
      ctx.strokeStyle = hexA(r.color, (1 - kk) * 0.75)
      ctx.lineWidth = 2 - j * 0.5
      const rx = (70 + kk * 120) * p.s
      ctx.beginPath()
      ctx.ellipse(p.x, p.y, rx, rx * ratio, 0, 0, TAU)
      ctx.stroke()
    }
  }
  ctx.restore()
}

/** '+N.Nk 토큰' — 받는 노드 위로 떠오르며 사라진다 */
function floats(ctx: CanvasRenderingContext2D, w: World): void {
  ctx.font = `600 12px ${w.fonts.mono}`
  ctx.textAlign = 'center'
  for (const f of w.floats) {
    const k = (w.t - f.t0) / LIFE.float
    const p = w.pos.get(f.id)!
    ctx.fillStyle = hexA(f.color, 1 - k)
    ctx.fillText(f.text, p.x + f.dx, p.y - 40 - k * 36)
  }
  ctx.textAlign = 'start'
}

/** 말풍선 '보낸 이 → 글' — 받는 노드 오른쪽 위(칸을 넘으면 왼쪽) */
function bubbles(ctx: CanvasRenderingContext2D, w: World): void {
  ctx.font = `12.5px ${w.fonts.ui}`
  ctx.lineWidth = 1
  for (const b of w.bubbles) {
    const k = (w.t - b.t0) / LIFE.bubble
    const a = k < 0.08 ? k / 0.08 : k > 0.8 ? (1 - k) / 0.2 : 1
    const p = w.pos.get(b.id)!
    const col = colorOf(w, b.from)
    const head = `${nameOf(w, b.from)} → `
    const hw = ctx.measureText(head).width
    const bw = hw + ctx.measureText(b.text).width + 22
    let x = p.x + 64
    let y = p.y - 58 - (k < 0.08 ? (0.08 - k) * 120 : 0)
    if (x + bw > w.W - 6) x = Math.max(6, p.x - 64 - bw)
    y = Math.max(4, Math.min(w.H - 30, y))
    ctx.globalAlpha = Math.max(0, a)
    ctx.fillStyle = BUBBLE_BG
    ctx.strokeStyle = hexA(col, 0.8)
    ctx.beginPath()
    ctx.roundRect(x, y, bw, 26, 8)
    ctx.fill()
    ctx.stroke()
    ctx.fillStyle = col
    ctx.fillText(head, x + 11, y + 17.5)
    ctx.fillStyle = BUBBLE_TEXT
    ctx.fillText(b.text, x + 11 + hw, y + 17.5)
    ctx.globalAlpha = 1
  }
}

/** 계기판 — 귀퉁이 틀 · 왼쪽 위 값 · 오른쪽 위 궤도 값 · 아래 활동 파형 · 훑는 선 */
function hud(ctx: CanvasRenderingContext2D, w: World): void {
  const { W, H, t } = w
  const b = 16
  const m = 6
  ctx.strokeStyle = HUD_FRAME
  ctx.lineWidth = 1.5
  for (const [cx, cy, sx, sy] of [
    [m, m, 1, 1],
    [W - m, m, -1, 1],
    [m, H - m, 1, -1],
    [W - m, H - m, -1, -1],
  ]) {
    ctx.beginPath()
    ctx.moveTo(cx, cy + sy * b)
    ctx.lineTo(cx, cy)
    ctx.lineTo(cx + sx * b, cy)
    ctx.stroke()
  }

  ctx.font = `11px ${w.fonts.mono}`
  const rows: [string, string][] = [
    ['궤도 동기화', (99 + Math.sin(t * 0.7) * 0.6).toFixed(1) + '%'],
    ['핵 출력', Math.round(w.energy * 100) + '%'],
    ['오가는 데이터', String(w.comets.length + w.shards.length)],
    ['카메라', `${deg(w.cam.e)}° · ${deg(w.cam.yaw)}°`],
  ]
  rows.forEach(([k, v], i) => {
    ctx.fillStyle = HUD_KEY
    ctx.fillText(k, 16, 24 + i * 16)
    ctx.fillStyle = HUD_VALUE
    ctx.fillText(v, 108, 24 + i * 16)
  })
  for (let i = 0; i < 20; i++) {
    ctx.fillStyle = i / 20 < w.energy ? (i >= 17 ? HUD_BAR_HOT : HUD_BAR_ON) : HUD_BAR_OFF
    ctx.fillRect(16 + i * 7, 24 + 4 * 16 - 7, 5, 8)
  }

  ctx.textAlign = 'right'
  const turn = orbitTurn(w)
  w.orbits.slice(0, HUD_ORBIT_ROWS).forEach((o, i) => {
    const y = 24 + i * 16
    ctx.fillStyle = HUD_KEY
    ctx.fillText(`θ ${String(deg(o.a + turn)).padStart(3, '0')}°  i ${(o.inc * 57.3).toFixed(0).padStart(3)}°`, W - 16, y)
    ctx.fillStyle = colorOf(w, o.id)
    ctx.fillText(trunc(nameOf(w, o.id), 8), W - 132, y)
  })
  if (w.orbits.length > HUD_ORBIT_ROWS) {
    ctx.fillStyle = HUD_KEY
    ctx.fillText(`외 ${w.orbits.length - HUD_ORBIT_ROWS}`, W - 16, 24 + HUD_ORBIT_ROWS * 16)
  }
  ctx.textAlign = 'start'

  const n = w.wave.length
  const x0 = (W - n * 3) / 2
  const yb = H - 26
  for (let i = 0; i < n; i++) {
    const h = 2 + w.wave[i] * 22
    ctx.fillStyle = shade(RGB.wave, 0.25 + (i / n) * 0.6)
    ctx.fillRect(x0 + i * 3, yb - h / 2, 2, h)
  }
  ctx.fillStyle = HUD_KEY
  ctx.textAlign = 'right'
  ctx.fillText('활동', x0 - 10, yb + 4)
  ctx.textAlign = 'start'

  const sy = ((t * 70) % (H + 40)) - 20
  const g = ctx.createLinearGradient(0, sy - 22, 0, sy)
  g.addColorStop(0, shade(RGB.scan, 0))
  g.addColorStop(1, shade(RGB.scan, 0.08))
  ctx.fillStyle = g
  ctx.fillRect(0, sy - 22, W, 22)
}

/** 동기화 알림 — 위 가운데 알약 */
function toast(ctx: CanvasRenderingContext2D, w: World): void {
  const s = w.toast
  if (!s) return
  const k = (w.t - s.t0) / LIFE.toast
  if (k < 0 || k >= 1) return
  const a = k < 0.1 ? k / 0.1 : k > 0.75 ? (1 - k) / 0.25 : 1
  ctx.font = `600 13px ${w.fonts.ui}`
  const tw = ctx.measureText(s.text).width + 36
  const tx = (w.W - tw) / 2
  const ty = 14
  ctx.globalAlpha = a
  ctx.fillStyle = TOAST_BG
  ctx.strokeStyle = TOAST_LINE
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.roundRect(tx, ty, tw, 28, 14)
  ctx.fill()
  ctx.stroke()
  ctx.fillStyle = TOAST_TEXT
  ctx.fillText(s.text, tx + 18, ty + 18.5)
  ctx.globalAlpha = 1
}
