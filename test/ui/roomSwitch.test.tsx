import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import '@testing-library/jest-dom/vitest'
import fs from 'node:fs'
import path from 'node:path'
import { render, screen, act, cleanup, fireEvent, within } from '@testing-library/react'

// 파워 모드의 방 단추 — 방이 둘 이상이면 단추(누르면 방 목록 메뉴 · 앱의 메뉴와 같은 층·키보드 규칙), 하나뿐이면 글만.
// 고르면 앱의 방 고르기(selectRoom) 그대로 — 파워 모드는 앱의 방을 따른다

const agent = (id: string, roomId: string, over: object = {}) => ({
  id, roomId, name: id, role: `${id}역`, folder: '/x', sessionId: '', started: true, auto: false, model: null,
  alwaysAllow: [], pos: { x: 0, y: 0 }, color: null, effort: null, effortNow: null, modelNow: null, lastContext: null, bypassOn: false, status: 'idle', errorText: null, bypass: false, bypassBySettings: false, bypassPending: false, heldInput: 0, planMode: false, asleep: false, waking: false, hold: null, subagentsRunning: [], pastCount: 0, remoteIssue: null, ...over,
})
const ROOMS = [{ id: 'r1', name: '첫 방', createdAt: 3 }, { id: 'r2', name: '둘째 방', createdAt: 2 }, { id: 'r3', name: '셋째 방', createdAt: 1 }]
const AGENTS = [agent('a', 'r1', { name: '알파' }), agent('b', 'r1', { name: '베타' }), agent('c', 'r2', { name: '감마' }), agent('d', 'r2', { name: '델타' })]

let setPowerMode: ReturnType<typeof vi.fn>

/** 덮개(PowerLayer)째로 — 층·Esc 길게가 진짜 */
async function mount(o: { rooms?: object[]; agents?: object[]; requests?: object[]; terminal?: boolean } = {}) {
  vi.resetModules()
  const rooms = o.rooms ?? ROOMS
  setPowerMode = vi.fn(async () => {})
  ;(window as any).dure = {
    snapshot: async () => ({ claudeMissing: false, rooms, agents: o.agents ?? AGENTS, messages: [], requests: o.requests ?? [], autoChainLimit: 5, allowBypass: false, notify: { asks: true, finished: false }, sleepAfterMin: 30, usage: null }),
    history: async () => [],
    prefs: async () => ({ tourDone: true, approvalTipSeen: true, claudeAutoUpdate: true, trayTipSeen: true, powerTerminal: o.terminal ?? false }),
    setPowerMode,
    setSelected: async () => {},
    on: () => () => {},
  }
  const { getStore } = await import('../../src/renderer/state/store')
  const { PowerLayer } = await import('../../src/renderer/power/PowerLayer')
  const store = getStore()
  await act(async () => { await store.init() })
  if (rooms.length) act(() => { store.selectRoom('r1') })
  await act(async () => { await store.setPower(true) })
  render(<PowerLayer />)
  return store
}
const wait = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms) })
const strip = () => (document.querySelector('.pw-room') ?? document.querySelector('.pw-t-bar')) as HTMLElement
const roomButton = () => within(strip()).getByRole('button', { name: /^방 / })
const menu = () => screen.queryByRole('menu', { name: '방 옮기기' })
const items = () => within(menu()!).getAllByRole('menuitemradio')
const openMenu = () => act(() => { roomButton().focus(); fireEvent.click(roomButton()) })

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => {
  cleanup()
  fireEvent.keyUp(window, { key: 'Escape' }) // 나가며 건 자동 반복 삼키기를 푼다
  vi.useRealTimers()
})

