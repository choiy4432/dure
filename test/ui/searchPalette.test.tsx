import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { render, screen, act, fireEvent, cleanup, within } from '@testing-library/react'
import type { ConversationSummary, HistoryItem, SearchHit, SearchResult } from '../../src/engine/types'
import type { AgentView, Snapshot } from '../../src/shared/ipcContract'

// 하나의 검색창(Ctrl+K · 시안 ① A) — 에이전트·방 이름으로 옮기기 + 대화 찾기(지난 대화 포함) · 고른 대화 줄로 가서 잠깐 표시.
// 화면 시험은 움직임 줄이기(setup.ts 기본)라 열고 닫기가 기다림 없이 맞는다

const agent = (id: string, roomId: string, name: string, over: Partial<AgentView> = {}): AgentView => ({
  id, roomId, name, role: '역할', folder: 'C:\\w', sessionId: 's', started: true, auto: false, model: null,
  alwaysAllow: [], pos: { x: 64, y: 64 }, color: null, effort: null, lastContext: null, bypassOn: false, effortNow: null, modelNow: null, status: 'idle', errorText: null, bypass: false, bypassBySettings: false, bypassPending: false, heldInput: 0, planMode: false, asleep: false, waking: false, hold: null, subagentsRunning: [], pastCount: 0, remoteIssue: null, ...over,
})

const NOW = Date.now()
const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

const hit = (over: Partial<SearchHit> & Pick<SearchHit, 'agentId' | 'roomId' | 't'>): SearchHit => ({
  conversation: { key: null, startedAt: over.t - HOUR }, who: 'me', snippet: '결제 버튼 색이 너무 연해', ranges: [[0, 5]], ...over,
})

/** 한 차례 = 사람 말 + Claude 답 — t 부터 두 항목 */
const turn = (t: number, n: number): HistoryItem[] => [
  { t, kind: 'user', source: 'human', parts: [{ type: 'text', text: `질문 ${n}` }] },
  { t: t + 1, kind: 'assistant', blocks: [{ type: 'text', text: `답 ${n}` }] },
]

let snapshot: Snapshot
let handlers: Record<string, ((p: any) => void)[]>
let history: Mock<(id: string, o?: { before?: number; limit?: number }) => Promise<HistoryItem[]>>
let search: Mock<(q: string, o?: { roomId?: string }) => Promise<SearchResult & { cancelled?: true }>>
let conversations: Mock<(id: string) => Promise<ConversationSummary[]>>
let conversation: Mock<(id: string, key: string, o?: { limit?: number }) => Promise<HistoryItem[]>>

