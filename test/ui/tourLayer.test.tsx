import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act, cleanup, fireEvent, within } from '@testing-library/react'
import type { AgentView, Snapshot } from '../../src/shared/ipcContract'
import type { AppPrefs, SetupState } from '../../src/shared/appTypes'
import type { PendingRequest } from '../../src/engine/types'
import type { TourState, TourStepId } from '../../src/renderer/tour/tourSteps'
import { allowMotion } from './motion'

const agent = (id: string, over: Partial<AgentView> = {}): AgentView => ({
  id, roomId: 'r1', name: id, role: '역할', folder: 'C:/w', sessionId: 's', started: true, auto: false, model: null,
  alwaysAllow: [], pos: { x: 0, y: 0 }, color: null, effort: null, lastContext: null, bypassOn: false, effortNow: null, modelNow: null, status: 'idle', errorText: null, bypass: false, bypassBySettings: false, bypassPending: false, heldInput: 0, planMode: false, asleep: false, waking: false, hold: null, subagentsRunning: [], pastCount: 0, remoteIssue: null, ...over,
})
const ROOM = { id: 'r1', name: '여름 캠페인', createdAt: 1 }
const ask = (agentId: string, kind: PendingRequest['kind'] = 'permission'): PendingRequest => ({
  id: `q-${agentId}`, agentId, toolName: 'Write', input: { file_path: 'a.txt' }, kind, createdAt: 1,
})

let snapshot: Snapshot
let prefs: AppPrefs
let setupState: SetupState
let setPrefs: ReturnType<typeof vi.fn>
const placed: HTMLElement[] = []

beforeEach(() => {
  vi.resetModules()
  snapshot = {
    claudeMissing: false, rooms: [], agents: [], messages: [], requests: [], autoChainLimit: 3, allowBypass: false,
    notify: { asks: true, finished: false }, sleepAfterMin: 30, usage: null,
  }
  prefs = { tourDone: false, approvalTipSeen: true, claudeAutoUpdate: true }
  setupState = { phase: 'ready' }
  setPrefs = vi.fn(async (p: Partial<AppPrefs>) => (prefs = { ...prefs, ...p }))
  ;(window as any).dure = {
    snapshot: async () => snapshot, history: async () => [], on: () => () => {}, setSelected: async () => {},
    appInfo: async () => ({ version: '0.1.0', packaged: false }), prefs: async () => prefs, setPrefs,
    setupState: async () => setupState, updateState: async () => ({ kind: 'idle' }), claudeUpdateState: async () => 'idle',
  }
})
afterEach(() => {
  cleanup()
  placed.splice(0).forEach(el => el.remove())
})

type Box = { left: number; top: number; width: number; height: number }
/** 화면 시험엔 배치가 없다 — 사각형을 정해 준다 */
function rect(el: Element, b: Box) {
  el.getBoundingClientRect = () =>
    ({ x: b.left, y: b.top, left: b.left, top: b.top, width: b.width, height: b.height, right: b.left + b.width, bottom: b.top + b.height, toJSON() {} }) as DOMRect
}
/** 짚을 요소 하나(data-tour) — parent 가 없으면 문서에 바로 붙인다 */
function place(tour: string, b: Box, opts: { tag?: string; parent?: HTMLElement } = {}): HTMLElement {
  const el = document.createElement(opts.tag ?? 'button')
  el.dataset.tour = tour
  el.textContent = tour
  rect(el, b)
  if (opts.parent) opts.parent.appendChild(el)
  else {
    document.body.appendChild(el)
    placed.push(el)
  }
  return el
}
function plain(tag: string): HTMLElement {
  const el = document.createElement(tag)
  document.body.appendChild(el)
  placed.push(el)
  return el
}

