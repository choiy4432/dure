import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { render, screen, act, fireEvent, cleanup, within } from '@testing-library/react'
import type { ConversationSummary, EngineEventMap, HistoryItem } from '../../src/engine/types'
import type { AgentView, Snapshot } from '../../src/shared/ipcContract'

// 패널의 '지난 대화' 탭 — 목록 ↔ 읽기 · 이 대화로 돌아가기 · 새 에이전트로 이어 가기(움직임 줄이기 = setup.ts 기본)

const agent = (id: string, over: Partial<AgentView> = {}): AgentView => ({
  id, roomId: 'r1', name: id, role: '역할', folder: 'C:\\w', sessionId: 's', started: true, auto: false, model: null,
  alwaysAllow: [], pos: { x: 64, y: 64 }, color: null, effort: null, lastContext: null, bypassOn: false, effortNow: null, modelNow: null, status: 'idle', errorText: null, bypass: false, bypassBySettings: false, bypassPending: false, heldInput: 0, planMode: false, asleep: false, waking: false, hold: null, subagentsRunning: [], pastCount: 0, ...over,
})

const NOW = Date.now()
const DAY = 86_400_000
const two = (n: number) => String(n).padStart(2, '0')
const clock = (t: number) => `${two(new Date(t).getHours())}:${two(new Date(t).getMinutes())}`

// 새것부터 — 지금 · 보통 · Claude 쪽 기록이 지워진 것
const CONVS: ConversationSummary[] = [
  { key: 'S3', current: true, title: '히어로 배너 문구를 더 짧게 바꿔 줘', at: NOW, turns: 2, lastReply: '2안으로 바꿨어요', resumable: false, why: null },
  { key: 'S2', current: false, title: '로그인 화면 오류 메시지를 친절하게 정리해 줘', at: NOW - 3 * DAY, turns: 23, lastReply: "버튼 3곳을 '다시 시도'로 맞췄어요.", resumable: true, why: null },
  { key: 'S1', current: false, title: '메인 첫 화면 시안 세 벌 만들어 줘', at: NOW - 34 * DAY, turns: 41, lastReply: '시안 셋을 올렸어요.', resumable: false, why: 'gone' },
]
const LOGIN: HistoryItem[] = [
  { t: 1, kind: 'user', source: 'human', parts: [{ type: 'text', text: '로그인 화면 오류 메시지를 친절하게 정리해 줘' }] },
  { t: 2, kind: 'assistant', blocks: [{ type: 'text', text: '오류 문구 6곳을 바꿨어요.' }] },
  { t: 3, kind: 'result', ok: true, subtype: 'success' },
]
const MAIN: HistoryItem[] = [
  { t: 1, kind: 'user', source: 'human', parts: [{ type: 'text', text: '메인 첫 화면 시안 세 벌 만들어 줘' }] },
  { t: 2, kind: 'assistant', blocks: [{ type: 'text', text: '시안 셋을 올렸어요.' }] },
]

let snapshot: Snapshot
let handlers: Record<string, ((p: any) => void)[]>
let conversations: Mock<(id: string) => Promise<ConversationSummary[]>>
let conversation: Mock<(id: string, key: string, o?: { limit?: number }) => Promise<HistoryItem[]>>
let resumeConversation: Mock<(id: string, key: string) => Promise<void>>

beforeEach(() => {
  vi.resetModules()
  handlers = {}
  snapshot = {
    claudeMissing: false, rooms: [{ id: 'r1', name: '여름 캠페인', createdAt: 1 }, { id: 'r2', name: '다른 방', createdAt: 2 }],
    agents: [
      agent('w', { name: '웹 화면', role: '프론트 구현', folder: 'C:\\web', pastCount: 2 }),
      agent('w2', { name: '웹 화면 2' }),
      agent('x', { roomId: 'r2', name: '웹 화면 3' }), // 다른 방 — 이름이 겹쳐도 된다
    ],
    messages: [], requests: [], autoChainLimit: 3, allowBypass: false, notify: { asks: true, finished: false }, sleepAfterMin: 30, usage: null,
  }
  conversations = vi.fn(async (_id: string) => CONVS)
  conversation = vi.fn(async (_id: string, key: string, _o?: { limit?: number }) => (key === 'S2' ? LOGIN : MAIN))
  resumeConversation = vi.fn(async (_id: string, _key: string) => {})
  ;(window as any).dure = {
    snapshot: async () => snapshot,
    history: async () => [],
    describe: async () => ({ commands: [], models: [], permissionMode: 'default' }),
    sendUser: async () => {},
    conversations: (id: string) => conversations(id),
    conversation: (...a: [string, string, { limit?: number }?]) => conversation(...a),
    resumeConversation: (id: string, key: string) => resumeConversation(id, key),
    on: (k: string, fn: (p: any) => void) => {
      ;(handlers[k] ??= []).push(fn)
      return () => {}
    },
  }
})
afterEach(() => cleanup())

