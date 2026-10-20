import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act, cleanup, waitFor } from '@testing-library/react'
import { animate } from 'animejs'
import type { EngineEventMap, PendingRequest } from '../../src/engine/types'
import type { AgentView, Snapshot } from '../../src/shared/ipcContract'
import { allowMotion, fastMotion } from './motion'

vi.mock('animejs', async orig => {
  const m = await orig<typeof import('animejs')>()
  return { ...m, animate: vi.fn(m.animate) }
})

const agent = (id: string): AgentView => ({
  id, roomId: 'r1', name: id, role: '역할', folder: 'C:\w', sessionId: 's', started: true, auto: false, model: null,
  alwaysAllow: [], pos: { x: 64, y: 64 }, color: null, effort: null, lastContext: null, effortNow: null, modelNow: null, status: 'idle', errorText: null, bypass: false, heldInput: 0,
})
const perm = (id: string, agentId = 'w'): PendingRequest => ({
  id, agentId, toolName: 'Edit', input: { file_path: 'C:\w\a.css' }, kind: 'permission', createdAt: Date.now(),
})
const ask = (id: string, agentId = 'w'): PendingRequest => ({
  id, agentId, toolName: 'AskUserQuestion', kind: 'question', createdAt: Date.now(),
  input: { questions: [{ question: '색은?', header: '색', options: [{ label: '파랑', description: '' }], multiSelect: false }] },
})

let snapshot: Snapshot
let handlers: Record<string, ((p: any) => void)[]>
const answerRequest = vi.fn(async () => {})
const emit = <K extends keyof EngineEventMap>(k: K, p: EngineEventMap[K]) => act(() => (handlers[k] ?? []).forEach(f => f(p)))
const settle = () => act(async () => { await new Promise(r => setTimeout(r, 0)) })

beforeEach(() => {
  vi.resetModules()
  answerRequest.mockClear()
  handlers = {}
  snapshot = {
    claudeMissing: false, rooms: [{ id: 'r1', name: '방', createdAt: 1 }],
    agents: [agent('w'), agent('p')],
    messages: [], requests: [], autoChainLimit: 3, usage: null,
  }
  ;(window as any).dure = {
    snapshot: async () => snapshot,
    history: async () => [],
    describe: async () => ({ commands: [], models: [], permissionMode: 'default' }),
    answerRequest,
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
const pins = () => document.querySelector('.pnl-pins') as HTMLElement
const pinCalls = () => vi.mocked(animate).mock.calls.filter(c => (c[0] as HTMLElement).classList?.contains('pin'))

describe('위에 붙는 카드 움직임', () => {
  it('패널을 열 때 이미 있던 카드는 움직이지 않는다', async () => {
    allowMotion()
    snapshot.requests = [perm('a'), ask('b')]
    await renderPanel()
    expect(pins().querySelectorAll('.pin')).toHaveLength(2)
    expect(pinCalls()).toHaveLength(0)
  })

  it('보는 동안 승인 요청이 오면 그 카드가 260ms 로 들어온다', async () => {
    allowMotion()
    await renderPanel()
    await emit('request', perm('a'))
    const calls = pinCalls()
    expect(calls).toHaveLength(1)
    expect(calls[0][0]).toBe(pins().querySelector('.pin'))
    const p = calls[0][1] as any
    expect(p.opacity.from).toBe(0)
    expect(p.translateY.from).toBe(12)
    expect(p.scale.from).toBe(0.98)
    expect(p.duration).toBe(260)
    expect(p.ease).toBe('outQuint')
  })

  it('허락·거절로 요청이 사라지면 카드는 마지막 내용 그대로 150ms 남아 inert, 그 뒤 사라진다', async () => {
    allowMotion()
    const restore = fastMotion(50)
    snapshot.requests = [perm('a')]
    await renderPanel()
    const before = pins().querySelector('.pin')!.textContent
    vi.mocked(animate).mockClear()
    await emit('request-resolved', { id: 'a', agentId: 'w' })
    const el = pins().querySelector('.pin') as HTMLElement
    expect(el).toBeTruthy()
    expect(el.textContent).toBe(before)
    expect(el.hasAttribute('inert')).toBe(true)
    const p = pinCalls().at(-1)![1] as any
    expect(p.translateY).toBe(-6)
    expect(p.opacity).toBe(0)
    expect(p.scale).toBe(0.98)
    expect(p.duration).toBe(150)
    expect(p.ease).toBe('outCubic')
    await waitFor(() => expect(pins().querySelector('.pin')).toBeNull(), { timeout: 1500 })
    restore()
  })

  it('하나가 나가는 동안 새 질문 카드가 오면 둘 다 있고 새 카드는 눌린다', async () => {
    allowMotion()
    snapshot.requests = [perm('a')]
    await renderPanel()
    await emit('request-resolved', { id: 'a', agentId: 'w' })
    await emit('request', ask('b'))
    const cards = pins().querySelectorAll('.pin')
    expect(cards).toHaveLength(2)
    const [old, fresh] = Array.from(cards) as HTMLElement[]
    expect(old.hasAttribute('inert')).toBe(true)
    expect(fresh.hasAttribute('inert')).toBe(false)
    expect(fresh.style.pointerEvents).toBe('')
    expect(screen.getByRole('button', { name: '대답 안 함' })).toBeTruthy()
  })

  it('에이전트를 바꾸면 새 에이전트의 카드는 들어오지 않고 옛 카드도 남지 않는다', async () => {
    allowMotion()
    snapshot.requests = [perm('a', 'w'), ask('b', 'p')]
    const store = await renderPanel()
    vi.mocked(animate).mockClear()
    await act(async () => { store.selectAgent('p') })
    await settle()
    expect(pins().querySelectorAll('.pin')).toHaveLength(1)
    expect(pins().querySelector('.pin')!.getAttribute('aria-label')).toBe('질문이 있어요')
    expect(pinCalls()).toHaveLength(0)
  })

  it('움직임 줄이기면 animate 를 부르지 않고 바로 사라진다', async () => {
    await renderPanel()
    await emit('request', perm('a'))
    expect(animate).not.toHaveBeenCalled()
    await emit('request-resolved', { id: 'a', agentId: 'w' })
    expect(pins().querySelector('.pin')).toBeNull()
  })
})
