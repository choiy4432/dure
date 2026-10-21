import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { render, screen, act, fireEvent, cleanup, within } from '@testing-library/react'
import { animate } from 'animejs'
import type { EngineEventMap, HistoryItem } from '../../src/engine/types'
import type { AgentView, Snapshot } from '../../src/shared/ipcContract'
import { allowMotion } from './motion'

vi.mock('animejs', async orig => {
  const m = await orig<typeof import('animejs')>()
  return { ...m, animate: vi.fn(m.animate) }
})

// 패널의 [대화 | 서브에이전트 N] 탭과 차례별 서브에이전트 나무 지도 — 움직임 줄이기(setup.ts 기본)에서

const agent = (id: string, over: Partial<AgentView> = {}): AgentView => ({
  id, roomId: 'r1', name: id, role: '역할', folder: 'C:\\w', sessionId: 's', started: true, auto: false, model: null,
  alwaysAllow: [], pos: { x: 64, y: 64 }, color: null, effort: null, lastContext: null, bypassOn: false, effortNow: null, modelNow: null, status: 'idle', errorText: null, bypass: false, bypassBySettings: false, bypassPending: false, heldInput: 0, subagentsRunning: [], ...over,
})

const human = (text: string, t = 1): HistoryItem => ({ t, kind: 'user', source: 'human', parts: [{ type: 'text', text }] })
const relayIn = (from: string, text: string, t: number): HistoryItem => ({
  t, kind: 'user', source: 'relay', parts: [{ type: 'text', text: `[두레 메시지 — 보낸 쪽: ${from}(기획서)]\n${text}` }],
})
const asst = (blocks: any[], t = 2, parent?: string): HistoryItem => ({ t, kind: 'assistant', blocks, ...(parent ? { parent } : {}) })
const say = (text: string) => ({ type: 'text', text })
const use = (id: string, description: string) => ({ type: 'tool_use', id, name: 'Agent', input: { description, subagent_type: 'general-purpose', prompt: 'p' } })
const read = (id: string, file: string) => ({ type: 'tool_use', id, name: 'Read', input: { file_path: `C:\\w\\${file}` } })
const web = (id: string, query: string) => ({ type: 'tool_use', id, name: 'WebSearch', input: { query } })
const result = (id: string, text: string, parent?: string): HistoryItem => ({
  t: 5, kind: 'tool-result', toolUseId: id, isError: false, text, viaApproval: false, ...(parent ? { parent } : {}),
})
const start = (id: string, description: string, t: number, parentTaskId: string | null = null): HistoryItem => ({
  t, kind: 'subagent-start', toolUseId: id, taskId: `task-${id}`, description, subagentType: 'general-purpose', parentTaskId,
})
const end = (id: string, status: 'completed' | 'failed' | 'stopped', summary: string, t: number, toolUses: number | null = null): HistoryItem => ({
  t, kind: 'subagent-end', toolUseId: id, taskId: `task-${id}`, status, summary, toolUses, durationMs: null,
})
const turnEnd = (t: number): HistoryItem => ({ t, kind: 'result', ok: true, subtype: 'success' })

// 한 차례 — A 끝(한 일 셋·보고) · B 도는 중(b.html 읽는 중) · B 가 띄운 B2(안쪽, 줄이 오지 않음) = 안쪽 포함 셋
const THREE: HistoryItem[] = [
  human('경쟁사 랜딩 문구를 조사해서 표로 정리해 줘\n둘째 줄'),
  asst([say('나눠서 맡길게요'), use('A', 'A사 랜딩 문구 조사'), use('B', 'B사 랜딩 문구 조사')], 2),
  start('A', 'A사 랜딩 문구 조사', 1_000),
  start('B', 'B사 랜딩 문구 조사', 1_000),
  result('A', 'Async agent launched successfully. agentId: aaa'),
  result('B', 'Async agent launched successfully. agentId: bbb'),
  asst([web('wa', 'A사 랜딩'), read('ra', 'a-landing.html')], 1_100, 'A'),
  result('wa', '검색 결과', 'A'),
  result('ra', '<h1>일 잘하는 팀</h1>', 'A'),
  asst([say('A사 정리를 마쳤어요')], 1_200, 'A'),
  end('A', 'completed', '헤드라인은 **일 잘하는 팀의 첫 화면**이에요.', 22_000),
  turnEnd(23_000),
  asst([read('rb1', 'b-index.html')], 1_300, 'B'),
  result('rb1', '<html>', 'B'),
  asst([read('rb2', 'b.html')], 1_400, 'B'),
  asst([use('B2', 'B사 가격표 찾기')], 1_500, 'B'),
  start('B2', 'B사 가격표 찾기', 1_500, 'task-B'),
]