beforeEach(() => {
  vi.resetModules()
  localStorage.clear()
  handlers = {}
  snapshot = {
    claudeMissing: false,
    rooms: [{ id: 'r1', name: '쇼핑몰 리뉴얼', createdAt: 1 }, { id: 'r2', name: '사내 도구', createdAt: 2 }],
    agents: [
      agent('w', 'r1', '웹', { role: '프론트엔드', folder: 'C:\\work\\shop\\web' }),
      agent('s', 'r1', '서버', { role: 'API · DB' }),
      agent('pay', 'r2', '결제 모듈', { role: '서버' }),
      agent('d', 'r2', '디자인', { role: '화면 설계', pastCount: 1 }),
    ],
    messages: [], requests: [], autoChainLimit: 3, allowBypass: false, notify: { asks: true, finished: false }, sleepAfterMin: 30, usage: null,
  }
  history = vi.fn(async () => [])
  search = vi.fn(async () => ({ hits: [], more: false }))
  conversations = vi.fn(async () => [])
  conversation = vi.fn(async () => [])
  const prefs = { tourDone: true, approvalTipSeen: true, claudeAutoUpdate: true }
  ;(window as any).dure = {
    appInfo: async () => ({ version: '0.1.0', packaged: true }),
    prefs: async () => prefs,
    setPrefs: async () => prefs,
    updateState: async () => ({ kind: 'idle' }),
    claudeUpdateState: async () => 'idle',
    setupState: async () => ({ phase: 'ready' }),
    snapshot: async () => snapshot,
    history: (id: string, o?: { before?: number; limit?: number }) => history(id, o),
    search: (q: string, o?: { roomId?: string }) => search(q, o),
    conversations: (id: string) => conversations(id),
    conversation: (id: string, key: string, o?: { limit?: number }) => conversation(id, key, o),
    describe: async () => ({ commands: [], models: [], permissionMode: 'default' }),
    sendUser: async () => {},
    setSelected: async () => {},
    updateAgent: async () => ({}),
    on: (k: string, fn: (p: any) => void) => {
      ;(handlers[k] ??= []).push(fn)
      return () => {}
    },
  }
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

const wait = (ms = 0) => act(async () => { await new Promise(r => setTimeout(r, ms)) })

async function renderApp() {
  const { getStore } = await import('../../src/renderer/state/store')
  const { App } = await import('../../src/renderer/App')
  await act(async () => { await getStore().init() })
  render(<App />)
  await wait()
  return getStore()
}

const ctrlK = (target: Element = document.activeElement ?? document.body, o: { meta?: boolean } = {}) =>
  act(() => { fireEvent.keyDown(target, { key: 'k', code: 'KeyK', ctrlKey: !o.meta, metaKey: !!o.meta }) })
const palette = () => screen.queryByRole('dialog', { name: '찾기 · 옮기기' })
const input = () => screen.getByRole('combobox', { name: '찾기 · 옮기기' }) as HTMLInputElement
const type = (text: string) => act(() => { fireEvent.change(input(), { target: { value: text } }) })
const key = (k: string) => act(() => { fireEvent.keyDown(input(), { key: k }) })
const options = () => screen.queryAllByRole('option')
const optionNames = () => options().map(o => o.querySelector('.pal-l1')?.textContent)
const group = (name: string | RegExp) => screen.getByRole('group', { name })
const status = () => within(palette()!).getByRole('status')
const conv = () => screen.getByRole('region', { name: '대화' })

async function openPalette() {
  await ctrlK(document.body)
  expect(palette()).not.toBeNull()
}

/** 찾기 → 150 ms 기다림 → 답까지 */
async function find(text: string) {
  await type(text)
  await wait(200)
}

describe('검색창 — 열기 · 닫기', () => {
  it('Ctrl+K · Cmd+K · 위 띠의 찾기 · 옮기기 칸으로 열리고, Esc 로 닫으면 초점이 연 자리로 돌아간다', async () => {
    await renderApp()
    const field = screen.getByRole('button', { name: '찾기 · 옮기기' })
    expect(field).toHaveTextContent('찾기 · 옮기기')
    expect(field.querySelector('kbd')).toHaveTextContent('Ctrl K')
    expect(field).toHaveAttribute('aria-keyshortcuts', 'Control+K')

    const gear = screen.getByRole('button', { name: '설정' })
    gear.focus()
    await ctrlK(gear)
    expect(palette()).not.toBeNull()
    expect(document.activeElement).toBe(input())
    expect(field).toHaveAttribute('aria-expanded', 'true')
    await key('Escape')
    expect(palette()).toBeNull()
    expect(document.activeElement).toBe(gear)

    await ctrlK(document.body, { meta: true })
    expect(palette()).not.toBeNull()
    await key('Escape')

    fireEvent.click(field)
    expect(palette()).not.toBeNull()
    // 열린 채 칸을 다시 누르면 닫힌다
    fireEvent.pointerDown(field)
    fireEvent.click(field)
    expect(palette()).toBeNull()
  })

  it('바깥(막)을 누르면 닫힌다 · 안에서 Ctrl+K 를 다시 누르면 닫힌다', async () => {
    await renderApp()
    await openPalette()
    fireEvent.pointerDown(document.querySelector('.pal-bd')!)
    expect(palette()).toBeNull()
    await openPalette()
    await ctrlK(input())
    expect(palette()).toBeNull()
  })

  it('ctrlKIgnoredUnderDialog — 설정 창 등 다른 창이 떠 있거나 다른 입력칸에 쓰는 중이면 Ctrl+K 를 무시한다 · 입력창에서는 열린다', async () => {
    const store = await renderApp()
    fireEvent.click(screen.getByRole('button', { name: '설정' }))
    const settings = screen.getByRole('dialog', { name: '설정' })
    await ctrlK(settings)
    expect(palette()).toBeNull()
    await ctrlK(document.body)
    expect(palette()).toBeNull()
    fireEvent.keyDown(settings, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: '설정' })).toBeNull()

    // 다른 입력칸(설정 숫자 칸·이름 고치기 같은) — 그 칸의 글쓰기를 빼앗지 않는다
    const other = document.createElement('input')
    document.body.append(other)
    other.focus()
    await ctrlK(other)
    expect(palette()).toBeNull()
    other.remove()

    // 입력창(Composer)에서는 연다 — 닫으면 입력창으로 돌아간다
    await act(async () => { store.selectAgent('w') })
    await wait()
    const composer = screen.getByRole('textbox', { name: '웹에게 보낼 메시지' })
    composer.focus()
    await ctrlK(composer)
    expect(palette()).not.toBeNull()
    await key('Escape')
    expect(document.activeElement).toBe(composer)
  })
})

