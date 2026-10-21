import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { render, screen, act, fireEvent, cleanup, within } from '@testing-library/react'
import type { Decision, EngineEventMap, PendingRequest, RelayMessage } from '../../src/engine/types'
import type { AgentView, Snapshot } from '../../src/shared/ipcContract'

const MIN = 60_000

const agent = (id: string, over: Partial<AgentView> = {}): AgentView => ({
  id, roomId: 'r1', name: id, role: '역할', folder: 'C:\\w', sessionId: 's', started: true, auto: false, model: null,
  alwaysAllow: [], pos: { x: 64, y: 64 }, color: null, effort: null, lastContext: null, bypassOn: false, effortNow: null, modelNow: null, status: 'idle', errorText: null, bypass: false, bypassBySettings: false, heldInput: 0, ...over,
})
const request = (over: Partial<PendingRequest> = {}): PendingRequest => ({
  id: 'q1', agentId: 'd', toolName: 'Edit', input: { file_path: 'C:\\w\\src\\styles\\tokens.css', old_string: 'a', new_string: 'b' },
  kind: 'permission', createdAt: Date.now() - MIN, ...over,
})
const msg = (over: Partial<RelayMessage> & { id: string }): RelayMessage => ({
  roomId: 'r1', from: 'w', to: 's', text: 'API 응답 확인 부탁해요', createdAt: Date.now() - 10_000, state: 'pending',
  updatedAt: Date.now() - 10_000, ...over,
})

const QUESTIONS = {
  questions: [
    {
      question: '배너 색은 어떻게 할까요?', header: '색',
      options: [{ label: '파랑', description: '지금 주색 그대로' }, { label: '초록', description: '여름 느낌' }],
      multiSelect: false,
    },
    {
      question: '어느 화면에 넣을까요?', header: '화면',
      options: [{ label: '메인', description: '' }, { label: '목록', description: '' }, { label: '상세', description: '' }],
      multiSelect: true,
    },
  ],
}

let snapshot: Snapshot
let handlers: Record<string, ((p: any) => void)[]>
let api: Record<'approveMessage' | 'dismissMessage' | 'continueHeld' | 'answerRequest', ReturnType<typeof vi.fn>>

const emit = <K extends keyof EngineEventMap>(k: K, p: EngineEventMap[K]) => act(() => (handlers[k] ?? []).forEach(f => f(p)))