const settle = () => act(async () => { await new Promise(r => setTimeout(r, 0)) })
const emit = <K extends keyof EngineEventMap>(k: K, p: EngineEventMap[K]) => act(() => (handlers[k] ?? []).forEach(f => f(p)))

async function renderPanel() {
  const { getStore } = await import('../../src/renderer/state/store')
  const { AgentPanel } = await import('../../src/renderer/panel/AgentPanel')
  await act(async () => { await getStore().init() })
  const r = render(<AgentPanel />)
  await act(async () => { getStore().selectAgent('w') })
  await settle()
  return { ...r, store: getStore() }
}
const pastTab = () => screen.getByRole('tab', { name: /지난 대화/ })
async function openPast() {
  const r = await renderPanel()
  fireEvent.click(pastTab())
  await settle()
  return r
}
const rows = () => within(screen.getByRole('region', { name: '지난 대화' })).getAllByRole('button')
async function read(i: number) {
  fireEvent.click(rows()[i])
  await settle()
}
const bar = () => document.querySelector('.pc-back') as HTMLElement
const resumeBtn = () => screen.getByRole('button', { name: '이 대화로 돌아가기' })
const forkBtn = () => screen.getByRole('button', { name: '새 에이전트로 이어 가기' })

describe('지난 대화 탭', () => {
  it('탭 — 지난 대화가 있을 때만', async () => {
    snapshot.agents[0].pastCount = 0
    const { store } = await renderPanel()
    expect(screen.queryByRole('tab', { name: /지난 대화/ })).toBeNull()

    snapshot.agents[0].pastCount = 2
    await act(async () => { await store.refresh() })
    expect(screen.getAllByRole('tab').map(t => t.textContent)).toEqual(['대화', '지난 대화 2'])
    expect(within(pastTab()).getByText('2')).toHaveClass('ptab-n')

    // 지금 탭이 사라지면 대화 탭으로
    fireEvent.click(pastTab())
    expect(store.getState().panelTab.w).toBe('past')
    snapshot.agents[0].pastCount = 0
    await act(async () => { await store.refresh() })
    expect(screen.queryByRole('tab', { name: /지난 대화/ })).toBeNull()
    expect(store.getState().panelTab.w).toBe('chat')
  })

  it('탭 순서 — [대화 | 서브에이전트 | 메시지 | 지난 대화]', async () => {
    snapshot.messages = [{ id: 'm1', roomId: 'r1', from: 'w2', to: 'w', text: '봐 주세요', createdAt: 1, updatedAt: 2, state: 'delivered' }]
    await renderPanel()
    expect(screen.getAllByRole('tab').map(t => t.textContent)).toEqual(['대화', '메시지 1', '지난 대화 2'])
  })

  it('목록 — 지금 배지·날짜 줄·읽기만', async () => {
    await openPast()
    expect(conversations).toHaveBeenCalledWith('w')
    const [cur, login, main] = rows()
    expect(rows()).toHaveLength(3)

    expect(within(cur).getByText('지금')).toHaveClass('pc-cur')
    expect(cur.querySelector('.pc-t')).toHaveTextContent('히어로 배너 문구를 더 짧게 바꿔 줘')
    expect(cur.querySelector('.pc-m')).toHaveTextContent(`오늘 ${clock(NOW)} · 2차례`)
    expect(cur.querySelector('.pc-s')).toHaveTextContent('2안으로 바꿨어요')

    expect(within(login).queryByText('지금')).toBeNull()
    expect(login.querySelector('.pc-m')!.textContent).toMatch(/ · 23차례$/)
    expect(login.querySelector('.pc-s')).toHaveTextContent("버튼 3곳을 '다시 시도'로 맞췄어요.")

    expect(main.querySelector('.pc-m')!.textContent).toMatch(/ · 41차례 · 읽기만$/)
    expect(main.querySelector('.pc-s')).toHaveTextContent('30일이 지나 이어 갈 수 없어요')
    expect(within(main).queryByText('시안 셋을 올렸어요.')).toBeNull()
    expect(main).toHaveClass('pc-old')
  })

  it('목록 — 예전 대화의 이유 · 빈 제목은 (내용 없음)', async () => {
    conversations.mockResolvedValue([
      { key: 'S3', current: true, title: '지금 하는 일', at: NOW, turns: 1, lastReply: '', resumable: false, why: null },
      { key: 'seg:0', current: false, title: '', at: NOW - DAY, turns: 1, lastReply: '네', resumable: false, why: 'old' },
    ])
    await openPast()
    const [cur, old] = rows()
    expect(cur.querySelector('.pc-s')).toBeNull() // 마지막 답이 없으면 셋째 줄도 없다
    expect(old.querySelector('.pc-t')).toHaveTextContent('(내용 없음)')
    expect(old.querySelector('.pc-s')).toHaveTextContent('예전 대화라 읽기만 돼요')
  })

  it('목록은 탭을 열 때마다 · 지난 대화 수가 바뀔 때 다시 받는다', async () => {
    const { store } = await openPast()
    expect(conversations).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('tab', { name: '대화' }))
    await settle()
    expect(conversations).toHaveBeenCalledTimes(1)
    fireEvent.click(pastTab())
    await settle()
    expect(conversations).toHaveBeenCalledTimes(2)
    snapshot.agents[0].pastCount = 3
    await act(async () => { await store.refresh() })
    await settle()
    expect(conversations).toHaveBeenCalledTimes(3)
    expect(pastTab()).toHaveTextContent('지난 대화 3')
  })

  it('읽기 — 고르면 그 대화, ‹·Esc 로 목록', async () => {
    await openPast()
    await read(1)
    expect(conversation).toHaveBeenCalledWith('w', 'S2')
    const body = screen.getByRole('region', { name: '로그인 화면 오류 메시지를 친절하게 정리해 줘' })
    expect(within(body).getByText('오류 문구 6곳을 바꿨어요.')).toBeInTheDocument()
    expect(body.querySelector('.ci-claude')).not.toBeNull()
    expect(body.querySelector('.me')).toHaveTextContent('로그인 화면 오류 메시지를 친절하게 정리해 줘')
    // 띠 — ‹ · 제목 · 날짜(차례 수 없이)
    const band = document.querySelector('.pc-band') as HTMLElement
    expect(band).toHaveTextContent('로그인 화면 오류 메시지를 친절하게 정리해 줘')
    expect(band).not.toHaveTextContent('23차례')
    const back = screen.getByRole('button', { name: '목록으로' })
    expect(document.activeElement).toBe(back)
    // 읽는 동안 목록은 없다 · 아래 줄 안내
    expect(screen.queryByRole('region', { name: '지난 대화' })).toBeNull()
    expect(bar()).toHaveTextContent('돌아가도 지금 대화는 지난 대화에 남아요.')

    fireEvent.click(back)
    expect(screen.queryByText('오류 문구 6곳을 바꿨어요.')).toBeNull()
    expect(rows()).toHaveLength(3)
    expect(document.activeElement).toBe(rows()[1]) // 연 줄로 초점이 돌아온다

    await read(1)
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    expect(screen.queryByText('오류 문구 6곳을 바꿨어요.')).toBeNull()
    expect(document.activeElement).toBe(rows()[1])
  })

  it('지금 대화를 고르면 대화 탭으로', async () => {
    const { store } = await openPast()
    await read(0)
    expect(store.getState().panelTab.w).toBe('chat')
    expect(conversation).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: '웹 화면에게 보낼 메시지' }))
  })

  it('긴 대화 — 받은 줄이 500 이면 맨 위에 앞 줄 모두 보기', async () => {
    const long: HistoryItem[] = Array.from({ length: 500 }, (_, i) => ({ t: i, kind: 'notice', text: `줄 ${i}` }))
    conversation.mockResolvedValueOnce(long).mockResolvedValueOnce([{ t: -1, kind: 'notice', text: '맨 앞 줄' }, ...long])
    await openPast()
    await read(1)
    const more = screen.getByRole('button', { name: '앞 줄 모두 보기' })
    fireEvent.click(more)
    await settle()
    expect(conversation).toHaveBeenLastCalledWith('w', 'S2', { limit: Infinity })
    expect(screen.getByText('맨 앞 줄')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '앞 줄 모두 보기' })).toBeNull()
  })

  it('돌아가기 → resumeConversation, 대화 탭으로', async () => {
    const { store } = await openPast()
    await read(1)
    expect(resumeBtn()).toBeEnabled()
    fireEvent.click(resumeBtn())
    await settle()
    expect(resumeConversation).toHaveBeenCalledWith('w', 'S2')
    expect(store.getState().panelTab.w).toBe('chat')
    // 숨은 칸의 초점이 몸통으로 떨어지지 않게 — 돌아간 대화에 바로 이어 쓰도록 입력창으로
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: '웹 화면에게 보낼 메시지' }))
    // 다시 열면 목록부터
    fireEvent.click(pastTab())
    await settle()
    expect(rows()).toHaveLength(3)
  })

  it('읽는 중 일하기 시작하면 본문은 그대로, 돌아가기만 막힘 문구로(Review Focus 4)', async () => {
    await openPast()
    await read(1)
    await emit('status', { agentId: 'w', status: 'working', errorText: null })
    expect(screen.getByText('오류 문구 6곳을 바꿨어요.')).toBeInTheDocument()
    expect(resumeBtn()).toBeDisabled()
    expect(bar()).toHaveTextContent('일이 끝나면 돌아갈 수 있어요')
    expect(bar()).not.toHaveTextContent('돌아가도 지금 대화는 지난 대화에 남아요.')
    expect(forkBtn()).toBeEnabled()

    await emit('status', { agentId: 'w', status: 'awaiting', errorText: null })
    expect(bar()).toHaveTextContent('기다리는 카드를 먼저 처리해 주세요')
    await emit('status', { agentId: 'w', status: 'idle', errorText: null })
    expect(resumeBtn()).toBeEnabled()
    expect(bar()).toHaveTextContent('돌아가도 지금 대화는 지난 대화에 남아요.')
  })

  it('붙잡아 둔 입력이 있으면 막힘', async () => {
    snapshot.agents[0].heldInput = 1
    await openPast()
    await read(1)
    expect(resumeBtn()).toBeDisabled()
    expect(bar()).toHaveTextContent('붙잡아 둔 입력을 먼저 처리해 주세요')
  })

  it('읽기만 대화 — 두 단추 모두 꺼짐 + 이유', async () => {
    await openPast()
    await read(2)
    expect(screen.getByText('시안 셋을 올렸어요.')).toBeInTheDocument()
    expect(resumeBtn()).toBeDisabled()
    expect(forkBtn()).toBeDisabled()
    expect(bar()).toHaveTextContent('30일이 지나 이어 갈 수 없어요')
  })

  it('새 에이전트로 이어 가기 → openFork({ name: nextAgentName, role·folder·roomId 원래 것 })', async () => {
    const { store } = await openPast()
    await read(1)
    await emit('status', { agentId: 'w', status: 'working', errorText: null })
    fireEvent.click(forkBtn())
    expect(store.getState().forkDraft).toEqual({ from: 'w', key: 'S2', roomId: 'r1', name: '웹 화면 3', role: '프론트 구현', folder: 'C:\\web' })
  })

  it('돌아가기 실패 글 — 아래 줄에', async () => {
    resumeConversation.mockRejectedValueOnce(new Error('기다리는 카드를 먼저 처리해 주세요'))
    const { store } = await openPast()
    await read(1)
    fireEvent.click(resumeBtn())
    await settle()
    expect(within(bar()).getByRole('alert')).toHaveTextContent('기다리는 카드를 먼저 처리해 주세요')
    expect(bar()).not.toHaveTextContent('돌아가도 지금 대화는 지난 대화에 남아요.')
    expect(store.getState().panelTab.w).toBe('past')
    expect(resumeBtn()).toBeEnabled() // 다시 누를 수 있다
  })
})
