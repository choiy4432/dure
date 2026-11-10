import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { render, screen, act, fireEvent, cleanup, within } from '@testing-library/react'
import type { RelayMessage, PendingRequest } from '../../src/engine/types'
import type { AgentView, Snapshot } from '../../src/shared/ipcContract'
import { APP_METHODS, METHODS } from '../../src/shared/ipcContract'
import { PHONE_ACCESS, PHONE_DENIED } from '../../src/shared/phoneAccess'

// 휴대폰 화면(MobileApp) — 방 고르기 → 카드 판 → 대화. window.dure 는 휴대폰 것(wsApi)처럼: 휴대폰 표시와 uploadFile 이 있고 pathForFile 은 늘 '',
// PC 전용 메서드는 부르면 PHONE_DENIED(실제 wsApi 는 보내지 않고 거절한다) — 시험은 그 메서드가 아예 불리지 않았는지 본다

const agent = (id: string, over: Partial<AgentView> = {}): AgentView => ({
  id, roomId: 'r1', name: id, role: '역할', folder: 'C:\\work\\pay', sessionId: 's', started: true, auto: false, model: null,
  alwaysAllow: [], pos: { x: 64, y: 64 }, color: null, effort: null, lastContext: null, bypassOn: false, effortNow: null, modelNow: null, status: 'idle', errorText: null, bypass: false, bypassBySettings: false, bypassPending: false, heldInput: 0, planMode: false, asleep: false, waking: false, hold: null, subagentsRunning: [], pastCount: 0, remoteIssue: null, ...over,
})
const msg = (id: string, from: string, to: string, state: RelayMessage['state'], createdAt = 10): RelayMessage => ({
  id, roomId: 'r1', from, to, text: '결제 API 를 이어서 해 줘', createdAt, state, updatedAt: createdAt,
})
const req = (id: string, agentId: string, kind: PendingRequest['kind'] = 'permission', createdAt = 5): PendingRequest => ({
  id, agentId, toolName: kind === 'question' ? 'AskUserQuestion' : 'Bash', input: kind === 'question' ? { questions: [{ question: '어느 쪽?', options: [] }] } : { command: 'npm run migrate' }, kind, createdAt,
})

/** 휴대폰 표시 — src/renderer/lib/phone 의 PHONE_MARK(Symbol.for) */
const PHONE = Symbol.for('dure.phone')

const PC_ONLY = (Object.keys(PHONE_ACCESS) as (keyof typeof PHONE_ACCESS)[]).filter(k => PHONE_ACCESS[k] === 'pc')

let snapshot: Snapshot
let handlers: Record<string, ((p: any) => void)[]>
let api: Record<string, ReturnType<typeof vi.fn>> & { on: unknown }

beforeEach(() => {
  vi.resetModules()
  localStorage.clear()
  window.history.replaceState(null, '', '/mobile.html')
  handlers = {}
  snapshot = {
    claudeMissing: false,
    rooms: [
      { id: 'r1', name: '결제 리팩터링', createdAt: 1 },
      { id: 'r2', name: '논문 실험', createdAt: 2, remote: { host: 'lab' } },
      { id: 'r3', name: '두레 개발', createdAt: 3 },
    ],
    agents: [
      agent('a1', { name: '백엔드', role: 'API' }),
      agent('a2', { name: '프론트', role: '화면', pos: { x: 424, y: 64 }, folder: 'C:\\work\\web' }),
      agent('b1', { name: '실험', roomId: 'r2', folder: '/home/me/exp' }),
    ],
    messages: [], requests: [], autoChainLimit: 3, allowBypass: false, notify: { asks: true, finished: false }, sleepAfterMin: 30, usage: null,
  }
  const fake: Record<string, unknown> = {}
  // 처음엔 모든 메서드가 '휴대폰에서 안 됨' — 아래에서 휴대폰 메서드만 엔진처럼 채운다
  for (const m of [...METHODS, ...APP_METHODS]) fake[m] = vi.fn(async () => { throw new Error(PHONE_DENIED) })
  Object.assign(fake, {
    snapshot: vi.fn(async () => snapshot),
    history: vi.fn(async () => []),
    describe: vi.fn(async () => ({ commands: [], models: [{ value: 'default', displayName: 'Default' }], permissionMode: 'default' })),
    sleepBlock: vi.fn(async () => 'no-session'),
    removeAgent: vi.fn(async (id: string) => { snapshot = { ...snapshot, agents: snapshot.agents.filter(a => a.id !== id) } }),
    removeRoom: vi.fn(async (id: string) => { snapshot = { ...snapshot, rooms: snapshot.rooms.filter(r => r.id !== id), agents: snapshot.agents.filter(a => a.roomId !== id) } }),
    renameRoom: vi.fn(async (id: string, name: string) => { snapshot = { ...snapshot, rooms: snapshot.rooms.map(r => (r.id === id ? { ...r, name } : r)) } }),
    addRoom: vi.fn(async (name: string) => {
      const room = { id: 'r9', name, createdAt: 9 }
      snapshot = { ...snapshot, rooms: [...snapshot.rooms, room] }
      return room
    }),
    newConversation: vi.fn(async () => {}),
    approveMessage: vi.fn(async (id: string) => { snapshot = { ...snapshot, messages: snapshot.messages.map(m => (m.id === id ? { ...m, state: 'delivered' } : m)) } }),
    updateAgent: vi.fn(async () => {}),
    sendUser: vi.fn(async () => {}),
  })
  fake.on = (k: string, fn: (p: any) => void) => {
    ;(handlers[k] ??= []).push(fn)
    return () => {}
  }
  fake.pathForFile = () => ''
  fake.uploadFile = vi.fn(async (f: File) => ({ path: `C:\\inbox\\${f.name}`, name: f.name, bytes: f.size }))
  ;(fake as Record<symbol, unknown>)[PHONE] = true // 휴대폰 표시(createWsApi 가 붙이는 것 — onPhone 은 이것만 본다)
  fake.setVisible = () => {}
  fake.close = () => {}
  api = fake as typeof api
  ;(window as any).dure = fake
})
// 화면은 ‹ 를 누르는 즉시 바뀌고 브라우저 뒤로 가기는 뒤에 끝난다 — 다음 시험의 기록에 끼어들지 않게 끝날 때까지 기다린다(jsdom 은 시험 사이에 기록을 지우지 않는다)
afterEach(async () => {
  cleanup()
  await new Promise(r => setTimeout(r, 20))
})

