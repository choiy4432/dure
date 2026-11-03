import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act, fireEvent, cleanup, within, waitFor } from '@testing-library/react'
import { allowMotion, fastMotion } from './motion'
import type { Room } from '../../src/engine/types'
import type { AgentView, Snapshot } from '../../src/shared/ipcContract'

const room = (id: string, name: string): Room => ({ id, name, createdAt: 1 })
const agent = (id: string, roomId: string, name: string, pos = { x: 64, y: 64 }): AgentView => ({
  id, roomId, name, role: '역할', folder: 'C:\\w', sessionId: 's', started: false, auto: false, model: null,
  alwaysAllow: [], pos, color: null, effort: null, lastContext: null, bypassOn: false, effortNow: null, modelNow: null, status: 'idle', errorText: null, bypass: false, bypassBySettings: false, bypassPending: false, heldInput: 0, planMode: false, asleep: false, waking: false, hold: null, subagentsRunning: [], pastCount: 0, remoteIssue: null,
})

let snapshot: Snapshot
let api: Record<'addRoom' | 'renameRoom' | 'removeRoom' | 'sleepRoom' | 'sleepableIn' | 'sshAvailable' | 'sshHosts' | 'checkRemote', ReturnType<typeof vi.fn>>

/** ~/.ssh/config 의 서버 — dev 는 사용자·주소를 알고, gpu 는 주소만 안다 */
const HOSTS = [
  { host: 'dev', user: 'a', hostName: '10.0.0.5', port: null },
  { host: 'gpu', user: null, hostName: 'gpu.internal', port: null },
]