describe('검색창 — 에이전트 · 방 묶음', () => {
  it('빈 입력이면 최근 고른 에이전트(새로 고른 것부터) — 고른 적이 없으면 이 방 에이전트', async () => {
    const store = await renderApp()
    await openPalette()
    expect(group('이 방 에이전트')).toBeTruthy()
    expect(optionNames()).toEqual(['웹', '서버'])
    await key('Escape')

    await act(async () => { store.focusAgent('pay') })
    await act(async () => { store.focusAgent('s') })
    await openPalette()
    expect(group('최근 고른 에이전트')).toBeTruthy()
    expect(optionNames()).toEqual(['서버', '결제 모듈'])
    expect(search).not.toHaveBeenCalled()
  })

  it('이름·역할·폴더가 맞는 에이전트(지금 방 먼저)와 이름이 맞는 방 — 맞은 곳 강조', async () => {
    await renderApp()
    await openPalette()
    await type('서버')
    expect(group('에이전트 · 방')).toBeTruthy()
    // 지금 방(쇼핑몰 리뉴얼)의 '서버' 먼저, 다른 방에서 역할이 맞는 '결제 모듈'
    expect(optionNames()).toEqual(['서버', '결제 모듈'])
    expect(options()[0].querySelector('.pal-l1 mark')).toHaveTextContent('서버')
    expect(options()[0]).toHaveTextContent('API · DB · 쇼핑몰 리뉴얼')
    expect(options()[1].querySelector('.pal-l2 mark')).toHaveTextContent('서버')

    await type('SHOP')
    expect(optionNames()).toEqual(['웹']) // 폴더(C:\work\shop\web) — 대소문자 무시

    await type('사내')
    expect(optionNames()).toEqual(['사내 도구'])
    expect(options()[0]).toHaveTextContent('방')
    expect(options()[0]).toHaveTextContent('에이전트 2개')
  })

  it('에이전트를 고르면 그 에이전트(다른 방이면 방도) · 방을 고르면 그 방으로', async () => {
    const store = await renderApp()
    await openPalette()
    await type('결제 모')
    fireEvent.click(options()[0])
    expect(palette()).toBeNull()
    expect(store.getState().roomId).toBe('r2')
    expect(store.getState().selectedAgentId).toBe('pay')

    await openPalette()
    await type('쇼핑')
    await key('Enter')
    expect(palette()).toBeNull()
    expect(store.getState().roomId).toBe('r1')
    expect(store.getState().selectedAgentId).toBeNull()
  })
})

