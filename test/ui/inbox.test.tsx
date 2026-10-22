import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { render, screen, act, fireEvent, cleanup, within } from '@testing-library/react'
import type { Decision, EngineEventMap, PendingRequest, RelayMessage } from '../../src/engine/types'
import type { AgentView, Snapshot } from '../../src/shared/ipcContract'

const MIN = 60_000

const agent = (id: string, over: Partial<AgentView> = {}): AgentView => ({
  id, roomId: 'r1', name: id, role: '역할', folder: 'C:\\w', sessionId: 's', started: true, auto: false, model: null,
  alwaysAllow: [], pos: { x: 64, y: 64 }, color: null, effort: null, lastContext: null, bypassOn: false, effortNow: null, modelNow: null, status: 'idle', errorText: null, bypass: false, bypassBySettings: false, bypassPending: false, heldInput: 0, subagentsRunning: [], ...over,
})
const request = (over: Partial<PendingRequest> = {}): PendingRequest => ({
  id: 'q1', agentId: 'd', toolName: 'Bash', input: { command: 'npm run build' },
  kind: 'permission', createdAt: Date.now() - MIN, ...over,
})
const msg = (over: Partial<RelayMessage> & { id: string }): RelayMessage => ({
  roomId: 'r1', from: 'p', to: 'd', text: '시안을 세 벌 만들어 주세요', createdAt: Date.now() - 10_000, state: 'pending',
  updatedAt: Date.now() - 10_000, ...over,
})

let snapshot: Snapshot
let handlers: Record<string, ((p: any) => void)[]>

const emit = <K extends keyof EngineEventMap>(k: K, p: EngineEventMap[K]) => act(() => (handlers[k] ?? []).forEach(f => f(p)))

