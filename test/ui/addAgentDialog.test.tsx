import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act, fireEvent, cleanup, within } from '@testing-library/react'
import type { Agent } from '../../src/engine/types'
import type { AgentView, Snapshot } from '../../src/shared/ipcContract'
import { placeNew } from '../../src/renderer/map/layout'

const agent = (id: string, roomId: string, name: string, pos: { x: number; y: number }): AgentView => ({
  id, roomId, name, role: '역할', folder: 'C:\\w', sessionId: 's', started: false, auto: false, model: null,
  alwaysAllow: [], pos, color: null, effort: null, lastContext: null, bypassOn: false, effortNow: null, modelNow: null, status: 'idle', errorText: null, bypass: false, bypassBySettings: false, bypassPending: false, heldInput: 0, planMode: false, asleep: false, waking: false, hold: null, subagentsRunning: [],
})

let snapshot: Snapshot
let api: Record<'addAgent' | 'updateAgent' | 'pickFolder', ReturnType<typeof vi.fn>>

beforeEach(() => {
  vi.resetModules()
  localStorage.clear()
  snapshot = {
    claudeMissing: false,
    rooms: [{ id: 'r1', name: '여름 캠페인', createdAt: 1 }, { id: 'r2', name: '가을 행사', createdAt: 2 }],
    agents: [
      agent('a1', 'r1', '기획', { x: 64, y: 64 }),
      agent('a2', 'r1', '웹 화면', { x: 424, y: 64 }),
      agent('b1', 'r2', '서버', { x: 784, y: 64 }), // 다른 방 — 자리 셈에 들지 않는다
    ],
    messages: [], requests: [], autoChainLimit: 3, allowBypass: false, notify: { asks: true, finished: false }, sleepAfterMin: 30, usage: null,
  }
  // 엔진처럼 — 이름 겹침·없는 폴더는 엔진 문구로 거절, 새 에이전트 자리는 {0,0}
  api = {
    pickFolder: vi.fn(async () => 'C:\\work\\summer'),
    addAgent: vi.fn(async (i: { roomId: string; name: string; role: string; folder: string }) => {
      if (snapshot.agents.some(a => a.roomId === i.roomId && a.name === i.name.trim())) {
        throw new Error(`이미 있는 이름입니다: ${i.name.trim()}`)
      }
      if (i.folder === 'C:\\gone') throw new Error(`폴더를 찾을 수 없습니다: ${i.folder}`)
      const a: AgentView = { ...agent('n1', i.roomId, i.name.trim(), { x: 0, y: 0 }), role: i.role, folder: i.folder }
      snapshot = { ...snapshot, agents: [...snapshot.agents, a] }
      const { status: _s, errorText: _e, bypass: _b, heldInput: _h, ...plain } = a
      return plain as Agent
    }),
    updateAgent: vi.fn(async (id: string, p: Partial<AgentView>) => {
      snapshot = { ...snapshot, agents: snapshot.agents.map(a => (a.id === id ? { ...a, ...p } : a)) }
      return snapshot.agents.find(a => a.id === id)
    }),
  }
  ;(window as any).dure = { ...api, snapshot: async () => snapshot, history: async () => [], on: () => () => {} }
})
afterEach(() => cleanup())

const settle = () => act(async () => { await new Promise(r => setTimeout(r, 0)) })

async function renderApp() {
  const { getStore } = await import('../../src/renderer/state/store')
  const { App } = await import('../../src/renderer/App')
  await act(async () => { await getStore().init() })
  render(<App />)
  return getStore()
}

const openDialog = () => {
  const opener = screen.getByRole('button', { name: '에이전트 추가' })
  opener.focus()
  fireEvent.click(opener)
  return { dlg: screen.getByRole('dialog', { name: '에이전트 추가' }), opener }
}

async function fill(dlg: HTMLElement, v: { name?: string; role?: string; pick?: boolean }) {
  if (v.pick !== false) await act(async () => { fireEvent.click(within(dlg).getByRole('button', { name: '폴더 고르기' })) })
  if (v.name !== undefined) fireEvent.change(within(dlg).getByRole('textbox', { name: '이름' }), { target: { value: v.name } })
  if (v.role !== undefined) fireEvent.change(within(dlg).getByRole('textbox', { name: '역할' }), { target: { value: v.role } })
}

