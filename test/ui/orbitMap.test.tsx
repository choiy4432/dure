import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { render, act, cleanup } from '@testing-library/react'
import { OrbitMap } from '../../src/renderer/power/orbit/OrbitMap'
import { intake, stepWorld, syncBoost } from '../../src/renderer/power/orbit/step'
import { createWorld, resizeWorld, satelliteNames, type World } from '../../src/renderer/power/orbit/world'
import { drawOverlay } from '../../src/renderer/power/orbit/overlay'
import { drawScene } from '../../src/renderer/power/orbit/scene'
import { fakeAgents } from '../../src/renderer/power/fakeWorld'
import { mulberry32, type ScreenEvent } from '../../src/renderer/power/events'

// 관계도(궤도++) — 캔버스 2장 · 노드 카드 · rAF · 동기화 규칙. jsdom 엔 캔버스가 없어 그리는 쪽은 기록하는 가짜 컨텍스트로 본다

type Call = { fn: string; args: unknown[] }
function fakeCtx(calls: Call[]): CanvasRenderingContext2D {
  const grad = { addColorStop() {} }
  const props: Record<string | symbol, unknown> = {}
  return new Proxy(props, {
    get(t, k) {
      if (k in t) return t[k]
      if (k === 'measureText') return (s: string) => ({ width: s.length * 7 })
      if (k === 'createRadialGradient' || k === 'createLinearGradient') return () => grad
      return (...args: unknown[]) => {
        calls.push({ fn: String(k), args })
      }
    },
    set(t, k, v) {
      t[k] = v
      return true
    },
  }) as unknown as CanvasRenderingContext2D
}

const realGetContext = HTMLCanvasElement.prototype.getContext
const realRaf = window.requestAnimationFrame
const realCaf = window.cancelAnimationFrame
let calls: Call[]
let frames: Map<number, FrameRequestCallback>
let cancelled: number[]
let nextId: number

function stubSize(w: number, h: number) {
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => w })
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get: () => h })
}

beforeEach(() => {
  calls = []
  frames = new Map()
  cancelled = []
  nextId = 0
  HTMLCanvasElement.prototype.getContext = function () {
    return fakeCtx(calls)
  } as unknown as typeof HTMLCanvasElement.prototype.getContext
  window.requestAnimationFrame = (cb: FrameRequestCallback) => {
    const id = ++nextId
    frames.set(id, cb)
    return id
  }
  window.cancelAnimationFrame = (id: number) => {
    cancelled.push(id)
    frames.delete(id)
  }
  stubSize(748, 580)
})
afterEach(() => {
  cleanup()
  HTMLCanvasElement.prototype.getContext = realGetContext
  window.requestAnimationFrame = realRaf
  window.cancelAnimationFrame = realCaf
  delete (HTMLElement.prototype as unknown as Record<string, unknown>).offsetWidth
  delete (HTMLElement.prototype as unknown as Record<string, unknown>).offsetHeight
})

function feed() {
  const subs = new Set<(ev: ScreenEvent) => void>()
  return {
    subscribe: (fn: (ev: ScreenEvent) => void) => {
      subs.add(fn)
      return () => {
        subs.delete(fn)
      }
    },
    emit: (ev: ScreenEvent) =>
      act(() => {
        for (const f of subs) f(ev)
      }),
  }
}

/** 기다리는 rAF 하나를 now 로 돌린다 */
function runFrame(now: number) {
  const first = [...frames][0]
  if (!first) throw new Error('기다리는 프레임이 없다')
  frames.delete(first[0])
  act(() => first[1](now))
}

const tool = (agentId: string, t: string, target: string): ScreenEvent => ({ kind: 'tool', agentId, tool: t, target, real: false, at: 0 })
const hand = (from: string, to: string, text: string): ScreenEvent => ({ kind: 'handoff', from, to, text, real: false, at: 0 })
const who = () => fakeAgents().map(a => ({ id: a.id, name: a.name, color: a.color }))
const world = (calm = false) => createWorld({ agents: who(), W: 748, H: 580, calm, rand: mulberry32(3), satellites: satelliteNames(0) })
/** 60fps 로 sec 초만큼 돌린다 */
function run(w: World, sec: number, from = 0): number {
  let now = from
  for (let i = 0; i < Math.round(sec * 60); i++) stepWorld(w, (now += 1000 / 60))
  return now
}
const texts = () => calls.filter(c => c.fn === 'fillText').map(c => String(c.args[0]))

