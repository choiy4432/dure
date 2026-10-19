import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act, fireEvent, cleanup } from '@testing-library/react'
import type { Decision, EngineEventMap, PendingRequest, RelayMessage } from '../../src/engine/types'
import type { AgentView, Snapshot } from '../../src/shared/ipcContract'

const agent = (id: string, over: Partial<AgentView> = {}): AgentView => ({
  id, roomId: 'r1', name: id, role: '역할', folder: 'C:\\w', sessionId: 's', started: true, auto: false, model: null,
  alwaysAllow: [], pos: { x: 64, y: 64 }, color: null, status: 'idle', errorText: null, bypass: false, heldInput: 0, ...over,
})
const request = (over: Partial<PendingRequest> = {}): PendingRequest => ({
  id: 'q1', agentId: 'd', toolName: 'Write', input: { file_path: 'C:\\w\\src\\styles\\tokens.css' }, kind: 'permission',
  createdAt: Date.now(), ...over,
})
let n = 0
const msg = (from: string, to: string, state: RelayMessage['state']): RelayMessage => ({
  id: `m${n++}`, roomId: 'r1', from, to, text: '배너 문구', createdAt: 1, state, updatedAt: 1,
})

let snapshot: Snapshot
let api: { answerRequest: ReturnType<typeof vi.fn> }
let handlers: Record<string, ((p: any) => void)[]>
const emit = <K extends keyof EngineEventMap>(k: K, p: EngineEventMap[K]) => act(() => (handlers[k] ?? []).forEach(f => f(p)))

beforeEach(() => {
  vi.resetModules()
  handlers = {}
  snapshot = {
    claudeMissing: false, rooms: [{ id: 'r1', name: '여름 캠페인', createdAt: 1 }],
    agents: [agent('d', { name: '디자인' })], messages: [], requests: [], autoChainLimit: 3,
  }
  api = { answerRequest: vi.fn(async (_id: string, _d: Decision) => {}) }
  ;(window as any).dure = {
    ...api,
    snapshot: async () => snapshot,
    history: async () => [],
    on: (k: string, fn: (p: any) => void) => {
      ;(handlers[k] ??= []).push(fn)
      return () => {}
    },
  }
})
afterEach(() => cleanup())

async function renderCard(id = 'd') {
  const { getStore } = await import('../../src/renderer/state/store')
  const { AgentCard } = await import('../../src/renderer/map/AgentNode')
  await act(async () => { await getStore().init() })
  const r = render(<AgentCard agentId={id} />)
  return { ...r, store: getStore(), card: r.container.querySelector<HTMLElement>('.nd')! }
}

