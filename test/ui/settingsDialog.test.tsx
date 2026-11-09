import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act, fireEvent, cleanup, within } from '@testing-library/react'
import type { AgentView, Snapshot } from '../../src/shared/ipcContract'

const agent = (id: string, roomId: string, status: AgentView['status']): AgentView => ({
  id, roomId, name: id, role: '역할', folder: 'C:/w', sessionId: 's', started: false, auto: false, model: null,
  alwaysAllow: [], pos: { x: 0, y: 0 }, color: null, effort: null, lastContext: null, bypassOn: false, effortNow: null, modelNow: null, status, errorText: null, bypass: false, bypassBySettings: false, bypassPending: false, heldInput: 0, planMode: false, asleep: false, waking: false, hold: null, subagentsRunning: [], pastCount: 0, remoteIssue: null,
})

let snapshot: Snapshot
let setAutoChainLimit: ReturnType<typeof vi.fn>
let setAllowBypass: ReturnType<typeof vi.fn>
let setNotify: ReturnType<typeof vi.fn>
let setTheme: ReturnType<typeof vi.fn>
let setSleepAfter: ReturnType<typeof vi.fn>
let setPrefsApi: ReturnType<typeof vi.fn>
let checkUpdate: ReturnType<typeof vi.fn>
let downloadUpdate: ReturnType<typeof vi.fn>
let installUpdate: ReturnType<typeof vi.fn>
let updateNow: any
let handlers: Record<string, (p: any) => void>

