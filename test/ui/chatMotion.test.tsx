import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest'
import { render, screen, act, cleanup, waitFor } from '@testing-library/react'
import { animate } from 'animejs'
import type { EngineEventMap, HistoryItem } from '../../src/engine/types'
import type { AgentView, Snapshot } from '../../src/shared/ipcContract'
import { allowMotion, fastMotion } from './motion'

vi.mock('animejs', async orig => {
  const m = await orig<typeof import('animejs')>()
  return { ...m, animate: vi.fn(m.animate) }
})

const agent = (id: string, over: Partial<AgentView> = {}): AgentView => ({
  id, roomId: 'r1', name: id, role: '역할', folder: 'C:\\w', sessionId: 's', started: true, auto: false, model: null,
  alwaysAllow: [], pos: { x: 64, y: 64 }, color: null, effort: null, lastContext: null, bypassOn: false, effortNow: null, modelNow: null, status: 'idle', errorText: null, bypass: false, bypassBySettings: false, heldInput: 0, ...over,
})
const say = (t: number, text: string): HistoryItem => ({ t, kind: 'user', source: 'human', parts: [{ type: 'text', text }] })
const reply = (t: number, text: string): HistoryItem => ({ t, kind: 'assistant', blocks: [{ type: 'text', text }] })

let snapshot: Snapshot
let handlers: Record<string, ((p: any) => void)[]>
let history: Mock<(id: string) => Promise<HistoryItem[]>>
const emit = <K extends keyof EngineEventMap>(k: K, p: EngineEventMap[K]) => act(() => (handlers[k] ?? []).forEach(f => f(p)))
const settle = () => act(async () => { await new Promise(r => setTimeout(r, 0)) })

beforeEach(() => {
  vi.resetModules()
  handlers = {}
  snapshot = {
    claudeMissing: false, rooms: [{ id: 'r1', name: '방', createdAt: 1 }],
    agents: [agent('w'), agent('p')],
    messages: [], requests: [], autoChainLimit: 3, allowBypass: false, usage: null,
  }
  history = vi.fn(async (id: string) => (id === 'w' ? [say(1, '하나'), reply(2, '둘')] : [say(1, '기획')]))
  ;(window as any).dure = {
    snapshot: async () => snapshot,
    history: (id: string) => history(id),
    describe: async () => ({ commands: [], models: [], permissionMode: 'default' }),
    sendUser: async () => {},
    on: (k: string, fn: (p: any) => void) => {
      ;(handlers[k] ??= []).push(fn)
      return () => {}
    },
  }
})
afterEach(() => {
  cleanup()
  vi.mocked(animate).mockClear()
})

async function renderPanel() {
  const { getStore } = await import('../../src/renderer/state/store')
  const { AgentPanel } = await import('../../src/renderer/panel/AgentPanel')
  await act(async () => { await getStore().init() })
  render(<AgentPanel />)
  await act(async () => { getStore().selectAgent('w') })
  await settle()
  return getStore()
}
const conv = () => screen.getByRole('region', { name: '대화' })
const lineCalls = () => vi.mocked(animate).mock.calls.filter(c => (c[0] as HTMLElement).hasAttribute?.('data-line'))

