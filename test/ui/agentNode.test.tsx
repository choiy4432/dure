import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act, fireEvent, cleanup } from '@testing-library/react'
import type { Decision, EngineEventMap, PendingRequest, RelayMessage } from '../../src/engine/types'
import type { AgentView, Snapshot } from '../../src/shared/ipcContract'
import { allowMotion } from './motion'

const agent = (id: string, over: Partial<AgentView> = {}): AgentView => ({
  id, roomId: 'r1', name: id, role: '역할', folder: 'C:\\w', sessionId: 's', started: true, auto: false, model: null,
  alwaysAllow: [], pos: { x: 64, y: 64 }, color: null, effort: null, lastContext: null, bypassOn: false, effortNow: null, modelNow: null, status: 'idle', errorText: null, bypass: false, bypassBySettings: false, bypassPending: false, heldInput: 0, subagentsRunning: [], ...over,
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
    agents: [agent('d', { name: '디자인' })], messages: [], requests: [], autoChainLimit: 3, allowBypass: false, notify: { asks: true, finished: false }, usage: null,
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
  ] as const)('앰버 칸의 [%s] 은 answerRequest 를 맞는 Decision 으로 부른다', async (name, decision) => {
    snapshot.agents = [agent('d', { name: '디자인', status: 'awaiting' })]
    snapshot.requests = [request()]
    const { card, store } = await renderCard()
    expect(card.classList.contains('pend')).toBe(true)
    expect(screen.getByText('디자인이 파일을 만들려 해요')).toBeTruthy()
    const target = screen.getByText('src/styles/tokens.css')
    expect(target.tagName).toBe('CODE')
    expect(screen.getByText('내 승인 필요')).toBeTruthy()

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

  it('서브에이전트가 물은 것이면 제목이 "디자인의 서브에이전트가 파일을 고치려 해요"', async () => {
    snapshot.agents = [agent('d', { name: '디자인', status: 'awaiting' })]
    snapshot.requests = [request({ toolName: 'Edit', input: { file_path: 'C:\\w\\src\\a.css', old_string: 'a', new_string: 'b' }, fromSubagent: true })]
    const { card } = await renderCard()
    expect(card.querySelector('.ap-t')!.textContent).toBe('디자인의 서브에이전트가 파일을 고치려 해요')
    expect(screen.getByText('src/a.css').tagName).toBe('CODE') // 대상은 지금 그대로
  })

  it('질문이면 "내 답 필요 · 패널에서 답하기" 링크만 — 누르면 그 에이전트를 고른다', async () => {
    snapshot.requests = [request({ toolName: 'AskUserQuestion', input: { questions: [] }, kind: 'question' })]
    const { store, card } = await renderCard()
    expect(card.classList.contains('pend')).toBe(true)
    expect(screen.queryByRole('button', { name: '허용' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '내 답 필요 · 패널에서 답하기' }))
    expect(store.getState().selectedAgentId).toBe('d')
    expect(api.answerRequest).not.toHaveBeenCalled()
  })
})