type Dialog = 'room' | 'agent' | 'settings' | null
async function mount(dialog: Dialog = null) {
  const { getStore } = await import('../../src/renderer/state/store')
  const { TourLayer } = await import('../../src/renderer/tour/TourLayer')
  await act(async () => { await getStore().init() })
  await act(async () => { await new Promise(r => setTimeout(r, 0)) }) // 앱 상태(설정·준비)까지
  const r = render(<TourLayer dialog={dialog} />)
  return { ...r, store: getStore(), show: (d: Dialog) => r.rerender(<TourLayer dialog={d} />) }
}
const at = (step: TourStepId, base: Partial<NonNullable<TourState>['base']> = {}, replay = false): NonNullable<TourState> => ({
  step, replay, base: { rooms: 0, agents: 0, sent: 0, ...base },
})
const card = () => document.querySelector<HTMLElement>('.tour-card')
const veils = () => Array.from(document.querySelectorAll<HTMLElement>('.tour-veil'))
const spot = () => document.querySelector<HTMLElement>('.tour-spot')
const box = (el: HTMLElement): Box => ({
  left: parseFloat(el.style.left), top: parseFloat(el.style.top), width: parseFloat(el.style.width), height: parseFloat(el.style.height),
})
const wait = (ms: number) => act(async () => { await new Promise(r => setTimeout(r, ms)) })
/** 방 하나 · 에이전트 a — 이미 쓰던 사람(투어가 저절로 뜨지 않는다) */
function withAgent() {
  snapshot.rooms = [ROOM]
  snapshot.agents = [agent('a')]
  prefs = { ...prefs, tourDone: true }
}

describe('TourLayer — 환영', () => {
  it('화면 전체 막 + 카드(번호 없음), 초점은 [시작하기] · 나중에 볼게요 → endTour', async () => {
    const { store } = await mount()
    expect(store.getState().tour?.step).toBe('welcome')
    const dlg = screen.getByRole('dialog', { name: '두레에 오신 걸 환영해요' })
    expect(dlg.textContent).toContain('여러 Claude 에이전트가 한 방에서 일을 주고받아요.')
    expect(veils()).toHaveLength(1)
    expect(spot()).toBeNull()
    expect(document.querySelector('.tour-n')).toBeNull()
    expect(document.querySelector('.tour-bar')).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '시작하기' }))
    fireEvent.click(screen.getByRole('button', { name: '나중에 볼게요' }))
    expect(store.getState().tour).toBeNull()
    expect(setPrefs).toHaveBeenCalledWith({ tourDone: true })
    expect(card()).toBeNull()
    expect(veils()).toHaveLength(0)
  })

  it('[시작하기] → 방 단계', async () => {
    place('new-room', { left: 100, top: 200, width: 80, height: 32 })
    const { store } = await mount()
    fireEvent.click(screen.getByRole('button', { name: '시작하기' }))
    expect(store.getState().tour?.step).toBe('room')
    expect(screen.getByRole('dialog', { name: '방을 만들어 보세요' })).toBeTruthy()
  })

  it('Tab 은 카드 안에서 돈다', async () => {
    await mount()
    const start = screen.getByRole('button', { name: '시작하기' })
    const later = screen.getByRole('button', { name: '나중에 볼게요' })
    fireEvent.keyDown(start, { key: 'Tab' })
    expect(document.activeElement).toBe(later)
    fireEvent.keyDown(later, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(start)
  })
})

