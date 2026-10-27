import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act, fireEvent, cleanup, within, waitFor } from '@testing-library/react'
import type { EngineEventMap, PendingRequest } from '../../src/engine/types'
import type { AgentView, Snapshot } from '../../src/shared/ipcContract'
import { allowMotion, fastMotion } from './motion'

const agent = (over: Partial<AgentView> = {}): AgentView => ({
  id: 'w', roomId: 'r1', name: '웹 화면', role: '역할', folder: 'C:\w', sessionId: 's', started: true, auto: false, model: null,
  alwaysAllow: ['Bash', 'Edit'], pos: { x: 64, y: 64 }, color: null, effort: null, lastContext: null, bypassOn: false, effortNow: null, modelNow: null, status: 'idle', errorText: null, bypass: false, bypassBySettings: false, bypassPending: false, heldInput: 0, planMode: false, asleep: false, waking: false, hold: null, subagentsRunning: [], ...over,
})

let snapshot: Snapshot
let handlers: Record<string, ((p: any) => void)[]>
let alwaysNow: string[] // 엔진 쪽 늘 허용 목록 — 사건으로만 화면에 간다(스냅샷은 처음 것 그대로)
let revoke: ReturnType<typeof vi.fn>
let answerRequest: ReturnType<typeof vi.fn>
let snapshotCalls: ReturnType<typeof vi.fn>

const emit = <K extends keyof EngineEventMap>(k: K, p: EngineEventMap[K]) => (handlers[k] ?? []).forEach(f => f(p))
const patch = (p: Partial<AgentView>) => {
  snapshot = { ...snapshot, agents: snapshot.agents.map(a => ({ ...a, ...p })) }
}

beforeEach(() => {
  vi.resetModules()
  handlers = {}
  alwaysNow = ['Bash', 'Edit']
  snapshot = {
    claudeMissing: false, rooms: [{ id: 'r1', name: '여름 캠페인', createdAt: 1 }],
    agents: [agent()], messages: [], requests: [], autoChainLimit: 3, allowBypass: false, notify: { asks: true, finished: false }, sleepAfterMin: 30, usage: null,
  }
  // 엔진처럼 — 바꾸면 always-allow 사건을 보내고(답보다 먼저), 스냅샷은 다시 받을 필요가 없다
  revoke = vi.fn(async (_id: string, tool: string) => {
    if (!alwaysNow.includes(tool)) return agent({ alwaysAllow: alwaysNow })
    alwaysNow = alwaysNow.filter(t => t !== tool)
    emit('always-allow', { agentId: 'w', alwaysAllow: alwaysNow })
    return agent({ alwaysAllow: alwaysNow })
  })
  answerRequest = vi.fn(async (id: string, d: { type: string }) => {
    const r = snapshot.requests.find(x => x.id === id)!
    if (d.type === 'allow-always' && !alwaysNow.includes(r.toolName)) {
      alwaysNow = [...alwaysNow, r.toolName]
      emit('always-allow', { agentId: 'w', alwaysAllow: alwaysNow })
    }
    emit('request-resolved', { id, agentId: 'w' })
  })
  snapshotCalls = vi.fn(async () => snapshot)
  ;(window as any).dure = {
    revokeAlwaysAllow: revoke, answerRequest, describe: vi.fn(async () => ({ commands: [], permissionMode: 'default', models: [] })),
    snapshot: snapshotCalls, history: async () => [],
    on: (k: string, fn: (p: any) => void) => {
      ;(handlers[k] ??= []).push(fn)
      return () => {}
    },
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
const undoIn = (tool: string) => {
  const row = within(screen.getByRole('dialog')).getByText(tool).closest('li') as HTMLElement
  return within(row).getByRole('button', { name: '되돌리기' })
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

  it("승인 카드의 '앞으로 … 묻지 않기' 를 누르면 메뉴의 수와 대화상자가 바로 바뀐다 — 스냅샷을 다시 받지 않는다", async () => {
    alwaysNow = []
    patch({ alwaysAllow: [] })
    const req: PendingRequest = { id: 'q1', agentId: 'w', toolName: 'Bash', input: { command: 'ls' }, kind: 'permission', createdAt: Date.now() }
    snapshot = { ...snapshot, requests: [req] }
    await renderPanel()
    fireEvent.click(menuButton())
    expect(screen.getByRole('menuitem', { name: /항상 허용한 일/ }).textContent).not.toMatch(/\d/)
    fireEvent.click(menuButton()) // 닫는다
    const calls = snapshotCalls.mock.calls.length
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '앞으로 웹 화면의 명령 실행은 묻지 않기' })) })
    await settle()
    expect(answerRequest).toHaveBeenCalledWith('q1', { type: 'allow-always' })
    expect(snapshotCalls.mock.calls.length).toBe(calls) // 사건만으로
    fireEvent.click(menuButton())
    const mi = screen.getByRole('menuitem', { name: /항상 허용한 일/ })
    expect(mi.textContent).toContain('1')
    fireEvent.click(mi)
    const dlg = screen.getByRole('dialog')
    expect(dlg.textContent).not.toContain('묻지 않고 하는 일이 없어요')
    expect(within(dlg).getByText('Bash')).toBeTruthy()
  })

  it('되돌리기 → revokeAlwaysAllow 후 그 줄이 사라지고 초점은 다음 줄의 되돌리기 — 마지막이면 [닫기]', async () => {
    await renderPanel()
    openDialog()
    const calls = snapshotCalls.mock.calls.length
    await act(async () => { fireEvent.click(undoIn('Bash')) })
    await settle()
    expect(revoke).toHaveBeenCalledWith('w', 'Bash')
    expect(snapshotCalls.mock.calls.length).toBe(calls) // 다시 받지 않는다 — 사건으로
    expect(within(screen.getByRole('dialog')).queryByText('Bash')).toBeNull()
    expect(screen.getByRole('dialog').textContent).toContain('파일 고치기')
    expect(document.activeElement).toBe(undoIn('Edit'))

    await act(async () => { fireEvent.click(undoIn('Edit')) })
    await settle()
    expect(screen.getByRole('dialog').textContent).toContain('묻지 않고 하는 일이 없어요')
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '닫기' }))
  })

  it('맨 끝 줄을 되돌리면 초점은 앞 줄로 · 실패하면 그 줄의 되돌리기로 돌아오고 문구', async () => {
    await renderPanel()
    openDialog()
    await act(async () => { fireEvent.click(undoIn('Edit')) })
    await settle()
    expect(document.activeElement).toBe(undoIn('Bash'))

    revoke.mockImplementationOnce(async () => { throw new Error('에이전트를 찾을 수 없습니다') })
    await act(async () => { fireEvent.click(undoIn('Bash')) })
    await settle()
    expect(screen.getByRole('dialog').textContent).toContain('에이전트를 찾을 수 없습니다')
    expect(document.activeElement).toBe(undoIn('Bash'))
  })

  it('되돌린 줄은 MOTION.line 으로 나간다 — 나가는 동안 inert, 끝나면 빠진다', async () => {
    allowMotion()
    await renderPanel()
    openDialog()
    // 사건은 되돌리기를 부르는 그 자리에서 온다 — 답을 기다리기 전에 나가기가 시작된다
    act(() => { fireEvent.click(undoIn('Bash')) })
    const leaving = within(screen.getByRole('dialog')).getByText('Bash').closest('li') as HTMLElement
    expect(leaving.hasAttribute('inert')).toBe(true)
    const restore = fastMotion()
    await waitFor(() => expect(within(screen.getByRole('dialog')).queryByText('Bash')).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(undoIn('Edit')))
    restore()
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
