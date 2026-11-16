import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { render, screen, act, fireEvent, cleanup } from '@testing-library/react'

// 파워 모드 옆 칸 — [대화 | 기록]. 대화 = 고른 에이전트의 진짜 대화 패널(AgentPanel 그대로), 기록 = 실시간 기록.
// 아무도 안 골랐으면 기록, 고르면 대화

const agent = (id: string, name: string) => ({
  id, roomId: 'r1', name, role: '역할', folder: '/x', sessionId: '', started: true, auto: false, model: null,
  alwaysAllow: [], pos: { x: 0, y: 0 }, color: null, effort: null, effortNow: null, modelNow: null, lastContext: null, bypassOn: false, status: 'idle',
  errorText: null, bypass: false, bypassBySettings: false, bypassPending: false, heldInput: 0, planMode: false, asleep: false, waking: false, hold: null,
  subagentsRunning: [], pastCount: 0, remoteIssue: null,
})

beforeEach(() => {
  vi.resetModules()
  ;(window as any).dure = {
    snapshot: async () => ({
      claudeMissing: false, rooms: [{ id: 'r1', name: '방', createdAt: 1 }], agents: [agent('a', '알파'), agent('b', '베타')],
      messages: [], requests: [], autoChainLimit: 3, allowBypass: false, notify: { asks: true, finished: false }, sleepAfterMin: 30, usage: null,
    }),
    history: async () => [],
    setSelected: async () => {},
    setPowerMode: async () => {},
    on: () => () => {},
  }
})
afterEach(() => cleanup())

async function mount() {
  const { getStore } = await import('../../src/renderer/state/store')
  const { SidePanel } = await import('../../src/renderer/power/SidePanel')
  const store = getStore()
  await act(async () => { await store.init() })
  act(() => { store.selectRoom('r1') })
  await act(async () => { await store.setPower(true) })
  render(<SidePanel log={<p>기록 줄</p>} />)
  return store
}

const tab = (name: '대화' | '기록') => screen.getByRole('tab', { name })
const composer = (name: string) => screen.queryByRole('textbox', { name: `${name}에게 보낼 메시지` })

describe('옆 칸', () => {
  it('고른 에이전트가 없으면 기록 — 대화 탭은 막혀 있다', async () => {
    await mount()
    expect(tab('기록')).toHaveAttribute('aria-selected', 'true')
    expect(tab('대화')).toHaveAttribute('aria-selected', 'false')
    expect(tab('대화')).toBeDisabled()
    expect(screen.getByText('기록 줄')).toBeVisible()
    expect(document.querySelector('.pnl')).toBeNull()
  })

  it('고르면 대화 — 그 에이전트의 AgentPanel(입력창이 있다)', async () => {
    const store = await mount()
    act(() => { store.selectAgent('b') })
    expect(tab('대화')).toHaveAttribute('aria-selected', 'true')
    expect(tab('대화')).toBeEnabled()
    expect(composer('베타')).toBeInTheDocument()
    expect(screen.getByRole('complementary', { name: '베타' })).toBeInTheDocument()
    expect(screen.getByText('기록 줄')).not.toBeVisible()
  })

  it('기록 탭을 누르면 실시간 기록 · 대화 탭을 누르면 다시 대화', async () => {
    const store = await mount()
    act(() => { store.selectAgent('a') })
    fireEvent.click(tab('기록'))
    expect(tab('기록')).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByText('기록 줄')).toBeVisible()
    expect(composer('알파')).toBeNull()
    fireEvent.click(tab('대화'))
    expect(composer('알파')).toBeInTheDocument()
  })

  it('기록을 보는 중에 다른 에이전트를 고르면 대화로', async () => {
    const store = await mount()
    act(() => { store.selectAgent('a') })
    fireEvent.click(tab('기록'))
    act(() => { store.selectAgent('b') })
    expect(tab('대화')).toHaveAttribute('aria-selected', 'true')
    expect(composer('베타')).toBeInTheDocument()
  })

  it('기록을 보는 중에 같은 에이전트를 다시 골라도(카드 클릭 = 입력창 커서 요청) 대화로', async () => {
    const store = await mount()
    act(() => { store.selectAgent('a', { focusInput: true }) })
    fireEvent.click(tab('기록'))
    act(() => { store.selectAgent('a', { focusInput: true }) })
    expect(tab('대화')).toHaveAttribute('aria-selected', 'true')
    expect(composer('알파')).toBeInTheDocument()
  })

  it('고르기를 풀면 기록으로', async () => {
    const store = await mount()
    act(() => { store.selectAgent('a') })
    act(() => { store.selectAgent(null) })
    expect(tab('기록')).toHaveAttribute('aria-selected', 'true')
    expect(tab('대화')).toBeDisabled()
  })

  it('←/→ 로 탭을 옮긴다(고른 탭만 Tab 으로 닿는다)', async () => {
    const store = await mount()
    act(() => { store.selectAgent('a') })
    expect(tab('대화')).toHaveAttribute('tabindex', '0')
    expect(tab('기록')).toHaveAttribute('tabindex', '-1')
    tab('대화').focus()
    fireEvent.keyDown(tab('대화'), { key: 'ArrowRight' })
    expect(tab('기록')).toHaveAttribute('aria-selected', 'true')
    expect(document.activeElement).toBe(tab('기록'))
  })
})
