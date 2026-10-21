import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act, fireEvent, cleanup, within, waitFor } from '@testing-library/react'
import { allowMotion, fastMotion } from './motion'
import type { Room } from '../../src/engine/types'
import type { AgentView, Snapshot } from '../../src/shared/ipcContract'

const room = (id: string, name: string): Room => ({ id, name, createdAt: 1 })
const agent = (id: string, roomId: string, name: string, pos = { x: 64, y: 64 }): AgentView => ({
  id, roomId, name, role: '역할', folder: 'C:\\w', sessionId: 's', started: false, auto: false, model: null,
  alwaysAllow: [], pos, color: null, effort: null, lastContext: null, bypassOn: false, effortNow: null, modelNow: null, status: 'idle', errorText: null, bypass: false, bypassBySettings: false, bypassPending: false, heldInput: 0, subagentsRunning: [],
})

let snapshot: Snapshot
let api: Record<'addRoom' | 'renameRoom' | 'removeRoom', ReturnType<typeof vi.fn>>

beforeEach(() => {
  vi.resetModules()
  localStorage.clear()
  snapshot = {
    claudeMissing: false,
    rooms: [room('r1', '여름 캠페인'), room('r2', '가을 행사'), room('r3', '빈 방')],
    agents: [agent('a1', 'r1', '기획'), agent('a2', 'r1', '웹 화면', { x: 384, y: 64 }), agent('b1', 'r2', '서버')],
    messages: [], requests: [], autoChainLimit: 3, allowBypass: false, usage: null,
  }
  // 엔진처럼 — 바뀐 방은 다음 스냅샷에 들어 있다(방 바뀜 이벤트는 없다)
  let next = 4
  api = {
    addRoom: vi.fn(async (name: string) => {
      if (!name.trim()) throw new Error('이름을 입력하세요')
      const r = room(`r${next++}`, name.trim())
      snapshot = { ...snapshot, rooms: [...snapshot.rooms, r] }
      return r
    }),
    renameRoom: vi.fn(async (id: string, name: string) => {
      snapshot = { ...snapshot, rooms: snapshot.rooms.map(r => (r.id === id ? { ...r, name: name.trim() } : r)) }
      return snapshot.rooms.find(r => r.id === id)
    }),
    removeRoom: vi.fn(async (id: string) => {
      snapshot = {
        ...snapshot,
        rooms: snapshot.rooms.filter(r => r.id !== id),
        agents: snapshot.agents.filter(a => a.roomId !== id),
      }
    }),
  }
  ;(window as any).dure = {
    ...api, snapshot: async () => snapshot, history: async () => [], on: () => () => {}, updateAgent: async () => ({}),
  }
})
afterEach(() => cleanup())

/** 기다리던 약속(refresh 등)이 다 풀리게 */
const settle = () => act(async () => { await new Promise(r => setTimeout(r, 0)) })

async function renderApp() {
  const { getStore } = await import('../../src/renderer/state/store')
  const { App } = await import('../../src/renderer/App')
  await act(async () => { await getStore().init() })
  render(<App />)
  return getStore()
}

/** 위 띠의 방 버튼(목록 안 같은 이름 줄과 헷갈리지 않게 aria-haspopup 으로 고른다) */
const roomButton = () => document.querySelector<HTMLButtonElement>('.top button[aria-haspopup]')!
const openList = () => {
  fireEvent.click(roomButton())
  return screen.getByRole('dialog', { name: '방' })
}