describe('TourLayer — 짚기', () => {
  it('room 단계 — 구멍은 new-room 사각형 + 6px, 막 네 칸이 둘레를 덮고 카드는 아래', async () => {
    place('new-room', { left: 100, top: 200, width: 80, height: 32 })
    const { store } = await mount()
    act(() => store.tourNext())
    expect(store.getState().tour?.step).toBe('room')
    expect(box(spot()!)).toEqual({ left: 94, top: 194, width: 92, height: 44 })
    const W = window.innerWidth
    const H = window.innerHeight
    expect(veils().map(box)).toEqual([
      { left: 0, top: 0, width: W, height: 194 },
      { left: 0, top: 238, width: W, height: H - 238 },
      { left: 0, top: 194, width: 94, height: 44 },
      { left: 186, top: 194, width: W - 186, height: 44 },
    ])
    const c = screen.getByRole('dialog', { name: '방을 만들어 보세요' })
    expect(c.style.top).toBe('250px') // 구멍 아래 12px
    expect(within(c).getByText('1 / 8')).toBeTruthy()
    expect(document.querySelector<HTMLElement>('.tour-bar i')!.style.width).toBe('12.5%')
    expect(within(c).getByText('방을 만들면 넘어가요')).toBeTruthy()
    expect(within(c).queryByRole('button', { name: '확인했어요' })).toBeNull()
    expect(within(c).getByRole('button', { name: '투어 끝내기' })).toBeTruthy()
    // do 단계 — 초점은 카드 자체
    expect(document.activeElement).toBe(c)
  })

  it('창 가장자리에 붙은 요소 — 구멍은 창 안쪽 2px 까지(테가 다 보이게)', async () => {
    const W = window.innerWidth
    const H = window.innerHeight
    place('new-room', { left: W - 100, top: H - 40, width: 100, height: 40 })
    const { store } = await mount()
    act(() => store.tourNext())
    expect(box(spot()!)).toEqual({ left: W - 106, top: H - 46, width: 104, height: 44 })
  })

  it('한동안 그대로였어도 창 크기가 바뀌면 바로 다시 잰다', async () => {
    const el = place('new-room', { left: 100, top: 200, width: 80, height: 32 })
    const { store } = await mount()
    act(() => store.tourNext())
    await wait(1300) // 띄엄띄엄 재는 때로 넘어간다
    rect(el, { left: 300, top: 400, width: 80, height: 32 })
    act(() => { window.dispatchEvent(new Event('resize')) })
    await wait(60)
    expect(box(spot()!)).toEqual({ left: 294, top: 394, width: 92, height: 44 })
  })

  it('do 단계 — 구멍 밖 누르기는 겹이 받고(앱에 닿지 않음), 구멍엔 막는 판이 없다', async () => {
    place('new-room', { left: 100, top: 200, width: 80, height: 32 })
    const { store } = await mount()
    act(() => store.tourNext())
    expect(veils()).toHaveLength(4)
    for (const v of veils()) expect(fireEvent.mouseDown(v)).toBe(false)
    expect(document.querySelector('.tour-block')).toBeNull()
    expect(document.activeElement).toBe(card())
  })

  it('ok 단계 — 구멍도 막히고 [확인했어요] → tourNext', async () => {
    withAgent()
    place('agent-card', { left: 300, top: 260, width: 256, height: 136 }, { tag: 'div' })
    const { store } = await mount()
    act(() => {
      store.selectAgent('a')
      store.setTour(at('card', { rooms: 1, agents: 1 }))
    })
    expect(screen.getByRole('dialog', { name: '에이전트 카드' })).toBeTruthy()
    expect(box(document.querySelector<HTMLElement>('.tour-block')!)).toEqual({ left: 294, top: 254, width: 268, height: 148 })
    const ok = screen.getByRole('button', { name: '확인했어요' })
    expect(document.activeElement).toBe(ok)
    fireEvent.click(ok)
    expect(store.getState().tour?.step).toBe('composer')
  })

  it('짚을 요소가 없으면 그 단계를 건너뛴다(ok) — 1초 넘게 없을 때', async () => {
    withAgent()
    const { store } = await mount()
    act(() => store.setTour(at('todo', { rooms: 1, agents: 1 })))
    await wait(300)
    expect(store.getState().tour?.step).toBe('todo')
    await wait(900)
    expect(store.getState().tour?.step).toBe('settings-open')
  })

  it('do 단계는 짚을 요소가 없어도 기다린다', async () => {
    const { store } = await mount()
    act(() => store.tourNext())
    await wait(1200)
    expect(store.getState().tour?.step).toBe('room')
    expect(screen.getByRole('dialog', { name: '방을 만들어 보세요' })).toBeTruthy()
  })

  it('화면 밖 요소는 한 번 scrollIntoView({block: nearest})', async () => {
    const el = place('new-room', { left: 100, top: 900, width: 80, height: 32 })
    const scroll = vi.fn()
    el.scrollIntoView = scroll
    const { store } = await mount()
    act(() => store.tourNext())
    await wait(250) // 자리를 잡은 뒤(몇 프레임 그대로) 본다
    expect(scroll).toHaveBeenCalledTimes(1)
    expect(scroll).toHaveBeenCalledWith({ block: 'nearest' })
  })

  it('고른 에이전트 카드가 관계도 밖이면 focusAgent 로 옮겨 달라고 한다(한 번)', async () => {
    withAgent()
    const flow = plain('div')
    flow.className = 'react-flow'
    rect(flow, { left: 0, top: 48, width: 600, height: 700 })
    place('agent-card', { left: 700, top: 300, width: 256, height: 136 }, { tag: 'div', parent: flow })
    const { store } = await mount()
    act(() => {
      store.selectAgent('a')
      store.setTour(at('card', { rooms: 1, agents: 1 }))
    })
    await wait(250) // 자리를 잡은 뒤(몇 프레임 그대로) 본다
    expect(store.getState().mapFocus).toEqual({ agentId: 'a', n: 1 })
    await wait(120)
    expect(store.getState().mapFocus?.n).toBe(1)
  })
})

