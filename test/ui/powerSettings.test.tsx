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
    expect(within(dlg).getByText('켜 둔 동안엔 화면이 꺼지거나 잠기지 않아요. Esc 를 길게 누르면 나가요.')).toBeInTheDocument()
  })

  it('스위치를 누르면 setPower(true) 와 설정 닫기', async () => {
    const { store, dlg } = await open()
    const spy = vi.spyOn(store, 'setPower')
    fireEvent.click(within(dlg).getByRole('switch', { name: '파워 모드' }))
    await settle()
    expect(spy).toHaveBeenCalledWith(true)
    expect(setPowerMode).toHaveBeenCalledWith(true)
    expect(screen.queryByRole('dialog', { name: '설정' })).toBeNull()
    expect(screen.getByRole('application', { name: '파워 모드' })).toBeInTheDocument()
  })

  it("'터미널 벽'을 누르면 setPrefs({powerTerminal:true})", async () => {
    const { dlg } = await open()
    fireEvent.click(within(dlg).getByRole('radio', { name: '터미널 벽' }))
    await settle()
    expect(setPrefsApi).toHaveBeenCalledWith({ powerTerminal: true })
    expect(within(dlg).getByRole('radio', { name: '터미널 벽' })).toHaveAttribute('aria-checked', 'true')
  })
})