describe('RoomSwitcher — 방 고르기', () => {
  it('방 버튼을 누르면 방 목록 — 지금 방 표시·포커스, 다른 방을 고르면 그 방으로·고른 에이전트는 비운다', async () => {
    const store = await renderApp()
    act(() => store.selectAgent('a1'))
    expect(roomButton().textContent).toBe('여름 캠페인')
    const list = openList()
    const summer = within(list).getByRole('button', { name: '여름 캠페인' })
    const autumn = within(list).getByRole('button', { name: '가을 행사' })
    expect(within(list).getByRole('button', { name: '빈 방' })).toBeTruthy()
    expect(summer.getAttribute('aria-current')).toBe('true')
    expect(autumn.getAttribute('aria-current')).toBeNull()
    expect(document.activeElement).toBe(summer)

    // ↓ 로 다음 방
    fireEvent.keyDown(summer, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(autumn)

    fireEvent.click(autumn)
    expect(screen.queryByRole('dialog', { name: '방' })).toBeNull()
    expect(store.getState().roomId).toBe('r2')
    expect(store.getState().selectedAgentId).toBeNull()
    expect(roomButton().textContent).toBe('가을 행사')
    expect(document.activeElement).toBe(roomButton())
  })

  it('지금 방을 다시 고르면 그대로(고른 에이전트도 그대로)', async () => {
    const store = await renderApp()
    act(() => store.selectAgent('a1'))
    const list = openList()
    fireEvent.click(within(list).getByRole('button', { name: '여름 캠페인' }))
    expect(store.getState().roomId).toBe('r1')
    expect(store.getState().selectedAgentId).toBe('a1')
  })

  it('Esc 는 목록을 닫고 방 버튼으로 포커스, 바깥 누르기도 닫는다', async () => {
    await renderApp()
    const list = openList()
    fireEvent.keyDown(within(list).getByRole('button', { name: '여름 캠페인' }), { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: '방' })).toBeNull()
    expect(document.activeElement).toBe(roomButton())

    openList()
    fireEvent.pointerDown(document.body)
    expect(screen.queryByRole('dialog', { name: '방' })).toBeNull()
  })
})

describe('RoomSwitcher — 새 방', () => {
  it('새 방은 목록 안 입력칸 — 만들면 그 방으로 바뀌고 목록이 닫힌다', async () => {
    const store = await renderApp()
    const list = openList()
    fireEvent.click(within(list).getByRole('button', { name: '새 방' }))
    const input = within(list).getByRole('textbox', { name: '새 방 이름' }) as HTMLInputElement
    expect(document.activeElement).toBe(input)
    const make = within(list).getByRole('button', { name: '만들기' }) as HTMLButtonElement
    expect(make.disabled).toBe(true) // 이름이 비면 못 만든다
    fireEvent.change(input, { target: { value: '   ' } })
    expect(make.disabled).toBe(true)

    fireEvent.change(input, { target: { value: '겨울 준비' } })
    expect(make.disabled).toBe(false)
    await act(async () => { fireEvent.click(make) })
    await settle()
    expect(api.addRoom).toHaveBeenCalledWith('겨울 준비')
    expect(screen.queryByRole('dialog', { name: '방' })).toBeNull()
    expect(store.getState().roomId).toBe('r4')
    expect(roomButton().textContent).toBe('겨울 준비')
  })

  it('새 방 — 엔진 오류는 입력칸 아래 그대로, Esc 는 입력만 접는다', async () => {
    api.addRoom.mockRejectedValueOnce(new Error('저장하지 못했어요: 디스크가 가득 찼어요'))
    await renderApp()
    const list = openList()
    fireEvent.click(within(list).getByRole('button', { name: '새 방' }))
    const input = within(list).getByRole('textbox', { name: '새 방 이름' })
    fireEvent.change(input, { target: { value: '겨울 준비' } })
    await act(async () => { fireEvent.submit(input.closest('form')!) })
    await settle()
    expect(within(list).getByText('저장하지 못했어요: 디스크가 가득 찼어요')).toBeTruthy()
    expect(input.getAttribute('aria-invalid')).toBe('true')

    fireEvent.keyDown(input, { key: 'Escape' })
    expect(within(list).queryByRole('textbox')).toBeNull()
    expect(screen.getByRole('dialog', { name: '방' })).toBeTruthy() // 목록은 그대로
    expect(document.activeElement).toBe(within(list).getByRole('button', { name: '새 방' }))
  })

  it('방이 없을 때 빈 화면의 방 만들기 — 대화상자에서 이름을 적어 만든다', async () => {
    snapshot = { ...snapshot, rooms: [], agents: [] }
    const store = await renderApp()
    fireEvent.click(screen.getByRole('button', { name: '방 만들기' }))
    const dlg = screen.getByRole('dialog', { name: '새 방' })
    const input = within(dlg).getByRole('textbox', { name: '이름' })
    expect(document.activeElement).toBe(input)
    const make = within(dlg).getByRole('button', { name: '만들기' }) as HTMLButtonElement
    expect(make.disabled).toBe(true)
    fireEvent.change(input, { target: { value: '여름 캠페인' } })
    await act(async () => { fireEvent.click(make) })
    await settle()
    expect(api.addRoom).toHaveBeenCalledWith('여름 캠페인')
    expect(screen.queryByRole('dialog', { name: '새 방' })).toBeNull()
    expect(store.getState().roomId).toBe('r4')
    expect(roomButton().textContent).toBe('여름 캠페인')
    expect(screen.getByText('첫 에이전트를 추가해 보세요')).toBeTruthy()
  })
})