beforeEach(() => {
  vi.resetModules()
  localStorage.clear()
  snapshot = {
    claudeMissing: false,
    rooms: [room('r1', '여름 캠페인'), room('r2', '가을 행사'), room('r3', '빈 방')],
    agents: [agent('a1', 'r1', '기획'), agent('a2', 'r1', '웹 화면', { x: 384, y: 64 }), agent('b1', 'r2', '서버')],
    messages: [], requests: [], autoChainLimit: 3, allowBypass: false, notify: { asks: true, finished: false }, sleepAfterMin: 30, usage: null,
  }
  // 엔진처럼 — 바뀐 방은 다음 스냅샷에 들어 있다(방 바뀜 이벤트는 없다)
  let next = 4
  api = {
    addRoom: vi.fn(async (name: string, remote?: { host: string } | null) => {
      if (!name.trim()) throw new Error('이름을 입력하세요')
      const r: Room = { ...room(`r${next++}`, name.trim()), ...(remote ? { remote } : {}) }
      snapshot = { ...snapshot, rooms: [...snapshot.rooms, r] }
      return r
    }),
    sshAvailable: vi.fn(async () => true),
    sshHosts: vi.fn(async () => HOSTS),
    checkRemote: vi.fn(async (_host: string) => ({ ok: true, claudeVersion: '2.1.304' })),
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
    sleepRoom: vi.fn(async (_id: string) => 2),
    sleepableIn: vi.fn(async (_id: string) => 2),
  }
  ;(window as any).dure = {
    ...api, snapshot: async () => snapshot, setupState: async () => ({ phase: 'ready' }), history: async () => [], on: () => () => {}, updateAgent: async () => ({}),
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

/** 목록의 '새 방' → 새 방 대화상자(목록은 닫힌다) */
const openNewRoom = async () => {
  fireEvent.click(within(openList()).getByRole('button', { name: '새 방' }))
  await settle() // ssh 있는지·서버 목록을 받는다
  return screen.getByRole('dialog', { name: '새 방' })
}
const makeButton = (dlg: HTMLElement) => within(dlg).getByRole('button', { name: '만들기' }) as HTMLButtonElement

describe('RoomSwitcher — 새 방', () => {
  it('목록의 새 방은 대화상자 — 이름을 적어 만들면 그 방으로 바뀌고, 이 PC 방은 이름만 넘긴다', async () => {
    const store = await renderApp()
    const dlg = await openNewRoom()
    expect(screen.queryByRole('dialog', { name: '방' })).toBeNull() // 목록은 닫고 대화상자만
    const input = within(dlg).getByRole('textbox', { name: '이름' }) as HTMLInputElement
    expect(document.activeElement).toBe(input)
    // 어디서 일하나요 — 기본 이 PC
    const where = within(dlg).getByRole('radiogroup', { name: '어디서 일하나요' })
    expect(within(where).getByRole('radio', { name: '이 PC' }).getAttribute('aria-checked')).toBe('true')
    expect(within(where).getByRole('radio', { name: '서버(SSH)' }).getAttribute('aria-checked')).toBe('false')
    expect(within(dlg).queryByRole('button', { name: /^서버/ })).toBeNull() // 서버 칸은 서버를 고를 때만
    const make = makeButton(dlg)
    expect(make.disabled).toBe(true) // 이름이 비면 못 만든다
    fireEvent.change(input, { target: { value: '   ' } })
    expect(make.disabled).toBe(true)

    fireEvent.change(input, { target: { value: '겨울 준비' } })
    expect(make.disabled).toBe(false)
    await act(async () => { fireEvent.click(make) })
    await settle()
    expect(api.addRoom).toHaveBeenCalledWith('겨울 준비')
    expect(api.checkRemote).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog', { name: '새 방' })).toBeNull()
    expect(store.getState().roomId).toBe('r4')
    expect(roomButton().textContent).toBe('겨울 준비')
    expect(document.activeElement).toBe(roomButton())
  })

  it('새 방 — 엔진 오류는 이름 칸 아래 그대로, Esc 는 대화상자를 닫고 방 버튼으로', async () => {
    api.addRoom.mockRejectedValueOnce(new Error('저장하지 못했어요: 디스크가 가득 찼어요'))
    await renderApp()
    const dlg = await openNewRoom()
    const input = within(dlg).getByRole('textbox', { name: '이름' })
    fireEvent.change(input, { target: { value: '겨울 준비' } })
    await act(async () => { fireEvent.click(makeButton(dlg)) })
    await settle()
    expect(within(dlg).getByText('저장하지 못했어요: 디스크가 가득 찼어요')).toBeTruthy()
    expect(input.getAttribute('aria-invalid')).toBe('true')

    fireEvent.keyDown(input, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: '새 방' })).toBeNull()
    expect(document.activeElement).toBe(roomButton())
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

/** 결과를 손으로 내주는 약속 — 확인 중 모습·늦게 온 옛 답을 본다 */
function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>(r => { resolve = r })
  return { promise, resolve }
}
type Check = { ok: true; claudeVersion: string } | { ok: false; kind: string; detail: string | null }

describe('새 방 — 서버(SSH)', () => {
  const serverButton = (dlg: HTMLElement) => within(dlg).getByRole('button', { name: /^서버 / }) as HTMLButtonElement
  const toServer = (dlg: HTMLElement) => fireEvent.click(within(dlg).getByRole('radio', { name: '서버(SSH)' }))
  const openHosts = (dlg: HTMLElement) => {
    fireEvent.click(serverButton(dlg))
    return within(dlg).getByRole('listbox', { name: '서버' })
  }

  it('스위치 서버 → 목록에 host·user@hostName → 고르면 바로 확인 → 접속됨 뒤에만 만들기 → addRoom(이름, { host })', async () => {
    const answer = deferred<Check>()
    api.checkRemote.mockReturnValueOnce(answer.promise)
    const store = await renderApp()
    const dlg = await openNewRoom()
    fireEvent.change(within(dlg).getByRole('textbox', { name: '이름' }), { target: { value: '서버 실험' } })
    toServer(dlg)
    expect(within(dlg).getByRole('radio', { name: '서버(SSH)' }).getAttribute('aria-checked')).toBe('true')
    expect(within(dlg).queryByText('~/.ssh/config 의 서버 · VS Code 원격과 같은 키로 접속해요')).toBeNull() // 안내 줄은 뺐다
    expect(makeButton(dlg).disabled).toBe(true) // 서버를 고르기 전

    const box = openHosts(dlg)
    expect(serverButton(dlg).getAttribute('aria-expanded')).toBe('true')
    const options = within(box).getAllByRole('option')
    // 줄마다 host + 흐린 user@hostName(없는 칸은 뺀다) · 끝에 직접 입력…(흐린 예시는 읽지 않는다)
    expect(options.map(o => o.textContent)).toEqual(['dev a@10.0.0.5', 'gpu gpu.internal', '직접 입력… 사용자@주소'])
    expect(within(box).getByRole('option', { name: '직접 입력…' })).toBe(options[2])
    expect(document.activeElement).toBe(options[0])

    await act(async () => { fireEvent.click(options[0]) })
    expect(within(dlg).queryByRole('listbox')).toBeNull()
    expect(document.activeElement).toBe(serverButton(dlg))
    expect(serverButton(dlg).textContent).toContain('dev')
    expect(serverButton(dlg).textContent).toContain('a@10.0.0.5')
    expect(api.checkRemote).toHaveBeenCalledWith('dev')
    expect(within(dlg).getByRole('status').textContent).toBe('확인하는 중…')
    expect(makeButton(dlg).disabled).toBe(true)

    await act(async () => { answer.resolve({ ok: true, claudeVersion: '2.1.304' }) })
    expect(within(dlg).getByRole('status').textContent).toBe('접속됨 · claude 2.1.304')
    expect(makeButton(dlg).disabled).toBe(false)

    // 이 PC 로 돌아가면 서버 칸은 접히고 만들기는 이름만 본다 — 다시 서버면 고른 서버·확인이 그대로
    fireEvent.click(within(dlg).getByRole('radio', { name: '이 PC' }))
    expect(within(dlg).queryByRole('button', { name: /^서버 / })).toBeNull()
    toServer(dlg)
    expect(within(dlg).getByRole('status').textContent).toBe('접속됨 · claude 2.1.304')

    await act(async () => { fireEvent.click(makeButton(dlg)) })
    await settle()
    expect(api.addRoom).toHaveBeenCalledWith('서버 실험', { host: 'dev' })
    expect(api.checkRemote).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('dialog', { name: '새 방' })).toBeNull()
    expect(store.getState().roomId).toBe('r4')
    // 위 띠 방 이름 뒤 서버 알약
    expect(roomButton().querySelector('.room-name')!.textContent).toBe('서버 실험')
    expect(roomButton().querySelector('.srv')!.textContent).toBe('dev')
  })

  it('확인에 실패하면 그 글(경고) — 만들기는 꺼진 채', async () => {
    api.checkRemote.mockResolvedValueOnce({ ok: false, kind: 'denied', detail: null })
    await renderApp()
    const dlg = await openNewRoom()
    fireEvent.change(within(dlg).getByRole('textbox', { name: '이름' }), { target: { value: '서버 실험' } })
    toServer(dlg)
    const devOption = within(openHosts(dlg)).getByRole('option', { name: /^dev/ })
    await act(async () => { fireEvent.click(devOption) })
    await settle()
    expect(within(dlg).getByRole('alert').textContent).toBe('dev 에 키로 접속할 수 없어요 — SSH 키를 등록해 주세요')
    expect(within(dlg).queryByRole('status')).toBeNull()
    expect(makeButton(dlg).disabled).toBe(true)
    // 경고 줄은 서버 단추가 가리킨다(칸 테두리는 시안처럼 그대로)
    expect(serverButton(dlg).getAttribute('aria-describedby')).toBe(within(dlg).getByRole('alert').id)
  })

  it('접속 실패는 ssh 오류 첫 줄을 뒤에 · 다른 서버를 고르면 늦게 온 옛 답은 버린다', async () => {
    const first = deferred<Check>()
    api.checkRemote.mockReturnValueOnce(first.promise).mockResolvedValueOnce({ ok: false, kind: 'unreachable', detail: 'Connection timed out' })
    await renderApp()
    const dlg = await openNewRoom()
    toServer(dlg)
    const devOption = within(openHosts(dlg)).getByRole('option', { name: /^dev/ })
    await act(async () => { fireEvent.click(devOption) })
    const gpuOption = within(openHosts(dlg)).getByRole('option', { name: /^gpu/ })
    await act(async () => { fireEvent.click(gpuOption) })
    await settle()
    expect(api.checkRemote).toHaveBeenLastCalledWith('gpu')
    expect(within(dlg).getByRole('alert').textContent).toBe('gpu 에 접속하지 못했어요 — Connection timed out')
    await act(async () => { first.resolve({ ok: true, claudeVersion: '2.1.304' }) }) // dev 의 답 — 이미 지난 일
    expect(within(dlg).queryByText(/접속됨/)).toBeNull()
    expect(within(dlg).getByRole('alert').textContent).toBe('gpu 에 접속하지 못했어요 — Connection timed out')
  })

  it('직접 입력 — 고르면 입력칸으로, Enter 면 바로 · 입력을 멈추면 잠시 뒤 확인', async () => {
    await renderApp()
    const dlg = await openNewRoom()
    fireEvent.change(within(dlg).getByRole('textbox', { name: '이름' }), { target: { value: '직접' } })
    toServer(dlg)
    fireEvent.click(within(openHosts(dlg)).getByRole('option', { name: '직접 입력…' }))
    const typed = within(dlg).getByRole('textbox', { name: '서버 주소' }) as HTMLInputElement
    expect(typed.placeholder).toBe('사용자@주소')
    expect(document.activeElement).toBe(typed)

    // Enter — 기다리지 않고 바로(대화상자를 보내지 않는다)
    fireEvent.change(typed, { target: { value: ' me@10.1.1.1 ' } })
    await act(async () => { fireEvent.keyDown(typed, { key: 'Enter' }) })
    await settle()
    expect(api.checkRemote).toHaveBeenCalledTimes(1)
    expect(api.checkRemote).toHaveBeenLastCalledWith('me@10.1.1.1')
    expect(screen.getByRole('dialog', { name: '새 방' })).toBeTruthy()
    expect(within(dlg).getByRole('status').textContent).toBe('접속됨 · claude 2.1.304')
    expect(makeButton(dlg).disabled).toBe(false)

    // 글을 바꾸면 확인이 풀리고, 멈춘 뒤에 다시 확인한다
    fireEvent.change(typed, { target: { value: 'me@10.1.1.2' } })
    expect(makeButton(dlg).disabled).toBe(true)
    expect(within(dlg).queryByText(/접속됨/)).toBeNull()
    expect(api.checkRemote).toHaveBeenCalledTimes(1)
    await act(async () => { await new Promise(r => setTimeout(r, 750)) })
    expect(api.checkRemote).toHaveBeenCalledTimes(2)
    expect(api.checkRemote).toHaveBeenLastCalledWith('me@10.1.1.2')
    expect(makeButton(dlg).disabled).toBe(false)

    await act(async () => { fireEvent.click(makeButton(dlg)) })
    await settle()
    expect(api.addRoom).toHaveBeenCalledWith('직접', { host: 'me@10.1.1.2' })
  })

  it('직접 입력 — Enter·직접 입력 고르기로 물은 것이 바로 실패해도 걸려 있던 입력 멈춤 타이머가 다시 묻지 않는다', async () => {
    await renderApp()
    const dlg = await openNewRoom()
    toServer(dlg)
    fireEvent.click(within(openHosts(dlg)).getByRole('option', { name: '직접 입력…' }))
    const typed = within(dlg).getByRole('textbox', { name: '서버 주소' }) as HTMLInputElement
    api.checkRemote.mockResolvedValue({ ok: false, kind: 'unreachable', detail: 'Connection refused' })
    vi.useFakeTimers()
    try {
      const tick = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms) })
      fireEvent.change(typed, { target: { value: 'me@10.9.9.9' } }) // 입력 멈춤 타이머가 걸린다
      await tick(100)
      await act(async () => { fireEvent.keyDown(typed, { key: 'Enter' }) })
      await tick(0) // 실패 답이 곧바로 온다
      expect(api.checkRemote).toHaveBeenCalledTimes(1)
      expect(within(dlg).getByRole('alert').textContent).toBe('me@10.9.9.9 에 접속하지 못했어요 — Connection refused')
      await tick(1000)
      expect(api.checkRemote).toHaveBeenCalledTimes(1)

      // 목록에서 다른 서버를 골랐다가 다시 직접 입력 — 고르는 즉시 묻고, 그 뒤 타이머로 또 묻지 않는다
      fireEvent.change(typed, { target: { value: 'me@10.9.9.8' } })
      fireEvent.click(within(openHosts(dlg)).getByRole('option', { name: /^dev/ }))
      await tick(0)
      expect(api.checkRemote).toHaveBeenCalledTimes(2)
      expect(api.checkRemote).toHaveBeenLastCalledWith('dev')
      await tick(1000)
      expect(api.checkRemote).toHaveBeenCalledTimes(2)
      fireEvent.click(within(openHosts(dlg)).getByRole('option', { name: '직접 입력…' }))
      await tick(0)
      expect(api.checkRemote).toHaveBeenCalledTimes(3)
      expect(api.checkRemote).toHaveBeenLastCalledWith('me@10.9.9.8')
      await tick(1000)
      expect(api.checkRemote).toHaveBeenCalledTimes(3)
    } finally {
      vi.useRealTimers()
    }
  })

  it('서버 목록 키보드 — ↑↓ 로 옮기고 Esc 는 목록만 닫고 서버 버튼으로', async () => {
    await renderApp()
    const dlg = await openNewRoom()
    toServer(dlg)
    const box = openHosts(dlg)
    const options = within(box).getAllByRole('option')
    fireEvent.keyDown(options[0], { key: 'ArrowDown' })
    expect(document.activeElement).toBe(options[1])
    fireEvent.keyDown(options[1], { key: 'ArrowUp' })
    expect(document.activeElement).toBe(options[0])
    fireEvent.keyDown(options[0], { key: 'End' })
    expect(document.activeElement).toBe(options[2])
    fireEvent.keyDown(options[2], { key: 'Escape' })
    expect(within(dlg).queryByRole('listbox')).toBeNull()
    expect(screen.getByRole('dialog', { name: '새 방' })).toBeTruthy() // 대화상자는 그대로
    expect(document.activeElement).toBe(serverButton(dlg))
    expect(api.checkRemote).not.toHaveBeenCalled()
  })

  it('ssh 가 없으면 서버 칸이 꺼지고 그 자리에 안내', async () => {
    api.sshAvailable.mockResolvedValue(false)
    await renderApp()
    const dlg = await openNewRoom()
    const server = within(dlg).getByRole('radio', { name: '서버(SSH)' }) as HTMLButtonElement
    expect(server.disabled).toBe(true)
    expect(within(dlg).getByText('윈도우 OpenSSH 를 찾지 못했어요')).toBeTruthy()
    fireEvent.click(server)
    expect(within(dlg).getByRole('radio', { name: '이 PC' }).getAttribute('aria-checked')).toBe('true')
  })
})