// 한 차례 — 상태 다섯(끝 · 도는 중 · 실패 · 멈춤 · 끊김)
const FIVE: HistoryItem[] = [
  human('다섯 군데 조사해 줘'),
  asst([use('A', '가 조사'), use('B', '나 조사'), use('C', '다 조사'), use('D', '라 조사'), use('E', '마 조사')], 2),
  start('A', '가 조사', 1_000),
  start('B', '나 조사', 1_000),
  start('C', '다 조사', 1_000),
  start('D', '라 조사', 1_000),
  start('E', '마 조사', 1_000),
  end('A', 'completed', '가 보고', 66_000, 5),
  end('C', 'failed', '웹 페이지를 열지 못했어요\n자세한 까닭은 이래요', 9_000, 1),
  end('D', 'stopped', '', 9_000, 0),
]

// 차례 셋 — 사람 말 · 받은 메시지 · 스스로 이어 간 차례
const TURNS: HistoryItem[] = [
  human('첫 부탁\n둘째 줄', 1),
  asst([use('A', '하나')], 2),
  start('A', '하나', 3),
  end('A', 'completed', '하나 보고', 4),
  turnEnd(5),
  relayIn('기획', '자료 부탁\n둘째 줄', 11),
  asst([use('B', '둘'), say('하나 더'), use('B3', '둘의 둘')], 12),
  start('B', '둘', 13),
  start('B3', '둘의 둘', 13),
  end('B', 'completed', '둘 보고', 14),
  end('B3', 'completed', '둘의 둘 보고', 14),
  turnEnd(15),
  asst([use('C', '셋')], 21),
  start('C', '셋', 22),
  end('C', 'completed', '셋 보고', 23),
  turnEnd(24),
]

const TWELVE: HistoryItem[] = [
  human('열두 곳'),
  asst(Array.from({ length: 12 }, (_, i) => use(`T${i}`, `조사 ${i + 1}`)), 2),
  ...Array.from({ length: 12 }, (_, i) => start(`T${i}`, `조사 ${i + 1}`, 3)),
]

const PLAIN: HistoryItem[] = [
  human('헤더 높이 좀 줄여 줘'),
  asst([say('줄였어요'), read('r', 'Header.tsx')], 2),
  result('r', 'export function Header() {}'),
  turnEnd(3),
]

let snapshot: Snapshot
let handlers: Record<string, ((p: any) => void)[]>
let histories: Record<string, HistoryItem[]>

const emit = <K extends keyof EngineEventMap>(k: K, p: EngineEventMap[K]) => act(() => (handlers[k] ?? []).forEach(f => f(p)))
const settle = () => act(async () => { await new Promise(r => setTimeout(r, 0)) })

beforeEach(() => {
  vi.resetModules()
  handlers = {}
  histories = { w: THREE, p: PLAIN }
  snapshot = {
    claudeMissing: false, rooms: [{ id: 'r1', name: '여름 캠페인', createdAt: 1 }],
    agents: [agent('w', { name: '기획', subagentsRunning: ['B', 'B2'] }), agent('p', { name: '디자인' })],
    messages: [], requests: [], autoChainLimit: 3, allowBypass: false, usage: null,
  }
  ;(window as any).dure = {
    snapshot: async () => snapshot,
    history: async (id: string) => histories[id] ?? [],
    describe: async () => ({ commands: [], models: [], permissionMode: 'default' }),
    sendUser: async () => {},
    on: (k: string, fn: (p: any) => void) => {
      ;(handlers[k] ??= []).push(fn)
      return () => {}
    },
  }
})
afterEach(() => {
  cleanup()
  vi.mocked(animate).mockClear()
})