beforeEach(() => {
  vi.resetModules()
  handlers = {}
  snapshot = {
    claudeMissing: false,
    rooms: [{ id: 'r1', name: '여름 캠페인', createdAt: 1 }, { id: 'r2', name: '다른 방', createdAt: 2 }],
    agents: [
      agent('p', { name: '기획', role: '기획서 · 문구' }),
      agent('d', { name: '디자인', role: '시안 · 스타일' }),
      agent('w', { name: '웹 화면', role: '화면 구현', auto: true }),
      agent('s', { name: '서버', role: 'API · 데이터' }),
      agent('x', { name: '다른 방 사람', roomId: 'r2' }),
    ],
    messages: [], requests: [], autoChainLimit: 3, allowBypass: false, usage: null,
  }
  api = {
    approveMessage: vi.fn(async (_id: string) => {}),
    dismissMessage: vi.fn(async (_id: string) => {}),
    continueHeld: vi.fn(async (_roomId: string) => {}),
    answerRequest: vi.fn(async (_id: string, _d: Decision) => {}),
  }
  ;(window as any).dure = {
    ...api,
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

async function renderPanel(select: string, withCard?: string) {
  const { getStore } = await import('../../src/renderer/state/store')
  const { AgentPanel } = await import('../../src/renderer/panel/AgentPanel')
  const { AgentCard } = await import('../../src/renderer/map/AgentNode')
  await act(async () => { await getStore().init() })
  const r = render(
    <>
      <AgentPanel />
      {withCard && <AgentCard agentId={withCard} />}
    </>,
  )
  await act(async () => { getStore().selectAgent(select) })
  await settle()
  return { ...r, store: getStore() }
}

const pins = () => Array.from(document.querySelectorAll<HTMLElement>('.pnl-pins > section'))
const card = (name: string) => screen.getByRole('region', { name })
const toggle = (el: HTMLElement) => el.querySelector<HTMLButtonElement>('button[aria-expanded]')!

describe('받은 메시지 카드', () => {
  it('긴 본문은 3줄만 보이고 흐려진다', async () => {
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (this: HTMLElement) { return this.classList.contains('clamp-box') ? 300 : 0 })
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) { return this.classList.contains('clamp-box') ? 54 : 0 })
    snapshot.messages = [msg({ id: 'm1', text: '긴 줄 '.repeat(200) })]
    await renderPanel('s')
    const c = card('웹 화면이 보낸 메시지')
    expect(c.querySelector('.pin-b .clamp-box')).toHaveClass('clamped')
    expect(c.querySelector('.pin-b .clamp-box')).toHaveClass('clamp-md') // 문단 사이 여백만큼 더(접기 기준)
    expect(within(c).getByRole('button', { name: '더 보기' })).toBeInTheDocument()
  })

  it('머리에 보낸 이름 → 받는 이름 · 시간 · 확인 대기, 본문은 마크다운(파일 이름은 mono)', async () => {
    snapshot.messages = [msg({ id: 'm1', text: '파일은 `src/api/user.ts` 의 **응답** 이에요' })]
    await renderPanel('s')
    const c = card('웹 화면이 보낸 메시지')
    const head = c.querySelector('.pin-h')!
    expect(head.textContent).toContain('웹 화면')
    expect(head.textContent).toContain('서버')
    expect(head.textContent).toContain('· 방금')
    expect(c.querySelector('.tag')!.textContent).toBe('확인 대기')
    const code = c.querySelector('.md code')!
    expect(code.textContent).toBe('src/api/user.ts')
    expect(c.querySelector('.md strong')!.textContent).toBe('응답')
  })

  it('보낸 에이전트가 지워졌으면 이름 자리에 "지워진 에이전트"(관계도의 메시지 창과 같은 말)', async () => {
    snapshot.messages = [msg({ id: 'm1', from: 'gone' })]
    await renderPanel('s')
    const c = card('지워진 에이전트가 보낸 메시지')
    expect(c.querySelector('.pin-h')!.textContent).toContain('지워진 에이전트')
  })

  it('[일 시키기] 는 approveMessage 를 그 메시지 id 로', async () => {
    snapshot.messages = [msg({ id: 'm1' })]
    await renderPanel('s')
    await act(async () => { fireEvent.click(within(card('웹 화면이 보낸 메시지')).getByRole('button', { name: '일 시키기' })) })
    expect(api.approveMessage).toHaveBeenCalledTimes(1)
    expect(api.approveMessage).toHaveBeenCalledWith('m1')
    expect(api.dismissMessage).not.toHaveBeenCalled()
  })

  it('일 시키기가 실패하면 엔진 문구를 보여 주고 다시 누를 수 있다', async () => {
    snapshot.messages = [msg({ id: 'm1' })]
    api.approveMessage.mockRejectedValueOnce(new Error('이미 처리된 메시지입니다.'))
    await renderPanel('s')
    const btn = within(card('웹 화면이 보낸 메시지')).getByRole('button', { name: '일 시키기' }) as HTMLButtonElement
    await act(async () => { fireEvent.click(btn) })
    await settle()
    expect(screen.getByRole('alert').textContent).toBe('이미 처리된 메시지입니다.')
    expect(btn.disabled).toBe(false)
  })

  it('전달이 허락되면(queued) 작업 끝 대기 — 버튼은 사라진다', async () => {
    snapshot.messages = [msg({ id: 'm1' })]
    await renderPanel('s')
    await emit('message', msg({ id: 'm1', state: 'queued', updatedAt: Date.now() }))
    const c = card('웹 화면이 보낸 메시지')
    expect(c.querySelector('.tag')!.textContent).toBe('작업 끝 대기')
    expect(within(c).queryByRole('button', { name: '일 시키기' })).toBeNull()
  })

  it("[나중에] 는 접기만 — API 를 부르지 않고 배지는 그대로, 다른 에이전트에 갔다 와도 접힌 채", async () => {
    snapshot.messages = [msg({ id: 'm1' })]
    const { store } = await renderPanel('s', 's')
    const c = () => card('웹 화면이 보낸 메시지')
    expect(document.querySelector('.um b')!.textContent).toBe('1')

    await act(async () => { fireEvent.click(within(c()).getByRole('button', { name: '나중에' })) })
    expect(c().querySelector('.md')).toBeNull()
    expect(within(c()).queryByRole('button', { name: '일 시키기' })).toBeNull()
    expect(toggle(c()).getAttribute('aria-expanded')).toBe('false')
    expect(api.approveMessage).not.toHaveBeenCalled()
    expect(api.dismissMessage).not.toHaveBeenCalled()
    expect(document.querySelector('.um b')!.textContent).toBe('1')

    await act(async () => store.selectAgent('p'))
    await act(async () => store.selectAgent('s'))
    expect(c().querySelector('.md')).toBeNull()

    // 머리를 누르면 다시 펼친다
    await act(async () => { fireEvent.click(toggle(c())) })
    expect(c().querySelector('.md')).not.toBeNull()
    expect(within(c()).getByRole('button', { name: '일 시키기' })).toBeTruthy()
  })

  it('메뉴의 버리기는 확인을 거친다 — 취소면 안 부르고, [버리기] 를 눌러야 dismissMessage', async () => {
    snapshot.messages = [msg({ id: 'm1' })]
    await renderPanel('s')
    const openMenu = async () => {
      await act(async () => { fireEvent.click(within(card('웹 화면이 보낸 메시지')).getByRole('button', { name: '메시지 메뉴' })) })
      await act(async () => { fireEvent.click(screen.getByRole('menuitem', { name: '버리기' })) })
    }

    await openMenu()
    let dlg = screen.getByRole('alertdialog')
    expect(within(dlg).getByText('이 메시지를 버릴까요?')).toBeTruthy()
    expect(api.dismissMessage).not.toHaveBeenCalled()
    await act(async () => { fireEvent.click(within(dlg).getByRole('button', { name: '취소' })) })
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(api.dismissMessage).not.toHaveBeenCalled()

    await openMenu()
    dlg = screen.getByRole('alertdialog')
    await act(async () => { fireEvent.click(within(dlg).getByRole('button', { name: '버리기' })) })
    await settle()
    expect(api.dismissMessage).toHaveBeenCalledTimes(1)
    expect(api.dismissMessage).toHaveBeenCalledWith('m1')
    expect(api.approveMessage).not.toHaveBeenCalled()
  })

  it('버린 메시지(dismissed)는 카드가 사라진다', async () => {
    snapshot.messages = [msg({ id: 'm1' })]
    await renderPanel('s')
    await emit('message', msg({ id: 'm1', state: 'dismissed', updatedAt: Date.now() }))
    expect(screen.queryByRole('region', { name: '웹 화면이 보낸 메시지' })).toBeNull()
  })

  it('최근 전달된 메시지 1장 — 전달됨(파랑), 5분이 지나면 접혀 있고 머리를 누르면 펼친다', async () => {
    snapshot.messages = [
      msg({ id: 'old', from: 'p', to: 'w', state: 'delivered', createdAt: Date.now() - 30 * MIN, updatedAt: Date.now() - 30 * MIN, text: '예전 것' }),
      msg({ id: 'new', from: 'p', to: 'w', state: 'delivered', createdAt: Date.now() - 20_000, updatedAt: Date.now() - 20_000, text: '배너 문구를 바꿔 주세요' }),
    ]
    const { store } = await renderPanel('w')
    expect(pins()).toHaveLength(1)
    const c = card('기획이 보낸 메시지')
    const tag = c.querySelector('.tag')!
    expect(tag.textContent).toBe('전달됨')
    expect(tag.classList.contains('ok')).toBe(true)
    expect(c.querySelector('.md')!.textContent).toBe('배너 문구를 바꿔 주세요')
    expect(within(c).queryByRole('button', { name: '일 시키기' })).toBeNull()
    expect(within(c).queryByRole('button', { name: '메시지 메뉴' })).toBeNull()

    snapshot.messages = [
      msg({ id: 'old', from: 'p', to: 'w', state: 'delivered', createdAt: 1, updatedAt: Date.now() - 6 * MIN, text: '예전 것' }),
    ]
    await act(async () => { await store.refresh() })
    const folded = card('기획이 보낸 메시지')
    expect(folded.querySelector('.md')).toBeNull()
    expect(toggle(folded).getAttribute('aria-expanded')).toBe('false')
    await act(async () => { fireEvent.click(toggle(folded)) })
    expect(card('기획이 보낸 메시지').querySelector('.md')!.textContent).toBe('예전 것')
  })
})

