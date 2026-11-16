import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { render, screen, act, fireEvent, cleanup, within } from '@testing-library/react'
import type { Snapshot } from '../../src/shared/ipcContract'

// 설정 > 일반 > 파워 모드 구역

let setPowerMode: ReturnType<typeof vi.fn>
let setPrefsApi: ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.resetModules()
  localStorage.clear()
  const snapshot: Snapshot = {
    claudeMissing: false, rooms: [{ id: 'r1', name: '방', createdAt: 1 }], agents: [],
    messages: [], requests: [], autoChainLimit: 3, allowBypass: false, notify: { asks: true, finished: false }, sleepAfterMin: 30, usage: null,
  }
  let prefsNow = { tourDone: true, approvalTipSeen: true, claudeAutoUpdate: true, trayTipSeen: true, powerTerminal: false }
  setPowerMode = vi.fn(async () => {})
  setPrefsApi = vi.fn(async (p: any) => (prefsNow = { ...prefsNow, ...p }))
  ;(window as any).dure = {
    appInfo: async () => ({ version: '0.1.0', packaged: true }), prefs: async () => prefsNow, setPrefs: setPrefsApi, setPowerMode,
    updateState: async () => ({ kind: 'idle' }), claudeUpdateState: async () => 'idle', snapshot: async () => snapshot,
    setupState: async () => ({ phase: 'ready' }), history: async () => [], on: () => () => {},
  }
})
afterEach(() => cleanup())

const settle = () => act(async () => { await new Promise(r => setTimeout(r, 0)) })

async function open() {
  const { getStore } = await import('../../src/renderer/state/store')
  const { App } = await import('../../src/renderer/App')
  await act(async () => { await getStore().init() })
  render(<App />)
  fireEvent.click(screen.getByRole('button', { name: '설정' }))
  return { store: getStore(), dlg: screen.getByRole('dialog', { name: '설정' }) }
}

describe('설정 — 파워 모드 구역', () => {
  it('스위치 · 화면 radiogroup · 안내 문구', async () => {
    const { dlg } = await open()
    expect(within(dlg).getByRole('switch', { name: '파워 모드' })).toHaveAttribute('aria-checked', 'false')
    const group = within(dlg).getByRole('radiogroup', { name: '화면' })
    expect(within(group).getByRole('radio', { name: '관제실' })).toHaveAttribute('aria-checked', 'true')
    expect(within(group).getByRole('radio', { name: '터미널 벽' })).toHaveAttribute('aria-checked', 'false')
    expect(within(dlg).getByText('켜 둔 동안엔 화면이 꺼지지 않아요. 위 띠의 [나가기]나 Esc 를 길게 눌러 나가요.')).toBeInTheDocument()
    expect(within(dlg).queryByText(/잠기지 않아요/)).toBeNull()
  })

  it('스위치를 누르면 setPower(true) 와 설정 닫기', async () => {
    const { store, dlg } = await open()
    const spy = vi.spyOn(store, 'setPower')
    fireEvent.click(within(dlg).getByRole('switch', { name: '파워 모드' }))
    await settle()
    expect(spy).toHaveBeenCalledWith(true)
    expect(setPowerMode).toHaveBeenCalledWith(true)
    expect(screen.queryByRole('dialog', { name: '설정' })).toBeNull()
    expect(screen.getByRole('region', { name: '파워 모드' })).toBeInTheDocument()
  })

  it("'터미널 벽'을 누르면 setPrefs({powerTerminal:true})", async () => {
    const { dlg } = await open()
    fireEvent.click(within(dlg).getByRole('radio', { name: '터미널 벽' }))
    await settle()
    expect(setPrefsApi).toHaveBeenCalledWith({ powerTerminal: true })
    expect(within(dlg).getByRole('radio', { name: '터미널 벽' })).toHaveAttribute('aria-checked', 'true')
  })

  it('설정이 닫힌 뒤에도 초점은 덮개에 있다 (연 단추로 돌아가지 않는다)', async () => {
    const { dlg } = await open()
    fireEvent.click(within(dlg).getByRole('switch', { name: '파워 모드' }))
    await settle()
    await act(async () => { await new Promise(r => setTimeout(r, 400)) })
    expect(screen.queryByRole('dialog', { name: '설정' })).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('region', { name: '파워 모드' }))
  })
})