const settle = () => act(async () => { await new Promise(r => setTimeout(r, 0)) })

async function renderPhone() {
  const { getStore } = await import('../../src/renderer/state/store')
  const conn = await import('../../src/renderer/mobile/connection')
  const { MobileApp } = await import('../../src/renderer/mobile/MobileApp')
  await act(async () => { await getStore().init() })
  conn.onPhoneConn('open', false)
  const r = render(<MobileApp />)
  await settle()
  return { ...r, store: getStore(), conn }
}

const heading = () => screen.getByRole('heading', { level: 1 })
const back = () => screen.getByRole('button', { name: '뒤로' })
const card = (container: HTMLElement, id: string) => container.querySelector<HTMLElement>(`.react-flow__node[data-id="${id}"]`)!
const noPcCalls = () => {
  for (const m of PC_ONLY) expect(api[m], m).not.toHaveBeenCalled()
}

describe('MobileApp — 흐름', () => {
  it('방 고르기 → 판 → 카드 → 대화 → ‹ 로 판', async () => {
    const { container, store } = await renderPhone()
    // 방 목록 — 머리는 연결된 PC 이름과 연결 상태
    expect(screen.getByText('연결됨')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /결제 리팩터링/ }))
    await settle()
    expect(heading()).toHaveTextContent('결제 리팩터링')
    fireEvent.click(card(container, 'a1'))
    await settle()
    expect(heading()).toHaveTextContent('백엔드')
    expect(screen.getByRole('textbox', { name: '백엔드에게 보낼 메시지' })).toBeInTheDocument()
    expect(store.getState().selectedAgentId).toBe('a1') // 열린 대화 = 고른 에이전트(다시 이어지면 이 기록을 다시 받는다)
    fireEvent.click(back())
    await settle()
    expect(heading()).toHaveTextContent('결제 리팩터링')
    expect(screen.queryByRole('textbox', { name: '백엔드에게 보낼 메시지' })).toBeNull()
    expect(store.getState().selectedAgentId).toBeNull()
    fireEvent.click(back())
    await settle()
    expect(screen.getByRole('heading', { name: '방 3' })).toBeInTheDocument()
    noPcCalls()
  })

  it('#agent= 로 바로 대화 — 처음 주소 · 알림 누름(hashchange)', async () => {
    window.history.replaceState(null, '', '/mobile.html#agent=a2')
    await renderPhone()
    expect(heading()).toHaveTextContent('프론트')
    // ‹ — 그 에이전트의 방 판으로
    fireEvent.click(back())
    await settle()
    expect(heading()).toHaveTextContent('결제 리팩터링')
    // 알림을 누르면 진입점이 #agent= 로 바꾼다
    await act(async () => {
      window.history.replaceState(null, '', '/mobile.html#agent=a1')
      window.dispatchEvent(new HashChangeEvent('hashchange'))
    })
    await settle()
    expect(heading()).toHaveTextContent('백엔드')
    noPcCalls()
  })

  it('휴대폰의 뒤로 가기 — 한 단계 위로(대화 → 판 → 방 목록)', async () => {
    const { container } = await renderPhone()
    fireEvent.click(screen.getByRole('button', { name: /결제 리팩터링/ }))
    await settle()
    fireEvent.click(card(container, 'a1'))
    await settle()
    expect(heading()).toHaveTextContent('백엔드')
    await act(async () => {
      window.history.back()
      await new Promise(r => setTimeout(r, 20))
    })
    expect(heading()).toHaveTextContent('결제 리팩터링')
    await act(async () => {
      window.history.back()
      await new Promise(r => setTimeout(r, 20))
    })
    expect(screen.getByRole('heading', { name: '방 3' })).toBeInTheDocument()
  })

  it('다시 이어지면 열린 대화의 기록을 다시 받는다(고른 에이전트 = 열린 대화)', async () => {
    const { container, conn } = await renderPhone()
    fireEvent.click(screen.getByRole('button', { name: /결제 리팩터링/ }))
    await settle()
    fireEvent.click(card(container, 'a1'))
    await settle()
    const before = api.history.mock.calls.filter(c => c[0] === 'a1').length
    await act(async () => { conn.onPhoneConn('reconnecting', true) })
    expect(screen.getAllByRole('status').filter(n => !n.classList.contains('sr-only'))[0]).toHaveTextContent('다시 잇는 중…')
    await act(async () => { conn.onPhoneConn('open', true) })
    await settle()
    expect(api.history.mock.calls.filter(c => c[0] === 'a1').length).toBe(before + 1)
    expect(heading()).toHaveTextContent('백엔드')
  })

  it('판의 승인 카드 — 작은 허용·거절 단추 없이 무엇을 묻는지만, 누르면 대화(큰 승인 카드)로', async () => {
    snapshot.agents = snapshot.agents.map(a => (a.id === 'a1' ? { ...a, status: 'awaiting' } : a))
    snapshot.requests = [req('q1', 'a1')]
    const { container } = await renderPhone()
    fireEvent.click(within(screen.getByRole('region', { name: /^방/ })).getByRole('button', { name: /결제 리팩터링/ }))
    await settle()
    const c = card(container, 'a1')
    expect(c).toHaveTextContent('npm run migrate')
    expect(within(c).queryByRole('button', { name: '허용' })).toBeNull()
    fireEvent.click(c.querySelector('.tcd-l')!)
    await settle()
    expect(heading()).toHaveTextContent('백엔드')
    expect(screen.getByRole('button', { name: '허용' })).toBeInTheDocument()
    expect(api.answerRequest).not.toHaveBeenCalled()
  })

  it('#agent= 의 에이전트가 없으면 방 목록', async () => {
    window.history.replaceState(null, '', '/mobile.html#agent=gone')
    await renderPhone()
    expect(screen.getByRole('heading', { name: '방 3' })).toBeInTheDocument()
  })

  it('처음 상태를 받기 전엔(PC 에 닿지 않음) #agent= · #room= 을 버리지 않는다 — 받으면 그 화면, 받은 뒤에도 없으면 그때 방 목록', async () => {
    let reachable = false
    api.snapshot.mockImplementation(async () => {
      if (!reachable) throw new Error('연결이 끊겼어요 — 다시 잇는 중이에요')
      return snapshot
    })
    const { getStore } = await import('../../src/renderer/state/store')
    const conn = await import('../../src/renderer/mobile/connection')
    const { MobileApp } = await import('../../src/renderer/mobile/MobileApp')
    window.history.replaceState(null, '', '/mobile.html#agent=a2')
    await act(async () => { await getStore().init().catch(() => {}) }) // 진입점처럼 — 못 받아도 화면은 띄운다
    conn.onPhoneConn('reconnecting', true)
    const r = render(<MobileApp />)
    await settle()
    expect(location.hash).toBe('#agent=a2')
    expect(screen.queryByRole('heading', { name: '방 3' })).toBeNull()
    expect(heading()).toHaveTextContent('대화')
    expect(screen.getAllByRole('status').filter(n => !n.classList.contains('sr-only'))[0]).toHaveTextContent('다시 잇는 중…')
    reachable = true
    await act(async () => { conn.onPhoneConn('open', true) })
    await settle()
    expect(heading()).toHaveTextContent('프론트')
    r.unmount()

    // 받은 뒤에 없으면 — 그때 떠난다
    window.history.replaceState(null, '', '/mobile.html#room=gone')
    render(<MobileApp />)
    await settle()
    expect(screen.getByRole('heading', { name: '방 3' })).toBeInTheDocument()
  })

  it('판의 몸통은 이름 붙은 영역(관계도)', async () => {
    await renderPhone()
    fireEvent.click(screen.getByRole('button', { name: /결제 리팩터링/ }))
    await settle()
    expect(screen.getByRole('region', { name: '관계도' })).toHaveClass('m-canvas')
  })

  it('setSelected 안 부름 — 대화를 열고 닫고 다른 방으로 가도, PC 전용 메서드는 하나도', async () => {
    const { container } = await renderPhone()
    fireEvent.click(screen.getByRole('button', { name: /결제 리팩터링/ }))
    await settle()
    fireEvent.click(card(container, 'a2'))
    await settle()
    fireEvent.click(back())
    await settle()
    fireEvent.click(back())
    await settle()
    fireEvent.click(screen.getByRole('button', { name: /두레 개발/ }))
    await settle()
    expect(api.setSelected).not.toHaveBeenCalled()
    noPcCalls()
  })
})

