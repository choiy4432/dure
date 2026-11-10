import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { render, screen, act, fireEvent, cleanup, within } from '@testing-library/react'
import type { EngineEventMap, HistoryItem } from '../../src/engine/types'
import type { AgentView, Snapshot } from '../../src/shared/ipcContract'

const agent = (id: string, over: Partial<AgentView> = {}): AgentView => ({
  id, roomId: 'r1', name: id, role: '역할', folder: 'C:\\w', sessionId: 's', started: true, auto: false, model: null,
  alwaysAllow: [], pos: { x: 64, y: 64 }, color: null, effort: null, lastContext: null, bypassOn: false, effortNow: null, modelNow: null, status: 'idle', errorText: null, bypass: false, bypassBySettings: false, bypassPending: false, heldInput: 0, planMode: false, asleep: false, waking: false, hold: null, subagentsRunning: [], pastCount: 0, remoteIssue: null, ...over,
})

let snapshot: Snapshot
let handlers: Record<string, ((p: any) => void)[]>
let history: Mock<(id: string, o?: { before?: number; limit?: number }) => Promise<HistoryItem[]>>

const emit = <K extends keyof EngineEventMap>(k: K, p: EngineEventMap[K]) => act(() => (handlers[k] ?? []).forEach(f => f(p)))
const frames = () => act(async () => { await new Promise(r => setTimeout(r, 60)) })
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
    messages: [], requests: [], autoChainLimit: 3, allowBypass: false, notify: { asks: true, finished: false }, sleepAfterMin: 30, usage: null,
  }
  history = vi.fn(async (_id: string) => CANON)
  ;(window as any).dure = {
    snapshot: async () => snapshot,
    history: (id: string, o?: { before?: number; limit?: number }) => (o === undefined ? history(id) : history(id, o)),
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

  it('전달된 메시지는 "기획에게서 온 메시지" 한 마디(이름만 굵게, 이름과 조사 사이 나눔 없음), 알림은 가운데 작은 줄', async () => {
    history.mockResolvedValueOnce([
      { t: 1, kind: 'user', source: 'relay', parts: [{ type: 'text', text: '[두레 메시지 — 보낸 쪽: 기획(기획서 · 문구)]\n배너 문구를 바꿔 주세요' }] },
      { t: 2, kind: 'notice', text: '멈췄어요' },
    ] satisfies HistoryItem[])
    await renderPanel()
    const relay = conv().querySelector('.ci-relay') as HTMLElement
    const name = within(relay).getByText('기획')
    expect(name.tagName).toBe('B')
    expect(name).not.toHaveClass('k') // 테두리 꼬리표가 아니다
    expect(relay.querySelector('.k')).toBeNull()
    // 이름과 '에게서 온 메시지' 가 한 덩어리 — 머리 줄(.who, 칸 사이 간격이 있는 줄)의 칸이 하나뿐
    expect(name.parentElement!.textContent).toBe('기획에게서 온 메시지')
    expect(relay.querySelector('.who')!.children).toHaveLength(1)
    expect(relay).toHaveTextContent('배너 문구를 바꿔 주세요')
    expect(conv().querySelector('.me')).toBeNull()
    expect(within(conv()).getByText('멈췄어요')).toHaveClass('note')
  })

  it('전달된 메시지는 대화에서 늘 다 보인다 — 위에 고정 카드가 없다(메시지 탭에서 본다)', async () => {
    const BODY = '배너 문구를 ‘여름, 같이 걸어요’로 바꿔 주세요.\n\n바꾼 뒤 줄바꿈이 두 줄 안에 들어가는지 확인 부탁해요.'
    const t = Date.now() - 10_000
    snapshot.messages = [{ id: 'm1', roomId: 'r1', from: 'p', to: 'w', text: BODY, createdAt: t - 1000, state: 'delivered', updatedAt: t }]
    history.mockResolvedValueOnce([{
      t: 1, kind: 'user', source: 'relay', messageId: 'm1',
      parts: [{ type: 'text', text: `[두레 메시지 — 보낸 쪽: 기획(기획서 · 문구)]\n${BODY}` }],
    }])
    await renderPanel()
    const relay = conv().querySelector('.ci-relay') as HTMLElement
    expect(relay).toHaveTextContent('기획에게서 온 메시지')
    expect(relay).toHaveTextContent('줄바꿈이 두 줄')
    expect(screen.queryByRole('region', { name: '기획이 보낸 메시지' })).toBeNull()
  })

  it('이미지가 붙은 내 말은 썸네일 — 저장한 그림을 엔진에서 읽어 온다', async () => {
    ;(window as any).dure.image = vi.fn(async () => 'data:image/png;base64,QUJD')
    history.mockResolvedValueOnce([
      { t: 1, kind: 'user', source: 'human', parts: [{ type: 'image', mediaType: 'image/png', bytes: 1200, file: 'f.png' }, { type: 'text', text: '이거 봐 줘' }] },
    ] satisfies HistoryItem[])
    await renderPanel()
    await settle()
    const th = within(conv()).getByRole('button', { name: '이미지 1/1 크게 보기' })
    expect(th.querySelector('img')).toHaveAttribute('src', 'data:image/png;base64,QUJD')
    expect((window as any).dure.image).toHaveBeenCalledWith('w', 'f.png')
    expect(conv().querySelector('.me')).toHaveTextContent('이거 봐 줘')
  })

  it('흐르는 글은 맨 끝에 깜빡이는 커서와 함께 — 기록 항목이 오면 사라진다', async () => {
    await renderPanel()
    await emit('agent-event', { agentId: 'w', event: { kind: 'text-delta', text: '메인 배너 문구를 ' } })
    await emit('agent-event', { agentId: 'w', event: { kind: 'text-delta', text: '바꾸는 중이에요…' } })
    await frames()
    const live = conv().querySelector('.ci-live') as HTMLElement
    expect(live).toHaveTextContent('메인 배너 문구를 바꾸는 중이에요…')
    expect(live.querySelector('.caret')).not.toBeNull()
    expect(conv().lastElementChild).toBe(live)
    await emit('history', { agentId: 'w', item: { t: 9, kind: 'assistant', blocks: [{ type: 'text', text: '메인 배너 문구를 바꿨어요' }] } })
    expect(conv().querySelector('.ci-live')).toBeNull()
    expect(conv()).toHaveTextContent('메인 배너 문구를 바꿨어요')
  })
})