describe('권한 카드', () => {
  it.each([
    ['허용', { type: 'allow' }],
    ['거절', { type: 'deny' }],
    ['이 에이전트에선 항상 허용', { type: 'allow-always' }],
  ] as const)('[%s] → answerRequest(id, %o)', async (name, decision) => {
    snapshot.requests = [request()]
    await renderPanel('d')
    const c = card('디자인이 파일을 고치려 해요')
    await act(async () => { fireEvent.click(within(c).getByRole('button', { name })) })
    expect(api.answerRequest).toHaveBeenCalledTimes(1)
    expect(api.answerRequest).toHaveBeenCalledWith('q1', decision)
  })

  it('제목은 관계도 카드와 같은 표 — 만들기는 "파일을 만들려", 명령은 "명령을 실행하려"', async () => {
    snapshot.requests = [
      request({ id: 'a', toolName: 'Write', input: { file_path: 'C:\\w\\src\\styles\\tokens.css', content: 'x' } }),
      request({ id: 'b', toolName: 'Bash', input: { command: 'npm run build\nnpm test' }, createdAt: Date.now() }),
    ]
    await renderPanel('d')
    expect(card('디자인이 파일을 만들려 해요')).toBeTruthy()
    expect(card('디자인이 명령을 실행하려 해요').querySelector('code')!.textContent).toBe('npm run build')
  })

  it('대상은 mono(폴더 기준 경로), 자세히는 입력 JSON 을 접어 둔다', async () => {
    snapshot.requests = [request()]
    await renderPanel('d')
    const c = card('디자인이 파일을 고치려 해요')
    expect(c.querySelector('code')!.textContent).toBe('src/styles/tokens.css')
    const more = within(c).getByRole('button', { name: '자세히' })
    expect(more.getAttribute('aria-expanded')).toBe('false')
    expect(c.querySelector('pre')).toBeNull()
    await act(async () => { fireEvent.click(more) })
    expect(more.getAttribute('aria-expanded')).toBe('true')
    const pre = c.querySelector('pre')!
    expect(JSON.parse(pre.textContent!)).toEqual(request().input)
  })

  it('답이 실패하면(이미 끝난 요청) 엔진 문구를 보여 주고 버튼을 다시 연다', async () => {
    snapshot.requests = [request()]
    api.answerRequest.mockRejectedValueOnce(new Error('대기 중인 요청이 없습니다: q1'))
    await renderPanel('d')
    const c = card('디자인이 파일을 고치려 해요')
    const allow = within(c).getByRole('button', { name: '허용' }) as HTMLButtonElement
    await act(async () => { fireEvent.click(allow) })
    await settle()
    expect(within(c).getByRole('alert').textContent).toBe('대기 중인 요청이 없습니다: q1')
    expect(allow.disabled).toBe(false)
  })

  it('요청이 풀리면(request-resolved) 카드가 사라진다', async () => {
    snapshot.requests = [request()]
    await renderPanel('d')
    await emit('request-resolved', { id: 'q1', agentId: 'd' })
    expect(screen.queryByRole('region', { name: '디자인이 파일을 고치려 해요' })).toBeNull()
  })
})