describe('AgentNode — 승인 기다림', () => {
  it.each([
    ['허용', { type: 'allow' }],
    ['거절', { type: 'deny' }],
    ['이 에이전트에선 항상 허용', { type: 'allow-always' }],
  ] as const)('앰버 칸의 [%s] 은 answerRequest 를 맞는 Decision 으로 부른다', async (name, decision) => {
    snapshot.agents = [agent('d', { name: '디자인', status: 'awaiting' })]
    snapshot.requests = [request()]
    const { card, store } = await renderCard()
    expect(card.classList.contains('pend')).toBe(true)
    expect(card.classList.contains('wide')).toBe(true)
    expect(screen.getByText('디자인이 파일을 만들려 해요')).toBeTruthy()
    const target = screen.getByText('src/styles/tokens.css')
    expect(target.tagName).toBe('CODE')
    expect(screen.getByText('승인 기다림')).toBeTruthy()

    await act(async () => { fireEvent.click(screen.getByRole('button', { name })) })
    expect(api.answerRequest).toHaveBeenCalledTimes(1)
    expect(api.answerRequest).toHaveBeenCalledWith('q1', decision)
    // 누르는 동안 다시 누를 수 없다 · 승인하려고 누른 것이 에이전트를 고르지는 않는다
    expect((screen.getByRole('button', { name: '허용' }) as HTMLButtonElement).disabled).toBe(true)
    expect(store.getState().selectedAgentId).toBeNull()
  })

  it('실패하면 버튼이 다시 살아난다', async () => {
    snapshot.requests = [request()]
    api.answerRequest.mockRejectedValueOnce(new Error('없는 요청'))
    await renderCard()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '허용' })) })
    expect((screen.getByRole('button', { name: '허용' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('질문이면 "질문이 있어요 · 패널에서 답하기" 링크만 — 누르면 그 에이전트를 고른다', async () => {
    snapshot.requests = [request({ toolName: 'AskUserQuestion', input: { questions: [] }, kind: 'question' })]
    const { store, card } = await renderCard()
    expect(card.classList.contains('pend')).toBe(true)
    expect(card.classList.contains('wide')).toBe(false)
    expect(screen.queryByRole('button', { name: '허용' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '질문이 있어요 · 패널에서 답하기' }))
    expect(store.getState().selectedAgentId).toBe('d')
    expect(api.answerRequest).not.toHaveBeenCalled()
  })
})

describe('AgentNode — 카드 내용', () => {
  it('머리: 이니셜 · 이름 · 역할 · 자동 켬/끔', async () => {
    snapshot.agents = [agent('d', { name: '디자인', role: '시안 · 스타일', auto: true })]
    const { card } = await renderCard()
    expect(card.querySelector('.av')!.textContent).toBe('디')
    expect(screen.getByText('시안 · 스타일')).toBeTruthy()
    const au = screen.getByText('자동 켬')
    expect(au.classList.contains('on')).toBe(true)
  })

  it('긴 이름·역할은 말줄임 클래스(카드 크기 유지), 전체는 title 로', async () => {
    const name = '아주 긴 이름을 가진 마케팅 문구 담당 에이전트'
    const role = '보도자료·뉴스레터·소셜 문구·광고 카피·고객 안내문 작성'
    snapshot.agents = [agent('d', { name, role })]
    await renderCard()
    const nameEl = screen.getByText(name)
    const roleEl = screen.getByText(role)
    expect(nameEl.classList.contains('trunc')).toBe(true)
    expect(roleEl.classList.contains('trunc')).toBe(true)
    expect(nameEl.getAttribute('title')).toBe(name)
    expect(roleEl.getAttribute('title')).toBe(role)
  })

  it('받은 메시지 배지 = 확인 대기·상한 대기 수, 한 줄 요약은 누가 보냈는지', async () => {
    snapshot.agents = [agent('s', { name: '서버' }), agent('w', { name: '웹 화면' })]
    snapshot.messages = [msg('w', 's', 'pending'), msg('w', 's', 'held'), msg('w', 's', 'queued'), msg('w', 's', 'delivered'), msg('s', 'w', 'pending')]
    const { card } = await renderCard('s')
    const badge = card.querySelector('.um')!
    expect(badge.textContent).toBe('받은 메시지2')
    expect(badge.querySelector('b')!.textContent).toBe('2')
    expect(screen.getByText('웹 화면이 보낸 메시지 확인 전')).toBeTruthy()
    expect(screen.getByText('대기')).toBeTruthy()
  })

  it('받은 메시지가 없으면 배지 대신 시각', async () => {
    snapshot.agents = [agent('d', { name: '디자인' })]
    const { card } = await renderCard()
    expect(card.querySelector('.um')).toBeNull()
  })

  it('bypass 면 이름 옆에 "묻지 않고 실행해요" 경고', async () => {
    snapshot.agents = [agent('d', { name: '디자인', bypass: true })]
    await renderCard()
    expect(screen.getByRole('img', { name: '묻지 않고 실행해요' })).toBeTruthy()
  })

  it('오류면 바닥에 빨간 "멈춤" + errorText 앞 30자', async () => {
    const errorText = '가'.repeat(30) + '나'.repeat(10)
    snapshot.agents = [agent('d', { name: '디자인', status: 'error', errorText })]
    const { card } = await renderCard()
    expect(card.querySelector('.st.e')!.textContent).toContain('멈춤')
    const err = card.querySelector('.nf-err')!
    expect(err.textContent).toBe('가'.repeat(30) + '…')
    expect(err.getAttribute('title')).toBe(errorText)
  })

  it('작업 중이면 흐르는 글 앞 40자(말줄임), 선택되면 파란 테두리', async () => {
    snapshot.agents = [agent('d', { name: '디자인', status: 'working' })]
    const { card, store } = await renderCard()
    expect(screen.getByText('작업 중')).toBeTruthy()
    emit('agent-event', { agentId: 'd', event: { kind: 'text-delta', text: '메인 배너 문구를 바꾸는 중이에요. ' + '아'.repeat(40) } })
    const line = card.querySelector('.na')!
    expect(line.textContent).toBe(('메인 배너 문구를 바꾸는 중이에요. ' + '아'.repeat(40)).slice(0, 40) + '…')
    expect(line.classList.contains('trunc')).toBe(true)
    expect(card.classList.contains('sel')).toBe(false)
    act(() => store.selectAgent('d'))
    expect(card.classList.contains('sel')).toBe(true)
  })

  it('끝난 답이 있으면 그 글 앞부분, 없으면 상태 문장', async () => {
    const { card } = await renderCard()
    expect(card.querySelector('.na')!.textContent).toBe('기다리는 중')
    emit('history', { agentId: 'd', item: { t: Date.now(), kind: 'assistant', blocks: [{ type: 'text', text: '배너 문구를 **웹 화면**에 넘겼어요' }] } })
    expect(card.querySelector('.na')!.textContent).toBe('배너 문구를 웹 화면에 넘겼어요')
  })
})
