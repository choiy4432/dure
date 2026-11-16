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
  async function withAgent() {
    const { getStore } = await import('../../src/renderer/state/store')
    const { App } = await import('../../src/renderer/App')
    const snap: Snapshot = {
      claudeMissing: false, rooms: [{ id: 'r1', name: '방', createdAt: 1 }],
      agents: [{
        id: 'a', roomId: 'r1', name: '알파', role: '역할', folder: '/x', sessionId: '', started: true, auto: false, model: null,
        alwaysAllow: [], pos: { x: 0, y: 0 }, color: null, effort: null, effortNow: null, modelNow: null, lastContext: null, bypassOn: false, status: 'idle',
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
    const gear = screen.getByRole('button', { name: '설정', hidden: true })
    expect(gear.closest('[inert]')).not.toBeNull()
    fireEvent.keyDown(document.body, { key: 'k', ctrlKey: true })
    const pal = await screen.findByRole('dialog', { name: '찾기 · 옮기기' })
    expect(pal.closest('[inert]')).toBeNull()
    await act(async () => { await store.setPower(false) })
    expect(screen.getByRole('button', { name: '설정' }).closest('[inert]')).toBeNull()
  })
})
