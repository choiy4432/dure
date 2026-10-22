import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, act, cleanup } from '@testing-library/react'
import { animate } from 'animejs'
import type { AgentView, Snapshot } from '../../src/shared/ipcContract'
import type { ContextUsage } from '../../src/engine/types'
import { allowMotion, fastMotion } from './motion'

vi.mock('animejs', async orig => {
  const m = await orig<typeof import('animejs')>()
  return { ...m, animate: vi.fn(m.animate) }
})

const agent = (id: string): AgentView => ({
  id, roomId: 'r1', name: id, role: '역할', folder: 'C:\\w', sessionId: 's', started: true, auto: false, model: null,
  alwaysAllow: [], pos: { x: 64, y: 64 }, color: null, effort: null, lastContext: null, bypassOn: false, effortNow: null, modelNow: null, status: 'idle', errorText: null, bypass: false, bypassBySettings: false, bypassPending: false, heldInput: 0, subagentsRunning: [],
})

let handlers: Record<string, ((p: any) => void)[]>
beforeEach(() => {
  vi.resetModules()
  handlers = {}
  const snapshot: Snapshot = {
    claudeMissing: false, rooms: [{ id: 'r1', name: '방', createdAt: 1 }],
    agents: [agent('n'), agent('o')], messages: [], requests: [], autoChainLimit: 3, allowBypass: false, notify: { asks: true, finished: false }, usage: null,
  }
  ;(window as any).dure = {
    snapshot: async () => snapshot,
    history: async () => [],
    refreshUsage: async () => {},
    on: (k: string, fn: (p: any) => void) => {
      ;(handlers[k] ??= []).push(fn)
      return () => {}
    },
  }
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.mocked(animate).mockClear()
})

const calls = (el: Element) => vi.mocked(animate).mock.calls.filter(c => c[0] === el)
const emit = (k: string, p: unknown) => act(() => (handlers[k] ?? []).forEach(f => f(p)))

async function cards() {
  const { getStore } = await import('../../src/renderer/state/store')
  const node = await import('../../src/renderer/map/AgentNode')
  const fresh = await import('../../src/renderer/map/freshNodes')
  await act(async () => { await getStore().init() })
  return { AgentCard: node.AgentCard, ...fresh }
}

describe('관계도 새 카드', () => {
  it('에이전트를 더하면 그 카드만 280ms outQuint · y 8 · scale 0.94 에서 나타난다', async () => {
    allowMotion()
    const { AgentCard, markFresh } = await cards()
    markFresh('n')
    const r = render(<><AgentCard agentId="n" /><AgentCard agentId="o" /></>)
    const [a, b] = Array.from(r.container.querySelectorAll('.nd'))
    const c = calls(a)[0]
    expect(c).toBeTruthy()
    const p = c[1] as any
    expect(p.opacity.from).toBe(0)
    expect(p.translateY.from).toBe(8)
    expect(p.scale.from).toBe(0.94)
    expect(p.duration).toBe(280)
    expect(p.ease).toBe('outQuint')
    expect(calls(b)).toHaveLength(0)
  })

  it('앱 시작·방 바꾸기로 그린 카드는 움직이지 않는다 — 새 카드도 한 번 나타난 뒤 다시 그리면 가만히', async () => {
    allowMotion()
    const { AgentCard, markFresh } = await cards()
    const first = render(<AgentCard agentId="o" />)
    expect(calls(first.container.querySelector('.nd')!)).toHaveLength(0)
    cleanup()
    markFresh('n') // 첫 에이전트(빈 화면 → 관계도)도 같은 길이다
    const r = render(<AgentCard agentId="n" />)
    expect(calls(r.container.querySelector('.nd')!)).toHaveLength(1)
    cleanup()
    const again = render(<AgentCard agentId="n" />) // 방을 바꿨다 돌아옴
    expect(calls(again.container.querySelector('.nd')!)).toHaveLength(0)
  })

  it('움직임 줄이기면 새 카드도 animate 없이 바로 나타난다', async () => {
    const { AgentCard, markFresh } = await cards()
    markFresh('n')
    render(<AgentCard agentId="n" />)
    expect(vi.mocked(animate)).not.toHaveBeenCalled()
  })
})

describe('freshNodes', () => {
  it('takeFresh 는 한 번만 참이고 5초가 지나면 거짓', async () => {
    vi.useFakeTimers()
    const { markFresh, takeFresh } = await import('../../src/renderer/map/freshNodes')
    markFresh('a')
    expect(takeFresh('a')).toBe(true)
    expect(takeFresh('a')).toBe(false)
    markFresh('b')
    vi.advanceTimersByTime(4999)
    expect(takeFresh('b')).toBe(true)
    markFresh('c')
    vi.advanceTimersByTime(5001)
    expect(takeFresh('c')).toBe(false)
  })
})