describe('관계도 화면', () => {
  it('캔버스_2장과_에이전트_수만큼_노드_카드', () => {
    const f = feed()
    const { container } = render(<OrbitMap agents={fakeAgents()} awaiting={new Set()} subagents={0} subscribe={f.subscribe} />)
    expect(container.querySelectorAll('canvas')).toHaveLength(2)
    expect(container.querySelectorAll('[data-node]')).toHaveLength(5)
    expect(container.querySelector('[data-node="lead"]')).toHaveTextContent('총괄')
  })

  it('승인_기다림_카드만_호박색이고_다른_카드는_최근_도구_줄', async () => {
    const f = feed()
    const { container } = render(<OrbitMap agents={fakeAgents()} awaiting={new Set(['impl'])} subagents={0} subscribe={f.subscribe} />)
    const node = (id: string) => container.querySelector(`[data-node="${id}"]`) as HTMLElement
    expect(node('impl')).toHaveAttribute('data-warn')
    expect(node('impl')).toHaveTextContent('승인 기다림')
    expect(node('test')).not.toHaveAttribute('data-warn')
    expect(node('test')).not.toHaveTextContent('승인 기다림')
    await f.emit(tool('test', 'Read', 'src/order/checkout.ts'))
    expect(node('test')).toHaveTextContent('Read · checkout.ts')
    // 기다리는 쪽은 도구 사건이 와도 '승인 기다림' 그대로(지어내지 않는다 — awaiting 에서만)
    await f.emit(tool('impl', 'Edit', 'src/a.ts'))
    expect(node('impl')).toHaveTextContent('승인 기다림')
  })

  it('여덟_명부터는_궤도_카드를_작은_판으로_핵과_기다림은_표시', () => {
    const f = feed()
    const many = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `a${i}`, name: `이름${i}`, role: '역할', color: '#60A5FA', real: true }))
    const seven = render(<OrbitMap agents={many(7)} awaiting={new Set()} subagents={0} subscribe={f.subscribe} />)
    expect(seven.container.querySelector('.pw-mapov')).not.toHaveAttribute('data-crowd')
    expect(seven.container.querySelector('[data-node="a0"]')).toHaveAttribute('data-core')
    seven.unmount()
    const { container } = render(<OrbitMap agents={many(8)} awaiting={new Set(['a5'])} subagents={0} subscribe={f.subscribe} />)
    expect(container.querySelector('.pw-mapov')).toHaveAttribute('data-crowd')
    expect(container.querySelectorAll('[data-core]')).toHaveLength(1)
    expect(container.querySelector('[data-node="a0"]')).toHaveAttribute('data-core')
    // 기다리는 카드는 작은 판에서도 '승인 기다림' 줄을 남긴다(CSS 가 data-warn 으로 가른다)
    expect(container.querySelector('[data-node="a5"]')).toHaveAttribute('data-warn')
    expect(container.querySelector('[data-node="a5"]')).toHaveTextContent('승인 기다림')
  })

  it('언마운트하면_rAF_가_취소된다', () => {
    const f = feed()
    const view = render(<OrbitMap agents={fakeAgents()} awaiting={new Set()} subagents={0} subscribe={f.subscribe} />)
    expect(frames.size).toBe(1)
    runFrame(16)
    runFrame(32)
    const pending = [...frames.keys()]
    expect(pending).toHaveLength(1)
    view.unmount()
    expect(cancelled).toContain(pending[0])
    expect(frames.size).toBe(0)
  })

  it('창이_안_보이면_rAF_를_쉬고_다시_보이면_잇는다', () => {
    const f = feed()
    let state: DocumentVisibilityState = 'visible'
    const desc = Object.getOwnPropertyDescriptor(Document.prototype, 'visibilityState')
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state })
    try {
      render(<OrbitMap agents={fakeAgents()} awaiting={new Set()} subagents={0} subscribe={f.subscribe} />)
      runFrame(16)
      state = 'hidden'
      runFrame(32)
      expect(frames.size).toBe(0)
      state = 'visible'
      act(() => {
        document.dispatchEvent(new Event('visibilitychange'))
      })
      expect(frames.size).toBe(1)
    } finally {
      delete (document as unknown as Record<string, unknown>).visibilityState
      if (desc) Object.defineProperty(Document.prototype, 'visibilityState', desc)
    }
  })

  it('캔버스를_못_얻으면_그리지_않고_던지지_않는다', async () => {
    HTMLCanvasElement.prototype.getContext = (() => null) as unknown as typeof HTMLCanvasElement.prototype.getContext
    const f = feed()
    const { container } = render(<OrbitMap agents={fakeAgents()} awaiting={new Set()} subagents={0} subscribe={f.subscribe} />)
    expect(frames.size).toBe(0)
    await f.emit(tool('doc', 'Read', 'docs/api/orders.md'))
    expect(container.querySelector('[data-node="doc"]')).toHaveTextContent('Read · orders.md')
  })

  it('캔버스_해상도는_dpr_곱하기_판_배율_최대_2.5', async () => {
    const f = feed()
    const dpr = Object.getOwnPropertyDescriptor(window, 'devicePixelRatio')
    Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 1.25 })
    const stage = document.createElement('div')
    stage.className = 'pw-stage'
    stage.getBoundingClientRect = () => ({ width: 1600 * 1.2, height: 900 * 1.2 }) as DOMRect
    document.body.appendChild(stage)
    try {
      const { container } = render(<OrbitMap agents={fakeAgents()} awaiting={new Set()} subagents={0} subscribe={f.subscribe} />, { container: stage })
      const cv = container.querySelector('canvas') as HTMLCanvasElement
      expect(cv.width).toBe(Math.round(748 * 1.5))
      expect(cv.height).toBe(Math.round(580 * 1.5))
      // 판이 새 scale 을 달면(창 크기 바뀜) 다시 잰다 — 상한 2.5
      Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 2 })
      stage.getBoundingClientRect = () => ({ width: 1600 * 1.5, height: 900 * 1.5 }) as DOMRect
      await act(async () => {
        stage.style.transform = 'scale(1.5)'
      })
      expect(cv.width).toBe(Math.round(748 * 2.5))
      cleanup()
      stage.getBoundingClientRect = () => ({ width: 1600 * 1.2, height: 900 * 1.2 }) as DOMRect
      const again = render(<OrbitMap agents={fakeAgents()} awaiting={new Set()} subagents={0} subscribe={f.subscribe} />, { container: stage })
      expect((again.container.querySelector('canvas') as HTMLCanvasElement).width).toBe(Math.round(748 * 2.4))
    } finally {
      stage.remove()
      if (dpr) Object.defineProperty(window, 'devicePixelRatio', dpr)
      else delete (window as unknown as Record<string, unknown>).devicePixelRatio
    }
  })
})

