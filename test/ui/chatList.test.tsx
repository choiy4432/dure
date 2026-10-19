import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { render, screen, act, fireEvent, cleanup, within } from '@testing-library/react'
import type { EngineEventMap, HistoryItem } from '../../src/engine/types'
import type { AgentView, Snapshot } from '../../src/shared/ipcContract'

const agent = (id: string, over: Partial<AgentView> = {}): AgentView => ({
  id, roomId: 'r1', name: id, role: '역할', folder: 'C:\\w', sessionId: 's', started: true, auto: false, model: null,
  alwaysAllow: [], pos: { x: 64, y: 64 }, color: null, status: 'idle', errorText: null, bypass: false, heldInput: 0, ...over,
})

let snapshot: Snapshot
let handlers: Record<string, ((p: any) => void)[]>
let history: Mock<(id: string) => Promise<HistoryItem[]>>

const emit = <K extends keyof EngineEventMap>(k: K, p: EngineEventMap[K]) => act(() => (handlers[k] ?? []).forEach(f => f(p)))
const settle = () => act(async () => { await new Promise(r => setTimeout(r, 0)) })

// canon 의 웹 화면 대화 — 사람 말 → Claude 답 + 하는 일 셋(읽음 · 수정 · 허용된 일 npm run build)
const CANON: HistoryItem[] = [
  { t: 1, kind: 'user', source: 'human', parts: [{ type: 'text', text: '헤더 높이 좀 줄여 줘. 모바일에서 너무 두꺼워.' }] },
  {
    t: 2, kind: 'assistant', blocks: [
      { type: 'text', text: '헤더 높이를 72px → 56px 로 줄였어요. 모바일에선 **로고**도 한 단계 작게 했습니다.' },
      { type: 'tool_use', id: 'a', name: 'Read', input: { file_path: 'C:\\w\\src\\Header.tsx' } },
      { type: 'tool_use', id: 'b', name: 'Edit', input: { file_path: 'C:\\w\\src\\Header.tsx' } },
      { type: 'tool_use', id: 'c', name: 'Bash', input: { command: 'npm run build' } },
    ],
  },
  { t: 3, kind: 'tool-result', toolUseId: 'a', isError: false, text: 'export function Header() {}', viaApproval: false },
  { t: 4, kind: 'tool-result', toolUseId: 'b', isError: false, text: 'ok', viaApproval: true },
  { t: 5, kind: 'tool-result', toolUseId: 'c', isError: false, text: 'built in 1.2s', viaApproval: false },
  { t: 6, kind: 'result', ok: true, subtype: 'success' },
]

beforeEach(() => {
  vi.resetModules()
  handlers = {}
  snapshot = {
    claudeMissing: false, rooms: [{ id: 'r1', name: '여름 캠페인', createdAt: 1 }],
    agents: [agent('w', { name: '웹 화면', role: '화면 구현' }), agent('p', { name: '기획', role: '기획서 · 문구' })],
    messages: [], requests: [], autoChainLimit: 3,
  }
  history = vi.fn(async (_id: string) => CANON)
  ;(window as any).dure = {
    snapshot: async () => snapshot,
    history: (id: string) => history(id),
    describe: async () => ({ commands: [], models: [], permissionMode: 'default' }),
    sendUser: async () => {},
    on: (k: string, fn: (p: any) => void) => {
      ;(handlers[k] ??= []).push(fn)
      return () => {}
    },
  }
})
afterEach(() => cleanup())

async function renderPanel(select = 'w') {
  const { getStore } = await import('../../src/renderer/state/store')
  const { AgentPanel } = await import('../../src/renderer/panel/AgentPanel')
  await act(async () => { await getStore().init() })
  const r = render(<AgentPanel />)
  await act(async () => { getStore().selectAgent(select) })
  await settle()
  return { ...r, store: getStore() }
}

const conv = () => screen.getByRole('region', { name: '대화' })