describe('MobileApp — 방 고르기', () => {
  it('할 일 — 에이전트마다 한 줄, 누르면 그 대화로 바로(‹ 는 방 목록)', async () => {
    snapshot.agents = snapshot.agents.map(a => (a.id === 'a1' ? { ...a, status: 'awaiting' } : a.id === 'b1' ? { ...a, remoteIssue: { kind: 'disconnected', detail: null } } : a))
    snapshot.requests = [req('q1', 'a1'), req('q2', 'a1', 'question', 6)]
    snapshot.messages = [msg('m1', 'a1', 'a2', 'pending')]
    await renderPhone()
    const waiting = screen.getByRole('region', { name: /^할 일/ })
    const rows = within(waiting).getAllByRole('button')
    expect(rows.map(r => r.textContent)).toEqual([
      expect.stringContaining('백엔드 승인을 기다려요'),
      expect.stringContaining('프론트 넘기기 승인을 기다려요'),
      expect.stringContaining('실험 서버 연결이 끊겼어요'),
    ])
    // 수는 줄 수가 아니라 할 일 수(PC 와 같이) — 백엔드 승인·질문 2 + 넘기는 메시지 1. 서버 문제는 세지 않는다
    expect(within(waiting).getByRole('heading')).toHaveTextContent(/^할 일 3$/)
    fireEvent.click(rows[0])
    await settle()
    expect(heading()).toHaveTextContent('백엔드')
    fireEvent.click(back())
    await settle()
    expect(screen.getByRole('heading', { name: '방 3' })).toBeInTheDocument()
  })

  it('방 줄 — 에이전트 수 · 일하는 중 · 할 일, 서버 방만 서버 표시', async () => {
    snapshot.agents = snapshot.agents.map(a => (a.id === 'a1' ? { ...a, status: 'working' } : a))
    snapshot.requests = [req('q1', 'a2')]
    await renderPhone()
    // 방 줄(할 일 줄에도 방 이름이 있다)
    const pay = within(screen.getByRole('region', { name: /^방/ })).getByRole('button', { name: /결제 리팩터링/ })
    expect(pay).toHaveTextContent('에이전트 2개')
    expect(pay).toHaveTextContent('일하는 중 1')
    expect(pay).toHaveTextContent('할 일 1')
    expect(within(pay).queryByText('lab')).toBeNull()
    expect(screen.getByRole('button', { name: /논문 실험/ })).toHaveTextContent('lab')
    expect(screen.getByRole('button', { name: /두레 개발/ })).toHaveTextContent('에이전트 없음')
  })

  it('방 순서 — 보이는 동안 일이 생겨도 움직이지 않는다', async () => {
    await renderPhone()
    const order = () => Array.from(document.querySelectorAll('.mr .mr-t')).map(t => t.textContent)
    expect(order()).toEqual(['결제 리팩터링', '논문 실험', '두레 개발'])
    snapshot.agents = [...snapshot.agents, agent('c1', { roomId: 'r3', name: '문서', status: 'awaiting' })]
    snapshot.requests = [req('q3', 'c1')]
    const { getStore } = await import('../../src/renderer/state/store')
    await act(async () => { await getStore().refresh() })
    expect(order()).toEqual(['결제 리팩터링', '논문 실험', '두레 개발'])
  })

  it('끊김 — 위 띠(받은 시각) · 지난 내용은 누를 수 없음 · 안내', async () => {
    const { conn } = await renderPhone()
    await act(async () => { conn.onPhoneConn('reconnecting', true) })
    expect(screen.getAllByRole('status').filter(n => !n.classList.contains('sr-only'))[0]).toHaveTextContent(/다시 잇는 중… .+ 에 받은 내용이에요/)
    expect(screen.getByText('끊김')).toBeInTheDocument()
    const pay = screen.getByText('결제 리팩터링').closest('.mr')!
    expect(pay.tagName).not.toBe('BUTTON')
    expect(screen.queryByRole('button', { name: /결제 리팩터링/ })).toBeNull()
    expect(screen.getByText('PC 가 꺼졌거나 잠들었으면 이어지지 않아요. 휴대폰의 Tailscale 이 켜져 있는지도 봐 주세요.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '이 PC에 새 방' })).toBeNull()
    await act(async () => { conn.onPhoneConn('open', true) })
    await settle()
    expect(screen.queryByText(/다시 잇는 중/)).toBeNull()
    expect(screen.getByRole('button', { name: /결제 리팩터링/ })).toBeInTheDocument()
  })

  it('빈 방 — 아직 방이 없어요 · 이 PC에 새 방(이름만 — 서버 방은 PC 에서)', async () => {
    snapshot = { ...snapshot, rooms: [], agents: [] }
    await renderPhone()
    expect(screen.getByText('아직 방이 없어요')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '이 PC에 새 방' }))
    const dlg = screen.getByRole('dialog', { name: '이 PC에 새 방' })
    fireEvent.change(within(dlg).getByRole('textbox', { name: '방 이름' }), { target: { value: '여름 캠페인' } })
    await act(async () => { fireEvent.click(within(dlg).getByRole('button', { name: '만들기' })) })
    await settle()
    expect(api.addRoom).toHaveBeenCalledWith('여름 캠페인')
    expect(heading()).toHaveTextContent('여름 캠페인') // 만든 방의 판으로
    noPcCalls()
  })
})

