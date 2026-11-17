import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { render, act, cleanup } from '@testing-library/react'
import fs from 'node:fs'
import path from 'node:path'
import { OrbitMap } from '../../src/renderer/power/orbit/OrbitMap'
import { boostOf, changeRoom, intake, stepWorld, syncBoost } from '../../src/renderer/power/orbit/step'
import { createWorld, inFlight, resizeWorld, setStates, type World } from '../../src/renderer/power/orbit/world'
import { drawOverlay } from '../../src/renderer/power/orbit/overlay'
import { drawScene } from '../../src/renderer/power/orbit/scene'
import { jumpK } from '../../src/renderer/power/orbit/transition'
import { SHAKE_PX } from '../../src/renderer/power/orbit/camera'
import { mulberry32, type PowerAgent, type ScreenEvent } from '../../src/renderer/power/events'
import type { RoomChange } from '../../src/renderer/power/usePowerFeed'
import { allowMotion } from './motion'

// 관계도(궤도++) — 캔버스 2장 · 노드 카드 · rAF · 동기화 규칙. jsdom 엔 캔버스가 없어 그리는 쪽은 기록하는 가짜 컨텍스트로 본다
// 혜성·조각·잎·위성은 진짜 사건과 진짜 서브에이전트에서만 — 떠도는 혜성·토큰 글·지어낸 위성·시간으로 터지는 동기화는 없다