describe('파워 모드 — 앱 아래층', () => {
  async function withAgent(over: { status?: 'idle' | 'working' } = {}) {
    const { getStore } = await import('../../src/renderer/state/store')
    const { App } = await import('../../src/renderer/App')
    const snap: Snapshot = {
      claudeMissing: false, rooms: [{ id: 'r1', name: '방', createdAt: 1 }],
      agents: [{
        id: 'a', roomId: 'r1', name: '알파', role: '역할', folder: '/x', sessionId: '', started: true, auto: false, model: null,
        alwaysAllow: [], pos: { x: 0, y: 0 }, color: null, effort: null, effortNow: null, modelNow: null, lastContext: null, bypassOn: false, status: over.status ?? 'idle',
        errorText: null, bypass: false, bypassBySettings: false, bypassPending: false, heldInput: 0, planMode: false, asleep: false, waking: false, hold: null,
        subagentsRunning: [], pastCount: 0, remoteIssue: null,
      }],
      messages: [], requests: [], autoChainLimit: 3, allowBypass: false, notify: { asks: true, finished: false }, sleepAfterMin: 30, usage: null,
    }
    ;(window as any).dure.snapshot = async () => snap
    ;(window as any).dure.setSelected = async () => {}
    ;(window as any).dure.updateAgent = async () => snap.agents[0]
    const store = getStore()
    await act(async () => { await store.init() })
    act(() => { store.selectRoom('r1') })
    act(() => { store.selectAgent('a') })
    render(<App />)
    return store
  }
  const composers = () => screen.queryAllByRole('textbox', { name: '알파에게 보낼 메시지' })

  it('켜면 고른 에이전트의 대화 패널은 덮개 안 하나만 — 앱의 패널은 그리지 않는다(효과가 두 번 돌지 않게)', async () => {
    const store = await withAgent()
    expect(composers()).toHaveLength(1)
    await act(async () => { await store.setPower(true) })
    const pw = screen.getByRole('region', { name: '파워 모드' })
    expect(composers()).toHaveLength(1)
    expect(pw.contains(composers()[0])).toBe(true)
    await act(async () => { await store.setPower(false) })
    expect(composers()).toHaveLength(1)
    expect(screen.queryByRole('region', { name: '파워 모드' })).toBeNull()
  })

  it('켜진 동안 덮개에 가린 앱 틀(위 띠·본문·상태 띠)만 inert — 찾기 창은 열리고 덮개 위에 뜬다', async () => {
    const store = await withAgent()
    await act(async () => { await store.setPower(true) })
    const gear = document.querySelector('[data-tour="settings-gear"]')!
    expect(gear.closest('[inert]')).not.toBeNull()
    fireEvent.keyDown(document.body, { key: 'k', ctrlKey: true })
    const pal = await screen.findByRole('dialog', { name: '찾기 · 옮기기' })
    expect(pal.closest('[inert]')).toBeNull()
    await act(async () => { await store.setPower(false) })
    expect(screen.getByRole('button', { name: '설정' }).closest('[inert]')).toBeNull()
  })

  it('덮개의 [설정] → 설정 창이 덮개 위(inert 밖)에 열리고 · 거기서 스위치를 끄면 덮개가 사라지고 앱 틀이 풀린다', async () => {
    const store = await withAgent()
    await act(async () => { await store.setPower(true) })
    const pw = screen.getByRole('region', { name: '파워 모드' })
    fireEvent.click(within(pw).getByRole('button', { name: '설정' }))
    const dlg = screen.getByRole('dialog', { name: '설정' })
    expect(dlg.closest('[inert]')).toBeNull()
    expect(pw.contains(dlg)).toBe(false)
    const sw = within(dlg).getByRole('switch', { name: '파워 모드' })
    expect(sw).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(sw)
    await settle()
    expect(setPowerMode).toHaveBeenLastCalledWith(false)
    expect(screen.queryByRole('region', { name: '파워 모드' })).toBeNull()
    expect(document.querySelector('[data-tour="settings-gear"]')!.closest('[inert]')).toBeNull()
    expect(document.querySelector('.app [inert]')).toBeNull()
  })

  it('덮개에서 연 설정을 닫으면 초점이 덮개의 [설정] 단추로 돌아온다', async () => {
    const store = await withAgent()
    await act(async () => { await store.setPower(true) })
    const pw = screen.getByRole('region', { name: '파워 모드' })
    const btn = within(pw).getByRole('button', { name: '설정' })
    btn.focus() // 진짜 누르기처럼 — 누른 단추에 초점
    fireEvent.click(btn)
    const dlg = screen.getByRole('dialog', { name: '설정' })
    fireEvent.click(within(dlg).getByRole('button', { name: '닫기' }))
    await act(async () => { await new Promise(r => setTimeout(r, 400)) })
    expect(screen.queryByRole('dialog', { name: '설정' })).toBeNull()
    expect(document.activeElement).toBe(btn)
  })

  it('덮개에서 연 설정의 [안내 다시 보기] — 투어가 가리킬 앱 화면이 보이게 파워 모드를 먼저 끄고 시작한다', async () => {
    const store = await withAgent()
    await act(async () => { await store.setPower(true) })
    fireEvent.click(within(screen.getByRole('region', { name: '파워 모드' })).getByRole('button', { name: '설정' }))
    const dlg = screen.getByRole('dialog', { name: '설정' })
    fireEvent.click(within(dlg).getByRole('tab', { name: '두레' }))
    await act(async () => { fireEvent.click(within(dlg).getByRole('button', { name: '안내 다시 보기' })) })
    await settle()
    expect(setPowerMode).toHaveBeenLastCalledWith(false)
    expect(screen.queryByRole('region', { name: '파워 모드' })).toBeNull()
    expect(store.getState().tour).not.toBeNull()
  })

  it('고른 채 켜고 초점이 body 일 때 Esc 를 눌렀다 떼도 아래 관계도가 고르기를 풀지 않는다 — 옆 칸은 대화 그대로', async () => {
    const setSelected = vi.fn(async () => {})
    const store = await withAgent()
    ;(window as any).dure.setSelected = setSelected
    await act(async () => { await store.setPower(true) })
    ;(document.activeElement as HTMLElement | null)?.blur()
    expect(document.activeElement).toBe(document.body)
    fireEvent.keyDown(document.body, { key: 'Escape' })
    fireEvent.keyUp(document.body, { key: 'Escape' })
    expect(store.getState().selectedAgentId).toBe('a')
    expect(setSelected).not.toHaveBeenCalled()
    expect(screen.getByRole('tab', { name: '대화' })).toHaveAttribute('aria-selected', 'true')
  })

  it('Esc 길게로 나가도 고르기는 그대로 — 나간 뒤에도 떼기 전의 자동 반복 Esc 는 아래 관계도에 닿지 않는다', async () => {
    const store = await withAgent()
    await act(async () => { await store.setPower(true) })
    ;(document.activeElement as HTMLElement | null)?.blur()
    fireEvent.keyDown(document.body, { key: 'Escape' })
    await act(async () => { await new Promise(r => setTimeout(r, 1600)) })
    expect(setPowerMode).toHaveBeenLastCalledWith(false)
    expect(screen.queryByRole('region', { name: '파워 모드' })).toBeNull()
    // 아직 누르고 있다 — 운영체제의 자동 반복
    act(() => {
      fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape', repeat: true })
      fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape', repeat: true })
    })
    fireEvent.keyUp(document.body, { key: 'Escape' })
    expect(store.getState().selectedAgentId).toBe('a')
  })

  it('입력창을 보던 에이전트가 일하는 중에 Esc 길게로 나가도 — 다시 붙은 앱 입력창이 자동 반복 Esc 로 그 일을 멈추지 않는다', async () => {
    const interrupt = vi.fn(async () => {})
    ;(window as any).dure.interrupt = interrupt
    const store = await withAgent({ status: 'working' })
    await act(async () => { await store.setPower(true) })
    // 덮개의 카드를 누른 것처럼 — 고르고 입력창 커서 요청
    act(() => { store.selectAgent('a', { focusInput: true }) })
    ;(document.activeElement as HTMLElement | null)?.blur()
    fireEvent.keyDown(document.body, { key: 'Escape' })
    await act(async () => { await new Promise(r => setTimeout(r, 1600)) })
    expect(screen.queryByRole('region', { name: '파워 모드' })).toBeNull()
    const box = screen.getByRole('textbox', { name: '알파에게 보낼 메시지' })
    expect(document.activeElement).toBe(box) // 다시 붙은 앱 입력창이 커서를 가져갔다
    act(() => {
      fireEvent.keyDown(box, { key: 'Escape', repeat: true })
      fireEvent.keyDown(box, { key: 'Escape', repeat: true })
    })
    fireEvent.keyUp(box, { key: 'Escape' })
    expect(interrupt).not.toHaveBeenCalled()
    // 손을 뗀 뒤 새로 누른 Esc 는 평소대로 멈춘다
    act(() => { fireEvent.keyDown(box, { key: 'Escape' }) })
    expect(interrupt).toHaveBeenCalledTimes(1)
  })

  it('끄고 나면 관계도의 Esc 고르기 풀기는 평소대로', async () => {
    const store = await withAgent()
    await act(async () => { await store.setPower(true) })
    await act(async () => { await store.setPower(false) })
    ;(document.activeElement as HTMLElement | null)?.blur()
    act(() => { fireEvent.keyDown(document.body, { key: 'Escape' }) })
    expect(store.getState().selectedAgentId).toBeNull()
  })
})
