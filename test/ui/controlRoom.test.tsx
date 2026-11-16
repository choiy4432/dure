import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { render, screen, act, cleanup, within } from '@testing-library/react'

// 관제실 — 카드 · 기록 · 승인 기다림 · 숫자 띠

const agent = (id: string, over: object = {}) => ({
  id, roomId: 'r1', name: id, role: `${id}역`, folder: '/x', sessionId: '', started: true, auto: false, model: null,
  alwaysAllow: [], pos: { x: 0, y: 0 }, color: null, effort: null, effortNow: null, modelNow: null, lastContext: null, bypassOn: false, status: 'idle', errorText: null, bypass: false, bypassBySettings: false, bypassPending: false, heldInput: 0, planMode: false, asleep: false, waking: false, hold: null, subagentsRunning: [], pastCount: 0, remoteIssue: null, ...over,
})
const toolItem = (name: string, input: unknown) => ({ t: 5, kind: 'assistant', blocks: [{ type: 'tool_use', id: 'u', name, input }] })

let handlers: Record<string, ((p: any) => void)[]>
const emit = (k: string, p: unknown) => act(() => { (handlers[k] ?? []).forEach(f => f(p)) })

async function mount(agents: object[]) {
  const rooms = agents.length ? [{ id: 'r1', name: '진짜 방', createdAt: 1 }] : []
  vi.resetModules()
  handlers = {}
  ;(window as any).dure = {
    snapshot: async () => ({ claudeMissing: false, rooms, agents, messages: [], requests: [], autoChainLimit: 5, allowBypass: false, notify: { asks: true, finished: false }, sleepAfterMin: 30, usage: null }),
    history: async () => [],
    setPowerMode: async () => {},
    on: (k: string, fn: (p: any) => void) => { (handlers[k] ??= []).push(fn); return () => {} },
  }
  const { getStore } = await import('../../src/renderer/state/store')
  const { ControlRoom } = await import('../../src/renderer/power/ControlRoom')
  const store = getStore()
  await act(async () => { await store.init() })
  if (rooms.length) act(() => { store.selectRoom('r1') })
  await act(async () => { await store.setPower(true) })
  render(<ControlRoom seed={7} />)
}
const wait = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms) })
const cards = () => document.querySelectorAll('.pw-card')
const rows = () => [...document.querySelectorAll('[data-row]')]
const card = (id: string) => document.querySelector(`[data-agent="${id}"]`) as HTMLElement

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { cleanup(); vi.useRealTimers() })

describe('관제실', () => {
  it('가짜_다섯이면_카드_5장', async () => {
    await mount([])
    expect(cards()).toHaveLength(5)
    expect(screen.queryByText(/^외 \d+명$/)).toBeNull()
    expect(screen.getByText('파워 모드 · 가동 중')).toBeInTheDocument()
    expect(screen.getByText('3:42:17')).toBeInTheDocument()
    expect(document.querySelector('[data-power-map] .pw-mapbox')).not.toBeNull()
  })

  it('에이전트_7명이면_카드_5장_더하기_외_2명', async () => {
    await mount(Array.from({ length: 7 }, (_, i) => agent(`x${i}`)))
    expect(cards()).toHaveLength(5)
    expect(screen.getByText('외 2명')).toBeInTheDocument()
  })

  it('tool_사건이_오면_카드_도구_줄과_기록_맨_위가_바뀐다', async () => {
    await mount([agent('a', { name: '알파' })])
    await emit('history', { agentId: 'a', item: toolItem('Read', { file_path: 'src/one.ts' }) })
    await wait(250)
    expect(within(card('a')).getByText('Read')).toBeInTheDocument()
    expect(within(card('a')).getByText('src/one.ts')).toBeInTheDocument()
    expect(rows()[0]).toHaveTextContent('src/one.ts')
    await emit('history', { agentId: 'a', item: toolItem('Bash', { command: 'npm test' }) })
    await wait(250)
    expect(within(card('a')).getByText('npm test')).toBeInTheDocument()
    expect(rows()[0]).toHaveTextContent('npm test')
    expect(rows()[1]).toHaveTextContent('src/one.ts')
  })

  it('기록은_26줄까지', async () => {
    await mount([agent('a', { name: '알파' })])
    for (let i = 0; i < 30; i++) await emit('history', { agentId: 'a', item: toolItem('Read', { file_path: `f${i}.ts` }) })
    await wait(250)
    expect(rows()).toHaveLength(26)
    expect(rows()[0]).toHaveTextContent('f29.ts')
  })

  it('awaiting_에_든_에이전트만_승인_기다림', async () => {
    await mount([agent('a', { name: '알파', status: 'awaiting' }), agent('b', { name: '베타' })])
    expect(within(card('a')).getByText('승인 기다림')).toBeInTheDocument()
    expect(within(card('b')).getByText('작업 중')).toBeInTheDocument()
  })

  it('채움_사건만으로는_승인_기다림이_안_뜨고_기다리는_쪽엔_채움이_안_붙는다', async () => {
    await mount([agent('a', { name: '알파' }), agent('b', { name: '베타', status: 'awaiting' })])
    await wait(15000)
    expect(rows().length).toBeGreaterThan(0)
    const names = rows().map(r => r.querySelector('b')!.textContent)
    expect(names).not.toContain('베타')
    expect(rows().some(r => r.textContent!.includes('→ 베타'))).toBe(false)
    expect(within(card('a')).queryByText('승인 기다림')).toBeNull()
    // 진짜 사건은 기다리는 쪽 것도 그대로 지나간다
    await emit('history', { agentId: 'b', item: toolItem('Edit', { file_path: 'real.ts' }) })
    await wait(250)
    expect(rows()[0]).toHaveTextContent('real.ts')
    expect(within(card('b')).getByText('승인 기다림')).toBeInTheDocument()
  })

  it('가짜_방은_채움만으로_아무도_승인_기다림이_아니다', async () => {
    await mount([])
    await wait(10000)
    expect(screen.queryByText('승인 기다림')).toBeNull()
    expect(rows().length).toBeGreaterThan(0)
  })

  it('쉬는_진짜_에이전트도_작업_중', async () => {
    await mount([agent('a', { name: '알파', status: 'idle' })])
    expect(within(card('a')).getByText('작업 중')).toBeInTheDocument()
  })

  it('숫자_띠_도구_호출이_올라가고_가동_시간이_센다', async () => {
    await mount([agent('a', { name: '알파' })])
    expect(document.querySelector('[data-stat="tools"]')).toHaveTextContent('1,284')
    await emit('history', { agentId: 'a', item: toolItem('Read', { file_path: 'a.ts' }) })
    await wait(250)
    expect(document.querySelector('[data-stat="tools"]')).toHaveTextContent('1,285')
    await wait(2000)
    expect(screen.getByText('3:42:19')).toBeInTheDocument()
  })
})