beforeEach(() => {
  vi.resetModules()
  localStorage.clear()
  snapshot = {
    claudeMissing: false, rooms: [{ id: 'r1', name: '여름 캠페인', createdAt: 1 }], agents: [],
    messages: [], requests: [], autoChainLimit: 3, allowBypass: false, notify: { asks: true, finished: false }, sleepAfterMin: 30, usage: null,
  }
  setAutoChainLimit = vi.fn(async (n: number) => {
    snapshot = { ...snapshot, autoChainLimit: n }
  })
  setAllowBypass = vi.fn(async (on: boolean) => {
    snapshot = { ...snapshot, allowBypass: on }
  })
  setNotify = vi.fn(async (p: Partial<{ asks: boolean; finished: boolean }>) => {
    snapshot = { ...snapshot, notify: { ...snapshot.notify, ...p } }
  })
  setTheme = vi.fn(async (t: 'light' | 'dark' | 'system') => {
    snapshot = { ...snapshot, theme: t }
  })
  setSleepAfter = vi.fn(async (m: number) => {
    snapshot = { ...snapshot, sleepAfterMin: m }
  })
  updateNow = { kind: 'idle' }
  handlers = {}
  let prefsNow = { tourDone: true, approvalTipSeen: true, claudeAutoUpdate: true }
  setPrefsApi = vi.fn(async (p: any) => (prefsNow = { ...prefsNow, ...p }))
  checkUpdate = vi.fn(async () => ({ kind: 'none' }))
  downloadUpdate = vi.fn(async () => {})
  installUpdate = vi.fn(async () => {})
  ;(window as any).dure = { appInfo: async () => ({ version: '0.1.0', packaged: true }), prefs: async () => prefsNow, setPrefs: setPrefsApi, updateState: async () => updateNow, claudeUpdateState: async () => 'idle', checkUpdate, downloadUpdate, installUpdate, setSleepAfter, setAutoChainLimit, setAllowBypass, setNotify, setTheme, snapshot: async () => snapshot, setupState: async () => ({ phase: 'ready' }), history: async () => [], on: (n: string, h: (p: any) => void) => { handlers[n] = h; return () => {} } }
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

const openSettings = () => {
  const opener = screen.getByRole('button', { name: '설정' })
  opener.focus()
  fireEvent.click(opener)
  return { dlg: screen.getByRole('dialog', { name: '설정' }), opener }
}

const tabOf = (dlg: HTMLElement, name: string) => within(dlg).getByRole('tab', { name })
const goTab = (dlg: HTMLElement, name: string) => fireEvent.click(tabOf(dlg, name))
const sw = (dlg: HTMLElement, name: string) => within(dlg).getByRole('switch', { name })
const limitInput = (dlg: HTMLElement) => within(dlg).getByRole('spinbutton', { name: '자동 전달 상한' }) as HTMLInputElement

describe('SettingsDialog — 탭 틀', () => {
  it('tabsVertical — 세로 tablist · 탭 다섯 · 화살표/Home/End · 아래 단추는 [닫기] 하나', async () => {
    await renderApp()
    const { dlg } = openSettings()
    const list = within(dlg).getByRole('tablist')
    expect(list.getAttribute('aria-orientation')).toBe('vertical')
    const tabs = within(list).getAllByRole('tab')
    expect(tabs.map(t => t.textContent)).toEqual(['일반', '에이전트', '알림', '휴대폰', '두레'])
    expect(tabs.map(t => t.getAttribute('aria-selected'))).toEqual(['true', 'false', 'false', 'false', 'false'])
    expect(tabs.map(t => t.getAttribute('tabindex'))).toEqual(['0', '-1', '-1', '-1', '-1'])
    expect(within(dlg).getByRole('tabpanel', { name: '일반' })).toBeTruthy()
    expect(document.activeElement).toBe(tabs[0]) // R1 — 처음 초점은 고른 탭

    fireEvent.keyDown(tabs[0], { key: 'ArrowDown' })
    expect(tabs[1].getAttribute('aria-selected')).toBe('true')
    expect(document.activeElement).toBe(tabs[1])
    expect(within(dlg).getByRole('tabpanel', { name: '에이전트' })).toBeTruthy()
    expect(within(dlg).getByRole('spinbutton', { name: '자동 전달 상한' })).toBeTruthy()
    expect(within(dlg).queryByRole('radiogroup', { name: '테마' })).toBeNull() // 숨긴 판을 DOM 에 두지 않는다

    fireEvent.keyDown(tabs[1], { key: 'End' })
    expect(tabs[4].getAttribute('aria-selected')).toBe('true')
    expect(document.activeElement).toBe(tabs[4])
    fireEvent.keyDown(tabs[4], { key: 'ArrowUp' })
    expect(tabs[3].getAttribute('aria-selected')).toBe('true')
    fireEvent.keyDown(tabs[3], { key: 'Home' })
    expect(tabs[0].getAttribute('aria-selected')).toBe('true')
    expect(document.activeElement).toBe(tabs[0])

    const buttons = within(dlg).getAllByRole('button').map(b => b.textContent)
    expect(buttons).toContain('닫기')
    expect(within(dlg).queryByRole('button', { name: '저장' })).toBeNull()
    expect(within(dlg).queryByRole('button', { name: '취소' })).toBeNull()
  })

  it('[닫기] · Esc 로 닫는다', async () => {
    await renderApp()
    const { dlg, opener } = openSettings()
    fireEvent.click(within(dlg).getByRole('button', { name: '닫기' }))
    expect(screen.queryByRole('dialog', { name: '설정' })).toBeNull()
    expect(document.activeElement).toBe(opener)
    const again = openSettings()
    fireEvent.keyDown(again.dlg, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: '설정' })).toBeNull()
  })

  it('initialTabProp — initialTab="about" 으로 열면 두레 탭이 고른 탭 · phonePane 이 없으면 휴대폰 탭도 없다', async () => {
    const { getStore } = await import('../../src/renderer/state/store')
    const { SettingsDialog } = await import('../../src/renderer/shell/SettingsDialog')
    await act(async () => { await getStore().init() })
    render(<SettingsDialog onClose={() => {}} onReplayTour={() => {}} initialTab="about" />)
    const dlg = screen.getByRole('dialog', { name: '설정' })
    expect(tabOf(dlg, '두레').getAttribute('aria-selected')).toBe('true')
    expect(within(dlg).getByRole('tabpanel', { name: '두레' })).toBeTruthy()
    expect(within(dlg).queryByRole('tab', { name: '휴대폰' })).toBeNull()
  })
})