describe('ChatList — 줄마다', () => {
  it('사람 말은 오른쪽 말풍선, Claude 답은 이름 + 마크다운', async () => {
    await renderPanel()
    const me = conv().querySelector('.me')!
    expect(me).toHaveTextContent('헤더 높이 좀 줄여 줘. 모바일에서 너무 두꺼워.')
    const claude = conv().querySelector('.ci-claude')!
    expect(within(claude as HTMLElement).getByText('Claude')).toHaveClass('who')
    expect(claude.querySelector('.md strong')).toHaveTextContent('로고')
  })

  it('하는 일은 접힌 한 줄 — 아이콘·mono 이름·동사, 승인 없이 된 일만 "허용된 일"', async () => {
    await renderPanel()
    const rows = within(conv()).getAllByRole('button', { name: /읽음|수정|실행/ })
    expect(rows.map(r => r.textContent)).toEqual(['Header.tsx읽음', 'Header.tsx수정', '허용된 일npm run build실행'])
    expect(rows.every(r => r.getAttribute('aria-expanded') === 'false')).toBe(true)
    expect(rows[2].querySelector('.f')).toHaveTextContent('npm run build')
    expect(rows[2].querySelector('.k')).toHaveTextContent('허용된 일')
  })

  it('누르면 출력이 펼쳐진다 — 다시 누르면 접힌다', async () => {
    await renderPanel()
    const row = within(conv()).getByRole('button', { name: /실행/ })
    fireEvent.click(row)
    expect(row).toHaveAttribute('aria-expanded', 'true')
    expect(within(conv()).getByText('built in 1.2s')).toBeInTheDocument()
    fireEvent.click(row)
    expect(within(conv()).queryByText('built in 1.2s')).toBeNull()
  })

  it('긴 출력은 앞 2000자 + "전체는 길어서 생략"(Review Focus 1)', async () => {
    history.mockResolvedValueOnce([
      { t: 1, kind: 'assistant', blocks: [{ type: 'tool_use', id: 'x', name: 'Bash', input: { command: 'cat big.log' } }] },
      { t: 2, kind: 'tool-result', toolUseId: 'x', isError: false, text: 'ㄱ'.repeat(5000), viaApproval: true },
    ] satisfies HistoryItem[])
    await renderPanel()
    fireEvent.click(within(conv()).getByRole('button', { name: /실행/ }))
    const out = conv().querySelector('.act-out pre')!
    expect(out.textContent).toHaveLength(2000)
    expect(within(conv()).getByText('전체는 길어서 생략')).toBeInTheDocument()
  })

  it('짧은 출력엔 생략 문구가 없다', async () => {
    await renderPanel()
    fireEvent.click(within(conv()).getByRole('button', { name: /읽음/ }))
    expect(within(conv()).queryByText('전체는 길어서 생략')).toBeNull()
  })

  it('거절된 일은 회색 줄그음', async () => {
    const { DENY } = await import('../../src/shared/denyTexts')
    history.mockResolvedValueOnce([
      { t: 1, kind: 'assistant', blocks: [{ type: 'tool_use', id: 'x', name: 'Write', input: { file_path: 'C:\\w\\a.ts' } }] },
      { t: 2, kind: 'tool-result', toolUseId: 'x', isError: true, text: DENY.userDenied, viaApproval: true },
    ] satisfies HistoryItem[])
    await renderPanel()
    const row = within(conv()).getByRole('button', { name: /만듦/ })
    expect(row.closest('li')).toHaveClass('no')
    expect(row.querySelector('.k')).toBeNull()
  })

  it('전달된 메시지는 보낸 이름 꼬리표, 알림은 가운데 작은 줄', async () => {
    history.mockResolvedValueOnce([
      { t: 1, kind: 'user', source: 'relay', parts: [{ type: 'text', text: '[두레 메시지 — 보낸 쪽: 기획(기획서 · 문구)]\n배너 문구를 바꿔 주세요' }] },
      { t: 2, kind: 'notice', text: '멈췄어요' },
    ] satisfies HistoryItem[])
    await renderPanel()
    const relay = conv().querySelector('.ci-relay') as HTMLElement
    expect(within(relay).getByText('기획')).toHaveClass('k')
    expect(relay).toHaveTextContent('배너 문구를 바꿔 주세요')
    expect(conv().querySelector('.me')).toBeNull()
    expect(within(conv()).getByText('멈췄어요')).toHaveClass('note')
  })

  it('이미지가 붙은 내 말은 이미지 수를 함께', async () => {
    history.mockResolvedValueOnce([
      { t: 1, kind: 'user', source: 'human', parts: [{ type: 'image', mediaType: 'image/png', bytes: 1200 }, { type: 'text', text: '이거 봐 줘' }] },
    ] satisfies HistoryItem[])
    await renderPanel()
    expect(conv().querySelector('.me')).toHaveTextContent('이미지 1개')
  })

  it('흐르는 글은 맨 끝에 깜빡이는 커서와 함께 — 기록 항목이 오면 사라진다', async () => {
    await renderPanel()
    await emit('agent-event', { agentId: 'w', event: { kind: 'text-delta', text: '메인 배너 문구를 ' } })
    await emit('agent-event', { agentId: 'w', event: { kind: 'text-delta', text: '바꾸는 중이에요…' } })
    const live = conv().querySelector('.ci-live') as HTMLElement
    expect(live).toHaveTextContent('메인 배너 문구를 바꾸는 중이에요…')
    expect(live.querySelector('.caret')).not.toBeNull()
    expect(conv().lastElementChild).toBe(live)
    await emit('history', { agentId: 'w', item: { t: 9, kind: 'assistant', blocks: [{ type: 'text', text: '메인 배너 문구를 바꿨어요' }] } })
    expect(conv().querySelector('.ci-live')).toBeNull()
    expect(conv()).toHaveTextContent('메인 배너 문구를 바꿨어요')
  })
})