async function renderPanel(select = 'w') {
  const { getStore } = await import('../../src/renderer/state/store')
  const { AgentPanel } = await import('../../src/renderer/panel/AgentPanel')
  await act(async () => { await getStore().init() })
  const r = render(<AgentPanel />)
  await act(async () => { getStore().selectAgent(select) })
  await settle()
  return { ...r, store: getStore() }
}

const chatTab = () => screen.getByRole('tab', { name: '대화' })
const subTab = () => screen.getByRole('tab', { name: /^서브에이전트/ })
const node = (name: RegExp | string) => screen.getByRole('button', { name: typeof name === 'string' ? new RegExp(`^${name}`) : name })
const openMap = () => fireEvent.click(subTab())

describe('패널 탭', () => {
  it('서브에이전트가 없는 대화면 탭이 없다 — 대화만', async () => {
    await renderPanel('p')
    expect(screen.queryByRole('tablist')).toBeNull()
    expect(screen.queryByRole('tabpanel')).toBeNull()
    expect(screen.getByRole('region', { name: '대화' })).toBeInTheDocument()
  })

  it('있으면 [대화 | 서브에이전트 N] — N 은 안쪽까지 센 수, 처음엔 대화', async () => {
    await renderPanel()
    const list = screen.getByRole('tablist')
    expect(within(list).getAllByRole('tab').map(t => t.textContent?.trim())).toEqual(['대화', '서브에이전트 3'])
    expect(chatTab()).toHaveAttribute('aria-selected', 'true')
    expect(subTab()).toHaveAttribute('aria-selected', 'false')
    expect(screen.getByRole('region', { name: '대화' })).toBeInTheDocument()
  })

  it('한 차례에 12개면 "서브에이전트 12"', async () => {
    histories.w = TWELVE
    snapshot.agents[0] = agent('w', { name: '기획', subagentsRunning: TWELVE.flatMap(i => (i.kind === 'subagent-start' ? [i.toolUseId] : [])) })
    await renderPanel()
    expect(subTab().textContent?.trim()).toBe('서브에이전트 12')
    openMap()
    expect(within(screen.getByRole('tabpanel')).getAllByRole('button', { name: /^조사 \d+/ })).toHaveLength(12)
  })

  it('도는 서브에이전트가 있으면 탭에 초록 점, 다 끝나면 없다', async () => {
    await renderPanel()
    expect(subTab().querySelector('.wk-dot')).not.toBeNull()
    expect(subTab()).toHaveAccessibleName('서브에이전트 3 도는 중')
    emit('subagents', { agentId: 'w', running: [] })
    expect(subTab().querySelector('.wk-dot')).toBeNull()
    expect(subTab()).toHaveAccessibleName('서브에이전트 3')
  })

  it('탭은 roving tabindex · aria-controls 로 한 패널을 — ←/→·Home·End 로 오가며 초점도 옮긴다', async () => {
    await renderPanel()
    expect(chatTab()).toHaveAttribute('tabindex', '0')
    expect(subTab()).toHaveAttribute('tabindex', '-1')
    const panel = screen.getByRole('tabpanel')
    expect(chatTab()).toHaveAttribute('aria-controls', panel.id)
    expect(subTab()).toHaveAttribute('aria-controls', panel.id)
    expect(panel).toHaveAttribute('aria-labelledby', chatTab().id)

    chatTab().focus()
    fireEvent.keyDown(chatTab(), { key: 'ArrowRight' })
    expect(subTab()).toHaveAttribute('aria-selected', 'true')
    expect(subTab()).toHaveFocus()
    expect(subTab()).toHaveAttribute('tabindex', '0')
    expect(screen.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', subTab().id)
    expect(screen.queryByRole('region', { name: '대화' })).toBeNull()

    fireEvent.keyDown(subTab(), { key: 'ArrowRight' }) // 끝에서 처음으로
    expect(chatTab()).toHaveAttribute('aria-selected', 'true')
    expect(chatTab()).toHaveFocus()
    fireEvent.keyDown(chatTab(), { key: 'ArrowLeft' }) // 처음에서 끝으로
    expect(subTab()).toHaveAttribute('aria-selected', 'true')
    fireEvent.keyDown(subTab(), { key: 'Home' })
    expect(chatTab()).toHaveAttribute('aria-selected', 'true')
    fireEvent.keyDown(chatTab(), { key: 'End' })
    expect(subTab()).toHaveAttribute('aria-selected', 'true')
  })

  it('입력창은 두 탭 모두에 있다', async () => {
    await renderPanel()
    expect(document.querySelector('.cmp')).not.toBeNull()
    openMap()
    expect(document.querySelector('.cmp')).not.toBeNull()
  })

  it('고른 탭은 에이전트마다 — 다른 에이전트를 골랐다 돌아오면 그 탭', async () => {
    const { store } = await renderPanel()
    openMap()
    await act(async () => { store.selectAgent('p') })
    await settle()
    expect(screen.queryByRole('tablist')).toBeNull()
    await act(async () => { store.selectAgent('w') })
    await settle()
    expect(subTab()).toHaveAttribute('aria-selected', 'true')
  })

  it('새 대화로 서브에이전트가 0 이 되면 탭이 사라지고 대화로 — 다음 서브에이전트가 와도 대화 탭', async () => {
    const { store } = await renderPanel()
    openMap()
    emit('history', { agentId: 'w', item: { t: 99, kind: 'boundary' } })
    expect(screen.queryByRole('tablist')).toBeNull()
    expect(screen.getByRole('region', { name: '대화' })).toBeInTheDocument()
    expect(store.getState().panelTab.w).toBe('chat')
    emit('history', { agentId: 'w', item: human('새 부탁', 100) })
    emit('history', { agentId: 'w', item: asst([use('N', '새 조사')], 101) })
    expect(subTab().textContent?.trim()).toBe('서브에이전트 1')
    expect(chatTab()).toHaveAttribute('aria-selected', 'true')
  })
})

describe('서브에이전트 지도', () => {
  it('차례 머리 — 사람 말 · 받은 메시지 · 스스로 이어 간 차례', async () => {
    histories.w = TURNS
    snapshot.agents[0] = agent('w', { name: '기획' })
    await renderPanel()
    openMap()
    const groups = within(screen.getByRole('tabpanel')).getAllByRole('group')
    expect(groups.map(g => g.getAttribute('aria-labelledby') && document.getElementById(g.getAttribute('aria-labelledby')!)?.textContent)).toEqual([
      '차례 · “첫 부탁”',
      '기획에게서 온 메시지 · “자료 부탁”',
      '서브에이전트가 끝난 뒤 이어서',
    ])
    // 묶음마다 부모(아바타·이름) 아래로 노드
    expect(within(groups[1]).getByText('기획', { selector: '.sa-root-n' })).toBeInTheDocument()
    expect(within(groups[1]).getAllByRole('button', { name: /^둘/ })).toHaveLength(2)
  })

  it('노드 칩 다섯 가지와 둘째 줄 — 끝은 도구 수·걸린 시간, 실패는 보고 첫 줄', async () => {
    histories.w = FIVE
    snapshot.agents[0] = agent('w', { name: '기획', subagentsRunning: ['B'] })
    await renderPanel()
    openMap()
    const map = screen.getByRole('tabpanel')
    expect([...map.querySelectorAll('.sa-st')].map(e => e.textContent)).toEqual(['끝', '도는 중', '실패', '멈춤', '끊김'])
    expect([...map.querySelectorAll('.sa-m')].map(e => e.textContent)).toEqual([
      '도구 5번 · 1분 5초',
      '도구 0번',
      '웹 페이지를 열지 못했어요',
      '멈췄어요',
      '끝나기 전에 끊겼어요',
    ])
  })

  it('도는 노드의 둘째 줄 — 마지막 하는 일이 진행 중이면 진행형, 끝났으면 그 동사', async () => {
    await renderPanel()
    openMap()
    expect(node('B사 랜딩 문구 조사').querySelector('.sa-m')).toHaveTextContent('b.html 읽는 중 · 도구 2번')
    expect(node('A사 랜딩 문구 조사').querySelector('.sa-m')).toHaveTextContent('도구 2번 · 21초')
    emit('history', { agentId: 'w', item: result('rb2', '<html>', 'B') })
    expect(node('B사 랜딩 문구 조사').querySelector('.sa-m')).toHaveTextContent('b.html 읽음 · 도구 2번')
  })

  it('누르면 그 자리에서 펼쳐져 한 일 줄·중간 글·"보고" — 여러 노드를 함께 펼친다', async () => {
    await renderPanel()
    openMap()
    const a = node('A사 랜딩 문구 조사')
    expect(a).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('보고')).toBeNull()
    fireEvent.click(a)
    expect(a).toHaveAttribute('aria-expanded', 'true')
    const body = document.getElementById(a.getAttribute('aria-controls')!)!
    expect(within(body).getAllByRole('button').map(b => b.textContent)).toEqual(['허용된 일A사 랜딩웹에서 찾아봄', 'a-landing.html읽음'])
    expect(within(body).getByText('A사 정리를 마쳤어요')).toBeInTheDocument()
    expect(within(body).getByText('보고')).toBeInTheDocument()
    expect(within(body).getByText('일 잘하는 팀의 첫 화면', { selector: 'strong' })).toBeInTheDocument()

    // 한 일 줄도 펼치면 출력
    fireEvent.click(within(body).getByRole('button', { name: /a-landing.html/ }))
    expect(within(body).getByText('<h1>일 잘하는 팀</h1>')).toBeInTheDocument()

    // 둘째 노드도 — 첫 노드는 펼친 채
    const b = node('B사 랜딩 문구 조사')
    fireEvent.click(b)
    expect(a).toHaveAttribute('aria-expanded', 'true')
    expect(b).toHaveAttribute('aria-expanded', 'true')
    const bBody = document.getElementById(b.getAttribute('aria-controls')!)!
    const rows = within(bBody).getAllByRole('button')
    expect(rows.map(r => r.textContent)).toEqual(['b-index.html읽음', 'b.html읽음'])
    expect(rows[1]).toBeDisabled() // 진행 중 — 펼칠 것이 없다
    expect(within(bBody).queryByText('보고')).toBeNull() // 아직 끝나지 않았다

    fireEvent.click(a)
    expect(a).toHaveAttribute('aria-expanded', 'false')
    expect(document.getElementById(a.getAttribute('aria-controls')!)).toBeNull()
  })

  it('안쪽 서브에이전트는 띄운 노드 아래 들여 붙고, 펼치면 Claude 가 보내 주지 않는다는 한 줄', async () => {
    await renderPanel()
    openMap()
    const b = node('B사 랜딩 문구 조사')
    const b2 = node('B사 가격표 찾기')
    const parentItem = b2.closest('ul')!.closest('li')!
    expect(parentItem).toContainElement(b)
    expect(b2.closest('ul')).toHaveClass('sa-kids')
    expect(b2.closest('ul')).not.toBe(b.closest('ul'))
    fireEvent.click(b2)
    const body = document.getElementById(b2.getAttribute('aria-controls')!)!
    expect(body).toHaveTextContent('이 서브에이전트가 한 일은 Claude 가 보내 주지 않아요')
  })

  it('Claude 내부 안내(Agent 결과)는 지도 어디에도 없다', async () => {
    await renderPanel()
    openMap()
    for (const b of within(screen.getByRole('tabpanel')).getAllByRole('button', { name: /조사|찾기/ })) fireEvent.click(b)
    expect(screen.queryByText(/Async agent launched/)).toBeNull()
  })

  it('탭을 열면 맨 아래(최신 차례)로', async () => {
    const was = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollHeight')
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', { configurable: true, get: () => 640 })
    try {
      histories.w = TURNS
      await renderPanel()
      openMap()
      expect(document.querySelector('.sa-map')!.scrollTop).toBe(640)
    } finally {
      if (was) Object.defineProperty(HTMLElement.prototype, 'scrollHeight', was)
      else delete (HTMLElement.prototype as any).scrollHeight
    }
  })

  it('showSubagents(id, key) — 탭을 바꾸고 그 노드가 든 차례 묶음을 scrollIntoView', async () => {
    const seen: Element[] = []
    const into = vi.fn(function (this: Element) { seen.push(this) })
    ;(HTMLElement.prototype as any).scrollIntoView = into
    const was = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollHeight')
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', { configurable: true, get: () => 640 })
    try {
      histories.w = TURNS
      const { store } = await renderPanel()
      // B3 은 받은 메시지 차례의 둘째 노드 — 그 차례의 key(B)와 다르다(글이 Agent 호출을 둘로 나눔)
      await act(async () => { store.showSubagents('w', 'B3') })
      expect(subTab()).toHaveAttribute('aria-selected', 'true')
      const turn = screen.getByRole('group', { name: /자료 부탁/ })
      expect(seen).toEqual([turn])
      expect(document.activeElement).toBe(turn) // 키보드 초점도 그 묶음으로(차례 머리가 이름)
      expect(turn).toHaveAttribute('tabindex', '-1')
      expect(document.querySelector('.sa-map')!.scrollTop).toBe(0) // 맨 아래로 끌어 내리지 않는다

      // 열린 채 다시 — 다른 차례로
      await act(async () => { store.showSubagents('w', 'C') })
      const auto = screen.getByRole('group', { name: '서브에이전트가 끝난 뒤 이어서' })
      expect(seen).toEqual([turn, auto])
      expect(document.activeElement).toBe(auto)

      // 대화로 갔다가 탭만 다시 열면 맨 아래로 — 지난 focus 로 다시 스크롤하지도, 초점을 옮기지도 않는다
      fireEvent.click(chatTab())
      openMap()
      expect(seen).toHaveLength(2)
      expect(document.activeElement).toBe(document.body)
      expect(document.querySelector('.sa-map')!.scrollTop).toBe(640)
    } finally {
      delete (HTMLElement.prototype as any).scrollIntoView
      if (was) Object.defineProperty(HTMLElement.prototype, 'scrollHeight', was)
      else delete (HTMLElement.prototype as any).scrollHeight
    }
  })
})