describe('관계도 장면', () => {
  it('차분하면_흔들림_0_급회전_배수_없음', () => {
    const calm = syncBoost(true, 0.5)
    expect(calm.shake).toBe(0)
    expect(calm.yaw).toBe(0)
    expect(calm.zoom).toBe(0)
    expect(calm.streak).toBe(false)
    const loud = syncBoost(false, 0.5)
    expect(loud.shake).toBeCloseTo(4)
    expect(loud.yaw).toBeCloseTo(1.7)
    expect(loud.streak).toBe(true)
    // 동기화 밖이면 아무것도 얹지 않는다
    expect(syncBoost(false, 1.2).yaw).toBe(0)
    expect(syncBoost(false, -0.1).shake).toBe(0)
  })

  it('차분_모드의_동기화는_알림과_은은한_빛만', () => {
    const w = world(true)
    let now = run(w, 0.5)
    w.sync.next = w.t // 다음 프레임에 동기화
    const yaw0 = w.cam.yaw
    let burstAdded = -1
    let maxShift = 0
    for (let i = 0; i < 60; i++) {
      const before = w.comets.length
      stepWorld(w, (now += 1000 / 60))
      if (i === 0) burstAdded = w.comets.length - before
      maxShift = Math.max(maxShift, Math.abs(w.cam.cx - w.cx0), Math.abs(w.cam.cy - w.cy0))
    }
    expect(w.syncing).toBe(true)
    expect(w.toast).not.toBeNull()
    expect(maxShift).toBe(0)
    expect(w.cam.yaw - yaw0).toBeCloseTo(60 * (1 / 60) * 0.05, 5) // 급회전 없이 평소 속도
    expect(w.hits).toEqual([])
    // 동기화 폭죽 혜성(14개)이 없다 — 동기화가 시작된 바로 그 프레임에 더해진 혜성이 0
    expect(burstAdded).toBe(0)

    const loud = world(false)
    now = run(loud, 0.5)
    loud.sync.next = loud.t
    const lyaw = loud.cam.yaw
    const loud0 = loud.comets.length
    stepWorld(loud, (now += 1000 / 60))
    expect(loud.comets.length - loud0).toBeGreaterThanOrEqual(14) // 일반 모드는 첫 프레임에 폭죽 혜성 14개
    for (let i = 1; i < 60; i++) stepWorld(loud, (now += 1000 / 60))
    expect(loud.cam.yaw - lyaw).toBeGreaterThan(0.5)
    expect(loud.hits.length).toBeGreaterThanOrEqual(5)
  })

  it('칸_크기가_0이면_자리_잡기를_건너뛰어_NaN이_없다', () => {
    const w = world(false)
    run(w, 0.3)
    resizeWorld(w, 0, 0)
    stepWorld(w, 1000)
    for (const p of w.pos.values()) {
      expect(Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.s) && Number.isFinite(p.o)).toBe(true)
      expect(`translate(${p.x}px, ${p.y}px) scale(${p.s})`).not.toContain('NaN')
    }
  })

  it('동기화_중엔_말풍선을_그리지_않는다', () => {
    const w = world(false)
    w.sync.next = 1e9
    let now = run(w, 0.2)
    intake(w, hand('impl', 'test', '테스트 다시 돌려 주세요'))
    now = run(w, 2, now)
    expect(w.bubbles).toHaveLength(1)
    const ctx = fakeCtx(calls)
    drawOverlay(ctx, w, null, 2)
    expect(texts()).toContain('테스트 다시 돌려 주세요')
    expect(texts()).toContain('구현 → ')

    calls.length = 0
    w.sync.next = w.t
    stepWorld(w, now + 16)
    expect(w.syncing).toBe(true)
    expect(w.bubbles).toHaveLength(1)
    drawOverlay(ctx, w, null, 2)
    expect(texts()).not.toContain('테스트 다시 돌려 주세요')
    expect(texts().some(s => s.startsWith('전체 동기화'))).toBe(true)
  })

  it('오른쪽_위_궤도_값은_여섯_줄까지_넘치면_외_N', () => {
    const agents = Array.from({ length: 12 }, (_, i) => ({ id: `a${i}`, name: `이름${i}`, color: '#60A5FA' }))
    const w = createWorld({ agents, W: 748, H: 580, calm: false, rand: mulberry32(5), satellites: satelliteNames(0) })
    run(w, 0.2)
    drawOverlay(fakeCtx(calls), w, null, 2)
    expect(texts().filter(s => s.startsWith('θ '))).toHaveLength(6)
    expect(texts()).toContain('외 5')
  })

  it('넘김이_닿으면_물결_불꽃_토큰_말풍선_카드_번쩍', () => {
    const w = world(false)
    w.sync.next = 1e9
    let now = run(w, 0.2)
    intake(w, hand('rev', 'doc', '리뷰 의견 4개 보냈어요'))
    now = run(w, 2, now)
    expect(w.ripples.some(r => r.id === 'doc')).toBe(true)
    expect(w.floats.some(f => f.id === 'doc' && /^\+\d\.\dk 토큰$/.test(f.text))).toBe(true)
    expect(w.bubbles[0]).toMatchObject({ id: 'doc', from: 'rev', text: '리뷰 의견 4개 보냈어요' })
    expect(w.sparks.length).toBeGreaterThan(0)
    expect(w.hits).toContain('doc')
  })

  it('핵의_도구_사건은_잎만_궤도_에이전트는_조각도', () => {
    const w = world(false)
    w.sync.next = 1e9
    let now = run(w, 0.2)
    intake(w, tool('lead', 'Read', 'src/order/checkout.ts'))
    now = run(w, 0.3, now)
    expect(w.leaves).toHaveLength(1)
    expect(w.leaves[0].label).toBe('Read checkout.ts')
    expect(w.shards).toHaveLength(0)
    intake(w, tool('impl', 'Edit', 'src/coupon/apply.ts'))
    run(w, 0.3, now)
    expect(w.leaves).toHaveLength(2)
    expect(w.shards).toHaveLength(1)
  })

  it('서브에이전트가_없으면_가짜_위성_넷', () => {
    expect(satelliteNames(0)).toEqual(['탐색 1', '탐색 2', '점검', '조사'])
    expect(satelliteNames(2)).toEqual(['서브 1', '서브 2'])
    const w = world(false)
    expect(w.sats.map(s => s.name)).toEqual(['탐색 1', '탐색 2', '점검', '조사'])
    expect(new Set(w.sats.map(s => s.parent))).toEqual(new Set(['impl', 'test', 'rev', 'doc']))
    const solo = createWorld({ agents: who().slice(0, 1), W: 748, H: 580, calm: false, rand: mulberry32(1), satellites: satelliteNames(0) })
    expect(solo.orbits).toEqual([])
    expect(new Set(solo.sats.map(s => s.parent))).toEqual(new Set(['lead']))
  })

  it('오래_멈췄다_와도_시간이_튀지_않는다', () => {
    const w = world(false)
    run(w, 0.1)
    const t0 = w.t
    stepWorld(w, 60_000)
    expect(w.t - t0).toBeCloseTo(0.05)
  })

  it('점_개수는_시안_값을_넘지_않고_한_프레임이_그려진다', () => {
    const w = world(false)
    run(w, 1)
    expect(w.gal.r.length).toBeLessThanOrEqual(1300)
    expect(w.disk.r.length).toBeLessThanOrEqual(240)
    expect(w.stars.length).toBeLessThanOrEqual(90)
    const ctx = fakeCtx(calls)
    drawScene(ctx, w, 2)
    expect(calls.filter(c => c.fn === 'fillRect').length).toBeGreaterThan(1300)
    calls.length = 0
    drawOverlay(ctx, w, null, 2)
    expect(texts()).toContain('궤도 동기화')
    expect(texts()).toContain('활동')
  })
})