describe('TourLayer — 진행', () => {
  it('에이전트가 생기면 그 에이전트를 고르고 카드 단계로(tourAdvance 의 select)', async () => {
    withAgent()
    snapshot.agents = []
    place('add-agent', { left: 400, top: 300, width: 60, height: 32 })
    const { store } = await mount()
    act(() => store.setTour(at('agent', { rooms: 1, agents: 0 })))
    expect(store.getState().tour?.step).toBe('agent')
    snapshot = { ...snapshot, agents: [agent('a')] }
    await act(async () => { await store.refresh() })
    expect(store.getState().tour?.step).toBe('card')
    expect(store.getState().selectedAgentId).toBe('a')
  })

  it('dialog 가 room 이면 막·카드를 숨기고, 닫히면 다시 보인다', async () => {
    place('new-room', { left: 100, top: 200, width: 80, height: 32 })
    const { store, show } = await mount()
    act(() => store.tourNext())
    show('room')
    expect(card()).toBeNull()
    expect(veils()).toHaveLength(0)
    expect(spot()).toBeNull()
    show(null)
    expect(screen.getByRole('dialog', { name: '방을 만들어 보세요' })).toBeTruthy()
    expect(veils()).toHaveLength(4)
  })

  it('준비가 안 됐으면(준비 화면) 겹 전체를 숨긴다 — 투어는 그대로', async () => {
    setupState = { phase: 'needs', install: { state: 'done', version: '2' }, login: { state: 'todo' } }
    const { store } = await mount()
    act(() => store.startTour(false))
    expect(store.getState().tour?.step).toBe('welcome')
    expect(card()).toBeNull()
    expect(veils()).toHaveLength(0)
  })

  it('settings 단계 — 막 없이 설정 창 오른쪽에 카드만, [확인했어요]는 카드만 닫고 창을 닫으면 끝으로', async () => {
    withAgent()
    const dlg = place('settings-dialog', { left: 300, top: 100, width: 420, height: 500 }, { tag: 'div' })
    dlg.textContent = ''
    const input = document.createElement('input')
    dlg.appendChild(input)
    const { store, show } = await mount('settings')
    act(() => store.setTour(at('settings', { rooms: 1, agents: 1 })))
    expect(veils()).toHaveLength(0)
    expect(spot()).toBeNull()
    expect(document.querySelector('.tour-block')).toBeNull()
    const c = screen.getByRole('dialog', { name: '설정 안에는' })
    expect(c.style.left).toBe('736px') // 창 오른쪽 + 16px
    expect(c.style.top).toBe('100px')
    expect(within(c).getAllByRole('listitem')).toHaveLength(6)
    expect(within(c).getByText('7 / 8')).toBeTruthy()
    fireEvent.click(within(c).getByRole('button', { name: '확인했어요' }))
    expect(card()).toBeNull()
    expect(store.getState().tour?.step).toBe('settings')
    expect(document.activeElement).toBe(input) // 초점은 설정 창으로
    show(null)
    const done = screen.getByRole('dialog', { name: '준비됐어요' })
    expect(within(done).getByText('8 / 8')).toBeTruthy()
    expect(within(done).queryByRole('button', { name: '투어 끝내기' })).toBeNull()
    fireEvent.click(within(done).getByRole('button', { name: '시작하기' }))
    expect(store.getState().tour).toBeNull()
    expect(setPrefs).toHaveBeenCalledWith({ tourDone: true })
  })

  it('settings 단계 — 오른쪽에 자리가 없으면 왼쪽', async () => {
    withAgent()
    place('settings-dialog', { left: 560, top: 100, width: 460, height: 500 }, { tag: 'div' })
    const { store } = await mount('settings')
    act(() => store.setTour(at('settings', { rooms: 1, agents: 1 })))
    expect(card()!.style.left).toBe('544px') // 창 왼쪽 − 16px − 카드 폭(시험엔 0)
  })
})

describe('TourLayer — Esc', () => {
  it('카드에 초점이 있을 때만 endTour — 설정 창에 초점이 있으면 아니다', async () => {
    withAgent()
    const dlg = place('settings-dialog', { left: 300, top: 100, width: 420, height: 500 }, { tag: 'div' })
    const input = document.createElement('input')
    dlg.appendChild(input)
    const { store } = await mount('settings')
    act(() => store.setTour(at('settings', { rooms: 1, agents: 1 })))
    input.focus()
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(store.getState().tour?.step).toBe('settings')
    const ok = screen.getByRole('button', { name: '확인했어요' })
    ok.focus()
    fireEvent.keyDown(ok, { key: 'Escape' })
    expect(store.getState().tour).toBeNull()
  })
})