describe('SettingsDialog — 일반', () => {
  it('themeAndSleepApplyNow — 누르는 즉시 setTheme / setSleepAfter 한 번 · 닫아도 되돌리지 않는다', async () => {
    const store = await renderApp()
    const { dlg } = openSettings()
    const theme = within(dlg).getByRole('radiogroup', { name: '테마' })
    expect(within(theme).getByRole('radio', { name: 'Windows 따라감' }).getAttribute('aria-checked')).toBe('true')
    await act(async () => { fireEvent.click(within(theme).getByRole('radio', { name: '다크' })) })
    await settle()
    expect(setTheme.mock.calls).toEqual([['dark']])
    expect(store.getState().theme).toBe('dark')
    expect(within(theme).getByRole('radio', { name: '다크' }).getAttribute('aria-checked')).toBe('true')

    const sleep = within(dlg).getByRole('radiogroup', { name: '쉬는 에이전트 재우기' })
    expect(within(sleep).getAllByRole('radio').map(r => r.textContent)).toEqual(['끔', '15분', '30분', '1시간', '3시간'])
    expect(within(sleep).getByRole('radio', { name: '30분' }).getAttribute('aria-checked')).toBe('true')
    expect(dlg.textContent).toContain('쉬는 동안 claude 를 내려 메모리를 비워요 · 말을 걸면 다시 깨요')
    await act(async () => { fireEvent.click(within(sleep).getByRole('radio', { name: '1시간' })) })
    await settle()
    expect(setSleepAfter.mock.calls).toEqual([[60]])

    await act(async () => { fireEvent.click(within(dlg).getByRole('button', { name: '닫기' })) })
    await settle()
    expect(setTheme).toHaveBeenCalledTimes(1)
    expect(setSleepAfter).toHaveBeenCalledTimes(1)
    expect(store.getState().theme).toBe('dark')
  })

  it('테마를 못 바꾸면 그 줄 아래 까닭 · 고른 칸은 저장된 값', async () => {
    setTheme.mockRejectedValueOnce(new Error('설정 파일을 쓰지 못했어요'))
    await renderApp()
    const { dlg } = openSettings()
    const theme = within(dlg).getByRole('radiogroup', { name: '테마' })
    await act(async () => { fireEvent.click(within(theme).getByRole('radio', { name: '다크' })) })
    await settle()
    expect(within(dlg).getByText('설정 파일을 쓰지 못했어요')).toBeTruthy()
    expect(within(theme).getByRole('radio', { name: 'Windows 따라감' }).getAttribute('aria-checked')).toBe('true')
    expect(within(theme).getByRole('radio', { name: '다크' }).getAttribute('aria-checked')).toBe('false')
  })
})

