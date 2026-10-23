import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act, fireEvent, cleanup, within } from '@testing-library/react'
import type { AgentView, Snapshot } from '../../src/shared/ipcContract'

const agent = (over: Partial<AgentView> = {}): AgentView => ({
  id: 'w', roomId: 'r1', name: '웹 화면', role: '역할', folder: 'C:\w', sessionId: 's', started: true, auto: false, model: null,
  alwaysAllow: ['Bash', 'Edit'], pos: { x: 64, y: 64 }, color: null, effort: null, lastContext: null, bypassOn: false, effortNow: null, modelNow: null, status: 'idle', errorText: null, bypass: false, bypassBySettings: false, bypassPending: false, heldInput: 0, planMode: false, hold: null, subagentsRunning: [], ...over,
})

let snapshot: Snapshot
let revoke: ReturnType<typeof vi.fn>

const patch = (p: Partial<AgentView>) => {
  snapshot = { ...snapshot, agents: snapshot.agents.map(a => ({ ...a, ...p })) }
}

beforeEach(() => {
  vi.resetModules()
  snapshot = {
    claudeMissing: false, rooms: [{ id: 'r1', name: '여름 캠페인', createdAt: 1 }],
    agents: [agent()], messages: [], requests: [], autoChainLimit: 3, allowBypass: false, notify: { asks: true, finished: false }, usage: null,
  }
  // 엔진처럼 — 이벤트는 없고 다음 스냅샷에 바뀐 값이 들어 있다
  revoke = vi.fn(async (_id: string, tool: string) => {
    patch({ alwaysAllow: snapshot.agents[0].alwaysAllow.filter(t => t !== tool) })
    return snapshot.agents[0]
  })
  ;(window as any).dure = {
    revokeAlwaysAllow: revoke, describe: vi.fn(async () => ({ commands: [], permissionMode: 'default', models: [] })),
    snapshot: async () => snapshot, history: async () => [], on: () => () => {},
  }
})
afterEach(() => cleanup())

const settle = () => act(async () => { await new Promise(r => setTimeout(r, 0)) })

async function renderPanel() {
  const { getStore } = await import('../../src/renderer/state/store')
  const { AgentPanel } = await import('../../src/renderer/panel/AgentPanel')
  await act(async () => { await getStore().init() })
  render(<AgentPanel />)
  await act(async () => { getStore().selectAgent('w') })
  await settle()
}

const menuButton = () => screen.getByRole('button', { name: '메뉴' })
const openDialog = () => {
  fireEvent.click(menuButton())
  fireEvent.click(screen.getByRole('menuitem', { name: /항상 허용한 일/ }))
}

describe('AlwaysAllowDialog', () => {
  it('메뉴에 항상 허용한 일과 수 — 누르면 대화상자', async () => {
    await renderPanel()
    fireEvent.click(menuButton())
    const mi = screen.getByRole('menuitem', { name: /항상 허용한 일/ })
    expect(mi.textContent).toContain('2')
    fireEvent.click(mi)
    const dlg = screen.getByRole('dialog')
    expect(dlg.textContent).toContain('웹 화면이 묻지 않고 하는 일')
    expect(dlg.textContent).toContain('여기 있는 일은 승인 없이 바로 해요. 되돌리면 다음부터 다시 물어요.')
    expect(dlg.textContent).toContain('명령 실행')
    expect(dlg.textContent).toContain('Bash')
    expect(dlg.textContent).toContain('파일 고치기')
  })

  it('되돌리기 → revokeAlwaysAllow 후 그 줄이 사라진다', async () => {
    await renderPanel()
    openDialog()
    const dlg = screen.getByRole('dialog')
    const row = within(dlg).getByText('Bash').closest('li')!
    await act(async () => { fireEvent.click(within(row as HTMLElement).getByRole('button', { name: '되돌리기' })) })
    await settle()
    expect(revoke).toHaveBeenCalledWith('w', 'Bash')
    expect(within(screen.getByRole('dialog')).queryByText('Bash')).toBeNull()
    expect(screen.getByRole('dialog').textContent).toContain('파일 고치기')
  })

  it('비었으면 안내 · 묻지 않음이 켜져 있으면 한 줄 더', async () => {
    patch({ alwaysAllow: [], bypass: true })
    await renderPanel()
    fireEvent.click(menuButton())
    expect(screen.getByRole('menuitem', { name: /항상 허용한 일/ }).textContent).not.toMatch(/\d/)
    fireEvent.click(screen.getByRole('menuitem', { name: /항상 허용한 일/ }))
    const dlg = screen.getByRole('dialog')
    expect(dlg.textContent).toContain('묻지 않고 하는 일이 없어요')
    expect(dlg.textContent).toContain("승인 카드의 '앞으로 … 묻지 않기'로 생겨요")
    expect(dlg.textContent).toContain('지금은 묻지 않음이 켜져 있어 모든 일을 묻지 않아요')
  })

  it('Esc 로 닫히고 초점은 메뉴 단추로', async () => {
    await renderPanel()
    openDialog()
    expect(screen.getByRole('dialog')).toBeTruthy()
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(menuButton())
  })
})