describe('AddAgentDialog', () => {
  it('첫 입력에 포커스 · 폴더·이름·역할이 다 있어야 추가가 켜진다 · 고른 폴더는 mono 로', async () => {
    await renderApp()
    const { dlg } = openDialog()
    const name = within(dlg).getByRole('textbox', { name: '이름' })
    const role = within(dlg).getByRole('textbox', { name: '역할' }) as HTMLInputElement
    expect(document.activeElement).toBe(name)
    expect(role.placeholder).toBe('예: 기획서 · 문구')
    const add = within(dlg).getByRole('button', { name: '추가' }) as HTMLButtonElement
    expect(add.disabled).toBe(true)

    // 이름·역할만으로는 안 된다
    await fill(dlg, { pick: false, name: '디자인', role: '시안 · 스타일' })
    expect(add.disabled).toBe(true)

    await fill(dlg, {})
    expect(api.pickFolder).toHaveBeenCalledTimes(1)
    const path = within(dlg).getByText('C:\\work\\summer')
    expect(path.classList.contains('f')).toBe(true)
    expect(add.disabled).toBe(false)

    // 역할이 빈칸뿐이면 다시 막힌다
    await fill(dlg, { pick: false, role: '   ' })
    expect(add.disabled).toBe(true)
    await fill(dlg, { pick: false, role: '시안 · 스타일', name: '  ' })
    expect(add.disabled).toBe(true)

    // 폴더 고르기를 취소(null)하면 고른 폴더는 그대로
    api.pickFolder.mockResolvedValueOnce(null)
    await fill(dlg, { name: '디자인' })
    expect(within(dlg).getByText('C:\\work\\summer')).toBeTruthy()
    expect(add.disabled).toBe(false)
  })

  it('폴더를 고르는 동안 버튼은 막지 않는다(포커스가 body 로 떨어지지 않게) — 두 번 눌러도 한 번만 연다', async () => {
    let done!: (p: string | null) => void
    api.pickFolder.mockImplementationOnce(() => new Promise<string | null>(r => { done = r }))
    await renderApp()
    const { dlg } = openDialog()
    const pick = within(dlg).getByRole('button', { name: '폴더 고르기' }) as HTMLButtonElement
    pick.focus()
    await act(async () => { fireEvent.click(pick) })
    expect(pick.disabled).toBe(false)
    await act(async () => { fireEvent.click(pick) })
    expect(api.pickFolder).toHaveBeenCalledTimes(1)
    await act(async () => { done('C:\\work\\summer') })
    expect(document.activeElement).toBe(pick)
    expect(within(dlg).getByText('C:\\work\\summer')).toBeTruthy()
  })

  it('추가하면 닫히고 그 에이전트를 고른다 — 자리는 방의 카드와 겹치지 않는 칸에 한 번 저장', async () => {
    const store = await renderApp()
    const { dlg } = openDialog()
    await fill(dlg, { name: '디자인 ', role: ' 시안 · 스타일 ' })
    await act(async () => { fireEvent.click(within(dlg).getByRole('button', { name: '추가' })) })
    await settle()
    expect(api.addAgent).toHaveBeenCalledWith({ roomId: 'r1', name: '디자인', role: '시안 · 스타일', folder: 'C:\\work\\summer' })
    expect(screen.queryByRole('dialog', { name: '에이전트 추가' })).toBeNull()
    expect(store.getState().selectedAgentId).toBe('n1')
    expect(screen.getByRole('complementary', { name: '디자인' })).toBeTruthy()

    const expected = placeNew([{ x: 64, y: 64 }, { x: 424, y: 64 }])
    expect(expected).toEqual({ x: 784, y: 64 })
    // 관계도가 {0,0} 을 보고 또 정해 저장하지 않는다 — 저장은 한 번
    expect(api.updateAgent).toHaveBeenCalledTimes(1)
    expect(api.updateAgent).toHaveBeenCalledWith('n1', { pos: expected })
    expect(store.getState().agents.find(a => a.id === 'n1')!.pos).toEqual(expected)
  })

  it('엔진 오류는 해당 칸 아래 빨간 글로 — 이름 겹침은 해요체 안내와 다음 할 일, 없는 폴더는 그대로, 대화상자는 열린 채', async () => {
    await renderApp()
    const { dlg } = openDialog()
    await fill(dlg, { name: '기획', role: '기획서 · 문구' })
    await act(async () => { fireEvent.click(within(dlg).getByRole('button', { name: '추가' })) })
    await settle()
    expect(within(dlg).queryByText('이미 있는 이름입니다: 기획')).toBeNull() // 엔진 원문은 보이지 않는다
    const nameError = within(dlg).getByText('‘기획’이라는 에이전트가 이미 있어요. 다른 이름을 써 주세요.')
    expect(nameError.classList.contains('fe')).toBe(true)
    const name = within(dlg).getByRole('textbox', { name: '이름' })
    expect(nameError.closest('.fld')!.contains(name)).toBe(true)
    expect(name.getAttribute('aria-invalid')).toBe('true')
    expect(document.activeElement).toBe(name)
    expect(screen.getByRole('dialog', { name: '에이전트 추가' })).toBeTruthy()

    // 이름을 고치면 그 문구는 사라진다
    fireEvent.change(name, { target: { value: '디자인' } })
    expect(within(dlg).queryByText('‘기획’이라는 에이전트가 이미 있어요. 다른 이름을 써 주세요.')).toBeNull()

    api.pickFolder.mockResolvedValueOnce('C:\\gone')
    await fill(dlg, {})
    await act(async () => { fireEvent.click(within(dlg).getByRole('button', { name: '추가' })) })
    await settle()
    const folderError = within(dlg).getByText('폴더를 찾을 수 없습니다: C:\\gone')
    expect(folderError.classList.contains('fe')).toBe(true)
    expect(folderError.closest('.fld')!.contains(within(dlg).getByRole('button', { name: '폴더 고르기' }))).toBe(true)
    expect(name.getAttribute('aria-invalid')).toBeNull()
    expect(api.updateAgent).not.toHaveBeenCalled()
  })

  it('어느 칸에도 맞지 않는 엔진 오류는 버튼 위에', async () => {
    api.addAgent.mockRejectedValueOnce(new Error('방을 찾을 수 없습니다: r1'))
    await renderApp()
    const { dlg } = openDialog()
    await fill(dlg, { name: '디자인', role: '시안' })
    await act(async () => { fireEvent.click(within(dlg).getByRole('button', { name: '추가' })) })
    await settle()
    expect(within(dlg).getByText('방을 찾을 수 없습니다: r1').classList.contains('dlg-err')).toBe(true)
  })

  it('Esc·바깥 누르기·취소로 닫히고 포커스는 연 버튼으로 · Tab 은 대화상자 안에서만 돈다', async () => {
    await renderApp()
    let { dlg, opener } = openDialog()
    const pick = within(dlg).getByRole('button', { name: '폴더 고르기' })
    const cancel = within(dlg).getByRole('button', { name: '취소' })
    // 추가는 막혀 있으니 마지막 칸은 취소
    cancel.focus()
    fireEvent.keyDown(cancel, { key: 'Tab' })
    expect(document.activeElement).toBe(pick)
    fireEvent.keyDown(pick, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(cancel)

    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(opener)

    ;({ dlg, opener } = openDialog())
    fireEvent.pointerDown(within(dlg).getByRole('textbox', { name: '이름' })) // 안을 누르면 그대로
    expect(screen.getByRole('dialog')).toBeTruthy()
    fireEvent.pointerDown(document.querySelector('.dlg-bd')!)
    expect(screen.queryByRole('dialog')).toBeNull()

    ;({ dlg } = openDialog())
    fireEvent.click(within(dlg).getByRole('button', { name: '취소' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(api.addAgent).not.toHaveBeenCalled()
  })
})