describe('ChatList — 아주 긴 대화(Review Focus 1)', () => {
  const many = (n: number): HistoryItem[] =>
    Array.from({ length: n }, (_, i) => ({ t: i, kind: 'notice' as const, text: `알림 ${i}` }))

  it('1000항목 → 최근 300줄만 + "이전 대화 700개 더 보기"', async () => {
    history.mockResolvedValueOnce(many(1000))
    await renderPanel()
    expect(conv().querySelectorAll('.note')).toHaveLength(300)
    expect(within(conv()).getByText('알림 999')).toBeInTheDocument()
    expect(within(conv()).queryByText('알림 699')).toBeNull()
    const more = within(conv()).getByRole('button', { name: '이전 대화 700개 더 보기' })
    fireEvent.click(more)
    expect(conv().querySelectorAll('.note')).toHaveLength(600)
    expect(within(conv()).getByRole('button', { name: '이전 대화 400개 더 보기' })).toBeInTheDocument()
  })

  it('300줄 이하면 더 보기가 없다', async () => {
    history.mockResolvedValueOnce(many(300))
    await renderPanel()
    expect(within(conv()).queryByRole('button', { name: /이전 대화/ })).toBeNull()
  })
})

describe('ChatList — 불러오기', () => {
  it('불러오는 동안 조용한 한 줄', async () => {
    history.mockReturnValueOnce(new Promise(() => {}))
    await renderPanel()
    expect(within(conv()).getByText('대화를 불러오는 중…')).toBeInTheDocument()
  })

  it('실패하면 안내 + 다시 시도(다시 불러온다)', async () => {
    history.mockRejectedValueOnce(new Error('읽을 수 없어요'))
    await renderPanel()
    expect(within(conv()).getByText('대화를 불러오지 못했어요')).toBeInTheDocument()
    fireEvent.click(within(conv()).getByRole('button', { name: '다시 시도' }))
    await settle()
    expect(history).toHaveBeenCalledTimes(2)
    expect(conv().querySelector('.me')).not.toBeNull()
  })
})

describe('ChatList — 따라 내려가기', () => {
  /** jsdom 은 배치를 하지 않는다 — 스크롤 크기를 정해 준다 */
  function fakeScroll(el: HTMLElement, o: { scrollHeight: number; clientHeight: number }) {
    Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => o.scrollHeight })
    Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => o.clientHeight })
  }
  const item = (t: number): HistoryItem => ({ t, kind: 'notice', text: `새 알림 ${t}` })

  it('맨 아래에 붙어 있으면 새 줄을 따라 내려간다', async () => {
    await renderPanel()
    const el = conv()
    const size = { scrollHeight: 1000, clientHeight: 400 }
    fakeScroll(el, size)
    el.scrollTop = 600
    fireEvent.scroll(el)
    size.scrollHeight = 1200
    await emit('history', { agentId: 'w', item: item(10) })
    expect(el.scrollTop).toBe(1200)
  })

  it('위로 올려 읽는 중이면 그대로 둔다', async () => {
    await renderPanel()
    const el = conv()
    const size = { scrollHeight: 1000, clientHeight: 400 }
    fakeScroll(el, size)
    el.scrollTop = 100
    fireEvent.scroll(el)
    size.scrollHeight = 1200
    await emit('history', { agentId: 'w', item: item(10) })
    expect(el.scrollTop).toBe(100)
    await emit('agent-event', { agentId: 'w', event: { kind: 'text-delta', text: '쓰는 중' } })
    expect(el.scrollTop).toBe(100)
  })

  describe('대화 칸이 줄 때(창 크기 · 위에 카드가 생김)', () => {
    let observed: { cb: ResizeObserverCallback; targets: Element[] }[]
    beforeEach(() => {
      observed = []
      vi.stubGlobal(
        'ResizeObserver',
        class {
          private entry: { cb: ResizeObserverCallback; targets: Element[] }
          constructor(cb: ResizeObserverCallback) {
            this.entry = { cb, targets: [] }
            observed.push(this.entry)
          }
          observe(el: Element) {
            this.entry.targets.push(el)
          }
          unobserve() {}
          disconnect() {
            this.entry.targets = []
          }
        },
      )
    })
    afterEach(() => vi.unstubAllGlobals())
    /** el 을 지켜보는 ResizeObserver 들에 크기가 바뀌었다고 알린다 */
    const resized = (el: Element) =>
      act(() => {
        for (const o of observed) if (o.targets.includes(el)) o.cb([], {} as ResizeObserver)
      })

    it('맨 아래에 붙어 있었으면 바닥을 지킨다 — 마지막 줄이 칸 밑으로 숨지 않게', async () => {
      await renderPanel()
      const el = conv()
      const size = { scrollHeight: 1000, clientHeight: 400 }
      fakeScroll(el, size)
      el.scrollTop = 600
      fireEvent.scroll(el)
      size.clientHeight = 300
      await resized(el)
      expect(el.scrollTop).toBe(1000)
    })

    it('위로 올려 읽는 중이면 그대로 둔다', async () => {
      await renderPanel()
      const el = conv()
      const size = { scrollHeight: 1000, clientHeight: 400 }
      fakeScroll(el, size)
      el.scrollTop = 100
      fireEvent.scroll(el)
      size.clientHeight = 300
      await resized(el)
      expect(el.scrollTop).toBe(100)
    })
  })
})
