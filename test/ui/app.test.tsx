import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act, fireEvent, cleanup } from '@testing-library/react'
import type { AgentView, Snapshot } from '../../src/shared/ipcContract'

const room = (id: string, name = id) => ({ id, name, createdAt: 1 })
const agent = (id: string, roomId: string, name: string): AgentView => ({
  id, roomId, name, role: '역할', folder: 'C:/w', sessionId: 's', started: false, auto: false, model: null,
  alwaysAllow: [], pos: { x: 0, y: 0 }, color: null, status: 'idle', errorText: null, bypass: false, heldInput: 0,
})

let snapshot: Snapshot
beforeEach(() => {
  vi.resetModules()
  localStorage.clear()
  snapshot = { claudeMissing: false, rooms: [], agents: [], messages: [], requests: [], autoChainLimit: 3 }
  ;(window as any).dure = {
    snapshot: async () => snapshot, history: async () => [], on: () => () => {}, updateAgent: async () => ({}),
  }
})
afterEach(() => cleanup())

async function renderApp() {
  const { getStore } = await import('../../src/renderer/state/store')
  const { App } = await import('../../src/renderer/App')
  await act(async () => { await getStore().init() })
  render(<App />)
  return getStore()
}

describe('App 셸', () => {
  it('claude 가 없으면 안내만, 에이전트 추가는 막힘', async () => {
    snapshot = { ...snapshot, claudeMissing: true, rooms: [room('r1')] }
    await renderApp()
    expect(screen.getByText('Claude Code 가 필요해요')).toBeTruthy()
    expect(screen.getByText('설치·로그인 안내는 곧 들어갑니다')).toBeTruthy()
    expect(screen.queryByRole('separator')).toBeNull()
    expect(screen.getByRole('button', { name: '에이전트 추가' })).toHaveProperty('disabled', true)
  })

  it('방이 없으면 첫 방 안내 + 방 만들기, 에이전트 추가는 막힘', async () => {
    await renderApp()
    expect(screen.getByText('첫 방을 만들어 보세요')).toBeTruthy()
    expect(screen.getByRole('button', { name: '방 만들기' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '에이전트 추가' })).toHaveProperty('disabled', true)
    expect(screen.queryByRole('separator')).toBeNull()
  })

  it('에이전트가 없으면 관계도 자리에 첫 에이전트 안내, 위 띠에 방 이름', async () => {
    snapshot = { ...snapshot, rooms: [room('r1', '여름 캠페인')] }
    await renderApp()
    expect(screen.getByText('두레')).toBeTruthy()
    expect(screen.getByRole('button', { name: '여름 캠페인' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '에이전트 추가' })).toHaveProperty('disabled', false)
    expect(screen.getByRole('button', { name: '설정' })).toBeTruthy()
    const map = screen.getByRole('main', { name: '관계도' })
    expect(map.textContent).toContain('첫 에이전트를 추가해 보세요')
    expect(screen.getByRole('button', { name: '추가' })).toBeTruthy()
    expect(screen.getByRole('separator')).toBeTruthy()
    expect(screen.getByRole('complementary', { name: '에이전트' })).toBeTruthy()
  })

  it('패널 이름은 고른 에이전트 이름, 다른 방의 에이전트는 세지 않는다', async () => {
    snapshot = {
      ...snapshot,
      rooms: [room('r1'), room('r2')],
      agents: [agent('a1', 'r1', '웹 화면'), agent('b1', 'r2', '서버')],
    }
    const store = await renderApp()
    expect(screen.queryByText('첫 에이전트를 추가해 보세요')).toBeNull()
    act(() => store.selectAgent('a1'))
    expect(screen.getByRole('complementary', { name: '웹 화면' })).toBeTruthy()
    act(() => store.selectAgent(null))
    expect(screen.getByRole('complementary', { name: '에이전트' })).toBeTruthy()
  })

  it('위 띠 버튼은 넘겨받은 처리를 부른다', async () => {
    const { TopBar } = await import('../../src/renderer/shell/TopBar')
    const onRoomMenu = vi.fn()
    const onAddAgent = vi.fn()
    const onSettings = vi.fn()
    render(<TopBar roomName="여름 캠페인" onRoomMenu={onRoomMenu} onAddAgent={onAddAgent} onSettings={onSettings} />)
    fireEvent.click(screen.getByRole('button', { name: '여름 캠페인' }))
    fireEvent.click(screen.getByRole('button', { name: '에이전트 추가' }))
    fireEvent.click(screen.getByRole('button', { name: '설정' }))
    expect(onRoomMenu).toHaveBeenCalledTimes(1)
    expect(onAddAgent).toHaveBeenCalledTimes(1)
    expect(onSettings).toHaveBeenCalledTimes(1)
  })

  it('빈 화면 버튼은 onAction 을 부른다', async () => {
    const { Empty } = await import('../../src/renderer/shell/Empty')
    const onAction = vi.fn()
    render(<Empty kind="room" onAction={onAction} />)
    fireEvent.click(screen.getByRole('button', { name: '방 만들기' }))
    expect(onAction).toHaveBeenCalledTimes(1)
  })
})
