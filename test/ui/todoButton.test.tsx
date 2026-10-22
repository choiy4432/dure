import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act, fireEvent, cleanup } from '@testing-library/react'
import type { AgentView, Snapshot } from '../../src/shared/ipcContract'
import type { PendingRequest, RelayMessage } from '../../src/engine/types'

const agent = (id: string, roomId: string): AgentView => ({
  id, roomId, name: id, role: '역할', folder: 'C:\w', sessionId: 's', started: false, auto: false, model: null,
  alwaysAllow: [], pos: { x: 64, y: 64 }, color: null, effort: null, lastContext: null, bypassOn: false, effortNow: null, modelNow: null, status: 'idle', errorText: null, bypass: false, bypassBySettings: false, bypassPending: false, heldInput: 0, subagentsRunning: [],
})
const ask = (id: string, agentId: string): PendingRequest => ({ id, agentId, toolName: 'Bash', input: {}, kind: 'permission', createdAt: 1 })
const msg = (id: string, to: string): RelayMessage => ({ id, roomId: 'r1', from: 'a1', to, text: 't', createdAt: 1, state: 'pending', updatedAt: 1 })

let snapshot: Snapshot
beforeEach(() => {
  vi.resetModules()
  localStorage.clear()
  snapshot = {
    claudeMissing: false,
    rooms: [{ id: 'r1', name: '여름', createdAt: 1 }],
    agents: [agent('a1', 'r1'), agent('a2', 'r1')],
    messages: [], requests: [], autoChainLimit: 3, allowBypass: false, notify: { asks: true, finished: false }, usage: null,
  }
  ;(window as any).dure = { snapshot: async () => snapshot, history: async () => [], on: () => () => {} }
})
afterEach(() => cleanup())

async function renderButton() {
  const { getStore } = await import('../../src/renderer/state/store')
  const { TodoButton } = await import('../../src/renderer/shell/TodoButton')
  await act(async () => { await getStore().init() })
  render(<TodoButton />)
  return getStore()
}

describe('TodoButton', () => {
  it('할 일 3 — 앰버 점', async () => {
    snapshot = { ...snapshot, requests: [ask('q1', 'a1')], messages: [msg('m1', 'a2'), msg('m2', 'a2')] }
    await renderButton()
    const b = screen.getByRole('button', { name: /할 일 3/ })
    expect(b.textContent).toBe('할 일 3')
    expect(b.getAttribute('aria-label')).toBe('할 일 3개 · 내 승인 필요 있음')
    expect(b.querySelector('.dot.a')).not.toBeNull()
    expect(b.querySelector('.dot.r')).toBeNull()
  })

  it('요청 없이 메시지만 있으면 빨간 점', async () => {
    snapshot = { ...snapshot, messages: [msg('m1', 'a2')] }
    await renderButton()
    const b = screen.getByRole('button', { name: /할 일 1/ })
    expect(b.querySelector('.dot.r')).not.toBeNull()
    expect(b.getAttribute('aria-label')).toBe('할 일 1개 · 받은 메시지만')
  })

  it('0 이면 할 일만 흐리게', async () => {
    await renderButton()
    const b = screen.getByRole('button', { name: '할 일' })
    expect(b.textContent).toBe('할 일')
    expect(b.classList.contains('muted')).toBe(true)
    expect(b.querySelector('.dot')).toBeNull()
  })

  it('누르면 고르기를 푼다 · 목록이 보이면 aria-pressed', async () => {
    const store = await renderButton()
    const b = screen.getByRole('button', { name: '할 일' })
    expect(b.getAttribute('aria-pressed')).toBe('true')
    act(() => store.selectAgent('a1'))
    expect(b.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(b)
    expect(store.getState().selectedAgentId).toBeNull()
    expect(b.getAttribute('aria-pressed')).toBe('true')
  })
})