describe('검색창 — 대화 묶음', () => {
  it('두 글자부터, 타자 뒤 150 ms 기다렸다 지금 방과 함께 찾는다', async () => {
    await renderApp()
    await openPalette()
    await type('결')
    await wait(200)
    expect(search).not.toHaveBeenCalled()
    expect(palette()).toHaveTextContent('두 글자부터 대화 내용도 찾아요')

    await type('결제')
    await wait(60)
    await type('결제 버튼')
    await wait(100)
    expect(search).not.toHaveBeenCalled()
    await wait(100)
    expect(search).toHaveBeenCalledTimes(1)
    expect(search).toHaveBeenCalledWith('결제 버튼', { roomId: 'r1' })
  })

  it('결과 줄 — 맞은 곳 앞뒤 글(강조) · 에이전트 · 누가 · 지금/지난 대화(시작한 날) · 언제, 다른 방이면 방 이름 · 지운 에이전트의 줄은 뺀다', async () => {
    const started = NOW - 40 * DAY
    const d = new Date(started)
    const day = d.getFullYear() === new Date(NOW).getFullYear() ? `${d.getMonth() + 1}월 ${d.getDate()}일` : `${d.getFullYear()}년 ${d.getMonth() + 1}월 ${d.getDate()}일`
    search.mockResolvedValue({
      more: false,
      hits: [
        hit({ agentId: 'w', roomId: 'r1', t: NOW - 10_000 }),
        hit({ agentId: 's', roomId: 'r1', t: NOW - 2 * HOUR, who: 'message', from: '기획', snippet: '웹이 결제 버튼을 누르면', ranges: [[3, 8]] }),
        hit({ agentId: 'gone', roomId: 'r1', t: NOW - 3 * HOUR }),
        hit({ agentId: 'd', roomId: 'r2', t: NOW - 2 * DAY, who: 'claude', conversation: { key: 'S1', startedAt: started }, snippet: '…결제 버튼 크기는 48px', ranges: [[1, 6]] }),
      ],
    })
    await renderApp()
    await openPalette()
    await find('결제 버튼')
    const g = group(/대화에서/)
    expect(within(g).getByText('대화에서 · 3곳')).toBeTruthy()
    expect(g).toHaveTextContent('지난 대화 포함')
    const rows = within(g).getAllByRole('option')
    expect(rows).toHaveLength(3)
    expect(rows[0].querySelector('.pal-l1')).toHaveTextContent('결제 버튼 색이 너무 연해')
    expect(rows[0].querySelector('.pal-l1 mark')).toHaveTextContent(/^결제 버튼$/)
    expect(rows[0].querySelector('.pal-l2')).toHaveTextContent(/^웹 · 나 · 지금 대화$/)
    expect(rows[0].querySelector('.pal-tm')).toHaveTextContent('방금')
    expect(rows[1].querySelector('.pal-l1 mark')).toHaveTextContent(/^결제 버튼$/)
    expect(rows[1].querySelector('.pal-l2')).toHaveTextContent(/^서버 · 기획에게서 온 메시지 · 지금 대화$/)
    expect(rows[1].querySelector('.pal-tm')).toHaveTextContent('2시간 전')
    expect(rows[2].querySelector('.pal-l2')).toHaveTextContent(`디자인 · Claude · 지난 대화(${day} 시작) · 사내 도구`)
    expect(rows[2].querySelector('.pal-tm')).toHaveTextContent('2일 전')
  })

  it('50곳이 넘으면 끝에 \'더 있어요\' 줄 · 맞는 곳이 없으면 그렇다고', async () => {
    search.mockResolvedValueOnce({ more: true, hits: Array.from({ length: 50 }, (_, i) => hit({ agentId: 'w', roomId: 'r1', t: NOW - i * MIN })) })
    await renderApp()
    await openPalette()
    await find('결제 버튼')
    expect(within(group(/대화에서/)).getByText('대화에서 · 50곳')).toBeTruthy()
    expect(within(group(/대화에서/)).getAllByRole('option')).toHaveLength(50)
    expect(palette()).toHaveTextContent('더 있어요 — 낱말을 더 적어 보세요')

    await find('없는 말')
    expect(screen.queryByRole('group', { name: /대화에서/ })).toBeNull()
    expect(palette()).toHaveTextContent('맞는 것이 없어요')
    expect(palette()).not.toHaveTextContent('더 있어요')
  })

  it('staleResultsIgnored — 앞 찾기 결과가 나중에 도착해도 화면에 나오지 않는다(끊긴 답은 버린다)', async () => {
    let late: (r: SearchResult) => void = () => {}
    search
      .mockImplementationOnce(() => new Promise(r => { late = r }))
      .mockResolvedValueOnce({ more: false, hits: [hit({ agentId: 'w', roomId: 'r1', t: NOW, snippet: '결제 버튼 새 결과', ranges: [[0, 5]] })] })
      .mockResolvedValueOnce({ hits: [], more: false, cancelled: true })
    await renderApp()
    await openPalette()
    await find('결제')
    await find('결제 버튼')
    expect(optionNames()).toEqual(['결제 버튼 새 결과'])
    // 앞 찾기(결제)의 답이 이제 왔다 — main 이 끊지 못했어도 화면은 버린다
    await act(async () => { late({ more: false, hits: [hit({ agentId: 's', roomId: 'r1', t: NOW, snippet: '결제 앞 결과', ranges: [[0, 2]] })] }) })
    await wait()
    expect(optionNames()).toEqual(['결제 버튼 새 결과'])
    // 끊긴 답(cancelled)은 지금 결과를 지우지 않는다
    await find('결제 버튼 ')
    await find('결제 버튼 색')
    expect(palette()).not.toHaveTextContent('결제 앞 결과')
  })
})