describe('SettingsDialog — 에이전트', () => {
  it('limitCommitsOnBlurOrEnter — Enter 나 칸을 벗어날 때 보낸다 · 안 바뀐 값은 안 보낸다', async () => {
    const store = await renderApp()
    const { dlg } = openSettings()
    goTab(dlg, '에이전트')
    const input = limitInput(dlg)
    expect(input.value).toBe('3')
    expect(dlg.textContent).toContain('사람 확인 없이 이어서 주고받는 횟수')
    fireEvent.change(input, { target: { value: '7' } })
    expect(setAutoChainLimit).not.toHaveBeenCalled() // 적는 동안엔 안 보낸다
    await act(async () => { fireEvent.keyDown(input, { key: 'Enter' }) })
    await settle()
    expect(setAutoChainLimit.mock.calls).toEqual([[7]])
    expect(store.getState().autoChainLimit).toBe(7)

    fireEvent.change(input, { target: { value: '9' } })
    await act(async () => { fireEvent.blur(input) })
    await settle()
    expect(setAutoChainLimit.mock.calls).toEqual([[7], [9]])

    // 안 바뀐 값
    await act(async () => { fireEvent.blur(input) })
    await act(async () => { fireEvent.keyDown(input, { key: 'Enter' }) })
    await settle()
    expect(setAutoChainLimit).toHaveBeenCalledTimes(2)
  })

  it('limitInvalidNeverSent — 21 · 0 · 빈칸 · 3.5 는 까닭만 보이고 안 보낸다 · 탭을 바꿨다 오면 저장된 값', async () => {
    await renderApp()
    const { dlg } = openSettings()
    goTab(dlg, '에이전트')
    for (const bad of ['21', '0', '', '3.5']) {
      const input = limitInput(dlg)
      fireEvent.change(input, { target: { value: bad } })
      expect(within(dlg).getByText('1부터 20까지 적을 수 있어요')).toBeTruthy()
      expect(input.getAttribute('aria-invalid')).toBe('true')
      await act(async () => { fireEvent.keyDown(input, { key: 'Enter' }) })
      await act(async () => { fireEvent.blur(input) })
      await settle()
    }
    expect(setAutoChainLimit).not.toHaveBeenCalled()
    fireEvent.change(limitInput(dlg), { target: { value: '99' } })
    goTab(dlg, '일반')
    goTab(dlg, '에이전트')
    expect(limitInput(dlg).value).toBe('3')
    expect(within(dlg).queryByText('1부터 20까지 적을 수 있어요')).toBeNull()
    // 적은 채로 닫았다 다시 열어도
    fireEvent.change(limitInput(dlg), { target: { value: '0' } })
    fireEvent.click(within(dlg).getByRole('button', { name: '닫기' }))
    expect(setAutoChainLimit).not.toHaveBeenCalled()
    const again = openSettings()
    goTab(again.dlg, '에이전트')
    expect(limitInput(again.dlg).value).toBe('3')
  })

  it('상한을 못 바꾸면 그 줄 아래 까닭 · 칸은 저장된 값', async () => {
    setAutoChainLimit.mockRejectedValueOnce(new Error('상한은 1 이상이어야 해요.'))
    await renderApp()
    const { dlg } = openSettings()
    goTab(dlg, '에이전트')
    const input = limitInput(dlg)
    fireEvent.change(input, { target: { value: '4' } })
    await act(async () => { fireEvent.keyDown(input, { key: 'Enter' }) })
    await settle()
    const err = within(dlg).getByText('상한은 1 이상이어야 해요.')
    expect(err.classList.contains('fe')).toBe(true)
    expect(input.value).toBe('3')
  })

  it('bypassConfirmStacksOverSettings — 켜기는 설정 위에 확인 창 · Esc 는 확인 창만 · [허용] 이면 켜짐 · 끄기는 확인 없이', async () => {
    const store = await renderApp()
    const { dlg } = openSettings()
    goTab(dlg, '에이전트')
    const bypass = sw(dlg, '묻지 않고 실행 허용')
    expect(bypass.getAttribute('aria-checked')).toBe('false')
    expect(dlg.textContent).toContain('켜면 에이전트마다 승인 없이 실행하게 할 수 있어요')
    expect(dlg.textContent).not.toContain('Bypass Permissions')
    fireEvent.click(bypass)
    expect(setAllowBypass).not.toHaveBeenCalled()
    const confirm = screen.getByRole('alertdialog', { name: '묻지 않고 실행을 허용할까요?' })
    expect(confirm.textContent).toContain("허용하면 에이전트마다 '묻지 않음'을 켤 수 있어요. 켠 에이전트는 파일 수정·명령 실행을 묻지 않고 바로 해요. 믿을 수 있는 폴더에서만 켜 주세요.")
    expect(screen.getByRole('dialog', { name: '설정' })).toBeTruthy() // 설정 창은 그대로

    fireEvent.keyDown(confirm, { key: 'Escape' })
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(screen.getByRole('dialog', { name: '설정' })).toBeTruthy()
    expect(setAllowBypass).not.toHaveBeenCalled()

    fireEvent.click(bypass)
    const confirm2 = screen.getByRole('alertdialog')
    await act(async () => { fireEvent.click(within(confirm2).getByRole('button', { name: '허용' })) })
    await settle()
    expect(setAllowBypass.mock.calls).toEqual([[true]])
    expect(store.getState().allowBypass).toBe(true)
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(sw(dlg, '묻지 않고 실행 허용').getAttribute('aria-checked')).toBe('true')

    await act(async () => { fireEvent.click(sw(dlg, '묻지 않고 실행 허용')) })
    await settle()
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(setAllowBypass.mock.calls).toEqual([[true], [false]])
  })

  it('확인 창이 떠 있는 동안 onCoveredChange(true) · 닫으면 false', async () => {
    const { getStore } = await import('../../src/renderer/state/store')
    const { SettingsDialog } = await import('../../src/renderer/shell/SettingsDialog')
    await act(async () => { await getStore().init() })
    const covered = vi.fn()
    render(<SettingsDialog onClose={() => {}} onReplayTour={() => {}} initialTab="agents" onCoveredChange={covered} />)
    const dlg = screen.getByRole('dialog', { name: '설정' })
    fireEvent.click(sw(dlg, '묻지 않고 실행 허용'))
    expect(covered).toHaveBeenLastCalledWith(true)
    fireEvent.keyDown(screen.getByRole('alertdialog'), { key: 'Escape' })
    expect(covered).toHaveBeenLastCalledWith(false)
  })
})