describe('RoomSwitcher — 방마다 메뉴', () => {
  const openRoomMenu = (list: HTMLElement, name: string) => {
    fireEvent.click(within(list).getByRole('button', { name: `${name} 메뉴` }))
    return screen.getByRole('menu', { name: `${name} 메뉴` })
  }

  it('이름 바꾸기 — 같은 줄에서 고치고 저장, Esc 는 저장하지 않는다', async () => {
    await renderApp()
    const list = openList()
    let menu = openRoomMenu(list, '가을 행사')
    fireEvent.click(within(menu).getByRole('menuitem', { name: '이름 바꾸기' }))
    expect(screen.queryByRole('menu')).toBeNull()
    let input = within(list).getByRole('textbox', { name: '방 이름' }) as HTMLInputElement
    expect(input.value).toBe('가을 행사')
    expect(document.activeElement).toBe(input)

    // Esc — 저장하지 않고 줄로 돌아간다(목록은 열린 채)
    fireEvent.change(input, { target: { value: '아무거나' } })
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(within(list).queryByRole('textbox')).toBeNull()
    expect(api.renameRoom).not.toHaveBeenCalled()
    expect(within(list).getByRole('button', { name: '가을 행사' })).toBeTruthy()

    menu = openRoomMenu(list, '가을 행사')
    fireEvent.click(within(menu).getByRole('menuitem', { name: '이름 바꾸기' }))
    input = within(list).getByRole('textbox', { name: '방 이름' }) as HTMLInputElement
    fireEvent.change(input, { target: { value: '가을 축제' } })
    await act(async () => { fireEvent.click(within(list).getByRole('button', { name: '저장' })) })
    await settle()
    expect(api.renameRoom).toHaveBeenCalledWith('r2', '가을 축제')
    const row = within(list).getByRole('button', { name: '가을 축제' })
    expect(document.activeElement).toBe(row)
    expect(screen.getByRole('dialog', { name: '방' })).toBeTruthy()
  })

  it('지우기는 확인을 거쳐야만 — 지금 방을 지우면 남은 첫 방으로, 고른 에이전트는 비운다', async () => {
    const store = await renderApp()
    act(() => store.selectAgent('a1'))
    let menu = openRoomMenu(openList(), '여름 캠페인')
    fireEvent.click(within(menu).getByRole('menuitem', { name: '지우기' }))
    expect(screen.queryByRole('dialog', { name: '방' })).toBeNull() // 목록은 닫고 확인만
    let dlg = screen.getByRole('alertdialog')
    expect(within(dlg).getByRole('heading').textContent).toBe('방 여름 캠페인을 지울까요?')
    expect(dlg.textContent).toContain('안의 에이전트 2개와 대화 기록도 지워져요.')
    fireEvent.click(within(dlg).getByRole('button', { name: '취소' }))
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(api.removeRoom).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(roomButton())

    menu = openRoomMenu(openList(), '여름 캠페인')
    fireEvent.click(within(menu).getByRole('menuitem', { name: '지우기' }))
    dlg = screen.getByRole('alertdialog')
    const confirm = within(dlg).getByRole('button', { name: '지우기' })
    expect(confirm.classList.contains('dng')).toBe(true)
    await act(async () => { fireEvent.click(confirm) })
    await settle()
    expect(api.removeRoom).toHaveBeenCalledTimes(1)
    expect(api.removeRoom).toHaveBeenCalledWith('r1')
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(store.getState().roomId).toBe('r2')
    expect(store.getState().selectedAgentId).toBeNull()
    expect(roomButton().textContent).toBe('가을 행사')
  })

  it('다른 방을 지워도 지금 방·고른 에이전트는 그대로 · 에이전트 없는 방은 덧붙임 없이 묻는다', async () => {
    const store = await renderApp()
    act(() => store.selectAgent('a1'))
    const menu = openRoomMenu(openList(), '빈 방')
    fireEvent.click(within(menu).getByRole('menuitem', { name: '지우기' }))
    const dlg = screen.getByRole('alertdialog')
    expect(within(dlg).getByRole('heading').textContent).toBe('방 빈 방을 지울까요?')
    expect(dlg.textContent).not.toContain('에이전트')
    await act(async () => { fireEvent.click(within(dlg).getByRole('button', { name: '지우기' })) })
    await settle()
    expect(api.removeRoom).toHaveBeenCalledWith('r3')
    expect(store.getState().roomId).toBe('r1')
    expect(store.getState().selectedAgentId).toBe('a1')
  })

  it('지우기에 실패하면 확인 대화상자에 엔진 문구', async () => {
    api.removeRoom.mockRejectedValueOnce(new Error('방을 찾을 수 없습니다: r2'))
    await renderApp()
    const menu = openRoomMenu(openList(), '가을 행사')
    fireEvent.click(within(menu).getByRole('menuitem', { name: '지우기' }))
    await act(async () => { fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: '지우기' })) })
    await settle()
    expect(within(screen.getByRole('alertdialog')).getByText('방을 찾을 수 없습니다: r2')).toBeTruthy()
  })

  it('움직임 — A 방 메뉴를 열었다가 B 방 메뉴를 열면, A 가 다 나간 뒤에도 B 메뉴 안을 스크롤해도 B 는 열린 채', async () => {
    allowMotion()
    await renderApp()
    const list = openList()
    openRoomMenu(list, '여름 캠페인')
    const b = openRoomMenu(list, '가을 행사')
    const restore = fastMotion()
    // A 메뉴는 나가는 동안 남았다가 떨어진다
    await waitFor(() => expect(document.querySelector('[role="menu"][aria-label="여름 캠페인 메뉴"]')).toBeNull(), { timeout: 1500 })
    restore()
    // 메뉴 안 스크롤은 닫지 않는다 — 방 메뉴 ref 가 B 를 가리켜야 '안'으로 안다
    fireEvent.scroll(b)
    expect(b.isConnected).toBe(true)
    expect(b.hasAttribute('inert')).toBe(false)
    expect(within(list).getByRole('button', { name: '가을 행사 메뉴' }).getAttribute('aria-expanded')).toBe('true')
  })

  it('방 메뉴는 Esc 로 닫히고 포커스는 … 버튼으로', async () => {
    await renderApp()
    const list = openList()
    const menu = openRoomMenu(list, '가을 행사')
    const first = within(menu).getByRole('menuitem', { name: '이름 바꾸기' })
    expect(document.activeElement).toBe(first)
    fireEvent.keyDown(first, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(screen.getByRole('dialog', { name: '방' })).toBeTruthy() // 목록은 그대로
    expect(document.activeElement).toBe(within(list).getByRole('button', { name: '가을 행사 메뉴' }))
  })
})