describe('검색창 — 키보드 · 접근성', () => {
  it('combobox + listbox — ↑↓ 로 고르면 aria-activedescendant 가 따라가고, 결과 수는 polite 로 읽힌다 · Enter 로 연다', async () => {
    search.mockResolvedValue({ more: false, hits: [hit({ agentId: 'w', roomId: 'r1', t: NOW, snippet: '서버 설정 결제', ranges: [[0, 2]] })] })
    const store = await renderApp()
    await openPalette()
    expect(palette()).toHaveAttribute('aria-modal', 'true')
    await find('서버')
    const box = input()
    const list = screen.getByRole('listbox')
    expect(box).toHaveAttribute('aria-expanded', 'true')
    expect(box).toHaveAttribute('aria-controls', list.id)
    expect(box).toHaveAttribute('aria-autocomplete', 'list')
    const all = options()
    expect(all).toHaveLength(3)
    expect(box.getAttribute('aria-activedescendant')).toBe(all[0].id)
    expect(all[0]).toHaveAttribute('aria-selected', 'true')
    expect(status()).toHaveAttribute('aria-live', 'polite')
    expect(status()).toHaveTextContent('에이전트·방 2개 · 대화 1곳')

    await key('ArrowDown')
    expect(box.getAttribute('aria-activedescendant')).toBe(all[1].id)
    expect(all[1]).toHaveAttribute('aria-selected', 'true')
    expect(all[0]).toHaveAttribute('aria-selected', 'false')
    await key('ArrowDown')
    await key('ArrowDown') // 끝에서 처음으로
    expect(box.getAttribute('aria-activedescendant')).toBe(all[0].id)
    await key('ArrowUp') // 처음에서 끝으로
    expect(box.getAttribute('aria-activedescendant')).toBe(all[2].id)
    await key('ArrowUp')
    await key('Enter')
    expect(palette()).toBeNull()
    expect(store.getState().selectedAgentId).toBe('pay')
  })

  it('찾는 동안은 그렇다고 읽힌다 · 맞는 것이 없으면 listbox 가 닫혀 있다', async () => {
    let done: (r: SearchResult) => void = () => {}
    search.mockImplementationOnce(() => new Promise(r => { done = r }))
    await renderApp()
    await openPalette()
    await find('없는 말')
    expect(status()).toHaveTextContent('대화에서 찾는 중')
    await act(async () => { done({ hits: [], more: false }) })
    expect(status()).toHaveTextContent('맞는 것이 없어요')
    expect(input()).toHaveAttribute('aria-expanded', 'false')
    expect(input()).not.toHaveAttribute('aria-activedescendant')
  })
})