describe('ChatList — 흐르는 글의 마크다운', () => {
  it('쓰는 중에도 굵게·코드가 같은 모양으로, 커서는 그대로', async () => {
    await renderPanel()
    await emit('agent-event', { agentId: 'w', event: { kind: 'text-delta', text: '**굵게** 와 `코드`' } })
    await frames()
    const live = conv().querySelector('.ci-live') as HTMLElement
    expect(live.querySelector('strong')).toHaveTextContent('굵게')
    expect(live.querySelector('code')).toHaveTextContent('코드')
    expect(live.querySelector('.caret')).not.toBeNull()
    expect(live.querySelector('.caret')).toHaveAttribute('aria-hidden', 'true')
    expect(live.querySelector('p .caret')).not.toBeNull()
  })

  it('쓰다 만 목록도 그리고 커서는 마지막 항목 끝에', async () => {
    await renderPanel()
    await emit('agent-event', { agentId: 'w', event: { kind: 'text-delta', text: '- 하나\n- 둘' } })
    await frames()
    const live = conv().querySelector('.ci-live') as HTMLElement
    expect(live.querySelectorAll('li')).toHaveLength(2)
    expect(live.querySelector('li:last-child .caret')).not.toBeNull()
  })

  it('쓰다 만 코드 상자면 커서는 그 상자 마지막 줄 끝에 — 아래 새 문단이 아니다', async () => {
    await renderPanel()
    await emit('agent-event', { agentId: 'w', event: { kind: 'text-delta', text: '```js\nconst a = 1' } })
    await frames()
    const live = conv().querySelector('.ci-live') as HTMLElement
    expect(live.querySelector('pre code .caret')).not.toBeNull()
    expect(live.querySelectorAll('.caret')).toHaveLength(1)
    expect(live.querySelector('pre code .caret')!.previousSibling!.textContent).toBe('const a = 1')
    expect(live.querySelector('.md-code')!.nextElementSibling).toBeNull() // 상자 뒤 새 문단 없음(상자 안 복사 단추는 상자 것)
  })

  it('델타가 빠르게 열 번 와도 마지막까지 다 그린다', async () => {
    await renderPanel()
    for (let i = 0; i < 10; i++) await emit('agent-event', { agentId: 'w', event: { kind: 'text-delta', text: `조각${i} ` } })
    await frames()
    const live = conv().querySelector('.ci-live') as HTMLElement
    expect(live).toHaveTextContent('조각0 조각1 조각2 조각3 조각4 조각5 조각6 조각7 조각8 조각9')
  })

  it('한 장 안에 델타가 열 번 와도 마크다운은 그 장에 한 번만 읽는다 — 마지막 글까지', async () => {
    // 마크다운 읽기(react-markdown 그리기) 횟수를 센다 — 진짜를 그대로 부른다
    const parsed: string[] = []
    vi.doMock('react-markdown', async () => {
      const real = await vi.importActual<typeof import('react-markdown')>('react-markdown')
      const Real = real.default
      const Counted = (props: Parameters<typeof Real>[0]) => {
        parsed.push(String(props.children))
        return <Real {...props} />
      }
      return { ...real, default: Counted }
    })
    try {
      await renderPanel()
      await emit('agent-event', { agentId: 'w', event: { kind: 'text-delta', text: '시작 ' } })
      await frames()
      parsed.length = 0
      // 델타마다 따로 그린다(IPC 사건 하나 = 한 번 그리기) — 장(animation frame)이 오기 전
      for (let i = 0; i < 10; i++) {
        act(() => (handlers['agent-event'] ?? []).forEach(f => f({ agentId: 'w', event: { kind: 'text-delta', text: `조각${i} ` } })))
      }
      expect(parsed).toEqual([])
      await frames()
      const all = '시작 조각0 조각1 조각2 조각3 조각4 조각5 조각6 조각7 조각8 조각9 '
      expect(parsed).toEqual([all])
      expect(conv().querySelector('.ci-live')).toHaveTextContent(all.trim())
    } finally {
      vi.doUnmock('react-markdown')
    }
  })
})