describe('RoomSwitcher — 서버 방 표시', () => {
  it('위 띠 방 이름 뒤 알약 · 방 목록 서버 방 줄 아래 흐린 <host> · <user>@<hostName>(모르면 host 만)', async () => {
    snapshot = {
      ...snapshot,
      rooms: [{ ...room('r1', '웹 리뉴얼'), remote: { host: 'dev' } }, { ...room('r2', '직접 방'), remote: { host: 'me@10.1.1.1' } }, room('r3', '빈 방')],
    }
    await renderApp()
    await settle()
    const pill = roomButton().querySelector('.srv')!
    expect(pill.textContent).toBe('dev')
    expect(pill.getAttribute('title')).toBe('dev · a@10.0.0.5')
    expect(api.sshHosts).toHaveBeenCalled()

    const list = openList()
    await settle()
    expect(list.querySelector('[data-nav="r1"] .rs-sub')!.textContent).toBe('dev · a@10.0.0.5')
    expect(list.querySelector('[data-nav="r2"] .rs-sub')!.textContent).toBe('me@10.1.1.1')
    expect(list.querySelector('[data-nav="r3"] .rs-sub')).toBeNull()
    expect(list.querySelector('[data-nav="r3"]')!.textContent).toBe('빈 방')
  })

  it('이 PC 방만 있으면 서버 목록을 묻지 않는다', async () => {
    await renderApp()
    openList()
    await settle()
    expect(api.sshHosts).not.toHaveBeenCalled()
    expect(roomButton().querySelector('.srv')).toBeNull()
  })
})