describe('MobileApp — 휴대폰의 뒤로 가기는 위에 뜬 것부터', () => {
  /** 안드로이드 뒤로 가기 손짓 = 브라우저 뒤로 가기 */
  const gesture = () => act(async () => {
    window.history.back()
    await new Promise(r => setTimeout(r, 20))
  })
  const sheet = () => screen.queryByRole('dialog', { name: '백엔드 설정' })
  async function openConversation() {
    const r = await renderPhone()
    fireEvent.click(screen.getByRole('button', { name: /결제 리팩터링/ }))
    await settle()
    fireEvent.click(card(r.container, 'a1'))
    await settle()
    expect(heading()).toHaveTextContent('백엔드')
    return r
  }

  it('설정 판이 열려 있으면 판만 닫고 대화에 머문다 — 한 번 더면 판으로', async () => {
    await openConversation()
    fireEvent.click(screen.getByRole('button', { name: '에이전트 설정' }))
    await settle()
    expect(sheet()).toBeInTheDocument()
    await gesture()
    expect(sheet()).toBeNull()
    expect(heading()).toHaveTextContent('백엔드')
    await gesture()
    expect(heading()).toHaveTextContent('결제 리팩터링')
  })

  it('설정 판 위의 확인 판 — 확인 판 → 설정 판 → 대화 → 판 차례로', async () => {
    await openConversation()
    fireEvent.click(screen.getByRole('button', { name: '에이전트 설정' }))
    await settle()
    fireEvent.click(within(sheet()!).getByRole('button', { name: '지우기' }))
    await settle()
    expect(screen.getByRole('alertdialog')).toBeInTheDocument()
    await gesture()
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(sheet()).toBeInTheDocument()
    expect(api.removeAgent).not.toHaveBeenCalled()
    await gesture()
    expect(sheet()).toBeNull()
    expect(heading()).toHaveTextContent('백엔드')
    await gesture()
    expect(heading()).toHaveTextContent('결제 리팩터링')
  })

  it('단추로 닫으면 그 뒤로 가기 자리도 걷힌다 — 다음 뒤로 가기는 바로 한 단계 위로', async () => {
    await openConversation()
    fireEvent.click(screen.getByRole('button', { name: '에이전트 설정' }))
    await settle()
    fireEvent.click(within(sheet()!).getByRole('button', { name: '닫기' }))
    await act(async () => { await new Promise(r => setTimeout(r, 20)) })
    expect(sheet()).toBeNull()
    await gesture()
    expect(heading()).toHaveTextContent('결제 리팩터링')
  })

  it('판의 에이전트 추가 · 방 목록(첫 화면)의 새 방 — 뒤로 가기로 대화상자만 닫힌다', async () => {
    await renderPhone()
    fireEvent.click(screen.getByRole('button', { name: '이 PC에 새 방' }))
    await settle()
    expect(screen.getByRole('dialog', { name: '이 PC에 새 방' })).toBeInTheDocument()
    await gesture()
    expect(screen.queryByRole('dialog', { name: '이 PC에 새 방' })).toBeNull()
    expect(screen.getByRole('heading', { name: '방 3' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /결제 리팩터링/ }))
    await settle()
    fireEvent.click(screen.getByRole('button', { name: '방 메뉴' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '에이전트 추가' }))
    await settle()
    expect(screen.getByRole('dialog', { name: '에이전트 추가' })).toBeInTheDocument()
    await gesture()
    expect(screen.queryByRole('dialog', { name: '에이전트 추가' })).toBeNull()
    expect(heading()).toHaveTextContent('결제 리팩터링')
    await gesture()
    expect(screen.getByRole('heading', { name: '방 3' })).toBeInTheDocument()
  })
})