describe('ChatList — 새 대화', () => {
  it('새 대화(boundary)가 오면 앞 대화 줄이 사라진다 — 알림 줄 없이 빈 대화, 그 뒤에 온 것만', async () => {
    await renderPanel()
    expect(conv().querySelector('.me')).not.toBeNull()
    await emit('history', { agentId: 'w', item: { t: 7, kind: 'boundary' } })
    expect(conv().querySelector('.me')).toBeNull()
    expect(conv().querySelector('.ci-claude')).toBeNull()
    expect(conv().querySelector('.note')).toBeNull()
    expect(conv()).not.toHaveTextContent('헤더 높이')
    expect(conv().children).toHaveLength(0)
    await emit('history', { agentId: 'w', item: { t: 8, kind: 'user', source: 'human', parts: [{ type: 'text', text: '새로 시작해요' }] } })
    expect(conv().querySelectorAll('.me')).toHaveLength(1)
    expect(conv().querySelector('.me')).toHaveTextContent('새로 시작해요')
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

describe('ChatList — 이전 대화 더 보기(불러온 것보다 앞 · 시안 ② A)', () => {
  const notes = (from: number, n: number): HistoryItem[] =>
    Array.from({ length: n }, (_, i) => ({ t: from + i, kind: 'notice' as const, text: `알림 ${from + i}` }))
  const older = () => within(conv()).queryByRole('button', { name: '이전 대화 더 보기' })
  /** 앞에 그리지 않은 줄을 다 편다 — 그다음에야 앞 기록을 불러오는 단추 */
  const unfold = () => {
    for (let b = within(conv()).queryByRole('button', { name: /^이전 대화 \d+개 더 보기$/ }); b; b = within(conv()).queryByRole('button', { name: /^이전 대화 \d+개 더 보기$/ })) fireEvent.click(b)
  }
  const note = (n: number) => within(conv()).getByText(`알림 ${n}`)
  afterEach(() => vi.restoreAllMocks())

  it('받은 기록이 500 항목보다 적으면(대화 맨 앞까지 받았다) 없다', async () => {
    history.mockResolvedValueOnce(notes(1000, 499))
    await renderPanel()
    unfold()
    expect(conv().querySelectorAll('.note')).toHaveLength(499)
    expect(older()).toBeNull()
  })

  it('500 항목을 받았으면 그린 줄을 다 편 뒤 맨 위에 — 누르면 history(before: 첫 시각 + 1, limit: 500) 한 번, 같은 시각의 가진 줄은 겹치지 않는다', async () => {
    history.mockResolvedValueOnce(notes(1000, 500))
    await renderPanel()
    expect(older()).toBeNull() // 그리지 않은 앞 줄(이전 대화 200개 더 보기)이 먼저
    unfold()
    const b = older()!
    expect(conv().firstElementChild).toBe(b)
    expect(b.querySelector('svg.lucide-arrow-up')).not.toBeNull()
    // 엔진: t < 1001 인 것 가운데 마지막 500 — 이미 가진 1000 도 덩이 끝에 온다
    history.mockResolvedValueOnce(notes(501, 500))
    await act(async () => { fireEvent.click(b) })
    await settle()
    expect(history).toHaveBeenCalledTimes(2)
    expect(history).toHaveBeenLastCalledWith('w', { before: 1001, limit: 500 })
    expect(conv().querySelectorAll('.note')).toHaveLength(999)
    expect(within(conv()).getAllByText('알림 1000')).toHaveLength(1)
    expect(conv().querySelector('.note')).toHaveTextContent('알림 501')
    expect(older()).not.toBeNull() // 덩이가 꽉 찼다 — 그 앞이 더 있을 수 있다
  })

  it('맨 앞까지 오면(받은 덩이가 500 보다 적다) 단추가 없다 — 누른 단추에 있던 초점은 맨 위 줄로', async () => {
    history.mockResolvedValueOnce(notes(1000, 500))
    await renderPanel()
    unfold()
    const b = older()!
    b.focus()
    history.mockResolvedValueOnce(notes(900, 101))
    await act(async () => { fireEvent.click(b) })
    await settle()
    expect(older()).toBeNull()
    expect(conv().querySelectorAll('.note')).toHaveLength(600)
    expect(document.activeElement).toBe(note(900))
  })

  it('빈 덩이가 와도(500 의 배수라 앞이 없다) 단추가 사라지며 초점이 몸통으로 떨어지지 않고 맨 위 줄로', async () => {
    history.mockResolvedValueOnce(notes(1000, 500))
    await renderPanel()
    unfold()
    const b = older()!
    b.focus()
    expect(document.activeElement).toBe(b)
    history.mockResolvedValueOnce([])
    await act(async () => { fireEvent.click(b) })
    await settle()
    expect(older()).toBeNull()
    expect(conv().querySelectorAll('.note')).toHaveLength(500)
    expect(document.activeElement).toBe(note(1000))
  })

  it('빈 덩이여도 초점이 단추에 없었으면 초점을 훔치지 않는다', async () => {
    history.mockResolvedValueOnce(notes(1000, 500))
    await renderPanel()
    unfold()
    const box = screen.getByRole('textbox', { name: '웹 화면에게 보낼 메시지' })
    history.mockResolvedValueOnce([])
    await act(async () => { fireEvent.click(older()!) })
    box.focus()
    await settle()
    expect(document.activeElement).toBe(box)
  })

  it('이미 그린 줄은 번호(key · data-line)가 그대로 — 다시 그리지 않고, 앞에 붙은 줄은 그 앞 번호', async () => {
    history.mockResolvedValueOnce(notes(1000, 500))
    await renderPanel()
    unfold()
    const first = note(1000)
    expect(first.dataset.line).toBe('0')
    history.mockResolvedValueOnce(notes(900, 101))
    await act(async () => { fireEvent.click(older()!) })
    await settle()
    expect(note(1000)).toBe(first)
    expect(first.dataset.line).toBe('0')
    expect(note(900).dataset.line).toBe('-100')
  })

  it('스크롤 자리 유지 — 앞에 줄이 붙어도 보던 줄이 그 자리에 그대로', async () => {
    history.mockResolvedValueOnce(notes(1000, 500))
    await renderPanel()
    unfold()
    const el = conv()
    // jsdom 은 배치를 하지 않는다 — 대화 칸 맨 위는 0, 칸 안 요소는 차례대로 20px 씩
    const ROW = 20
    Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => el.children.length * ROW })
    Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => 400 })
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const i = this.parentElement === el ? Array.prototype.indexOf.call(el.children, this) : -1
      const top = i >= 0 ? i * ROW - el.scrollTop : 0
      const height = this === el ? 400 : ROW
      return { top, bottom: top + height, left: 0, right: 0, width: 0, height, x: 0, y: top, toJSON: () => ({}) } as DOMRect
    })
    el.scrollTop = 30
    fireEvent.scroll(el)
    const seen = note(1000) // 맨 위에 걸친 줄 — 위 10px 이 칸 밖
    expect(seen.getBoundingClientRect().top).toBe(-10)
    history.mockResolvedValueOnce(notes(501, 500))
    await act(async () => { fireEvent.click(older()!) })
    await settle()
    expect(seen.getBoundingClientRect().top).toBe(-10)
    expect(el.scrollTop).toBe(30 + 499 * ROW)
  })

  it('불러오는 동안 다시 눌러도 한 번만 · 실패하면 "다시 시도" — 다시 누르면 다시 부른다', async () => {
    history.mockResolvedValueOnce(notes(1000, 500))
    await renderPanel()
    unfold()
    let fail!: (e: Error) => void
    history.mockReturnValueOnce(new Promise<HistoryItem[]>((_, reject) => { fail = reject }))
    fireEvent.click(older()!)
    const busy = within(conv()).getByRole('button', { name: '이전 대화를 불러오는 중…' })
    expect(busy).toHaveAttribute('aria-disabled', 'true')
    fireEvent.click(busy)
    expect(history).toHaveBeenCalledTimes(2)
    await act(async () => { fail(new Error('읽을 수 없어요')) })
    await settle()
    expect(document.querySelector('.conv-wrap [role="status"]')).toHaveTextContent('이전 대화를 불러오지 못했어요')
    const retry = within(conv()).getByRole('button', { name: '이전 대화를 불러오지 못했어요 · 다시 시도' })
    expect(retry).toBe(busy) // 같은 단추 — 초점이 그대로
    history.mockResolvedValueOnce(notes(900, 101))
    await act(async () => { fireEvent.click(retry) })
    await settle()
    expect(history).toHaveBeenCalledTimes(3)
    expect(conv().querySelectorAll('.note')).toHaveLength(600)
  })

  it('새 대화(경계)가 오면 앞 기록은 없다', async () => {
    history.mockResolvedValueOnce(notes(1000, 500))
    await renderPanel()
    unfold()
    expect(older()).not.toBeNull()
    await emit('history', { agentId: 'w', item: { t: 2000, kind: 'boundary' } })
    expect(older()).toBeNull()
  })
})