describe('고른 대화 줄로 가기', () => {
  /** 지금 대화 260 차례(520 항목) — 처음엔 끝 500 항목만, before 를 주면 그 앞을 limit 만큼 */
  const ALL: HistoryItem[] = Array.from({ length: 260 }, (_, i) => turn(10_000 + i * 10, i)).flat()
  const answer = (_id: string, o?: { before?: number; limit?: number }) => {
    const pool = o?.before === undefined ? ALL : ALL.filter(x => x.t < o.before!)
    const limit = o?.limit ?? 500
    return Promise.resolve(limit === Infinity ? pool : pool.slice(-limit))
  }

  it('jumpToOlderHit — 불러온 범위보다 앞의 지금 대화 줄: 한 번에 그 줄까지 불러와 그 줄로 가서 표시한다(겹친 줄 없이)', async () => {
    history.mockImplementation(answer)
    const target = ALL[4] // 질문 2 — 불러온 끝 500 항목(질문 10 부터)보다 앞
    search.mockResolvedValue({ more: false, hits: [hit({ agentId: 'w', roomId: 'r1', t: target.t, snippet: '질문 2', ranges: [[0, 2]] })] })
    const store = await renderApp()
    await act(async () => { store.selectAgent('s') })
    await openPalette()
    await find('질문 2')
    await key('Enter')
    await wait()
    await wait()
    expect(store.getState().selectedAgentId).toBe('w')
    // 앞쪽은 한 번에 — 엔진은 부를 때마다 파일을 다시 읽는다
    const older = history.mock.calls.filter(([, o]) => o?.before !== undefined)
    const first = ALL[ALL.length - 500].t
    expect(older).toEqual([['w', { before: first + 1, limit: Infinity }]])
    // 같은 시각(first)의 줄은 한 번만 — 이미 가진 줄을 앞쪽에서 또 붙이지 않는다
    expect(conv().querySelectorAll(`[data-t="${first}"]`)).toHaveLength(1)
    const row = conv().querySelector<HTMLElement>(`:scope > [data-t="${target.t}"]`)!
    expect(row).toHaveClass('me')
    expect(row).toHaveTextContent('질문 2')
    expect(row).toHaveClass('hit')
    expect(document.activeElement).toBe(row)
    expect(store.getState().hitFocus).toBeNull()
  })

  it('불러온 범위 안이면 더 부르지 않고 그 줄로 · 같은 시각의 줄이 여럿이면 누가와 맞는 첫 줄 · 차례 가운데 Claude 글은 그 답 줄', async () => {
    history.mockResolvedValue([
      { t: 100, kind: 'user', source: 'human', parts: [{ type: 'text', text: '헤더 높이' }] },
      { t: 100, kind: 'assistant', blocks: [{ type: 'text', text: '줄였어요' }] },
      { t: 105, kind: 'assistant', blocks: [{ type: 'text', text: '로고도 줄였어요' }] },
      { t: 106, kind: 'result', ok: true, subtype: 'success' },
    ])
    const store = await renderApp()
    await act(async () => { await store.openHit(hit({ agentId: 'w', roomId: 'r1', t: 100, who: 'claude' })) })
    await wait()
    expect(history.mock.calls.every(([, o]) => o === undefined)).toBe(true)
    expect(conv().querySelector('.hit')).toHaveClass('ci-claude')

    await act(async () => { await store.openHit(hit({ agentId: 'w', roomId: 'r1', t: 100, who: 'me' })) })
    await wait()
    expect(conv().querySelectorAll('.hit')).toHaveLength(1)
    expect(conv().querySelector('.hit')).toHaveClass('me')

    await act(async () => { await store.openHit(hit({ agentId: 'w', roomId: 'r1', t: 105, who: 'claude' })) })
    await wait()
    expect(conv().querySelector('.hit')).toHaveClass('ci-claude')
    expect(conv().querySelector('.hit')).toHaveAttribute('data-t', '100')
  })

  it('표시는 약 2초 뒤 사라진다', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    history.mockResolvedValue(turn(100, 1))
    const { getStore } = await import('../../src/renderer/state/store')
    const { App } = await import('../../src/renderer/App')
    await act(async () => { await getStore().init() })
    render(<App />)
    await act(async () => { await getStore().openHit(hit({ agentId: 'w', roomId: 'r1', t: 100 })) })
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    const row = conv().querySelector('[data-t="100"]')!
    expect(row).toHaveClass('hit')
    await act(async () => { await vi.advanceTimersByTimeAsync(1900) })
    expect(row).toHaveClass('hit')
    await act(async () => { await vi.advanceTimersByTimeAsync(200) })
    expect(row).not.toHaveClass('hit')
  })

  describe('지난 대화', () => {
    const PAST: HistoryItem[] = Array.from({ length: 260 }, (_, i) => turn(5_000 + i * 10, i)).flat() // 520 항목
    const CONVS: ConversationSummary[] = [
      { key: 'cur', current: true, title: '지금 대화', at: NOW, turns: 1, lastReply: '', resumable: false, why: null },
      { key: 'S1', current: false, title: '버튼 크기 정하기', at: NOW - 2 * DAY, turns: 260, lastReply: '', resumable: true, why: null },
    ]
    beforeEach(() => {
      conversations.mockResolvedValue(CONVS)
      conversation.mockImplementation(async (_id, _key, o) => (o?.limit === Infinity ? PAST : PAST.slice(-500)))
    })

    it('jumpToPastHit — 지난 대화 줄은 그 에이전트의 지난 대화 보기를 그 줄에서 연다(끝 500 줄보다 앞이면 한 번에 모두)', async () => {
      const target = PAST[11] // 답 5 — 끝 500 항목보다 앞
      search.mockResolvedValue({ more: false, hits: [hit({ agentId: 'd', roomId: 'r2', t: target.t, who: 'claude', conversation: { key: 'S1', startedAt: PAST[0].t }, snippet: '답 5', ranges: [[0, 3]] })] })
      const store = await renderApp()
      await openPalette()
      await find('답 5')
      await key('Enter')
      await wait()
      await wait()
      expect(store.getState().roomId).toBe('r2')
      expect(store.getState().selectedAgentId).toBe('d')
      expect(screen.getByRole('tab', { name: /지난 대화/ })).toHaveAttribute('aria-selected', 'true')
      const view = screen.getByRole('region', { name: '버튼 크기 정하기' })
      expect(conversation.mock.calls.filter(([, , o]) => o?.limit === Infinity)).toEqual([['d', 'S1', { limit: Infinity }]])
      const row = view.querySelector<HTMLElement>(`:scope > [data-t="${target.t}"]`)!
      expect(row).toHaveClass('ci-claude')
      expect(row).toHaveTextContent('답 5')
      expect(row).toHaveClass('hit')
      expect(document.activeElement).toBe(row)
    })

    it('끝 500 줄 안이면 더 부르지 않는다 · 목록에 없는 대화도 그 열쇠로 연다', async () => {
      const store = await renderApp()
      const target = PAST[PAST.length - 4]
      await act(async () => { await store.openHit(hit({ agentId: 'd', roomId: 'r2', t: target.t, who: 'me', conversation: { key: 'S1', startedAt: PAST[0].t } })) })
      await wait()
      await wait()
      expect(conversation.mock.calls.some(([, , o]) => o?.limit === Infinity)).toBe(false)
      expect(screen.getByRole('region', { name: '버튼 크기 정하기' }).querySelector(`[data-t="${target.t}"]`)).toHaveClass('hit')

      // 사람 말 없는 대화 — 목록(conversations)엔 없지만 conversation(id, key) 로는 읽힌다
      conversation.mockResolvedValue([{ t: 42, kind: 'assistant', blocks: [{ type: 'text', text: '혼자 한 말' }] }])
      await act(async () => { await store.openHit(hit({ agentId: 'd', roomId: 'r2', t: 42, who: 'claude', conversation: { key: 'S0', startedAt: 42 } })) })
      await wait()
      await wait()
      expect(conversation).toHaveBeenLastCalledWith('d', 'S0', undefined)
      expect(document.querySelector('.pc-view [data-t="42"]')).toHaveClass('hit')
    })
  })
})

describe('대화 줄 표시(data-t)', () => {
  it('지금 대화의 줄마다 그 줄을 연 기록의 시각', async () => {
    history.mockResolvedValue([...turn(100, 1), { t: 102, kind: 'notice', text: '멈췄어요' }])
    const store = await renderApp()
    await act(async () => { store.selectAgent('w') })
    await wait()
    expect(Array.from(conv().querySelectorAll<HTMLElement>(':scope > [data-t]')).map(n => n.dataset.t)).toEqual(['100', '101', '102'])
  })
})

describe('설정 — 두레 탭', () => {
  it('단축키 한 줄 — Ctrl+K 찾기 · 옮기기', async () => {
    await renderApp()
    fireEvent.click(screen.getByRole('button', { name: '설정' }))
    const dlg = screen.getByRole('dialog', { name: '설정' })
    fireEvent.click(within(dlg).getByRole('tab', { name: '두레' }))
    const row = within(dlg).getByText('단축키').closest('[data-row]') as HTMLElement
    expect(row).toHaveTextContent('Ctrl+K 찾기 · 옮기기')
  })
})