describe('질문 카드', () => {
  const question = () => request({ id: 'ask1', agentId: 'w', toolName: 'AskUserQuestion', kind: 'question', input: QUESTIONS })

  it('질문마다 머리·질문·보기 — 하나만 고르는 건 라디오, multiSelect 는 체크', async () => {
    snapshot.requests = [question()]
    await renderPanel('w')
    const c = card('질문이 있어요')
    const g1 = within(c).getByRole('group', { name: /배너 색은 어떻게 할까요\?/ })
    const g2 = within(c).getByRole('group', { name: /어느 화면에 넣을까요\?/ })
    expect(within(g1).getByText('색')).toBeTruthy()
    expect(within(g1).getAllByRole('radio')).toHaveLength(2)
    expect(within(g1).getByText('여름 느낌')).toBeTruthy()
    expect(within(g2).getByText('화면')).toBeTruthy()
    expect(within(g2).getAllByRole('checkbox')).toHaveLength(3)
  })

  it('모두 골라야 [답 보내기] — multiSelect 는 보기 순서대로 ", " 로 이어 answer 로 보낸다', async () => {
    snapshot.requests = [question()]
    await renderPanel('w')
    const c = card('질문이 있어요')
    const send = within(c).getByRole('button', { name: '답 보내기' }) as HTMLButtonElement
    expect(send.disabled).toBe(true)

    await act(async () => { fireEvent.click(within(c).getByRole('radio', { name: /초록/ })) })
    expect(send.disabled).toBe(true) // 둘째 질문이 아직
    await act(async () => { fireEvent.click(within(c).getByRole('checkbox', { name: /상세/ })) })
    await act(async () => { fireEvent.click(within(c).getByRole('checkbox', { name: /메인/ })) })
    await act(async () => { fireEvent.click(within(c).getByRole('checkbox', { name: /목록/ })) })
    await act(async () => { fireEvent.click(within(c).getByRole('checkbox', { name: /목록/ })) }) // 다시 눌러 뺀다
    expect(send.disabled).toBe(false)

    await act(async () => { fireEvent.click(send) })
    expect(api.answerRequest).toHaveBeenCalledTimes(1)
    expect(api.answerRequest).toHaveBeenCalledWith('ask1', {
      type: 'answer',
      answers: { '배너 색은 어떻게 할까요?': '초록', '어느 화면에 넣을까요?': '메인, 상세' },
    })
  })

  it('체크를 다 빼면 다시 비활성', async () => {
    snapshot.requests = [question()]
    await renderPanel('w')
    const c = card('질문이 있어요')
    const send = within(c).getByRole('button', { name: '답 보내기' }) as HTMLButtonElement
    await act(async () => { fireEvent.click(within(c).getByRole('radio', { name: /파랑/ })) })
    await act(async () => { fireEvent.click(within(c).getByRole('checkbox', { name: /메인/ })) })
    expect(send.disabled).toBe(false)
    await act(async () => { fireEvent.click(within(c).getByRole('checkbox', { name: /메인/ })) })
    expect(send.disabled).toBe(true)
  })

  it("'대답 안 함' 은 deny — allow 류는 쓰지 않는다", async () => {
    snapshot.requests = [question()]
    await renderPanel('w')
    await act(async () => { fireEvent.click(within(card('질문이 있어요')).getByRole('button', { name: '대답 안 함' })) })
    expect(api.answerRequest).toHaveBeenCalledWith('ask1', { type: 'deny' })
    for (const [, d] of api.answerRequest.mock.calls) expect(['allow', 'allow-always']).not.toContain((d as Decision).type)
  })
})