describe('ChatList — 새 글 알약(시안 ② A)', () => {
  function fakeScroll(el: HTMLElement, o: { scrollHeight: number; clientHeight: number }) {
    Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => o.scrollHeight })
    Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => o.clientHeight })
  }
  const pill = () => screen.queryByRole('button', { name: /^새 글/ })
  const note = (t: number): HistoryItem => ({ t, kind: 'notice', text: `새 알림 ${t}` })
  /** 위로 올려 읽는 중(바닥에서 벗어남) */
  async function readUp() {
    const r = await renderPanel()
    const el = conv()
    const size = { scrollHeight: 1000, clientHeight: 400 }
    fakeScroll(el, size)
    el.scrollTop = 100
    fireEvent.scroll(el)
    return { ...r, el, size }
  }

  it('맨 아래에 붙어 있으면 새 줄이 와도 없다', async () => {
    await renderPanel()
    const el = conv()
    fakeScroll(el, { scrollHeight: 1000, clientHeight: 400 })
    el.scrollTop = 600
    fireEvent.scroll(el)
    await emit('history', { agentId: 'w', item: note(10) })
    expect(pill()).toBeNull()
  })

  it('위로 올려 읽는 중 새 줄이 오면 대화 칸 아래 가운데 "↓ 새 글 N개" — 누르면 맨 아래로, 알약은 사라지고 커서는 입력창', async () => {
    const { el, size } = await readUp()
    expect(pill()).toBeNull()
    await emit('history', { agentId: 'w', item: note(10) })
    expect(pill()).toHaveAccessibleName('새 글 1개')
    expect(pill()!.querySelector('svg.lucide-arrow-down')).not.toBeNull()
    expect(pill()!.closest('.conv-wrap')).not.toBeNull()
    expect(el.contains(pill())).toBe(false) // 글과 함께 스크롤되지 않는다
    await emit('history', { agentId: 'w', item: note(11) })
    expect(pill()).toHaveAccessibleName('새 글 2개')
    expect(el.scrollTop).toBe(100) // 따라 내려가지 않는다
    size.scrollHeight = 1200
    fireEvent.click(pill()!)
    expect(el.scrollTop).toBe(1200)
    expect(pill()).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: '웹 화면에게 보낼 메시지' }))
    await emit('history', { agentId: 'w', item: note(12) })
    expect(pill()).toBeNull() // 다시 바닥에 붙었다
  })

  it('바닥까지 스크롤하면 사라진다', async () => {
    const { el } = await readUp()
    await emit('history', { agentId: 'w', item: note(10) })
    expect(pill()).not.toBeNull()
    el.scrollTop = 600
    fireEvent.scroll(el)
    expect(pill()).toBeNull()
  })

  it('Claude 답이 흐르기 시작해도 1 — 다 흘러 줄이 되어도 1(두 번 세지 않는다)', async () => {
    await readUp()
    await emit('agent-event', { agentId: 'w', event: { kind: 'text-delta', text: '새 답을 쓰는 중' } })
    expect(pill()).toHaveAccessibleName('새 글 1개')
    await emit('history', { agentId: 'w', item: { t: 10, kind: 'assistant', blocks: [{ type: 'text', text: '새 답을 쓰는 중이에요.' }] } })
    expect(pill()).toHaveAccessibleName('새 글 1개')
  })

  it('읽던 차례의 Claude 답이 이어 자라도(같은 줄) 1 — 흐르는 글이 또 와도 1', async () => {
    history.mockResolvedValueOnce(CANON.slice(0, 5)) // 차례가 아직 안 끝났다
    await readUp()
    await emit('history', { agentId: 'w', item: { t: 10, kind: 'assistant', blocks: [{ type: 'text', text: '이어서 테스트도 돌렸어요.' }] } })
    expect(pill()).toHaveAccessibleName('새 글 1개')
    await emit('agent-event', { agentId: 'w', event: { kind: 'text-delta', text: '하나 더' } })
    expect(pill()).toHaveAccessibleName('새 글 1개')
    await emit('history', { agentId: 'w', item: { t: 11, kind: 'assistant', blocks: [{ type: 'text', text: '하나 더 고쳤어요.' }] } })
    expect(pill()).toHaveAccessibleName('새 글 1개')
  })

  it('받은 메시지 뒤에 Claude 답이 흐르면 2 — 다 흘러도 2', async () => {
    await readUp()
    await emit('history', { agentId: 'w', item: { t: 10, kind: 'user', source: 'relay', parts: [{ type: 'text', text: '[두레 메시지 — 보낸 쪽: 기획(기획서 · 문구)]\n배너 문구 바꿔 주세요' }] } })
    expect(pill()).toHaveAccessibleName('새 글 1개')
    await emit('agent-event', { agentId: 'w', event: { kind: 'text-delta', text: '바꿀게요' } })
    expect(pill()).toHaveAccessibleName('새 글 2개')
    await emit('history', { agentId: 'w', item: { t: 11, kind: 'assistant', blocks: [{ type: 'text', text: '바꿀게요.' }] } })
    expect(pill()).toHaveAccessibleName('새 글 2개')
  })

  const sr = () => document.querySelector<HTMLElement>('.conv-wrap [role="status"]')!

  it('알약이 나타날 때 한 번 읽는다 — 새 글이 늘어도 다시 읽지 않고, 사라지면 비운다', async () => {
    const { el } = await readUp()
    expect(sr()).toHaveClass('sr-only')
    expect(sr()).toHaveAttribute('aria-live', 'polite')
    expect(sr()).toHaveTextContent('')
    await emit('history', { agentId: 'w', item: note(10) })
    expect(sr()).toHaveTextContent('새 글 1개')
    await emit('history', { agentId: 'w', item: note(11) })
    expect(pill()).toHaveAccessibleName('새 글 2개')
    expect(sr()).toHaveTextContent('새 글 1개') // 늘어도 그대로 — 다시 읽지 않는다
    el.scrollTop = 600
    fireEvent.scroll(el)
    expect(sr()).toHaveTextContent('')
  })

  it('목록이 통째로 갈려도(새 대화) 위로 읽던 중이면 그 뒤 새 글에 알약이 뜬다', async () => {
    await readUp()
    await emit('history', { agentId: 'w', item: note(10) })
    expect(pill()).not.toBeNull()
    await emit('history', { agentId: 'w', item: { t: 20, kind: 'boundary' } })
    expect(pill()).toBeNull() // 새 목록 — 아직 새 글 없음
    await emit('history', { agentId: 'w', item: note(21) })
    expect(pill()).toHaveAccessibleName('새 글 1개')
  })

  it('내가 보내면 사라진다(맨 아래로 붙는다)', async () => {
    await readUp()
    await emit('history', { agentId: 'w', item: note(10) })
    expect(pill()).not.toBeNull()
    const box = screen.getByRole('textbox', { name: '웹 화면에게 보낼 메시지' })
    fireEvent.change(box, { target: { value: '이것도 해 줘' } })
    fireEvent.keyDown(box, { key: 'Enter' })
    await settle()
    expect(pill()).toBeNull()
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

  it('내가 보내면 위로 올려 읽던 중이어도 맨 아래로 — 내 말이 보이게, 그 뒤 줄도 따라간다', async () => {
    await renderPanel()
    const el = conv()
    const size = { scrollHeight: 1000, clientHeight: 400 }
    fakeScroll(el, size)
    el.scrollTop = 100
    fireEvent.scroll(el)
    const box = screen.getByRole('textbox', { name: '웹 화면에게 보낼 메시지' })
    fireEvent.change(box, { target: { value: '이것도 해 줘' } })
    fireEvent.keyDown(box, { key: 'Enter' })
    await settle()
    expect(el.scrollTop).toBe(1000)
    size.scrollHeight = 1200
    await emit('history', { agentId: 'w', item: { t: 20, kind: 'user', source: 'human', parts: [{ type: 'text', text: '이것도 해 줘' }] } })
    expect(el.scrollTop).toBe(1200)
  })

  it('못 보내면 읽던 자리 그대로', async () => {
    ;(window as any).dure.sendUser = async () => { throw new Error('보내지 못했어요') }
    await renderPanel()
    const el = conv()
    fakeScroll(el, { scrollHeight: 1000, clientHeight: 400 })
    el.scrollTop = 100
    fireEvent.scroll(el)
    const box = screen.getByRole('textbox', { name: '웹 화면에게 보낼 메시지' })
    fireEvent.change(box, { target: { value: '이것도 해 줘' } })
    fireEvent.keyDown(box, { key: 'Enter' })
    await settle()
    expect(screen.getByRole('alert')).toHaveTextContent('보내지 못했어요')
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

describe('ChatList — 작업 중 줄(Claude Code 의 작업 중 표시처럼)', () => {
  afterEach(() => vi.useRealTimers())
  const working = () => conv().querySelector('.ci-work')

  it('일하는 동안 대화 맨 아래에 "작업 중…"과 지난 시간 — 1초마다 늘어난다', async () => {
    await renderPanel()
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
    vi.setSystemTime(100_000)
    await emit('status', { agentId: 'w', status: 'working', errorText: null })
    const row = working()!
    expect(row).toHaveAttribute('role', 'status')
    expect(row).toHaveTextContent('작업 중…')
    expect(row).toHaveTextContent('0초')
    expect(conv().lastElementChild).toBe(row)
    act(() => { vi.advanceTimersByTime(12_000) })
    expect(working()).toHaveTextContent('12초')
  })

  it('흐르는 글이 있어도 그 아래, 맨 끝', async () => {
    await renderPanel()
    await emit('status', { agentId: 'w', status: 'working', errorText: null })
    await emit('agent-event', { agentId: 'w', event: { kind: 'text-delta', text: '쓰는 중' } })
    expect(conv().lastElementChild).toBe(working())
    expect(working()!.previousElementSibling).toHaveClass('ci-live')
  })

  it('일이 끝나면 사라진다', async () => {
    await renderPanel()
    await emit('status', { agentId: 'w', status: 'working', errorText: null })
    expect(working()).not.toBeNull()
    await emit('status', { agentId: 'w', status: 'idle', errorText: null })
    expect(working()).toBeNull()
  })

  it('승인을 기다리는 동안엔 없다 — 승인 카드가 대신 알린다', async () => {
    await renderPanel()
    await emit('status', { agentId: 'w', status: 'awaiting', errorText: null })
    expect(working()).toBeNull()
  })

  it('앱을 열 때 이미 일하던 중이면 시간 없이 "작업 중…"만(언제 시작했는지 모른다)', async () => {
    snapshot.agents[0] = agent('w', { name: '웹 화면', role: '화면 구현', status: 'working' })
    await renderPanel()
    expect(working()).toHaveTextContent('작업 중…')
    expect(working()!.querySelector('.wk-time')).toBeNull()
  })

  it('다른 에이전트가 일하는 건 이 대화에 뜨지 않는다', async () => {
    await renderPanel('w')
    await emit('status', { agentId: 'p', status: 'working', errorText: null })
    expect(working()).toBeNull()
  })

  it('도는 서브에이전트가 있으면 "작업 중…" 뒤에 "서브에이전트 2개가 일하고 있어요" — 다 끝나면 빠진다', async () => {
    await renderPanel()
    await emit('status', { agentId: 'w', status: 'working', errorText: null })
    expect(working()).not.toHaveTextContent('서브에이전트')
    await emit('subagents', { agentId: 'w', running: ['A', 'B'] })
    const sub = within(working() as HTMLElement).getByText('서브에이전트 2개가 일하고 있어요')
    expect(working()!.querySelector('.wk-t')!.nextElementSibling).toBe(sub)
    await emit('subagents', { agentId: 'w', running: ['B'] })
    expect(working()).toHaveTextContent('서브에이전트 1개가 일하고 있어요')
    await emit('subagents', { agentId: 'w', running: [] })
    expect(working()).toHaveTextContent('작업 중…')
    expect(working()).not.toHaveTextContent('서브에이전트')
  })

  const think = (active: boolean, tokens: number | null = null) =>
    emit('agent-event', { agentId: 'w', event: { kind: 'thinking', active, tokens } })

  it('Claude 가 생각하는 동안 "생각하는 중…" — 그 뒤 지난 시간, 그 뒤 "약 278 토큰"(수를 알 때만). 글이 오면 "작업 중…"', async () => {
    await renderPanel()
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
    vi.setSystemTime(100_000)
    await emit('status', { agentId: 'w', status: 'working', errorText: null })
    await think(true)
    const row = working()!
    expect(row.querySelector('.wk-t')).toHaveTextContent('생각하는 중…')
    expect(row).not.toHaveTextContent('작업 중…')
    expect(row).not.toHaveTextContent('토큰') // 아직 모른다
    await think(true, 278)
    const tok = within(working() as HTMLElement).getByText('약 278 토큰')
    // 차례: 생각하는 중… → 지난 시간 → 토큰 수. 1초마다·몇 번씩 바뀌는 수라 화면 읽기 프로그램은 읽지 않는다
    expect(working()!.querySelector('.wk-time')!.nextElementSibling).toBe(tok)
    expect(tok).toHaveAttribute('aria-hidden', 'true')
    await think(true, 12_345)
    expect(working()).toHaveTextContent('약 1.2만 토큰')
    act(() => { vi.advanceTimersByTime(3_000) })
    expect(working()).toHaveTextContent('3초')
    await emit('agent-event', { agentId: 'w', event: { kind: 'text-delta', text: '답을 쓰는 중' } })
    expect(working()!.querySelector('.wk-t')).toHaveTextContent('작업 중…')
    expect(working()).not.toHaveTextContent('토큰')
  })

  const apiStatus = (status: 'requesting' | 'compacting' | null) => emit('agent-event', { agentId: 'w', event: { kind: 'api-status', status } })

  it('단계: 보내면 "준비하는 중…"(아직 보내기 전이라는 풀이) → 요청이 나가면 "Claude 답 받는 중…" → 생각 → 글이면 "작업 중…"', async () => {
    await renderPanel()
    await emit('history', { agentId: 'w', item: { t: 5, kind: 'user', source: 'human', parts: [{ type: 'text', text: '해 줘' }] } })
    await emit('status', { agentId: 'w', status: 'working', errorText: null })
    const label = () => working()!.querySelector('.wk-t')!
    expect(label()).toHaveTextContent('준비하는 중…')
    expect(label()).toHaveAttribute('title', '아직 Claude에게 질문을 보내기 전이에요')
    await apiStatus('requesting')
    expect(label()).toHaveTextContent('Claude 답 받는 중…')
    expect(label()).not.toHaveAttribute('title')
    await think(true)
    expect(label()).toHaveTextContent('생각하는 중…')
    await think(false)
    expect(label()).toHaveTextContent('작업 중…')
    await apiStatus('requesting') // 하는 일 뒤 다음 요청
    expect(label()).toHaveTextContent('Claude 답 받는 중…')
    await emit('agent-event', { agentId: 'w', event: { kind: 'text-delta', text: '답' } })
    expect(label()).toHaveTextContent('작업 중…')
  })

  it('단계: 대화를 요약하는 동안 "대화를 정리하는 중…" — 끝나면(null) "작업 중…"', async () => {
    await renderPanel()
    await emit('status', { agentId: 'w', status: 'working', errorText: null })
    await apiStatus('compacting')
    expect(working()!.querySelector('.wk-t')).toHaveTextContent('대화를 정리하는 중…')
    await apiStatus(null)
    expect(working()!.querySelector('.wk-t')).toHaveTextContent('작업 중…')
  })

  it('생각 블록 시작 없이 온 토큰 수(늦게 온 수)는 "생각하는 중…"을 띄우지 않는다 — 생각이 끝난 뒤에도', async () => {
    await renderPanel()
    await emit('status', { agentId: 'w', status: 'working', errorText: null })
    await think(true, 278)
    expect(working()!.querySelector('.wk-t')).toHaveTextContent('작업 중…')
    expect(working()).not.toHaveTextContent('토큰')
    await think(true)
    expect(working()!.querySelector('.wk-t')).toHaveTextContent('생각하는 중…')
    await think(false) // 글 블록 시작 — 생각 끝
    await think(true, 452)
    expect(working()!.querySelector('.wk-t')).toHaveTextContent('작업 중…')
    expect(working()).not.toHaveTextContent('생각하는 중…')
  })

  it('생각하는 중에도 서브에이전트 문구는 그대로 덧붙는다', async () => {
    await renderPanel()
    await emit('status', { agentId: 'w', status: 'working', errorText: null })
    await emit('subagents', { agentId: 'w', running: ['A'] })
    await think(true)
    await think(true, 50)
    const sub = within(working() as HTMLElement).getByText('서브에이전트 1개가 일하고 있어요')
    expect(working()!.querySelector('.wk-t')).toHaveTextContent('생각하는 중…')
    expect(working()!.querySelector('.wk-t')!.nextElementSibling).toBe(sub)
    expect(working()).toHaveTextContent('약 50 토큰')
  })

  it('생각하는 중에 멈추거나 세션이 죽으면 "생각하는 중…"이 남지 않는다 — 다음 차례는 "작업 중…"으로 시작', async () => {
    await renderPanel()
    await emit('status', { agentId: 'w', status: 'working', errorText: null })
    await think(true)
    await think(true, 278)
    expect(working()!.querySelector('.wk-t')).toHaveTextContent('생각하는 중…')
    // 멈추기: 쉬는 상태 → 멈춤 알림 → 끝(진짜 순서 — 세션은 result 를 내기 직전에 쉰다)
    await emit('status', { agentId: 'w', status: 'idle', errorText: null })
    await emit('history', { agentId: 'w', item: { t: 10, kind: 'notice', text: '멈췄어요' } })
    expect(working()).toBeNull()
    await emit('status', { agentId: 'w', status: 'working', errorText: null })
    expect(working()!.querySelector('.wk-t')).toHaveTextContent('작업 중…')
    expect(working()).not.toHaveTextContent('토큰')
    // 세션이 죽음: 오류 상태
    await think(true)
    await think(true, 452)
    expect(working()!.querySelector('.wk-t')).toHaveTextContent('생각하는 중…')
    await emit('status', { agentId: 'w', status: 'error', errorText: 'fake crash' })
    expect(working()).toBeNull()
    await emit('status', { agentId: 'w', status: 'working', errorText: null })
    expect(working()!.querySelector('.wk-t')).toHaveTextContent('작업 중…')
  })

  it('부모 차례가 끝났어도 서브에이전트 때문에 작업 중이면 줄이 보인다', async () => {
    snapshot.agents[0] = agent('w', { name: '웹 화면', role: '화면 구현', status: 'working', subagentsRunning: ['A'] })
    history.mockResolvedValueOnce([
      { t: 1, kind: 'user', source: 'human', parts: [{ type: 'text', text: '조사해 줘' }] },
      { t: 2, kind: 'assistant', blocks: [{ type: 'tool_use', id: 'A', name: 'Agent', input: { description: '조사', prompt: 'p' } }] },
      { t: 3, kind: 'subagent-start', toolUseId: 'A', taskId: 'task-A', description: '조사', subagentType: null, parentTaskId: null },
      { t: 4, kind: 'result', ok: true, subtype: 'success' },
    ] satisfies HistoryItem[])
    await renderPanel()
    expect(conv().lastElementChild).toBe(working())
    expect(working()).toHaveTextContent('작업 중…')
    expect(working()).toHaveTextContent('서브에이전트 1개가 일하고 있어요')
  })
})

describe('ChatList — 서브에이전트 요약 줄', () => {
  // 한 차례에 셋 — A 도는 중 · B 끝 · C 실패. Claude 내부 안내(Agent 결과)는 어디에도 안 보인다
  const THREE: HistoryItem[] = [
    { t: 1, kind: 'user', source: 'human', parts: [{ type: 'text', text: '세 곳 조사해 줘' }] },
    {
      t: 2, kind: 'assistant', blocks: [
        { type: 'text', text: '나눠서 맡길게요' },
        { type: 'tool_use', id: 'A', name: 'Agent', input: { description: 'A사 조사', prompt: 'p' } },
        { type: 'tool_use', id: 'B', name: 'Agent', input: { description: 'B사 조사', prompt: 'p' } },
        { type: 'tool_use', id: 'C', name: 'Agent', input: { description: 'C사 조사', prompt: 'p' } },
      ],
    },
    ...(['A', 'B', 'C'] as const).flatMap((id): HistoryItem[] => [
      { t: 3, kind: 'subagent-start', toolUseId: id, taskId: `task-${id}`, description: `${id}사 조사`, subagentType: null, parentTaskId: null },
      { t: 4, kind: 'tool-result', toolUseId: id, isError: false, text: 'Async agent launched successfully.', viaApproval: false },
    ]),
    { t: 5, kind: 'subagent-end', toolUseId: 'B', taskId: 'task-B', status: 'completed', summary: 'B 보고', toolUses: 2, durationMs: 1000 },
    { t: 6, kind: 'subagent-end', toolUseId: 'C', taskId: 'task-C', status: 'failed', summary: '못 열었어요', toolUses: 1, durationMs: 1000 },
  ]
  const counts = () => within(conv()).getByRole('button', { name: /서브에이전트 3개에게 맡김/ }).querySelector('[role="img"]')

  it('도는 것은 에이전트의 도는 목록으로 센다 — 끝나면 그 줄이 다시 그려진다', async () => {
    snapshot.agents[0] = agent('w', { name: '웹 화면', role: '화면 구현', subagentsRunning: ['A'] })
    history.mockResolvedValueOnce(THREE)
    await renderPanel()
    expect(counts()).toHaveAccessibleName('도는 중 1, 끝 1, 실패 1')
    expect(conv()).not.toHaveTextContent('Async agent launched')
    expect(within(conv()).queryByRole('button', { name: /A사 조사/ })).toBeNull() // 하나씩 줄이 생기지 않는다
    await emit('history', { agentId: 'w', item: { t: 7, kind: 'subagent-end', toolUseId: 'A', taskId: 'task-A', status: 'completed', summary: 'A 보고', toolUses: 3, durationMs: 1000 } })
    await emit('subagents', { agentId: 'w', running: [] })
    expect(counts()).toHaveAccessibleName('끝 2, 실패 1')
  })

  it('누르면 서브에이전트 탭으로 가 그 요약의 차례를 보인다(showSubagents(에이전트, 첫 Agent id))', async () => {
    snapshot.agents[0] = agent('w', { name: '웹 화면', role: '화면 구현', subagentsRunning: ['A'] })
    history.mockResolvedValueOnce(THREE)
    const { store } = await renderPanel()
    fireEvent.click(within(conv()).getByRole('button', { name: /서브에이전트 3개에게 맡김/ }))
    expect(screen.getByRole('tab', { name: /^서브에이전트/ })).toHaveAttribute('aria-selected', 'true')
    expect(store.getState().subagentFocus).toMatchObject({ agentId: 'w', key: 'A' })
    expect(within(screen.getByRole('tabpanel')).getByRole('group', { name: /세 곳 조사해 줘/ })).toBeInTheDocument()
  })

  it('키보드로 누르면 초점이 그 차례 묶음으로 간다 — 누른 줄이 대화와 함께 숨어도 body 로 떨어지지 않는다', async () => {
    snapshot.agents[0] = agent('w', { name: '웹 화면', role: '화면 구현', subagentsRunning: ['A'] })
    history.mockResolvedValueOnce(THREE)
    await renderPanel()
    const row = within(conv()).getByRole('button', { name: /서브에이전트 3개에게 맡김/ })
    row.focus()
    expect(document.activeElement).toBe(row)
    fireEvent.click(row) // 버튼에서 Enter·Space 는 click 으로 온다(jsdom 은 키를 click 으로 바꾸지 않는다)
    expect(row.closest('[hidden]')).not.toBeNull() // 대화 목록은 그려 둔 채 숨는다(Chromium 은 숨은 줄의 초점을 푼다)
    const turn = within(screen.getByRole('tabpanel')).getByRole('group', { name: /세 곳 조사해 줘/ })
    expect(document.activeElement).toBe(turn)
    expect(turn).toHaveAttribute('tabindex', '-1') // 초점을 받을 수 있지만 Tab 순서에는 없다
  })

  it('끝 기록 없이 도는 목록에서만 빠지면(세션이 죽음) 끊김 — 빨간 묶음으로 다시 그려진다', async () => {
    snapshot.agents[0] = agent('w', { name: '웹 화면', role: '화면 구현', subagentsRunning: ['A'] })
    history.mockResolvedValueOnce([
      { t: 1, kind: 'user', source: 'human', parts: [{ type: 'text', text: '조사해 줘' }] },
      { t: 2, kind: 'assistant', blocks: [{ type: 'tool_use', id: 'A', name: 'Agent', input: { description: 'A사 조사', prompt: 'p' } }] },
      { t: 3, kind: 'subagent-start', toolUseId: 'A', taskId: 'task-A', description: 'A사 조사', subagentType: null, parentTaskId: null },
      { t: 4, kind: 'tool-result', toolUseId: 'A', isError: false, text: 'Async agent launched successfully.', viaApproval: false },
    ] satisfies HistoryItem[])
    await renderPanel()
    const counts = () => within(conv()).getByRole('button', { name: /A사 조사 서브에이전트에게 맡김/ }).querySelector('[role="img"]')
    expect(counts()).toHaveAccessibleName('도는 중 1')
    await emit('subagents', { agentId: 'w', running: [] }) // 끝 기록은 오지 않는다
    expect(counts()).toHaveAccessibleName('실패 1')
    expect(counts()!.querySelector('.dot.g')).toBeNull()
    expect(counts()!.querySelector('.dot.r')).not.toBeNull()
  })
})

describe('ChatList — 명령 출력', () => {
  const COMPACT = 'Compacted PreCompact ["C:/Program Files/nodejs/node.exe" "C:/hooks/monitor.js"] completed successfully'

  it('/compact 결과는 한국어 한 줄 — 영어 원문은 접힌 "자세히" 안에', async () => {
    history = vi.fn(async () => [
      { t: 1, kind: 'user', source: 'human', parts: [{ type: 'text', text: '/compact' }] },
      { t: 2, kind: 'local-output', text: COMPACT },
    ] as HistoryItem[])
    await renderPanel()
    expect(within(conv()).getByText('대화를 요약해서 줄였어요')).toBeInTheDocument()
    expect(within(conv()).queryByText(COMPACT)).toBeNull()
    const more = within(conv()).getByRole('button', { name: '자세히' })
    expect(more).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(more)
    expect(more).toHaveAttribute('aria-expanded', 'true')
    expect(within(conv()).getByText(COMPACT)).toHaveClass('ci-local')
  })

  it('모르는 명령 출력은 원문 그대로, "자세히" 없이', async () => {
    history = vi.fn(async () => [{ t: 1, kind: 'local-output', text: 'Total cost: $0.12' }] as HistoryItem[])
    await renderPanel()
    expect(within(conv()).getByText('Total cost: $0.12')).toHaveClass('ci-local')
    expect(within(conv()).queryByRole('button', { name: '자세히' })).toBeNull()
  })

  describe('긴 메시지는 3줄 + 흐림', () => {
    const LONG = '긴 줄 '.repeat(200)
    beforeEach(() => {
      vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (this: HTMLElement) { return this.classList.contains('clamp-box') ? 300 : 0 })
      vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) { return this.classList.contains('clamp-box') ? 54 : 0 })
    })
    afterEach(() => vi.restoreAllMocks())

    it('받은 메시지는 접힌 상자 안 + 더 보기, 같은 길이의 Claude 답은 접지 않는다', async () => {
      history.mockResolvedValueOnce([
        { t: 1, kind: 'user', source: 'relay', parts: [{ type: 'text', text: `[두레 메시지 — 보낸 쪽: 기획(기획서 · 문구)]
${LONG}` }] },
        { t: 2, kind: 'assistant', blocks: [{ type: 'text', text: LONG }] },
      ] satisfies HistoryItem[])
      await renderPanel()
      const relay = conv().querySelector('.ci-relay') as HTMLElement
      expect(relay.querySelector('.clamp-box')).toHaveClass('clamped')
      expect(relay.querySelector('.clamp-box')).toHaveClass('clamp-md') // 문단 사이 여백만큼 더(접기 기준)
      expect(within(relay).getByRole('button', { name: '더 보기' })).toBeInTheDocument()
      const claude = conv().querySelector('.ci-claude') as HTMLElement
      expect(claude.querySelector('.clamp')).toBeNull()
    })

    it('열어 본 하는 일 출력과 모르는 명령 출력도 접힌다', async () => {
      history.mockResolvedValueOnce([
        { t: 1, kind: 'assistant', blocks: [{ type: 'tool_use', id: 'x', name: 'Bash', input: { command: 'cat big.log' } }] },
        { t: 2, kind: 'tool-result', toolUseId: 'x', isError: false, text: LONG, viaApproval: true },
        { t: 3, kind: 'local-output', text: LONG },
      ] satisfies HistoryItem[])
      await renderPanel()
      expect(conv().querySelector('.ci-local')!.closest('.clamp-box')).toHaveClass('clamped')
      fireEvent.click(within(conv()).getByRole('button', { name: /실행/ }))
      expect(conv().querySelector('.act-out pre')!.closest('.clamp-box')).toHaveClass('clamped')
      expect(conv().querySelectorAll('.clamp-box.clamp-md')).toHaveLength(0) // 고정폭 출력엔 문단 여백이 없다
    })
  })
})

describe('ChatList — 위 고정(지금 보는 차례를 연 말)', () => {
  const TWO: HistoryItem[] = [
    { t: 1, kind: 'user', source: 'human', parts: [{ type: 'text', text: '헤더 높이 줄여 줘.' }] },
    { t: 2, kind: 'assistant', blocks: [{ type: 'text', text: '줄였어요.' }] },
    { t: 3, kind: 'result', ok: true, subtype: 'success' },
    { t: 4, kind: 'user', source: 'human', parts: [{ type: 'text', text: '쿠폰 칸도\n같이 넣어 줘.' }] },
    { t: 5, kind: 'assistant', blocks: [{ type: 'text', text: '긴 답이에요.' }] },
    { t: 6, kind: 'result', ok: true, subtype: 'success' },
  ]
  /** jsdom 은 배치를 하지 않는다 — 대화 칸 맨 위는 100, 차례를 연 줄들의 자리를 정해 준다 */
  function place(el: HTMLElement, spots: [number, number][]) {
    Object.defineProperty(el, 'getBoundingClientRect', { configurable: true, value: () => ({ top: 100, bottom: 500 }) })
    el.querySelectorAll<HTMLElement>('.me, .ci-relay').forEach((n, i) => {
      const [top, bottom] = spots[i]
      Object.defineProperty(n, 'getBoundingClientRect', { configurable: true, value: () => ({ top, bottom }) })
    })
  }
  const stuck = () => screen.queryByRole('button', { name: /로 가기/ })

  it('차례를 연 내 말이 화면 위로 다 지나가면 위에 한 줄로 고정되고, 누르면 그 말로 간다', async () => {
    history.mockResolvedValue(TWO)
    await renderPanel()
    const el = conv()
    const to = vi.fn()
    ;(el as any).scrollTo = to
    el.scrollTop = 800
    place(el, [[-500, -460], [-120, -80]])
    fireEvent.scroll(el)
    const b = stuck()
    expect(b).not.toBeNull()
    expect(b).toHaveAccessibleName('내 메시지로 가기 — 쿠폰 칸도 같이 넣어 줘.')
    expect(b).toHaveTextContent('쿠폰 칸도 같이 넣어 줘.')
    fireEvent.click(b!)
    expect(to).toHaveBeenCalledWith({ top: 800 + -120 - 100, behavior: 'auto' })
    expect(document.activeElement).toBe(el.querySelectorAll('.me')[1])
  })

  it('그 말이 조금이라도 보이거나 대화 맨 위면 없다', async () => {
    history.mockResolvedValue(TWO)
    await renderPanel()
    const el = conv()
    place(el, [[-500, -460], [60, 110]])
    fireEvent.scroll(el)
    expect(stuck()).toBeNull()
    place(el, [[120, 160], [400, 440]])
    fireEvent.scroll(el)
    expect(stuck()).toBeNull()
    // 둘째 말로 가서 그 말이 상자 자리(맨 위 100 에서 116 안)에 보이면 첫 차례 상자가 덮지 않는다
    place(el, [[-500, -460], [124, 164]])
    fireEvent.scroll(el)
    expect(stuck()).toBeNull()
  })

  it('다른 에이전트가 보낸 메시지로 연 차례면 보낸 이름을 붙인다', async () => {
    history.mockResolvedValue([
      { t: 1, kind: 'user', source: 'relay', parts: [{ type: 'text', text: '[두레 메시지 — 보낸 쪽: 기획(기획서 · 문구)]\n## 시안 세 벌\n만들어 주세요' }] },
      { t: 2, kind: 'assistant', blocks: [{ type: 'text', text: '만들게요.' }] },
    ])
    await renderPanel()
    const el = conv()
    place(el, [[-200, -140]])
    fireEvent.scroll(el)
    expect(stuck()).toHaveTextContent('기획에게서')
    expect(stuck()).toHaveAccessibleName('기획에게서 온 메시지로 가기 — 시안 세 벌')
  })
})