describe('AgentNode — 새 에이전트 만들기 승인', () => {
  const make = () =>
    request({
      agentId: 'p', toolName: 'mcp__dure__create_agent', kind: 'create-agent',
      input: { name: '테스트', role: '시험 담당', folder: 'C:\\w\\t', task: '첫 할 일' },
    })

  it('앰버 칸은 제목 "기획이 새 에이전트를 만들려 해요" · 새 이름 · 역할 · "패널에서 확인하기" 링크 — 여기선 [만들기]·[거절]이 없다(폴더·첫 할 일을 못 본 채 승인하지 않게)', async () => {
    snapshot.agents = [agent('p', { name: '기획', status: 'awaiting' })]
    snapshot.requests = [make()]
    const { card } = await renderCard('p')
    expect(card.classList.contains('pend')).toBe(true)
    expect(card.querySelector('.ap-t')!.textContent).toBe('기획이 새 에이전트를 만들려 해요')
    const who = card.querySelector<HTMLElement>('.ap-who')!
    expect(who.textContent).toBe('테스트 · 시험 담당')
    expect(who.title).toBe('테스트 · 시험 담당')
    expect(who.querySelector('b')!.textContent).toBe('테스트')
    expect(Array.from(card.querySelectorAll('.ap button')).map(b => b.textContent)).toEqual(['패널에서 확인하기'])
    expect(screen.queryByRole('button', { name: '만들기' })).toBeNull()
    expect(screen.queryByRole('button', { name: '거절' })).toBeNull()
    expect(card.textContent).not.toContain('항상 허용')
  })

  it('"패널에서 확인하기"는 만든 에이전트를 고른다 — 답하지 않고, 누름이 칸 밖(관계도)으로 번지지 않는다', async () => {
    snapshot.agents = [agent('p', { name: '기획', status: 'awaiting' })]
    snapshot.requests = [make()]
    const { store } = await renderCard('p')
    const outside = vi.fn()
    document.addEventListener('click', outside)
    try {
      fireEvent.click(screen.getByRole('button', { name: '패널에서 확인하기' }))
    } finally {
      document.removeEventListener('click', outside)
    }
    expect(store.getState().selectedAgentId).toBe('p')
    expect(api.answerRequest).not.toHaveBeenCalled()
    expect(outside).not.toHaveBeenCalled()
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

  it('묻지 않음이면 구석 글씨도 "묻지 않음"(테두리와 같은 주황) — 자동 켬/끔 대신', async () => {
    snapshot.agents = [agent('d', { name: '디자인', auto: true, bypass: true })]
    await renderCard()
    expect(screen.queryByText('자동 켬')).toBeNull()
    const au = screen.getByText('묻지 않음')
    expect(au.classList.contains('au')).toBe(true)
    expect(au.classList.contains('byp')).toBe(true)
    expect(au.classList.contains('on')).toBe(false)
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
    expect(roleEl.closest('.nr')!.getAttribute('title')).toBe(role)
  })

  it("역할 옆에 모델 · effort — '기획서 · 문구 · Opus 5.5 · high', 역할만 말줄임", async () => {
    snapshot.agents = [agent('d', { role: '기획서 · 문구', model: 'opus', modelNow: 'claude-opus-5-5', effort: 'high', effortNow: 'high' })]
    const { card } = await renderCard()
    const line = card.querySelector('.nr') as HTMLElement
    expect(line.textContent).toBe('기획서 · 문구 · Opus 5.5 · high')
    expect(line.getAttribute('title')).toBe('기획서 · 문구 · Opus 5.5 · high')
    expect(screen.getByText('기획서 · 문구').classList.contains('trunc')).toBe(true)
    expect(line.querySelector('.nr-meta')!.classList.contains('keep')).toBe(true)
    // 줄이 나뉘어도 둘째 줄이 "·" 로 시작하지 않는다 — 구분 점은 역할 묶음 쪽에
    expect(line.querySelector('.nr-meta')!.textContent).toBe('Opus 5.5 · high')
    expect(line.querySelector('.nr-meta')!.textContent!.startsWith('·')).toBe(false)
    expect(line.querySelector('.nr-role')!.textContent).toBe('기획서 · 문구 · ')
  })

  it('effort 를 모르면 그 부분(과 구분 점)이 없다 · 정한 값만 있으면 그 값', async () => {
    snapshot.agents = [agent('d', { role: '기획서', model: 'opus' })]
    const { card } = await renderCard()
    expect(card.querySelector('.nr')!.textContent).toBe('기획서 · Opus')
    cleanup()
    snapshot.agents = [agent('d', { role: '기획서', model: 'opus', effort: 'low' })]
    const again = await renderCard()
    expect(again.card.querySelector('.nr')!.textContent).toBe('기획서 · Opus · low')
  })

  it('긴 역할만 최소 폭(6em) 규칙을 받고, 그 규칙은 CSS 에 있다', async () => {
    snapshot.agents = [agent('d', { role: '기획서 · 문구 · 행사 페이지 카피 전부', model: 'opus', modelNow: 'claude-opus-5[1m]', effort: 'xhigh', effortNow: 'xhigh' })]
    const { card } = await renderCard()
    expect(card.querySelector('.nr-role')!.classList.contains('floor')).toBe(true)
    expect(card.querySelector('.nr')!.textContent).toBe('기획서 · 문구 · 행사 페이지 카피 전부 · Opus 5 (긴 대화) · xhigh')
    cleanup()
    snapshot.agents = [agent('d', { role: '기획서' })]
    const short = await renderCard()
    expect(short.card.querySelector('.nr-role')!.classList.contains('floor')).toBe(false)
    const fsName: string = 'node:fs'
    const css: string = (await import(/* @vite-ignore */ fsName)).readFileSync('src/renderer/styles/base.css', 'utf8')
    // 최소 폭은 바탕 크기(6em) + 줄 나눔(wrap)이 지킨다 — 글보다 넓어지지 않는다(모델·effort 가 역할 바로 뒤에, 실제 배치는 e2e 2단계)
    expect(css).toMatch(/\.nr-role\.floor\s*\{[^}]*flex:\s*1 1 6em/)
    expect(css).toMatch(/\.nr-role\.floor\s*\{[^}]*max-width:\s*max-content/)
    expect(css).not.toMatch(/\.nr-role\.floor\s*\{[^}]*min-width/)
    expect(css).toMatch(/\.nr\s*\{[^}]*flex-wrap:\s*wrap/)
  })

  it('역할이 비면 앞 구분 점 없이 모델 · effort 만', async () => {
    snapshot.agents = [agent('d', { role: '', model: 'opus', modelNow: 'claude-opus-5-5', effort: 'max', effortNow: 'max' })]
    const { card } = await renderCard()
    expect(card.querySelector('.nr')!.textContent).toBe('Opus 5.5 · max')
  })

  it('받은 메시지 배지 = 확인 필요·자동 멈춤 수, 한 줄 요약은 누가 보냈는지', async () => {
    snapshot.agents = [agent('s', { name: '서버' }), agent('w', { name: '웹 화면' })]
    snapshot.messages = [msg('w', 's', 'pending'), msg('w', 's', 'held'), msg('w', 's', 'queued'), msg('w', 's', 'delivered'), msg('s', 'w', 'pending')]
    const { card } = await renderCard('s')
    const badge = card.querySelector('.um')!
    expect(badge.textContent).toBe('받은 메시지2')
    expect(badge.querySelector('b')!.textContent).toBe('2')
    expect(screen.getByText('웹 화면이 보낸 메시지 확인 전')).toBeTruthy()
    expect(screen.getByText('쉬는 중')).toBeTruthy()
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

  it('묻지 않음이면 카드에 byp — 테두리·고른 고리가 주황, 아니면 없다', async () => {
    snapshot.agents = [agent('d', { name: '디자인', bypass: true }), agent('w', { name: '웹' })]
    const on = await renderCard('d')
    expect(on.card.classList.contains('byp')).toBe(true)
    const off = await renderCard('w')
    expect(off.card.classList.contains('byp')).toBe(false)
  })

  it('경고를 닫은 에이전트는 이름 옆 경고가 없다 — 주황 테두리(byp)는 남는다', async () => {
    snapshot.agents = [agent('d', { name: '디자인', bypass: true, bypassNoticeClosed: true })]
    const { card } = await renderCard()
    expect(screen.queryByRole('img', { name: '묻지 않고 실행해요' })).toBeNull()
    expect(card.classList.contains('byp')).toBe(true)
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

  it('흐르는 글이 없고 서브에이전트가 돌면 한 줄 "서브에이전트 2개가 일하는 중" — 수가 바뀌면 따라, 흐르는 글이 오면 그 글', async () => {
    snapshot.agents = [agent('d', { name: '디자인', status: 'working', subagentsRunning: ['A', 'B'] })]
    const { card } = await renderCard()
    const line = () => card.querySelector('.na')!.textContent
    expect(line()).toBe('서브에이전트 2개가 일하는 중')
    emit('subagents', { agentId: 'd', running: ['B'] })
    expect(line()).toBe('서브에이전트 1개가 일하는 중')
    emit('agent-event', { agentId: 'd', event: { kind: 'text-delta', text: '결과를 모아 정리하는 중이에요' } })
    expect(line()).toBe('결과를 모아 정리하는 중이에요')
  })

  it('흐르는 글이 없고 Claude 가 생각하는 중이면 한 줄 "생각하는 중…" — 글이 오면 그 글, 생각이 끝나면 "일하는 중…"', async () => {
    snapshot.agents = [agent('d', { name: '디자인', status: 'working' })]
    const { card } = await renderCard()
    const line = () => card.querySelector('.na')!.textContent
    expect(line()).toBe('작업 중…')
    emit('agent-event', { agentId: 'd', event: { kind: 'thinking', active: true, tokens: null } })
    expect(line()).toBe('생각하는 중…')
    emit('agent-event', { agentId: 'd', event: { kind: 'thinking', active: true, tokens: 278 } })
    expect(line()).toBe('생각하는 중…') // 카드엔 토큰 수를 쓰지 않는다
    emit('agent-event', { agentId: 'd', event: { kind: 'thinking', active: false, tokens: null } })
    expect(line()).toBe('작업 중…')
    emit('agent-event', { agentId: 'd', event: { kind: 'thinking', active: true, tokens: null } })
    emit('agent-event', { agentId: 'd', event: { kind: 'text-delta', text: '배너 문구를 고르는 중이에요' } })
    expect(line()).toBe('배너 문구를 고르는 중이에요')
  })

  it('차례: 흐르는 글 → 생각하는 중 → 서브에이전트 → 일하는 중 — 생각이 끝나면 서브에이전트 문구', async () => {
    snapshot.agents = [agent('d', { name: '디자인', status: 'working', subagentsRunning: ['A', 'B'] })]
    const { card } = await renderCard()
    const line = () => card.querySelector('.na')!.textContent
    expect(line()).toBe('서브에이전트 2개가 일하는 중')
    emit('agent-event', { agentId: 'd', event: { kind: 'thinking', active: true, tokens: null } })
    emit('agent-event', { agentId: 'd', event: { kind: 'thinking', active: true, tokens: 50 } })
    expect(line()).toBe('생각하는 중…')
    emit('agent-event', { agentId: 'd', event: { kind: 'thinking', active: false, tokens: null } })
    expect(line()).toBe('서브에이전트 2개가 일하는 중')
  })

  it('단계: 보내면 "준비하는 중…" → 요청이 나가면 "Claude 답 받는 중…" → 요약 중이면 "대화를 정리하는 중…" — 서브에이전트 문구보다 먼저', async () => {
    snapshot.agents = [agent('d', { name: '디자인', status: 'working', subagentsRunning: ['A'] })]
    const { card } = await renderCard()
    const line = () => card.querySelector('.na')!.textContent
    expect(line()).toBe('서브에이전트 1개가 일하는 중')
    emit('history', { agentId: 'd', item: { t: 5, kind: 'user', source: 'human', parts: [{ type: 'text', text: '해 줘' }] } })
    expect(line()).toBe('준비하는 중…')
    emit('agent-event', { agentId: 'd', event: { kind: 'api-status', status: 'requesting' } })
    expect(line()).toBe('Claude 답 받는 중…')
    emit('agent-event', { agentId: 'd', event: { kind: 'api-status', status: 'compacting' } })
    expect(line()).toBe('대화를 정리하는 중…')
    emit('agent-event', { agentId: 'd', event: { kind: 'api-status', status: 'requesting' } })
    emit('agent-event', { agentId: 'd', event: { kind: 'thinking', active: true, tokens: null } })
    expect(line()).toBe('생각하는 중…')
    emit('agent-event', { agentId: 'd', event: { kind: 'thinking', active: false, tokens: null } })
    expect(line()).toBe('서브에이전트 1개가 일하는 중')
  })

  it('생각이 끝난 뒤 늦게 온 토큰 수는 "생각하는 중…"을 다시 띄우지 않는다 — 생각 블록 시작만 띄운다', async () => {
    snapshot.agents = [agent('d', { name: '디자인', status: 'working' })]
    const { card } = await renderCard()
    const line = () => card.querySelector('.na')!.textContent
    emit('agent-event', { agentId: 'd', event: { kind: 'thinking', active: true, tokens: 278 } })
    expect(line()).toBe('작업 중…') // 블록 시작 없이 온 수
    emit('agent-event', { agentId: 'd', event: { kind: 'thinking', active: true, tokens: null } })
    expect(line()).toBe('생각하는 중…')
    emit('agent-event', { agentId: 'd', event: { kind: 'thinking', active: false, tokens: null } })
    emit('agent-event', { agentId: 'd', event: { kind: 'thinking', active: true, tokens: 452 } })
    expect(line()).toBe('작업 중…')
  })

  it('생각하는 중에 멈추면 "생각하는 중…"이 남지 않는다', async () => {
    snapshot.agents = [agent('d', { name: '디자인', status: 'working' })]
    const { card } = await renderCard()
    emit('agent-event', { agentId: 'd', event: { kind: 'thinking', active: true, tokens: null } })
    emit('agent-event', { agentId: 'd', event: { kind: 'thinking', active: true, tokens: 278 } })
    expect(card.querySelector('.na')!.textContent).toBe('생각하는 중…')
    emit('status', { agentId: 'd', status: 'idle', errorText: null })
    expect(card.querySelector('.na')!.textContent).toBe('쉬는 중')
    emit('status', { agentId: 'd', status: 'working', errorText: null })
    expect(card.querySelector('.na')!.textContent).toBe('작업 중…')
  })

  it('서브에이전트가 다 끝나면 지금처럼 — 작업 중이면 "일하는 중…"', async () => {
    snapshot.agents = [agent('d', { name: '디자인', status: 'working', subagentsRunning: ['A'] })]
    const { card } = await renderCard()
    emit('subagents', { agentId: 'd', running: [] })
    expect(card.querySelector('.na')!.textContent).toBe('작업 중…')
  })

  it('작업 중인데 언제부터인지 모르면(켤 때 이미 작업 중) 시각을 쓰지 않는다', async () => {
    snapshot.agents = [agent('d', { name: '디자인', status: 'working' })]
    const { card } = await renderCard()
    expect(card.querySelector('.nf-t')).toBeNull()
    expect(card.textContent).not.toContain('방금 시작')
  })

  it('작업 시작 시각은 스토어에 — 카드를 다시 그려도(방을 오가도) 그대로 N분째', async () => {
    const t0 = Date.now()
    const now = vi.spyOn(Date, 'now').mockReturnValue(t0)
    try {
      const { card, unmount } = await renderCard()
      emit('status', { agentId: 'd', status: 'working', errorText: null })
      expect(card.querySelector('.nf-t')!.textContent).toBe('방금 시작')
      unmount()
      now.mockReturnValue(t0 + 3 * 60_000 + 5_000)
      const { AgentCard } = await import('../../src/renderer/map/AgentNode')
      const again = render(<AgentCard agentId="d" />)
      expect(again.container.querySelector('.nf-t')!.textContent).toBe('3분째')
    } finally {
      now.mockRestore()
    }
  })

  it('끝난 답이 있으면 그 글 앞부분, 없으면 상태 문장', async () => {
    const { card } = await renderCard()
    expect(card.querySelector('.na')!.textContent).toBe('쉬는 중')
    emit('history', { agentId: 'd', item: { t: Date.now(), kind: 'assistant', blocks: [{ type: 'text', text: '배너 문구를 **웹 화면**에 넘겼어요' }] } })
    expect(card.querySelector('.na')!.textContent).toBe('배너 문구를 웹 화면에 넘겼어요')
  })
})

describe('AgentNode — 넘김 서명: 메시지가 도착하면 받는 노드 배지가 한 번 튄다', () => {
  // jsdom 엔 Web Animations 가 없다 — 부른 것만 센다
  let animate: ReturnType<typeof vi.fn>
  beforeEach(() => {
    allowMotion() // 움직임 경로 시험 — setup.ts 기본값(움직임 줄이기)을 이 묶음에서만 끈다
    animate = vi.fn(() => ({ cancel: vi.fn() }))
    ;(HTMLElement.prototype as any).animate = animate
  })
  afterEach(() => {
    delete (HTMLElement.prototype as any).animate
    delete (window as any).matchMedia
  })
  const at = (m: RelayMessage, state: RelayMessage['state'], t: number): RelayMessage => ({ ...m, state, updatedAt: t })
  const setup = () => {
    snapshot.agents = [agent('s', { name: '서버' }), agent('w', { name: '웹 화면' })]
  }

  it('받은 메시지가 0→1 로 생기면 배지가 바로 한 번 튄다(300ms 안, 기다림 없이)', async () => {
    setup()
    snapshot.messages = []
    const { card } = await renderCard('s')
    expect(card.querySelector('.um')).toBeNull()
    emit('message', msg('w', 's', 'pending'))
    const badge = card.querySelector('.um b')!
    expect(badge.textContent).toBe('1')
    expect(animate).toHaveBeenCalledTimes(1)
    expect(animate.mock.contexts[0]).toBe(badge)
    const [frames, opts] = animate.mock.calls[0] as unknown as [Keyframe[], KeyframeAnimationOptions]
    expect(frames[0].transform).toBe('scale(1)')
    expect(frames.at(-1)!.transform).toBe('scale(1)')
    expect(frames.some(f => f.transform !== 'scale(1)')).toBe(true)
    expect(opts.delay ?? 0).toBe(0)
    expect(opts.duration).toBeLessThanOrEqual(300)
    expect(opts.iterations ?? 1).toBe(1)
  })

  it('n→n+1 로 늘 때도 튄다', async () => {
    setup()
    snapshot.messages = [msg('w', 's', 'pending')]
    const { card } = await renderCard('s')
    emit('message', msg('w', 's', 'pending'))
    expect(card.querySelector('.um b')!.textContent).toBe('2')
    expect(animate).toHaveBeenCalledTimes(1)
    expect(animate.mock.contexts[0]).toBe(card.querySelector('.um b'))
  })

  it('처음 그릴 때 이미 개수가 있으면(다시 켬·방 바꿈) 튀지 않는다', async () => {
    setup()
    snapshot.messages = [msg('w', 's', 'pending'), msg('w', 's', 'pending')]
    const { card } = await renderCard('s')
    expect(card.querySelector('.um b')!.textContent).toBe('2')
    expect(animate).not.toHaveBeenCalled()
  })

  it("개수가 줄 때(전달됨)는 튀지 않고 '방금' 시각도 튀지 않는다", async () => {
    setup()
    const a = msg('w', 's', 'pending')
    const b = msg('w', 's', 'pending')
    snapshot.messages = [a, b]
    const { card } = await renderCard('s')
    emit('message', at(a, 'delivered', Date.now()))
    expect(card.querySelector('.um b')!.textContent).toBe('1')
    emit('message', at(b, 'delivered', Date.now()))
    expect(card.querySelector('.um')).toBeNull()
    expect(card.querySelector('.nf-t')!.textContent).toBe('방금')
    expect(animate).not.toHaveBeenCalled()
  })

  it('움직임 줄이기 설정이면 튀지 않는다(배지는 바로 보인다)', async () => {
    ;(window as any).matchMedia = (q: string) => ({ matches: q.includes('reduce'), media: q })
    setup()
    snapshot.messages = []
    const { card } = await renderCard('s')
    emit('message', msg('w', 's', 'pending'))
    expect(card.querySelector('.um b')!.textContent).toBe('1')
    expect(animate).not.toHaveBeenCalled()
  })
})

describe('AgentNode — 에이전트가 만든 새 에이전트의 카드도 나타난다', () => {
  async function renderBoth() {
    snapshot.agents = [agent('d', { name: '디자인' }), agent('n', { name: '새 에이전트' })]
    const { getStore } = await import('../../src/renderer/state/store')
    const { AgentCard } = await import('../../src/renderer/map/AgentNode')
    await act(async () => { await getStore().init() })
    // 엔진이 create_agent 로 만들었다 — 새 에이전트는 이미 받은 스냅샷에 있다
    emit('agent-added', { agent: snapshot.agents[1] as unknown as EngineEventMap['agent-added']['agent'], by: 'd' })
    const r = render(
      <>
        <AgentCard agentId="d" />
        <AgentCard agentId="n" />
      </>,
    )
    const [d, n] = r.container.querySelectorAll<HTMLElement>('.nd')
    return { d, n }
  }

  it('agent-added 로 온 카드는 사람이 더한 카드처럼 들어온다 — 원래 있던 카드는 그대로', async () => {
    allowMotion()
    const { d, n } = await renderBoth()
    expect(n.style.opacity).toBe('0') // 들어오기 시작(MOTION.node enter)
    expect(d.style.opacity).toBe('')
  })

  it('움직임 줄이기면 들어오지 않는다(지금처럼)', async () => {
    const { n } = await renderBoth()
    expect(n.style.opacity).toBe('')
  })
})

describe('AgentNode — 흘끗 보기 카드', () => {
  it('승인 칸 링크는 패널에서 자세히 — 누르면 그 에이전트를 고르고 answerRequest 는 부르지 않는다', async () => {
    snapshot.agents = [agent('d', { name: '디자인', status: 'awaiting' })]
    snapshot.requests = [request()]
    const { store, card } = await renderCard()
    expect(screen.queryByRole('button', { name: '이 에이전트에선 항상 허용' })).toBeNull()
    const outside = vi.fn()
    document.addEventListener('click', outside)
    try {
      fireEvent.click(screen.getByRole('button', { name: '패널에서 자세히' }))
    } finally {
      document.removeEventListener('click', outside)
    }
    expect(store.getState().selectedAgentId).toBe('d')
    expect(api.answerRequest).not.toHaveBeenCalled()
    expect(outside).not.toHaveBeenCalled()
    expect(card.classList.contains('pend')).toBe(true)
  })

  it('넓은 카드 클래스(wide)가 없다', async () => {
    snapshot.agents = [agent('d', { name: '디자인', status: 'awaiting' })]
    snapshot.requests = [request()]
    const { card } = await renderCard()
    expect(card.classList.contains('wide')).toBe(false)
    const fsName: string = 'node:fs'
    const css: string = (await import(/* @vite-ignore */ fsName)).readFileSync('src/renderer/styles/base.css', 'utf8')
    expect(css).not.toMatch(/\.nd\.wide/)
  })

  it('모델·effort 는 고른 값만 — 기본이면 역할만', async () => {
    snapshot.agents = [agent('d', { role: '기획서' })]
    const { card } = await renderCard()
    expect(card.querySelector('.nr')!.textContent).toBe('기획서')
    expect(card.querySelector('.nr-sep')).toBeNull()
    cleanup()
    snapshot.agents = [agent('d', { role: '기획서', effort: 'high' })]
    const eff = await renderCard()
    expect(eff.card.querySelector('.nr')!.textContent).toBe('기획서 · high')
  })

  it('자동 끔은 쓰지 않는다 — 자동 켬·묻지 않음만', async () => {
    snapshot.agents = [agent('d', { auto: false })]
    const { card } = await renderCard()
    expect(card.querySelector('.au')).toBeNull()
    expect(card.textContent).not.toContain('자동 끔')
    cleanup()
    snapshot.agents = [agent('d', { auto: true })]
    const on = await renderCard()
    expect(on.card.querySelector('.au')!.textContent).toBe('자동 켬')
  })

  it('묻지 않음 예약(bypassPending)도 묻지 않음·byp', async () => {
    snapshot.agents = [agent('d', { auto: true, bypassPending: true })]
    const { card } = await renderCard()
    const au = card.querySelector('.au')!
    expect(au.textContent).toBe('묻지 않음')
    expect(au.classList.contains('byp')).toBe(true)
    expect(card.classList.contains('byp')).toBe(true)
  })

  it('쉬는 에이전트에 fresh 가 있으면 바닥이 끝남 · 새 결과(.dot.n)', async () => {
    snapshot.agents = [agent('d', { status: 'idle' })]
    const { card, store } = await renderCard()
    expect(card.querySelector('.dot.n')).toBeNull()
    emit('history', { agentId: 'd', item: { kind: 'result', t: 5 } } as any)
    expect(store.getState().fresh.d).toBe(5)
    expect(card.querySelector('.dot.n')).toBeTruthy()
    expect(card.querySelector('.st.n')!.textContent).toContain('끝남 · 새 결과')
  })

  it('작업 중이면 fresh 가 있어도 작업 중', async () => {
    snapshot.agents = [agent('d', { status: 'working' })]
    const { card, store } = await renderCard()
    emit('history', { agentId: 'd', item: { kind: 'result', t: 5 } } as any)
    expect(store.getState().fresh.d).toBe(5)
    expect(card.querySelector('.dot.n')).toBeNull()
    expect(card.querySelector('.st-l')!.textContent).toBe('작업 중')
  })
})