describe('MobileApp — 되돌릴 수 없는 일', () => {
  it('지우기 — 확인 판 뒤에만(에이전트 · 새 대화 · 방)', async () => {
    const { container } = await renderPhone()
    fireEvent.click(screen.getByRole('button', { name: /결제 리팩터링/ }))
    await settle()
    fireEvent.click(card(container, 'a1'))
    await settle()
    // 설정 판 — 새 대화
    fireEvent.click(screen.getByRole('button', { name: '에이전트 설정' }))
    await settle()
    let sheet = screen.getByRole('dialog', { name: '백엔드 설정' })
    fireEvent.click(within(sheet).getByRole('button', { name: '새 대화' }))
    expect(api.newConversation).not.toHaveBeenCalled()
    let ask = screen.getByRole('alertdialog')
    await act(async () => { fireEvent.click(within(ask).getByRole('button', { name: '새로 시작' })) })
    await settle()
    expect(api.newConversation).toHaveBeenCalledWith('a1')
    // 지우기
    if (!screen.queryByRole('dialog', { name: '백엔드 설정' })) fireEvent.click(screen.getByRole('button', { name: '에이전트 설정' }))
    await settle()
    sheet = screen.getByRole('dialog', { name: '백엔드 설정' })
    fireEvent.click(within(sheet).getByRole('button', { name: '지우기' }))
    expect(api.removeAgent).not.toHaveBeenCalled()
    ask = screen.getByRole('alertdialog', { name: '에이전트 백엔드를 지울까요?' })
    fireEvent.click(within(ask).getByRole('button', { name: '취소' }))
    await settle()
    expect(api.removeAgent).not.toHaveBeenCalled()
    fireEvent.click(within(screen.getByRole('dialog', { name: '백엔드 설정' })).getByRole('button', { name: '지우기' }))
    ask = screen.getByRole('alertdialog', { name: '에이전트 백엔드를 지울까요?' })
    await act(async () => { fireEvent.click(within(ask).getByRole('button', { name: '지우기' })) })
    await settle()
    expect(api.removeAgent).toHaveBeenCalledWith('a1')
    // 지운 대화는 닫히고 판으로
    expect(heading()).toHaveTextContent('결제 리팩터링')
    // 방 지우기 — 판의 ⋯
    fireEvent.click(screen.getByRole('button', { name: '방 메뉴' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '방 지우기' }))
    expect(api.removeRoom).not.toHaveBeenCalled()
    ask = screen.getByRole('alertdialog')
    expect(ask).toHaveTextContent('결제 리팩터링')
    await act(async () => { fireEvent.click(within(ask).getByRole('button', { name: '지우기' })) })
    await settle()
    expect(api.removeRoom).toHaveBeenCalledWith('r1')
    expect(screen.getByRole('heading', { name: '방 2' })).toBeInTheDocument()
    noPcCalls()
  })

  it('방 이름 바꾸기 — 판의 ⋯ → 이름 칸 → renameRoom', async () => {
    await renderPhone()
    fireEvent.click(screen.getByRole('button', { name: /두레 개발/ }))
    await settle()
    fireEvent.click(screen.getByRole('button', { name: '방 메뉴' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '방 이름 바꾸기' }))
    const dlg = screen.getByRole('dialog', { name: '방 이름 바꾸기' })
    fireEvent.change(within(dlg).getByRole('textbox', { name: '방 이름' }), { target: { value: '두레 앱' } })
    await act(async () => { fireEvent.click(within(dlg).getByRole('button', { name: '저장' })) })
    await settle()
    expect(api.renameRoom).toHaveBeenCalledWith('r3', '두레 앱')
    expect(heading()).toHaveTextContent('두레 앱')
  })
})

describe('MobileApp — 할 일', () => {
  it('넘기기 승인 — 할 일 화면에서 approveMessage', async () => {
    snapshot.messages = [msg('m1', 'a2', 'a1', 'pending')]
    await renderPhone()
    fireEvent.click(within(screen.getByRole('region', { name: /^방/ })).getByRole('button', { name: /결제 리팩터링/ }))
    await settle()
    fireEvent.click(screen.getByRole('button', { name: /할 일 1/ }))
    await settle()
    expect(heading()).toHaveTextContent('할 일')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '일 시키기' })) })
    await settle()
    expect(api.approveMessage).toHaveBeenCalledWith('m1')
    fireEvent.click(back())
    await settle()
    expect(heading()).toHaveTextContent('결제 리팩터링')
    noPcCalls()
  })
})

