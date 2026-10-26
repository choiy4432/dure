import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act, fireEvent, cleanup, within } from '@testing-library/react'
import type { AgentView, Snapshot } from '../../src/shared/ipcContract'

const room = (id: string, name = id) => ({ id, name, createdAt: 1 })
const agent = (id: string, roomId: string, name: string): AgentView => ({
  id, roomId, name, role: '역할', folder: 'C:/w', sessionId: 's', started: false, auto: false, model: null,
  alwaysAllow: [], pos: { x: 0, y: 0 }, color: null, effort: null, lastContext: null, bypassOn: false, effortNow: null, modelNow: null, status: 'idle', errorText: null, bypass: false, bypassBySettings: false, bypassPending: false, heldInput: 0, planMode: false, hold: null, subagentsRunning: [],
})

let snapshot: Snapshot
beforeEach(() => {
  vi.resetModules()
  localStorage.clear()
  snapshot = { claudeMissing: false, rooms: [], agents: [], messages: [], requests: [], autoChainLimit: 3, allowBypass: false, notify: { asks: true, finished: false }, usage: null }
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
  it('claude 가 없으면 안내만, 에이전트 추가는 없다(관계도가 없다)', async () => {
    snapshot = { ...snapshot, claudeMissing: true, rooms: [room('r1')] }
    await renderApp()
    expect(screen.getByText('Claude Code 가 필요해요')).toBeTruthy()
    expect(screen.getByText('설치·로그인 안내는 곧 들어갑니다')).toBeTruthy()
    expect(screen.queryByRole('separator')).toBeNull()
    expect(screen.queryByRole('button', { name: '에이전트 추가' })).toBeNull()
  })

  it('방이 없으면 첫 방 안내 + 방 만들기, 에이전트 추가는 없다', async () => {
    await renderApp()
    expect(screen.getByText('첫 방을 만들어 보세요')).toBeTruthy()
    expect(screen.getByRole('button', { name: '방 만들기' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: '에이전트 추가' })).toBeNull()
    expect(screen.queryByRole('separator')).toBeNull()
  })

  it('에이전트가 없으면 관계도 자리에 첫 에이전트 안내, 위 띠에 방 이름', async () => {
    snapshot = { ...snapshot, rooms: [room('r1', '여름 캠페인')] }
    await renderApp()
    expect(screen.getByRole('img', { name: '두레' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '여름 캠페인' })).toBeTruthy()
    // 에이전트가 없는 방은 빈 화면의 '추가'가 그 자리 — 관계도 단추는 카드가 생긴 뒤에
    expect(screen.queryByRole('button', { name: '에이전트 추가' })).toBeNull()
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

  it('위 띠 버튼은 넘겨받은 처리를 부른다 — 방 버튼은 방 목록을 연다', async () => {
    snapshot = { ...snapshot, rooms: [room('r1', '여름 캠페인')] }
    const { getStore } = await import('../../src/renderer/state/store')
    const { TopBar } = await import('../../src/renderer/shell/TopBar')
    await act(async () => { await getStore().init() })
    const onSettings = vi.fn()
    render(<TopBar hasRoom onSettings={onSettings} />)
    const roomButton = screen.getByRole('button', { name: '여름 캠페인' })
    expect(roomButton.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(roomButton)
    expect(roomButton.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByRole('dialog', { name: '방' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '설정' }))
    expect(onSettings).toHaveBeenCalledTimes(1)
    // 위 띠엔 사용량·에이전트 추가가 없다 — 아래 상태 띠·관계도로 갔다
    expect(screen.queryByRole('button', { name: '에이전트 추가' })).toBeNull()
    expect(document.querySelector('.top .usg-wrap')).toBeNull()
  })

  it('위 띠는 창 제목 표시줄 — 끌어 옮기는 자리라 표시해 둔다', async () => {
    snapshot = { ...snapshot, rooms: [room('r1', '여름 캠페인')] }
    await renderApp()
    expect(document.querySelector('header.top')).toBeTruthy()
  })

  it('에이전트가 있으면 관계도 오른쪽 아래에 에이전트 추가(확대 조절 줄과 따로) — 누르면 추가 대화상자', async () => {
    snapshot = { ...snapshot, rooms: [room('r1')], agents: [agent('a1', 'r1', '웹 화면')] }
    ;(window as any).dure.pickFolder = async () => null
    await renderApp()
    const map = screen.getByRole('main', { name: '관계도' })
    const add = within(map).getByRole('button', { name: '에이전트 추가' })
    const zoom = within(map).getByRole('group', { name: '확대 조절' })
    expect(add.classList.contains('mbr')).toBe(true)
    expect(zoom.parentElement!.contains(add)).toBe(false)
    fireEvent.click(add)
    expect(screen.getByRole('dialog', { name: '에이전트 추가' })).toBeTruthy()
  })

  it('사용량은 창 맨 아래 상태 띠 왼쪽에 — 펼침은 위로 연다', async () => {
    snapshot = {
      ...snapshot, rooms: [room('r1')],
      usage: { windows: [{ key: 'session', label: '5시간', percent: 12, resetsAt: null }], at: Date.now() },
    }
    ;(window as any).dure.refreshUsage = async () => {}
    await renderApp()
    const bar = screen.getByRole('contentinfo')
    const button = within(bar).getByRole('button', { expanded: false })
    fireEvent.click(button)
    expect(within(bar).getByRole('dialog', { name: '사용량' }).classList.contains('up')).toBe(true)
  })

  it('설정은 claude 가 없으면 막힘', async () => {
    snapshot = { ...snapshot, claudeMissing: true }
    await renderApp()
    expect(screen.getByRole('button', { name: '설정' })).toHaveProperty('disabled', true)
  })

  it('처음 상태를 못 받으면 불러오기 오류와 다시 시도 — 첫 방 안내는 보이지 않는다', async () => {
    const snap = vi.fn()
      .mockRejectedValueOnce(new Error('연결이 끊겼어요'))
      .mockRejectedValueOnce(new Error('아직 끊겨 있어요'))
      .mockImplementation(async () => snapshot)
    ;(window as any).dure.snapshot = snap
    const { getStore } = await import('../../src/renderer/state/store')
    const { App } = await import('../../src/renderer/App')
    await act(async () => { await getStore().init().catch(() => {}) })
    render(<App />)
    expect(screen.getByText('두레를 불러오지 못했어요')).toBeTruthy()
    expect(screen.getByText('연결이 끊겼어요')).toBeTruthy()
    expect(screen.queryByText('첫 방을 만들어 보세요')).toBeNull()
    expect(screen.queryByRole('button', { name: '에이전트 추가' })).toBeNull()
    expect(screen.getByRole('button', { name: '설정' })).toHaveProperty('disabled', true)

    // 다시 시도 — 또 실패하면 새 문구
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '다시 시도' })) })
    expect(screen.getByText('아직 끊겨 있어요')).toBeTruthy()
    expect(screen.getByRole('button', { name: '다시 시도' })).toHaveProperty('disabled', false)

    // 받으면 평소 화면(방이 없으니 첫 방 안내)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '다시 시도' })) })
    expect(screen.queryByText('두레를 불러오지 못했어요')).toBeNull()
    expect(screen.getByText('첫 방을 만들어 보세요')).toBeTruthy()
    expect(snap).toHaveBeenCalledTimes(3)
  })

  it('불러오기 오류 문구 — 한글이 없는 원문(IPC 등)은 한국어 안내를 본문으로, 원문은 접힌 "자세히" 안에만', async () => {
    const raw = "Error invoking remote method 'dure:invoke': Error: No handler registered for 'dure:invoke'"
    ;(window as any).dure.snapshot = vi.fn().mockRejectedValueOnce(new Error(raw)).mockImplementation(async () => snapshot)
    const { getStore } = await import('../../src/renderer/state/store')
    const { App } = await import('../../src/renderer/App')
    await act(async () => { await getStore().init().catch(() => {}) })
    render(<App />)
    const card = screen.getByRole('alert')
    expect(within(card).getByText('두레를 불러오지 못했어요')).toBeTruthy()
    const main = within(card).getByText('잠시 뒤 다시 시도해 주세요. 계속 안 되면 두레를 껐다 켜 주세요.')
    expect(main.classList.contains('empty-d')).toBe(true)
    expect(within(card).getByRole('button', { name: '다시 시도' })).toBeTruthy()

    // 처음엔 접혀 있다 — 원문은 화면에 없다
    const more = within(card).getByRole('button', { name: '자세히' })
    expect(more.getAttribute('aria-expanded')).toBe('false')
    expect(within(card).queryByText(raw)).toBeNull()

    // 펼치면 작은 mono 줄로, 다시 누르면 접힌다
    fireEvent.click(more)
    expect(more.getAttribute('aria-expanded')).toBe('true')
    const detail = within(card).getByText(raw)
    expect(detail.classList.contains('empty-x')).toBe(true)
    expect(more.getAttribute('aria-controls')).toBe(detail.id)
    fireEvent.click(more)
    expect(within(card).queryByText(raw)).toBeNull()
  })

  it('불러오기 오류 문구 — 한글 원문(엔진 문구)은 그대로 본문, 일반 안내·작은 줄은 없다', async () => {
    ;(window as any).dure.snapshot = vi.fn().mockRejectedValueOnce(new Error('설정 파일을 읽지 못했어요')).mockImplementation(async () => snapshot)
    const { getStore } = await import('../../src/renderer/state/store')
    const { App } = await import('../../src/renderer/App')
    await act(async () => { await getStore().init().catch(() => {}) })
    render(<App />)
    const card = screen.getByRole('alert')
    expect(within(card).getByText('설정 파일을 읽지 못했어요').classList.contains('empty-d')).toBe(true)
    expect(within(card).queryByText('잠시 뒤 다시 시도해 주세요. 계속 안 되면 두레를 껐다 켜 주세요.')).toBeNull()
    expect(card.querySelector('.empty-x')).toBeNull()
    expect(within(card).queryByRole('button', { name: '자세히' })).toBeNull()
  })

  it('빈 화면 버튼은 onAction 을 부른다', async () => {
    const { Empty } = await import('../../src/renderer/shell/Empty')
    const onAction = vi.fn()
    render(<Empty kind="room" onAction={onAction} />)
    fireEvent.click(screen.getByRole('button', { name: '방 만들기' }))
    expect(onAction).toHaveBeenCalledTimes(1)
  })

  it('빈 화면의 추가는 에이전트 추가 대화상자를 연다', async () => {
    snapshot = { ...snapshot, rooms: [room('r1', '여름 캠페인')] }
    ;(window as any).dure.pickFolder = async () => null
    await renderApp()
    fireEvent.click(screen.getByRole('button', { name: '추가' }))
    expect(screen.getByRole('dialog', { name: '에이전트 추가' })).toBeTruthy()
  })
})