describe('방 단추', () => {
  it('방_1개_→_단추_없음(글만)', async () => {
    await mount({ rooms: [ROOMS[0]], agents: AGENTS.slice(0, 2) })
    expect(within(strip()).queryByRole('button')).toBeNull()
    expect(strip()).toHaveTextContent(/^방 첫 방 · 에이전트 2 · 서브에이전트 0$/)
    cleanup()
    await mount({ rooms: [], agents: [] })
    expect(within(strip()).queryByRole('button')).toBeNull()
    expect(strip()).toHaveTextContent(/^방 — · 에이전트 0/)
  })

  it('방_3개_→_메뉴에_3줄,_지금_방_aria_checked', async () => {
    await mount()
    const btn = roomButton()
    expect(btn).toHaveAccessibleName('방 첫 방')
    expect(btn).toHaveAttribute('aria-haspopup', 'menu')
    expect(btn).toHaveAttribute('aria-expanded', 'false')
    expect(strip()).toHaveTextContent(/^방 첫 방 · 에이전트 2 · 서브에이전트 0$/)
    await openMenu()
    expect(btn).toHaveAttribute('aria-expanded', 'true')
    expect(items()).toHaveLength(3)
    expect(items().map(i => i.getAttribute('aria-checked'))).toEqual(['true', 'false', 'false'])
    expect(items()[0]).toHaveTextContent('첫 방 · 에이전트 2')
    expect(items()[1]).toHaveTextContent('둘째 방 · 에이전트 2')
    expect(items()[2]).toHaveTextContent('셋째 방 · 에이전트 0')
    // 지금 방 줄에만 체크 — 열면 그 줄로 초점
    expect(items()[0].querySelector('.mi-ck')).not.toBeNull()
    expect(items()[1].querySelector('.mi-ck')).toBeNull()
    expect(document.activeElement).toBe(items()[0])
    // ↑↓ 로 오간다(앱 메뉴와 같은 규칙)
    fireEvent.keyDown(items()[0], { key: 'ArrowDown' })
    expect(document.activeElement).toBe(items()[1])
  })

  it('방_이름은_글로만_한_줄_—_이름에_든_꺾쇠가_요소가_되지_않는다', async () => {
    await mount({ rooms: [{ id: 'r1', name: '<img src=x onerror=alert(1)>', createdAt: 2 }, ROOMS[1]] })
    expect(roomButton()).toHaveAccessibleName('방 <img src=x onerror=alert(1)>')
    await openMenu()
    expect(menu()!.querySelector('img')).toBeNull()
    expect(strip().querySelector('img')).toBeNull()
    expect(items()[0]).toHaveTextContent('<img src=x onerror=alert(1)> · 에이전트 2')
  })

  it('기다리는_에이전트가_있는_방에_기다림_N', async () => {
    // 감마는 질문을 기다림(상태) · 델타는 승인 요청이 걸려 있다 — 화면의 '승인 기다림'과 같은 셈(displayStatus)
    const agents = [agent('a', 'r1', { status: 'working' }), agent('b', 'r1'), agent('c', 'r2', { status: 'awaiting' }), agent('d', 'r2', { status: 'working' })]
    await mount({ agents, requests: [{ id: 'q1', agentId: 'd', kind: 'tool', tool: 'Bash', input: {}, createdAt: 1 }] })
    await openMenu()
    const [r1, r2, r3] = items()
    expect(r2).toHaveTextContent('기다림 2')
    expect(r2.querySelector('.dot.a')).not.toBeNull()
    expect(r1).not.toHaveTextContent('기다림')
    expect(r1.querySelector('.dot')).toBeNull()
    expect(r3).not.toHaveTextContent('기다림')
  })

  it('줄을_고르면_selectRoom', async () => {
    const store = await mount()
    act(() => { store.selectAgent('a') })
    const spy = vi.spyOn(store, 'selectRoom')
    await openMenu()
    act(() => { fireEvent.click(items()[1]) })
    expect(spy).toHaveBeenCalledWith('r2')
    expect(menu()).toBeNull()
    expect(store.getState().roomId).toBe('r2')
    expect(store.getState().power).toMatchObject({ roomId: 'r2', agentIds: ['c', 'd'] })
    expect(roomButton()).toHaveAccessibleName('방 둘째 방')
    expect(document.activeElement).toBe(roomButton())
    // 고른 에이전트는 앱 규칙대로(방을 옮기면 비운다) — 옆 칸은 기록
    expect(store.getState().selectedAgentId).toBeNull()
    expect(screen.getByRole('tab', { name: '기록' })).toHaveAttribute('aria-selected', 'true')
    // 지금 방을 다시 고르면 그대로(앱의 방 목록과 같다)
    act(() => { store.selectAgent('c') })
    spy.mockClear()
    await openMenu()
    act(() => { fireEvent.click(items()[1]) })
    expect(spy).not.toHaveBeenCalled()
    expect(store.getState().selectedAgentId).toBe('c')
  })

  it('메뉴가_떠_있는_동안_Esc_길게로_파워_모드가_안_꺼지고_Esc_한_번에_메뉴만_닫힌다', async () => {
    await mount()
    await openMenu()
    expect(document.activeElement).toBe(items()[0])
    // 메뉴 안의 Esc — 메뉴만 닫고 단추로 초점. 누르고 있는 동안의 자동 반복으로도 나가지 않는다
    act(() => { fireEvent.keyDown(document.activeElement!, { key: 'Escape' }) })
    expect(menu()).toBeNull()
    expect(document.activeElement).toBe(roomButton())
    for (let i = 0; i < 20; i++) {
      act(() => { fireEvent.keyDown(document.activeElement!, { key: 'Escape', repeat: true }) })
      await wait(100)
    }
    fireEvent.keyUp(document.activeElement!, { key: 'Escape' })
    expect(setPowerMode).not.toHaveBeenCalledWith(false)
    expect(screen.getByRole('region', { name: '파워 모드' })).toBeInTheDocument()
    // 메뉴가 떠 있으면 메뉴 밖에서 누른 Esc 길게도 듣지 않는다(덮개 안의 메뉴도 떠 있는 창)
    await openMenu()
    fireEvent.keyDown(document.body, { key: 'Escape' })
    await wait(2000)
    fireEvent.keyUp(document.body, { key: 'Escape' })
    expect(setPowerMode).not.toHaveBeenCalledWith(false)
    expect(screen.queryByText('나가는 중…')).toBeNull()
    // 닫히면 다시 듣는다
    act(() => { fireEvent.keyDown(items()[0], { key: 'Escape' }) })
    fireEvent.keyUp(document.activeElement!, { key: 'Escape' })
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    await wait(1500)
    expect(setPowerMode).toHaveBeenLastCalledWith(false)
  })

  it('메뉴_밖을_누르거나_Tab_으로_나가면_닫힌다', async () => {
    await mount()
    await openMenu()
    act(() => { fireEvent.pointerDown(document.querySelector('.pw-map')!) })
    expect(menu()).toBeNull()
    await openMenu()
    act(() => { fireEvent.pointerDown(items()[2]) }) // 메뉴 안 누르기는 닫지 않는다(그 줄을 고른다)
    expect(menu()).not.toBeNull()
    act(() => { fireEvent.keyDown(items()[0], { key: 'Tab' }) })
    expect(menu()).toBeNull()
  })

  it('메뉴는_덮개_위_층', async () => {
    await mount()
    await openMenu()
    const m = menu()!
    const layer = screen.getByRole('region', { name: '파워 모드' })
    // 덮개 안(덮개의 어두운 색을 쓴다)이지만 화면(판) 밖 — 위 띠의 잘림·관계도 노드 카드의 z-index 가 메뉴를 덮지 못한다
    expect(m.parentElement).toBe(layer)
    expect(m.closest('.pw-stage')).toBeNull()
    expect(m.closest('[inert]')).toBeNull()
    expect(m).toHaveClass('pop')
    // 판은 제 안의 층(노드 카드 z-index 최대 110)을 가둔다 — 그 위에 메뉴(.pop z-index 20)
    const css = (f: string) => fs.readFileSync(path.resolve(f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
    const block = (src: string, sel: string) => [...src.matchAll(new RegExp(`(?:^|\\n|\\})\\s*${sel.replace(/[.-]/g, c => `\\${c}`)}\\s*\\{([^}]*)\\}`, 'g'))].map(x => x[1]).join(';')
    expect(block(css('src/renderer/power/power.css'), '.pw-stage')).toMatch(/isolation:\s*isolate/)
    expect(Number(/z-index:\s*(\d+)/.exec(block(css('src/renderer/styles/base.css'), '.pop'))![1])).toBeGreaterThan(1)
    // 단추 아래 자리에 붙는다(화면 기준)
    expect(m).toHaveClass('fix')
    expect(m.style.top).toMatch(/px$/)
  })

  it('터미널_벽은_상태_줄의_[두레]_바로_뒤에_같은_단추_—_메뉴는_위로_펼친다', async () => {
    const store = await mount({ terminal: true })
    const bar = document.querySelector('.pw-t-bar') as HTMLElement
    expect(bar.firstElementChild).toHaveTextContent('[두레]')
    expect(bar.children[1]).toBe(roomButton())
    expect(roomButton()).toHaveAccessibleName('방 첫 방')
    await openMenu()
    expect(items()).toHaveLength(3)
    expect(menu()!.style.bottom).toMatch(/px$/)
    act(() => { fireEvent.click(items()[1]) })
    expect(store.getState().roomId).toBe('r2')
    expect([...document.querySelectorAll('.pw-t-pane')].map(p => (p as HTMLElement).dataset.agent)).toEqual(['c', 'd'])
  })

  it('지금_방_줄(이름·에이전트_N·기다림_N·체크)이_말줄임_없이_들어갈_만큼_넓고_위_띠의_단추_바탕이_왼쪽에서_잘리지_않는다', () => {
    const css = fs.readFileSync(path.resolve('src/renderer/power/power.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
    const block = (sel: string) => [...css.matchAll(new RegExp(`(?:^|\\n|\\})\\s*${sel.replace(/[.-]/g, c => `\\${c}`)}\\s*\\{([^}]*)\\}`, 'g'))].map(x => x[1]).join(';')
    // 앱의 .pop 최대 폭(320px)까지 — 280px 에선 '주문 서비스 개편 · 에이전트 5 · 기다림 1 ✓' 의 이름이 '주문 서비스 …' 로 잘렸다(하니스 1600×900)
    expect(block('.pop.pw-rs-pop')).toMatch(/(^|;)\s*width:\s*320px/)
    // 위 띠 가운데 칸은 넘치면 잘린다 — 단추를 음수 margin 으로 내밀면 펼친·올린 단추 바탕의 왼쪽이 잘려 '방' 이 가장자리에 붙는다
    expect(block('.pw-room')).toMatch(/overflow:\s*hidden/)
    expect(block('button.pw-rs')).not.toMatch(/margin-left:\s*-/)
    // 터미널 벽 상태 줄 — 올리거나 펼치면 바탕(--pw-term-win-on)이 밝아져 '방'(--pw-term-ptl-ink)이 4.45:1 로 떨어졌다 → 그때는 밝은 글
    expect(css).toMatch(/\.pw-t-bar button\.pw-rs:hover[^{]*\{[^}]*\bcolor:\s*var\(--pw-term-focus-ink\)/)
  })

  it('관제실_방_단추의_초점_고리는_안쪽으로_—_.pw-room_의_overflow_hidden_이_바깥_고리를_자른다', () => {
    const css = fs.readFileSync(path.resolve('src/renderer/power/power.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
    expect(css).toMatch(/(^|\n|\})\s*button\.pw-rs:focus-visible\s*\{[^}]*outline-offset:\s*-2px/)
  })

  it('Tab_이면_단추로_초점을_옮기고_메뉴를_닫는다(이어서_브라우저가_단추_다음으로)', async () => {
    await mount()
    await openMenu()
    const ev = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
    act(() => { items()[0].dispatchEvent(ev) })
    expect(ev.defaultPrevented).toBe(false)
    expect(document.activeElement).toBe(roomButton())
    expect(menu()).toBeNull()
    await openMenu()
    act(() => { fireEvent.keyDown(items()[0], { key: 'Tab', shiftKey: true }) })
    expect(document.activeElement).toBe(roomButton())
    expect(menu()).toBeNull()
  })
})