describe('MobileApp — 할 일 수', () => {
  it("이름은 '할 일' 하나 · 수는 방 목록 · 방 줄 · 판 · 할 일 화면이 같고 PC 의 할 일 수와 같다(승인·질문 하나하나 · 넘기는 메시지 · 이어 보내기 묶음)", async () => {
    snapshot.agents = snapshot.agents.map(a => (a.id === 'a1' ? { ...a, status: 'awaiting' } : a))
    snapshot.requests = [req('q1', 'a1'), req('q2', 'a1', 'question', 6)]
    snapshot.messages = [msg('m1', 'a1', 'a2', 'pending'), msg('m2', 'a2', 'a1', 'held', 11), msg('m3', 'a2', 'a1', 'held', 12)]
    const { todoCounts, roomTotal } = await import('../../src/renderer/state/attention')
    const pc = roomTotal(todoCounts(snapshot).rooms.r1)
    expect(pc).toBe(4) // 승인·질문 2 + 넘기는 메시지 1 + 이어 보내기 묶음 1
    await renderPhone()
    // 방 목록 — 줄은 에이전트마다 둘(백엔드·프론트)이지만 수는 할 일 수
    const todo = screen.getByRole('region', { name: /^할 일/ })
    expect(within(todo).getAllByRole('button')).toHaveLength(2)
    expect(within(todo).getByRole('heading')).toHaveTextContent(`할 일 ${pc}`)
    const pay = within(screen.getByRole('region', { name: /^방/ })).getByRole('button', { name: /결제 리팩터링/ })
    expect(pay).toHaveTextContent(`할 일 ${pc}`)
    expect(screen.queryByText(/기다리는 일|기다림|받은 일/)).toBeNull()
    // 판
    fireEvent.click(pay)
    await settle()
    const btn = screen.getByRole('button', { name: `할 일 ${pc}` })
    expect(screen.queryByText(/받은 일/)).toBeNull()
    // 할 일 화면
    fireEvent.click(btn)
    await settle()
    expect(heading()).toHaveTextContent(`할 일 ${pc}`)
    expect(screen.queryByText(/받은 일/)).toBeNull()
  })
})

describe('MobileApp — 설정 판의 오류', () => {
  async function openSheet() {
    const r = await renderPhone()
    fireEvent.click(screen.getByRole('button', { name: /결제 리팩터링/ }))
    await settle()
    fireEvent.click(card(r.container, 'a1'))
    await settle()
    fireEvent.click(screen.getByRole('button', { name: '에이전트 설정' }))
    await settle()
    return screen.getByRole('dialog', { name: '백엔드 설정' })
  }

  it('판을 닫는 일(재우기 등)이 뒤에 실패하면 — 대화 머리의 오류 줄에(닫힌 판 안이 아니라)', async () => {
    api.sleepBlock.mockResolvedValue(null)
    api.sleep.mockRejectedValue(new Error('재우지 못했어요 — 다시 해 주세요'))
    const sheet = await openSheet()
    await act(async () => { fireEvent.click(within(sheet).getByRole('button', { name: '지금 재우기' })) })
    await settle()
    expect(screen.queryByRole('dialog', { name: '백엔드 설정' })).toBeNull()
    expect(screen.getByRole('alert')).toHaveTextContent('재우지 못했어요 — 다시 해 주세요')
    expect(screen.getByRole('alert').closest('.m-agent')).not.toBeNull()
  })

  it('판 안에서 난 오류는 판에 · 판을 다시 열면 지난 오류는 없다', async () => {
    api.interrupt.mockRejectedValue(new Error('멈추지 못했어요'))
    snapshot.agents = snapshot.agents.map(a => (a.id === 'a1' ? { ...a, status: 'working' } : a))
    let sheet = await openSheet()
    await act(async () => { fireEvent.click(within(sheet).getByRole('button', { name: '멈추기' })) })
    await settle()
    sheet = screen.getByRole('dialog', { name: '백엔드 설정' })
    expect(within(sheet).getByRole('alert')).toHaveTextContent('멈추지 못했어요')
    fireEvent.click(within(sheet).getByRole('button', { name: '닫기' }))
    await settle()
    fireEvent.click(screen.getByRole('button', { name: '에이전트 설정' }))
    await settle()
    sheet = screen.getByRole('dialog', { name: '백엔드 설정' })
    expect(within(sheet).queryByRole('alert')).toBeNull()
  })
})

describe('AgentMenu — 휴대폰', () => {
  it('폴더 열기 · 대화 내보내기는 숨긴다(PC 의 탐색기·저장 창)', async () => {
    const { container } = await renderPhone()
    fireEvent.click(screen.getByRole('button', { name: /결제 리팩터링/ }))
    await settle()
    fireEvent.click(card(container, 'a1'))
    await settle()
    fireEvent.click(screen.getByRole('button', { name: '에이전트 설정' }))
    await settle()
    const sheet = screen.getByRole('dialog', { name: '백엔드 설정' })
    expect(within(sheet).getByRole('button', { name: '이름·역할 바꾸기' })).toBeInTheDocument()
    expect(within(sheet).queryByRole('button', { name: '폴더 열기' })).toBeNull()
    expect(within(sheet).queryByRole('button', { name: '대화 내보내기' })).toBeNull()
  })

  it('PC 창의 메뉴는 그대로 — 폴더 열기 · 대화 내보내기가 있다', async () => {
    delete (window as any).dure.uploadFile
    delete (window as any).dure[PHONE]
    const { AgentMenu } = await import('../../src/renderer/panel/AgentMenu')
    render(<AgentMenu agent={agent('a1')} onEdit={() => {}} onError={() => {}} onNotice={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: '메뉴' }))
    expect(screen.getByRole('menuitem', { name: '폴더 열기' })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: '대화 내보내기' })).toBeInTheDocument()
  })
})