describe('SettingsDialog — 알림', () => {
  it('notifySwitches — 끄면 setNotify({asks:false}) · 그때 일이 끝나면은 잠기고 안 보낸다 · 켜져 있을 때 켜면 {finished:true}', async () => {
    await renderApp()
    const { dlg } = openSettings()
    goTab(dlg, '알림')
    expect(dlg.textContent).toContain('Windows 알림')
    expect(dlg.textContent).toContain('창이 가려져 있을 때')
    const fin = sw(dlg, '일이 끝나면')
    expect(fin.getAttribute('aria-disabled')).toBeNull()
    await act(async () => { fireEvent.click(fin) })
    await settle()
    expect(setNotify.mock.calls).toEqual([[{ finished: true }]])
    expect(fin.getAttribute('aria-checked')).toBe('true')

    await act(async () => { fireEvent.click(sw(dlg, '승인·질문이 오면')) })
    await settle()
    expect(setNotify.mock.calls).toEqual([[{ finished: true }], [{ asks: false }]])
    expect(sw(dlg, '일이 끝나면').getAttribute('aria-disabled')).toBe('true')
    await act(async () => { fireEvent.click(sw(dlg, '일이 끝나면')) })
    await settle()
    expect(setNotify).toHaveBeenCalledTimes(2)
    // 승인·질문을 다시 켜면 잠김이 풀린다
    await act(async () => { fireEvent.click(sw(dlg, '승인·질문이 오면')) })
    await settle()
    expect(setNotify.mock.calls[2]).toEqual([{ asks: true }])
    expect(sw(dlg, '일이 끝나면').getAttribute('aria-disabled')).toBeNull()
  })

  it('switchSendsOnceAndShowsError — 보내는 중엔 한 번만 · 실패하면 저장된 값 + 그 줄 아래 까닭', async () => {
    let fail!: (e: Error) => void
    setNotify.mockImplementationOnce(() => new Promise((_res, rej) => { fail = rej }))
    await renderApp()
    const { dlg } = openSettings()
    goTab(dlg, '알림')
    const fin = sw(dlg, '일이 끝나면')
    fireEvent.click(fin)
    fireEvent.click(fin)
    fireEvent.click(fin)
    expect(setNotify).toHaveBeenCalledTimes(1)
    await act(async () => { fail(new Error('저장하지 못했어요')) })
    await settle()
    expect(fin.getAttribute('aria-checked')).toBe('false')
    const err = within(dlg).getByText('저장하지 못했어요')
    expect(err.closest('[data-row]')!.contains(fin)).toBe(true)
    // 끝났으니 다시 누르면 다시 보낸다
    await act(async () => { fireEvent.click(fin) })
    await settle()
    expect(setNotify).toHaveBeenCalledTimes(2)
    expect(within(dlg).queryByText('저장하지 못했어요')).toBeNull()
  })
})