describe('서브에이전트 지도 — 강조 움직임', () => {
  const groupCalls = () => vi.mocked(animate).mock.calls.filter(c => (c[0] as HTMLElement).classList?.contains('sa-turn'))

  it('요약 줄에서 오면 그 차례 묶음이 새 줄과 같은 움직임(260ms · y 12 · 0.98)으로 다시 들어온다', async () => {
    allowMotion()
    ;(HTMLElement.prototype as any).scrollIntoView = () => {}
    try {
      histories.w = TURNS
      const { store } = await renderPanel()
      await act(async () => { store.showSubagents('w', 'B') })
      const calls = groupCalls()
      expect(calls).toHaveLength(1)
      expect(calls[0][0]).toBe(screen.getByRole('group', { name: /자료 부탁/ }))
      const p = calls[0][1] as any
      expect([p.duration, p.ease, p.opacity.from, p.translateY.from, p.scale.from]).toEqual([260, 'outQuint', 0, 12, 0.98])
    } finally {
      delete (HTMLElement.prototype as any).scrollIntoView
    }
  })

  it('탭만 열면 · 움직임 줄이기면 강조하지 않는다', async () => {
    ;(HTMLElement.prototype as any).scrollIntoView = () => {}
    try {
      histories.w = TURNS
      const { store } = await renderPanel()
      await act(async () => { store.showSubagents('w', 'B') }) // 움직임 줄이기(기본)
      fireEvent.click(chatTab())
      allowMotion()
      openMap()
      expect(groupCalls()).toHaveLength(0)
    } finally {
      delete (HTMLElement.prototype as any).scrollIntoView
    }
  })
})