describe('MobileApp — 두레 앱(안드로이드)으로 쓰기 · 앱 업데이트 띠', () => {
  const ANDROID_CHROME = 'Mozilla/5.0 (Linux; Android 15; SM-S921N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Mobile Safari/537.36'
  const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'
  const PC = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36'
  const STEER = '두레 앱으로 쓰면 알림에 주소가 안 붙어요.'
  const UPDATE = '앱 업데이트가 있어요'
  let pcApp: { versionCode: number; packageName: string } | null
  let me: ReturnType<typeof vi.fn>

  const as = (ua: string, referrer = '') => {
    Object.defineProperty(navigator, 'userAgent', { value: ua, configurable: true })
    Object.defineProperty(document, 'referrer', { value: referrer, configurable: true })
  }
  /** 웹앱 설치 권유 — 진입점처럼 막기를 걸고 크롬이 권유를 보낸 것처럼 */
  const installPrompt = async () => {
    const { blockInstallPrompt } = await import('../../src/renderer/mobile/androidApp')
    const t = new EventTarget()
    blockInstallPrompt(t)
    const e = new Event('beforeinstallprompt', { cancelable: true })
    t.dispatchEvent(e)
    return e
  }

  beforeEach(() => {
    sessionStorage.clear()
    pcApp = { versionCode: 3, packageName: 'io.github.choiy4432.dure' }
    me = vi.fn(async (u: string) =>
      String(u).endsWith('/api/me')
        ? new Response(JSON.stringify({ ok: true, device: { id: 'd', name: '내 휴대폰', createdAt: 1, lastSeen: 1, push: false }, androidApp: pcApp }), { status: 200 })
        : new Response(null, { status: 404 }),
    )
    vi.stubGlobal('fetch', me)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    delete (navigator as any).userAgent
    delete (document as any).referrer
  })

  it('안드로이드 크롬(앱 밖) — 웹앱 설치 권유를 막고, 방 목록 위 띠: [두레 앱으로 열기] = intent 링크(앱이 없으면 /dure.apk)', async () => {
    as(ANDROID_CHROME)
    expect((await installPrompt()).defaultPrevented).toBe(true)
    await renderPhone()
    const band = await screen.findByRole('region', { name: '두레 앱으로 쓰기' })
    expect(band).toHaveTextContent(STEER)
    const open = within(band).getByRole('link', { name: '두레 앱으로 열기' })
    expect(open.getAttribute('href')).toBe(
      `intent://${location.host}/mobile.html#Intent;scheme=https;package=io.github.choiy4432.dure;S.browser_fallback_url=${encodeURIComponent(`${location.origin}/dure.apk`)};end`,
    )
    // 띠는 방 목록 위
    const rooms = screen.getByRole('region', { name: /^방/ })
    expect(band.compareDocumentPosition(rooms) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(screen.queryByText(UPDATE)).toBeNull()
  })

  it('시험 빌드의 앱(패키지 .test)이면 그 패키지로 연다 — /api/me 가 알려 준 대로', async () => {
    pcApp = { versionCode: 3, packageName: 'io.github.choiy4432.dure.test' }
    as(ANDROID_CHROME)
    await renderPhone()
    const open = await screen.findByRole('link', { name: '두레 앱으로 열기' })
    expect(open.getAttribute('href')).toContain(';package=io.github.choiy4432.dure.test;')
  })

  it('[나중에] — 이번 세션 동안 접는다(다시 그려도 안 보임)', async () => {
    as(ANDROID_CHROME)
    const first = await renderPhone()
    fireEvent.click(await screen.findByRole('button', { name: '나중에' }))
    expect(screen.queryByText(STEER)).toBeNull()
    first.unmount()
    vi.resetModules()
    await renderPhone()
    await settle()
    expect(screen.queryByText(STEER)).toBeNull()
  })

  it('PC 에 앱 파일이 없으면(androidApp null) 띠 없음', async () => {
    pcApp = null
    as(ANDROID_CHROME)
    await renderPhone()
    await settle()
    expect(me).toHaveBeenCalled()
    expect(screen.queryByText(STEER)).toBeNull()
    expect(screen.queryByRole('region', { name: '두레 앱으로 쓰기' })).toBeNull()
  })

  it('아이폰 · PC 브라우저 — 설치 권유 그대로 · 띠 없음(/api/me 도 묻지 않는다)', async () => {
    for (const ua of [IPHONE, PC]) {
      as(ua)
      expect((await installPrompt()).defaultPrevented, ua).toBe(false)
      const r = await renderPhone()
      await settle()
      expect(screen.queryByText(STEER)).toBeNull()
      expect(screen.queryByText(UPDATE)).toBeNull()
      r.unmount()
      vi.resetModules()
    }
    expect(me).not.toHaveBeenCalled()
  })

  it('앱 안 — 설치 권유·크롬 띠 없음 · PC 판이 앱 판보다 크면 앱 업데이트 띠 [받기] = /dure.apk', async () => {
    as(ANDROID_CHROME, 'android-app://io.github.choiy4432.dure/')
    sessionStorage.setItem('dure:app', '2')
    expect((await installPrompt()).defaultPrevented).toBe(false)
    await renderPhone()
    const band = await screen.findByRole('region', { name: '앱 업데이트' })
    expect(band).toHaveTextContent(UPDATE)
    expect(within(band).getByRole('link', { name: '받기' }).getAttribute('href')).toBe('/dure.apk')
    expect(within(band).queryByRole('button', { name: '나중에' })).toBeNull()
    expect(screen.queryByText(STEER)).toBeNull()
  })

  it('앱 안 — 판이 같거나 앱이 판을 안 알렸으면 업데이트 띠 없음', async () => {
    for (const stored of ['3', null]) {
      sessionStorage.clear()
      if (stored) sessionStorage.setItem('dure:app', stored)
      as(ANDROID_CHROME, 'android-app://io.github.choiy4432.dure/')
      const r = await renderPhone()
      await settle()
      expect(screen.queryByText(UPDATE), String(stored)).toBeNull()
      expect(screen.queryByText(STEER)).toBeNull()
      r.unmount()
      vi.resetModules()
    }
  })

  describe("앱 안 — 알림 허락을 아직 안 물었으면 '알림을 켜야 휴대폰으로 알림이 와요' [켜기]", () => {
    const NOTIFY = '알림을 켜야 휴대폰으로 알림이 와요'
    let notif: { permission: NotificationPermission; requestPermission: ReturnType<typeof vi.fn> }
    let answer: NotificationPermission
    let reg: { pushManager: { getSubscription: ReturnType<typeof vi.fn>; subscribe: ReturnType<typeof vi.fn> } }

    beforeEach(() => {
      answer = 'granted'
      notif = {
        permission: 'default',
        requestPermission: vi.fn(async () => {
          notif.permission = answer
          return answer
        }),
      }
      vi.stubGlobal('Notification', notif)
      vi.stubGlobal('PushManager', function PushManager() {})
      reg = {
        pushManager: {
          getSubscription: vi.fn(async () => null),
          subscribe: vi.fn(async () => ({ toJSON: () => ({ endpoint: 'https://push.example/s1', keys: { p256dh: 'p', auth: 'a' } }) })),
        },
      }
      Object.defineProperty(navigator, 'serviceWorker', { value: { register: vi.fn(async () => reg), ready: Promise.resolve(reg) }, configurable: true })
      // /api/me 는 위 그대로 · 알림 켜기 흐름의 /api/vapid → /api/subscribe
      const base = me.getMockImplementation() as (u: string) => Promise<Response>
      me.mockImplementation(async (u: string) =>
        String(u).endsWith('/api/vapid') ? new Response(JSON.stringify({ ok: true, publicKey: 'AQAB' }), { status: 200 })
          : String(u).endsWith('/api/subscribe') ? new Response(JSON.stringify({ ok: true }), { status: 200 })
            : base(u),
      )
    })
    afterEach(() => {
      delete (navigator as any).serviceWorker
    })
    const subscribed = () => me.mock.calls.filter(c => String(c[0]).endsWith('/api/subscribe')).length

    it('앱 안 + 허락 전(default) — 띠가 보이고, [켜기] = 알림 켜기 흐름(앱 안에서 허락을 묻고 구독) → 허락하면 띠가 숨는다', async () => {
      as(ANDROID_CHROME, 'android-app://io.github.choiy4432.dure/')
      sessionStorage.setItem('dure:app', '3')
      await renderPhone()
      const band = await screen.findByRole('region', { name: '휴대폰 알림' })
      expect(band).toHaveTextContent(NOTIFY)
      expect(band).toHaveClass('m-appband') // 시안 phone-a 의 띠 모양 그대로
      // 띠는 방 목록 위
      expect(band.compareDocumentPosition(screen.getByRole('region', { name: /^방/ })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
      expect(screen.queryByText(STEER)).toBeNull()
      const on = within(band).getByRole('button', { name: '켜기' })
      fireEvent.click(on)
      // 켜는 동안 — 글이 바뀌고(흐려지지 않음) 두 번 눌러도 한 번만
      expect(on).toHaveTextContent('켜는 중…')
      expect(on).toHaveAttribute('aria-busy', 'true')
      expect(on).not.toBeDisabled()
      fireEvent.click(on)
      await vi.waitFor(() => expect(screen.queryByText(NOTIFY)).toBeNull())
      expect(notif.requestPermission).toHaveBeenCalledTimes(1)
      expect(reg.pushManager.subscribe).toHaveBeenCalledTimes(1)
      expect(subscribed()).toBe(1)
      expect(screen.getByText('알림을 켰어요')).toBeInTheDocument()
    })

    it('[켜기]에서 막으면(denied) 띠가 숨고 막힘 안내', async () => {
      answer = 'denied'
      as(ANDROID_CHROME, 'android-app://io.github.choiy4432.dure/')
      await renderPhone()
      fireEvent.click(within(await screen.findByRole('region', { name: '휴대폰 알림' })).getByRole('button', { name: '켜기' }))
      await vi.waitFor(() => expect(screen.queryByText(NOTIFY)).toBeNull())
      expect(screen.getByRole('alert')).toHaveTextContent('알림이 막혀 있어요')
      expect(subscribed()).toBe(0)
    })

    it("⋯ 메뉴의 '휴대폰 알림 켜기'로 켜도 띠가 숨는다(같은 흐름)", async () => {
      as(ANDROID_CHROME, 'android-app://io.github.choiy4432.dure/')
      await renderPhone()
      await screen.findByRole('region', { name: '휴대폰 알림' })
      fireEvent.click(screen.getByRole('button', { name: '메뉴' }))
      fireEvent.click(screen.getByRole('menuitem', { name: '휴대폰 알림 켜기' }))
      await vi.waitFor(() => expect(screen.queryByText(NOTIFY)).toBeNull())
      expect(notif.requestPermission).toHaveBeenCalledTimes(1)
    })

    it('앱 안이라도 이미 허락했거나 막았으면 없음', async () => {
      for (const permission of ['granted', 'denied'] as const) {
        notif.permission = permission
        as(ANDROID_CHROME, 'android-app://io.github.choiy4432.dure/')
        const r = await renderPhone()
        await settle()
        expect(screen.queryByText(NOTIFY), permission).toBeNull()
        r.unmount()
        vi.resetModules()
      }
    })

    it('앱 밖(안드로이드 크롬) · 아이폰 · PC 브라우저 — 허락 전이어도 없음', async () => {
      for (const ua of [ANDROID_CHROME, IPHONE, PC]) {
        as(ua)
        const r = await renderPhone()
        await settle()
        expect(screen.queryByText(NOTIFY), ua).toBeNull()
        expect(screen.queryByRole('region', { name: '휴대폰 알림' }), ua).toBeNull()
        r.unmount()
        vi.resetModules()
      }
      // 크롬(앱 밖)은 '두레 앱으로 쓰기' 띠 몫이다
      as(ANDROID_CHROME)
      await renderPhone()
      expect(await screen.findByText(STEER)).toBeInTheDocument()
      expect(screen.queryByText(NOTIFY)).toBeNull()
      expect(notif.requestPermission).not.toHaveBeenCalled()
    })
  })

  it('/api/me 의 패키지가 두레 것이 아니면 띠 없음(남의 앱을 여는 intent 를 만들지 않는다)', async () => {
    pcApp = { versionCode: 3, packageName: 'com.evil.app' }
    as(ANDROID_CHROME)
    await renderPhone()
    await settle()
    expect(me).toHaveBeenCalled()
    expect(screen.queryByText(STEER)).toBeNull()
  })
})