describe('SettingsDialog — 두레', () => {
  const push = (p: any) => act(async () => { handlers['update']?.(p) })
  const AV = { kind: 'available', version: '0.2.0', current: '0.1.0', highlights: [], url: 'u' }
  const open = () => {
    const r = openSettings()
    goTab(r.dlg, '두레')
    return r.dlg
  }

  it('aboutPane — 판 · [업데이트 확인] → checkUpdate · 결과 줄', async () => {
    await renderApp()
    const dlg = open()
    expect(within(dlg).getByText('업데이트')).toBeTruthy()
    expect(within(dlg).getByText('두레 0.1.0')).toBeTruthy()
    await act(async () => { fireEvent.click(within(dlg).getByRole('button', { name: '업데이트 확인' })) })
    expect(checkUpdate).toHaveBeenCalledTimes(1)
    await push({ kind: 'checking' })
    expect(within(dlg).getByText('확인하는 중…')).toBeTruthy()
    await push({ kind: 'none' })
    expect(within(dlg).getByText('최신이에요')).toBeTruthy()
  })

  it('available — 새 버전 줄 + [업데이트] → downloadUpdate', async () => {
    await renderApp()
    const dlg = open()
    await push(AV)
    expect(within(dlg).getByText('새 버전 0.2.0 이 있어요')).toBeTruthy()
    await act(async () => { fireEvent.click(within(dlg).getByRole('button', { name: '업데이트' })) })
    expect(downloadUpdate).toHaveBeenCalledTimes(1)
  })

  it('downloading · ready — 받는 중 % · [다시 켜기] → installUpdate', async () => {
    await renderApp()
    const dlg = open()
    await push({ kind: 'downloading', version: '0.2.0', percent: 42 })
    expect(within(dlg).getByText('받고 있어요 · 42%')).toBeTruthy()
    await push({ kind: 'ready', version: '0.2.0' })
    expect(within(dlg).getByText('준비됐어요')).toBeTruthy()
    await act(async () => { fireEvent.click(within(dlg).getByRole('button', { name: '다시 켜기' })) })
    expect(installUpdate).toHaveBeenCalledTimes(1)
  })

  it('error — 확인 실패(version 없음)는 첫 줄만 · 80자까지 · [다시 시도] 없음', async () => {
    await renderApp()
    const dlg = open()
    await push({ kind: 'error', message: '  net::ERR_FAILED  \nstack line two', version: null })
    expect(within(dlg).getByText('확인하지 못했어요 — net::ERR_FAILED')).toBeTruthy()
    expect(within(dlg).queryByText(/stack line two/)).toBeNull()
    expect(within(dlg).queryByRole('button', { name: '다시 시도' })).toBeNull()
    expect(within(dlg).queryByRole('button', { name: '다시 켜기' })).toBeNull()
    await push({ kind: 'error', message: 'x'.repeat(100), version: null })
    expect(within(dlg).getByText(`확인하지 못했어요 — ${'x'.repeat(80)}…`)).toBeTruthy()
  })

  it('error — 설치 실패 글은 그대로 + [다시 켜기] → installUpdate (downloadUpdate 는 안 부름)', async () => {
    await renderApp()
    const dlg = open()
    await push({ kind: 'error', message: '업데이트를 설치하지 못했어요', version: '0.2.0' })
    expect(within(dlg).getByText('업데이트를 설치하지 못했어요')).toBeTruthy()
    expect(dlg.textContent).not.toContain('확인하지 못했어요 —')
    expect(within(dlg).queryByRole('button', { name: '다시 시도' })).toBeNull()
    await act(async () => { fireEvent.click(within(dlg).getByRole('button', { name: '다시 켜기' })) })
    expect(installUpdate).toHaveBeenCalledTimes(1)
    expect(downloadUpdate).not.toHaveBeenCalled()
  })

  it('받기 실패(version 있음) — 받지 못했어요 + [다시 시도] → downloadUpdate · 영어 오류 글은 안 보임 · installUpdate 는 안 부름', async () => {
    await renderApp()
    const dlg = open()
    await push({ kind: 'error', message: 'net::ERR_CONNECTION_RESET\n    at SimpleURLLoaderWrapper', version: '0.2.0' })
    expect(within(dlg).getByText('받지 못했어요')).toBeTruthy()
    expect(dlg.textContent).not.toContain('확인하지 못했어요')
    expect(dlg.textContent).not.toContain('ERR_CONNECTION_RESET')
    expect(within(dlg).queryByRole('button', { name: '다시 켜기' })).toBeNull()
    await act(async () => { fireEvent.click(within(dlg).getByRole('button', { name: '다시 시도' })) })
    expect(downloadUpdate).toHaveBeenCalledTimes(1)
    expect(installUpdate).not.toHaveBeenCalled()
  })

  it('ready — 일하는 에이전트(모든 방의 작업 중·승인 기다림)가 있으면 노란 줄, 다 쉬면 없음', async () => {
    snapshot = {
      ...snapshot,
      rooms: [...snapshot.rooms, { id: 'r2', name: '서버', createdAt: 2 }],
      agents: [agent('a', 'r1', 'working'), agent('b', 'r2', 'awaiting'), agent('c', 'r1', 'idle')],
    }
    ;(window as any).dure.updateAgent = async () => ({})
    await renderApp()
    const dlg = open()
    await push({ kind: 'ready', version: '0.2.0' })
    expect(within(dlg).getByText('준비됐어요')).toBeTruthy()
    expect(within(dlg).getByText('일하는 에이전트 2명이 멈춰요 — 다시 켜진 뒤 말을 걸면 이어서 해요')).toBeTruthy()
    await act(async () => {
      handlers['status']?.({ agentId: 'a', status: 'idle', errorText: null })
      handlers['status']?.({ agentId: 'b', status: 'idle', errorText: null })
    })
    expect(within(dlg).queryByText(/명이 멈춰요/)).toBeNull()
  })

  it('downloading — 일하는 에이전트가 있어도 노란 줄 없음', async () => {
    snapshot = { ...snapshot, agents: [agent('a', 'r1', 'working'), agent('b', 'r1', 'awaiting')] }
    ;(window as any).dure.updateAgent = async () => ({})
    await renderApp()
    const dlg = open()
    await push({ kind: 'downloading', version: '0.2.0', percent: 10 })
    expect(within(dlg).getByText('받고 있어요 · 10%')).toBeTruthy()
    expect(within(dlg).queryByText(/명이 멈춰요/)).toBeNull()
  })

  it('ready — [업데이트 확인] 은 꺼진다(다 받아 둔 것을 다시 확인하지 않는다)', async () => {
    await renderApp()
    const dlg = open()
    const check = within(dlg).getByRole('button', { name: '업데이트 확인' }) as HTMLButtonElement
    expect(check.disabled).toBe(false)
    await push({ kind: 'ready', version: '0.2.0' })
    expect(check.disabled).toBe(true)
    fireEvent.click(check)
    expect(checkUpdate).not.toHaveBeenCalled()
  })

  it('dev — 확인 단추 없이 개발 실행 안내', async () => {
    updateNow = { kind: 'dev' }
    await renderApp()
    const dlg = open()
    expect(within(dlg).getByText('개발 실행이라 확인하지 않아요')).toBeTruthy()
    expect(within(dlg).queryByRole('button', { name: '업데이트 확인' })).toBeNull()
  })

  it('켤 때 claude 최신으로 — 끄면 setPrefs({claudeAutoUpdate:false}) · [다시 보기] → onReplayTour (창 닫고 투어)', async () => {
    const store = await renderApp()
    const spy = vi.spyOn(store, 'startTour')
    const dlg = open()
    const auto = sw(dlg, '켤 때 claude 최신으로')
    expect(dlg.textContent).toContain('이 PC 와 서버의 claude 를 바꿔요')
    expect(auto.getAttribute('aria-checked')).toBe('true')
    await act(async () => { fireEvent.click(auto) })
    await settle()
    expect(setPrefsApi).toHaveBeenCalledWith({ claudeAutoUpdate: false })
    expect(sw(dlg, '켤 때 claude 최신으로').getAttribute('aria-checked')).toBe('false')

    expect(within(dlg).getByText('처음 쓰는 안내')).toBeTruthy()
    await act(async () => { fireEvent.click(within(dlg).getByRole('button', { name: '다시 보기' })) })
    expect(screen.queryByRole('dialog', { name: '설정' })).toBeNull()
    expect(spy).toHaveBeenCalledWith(true)
  })
})