describe('자동 상한 카드', () => {
  it('방에 held 가 있으면 하나만 — 문구에 상한 수, [계속] 은 continueHeld(방)', async () => {
    snapshot.messages = [
      msg({ id: 'h1', from: 'w', to: 's', state: 'held' }),
      msg({ id: 'h2', from: 's', to: 'w', state: 'held' }),
    ]
    await renderPanel('p') // held 와 상관없는 같은 방 에이전트에서도 보인다
    const cards = screen.getAllByText('자동 전달이 3번 이어졌어요 — 계속할까요?')
    expect(cards).toHaveLength(1)
    const c = cards[0].closest('section')!
    await act(async () => { fireEvent.click(within(c).getByRole('button', { name: '계속' })) })
    expect(api.continueHeld).toHaveBeenCalledTimes(1)
    expect(api.continueHeld).toHaveBeenCalledWith('r1')
  })

  it('다른 방의 held 는 보이지 않는다 · held 가 없으면 없다', async () => {
    snapshot.messages = [msg({ id: 'h1', from: 'w', to: 's', state: 'held' })]
    const { store } = await renderPanel('x')
    expect(screen.queryByText(/자동 전달이/)).toBeNull()
    await act(async () => store.selectAgent('w'))
    expect(screen.getByText('자동 전달이 3번 이어졌어요 — 계속할까요?')).toBeTruthy()
    await emit('message', msg({ id: 'h1', from: 'w', to: 's', state: 'queued', updatedAt: Date.now() }))
    expect(screen.queryByText(/자동 전달이/)).toBeNull()
  })
})