describe('TourLayer — 승인 한 번', () => {
  /** 관계도 카드(React Flow 노드 data-id) 안의 승인 칸 */
  function approvalIn(agentId: string, b: Box) {
    const node = plain('div')
    node.dataset.id = agentId
    return place('approval', b, { tag: 'div', parent: node })
  }

  it('투어 위에 뜨고(승인 칸을 짚는다) [확인했어요] → setPrefs 뒤 투어로', async () => {
    withAgent()
    prefs = { ...prefs, approvalTipSeen: false }
    snapshot.requests = [ask('a')]
    approvalIn('a', { left: 300, top: 300, width: 230, height: 70 })
    place('stop', { left: 800, top: 60, width: 70, height: 32 })
    place('auto', { left: 880, top: 100, width: 60, height: 28 })
    const { store } = await mount()
    act(() => {
      store.selectAgent('a')
      store.setTour(at('controls', { rooms: 1, agents: 1 }))
    })
    const tip = screen.getByRole('dialog', { name: '승인이 필요해요' })
    expect(within(tip).getByText('처음 한 번')).toBeTruthy()
    expect(tip.textContent).toContain('파일을 만들거나 고치고, 명령을 실행하기 전엔 이렇게 물어요.')
    expect(within(tip).queryByRole('button', { name: '투어 끝내기' })).toBeNull()
    expect(screen.queryByRole('dialog', { name: '멈추기 · 자동' })).toBeNull()
    expect(box(spot()!)).toEqual({ left: 294, top: 294, width: 242, height: 82 })
    const ok = within(tip).getByRole('button', { name: '확인했어요' })
    expect(document.activeElement).toBe(ok)
    await act(async () => { fireEvent.click(ok) })
    expect(setPrefs).toHaveBeenCalledWith({ approvalTipSeen: true })
    expect(screen.queryByRole('dialog', { name: '승인이 필요해요' })).toBeNull()
    expect(screen.getByRole('dialog', { name: '멈추기 · 자동' })).toBeTruthy()
    expect(store.getState().tour?.step).toBe('controls')
  })

  it('투어가 없어도 처음 승인 칸이 뜰 때 한 번 — 승인 칸이 안 보이면 고른 에이전트 카드를 짚는다', async () => {
    withAgent()
    prefs = { ...prefs, approvalTipSeen: false }
    snapshot.requests = [ask('a')]
    place('agent-card', { left: 300, top: 260, width: 256, height: 136 }, { tag: 'div' })
    const { store } = await mount()
    act(() => store.selectAgent('a'))
    expect(store.getState().tour).toBeNull()
    expect(screen.getByRole('dialog', { name: '승인이 필요해요' })).toBeTruthy()
    expect(box(spot()!)).toEqual({ left: 294, top: 254, width: 268, height: 148 })
  })

  it('이미 봤거나 · 묻는 게 승인이 아니거나 · 대화상자가 열려 있으면 뜨지 않는다', async () => {
    withAgent()
    prefs = { ...prefs, approvalTipSeen: true }
    snapshot.requests = [ask('a')]
    const first = await mount()
    expect(screen.queryByRole('dialog', { name: '승인이 필요해요' })).toBeNull()
    first.unmount()

    vi.resetModules()
    prefs = { ...prefs, approvalTipSeen: false }
    snapshot.requests = [ask('a', 'question')]
    const second = await mount()
    expect(screen.queryByRole('dialog', { name: '승인이 필요해요' })).toBeNull()
    second.unmount()

    vi.resetModules()
    snapshot.requests = [ask('a')]
    const third = await mount('agent')
    expect(screen.queryByRole('dialog', { name: '승인이 필요해요' })).toBeNull()
    third.show(null)
    expect(screen.getByRole('dialog', { name: '승인이 필요해요' })).toBeTruthy()
  })
})

describe('TourLayer — 움직임', () => {
  it('움직임 줄이기면 기다림 점이 깜박이지 않는다', async () => {
    place('new-room', { left: 100, top: 200, width: 80, height: 32 })
    const { store } = await mount()
    act(() => store.tourNext())
    expect(document.querySelector('.tour-dot')).not.toBeNull()
    expect(document.querySelector('.tour-dot.blink')).toBeNull()
  })

  it('움직임을 켜 두면 깜박인다', async () => {
    allowMotion()
    place('new-room', { left: 100, top: 200, width: 80, height: 32 })
    const { store } = await mount()
    act(() => store.tourNext())
    expect(document.querySelector('.tour-dot.blink')).not.toBeNull()
  })
})
