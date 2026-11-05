import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { render, screen, act, fireEvent, cleanup, within } from '@testing-library/react'
import type { RelayMessage, PendingRequest } from '../../src/engine/types'
import type { AgentView, Snapshot } from '../../src/shared/ipcContract'
import { APP_METHODS, METHODS } from '../../src/shared/ipcContract'
import { PHONE_ACCESS, PHONE_DENIED } from '../../src/shared/phoneAccess'

// 휴대폰 화면(MobileApp) — 방 고르기 → 카드 판 → 대화. window.dure 는 휴대폰 것(wsApi)처럼: uploadFile 이 있고 pathForFile 은 늘 '',
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
    expect(screen.getByRole('status')).toHaveTextContent('다시 잇는 중…')
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
  it('기다리는 일 — 에이전트마다 한 줄, 누르면 그 대화로 바로(‹ 는 방 목록)', async () => {
    snapshot.agents = snapshot.agents.map(a => (a.id === 'a1' ? { ...a, status: 'awaiting' } : a.id === 'b1' ? { ...a, remoteIssue: { kind: 'disconnected', detail: null } } : a))
    snapshot.requests = [req('q1', 'a1'), req('q2', 'a1', 'question', 6)]
    snapshot.messages = [msg('m1', 'a1', 'a2', 'pending')]
    await renderPhone()
    const waiting = screen.getByRole('region', { name: /기다리는 일/ })
    const rows = within(waiting).getAllByRole('button')
    expect(rows.map(r => r.textContent)).toEqual([
      expect.stringContaining('백엔드 승인을 기다려요'),
      expect.stringContaining('프론트 넘기기 승인을 기다려요'),
      expect.stringContaining('실험 서버 연결이 끊겼어요'),
    ])
    expect(within(waiting).getByText('3')).toBeInTheDocument()
    fireEvent.click(rows[0])
    await settle()
    expect(heading()).toHaveTextContent('백엔드')
    fireEvent.click(back())
    await settle()
    expect(screen.getByRole('heading', { name: '방 3' })).toBeInTheDocument()
  })

  it('방 줄 — 에이전트 수 · 일하는 중 · 기다림, 서버 방만 서버 표시', async () => {
    snapshot.agents = snapshot.agents.map(a => (a.id === 'a1' ? { ...a, status: 'working' } : a))
    snapshot.requests = [req('q1', 'a2')]
    await renderPhone()
    // 방 줄(기다리는 일 줄에도 방 이름이 있다)
    const pay = within(screen.getByRole('region', { name: /^방/ })).getByRole('button', { name: /결제 리팩터링/ })
    expect(pay).toHaveTextContent('에이전트 2개')
    expect(pay).toHaveTextContent('일하는 중 1')
    expect(pay).toHaveTextContent('기다림 1')
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
    expect(screen.getByRole('status')).toHaveTextContent(/다시 잇는 중… .+ 에 받은 내용이에요/)
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

describe('MobileApp — 받은 일', () => {
  it('넘기기 승인 — 받은 일에서 approveMessage', async () => {
    snapshot.messages = [msg('m1', 'a2', 'a1', 'pending')]
    await renderPhone()
    fireEvent.click(within(screen.getByRole('region', { name: /^방/ })).getByRole('button', { name: /결제 리팩터링/ }))
    await settle()
    fireEvent.click(screen.getByRole('button', { name: /받은 일 1/ }))
    await settle()
    expect(heading()).toHaveTextContent('받은 일')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '일 시키기' })) })
    await settle()
    expect(api.approveMessage).toHaveBeenCalledWith('m1')
    fireEvent.click(back())
    await settle()
    expect(heading()).toHaveTextContent('결제 리팩터링')
    noPcCalls()
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
    const { AgentMenu } = await import('../../src/renderer/panel/AgentMenu')
    render(<AgentMenu agent={agent('a1')} onEdit={() => {}} onError={() => {}} onNotice={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: '메뉴' }))
    expect(screen.getByRole('menuitem', { name: '폴더 열기' })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: '대화 내보내기' })).toBeInTheDocument()
  })
})