/** fill — 그 부름 때의 fillStyle */
type Call = { fn: string; args: unknown[]; fill?: unknown }
function fakeCtx(calls: Call[]): CanvasRenderingContext2D {
  const grad = { addColorStop() {} }
  const props: Record<string | symbol, unknown> = {}
  return new Proxy(props, {
    get(t, k) {
      if (k in t) return t[k]
      if (k === 'measureText') return (s: string) => ({ width: s.length * 7 })
      if (k === 'createRadialGradient' || k === 'createLinearGradient') return () => grad
      return (...args: unknown[]) => {
        calls.push({ fn: String(k), args, fill: t.fillStyle })
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

const tool = (agentId: string, t: string, target: string): ScreenEvent => ({ kind: 'tool', agentId, tool: t, target, at: 0 })
const hand = (from: string, to: string, text: string): ScreenEvent => ({ kind: 'handoff', from, to, text, at: 0 })
const done = (agentId: string): ScreenEvent => ({ kind: 'done', agentId, at: 0 })
/** 시험용 방 다섯 명 */
const five = (): PowerAgent[] =>
  [['lead', '총괄'], ['impl', '구현'], ['test', '테스트'], ['rev', '검토'], ['doc', '문서']].map(([id, name]) => ({ id, name, role: '역할', color: '#60A5FA' }))
const who = () => five().map(a => ({ id: a.id, name: a.name, color: a.color }))
const world = (calm = false) => createWorld({ agents: who(), W: 748, H: 580, calm, rand: mulberry32(3) })
/** 모아 그리기(100ms)를 기다린다 */
const flush = () => act(() => { vi.advanceTimersByTime(150) })
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
    const { container } = render(<OrbitMap agents={five()} state={{}} subagents={[]} subscribe={f.subscribe} />)
    expect(container.querySelectorAll('canvas')).toHaveLength(2)
    expect(container.querySelectorAll('[data-node]')).toHaveLength(5)
    expect(container.querySelector('[data-node="lead"]')).toHaveTextContent('총괄')
  })

  it('승인_기다림_카드만_호박색이고_다른_카드는_마지막_진짜_도구_줄_없으면_진짜_상태', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const f = feed()
      const { container } = render(<OrbitMap agents={five()} state={{ impl: 'awaiting', rev: 'working' }} subagents={[]} subscribe={f.subscribe} />)
      const node = (id: string) => container.querySelector(`[data-node="${id}"]`) as HTMLElement
      expect(node('impl')).toHaveAttribute('data-warn')
      expect(node('impl')).toHaveTextContent('승인 기다림')
      expect(node('test')).not.toHaveAttribute('data-warn')
      expect(node('test')).not.toHaveTextContent('승인 기다림')
      expect(node('test').querySelector('i')).toHaveTextContent(/^쉬는 중$/)
      expect(node('rev').querySelector('i')).toHaveTextContent(/^작업 중$/)
      await f.emit(tool('test', 'Read', 'src/order/checkout.ts'))
      flush()
      expect(node('test')).toHaveTextContent('Read · checkout.ts')
      // 기다리는 쪽은 도구 사건이 와도 '승인 기다림' 그대로(상태는 스토어 것만)
      await f.emit(tool('impl', 'Edit', 'src/a.ts'))
      flush()
      expect(node('impl')).toHaveTextContent('승인 기다림')
    } finally {
      vi.useRealTimers()
    }
  })

  it('여덟_명부터는_궤도_카드를_작은_판으로_핵과_기다림은_표시', () => {
    const f = feed()
    const many = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `a${i}`, name: `이름${i}`, role: '역할', color: '#60A5FA' }))
    const seven = render(<OrbitMap agents={many(7)} state={{}} subagents={[]} subscribe={f.subscribe} />)
    expect(seven.container.querySelector('.pw-mapov')).not.toHaveAttribute('data-crowd')
    expect(seven.container.querySelector('[data-node="a0"]')).toHaveAttribute('data-core')
    seven.unmount()
    const { container } = render(<OrbitMap agents={many(8)} state={{ a5: 'awaiting' }} subagents={[]} subscribe={f.subscribe} />)
    expect(container.querySelector('.pw-mapov')).toHaveAttribute('data-crowd')
    expect(container.querySelectorAll('[data-core]')).toHaveLength(1)
    expect(container.querySelector('[data-node="a0"]')).toHaveAttribute('data-core')
    // 기다리는 카드는 작은 판에서도 '승인 기다림' 줄을 남긴다(CSS 가 data-warn 으로 가른다)
    expect(container.querySelector('[data-node="a5"]')).toHaveAttribute('data-warn')
    expect(container.querySelector('[data-node="a5"]')).toHaveTextContent('승인 기다림')
  })

  it('언마운트하면_rAF_가_취소된다', () => {
    const f = feed()
    const view = render(<OrbitMap agents={five()} state={{}} subagents={[]} subscribe={f.subscribe} />)
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
      render(<OrbitMap agents={five()} state={{}} subagents={[]} subscribe={f.subscribe} />)
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
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const { container } = render(<OrbitMap agents={five()} state={{}} subagents={[]} subscribe={f.subscribe} />)
      expect(frames.size).toBe(0)
      await f.emit(tool('doc', 'Read', 'docs/api/orders.md'))
      flush()
      expect(container.querySelector('[data-node="doc"]')).toHaveTextContent('Read · orders.md')
    } finally {
      vi.useRealTimers()
    }
  })

  it('캔버스_해상도는_dpr_최대_2.5_창이_바뀌면_다시_잰다(판을_늘리고_줄이지_않는다)', async () => {
    const f = feed()
    const dpr = Object.getOwnPropertyDescriptor(window, 'devicePixelRatio')
    Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 1.25 })
    try {
      const { container } = render(<OrbitMap agents={five()} state={{}} subagents={[]} subscribe={f.subscribe} />)
      const cv = container.querySelector('canvas') as HTMLCanvasElement
      expect(cv.width).toBe(Math.round(748 * 1.25))
      expect(cv.height).toBe(Math.round(580 * 1.25))
      Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 3 })
      await act(async () => {
        window.dispatchEvent(new Event('resize'))
      })
      expect(cv.width).toBe(Math.round(748 * 2.5))
    } finally {
      if (dpr) Object.defineProperty(window, 'devicePixelRatio', dpr)
      else delete (window as unknown as Record<string, unknown>).devicePixelRatio
    }
  })

  it('노드_카드는_단추_누르면_onPick(id)_고른_노드만_aria_pressed_캔버스는_누르기를_안_받는다', () => {
    const f = feed()
    const onPick = vi.fn()
    const { container, rerender } = render(<OrbitMap agents={five()} state={{}} subagents={[]} subscribe={f.subscribe} selected="test" onPick={onPick} />)
    const node = (id: string) => container.querySelector(`[data-node="${id}"]`) as HTMLElement
    expect(node('impl').tagName).toBe('BUTTON')
    expect(node('test')).toHaveAttribute('aria-pressed', 'true')
    expect(node('impl')).toHaveAttribute('aria-pressed', 'false')
    act(() => { node('impl').click() })
    expect(onPick).toHaveBeenCalledWith('impl')
    rerender(<OrbitMap agents={five()} state={{}} subagents={[]} subscribe={f.subscribe} selected="impl" onPick={onPick} />)
    expect(node('impl')).toHaveAttribute('aria-pressed', 'true')
    expect(node('test')).toHaveAttribute('aria-pressed', 'false')
    for (const c of container.querySelectorAll('canvas')) expect(c).toHaveAttribute('aria-hidden', 'true')
  })

  it('위성_이름표는_진짜_서브에이전트_수만큼(0이면_0)_바뀌면_따라간다', () => {
    const f = feed()
    const ag = five()
    const subs = [{ agentId: 'impl', label: '결제 흐름 조사' }, { agentId: 'lead', label: '쿠폰 규칙 읽기' }]
    const labels = () => texts().filter(s => s === '결제 흐름 조사' || s === '쿠폰 규칙 읽기')
    const { rerender } = render(<OrbitMap agents={ag} state={{}} subagents={[]} subscribe={f.subscribe} />)
    runFrame(16)
    expect(labels()).toEqual([])
    rerender(<OrbitMap agents={ag} state={{}} subagents={subs} subscribe={f.subscribe} />)
    calls.length = 0
    runFrame(32)
    expect(labels()).toEqual(['결제 흐름 조사', '쿠폰 규칙 읽기'])
    rerender(<OrbitMap agents={ag} state={{}} subagents={[]} subscribe={f.subscribe} />)
    calls.length = 0
    runFrame(48)
    expect(labels()).toEqual([])
  })

  it('상태가_바뀌면_계기판의_일하는_중·기다림_값이_따라간다', () => {
    const f = feed()
    const ag = five()
    const { rerender } = render(<OrbitMap agents={ag} state={{ impl: 'working' }} subagents={[]} subscribe={f.subscribe} />)
    runFrame(16)
    calls.length = 0
    runFrame(32)
    const row = (k: string) => { const t = texts(); return t[t.indexOf(k) + 1] }
    expect(row('일하는 중')).toBe('1/5')
    expect(row('기다림')).toBe('0')
    rerender(<OrbitMap agents={ag} state={{ impl: 'working', rev: 'working', doc: 'awaiting' }} subagents={[]} subscribe={f.subscribe} />)
    calls.length = 0
    runFrame(48)
    expect(row('일하는 중')).toBe('2/5')
    expect(row('기다림')).toBe('1')
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
    intake(w, done('impl')) // 다음 프레임에 동기화
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
    intake(loud, done('impl'))
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
    let now = run(w, 0.2)
    intake(w, hand('impl', 'test', '테스트 다시 돌려 주세요'))
    now = run(w, 2, now)
    expect(w.bubbles).toHaveLength(1)
    const ctx = fakeCtx(calls)
    drawOverlay(ctx, w, null, 2)
    expect(texts()).toContain('테스트 다시 돌려 주세요')
    expect(texts()).toContain('구현 → ')

    calls.length = 0
    intake(w, done('test'))
    stepWorld(w, now + 16)
    expect(w.syncing).toBe(true)
    expect(w.bubbles).toHaveLength(1)
    drawOverlay(ctx, w, null, 2)
    expect(texts()).not.toContain('테스트 다시 돌려 주세요')
    expect(texts()).toContain('테스트 끝남')
  })

  it('오른쪽_위_궤도_값은_여섯_줄까지_넘치면_외_N', () => {
    const agents = Array.from({ length: 12 }, (_, i) => ({ id: `a${i}`, name: `이름${i}`, color: '#60A5FA' }))
    const w = createWorld({ agents, W: 748, H: 580, calm: false, rand: mulberry32(5) })
    run(w, 0.2)
    drawOverlay(fakeCtx(calls), w, null, 2)
    expect(texts().filter(s => s.startsWith('θ '))).toHaveLength(6)
    expect(texts()).toContain('외 5')
  })

  it('넘김이_닿으면_물결_불꽃_말풍선_카드_번쩍_지어낸_토큰_글은_없다', () => {
    const w = world(false)
    let now = run(w, 0.2)
    intake(w, hand('rev', 'doc', '리뷰 의견 4개 보냈어요'))
    now = run(w, 2, now)
    expect(w.ripples.some(r => r.id === 'doc')).toBe(true)
    expect(w).not.toHaveProperty('floats')
    expect(w.bubbles[0]).toMatchObject({ id: 'doc', from: 'rev', text: '리뷰 의견 4개 보냈어요' })
    expect(w.sparks.length).toBeGreaterThan(0)
    expect(w.hits).toContain('doc')
    drawOverlay(fakeCtx(calls), w, null, 2)
    expect(texts().some(s => s.includes('토큰'))).toBe(false)
  })

  it('사건이_없으면_조각·혜성·말풍선·뜬_글이_0이고_시간만_흘러서는_동기화가_터지지_않는다', () => {
    const w = world(false)
    run(w, 60)
    expect([w.comets.length, w.shards.length, w.bubbles.length, w.leaves.length, w.sparks.length, w.ripples.length]).toEqual([0, 0, 0, 0, 0, 0])
    expect(w).not.toHaveProperty('floats')
    expect(w.syncing).toBe(false)
    expect(w.toast).toBeNull()
    expect(inFlight(w)).toBe(0)
    calls.length = 0
    drawOverlay(fakeCtx(calls), w, null, 2)
    expect(texts().some(s => /토큰|끝남|동기화/.test(s))).toBe(false)
  })

  it('done_사건이면_동기화가_시작되고_알림_글은_이름_끝남', () => {
    const w = world(false)
    let now = run(w, 0.5)
    intake(w, done('rev'))
    now = run(w, 0.1, now)
    expect(w.syncing).toBe(true)
    expect(w.toast?.text).toBe('검토 끝남')
    drawOverlay(fakeCtx(calls), w, null, 2)
    expect(texts()).toContain('검토 끝남')
  })

  it('6초_안의_두_번째_done_은_동기화를_다시_시작하지_않고_6초가_지나면_다시', () => {
    const w = world(false)
    let now = run(w, 0.5)
    intake(w, done('rev'))
    now = run(w, 0.1, now)
    const t0 = w.sync.t0
    now = run(w, 3, now)
    intake(w, done('impl'))
    now = run(w, 0.1, now)
    expect(w.sync.t0).toBe(t0)
    expect(w.syncing).toBe(false)
    now = run(w, 3, now) // 첫 동기화에서 6초 넘게 지났다
    intake(w, done('impl'))
    now = run(w, 0.1, now)
    expect(w.sync.t0).toBeGreaterThan(t0 + 6)
    expect(w.syncing).toBe(true)
    expect(w.toast?.text).toBe('구현 끝남')
  })

  it('모르는_에이전트의_done_은_버린다', () => {
    const w = world(false)
    run(w, 0.2)
    intake(w, done('ghost'))
    expect(w.queue).toHaveLength(0)
  })

  it('say·result_는_장면에_아무것도_안_더한다', () => {
    const w = world(false)
    let now = run(w, 0.2)
    intake(w, { kind: 'say', agentId: 'impl', text: '말', at: 0 })
    intake(w, { kind: 'result', agentId: 'impl', ok: true, text: '', added: 1, removed: 0, diff: [], at: 0 })
    expect(w.queue).toHaveLength(0)
    now = run(w, 1, now)
    expect([w.comets.length, w.shards.length, w.leaves.length]).toEqual([0, 0, 0])
    expect(w.syncing).toBe(false)
  })

  it('계기판의_오가는_넘김은_날아가는_진짜_넘김만_센다(도구_조각·따라가는_작은_혜성은_안_센다)', () => {
    const w = world(false)
    let now = run(w, 0.2)
    intake(w, hand('impl', 'test', '넘겨요'))
    intake(w, tool('rev', 'Read', 'a.ts'))
    now = run(w, 0.3, now)
    expect(inFlight(w)).toBe(1)
    drawOverlay(fakeCtx(calls), w, null, 2)
    const t = texts()
    expect(t[t.indexOf('오가는 넘김') + 1]).toBe('1')
    expect(t).not.toContain('오가는 데이터')
  })

  it('계기판은_진짜_값만_일하는_중_N/M_기다림_N_오가는_넘김_카메라', () => {
    const w = world(false)
    setStates(w, { lead: 'working', impl: 'working', test: 'awaiting', rev: 'resting' })
    run(w, 0.2)
    drawOverlay(fakeCtx(calls), w, null, 2)
    const t = texts()
    const row = (k: string) => t[t.indexOf(k) + 1]
    expect(row('일하는 중')).toBe('2/5')
    expect(row('기다림')).toBe('1')
    expect(row('오가는 넘김')).toBe('0')
    expect(t).toContain('카메라')
    expect(t).not.toContain('궤도 동기화')
    expect(t).not.toContain('핵 출력')
  })

  it('핵_밝기는_진짜_도구_빈도를_따르고_쉬면_낮게_가라앉는다', () => {
    const w = world(false)
    let now = run(w, 30)
    const rest = w.energy
    expect(rest).toBeLessThan(0.25)
    for (let s = 0; s < 5; s++) {
      for (let i = 0; i < 3; i++) intake(w, tool('impl', 'Read', `f${s}${i}.ts`))
      now = run(w, 1, now)
    }
    expect(w.energy).toBeGreaterThan(rest + 0.3)
    run(w, 30, now)
    expect(w.energy).toBeLessThan(0.25)
  })

  it('쉬면_활동_파형은_바닥에_붙는다', () => {
    const w = world(false)
    run(w, 10)
    expect(Math.max(...w.wave)).toBeLessThanOrEqual(0.06)
  })

  it('핵의_도구_사건은_잎만_궤도_에이전트는_조각도', () => {
    const w = world(false)
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

  it('위성은_진짜로_도는_서브에이전트만_이름과_부모가_진짜', () => {
    expect(world(false).sats).toEqual([])
    const w = createWorld({
      agents: who(), W: 748, H: 580, calm: false, rand: mulberry32(3),
      satellites: [{ agentId: 'impl', label: '결제 흐름 조사' }, { agentId: 'lead', label: '서브에이전트' }, { agentId: 'gone', label: '모르는 부모' }],
    })
    expect(w.sats.map(s => [s.name, s.parent])).toEqual([['결제 흐름 조사', 'impl'], ['서브에이전트', 'lead'], ['모르는 부모', 'lead']])
    run(w, 0.2)
    drawOverlay(fakeCtx(calls), w, null, 2)
    expect(texts()).toContain('결제 흐름 조사')
  })

  it('위성_이름표는_뒤쪽으로_돌아가도_읽힌다(진짜_설명이라_흐려져도_불투명도_0.6_이상_—_관계도_판_위_대비_4.5:1_이상)', () => {
    const names = ['결제 흐름 조사', '테스트 빈틈 찾기']
    const w = createWorld({ agents: who(), W: 748, H: 580, calm: false, rand: mulberry32(3), satellites: names.map((label, i) => ({ agentId: i ? 'lead' : 'impl', label })) })
    const alphas: number[] = []
    let now = 0
    for (let i = 0; i < 160; i++) {
      now = run(w, 0.25, now)
      calls.length = 0
      drawOverlay(fakeCtx(calls), w, null, 2)
      for (const c of calls)
        if (c.fn === 'fillText' && names.includes(String(c.args[0]))) alphas.push(Number(/,\s*([\d.]+)\)$/.exec(String(c.fill))![1]))
    }
    expect(alphas.length).toBeGreaterThan(200)
    expect(Math.min(...alphas)).toBeGreaterThanOrEqual(0.6)
    expect(Math.max(...alphas) - Math.min(...alphas)).toBeGreaterThan(0.1) // 깊이감(앞쪽이 더 또렷)은 남는다
  })

  it('먼_쪽_노드_카드도_읽힌다_—_깊이_밝기는_0.8_아래로_내려가지_않고_도구_줄은_text-3(가장_밝은_번짐_위에서도_4.5:1)', () => {
    const w = world(false)
    let now = 0
    let lo = 1
    let hi = 0
    for (let i = 0; i < 200; i++) {
      now = run(w, 0.25, now)
      for (const [id, p] of w.pos) {
        if (id === w.core.id) continue
        lo = Math.min(lo, p.o)
        hi = Math.max(hi, p.o)
      }
    }
    expect(lo).toBeGreaterThanOrEqual(0.8)
    expect(hi - lo).toBeGreaterThan(0.1) // 깊이감(앞쪽이 더 밝다)은 남는다
    const css = fs.readFileSync(path.resolve('src/renderer/power/power.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
    expect(/\n\.pw-mn-tx i \{[^}]*color: var\(--text-3\)/.test(css)).toBe(true)
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
    expect(texts()).toContain('카메라')
    expect(texts()).toContain('활동')
    expect(texts()).toContain('일하는 중')
    expect(texts()).toContain('기다림')
    // 지어낸 계기판 값은 없다
    expect(texts()).not.toContain('궤도 동기화')
    expect(texts()).not.toContain('핵 출력')
  })
})

/** 둘째 방 세 명 · 셋째 방 두 명(다섯 명 방과 id 가 겹치지 않는다) */
const three = (): PowerAgent[] => [['pay', '결제'], ['ship', '배송'], ['ops', '운영']].map(([id, name]) => ({ id, name, role: '역할', color: '#34D399' }))
const two = (): PowerAgent[] => [['k1', '하나'], ['k2', '둘']].map(([id, name]) => ({ id, name, role: '역할', color: '#FBBF24' }))
const whoOf = (a: PowerAgent[]) => a.map(x => ({ id: x.id, name: x.name, color: x.color }))
const roomOf = (n: number, prev: string | null, next: string | null): RoomChange => ({ n, prev, next })
const go = (w: World, agents: PowerAgent[], name: string | null = '결제', tag = 1) =>
  changeRoom(w, { agents: whoOf(agents), satellites: [], states: {}, tag, toRoom: `room-${tag}`, name })
/** 궤도 노드의 세계 반지름 — 제 궤도 반지름에 대한 배수(1 = 제 궤도 위, 0 = 핵) */
const radiusK = (w: World) => w.orbits.map(o => Math.hypot(w.wpos.get(o.id)![0], w.wpos.get(o.id)![2]) / (o.r * w.RA))
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length
const idsIn = (c: HTMLElement) => [...c.querySelectorAll('[data-node]')].map(e => e.getAttribute('data-node')).join(',')
const scaleOf = (el: Element) => Number(/scale\(([-\d.e]+)\)/.exec((el as HTMLElement).style.transform)![1])

describe('관계도 — 방을 옮길 때 전환(빨려 들기 · 도약 · 펼쳐지기)', () => {
  it('방이_바뀌면_전환이_시작되고_옛_카드는_나선을_그리며_핵으로_—_0.55s_에_모두_핵_자리(scale_0)', () => {
    const w = world(false)
    let now = run(w, 0.5)
    expect(mean(radiusK(w))).toBeCloseTo(1, 5)
    const ang0 = w.orbits.map(o => Math.atan2(w.wpos.get(o.id)![2], w.wpos.get(o.id)![0]))
    const turn0 = w.tt
    go(w, three())
    expect(w.tr.phase).toBe('out')
    now = run(w, 0.2, now)
    const r1 = mean(radiusK(w))
    now = run(w, 0.2, now)
    const r2 = mean(radiusK(w))
    expect(r1).toBeLessThan(1)
    expect(r2).toBeLessThan(r1)
    // 나선 — 평소 궤도 회전보다 더 돈다(각에 outK·π 가 더해진다)
    const plain = ((w.tt - turn0) * 2 * Math.PI) / 70
    w.orbits.forEach((o, i) => {
      const a = Math.atan2(w.wpos.get(o.id)![2], w.wpos.get(o.id)![0]) - ang0[i]
      expect(((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)).toBeGreaterThan(plain + 1)
    })
    now = run(w, 0.15, now) // 0.55초
    const core = w.pos.get('lead')!
    for (const [id, p] of w.pos) {
      expect(p.s).toBeLessThan(0.01)
      expect(p.a).toBeLessThan(0.01)
      if (id !== 'lead') expect(Math.hypot(p.x - core.x, p.y - core.y)).toBeLessThan(1.5)
    }
    // 아직 옛 방 노드 — 바꿔 끼우기는 0.9초
    expect([...w.who.keys()]).toEqual(['lead', 'impl', 'test', 'rev', 'doc'])
    run(w, 0.4, now)
    expect([...w.who.keys()]).toEqual(['pay', 'ship', 'ops'])
  })

  it('펼칠_때_새_카드는_핵에서_작게_시작해_제_궤도로_—_핵부터_차례로(늦게_출발)', () => {
    const w = world(false)
    let now = run(w, 0.5)
    go(w, five().map(a => ({ ...a, id: `n-${a.id}` })))
    now = run(w, 0.91, now)
    expect(w.tr.phase).toBe('in')
    const p = (id: string) => w.pos.get(id)!
    // 바꿔 끼운 직후 — 모두 핵 자리에서 scale 0 근처
    for (const q of w.pos.values()) expect(q.s).toBeLessThan(0.2)
    now = run(w, 0.15, now)
    // 핵이 먼저, 뒤 카드일수록 덜 나왔다
    expect(p('n-lead').s).toBeGreaterThan(p('n-impl').s)
    const r = radiusK(w)
    for (let i = 1; i < r.length; i++) expect(r[i]).toBeLessThan(r[i - 1])
    now = run(w, 0.5, now)
    expect(w.tr.phase).toBe('idle')
    expect(mean(radiusK(w))).toBeCloseTo(1, 5)
    for (const q of w.pos.values()) expect(q.a).toBe(1)
    expect(p('n-lead').s).toBeGreaterThan(0.9)
  })

  it('도약은_끝남_연출과_같은_세기_하나로_—_급회전·당기기·흔들림·줄무늬(동기화와_겹치면_더_센_쪽)', () => {
    const w = world(false)
    let now = run(w, 0.5)
    go(w, three())
    let peak = 0
    for (let i = 0; i < 60; i++) {
      stepWorld(w, (now += 1000 / 60))
      const j = jumpK(w.tr)
      expect(w.boost).toEqual(boostOf(false, j))
      peak = Math.max(peak, j)
      if (j > 0.5) {
        expect(w.boost.streak).toBe(true)
        expect(w.boost.shake).toBeCloseTo(SHAKE_PX * j)
      }
    }
    expect(peak).toBeGreaterThan(0.95)
    // 동기화 세기와 함께면 — 둘 중 큰 쪽(두 연출이 세기 값 하나를 쓴다)
    const v = world(false)
    now = run(v, 0.5)
    intake(v, done('rev'))
    now = run(v, 0.05, now)
    go(v, three())
    for (let i = 0; i < 40; i++) {
      stepWorld(v, (now += 1000 / 60))
      const k = (v.t - v.sync.t0) / 2
      expect(v.boost.b).toBeCloseTo(Math.max(k >= 0 && k < 1 ? Math.sin(Math.PI * k) : 0, jumpK(v.tr)), 6)
    }
  })

  it('알림_글은_<새_방_이름>_방으로_—_도약이_시작될_때(끝남_알림과_같은_자리)', () => {
    const w = world(false)
    let now = run(w, 0.5)
    go(w, three(), '결제 서비스')
    now = run(w, 0.3, now)
    drawOverlay(fakeCtx(calls), w, null, 2)
    expect(texts()).not.toContain('결제 서비스 방으로')
    run(w, 0.4, now)
    calls.length = 0
    drawOverlay(fakeCtx(calls), w, null, 2)
    expect(texts()).toContain('결제 서비스 방으로')
    // 방이 없으면(이름 없음) 알림도 없다
    const v = world(false)
    run(v, 0.2)
    go(v, [], null)
    expect(v.toast).toBeNull()
  })

  it('알림은_그릴_때_잰_너비로_맞춘다_—_이름을_말줄임하고_꼬리(방으로·끝남)는_늘_남는다(좁은_칸에서도_칸을_안_넘는다)', () => {
    // 글자 하나 14px 인 가짜 잣대 — 알약 안쪽 너비 = 칸 − 가장자리 16 − 안쪽 여백 36
    const toastText = (W: number, setup: (w: World) => void) => {
      const w = createWorld({ agents: who(), W, H: 470, calm: false, rand: mulberry32(3) })
      setup(w)
      const ctx = fakeCtx(calls = [])
      ;(ctx as unknown as { measureText: (s: string) => { width: number } }).measureText = (s: string) => ({ width: s.length * 14 })
      drawOverlay(ctx, w, null, 2)
      const t = calls.filter(c => c.fn === 'fillText').map(c => String(c.args[0])).find(s => /방으로$|끝남$/.test(s))
      return t
    }
    const long = '결제 연동 · 웹훅 서명 검증과 정산 금액 반올림을 한 번에 정리하는 방'
    const toRoom = (name: string) => (w: World) => { const now = run(w, 0.2); go(w, three(), name); run(w, 0.7, now) }
    const t = toastText(344, toRoom(long))!
    expect(t.endsWith(' 방으로')).toBe(true)
    expect(t).toContain('…')
    expect(t.length * 14).toBeLessThanOrEqual(344 - 16 - 36)
    // 넓은 칸이면 더 많이 보이고 · 짧은 이름은 그대로
    expect(toastText(748, toRoom(long))!.length).toBeGreaterThan(t.length)
    expect(toastText(344, toRoom('결제 연동'))).toBe('결제 연동 방으로')
    // 끝남 알림도 같다
    const doneLong = (w: World) => {
      const w2 = w
      w2.who.get('lead')!.name = '아주아주아주아주아주아주아주아주아주 긴 에이전트 이름'
      intake(w2, done('lead'))
      run(w2, 0.6)
    }
    const d = toastText(344, doneLong)!
    expect(d.endsWith(' 끝남')).toBe(true)
    expect(d).toContain('…')
    expect(d.length * 14).toBeLessThanOrEqual(344 - 16 - 36)
    // 데이터는 온전한 글(자르기는 그리는 쪽)
    const w = world(false)
    run(w, 0.2)
    go(w, three(), long)
    expect(w.toast!.text).toBe(`${long} 방으로`)
  })

  it('알림이_계기판_글(왼쪽_위_값·오른쪽_위_궤도)과_겹칠_만큼_넓으면_그_아래로_—_좁은_관계도(1366×768)', () => {
    /** 알림 알약(roundRect 높이 28)의 y · 오른쪽 위 궤도 이름의 마지막 줄 y */
    const toastY = (w: World) => {
      calls.length = 0
      drawOverlay(fakeCtx(calls), w, null, 2)
      return Number(calls.find(c => c.fn === 'roundRect' && c.args[3] === 28)!.args[1])
    }
    const lastHudY = () => Math.max(...calls.filter(c => c.fn === 'fillText' && /^θ /.test(String(c.args[0]))).map(c => Number(c.args[2])))
    const at = (W: number, name: string) => {
      const w = createWorld({ agents: who(), W, H: 470, calm: false, rand: mulberry32(3) })
      let now = run(w, 0.3)
      go(w, three(), name)
      now = run(w, 0.7, now) // 도약 — 알림이 떠 있다(새 방 노드는 아직)
      return w
    }
    // 넓은 칸 · 짧은 이름 — 늘 자리(위 가운데)
    expect(toastY(at(748, '결제 연동'))).toBe(14)
    // 좁은 칸 · 긴 이름 — 계기판 마지막 줄 아래로
    const narrow = at(586, '결제 연동 · 웹훅 서명 검증과 정산 금액 반올림')
    const y = toastY(narrow)
    expect(y).toBeGreaterThan(lastHudY())
  })

  it('전환_중_온_사건은_끝난_뒤_첫_프레임들에_그려진다(조각_수)_—_차례_끝(done)의_동기화도_끝난_뒤로', () => {
    const w = world(false)
    let now = run(w, 0.5)
    go(w, three())
    now = run(w, 0.3, now)
    intake(w, tool('ship', 'Read', 'a.ts'))
    intake(w, tool('ops', 'Edit', 'b.ts'))
    intake(w, done('pay'))
    let during = 0
    let steps = 0
    const phase = () => w.tr.phase
    while (phase() !== 'idle' && steps++ < 200) {
      stepWorld(w, (now += 1000 / 60))
      if (phase() === 'idle') break // 끝난 걸음 — 여기부터 그린다
      during = Math.max(during, w.shards.length, w.leaves.length)
      expect(w.syncing).toBe(false)
    }
    expect(during).toBe(0)
    let after = 0
    for (let i = 0; i < 18; i++) {
      stepWorld(w, (now += 1000 / 60))
      after = Math.max(after, w.shards.length)
    }
    expect(after).toBe(2)
    expect(w.syncing).toBe(true)
    expect(w.toast?.text).toBe('결제 끝남')
  })

  it('움직임_줄이기면_나선·급회전·흔들림_없이_옛_카드는_제자리에서_0.3s_흐려지고_새_카드는_제자리에서_0.3s_나타난다_—_알림은_뜬다', () => {
    const w = world(true)
    let now = run(w, 0.5)
    go(w, three())
    let shift = 0
    let rMin = 1
    const yaw0 = w.cam.yaw
    for (let i = 0; i < 17; i++) {
      stepWorld(w, (now += 1000 / 60))
      shift = Math.max(shift, Math.abs(w.cam.cx - w.cx0), Math.abs(w.cam.cy - w.cy0))
      expect(w.boost).toEqual(boostOf(true, 0))
      rMin = Math.min(rMin, ...radiusK(w))
    }
    expect(shift).toBe(0)
    expect(w.cam.yaw - yaw0).toBeCloseTo(17 * (1 / 60) * 0.05, 5)
    expect(rMin).toBeCloseTo(1, 5)
    expect([...w.who.keys()]).toEqual(['lead', 'impl', 'test', 'rev', 'doc'])
    // 0.3초 — 옛 카드는 흐려져 사라지고 새 방으로 바뀐다(새 카드는 제 궤도 · 제 크기에서 나타난다)
    now = run(w, 0.05, now)
    expect([...w.who.keys()]).toEqual(['pay', 'ship', 'ops'])
    expect(mean(radiusK(w))).toBeCloseTo(1, 5)
    for (const p of w.pos.values()) {
      expect(p.a).toBeLessThan(0.3)
      expect(p.s).toBeGreaterThan(0.5)
    }
    now = run(w, 0.3, now)
    expect(w.tr.phase).toBe('idle')
    for (const p of w.pos.values()) expect(p.a).toBe(1)
    expect(w.toast?.text).toBe('결제 방으로')
  })
})

describe('관계도 화면 — 방을 옮길 때', () => {
  /** 60fps 로 n 프레임 — 프레임 앞마다 cb */
  const frames60 = (n: number, from: number, cb?: (i: number) => void) => {
    let now = from
    for (let i = 0; i < n; i++) {
      cb?.(i)
      runFrame((now += 1000 / 60))
    }
    return now
  }

  it('swap_전엔_옛_방_카드만_뒤엔_새_방_카드만_DOM_에_있다_—_0.7s_에_또_바꿔도_섞이지_않는다', () => {
    allowMotion()
    const f = feed()
    const map = (n: number, agents: PowerAgent[], name: string) => (
      <OrbitMap room={roomOf(n, null, `r${n}`)} roomName={name} agents={agents} state={{}} subagents={[]} subscribe={f.subscribe} />
    )
    const { container, rerender } = render(map(0, five(), '주문'))
    let now = frames60(3, 0)
    const A = 'lead,impl,test,rev,doc'
    const B = 'pay,ship,ops'
    const C = 'k1,k2'
    expect(idsIn(container)).toBe(A)
    rerender(map(1, three(), '결제'))
    expect(idsIn(container)).toBe(A) // 바꿔 끼우기 전 — 옛 방 카드가 빨려 든다
    const seen: string[] = []
    now = frames60(150, now, i => {
      if (i === 42) rerender(map(2, two(), '배송')) // 0.7초 — 도약 중에 또 옮긴다
      seen.push(idsIn(container))
    })
    seen.push(idsIn(container))
    expect(seen.every(s => s === A || s === C)).toBe(true)
    expect(seen).not.toContain(B)
    const first = seen.indexOf(C)
    expect(first).toBeGreaterThan(50) // 0.9초 언저리
    expect(first).toBeLessThan(58)
    expect(seen.slice(first).every(s => s === C)).toBe(true)
    // 끝나면 새 카드는 제 크기 · 다 보인다(scale 0 이나 반쯤 흐린 채 남지 않는다)
    for (const el of container.querySelectorAll('[data-node]')) {
      expect(scaleOf(el)).toBeGreaterThan(0.6)
      expect((el as HTMLElement).style.opacity).toBe('')
    }
  })

  it('옛_카드는_0.55s_에_모두_핵_자리에서_scale_0·투명', () => {
    allowMotion()
    const f = feed()
    const { container, rerender } = render(<OrbitMap room={roomOf(0, 'r1', 'r1')} agents={five()} state={{}} subagents={[]} subscribe={f.subscribe} />)
    let now = frames60(3, 0)
    rerender(<OrbitMap room={roomOf(1, 'r1', 'r2')} roomName="결제" agents={three()} state={{}} subagents={[]} subscribe={f.subscribe} />)
    now = frames60(33, now)
    const nodes = [...container.querySelectorAll('[data-node]')] as HTMLElement[]
    expect(nodes.map(n => n.dataset.node)).toEqual(['lead', 'impl', 'test', 'rev', 'doc'])
    for (const el of nodes) {
      expect(scaleOf(el)).toBeLessThan(0.01)
      expect(Number(el.style.opacity)).toBeLessThan(0.01)
    }
  })

  it('방이_바뀐_바로_그_순간(그리기_한_걸음_전에도)_옛_방_노드_카드는_이미_누를_수_없다', () => {
    allowMotion()
    const f = feed()
    const onPick = vi.fn()
    const map = (n: number, agents: PowerAgent[]) => (
      <OrbitMap room={roomOf(n, null, `r${n}`)} roomName="결제" agents={agents} state={{}} subagents={[]} subscribe={f.subscribe} onPick={onPick} />
    )
    const { container, rerender } = render(map(0, five()))
    frames60(3, 0)
    const nodes = () => [...container.querySelectorAll('[data-node]')] as HTMLButtonElement[]
    rerender(map(1, three())) // rAF 를 한 번도 돌리지 않는다
    expect(nodes().every(n => n.disabled)).toBe(true)
    act(() => { nodes()[1].click() })
    expect(onPick).not.toHaveBeenCalled()
  })

  it('전환_중_노드_카드는_누를_수_없고(disabled)_끝나면_다시_눌린다', () => {
    allowMotion()
    const f = feed()
    const onPick = vi.fn()
    const map = (n: number, agents: PowerAgent[]) => (
      <OrbitMap room={roomOf(n, null, `r${n}`)} roomName="결제" agents={agents} state={{}} subagents={[]} subscribe={f.subscribe} onPick={onPick} />
    )
    const { container, rerender } = render(map(0, five()))
    let now = frames60(3, 0)
    const nodes = () => [...container.querySelectorAll('[data-node]')] as HTMLButtonElement[]
    expect(nodes().every(n => !n.disabled)).toBe(true)
    rerender(map(1, three()))
    now = frames60(10, now)
    expect(nodes().every(n => n.disabled)).toBe(true)
    act(() => { nodes()[1].click() })
    now = frames60(50, now) // 1.0초 — 새 카드가 펼쳐지는 중
    expect(nodes().map(n => n.dataset.node)).toEqual(['pay', 'ship', 'ops'])
    expect(nodes().every(n => n.disabled)).toBe(true)
    act(() => { nodes()[0].click() })
    expect(onPick).not.toHaveBeenCalled()
    frames60(40, now)
    expect(nodes().every(n => !n.disabled)).toBe(true)
    act(() => { nodes()[1].click() })
    expect(onPick).toHaveBeenCalledWith('ship')
  })

  it('빈_방으로_옮기면_빨려_들고_도약한_뒤_카드가_다_빠지고_onEmpty_한_번', () => {
    allowMotion()
    const f = feed()
    const onEmpty = vi.fn()
    const { container, rerender } = render(<OrbitMap room={roomOf(0, 'r1', 'r1')} agents={five()} state={{}} subagents={[]} subscribe={f.subscribe} onEmpty={onEmpty} />)
    let now = frames60(3, 0)
    rerender(<OrbitMap room={roomOf(1, 'r1', 'e')} roomName="빈 방" agents={[]} state={{}} subagents={[]} subscribe={f.subscribe} onEmpty={onEmpty} />)
    now = frames60(50, now) // 0.83초
    expect(container.querySelectorAll('[data-node]')).toHaveLength(5)
    expect(onEmpty).not.toHaveBeenCalled()
    frames60(20, now)
    expect(container.querySelectorAll('[data-node]')).toHaveLength(0)
    expect(onEmpty).toHaveBeenCalledTimes(1)
  })

  it('빈_방에서_옮겨_와_처음_그리면_카드가_핵에서_작게_시작해_제_크기로_펼쳐진다', () => {
    allowMotion()
    const f = feed()
    const { container } = render(<OrbitMap room={roomOf(1, 'e', 'r2')} roomName="결제" agents={three()} state={{}} subagents={[]} subscribe={f.subscribe} />)
    let now = frames60(2, 0)
    const nodes = () => [...container.querySelectorAll('[data-node]')] as HTMLElement[]
    expect(nodes().map(n => n.dataset.node)).toEqual(['pay', 'ship', 'ops'])
    for (const el of nodes()) expect(scaleOf(el)).toBeLessThan(0.25)
    now = frames60(40, now)
    for (const el of nodes()) {
      expect(scaleOf(el)).toBeGreaterThan(0.6)
      expect(el.style.opacity).toBe('')
    }
    // 알림 — 빈 방에서도 뜬다
    calls.length = 0
    frames60(1, now)
    expect(texts()).toContain('결제 방으로')
  })

  it('캔버스가_없으면_전환_없이_바로_새_방_카드(빈_방이면_바로_onEmpty)', () => {
    HTMLCanvasElement.prototype.getContext = (() => null) as unknown as typeof HTMLCanvasElement.prototype.getContext
    allowMotion()
    const f = feed()
    const onEmpty = vi.fn()
    const { container, rerender } = render(<OrbitMap room={roomOf(0, 'r1', 'r1')} agents={five()} state={{}} subagents={[]} subscribe={f.subscribe} onEmpty={onEmpty} />)
    rerender(<OrbitMap room={roomOf(1, 'r1', 'r2')} agents={three()} state={{}} subagents={[]} subscribe={f.subscribe} onEmpty={onEmpty} />)
    expect(idsIn(container)).toBe('pay,ship,ops')
    rerender(<OrbitMap room={roomOf(2, 'r2', 'e')} agents={[]} state={{}} subagents={[]} subscribe={f.subscribe} onEmpty={onEmpty} />)
    expect(idsIn(container)).toBe('')
    expect(onEmpty).toHaveBeenCalledTimes(1)
  })
})