describe('고정 카드 순서', () => {
  it('권한·질문(먼저 온 것부터) → 받은 메시지(오래된 순) → 자동 상한 → 최근 전달 1장', async () => {
    const now = Date.now()
    snapshot.requests = [
      request({ id: 'perm', agentId: 's', toolName: 'Bash', input: { command: 'npm test' }, createdAt: now - 5_000 }),
      request({ id: 'ask', agentId: 's', toolName: 'AskUserQuestion', kind: 'question', input: QUESTIONS, createdAt: now - 9_000 }),
      request({ id: 'other', agentId: 'd' }), // 다른 에이전트 것 — 안 보인다
    ]
    snapshot.messages = [
      msg({ id: 'late', from: 'd', to: 's', createdAt: now - 1_000 }),
      msg({ id: 'early', from: 'p', to: 's', createdAt: now - 50_000 }),
      msg({ id: 'held', from: 'w', to: 'd', state: 'held' }),
      msg({ id: 'done', from: 'w', to: 's', state: 'delivered', createdAt: now - 90_000, updatedAt: now - 60_000 }),
      msg({ id: 'mine', from: 's', to: 'p' }), // 이 에이전트가 보낸 것 — 받은 메시지가 아니다
    ]
    await renderPanel('s')
    expect(pins().map(el => el.getAttribute('aria-label'))).toEqual([
      '질문이 있어요',
      '서버가 명령을 실행하려 해요',
      '기획이 보낸 메시지',
      '디자인이 보낸 메시지',
      '자동 전달이 3번 이어졌어요 — 계속할까요?',
      '웹 화면이 보낸 메시지',
    ])
    expect(pins()[5].querySelector('.tag')!.textContent).toBe('전달됨')
  })

  it('카드가 없으면 고정 자리는 비어 있다', async () => {
    await renderPanel('s')
    expect(pins()).toHaveLength(0)
  })
})

describe('Markdown', () => {
  async function md(text: string) {
    const { Markdown } = await import('../../src/renderer/lib/Markdown')
    return render(<Markdown text={text} />).container.querySelector<HTMLElement>('.md')!
  }

  it('원시 HTML 은 요소로 그리지 않는다', async () => {
    const el = await md('앞 <img src="x" onerror="alert(1)"> <b>굵게</b> 뒤')
    expect(el.querySelector('img')).toBeNull()
    expect(el.querySelector('b')).toBeNull()
  })

  it('http·https 링크는 기본 브라우저로(window.open) — 앱 안에서 이동하지 않는다', async () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null)
    const el = await md('[문서](https://example.com/a) 와 [나쁜](javascript:alert(1)) 와 [파일](file:///C:/x)')
    const link = within(el).getByRole('link', { name: '문서' })
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true })
    link.dispatchEvent(ev)
    expect(ev.defaultPrevented).toBe(true)
    expect(open).toHaveBeenCalledWith('https://example.com/a', '_blank')
    expect(within(el).queryByRole('link', { name: '나쁜' })).toBeNull()
    expect(within(el).queryByRole('link', { name: '파일' })).toBeNull()
    expect(el.textContent).toContain('나쁜')
    expect(open).toHaveBeenCalledTimes(1)
  })

  it('표·줄그음(GFM) 과 코드 블록', async () => {
    const el = await md('| a | b |\n|---|---|\n| 1 | 2 |\n\n~~지움~~\n\n```\nnpm test\n```')
    expect(el.querySelector('table')).not.toBeNull()
    expect(el.querySelector('del')!.textContent).toBe('지움')
    expect(el.querySelector('pre code')!.textContent).toBe('npm test\n')
  })
})