describe('RoomSwitcher — 방마다 메뉴', () => {
  it('이름 바꾸기 위에 모두 재우기 — 메뉴를 열면 sleepableIn 을 묻고, 누르면 sleepRoom 한 번', async () => {
    await renderApp()
    fireEvent.click(within(openList()).getByRole('button', { name: '여름 캠페인 메뉴' }))
    const menu = screen.getByRole('menu', { name: '여름 캠페인 메뉴' })
    await settle()
    expect(api.sleepableIn).toHaveBeenCalledWith('r1')
    const items = within(menu).getAllByRole('menuitem').map(el => el.textContent)
    expect(items.indexOf('쉬는 에이전트 모두 재우기')).toBe(items.indexOf('이름 바꾸기') - 1)
    const btn = within(menu).getByRole('menuitem', { name: '쉬는 에이전트 모두 재우기' }) as HTMLButtonElement
    expect(btn.disabled).toBe(false)
    await act(async () => { fireEvent.click(btn) })
    expect(api.sleepRoom).toHaveBeenCalledTimes(1)
    expect(api.sleepRoom).toHaveBeenCalledWith('r1')
  })

  it('재울 수 있는 게 0 이면 항목이 꺼져 있고 눌러도 부르지 않는다', async () => {
    api.sleepableIn.mockResolvedValue(0)
    await renderApp()
    fireEvent.click(within(openList()).getByRole('button', { name: '빈 방 메뉴' }))
    const menu = screen.getByRole('menu', { name: '빈 방 메뉴' })
    await settle()
    const btn = within(menu).getByRole('menuitem', { name: '쉬는 에이전트 모두 재우기' }) as HTMLButtonElement
    expect(btn.disabled).toBe(true)
    fireEvent.click(btn)
    expect(api.sleepRoom).not.toHaveBeenCalled()
  })

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

describe('RoomSwitcher — 할 일 수', () => {
  const ask = (id: string, agentId: string) => ({ id, agentId, toolName: 'Bash', input: {}, kind: 'permission' as const, createdAt: 1 })
  const msg = (id: string, to: string, roomId: string, state: 'pending' | 'held' = 'pending') =>
    ({ id, roomId, from: 'a1', to, text: 't', createdAt: 1, state, updatedAt: 1 })

  it('방마다 할 일 수', async () => {
    snapshot = { ...snapshot, requests: [ask('q1', 'b1'), ask('q2', 'b1')], messages: [msg('m1', 'b1', 'r2'), msg('m2', 'b1', 'r2', 'held')] }
    await renderApp()
    const list = openList()
    const row = list.querySelector<HTMLElement>('[data-nav="r2"]')!
    // 색만으로 구분하지 않는다 — 숫자 앞에 보이지 않는 이름
    expect(row.querySelector('.rs-todo.a')?.textContent).toBe('내 승인 필요 2')
    expect(row.querySelector('.rs-todo.r')?.textContent).toBe('받은 메시지 2')
    const quiet = list.querySelector<HTMLElement>('[data-nav="r3"]')!
    expect(quiet.querySelector('.rs-todo')).toBeNull()
  })

  it('서버 방 문제(끊김·로그인 만료 …)가 있는 에이전트 수 — 오류처럼 빨간 표시, 무엇인지는 title · 일하는 중이면 세지 않는다', async () => {
    const drop = { kind: 'disconnected' as const, detail: null }
    snapshot = {
      ...snapshot,
      rooms: [room('r1', '여름 캠페인'), { ...room('r2', '가을 행사'), remote: { host: 'dev' } }, room('r3', '빈 방')],
      agents: [
        agent('a1', 'r1', '기획'),
        { ...agent('b1', 'r2', '서버'), remoteIssue: drop },
        { ...agent('b2', 'r2', '화면'), remoteIssue: { kind: 'login', detail: null } },
        { ...agent('b3', 'r2', '일꾼'), status: 'working', remoteIssue: drop },
      ],
    }
    await renderApp()
    const list = openList()
    const mark = list.querySelector<HTMLElement>('[data-nav="r2"] .rs-todo.e')!
    expect(mark.textContent).toBe('서버 문제 2')
    expect(mark.title).toBe('서버: dev 연결이 끊겼어요 — 다시 보내면 이어서 해요\n화면: dev 의 claude 로그인이 만료됐어요')
    expect(mark.querySelector('svg')).not.toBeNull()
    expect(list.querySelector('[data-nav="r1"] .rs-todo')).toBeNull()
  })

  it('다른 방에 할 일이 있으면 방 단추에 점', async () => {
    await renderApp()
    expect(roomButton().querySelector('[aria-label="다른 방에 할 일 있음"]')).toBeNull()
    cleanup()
    snapshot = { ...snapshot, requests: [ask('q1', 'b1')] }
    await renderApp()
    expect(roomButton().querySelector('[aria-label="다른 방에 할 일 있음"]')).not.toBeNull()
  })

  it('지금 방의 할 일만 있으면 방 단추에 점이 없다', async () => {
    snapshot = { ...snapshot, requests: [ask('q1', 'a1')] }
    await renderApp()
    expect(roomButton().querySelector('[aria-label="다른 방에 할 일 있음"]')).toBeNull()
  })

  it('roomMenuRequest 가 오르면 목록이 열린다', async () => {
    const store = await renderApp()
    expect(screen.queryByRole('dialog', { name: '방' })).toBeNull() // 처음 마운트로는 안 열린다
    act(() => store.requestRoomMenu())
    expect(screen.getByRole('dialog', { name: '방' })).toBeTruthy()
  })
})