describe('대화 움직임 — 새 줄', () => {
  it('처음 그린 대화는 움직이지 않는다', async () => {
    allowMotion()
    await renderPanel()
    expect(conv().querySelectorAll('[data-line]').length).toBe(2)
    expect(lineCalls()).toHaveLength(0)
  })

  it('보는 동안 기록이 하나 늘면 그 줄만 260ms outQuint · y 12 · scale 0.98 에서 들어온다', async () => {
    allowMotion()
    await renderPanel()
    await emit('history', { agentId: 'w', item: say(3, '셋') })
    const calls = lineCalls()
    expect(calls).toHaveLength(1)
    expect(calls[0][0]).toBe(conv().querySelector('[data-line="2"]'))
    const p = calls[0][1] as any
    expect(p.opacity.from).toBe(0)
    expect(p.translateY.from).toBe(12)
    expect(p.scale.from).toBe(0.98)
    expect(p.duration).toBe(260)
    expect(p.ease).toBe('outQuint')
  })

  it('끝나면 transform 을 지운다(안쪽 fixed 목록의 기준이 되지 않게)', async () => {
    allowMotion()
    const restore = fastMotion(50)
    await renderPanel()
    await emit('history', { agentId: 'w', item: say(3, '셋') })
    const el = conv().querySelector('[data-line="2"]') as HTMLElement
    await waitFor(() => expect(el.style.transform).toBe(''), { timeout: 1500 })
    restore()
  })

  it('흐르는 글은 처음 생길 때 한 번만 — 글자가 늘어도 다시 들어오지 않는다', async () => {
    allowMotion()
    await renderPanel()
    await emit('agent-event', { agentId: 'w', event: { kind: 'text-delta', text: '가' } })
    expect(lineCalls().map(c => (c[0] as HTMLElement).getAttribute('data-line'))).toEqual(['live'])
    await emit('agent-event', { agentId: 'w', event: { kind: 'text-delta', text: '나다' } })
    await emit('agent-event', { agentId: 'w', event: { kind: 'text-delta', text: '라마' } })
    expect(lineCalls()).toHaveLength(1)
  })

  it('흐르던 글이 끝나 기록 줄이 되면 그 줄은 들어오지 않는다', async () => {
    allowMotion()
    await renderPanel()
    await emit('history', { agentId: 'w', item: say(3, '셋') })
    await emit('agent-event', { agentId: 'w', event: { kind: 'text-delta', text: '가나' } })
    vi.mocked(animate).mockClear()
    await emit('history', { agentId: 'w', item: reply(4, '가나') })
    expect(conv().querySelector('[data-line="3"]')).toBeTruthy()
    expect(lineCalls()).toHaveLength(0)
  })

  it('이전 대화 더 보기 · 기록 다시 받기 · 에이전트 바꾸기는 움직이지 않는다', async () => {
    allowMotion()
    history.mockImplementation(async () => Array.from({ length: 400 }, (_, i) => say(i + 1, `말${i}`)))
    const store = await renderPanel()
    await act(async () => { screen.getByRole('button', { name: /이전 대화 100개 더 보기/ }).click() })
    await settle()
    expect(lineCalls()).toHaveLength(0)
    await act(async () => { store.selectAgent('p') })
    await settle()
    expect(lineCalls()).toHaveLength(0)
  })

  it('움직임 줄이기면 animate 를 부르지 않는다', async () => {
    await renderPanel()
    await emit('history', { agentId: 'w', item: say(3, '셋') })
    await emit('agent-event', { agentId: 'w', event: { kind: 'text-delta', text: '가' } })
    expect(animate).not.toHaveBeenCalled()
  })
})

describe('대화 움직임 — 작업 중 줄', () => {
  const status = (s: 'working' | 'idle') =>
    emit('status', { agentId: 'w', status: s, errorText: null } as EngineEventMap['status'])

  it('보는 동안 생기면 들어오고, 끝나면 150ms 동안 남았다 사라진다', async () => {
    allowMotion()
    const restore = fastMotion(1)
    await renderPanel()
    await status('working')
    const row = screen.getByRole('status')
    const enter = vi.mocked(animate).mock.calls.find(c => c[0] === row)
    expect(enter).toBeTruthy()
    expect((enter![1] as any).translateY.from).toBe(12)
    await status('idle')
    expect(screen.getByRole('status')).toBe(row)
    expect(row.hasAttribute('inert')).toBe(true)
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull(), { timeout: 1500 })
    restore()
  })

  it('처음부터 일하던 중이면 그대로 — 움직이지 않는다', async () => {
    allowMotion()
    snapshot.agents = [agent('w', { status: 'working' }), agent('p')]
    await renderPanel()
    expect(screen.getByRole('status')).toBeTruthy()
    expect(vi.mocked(animate).mock.calls.find(c => (c[0] as HTMLElement).className === 'ci-work')).toBeUndefined()
  })
})