beforeEach(() => {
  vi.resetModules()
  handlers = {}
  snapshot = {
    claudeMissing: false,
    rooms: [{ id: 'r1', name: '여름 캠페인', createdAt: 1 }, { id: 'r2', name: '다른 방', createdAt: 2 }],
    agents: [
      agent('p', { name: '기획' }),
      agent('d', { name: '디자인' }),
      agent('x', { name: '다른 방 사람', roomId: 'r2' }),
    ],
    messages: [], requests: [], autoChainLimit: 3, allowBypass: false, notify: { asks: true, finished: false }, usage: null,
  }
  ;(window as any).dure = {
    approveMessage: vi.fn(async () => {}),
    dismissMessage: vi.fn(async () => {}),
    continueHeld: vi.fn(async () => {}),
    answerRequest: vi.fn(async (_id: string, _d: Decision) => {}),
    snapshot: async () => snapshot,
    history: async () => [],
    describe: async () => ({ commands: [], models: [], permissionMode: 'default' }),
    on: (k: string, fn: (p: any) => void) => {
      ;(handlers[k] ??= []).push(fn)
      return () => {}
    },
  }
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const settle = () => act(async () => { await new Promise(r => setTimeout(r, 0)) })

async function renderInbox() {
  const { getStore } = await import('../../src/renderer/state/store')
  const { Inbox } = await import('../../src/renderer/panel/Inbox')
  await act(async () => { await getStore().init() })
  const r = render(<Inbox />)
  await settle()
  return { ...r, store: getStore() }
}

describe('내가 할 일 패널', () => {
  it('비었으면 안내 두 줄', async () => {
    await renderInbox()
    expect(screen.getByText('지금 할 일이 없어요')).toBeInTheDocument()
    expect(screen.getByText('에이전트가 승인이나 확인을 부탁하면 여기에 모여요.')).toBeInTheDocument()
  })

  it('순서: 권한 → 받은 메시지 → 새 결과(머리 새 결과)', async () => {
    snapshot.requests = [request()]
    snapshot.messages = [msg({ id: 'm1' })]
    const { store } = await renderInbox()
    emit('history', { agentId: 'p', item: { kind: 'result', t: Date.now() } } as any)
    expect(store.getState().fresh.p).toBeDefined()
    const names = Array.from(document.querySelectorAll('.inbox section, .inbox h3')).map(e =>
      e.tagName === 'H3' ? `H:${e.textContent}` : (e.getAttribute('aria-label') ?? ''),
    )
    expect(names).toEqual(['디자인이 명령을 실행하려 해요', '기획이 보낸 메시지', 'H:새 결과', '기획 · 끝남 · 새 결과'])
  })

  it('권한 항목엔 항상 허용이 없고 대화 보기가 그 에이전트를 고른다', async () => {
    snapshot.requests = [request()]
    const { store } = await renderInbox()
    expect(screen.queryByRole('button', { name: /항상 허용/ })).toBeNull()
    expect(screen.getByRole('button', { name: '허용' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '대화 보기' }))
    expect(store.getState().selectedAgentId).toBe('d')
  })

  it('질문 항목 답하기·만들기 항목 패널에서 확인하기가 그 에이전트를 고른다', async () => {
    snapshot.requests = [
      request({ id: 'q1', agentId: 'p', kind: 'question', toolName: 'AskUserQuestion', input: { questions: [{ question: '배너 색은 어떻게 할까요?', header: '색', options: [{ label: '파랑', description: '' }], multiSelect: false }] } }),
      request({ id: 'q2', agentId: 'd', kind: 'create-agent', toolName: 'create_agent', input: { name: '검수', role: '품질 확인', folder: 'C:\\w' }, createdAt: Date.now() }),
    ]
    const { store } = await renderInbox()
    expect(screen.getByText('기획에게 질문이 있어요')).toBeInTheDocument()
    expect(screen.getByText('배너 색은 어떻게 할까요?')).toBeInTheDocument()
    expect(screen.getByText('검수 · 품질 확인')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '답하기' }))
    expect(store.getState().selectedAgentId).toBe('p')
    fireEvent.click(screen.getByRole('button', { name: '패널에서 확인하기' }))
    expect(store.getState().selectedAgentId).toBe('d')
  })

  it('지금 하는 일 — 단계 말과 지난 시간', async () => {
    const { store } = await renderInbox()
    expect(screen.queryByText('지금 하는 일')).toBeNull()
    emit('status', { agentId: 'p', status: 'working', errorText: null } as any)
    emit('status', { agentId: 'd', status: 'working', errorText: null } as any)
    emit('agent-event', { agentId: 'd', event: { kind: 'thinking', active: true, tokens: null } } as any)
    expect(screen.getByText('지금 하는 일')).toBeInTheDocument()
    const rows = Array.from(document.querySelectorAll<HTMLElement>('.ib-run'))
    expect(rows).toHaveLength(2)
    expect(rows[0].textContent).toContain('기획')
    expect(rows[0].textContent).toContain('작업 중…')
    expect(rows[0].textContent).toMatch(/\d+초/) // 지난 시간 — 상태가 바뀐 때를 아는 에이전트만
    expect(rows[1].textContent).toContain('생각하는 중…')
    fireEvent.click(within(rows[1]).getByRole('button'))
    expect(store.getState().selectedAgentId).toBe('d')
  })

  it('다른 방에도 할 일 N개 → requestRoomMenu', async () => {
    snapshot.requests = [request({ agentId: 'x' })]
    const { store } = await renderInbox()
    const before = store.getState().roomMenuRequest
    fireEvent.click(screen.getByRole('button', { name: '다른 방에도 할 일 1개' }))
    expect(store.getState().roomMenuRequest).toBe(before + 1)
  })

  it('머리 수 = 지금 방 할 일 수(새 결과 빼고)', async () => {
    snapshot.requests = [request()]
    snapshot.messages = [msg({ id: 'm1' }), msg({ id: 'm2', createdAt: Date.now() })]
    await renderInbox()
    expect(document.querySelector('.ib-h')!.textContent).toBe('내가 할 일3')
  })
})
