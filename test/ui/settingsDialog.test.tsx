import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act, fireEvent, cleanup, within } from '@testing-library/react'
import type { Snapshot } from '../../src/shared/ipcContract'

let snapshot: Snapshot
let setAutoChainLimit: ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.resetModules()
  localStorage.clear()
  snapshot = {
    claudeMissing: false, rooms: [{ id: 'r1', name: '여름 캠페인', createdAt: 1 }], agents: [],
    messages: [], requests: [], autoChainLimit: 3,
  }
  setAutoChainLimit = vi.fn(async (n: number) => {
    snapshot = { ...snapshot, autoChainLimit: n }
  })
  ;(window as any).dure = { setAutoChainLimit, snapshot: async () => snapshot, history: async () => [], on: () => () => {} }
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