const plan = (percent: number) => ({ windows: [{ key: 'five_hour', label: '5시간', percent, resetsAt: null }], at: 1 })

async function mountUsage() {
  const { getStore } = await import('../../src/renderer/state/store')
  const { UsageMeters } = await import('../../src/renderer/shell/UsageMeters')
  await act(async () => { await getStore().init() })
  const r = render(<UsageMeters />)
  return r
}

describe('사용량 막대', () => {
  it('처음 값은 바로, 값이 바뀌면 막대 width 가 700ms outQuint 로', async () => {
    allowMotion()
    const restore = fastMotion(1)
    const r = await mountUsage()
    emit('usage', plan(30))
    const fill = r.container.querySelector('.usg-bar > span') as HTMLElement
    expect(fill.style.width).toBe('30%')
    expect(calls(fill)).toHaveLength(0)
    emit('usage', plan(60))
    const c = calls(fill)[0]
    expect(c).toBeTruthy()
    const p = c[1] as any
    expect(p.width).toBe('60%') // 시작 값을 주지 않는다 — 지금 너비에서 이어 간다
    expect(p.duration).toBe(700)
    expect(p.ease).toBe('outQuint')
    restore()
  })

  it('움직이는 중에 새 값이 오면 옛 끝 값으로 되돌아가지 않고 지금 너비에서 이어 간다', async () => {
    allowMotion()
    const restore = fastMotion(1)
    const r = await mountUsage()
    emit('usage', plan(30))
    const fill = r.container.querySelector('.usg-bar > span') as HTMLElement
    emit('usage', plan(60))
    emit('usage', plan(90))
    const all = calls(fill)
    expect(all).toHaveLength(2)
    for (const c of all) expect(Array.isArray((c[1] as any).width)).toBe(false)
    expect((all[1][1] as any).width).toBe('90%')
    restore()
  })

  it('움직임 줄이기면 animate 없이 바로 그 값', async () => {
    const r = await mountUsage()
    emit('usage', plan(30))
    const fill = r.container.querySelector('.usg-bar > span') as HTMLElement
    emit('usage', plan(60))
    expect(fill.style.width).toBe('60%')
    expect(vi.mocked(animate)).not.toHaveBeenCalled()
  })
})

const ctx = (percent: number): ContextUsage => ({ total: percent * 10_000, max: 1_000_000, percent, autoCompactAt: 967_000, at: 1 })
const CIRC = 2 * Math.PI * ((18 - 2.5) / 2)
const dash = (fill: number) => `${(CIRC * fill) / 100} ${CIRC}`

describe('context 링', () => {
  it('처음 값은 바로, 바뀌면 호 길이가 800ms 동안 이어지고 끝은 지금과 같은 stroke-dasharray', async () => {
    allowMotion()
    const restore = fastMotion(40)
    const { ContextRing } = await import('../../src/renderer/panel/ContextRing')
    const el = (v: ContextUsage) => <ContextRing agentId="w" name="웹" value={v} working={false} onCompact={() => {}} />
    const r = render(el(ctx(20)))
    const fg = r.container.querySelector('.ctx-fg')!
    expect(fg.getAttribute('stroke-dasharray')).toBe(dash(20))
    expect(vi.mocked(animate)).not.toHaveBeenCalled()
    r.rerender(el(ctx(70)))
    const c = vi.mocked(animate).mock.calls[0]
    expect(c).toBeTruthy()
    expect((c[1] as any).duration).toBe(800)
    expect((c[1] as any).ease).toBe('outQuint')
    await new Promise(res => setTimeout(res, 150))
    expect(fg.getAttribute('stroke-dasharray')).toBe(dash(70))
    restore()
  })

  it('움직임 줄이기면 animate 없이 바로 그 값', async () => {
    const { ContextRing } = await import('../../src/renderer/panel/ContextRing')
    const el = (v: ContextUsage) => <ContextRing agentId="w" name="웹" value={v} working={false} onCompact={() => {}} />
    const r = render(el(ctx(20)))
    r.rerender(el(ctx(70)))
    expect(r.container.querySelector('.ctx-fg')!.getAttribute('stroke-dasharray')).toBe(dash(70))
    expect(vi.mocked(animate)).not.toHaveBeenCalled()
  })
})
