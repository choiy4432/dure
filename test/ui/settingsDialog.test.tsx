import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act, fireEvent, cleanup, within } from '@testing-library/react'
import type { Snapshot } from '../../src/shared/ipcContract'

let snapshot: Snapshot
let setAutoChainLimit: ReturnType<typeof vi.fn>
let setAllowBypass: ReturnType<typeof vi.fn>
let setNotify: ReturnType<typeof vi.fn>
let setTheme: ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.resetModules()
  localStorage.clear()
  snapshot = {
    claudeMissing: false, rooms: [{ id: 'r1', name: '여름 캠페인', createdAt: 1 }], agents: [],
    messages: [], requests: [], autoChainLimit: 3, allowBypass: false, notify: { asks: true, finished: false }, usage: null,
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
  ;(window as any).dure = { setAutoChainLimit, setAllowBypass, setNotify, setTheme, snapshot: async () => snapshot, history: async () => [], on: () => () => {} }
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

describe('SettingsDialog', () => {
  it('지금 상한을 보여 주고 1~20 정수로 바꿨을 때만 저장이 켜진다 — 저장하면 setAutoChainLimit 후 닫힘', async () => {
    const store = await renderApp()
    const { dlg, opener } = openSettings()
    const input = within(dlg).getByRole('spinbutton', { name: '자동 전달 상한' }) as HTMLInputElement
    expect(input.value).toBe('3')
    expect(document.activeElement).toBe(input)
    expect(dlg.textContent).toContain('자동 켠 에이전트끼리 사람 확인 없이 이어서 주고받을 수 있는 횟수')
    const save = within(dlg).getByRole('button', { name: '저장' }) as HTMLButtonElement
    expect(save.disabled).toBe(true) // 바뀐 게 없다

    for (const bad of ['0', '21', '2.5', '-1', '']) {
      fireEvent.change(input, { target: { value: bad } })
      expect(save.disabled).toBe(true)
      if (bad !== '') expect(input.getAttribute('aria-invalid')).toBe('true')
    }
    fireEvent.change(input, { target: { value: '21' } })
    expect(within(dlg).getByText('1부터 20까지 적을 수 있어요')).toBeTruthy()

    fireEvent.change(input, { target: { value: '20' } })
    expect(save.disabled).toBe(false)
    expect(input.getAttribute('aria-invalid')).toBeNull()
    expect(within(dlg).queryByText('1부터 20까지 적을 수 있어요')).toBeNull()

    fireEvent.change(input, { target: { value: '5' } })
    await act(async () => { fireEvent.click(save) })
    await settle()
    expect(setAutoChainLimit).toHaveBeenCalledTimes(1)
    expect(setAutoChainLimit).toHaveBeenCalledWith(5)
    expect(screen.queryByRole('dialog', { name: '설정' })).toBeNull()
    expect(store.getState().autoChainLimit).toBe(5)
    expect(document.activeElement).toBe(opener)

    // 다시 열면 저장한 값
    const again = openSettings()
    expect((within(again.dlg).getByRole('spinbutton') as HTMLInputElement).value).toBe('5')
  })

  it('엔진 오류는 칸 아래 빨간 글 — 대화상자는 열린 채', async () => {
    setAutoChainLimit.mockRejectedValueOnce(new Error('상한은 1 이상이어야 해요.'))
    await renderApp()
    const { dlg } = openSettings()
    const input = within(dlg).getByRole('spinbutton', { name: '자동 전달 상한' })
    fireEvent.change(input, { target: { value: '4' } })
    await act(async () => { fireEvent.submit(input.closest('form')!) })
    await settle()
    const err = within(dlg).getByText('상한은 1 이상이어야 해요.')
    expect(err.classList.contains('fe')).toBe(true)
    expect(err.closest('.fld')!.contains(input)).toBe(true)
    expect(screen.getByRole('dialog', { name: '설정' })).toBeTruthy()
  })

  it('범위 밖 값은 Enter 로도 저장되지 않는다 · Esc 는 저장하지 않고 닫는다', async () => {
    await renderApp()
    const { dlg } = openSettings()
    const input = within(dlg).getByRole('spinbutton', { name: '자동 전달 상한' })
    fireEvent.change(input, { target: { value: '99' } })
    await act(async () => { fireEvent.submit(input.closest('form')!) })
    expect(setAutoChainLimit).not.toHaveBeenCalled()
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(setAutoChainLimit).not.toHaveBeenCalled()
  })
})

describe('SettingsDialog — 묻지 않고 실행 허용', () => {
  const allowSwitch = (dlg: HTMLElement) => within(dlg).getByRole('switch', { name: /묻지 않고 실행 허용/ })

  it('허용이 꺼져 있으면 스위치는 꺼짐 · 켜고 저장하면 설정 창이 닫히고 확인 창이 뜬다 — [허용] 이면 setAllowBypass(true)', async () => {
    const store = await renderApp()
    const { dlg } = openSettings()
    const sw = allowSwitch(dlg)
    expect(sw.getAttribute('aria-checked')).toBe('false')
    expect(dlg.textContent).toContain('Bypass Permissions')
    expect(dlg.textContent).toContain('켜면 에이전트마다 승인 없이 실행하게 할 수 있어요')
    const save = within(dlg).getByRole('button', { name: '저장' }) as HTMLButtonElement
    expect(save.disabled).toBe(true)
    fireEvent.click(sw)
    expect(sw.getAttribute('aria-checked')).toBe('true')
    expect(save.disabled).toBe(false)
    expect(setAllowBypass).not.toHaveBeenCalled() // 폼 값일 뿐 — 저장에서 반영
    await act(async () => { fireEvent.click(save) })
    await settle()
    expect(screen.queryByRole('dialog', { name: '설정' })).toBeNull()
    expect(setAllowBypass).not.toHaveBeenCalled()
    const confirm = screen.getByRole('alertdialog', { name: '묻지 않고 실행을 허용할까요?' })
    expect(confirm.textContent).toContain("허용하면 에이전트마다 '묻지 않음'을 켤 수 있어요. 켠 에이전트는 파일 수정·명령 실행을 묻지 않고 바로 해요. 믿을 수 있는 폴더에서만 켜 주세요.")
    await act(async () => { fireEvent.click(within(confirm).getByRole('button', { name: '허용' })) })
    await settle()
    expect(setAllowBypass).toHaveBeenCalledWith(true)
    expect(store.getState().allowBypass).toBe(true)
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })

  it('확인 창에서 [취소] 면 setAllowBypass 를 부르지 않고, 같이 바꾼 상한은 저장된다', async () => {
    const store = await renderApp()
    const { dlg } = openSettings()
    fireEvent.change(within(dlg).getByRole('spinbutton', { name: '자동 전달 상한' }), { target: { value: '7' } })
    fireEvent.click(allowSwitch(dlg))
    await act(async () => { fireEvent.click(within(dlg).getByRole('button', { name: '저장' })) })
    await settle()
    expect(setAutoChainLimit).toHaveBeenCalledWith(7)
    const confirm = screen.getByRole('alertdialog')
    await act(async () => { fireEvent.click(within(confirm).getByRole('button', { name: '취소' })) })
    await settle()
    expect(setAllowBypass).not.toHaveBeenCalled()
    expect(store.getState().allowBypass).toBe(false)
    expect(store.getState().autoChainLimit).toBe(7)
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })

  it('켜져 있을 때 끄고 저장하면 확인 없이 setAllowBypass(false)', async () => {
    snapshot.allowBypass = true
    const store = await renderApp()
    const { dlg } = openSettings()
    const sw = allowSwitch(dlg)
    expect(sw.getAttribute('aria-checked')).toBe('true')
    fireEvent.click(sw)
    await act(async () => { fireEvent.click(within(dlg).getByRole('button', { name: '저장' })) })
    await settle()
    expect(setAllowBypass).toHaveBeenCalledWith(false)
    expect(setAutoChainLimit).not.toHaveBeenCalled()
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(screen.queryByRole('dialog', { name: '설정' })).toBeNull()
    expect(store.getState().allowBypass).toBe(false)
  })

  it('알림 두 스위치 — 저장하면 바뀐 칸만 setNotify', async () => {
    const store = await renderApp()
    const { dlg } = openSettings()
    const asks = within(dlg).getByRole('switch', { name: /Windows 알림/ })
    const fin = within(dlg).getByRole('switch', { name: /일이 끝나도 알림/ })
    expect(dlg.textContent).toContain('창이 가려져 있을 때 승인·질문을 알려 줘요')
    expect(dlg.textContent).toContain('창이 가려져 있을 때 일을 끝내면 알려 줘요')
    expect(asks.getAttribute('aria-checked')).toBe('true')
    expect(fin.getAttribute('aria-checked')).toBe('false')
    const save = within(dlg).getByRole('button', { name: '저장' }) as HTMLButtonElement
    expect(save.disabled).toBe(true)
    fireEvent.click(fin)
    expect(save.disabled).toBe(false)
    fireEvent.click(save)
    await settle()
    expect(setNotify).toHaveBeenCalledTimes(1)
    expect(setNotify).toHaveBeenCalledWith({ finished: true })
    expect(store.getState().notify).toEqual({ asks: true, finished: true })
  })

  it('Windows 알림을 끄면 일이 끝나도 알림이 흐려지고 눌리지 않는다', async () => {
    await renderApp()
    const { dlg } = openSettings()
    const asks = within(dlg).getByRole('switch', { name: /Windows 알림/ })
    const fin = within(dlg).getByRole('switch', { name: /일이 끝나도 알림/ })
    expect(fin.getAttribute('aria-disabled')).toBeNull()
    fireEvent.click(asks)
    expect(fin.getAttribute('aria-disabled')).toBe('true')
    fireEvent.click(fin)
    expect(fin.getAttribute('aria-checked')).toBe('false') // 눌림 무시
    fireEvent.click(asks)
    expect(fin.getAttribute('aria-disabled')).toBeNull()
  })
})

describe('SettingsDialog — 화면 테마', () => {
  const radios = (dlg: HTMLElement) => {
    const group = within(dlg).getByRole('radiogroup', { name: '화면 테마' })
    return {
      light: within(group).getByRole('radio', { name: '라이트' }),
      dark: within(group).getByRole('radio', { name: '다크' }),
      system: within(group).getByRole('radio', { name: 'Windows 따라감' }),
    }
  }

  it('기본은 Windows 따라감 — 누르면 저장 전에도 바로 바꾼다(setTheme)', async () => {
    const store = await renderApp()
    const { dlg } = openSettings()
    const r = radios(dlg)
    expect(r.system.getAttribute('aria-checked')).toBe('true')
    expect(r.light.getAttribute('aria-checked')).toBe('false')
    await act(async () => { fireEvent.click(r.dark) })
    await settle()
    expect(setTheme).toHaveBeenCalledWith('dark')
    expect(r.dark.getAttribute('aria-checked')).toBe('true')
    expect(store.getState().theme).toBe('dark')
    expect((within(dlg).getByRole('button', { name: '저장' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('저장하면 고른 테마 그대로 닫힌다 — 되돌리지 않는다', async () => {
    const store = await renderApp()
    const { dlg } = openSettings()
    await act(async () => { fireEvent.click(radios(dlg).light) })
    await act(async () => { fireEvent.click(within(dlg).getByRole('button', { name: '저장' })) })
    await settle()
    expect(screen.queryByRole('dialog', { name: '설정' })).toBeNull()
    expect(setTheme.mock.calls).toEqual([['light']])
    expect(store.getState().theme).toBe('light')
  })

  it.each([
    ['취소', (dlg: HTMLElement) => fireEvent.click(within(dlg).getByRole('button', { name: '취소' }))],
    ['Esc', (dlg: HTMLElement) => fireEvent.keyDown(dlg, { key: 'Escape' })],
  ])('%s 로 닫으면 열 때의 테마로 되돌린다', async (_name, close) => {
    snapshot = { ...snapshot, theme: 'light' }
    const store = await renderApp()
    const { dlg } = openSettings()
    await act(async () => { fireEvent.click(radios(dlg).dark) })
    await act(async () => { close(dlg) })
    await settle()
    expect(screen.queryByRole('dialog', { name: '설정' })).toBeNull()
    expect(setTheme.mock.calls).toEqual([['dark'], ['light']])
    expect(store.getState().theme).toBe('light')
  })

  it('테마를 안 바꾸고 닫으면 아무것도 부르지 않는다', async () => {
    await renderApp()
    const { dlg } = openSettings()
    await act(async () => { fireEvent.click(within(dlg).getByRole('button', { name: '취소' })) })
    expect(setTheme).not.toHaveBeenCalled()
  })

  it('바꾸지 못하면 오류 글 — 고른 칸은 그대로', async () => {
    setTheme.mockRejectedValueOnce(new Error('설정 파일을 쓰지 못했어요'))
    await renderApp()
    const { dlg } = openSettings()
    const r = radios(dlg)
    await act(async () => { fireEvent.click(r.dark) })
    await settle()
    expect(within(dlg).getByText('설정 파일을 쓰지 못했어요')).toBeTruthy()
    expect(r.system.getAttribute('aria-checked')).toBe('true')
    expect(r.dark.getAttribute('aria-checked')).toBe('false')
  })
})
