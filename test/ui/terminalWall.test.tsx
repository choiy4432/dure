import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { render, screen, act, cleanup, within } from '@testing-library/react'
import fs from 'node:fs'
import path from 'node:path'

// 터미널 벽 — 창 하나 = 에이전트 한 명(최대 6). 창에 흐르는 줄은 전부 진짜 사건에서, 오른쪽은 관제실과 같은 옆 칸(고른 에이전트의 대화)

const agent = (id: string, over: object = {}) => ({
  id, roomId: 'r1', name: id, role: `${id}역`, folder: 'C:\\work\\shop', sessionId: '', started: true, auto: false, model: null,
  alwaysAllow: [], pos: { x: 0, y: 0 }, color: null, effort: null, effortNow: null, modelNow: null, lastContext: null, bypassOn: false, status: 'idle', errorText: null, bypass: false, bypassBySettings: false, bypassPending: false, heldInput: 0, planMode: false, asleep: false, waking: false, hold: null, subagentsRunning: [], pastCount: 0, remoteIssue: null, ...over,
})
const toolItem = (name: string, input: unknown) => ({ t: 5, kind: 'assistant', blocks: [{ type: 'tool_use', id: 'u', name, input }] })
const relay = (id: string, from: string, to: string, text: string) => ({ id, roomId: 'r1', from, to, text, createdAt: 1, state: 'pending', updatedAt: 1 })

let handlers: Record<string, ((p: any) => void)[]>
let historyCalls: string[]
let setPowerMode: ReturnType<typeof vi.fn>
const emit = (k: string, p: unknown) => act(() => { (handlers[k] ?? []).forEach(f => f(p)) })
const wait = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms) })
/** 한 프레임 — 줄은 프레임마다 몰아 붙는다 */
const frame = () => wait(20)

function api(agents: object[], o: { history?: Record<string, unknown[]>; terminalPref?: boolean } = {}) {
  const rooms = agents.length ? [{ id: 'r1', name: '진짜 방', createdAt: 1 }] : []
  handlers = {}
  historyCalls = []
  setPowerMode = vi.fn(async () => {})
  ;(window as any).dure = {
    snapshot: async () => ({ claudeMissing: false, rooms, agents, messages: [], requests: [], autoChainLimit: 5, allowBypass: false, notify: { asks: true, finished: false }, sleepAfterMin: 30, usage: null }),
    history: async (id: string) => { historyCalls.push(id); return o.history?.[id] ?? [] },
    prefs: async () => ({ tourDone: true, approvalTipSeen: true, claudeAutoUpdate: true, trayTipSeen: true, powerTerminal: o.terminalPref ?? false }),
    setPowerMode,
    setSelected: async () => {},
    on: (k: string, fn: (p: any) => void) => { (handlers[k] ??= []).push(fn); return () => {} },
  }
  return rooms.length > 0
}

async function mount(agents: object[], o: { history?: Record<string, unknown[]>; select?: string; preload?: string[]; onExit?: () => void } = {}) {
  vi.resetModules()
  const hasRoom = api(agents, o)
  const { getStore } = await import('../../src/renderer/state/store')
  const { TerminalWall } = await import('../../src/renderer/power/TerminalWall')
  const store = getStore()
  await act(async () => { await store.init() })
  if (hasRoom) act(() => { store.selectRoom('r1') })
  // 기록만 불러 두고 고르기는 푼다(옆 칸은 기록 — 대화 패널이 그 기록을 그리지 않는다)
  for (const id of o.preload ?? []) await act(async () => { store.selectAgent(id) })
  if (o.preload) act(() => { store.selectAgent(null) })
  if (o.select) await act(async () => { store.selectAgent(o.select!) })
  await act(async () => { await store.setPower(true) })
  historyCalls.length = 0 // 여기부터는 이 화면이 부르는 것만
  render(<TerminalWall onExit={o.onExit ?? (() => {})} />)
  return store
}
const panes = () => [...document.querySelectorAll('.pw-t-pane')] as HTMLElement[]
const pane = (id: string) => document.querySelector(`.pw-t-pane[data-agent="${id}"]`) as HTMLElement
const body = (id: string) => pane(id).querySelector('.pw-t-pb') as HTMLElement
const lines = (id: string) => [...body(id).children].map(e => e.textContent)
const title = (id: string) => pane(id).querySelector('.pw-t-ptl') as HTMLElement
const bar = () => document.querySelector('.pw-t-bar') as HTMLElement
const setStatus = (agentId: string, status: string) => emit('status', { agentId, status, errorText: null })
const visible = (v: 'visible' | 'hidden') => Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => v })

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { visible('visible'); cleanup(); vi.useRealTimers() })

describe('터미널 벽', () => {
  it('에이전트_3명_→_창_3개(가짜_창_없음)', async () => {
    await mount([agent('a', { name: '알파', role: '구현' }), agent('b', { name: '베타', role: '검토' }), agent('c', { name: '감마', role: '' })])
    expect(panes()).toHaveLength(3)
    expect(panes().map(p => p.dataset.agent)).toEqual(['a', 'b', 'c'])
    expect(title('a')).toHaveTextContent('알파 — 구현')
    expect(title('c').textContent).toBe('감마')
    expect(document.querySelector('.pw-t-grid')).toHaveAttribute('data-n', '3')
  })

  it('창_6개와_상태_줄이_있다', async () => {
    const st = (i: number) => (i === 6 ? 'awaiting' : i === 3 || i === 7 ? 'working' : 'idle')
    await mount(Array.from({ length: 8 }, (_, i) => agent(`x${i}`, { name: `n${i}`, status: st(i) })))
    // 기다림 → 일하는 중 → 나머지로 여섯을 뽑고, 자리는 방 순서
    expect(panes().map(p => p.dataset.agent)).toEqual(['x0', 'x1', 'x2', 'x3', 'x6', 'x7'])
    expect(document.querySelector('.pw-t-grid')).toHaveAttribute('data-n', '6')
    const b = bar()
    expect(b.firstElementChild).toHaveTextContent('[두레]')
    expect(within(b).getByText('0:n0')).toBeInTheDocument()
    expect(within(b).getByText('4:n6')).toBeInTheDocument()
    expect(b).toHaveTextContent('외 2명')
    expect(within(b).getByRole('button', { name: '나가기' })).toBeInTheDocument()
    expect(b).toHaveTextContent(/\d\d:\d\d$/)
    // 밖에 있던 에이전트가 승인을 기다리면 창에 올라오고, 쉬는 마지막 에이전트가 내려간다
    await setStatus('x5', 'awaiting')
    expect(panes().map(p => p.dataset.agent)).toEqual(['x0', 'x1', 'x3', 'x5', 'x6', 'x7'])
  })

  it('6명_이하면_상태가_바뀌어도_창_자리는_그대로(방_순서)', async () => {
    await mount([agent('a', { name: '알파' }), agent('b', { name: '베타' }), agent('c', { name: '감마' })])
    await emit('history', { agentId: 'b', item: toolItem('Read', { file_path: 'b.ts' }) })
    await frame()
    const before = panes()
    await setStatus('c', 'awaiting')
    await setStatus('b', 'working')
    expect(panes().map(p => p.dataset.agent)).toEqual(['a', 'b', 'c'])
    // 같은 창(요소)이 그대로 — 줄도 그대로
    expect(panes()).toEqual(before)
    expect(lines('b')).toEqual(['● Read(b.ts)'])
  })

  it('창_제목은_진짜_이름과_역할_—_폴더_경로·날_id_는_안_쓴다', async () => {
    await mount([agent('id-a', { name: '알파', role: '구현' }), agent('id-b', { name: '베타', role: '' })])
    expect(title('id-a').textContent).toBe('알파 — 구현')
    expect(title('id-b').textContent).toBe('베타')
    const wall = document.querySelector('.pw-t-wall')!
    expect(wall).not.toHaveTextContent('C:\\work')
    expect(document.querySelector('.pw-t-grid')).not.toHaveTextContent(/id-a|id-b/)
  })

  it('0명_→_이_방엔_에이전트가_없어요', async () => {
    await mount([])
    expect(panes()).toHaveLength(0)
    expect(document.querySelector('.pw-t-main')).toHaveTextContent('이 방엔 에이전트가 없어요')
    expect(within(bar()).getByRole('button', { name: '나가기' })).toBeInTheDocument()
    expect(document.querySelector('.pw-side')).not.toBeNull()
    await wait(15000)
    expect(document.querySelectorAll('.pw-t-ln')).toHaveLength(0)
  })

  it('사건이_그_에이전트_창에만_붙는다', async () => {
    await mount([agent('a', { name: '알파' }), agent('b', { name: '베타' }), agent('c', { name: '감마' })])
    await emit('history', { agentId: 'a', item: toolItem('Read', { file_path: 'src/real/one.ts' }) })
    await emit('history', { agentId: 'a', item: { t: 6, kind: 'tool-result', toolUseId: 'u', isError: true, text: '파일이 없어요', viaApproval: false } })
    await frame()
    expect(lines('a')).toEqual(['● Read(src/real/one.ts)', '  ⎿  파일이 없어요'])
    expect(lines('b')).toEqual(['기다리는 중…'])
    // 넘김은 보낸 이와 받는 이 창에 — 다른 창엔 없다
    await emit('message', relay('m1', 'a', 'b', '확인 부탁해요'))
    await emit('history', { agentId: 'b', item: { t: 7, kind: 'result', ok: true, subtype: 'success' } })
    await frame()
    expect(lines('a').slice(-2)).toEqual(['● send_message(→ 베타)', '  ⎿  "확인 부탁해요"'])
    expect(lines('b')).toEqual(['← 알파: 확인 부탁해요', '✓ 끝남'])
    expect(lines('c')).toEqual(['기다리는 중…'])
    // 진짜 사건 뒤에 지어낸 줄이 끼어들지 않는다
    await wait(5000)
    expect(lines('a')).toHaveLength(4)
    expect(lines('b')).toHaveLength(2)
  })

  it('창당_60줄_상한_—_줄은_프레임마다_몰아_붙는다', async () => {
    await mount([agent('a', { name: '알파' })])
    for (let i = 0; i < 100; i++) await emit('history', { agentId: 'a', item: toolItem('Read', { file_path: `f${i}.ts` }) })
    expect(lines('a')).toEqual(['기다리는 중…']) // 아직 그 프레임 전
    await frame()
    expect(body('a').childElementCount).toBe(60)
    expect(body('a').firstElementChild).toHaveTextContent('Read(f40.ts)')
    expect(body('a').lastElementChild).toHaveTextContent('Read(f99.ts)')
    for (let i = 100; i < 110; i++) await emit('history', { agentId: 'a', item: toolItem('Read', { file_path: `f${i}.ts` }) })
    await frame()
    expect(body('a').childElementCount).toBe(60)
    expect(body('a').firstElementChild).toHaveTextContent('Read(f50.ts)')
  })

  it('awaiting_이면_그_창_아래_승인을_기다리는_중…_—_진짜_줄은_그대로', async () => {
    await mount([agent('a', { name: '알파' }), agent('b', { name: '베타' })])
    await emit('history', { agentId: 'a', item: toolItem('Bash', { command: 'npm test' }) })
    await frame()
    expect(pane('a').querySelector('.pw-t-wait')).toBeNull()
    await setStatus('a', 'awaiting')
    expect(pane('a')).toHaveAttribute('data-st', 'awaiting')
    const pin = pane('a').querySelector('.pw-t-wait')!
    expect(pin).toHaveTextContent('승인을 기다리는 중…')
    expect(pane('a').lastElementChild).toBe(pin)
    expect(lines('a')).toEqual(['● Bash(npm test)'])
    expect(pane('b').querySelector('.pw-t-wait')).toBeNull()
    await setStatus('a', 'working')
    expect(pane('a').querySelector('.pw-t-wait')).toBeNull()
    expect(pane('a')).toHaveAttribute('data-st', 'working')
    expect(lines('a')).toEqual(['● Bash(npm test)'])
  })

  it('사건_없는_창은_기다리는_중…', async () => {
    await mount([agent('a', { name: '알파', status: 'working' }), agent('b', { name: '베타' })])
    await wait(15000)
    expect(lines('a')).toEqual(['기다리는 중…'])
    expect(body('a').firstElementChild).toHaveClass('pw-t-dim')
    expect(lines('b')).toEqual(['기다리는 중…'])
    await emit('history', { agentId: 'a', item: { t: 5, kind: 'assistant', blocks: [{ type: 'text', text: '진짜 답 글' }] } })
    await frame()
    expect(lines('a')).toEqual(['진짜 답 글'])
  })

  it('켤_때_불러와_있는_기록의_마지막_줄을_깐다_—_안_불러온_에이전트는_부르지_않는다', async () => {
    const hist = {
      a: [
        { t: 1, kind: 'user', source: 'human', parts: [{ type: 'text', text: '고쳐 줘' }] },
        ...Array.from({ length: 50 }, (_, i) => toolItem('Read', { file_path: `old${i}.ts` })),
        { t: 2, kind: 'assistant', blocks: [{ type: 'text', text: '다 봤어요.' }] },
      ],
    }
    await mount([agent('a', { name: '알파' }), agent('b', { name: '베타' })], { history: hist, select: 'a' })
    expect(lines('a')).toHaveLength(40)
    expect(lines('a').at(-1)).toBe('다 봤어요.')
    expect(lines('a').at(-2)).toBe('● Read(old49.ts)')
    expect(lines('b')).toEqual(['기다리는 중…'])
    await emit('history', { agentId: 'a', item: toolItem('Grep', { pattern: 'fresh' }) })
    await frame()
    expect(lines('a').at(-1)).toBe('● Grep(fresh)')
    expect(lines('a')).toHaveLength(41)
    await wait(2000)
    expect(historyCalls).not.toContain('b')
  })

  it('켤_때_깔_기록에_이상한_줄이_있으면_그_창만_비고_벽은_뜬다_—_남기는_건_고정_문구와_오류_종류뿐', async () => {
    const hist = {
      a: [
        { t: 1, kind: 'assistant', blocks: [{ type: 'tool_use', id: 'u', name: 'Read', input: { file_path: 'C:\\비밀\\고객명단.ts' } }] },
        // 이상한 줄 — 결과 글이 없고 patch 줄이 배열이 아니다
        { t: 2, kind: 'tool-result', toolUseId: 'u', isError: false, viaApproval: false, patch: [{ oldStart: 1, newStart: 1, lines: null }] },
      ],
      b: [{ t: 3, kind: 'assistant', blocks: [{ type: 'text', text: '베타의 답' }] }],
    }
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await mount([agent('a', { name: '알파' }), agent('b', { name: '베타' })], { history: hist, preload: ['a', 'b'] })
      expect(panes()).toHaveLength(2)
      expect(lines('a')).toEqual(['기다리는 중…'])
      expect(lines('b')).toEqual(['베타의 답'])
      // 그 창도 뒤에 오는 진짜 사건은 평소대로
      await emit('history', { agentId: 'a', item: toolItem('Grep', { pattern: 'fresh' }) })
      await frame()
      expect(lines('a')).toEqual(['● Grep(fresh)'])
      const { PREFILL_FAILED } = await import('../../src/renderer/power/TerminalWall')
      expect(err.mock.calls).toEqual([[PREFILL_FAILED, 'TypeError']])
      expect(warn).not.toHaveBeenCalled()
    } finally {
      err.mockRestore()
      warn.mockRestore()
    }
  })

  it('창_클릭_→_selectAgent', async () => {
    const store = await mount([agent('a', { name: '알파' }), agent('b', { name: '베타' })])
    const spy = vi.spyOn(store, 'selectAgent')
    expect(title('a').tagName).toBe('BUTTON')
    expect(title('a')).toHaveAttribute('aria-pressed', 'false')
    act(() => { body('b').click() })
    expect(spy).toHaveBeenCalledTimes(1)
    // 고르기만 — 입력창 커서 요청은 없다(초점이 창에 남아야 Esc 길게가 된다)
    expect(spy).toHaveBeenCalledWith('b')
    expect(store.getState().inputFocus).toBeNull()
    expect(store.getState().selectedAgentId).toBe('b')
    expect(title('b')).toHaveAttribute('aria-pressed', 'true')
    expect(title('a')).toHaveAttribute('aria-pressed', 'false')
    expect(pane('b')).toHaveAttribute('data-sel')
    expect(within(bar()).getByText(/1:베타/)).toHaveAttribute('data-on')
    // 제목 단추(키보드로 닿는다)도 같은 고르기 — 한 번만
    act(() => { title('a').click() })
    expect(spy).toHaveBeenCalledTimes(2)
    expect(spy).toHaveBeenLastCalledWith('a')
    expect(title('a')).toHaveAttribute('aria-pressed', 'true')
  })

  it('기록을_보는_중에_같은_창을_다시_누르면_옆_칸이_대화로', async () => {
    await mount([agent('a', { name: '알파' })])
    const tab = (name: string) => screen.getByRole('tab', { name })
    act(() => { title('a').click() })
    expect(tab('대화')).toHaveAttribute('aria-selected', 'true')
    act(() => { tab('기록').click() })
    act(() => { body('a').click() })
    expect(tab('대화')).toHaveAttribute('aria-selected', 'true')
  })

  it('창의_글을_끌어_고르던_누르기는_고르지_않는다(고른_글이_풀리지_않게)', async () => {
    const store = await mount([agent('a', { name: '알파' }), agent('b', { name: '베타' })])
    await emit('history', { agentId: 'b', item: toolItem('Read', { file_path: 'C:\\work\\copy-me.ts' }) })
    await frame()
    const spy = vi.spyOn(store, 'selectAgent')
    const range = document.createRange()
    range.selectNodeContents(body('b').firstElementChild!)
    window.getSelection()!.removeAllRanges()
    window.getSelection()!.addRange(range)
    act(() => { body('b').click() })
    expect(spy).not.toHaveBeenCalled()
    // 제목 단추는 고른 글이 있어도 고른다 · 고른 글이 풀리면 본문 누르기도 고른다
    act(() => { title('b').click() })
    expect(spy).toHaveBeenCalledTimes(1)
    window.getSelection()!.removeAllRanges()
    act(() => { body('a').click() })
    expect(spy).toHaveBeenLastCalledWith('a')
  })

  it('오른쪽에_SidePanel', async () => {
    await mount([agent('a', { name: '알파' }), agent('b', { name: '베타' })])
    const main = document.querySelector('.pw-t-main')!
    expect([...main.children].map(c => c.className.split(' ')[0])).toEqual(['pw-t-grid', 'pw-side'])
    expect(screen.getByRole('tab', { name: '기록' })).toHaveAttribute('aria-selected', 'true')
    act(() => { body('b').click() })
    expect(screen.getByRole('tab', { name: '대화' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('textbox', { name: '베타에게 보낼 메시지' })).toBeInTheDocument()
    // 기록 탭은 관제실과 같은 실시간 기록
    await emit('history', { agentId: 'a', item: toolItem('Read', { file_path: 'log.ts' }) })
    await wait(250)
    act(() => { screen.getByRole('tab', { name: '기록' }).click() })
    expect(document.querySelector('.pw-side [data-row]')).toHaveTextContent('log.ts')
  })

  it('상태_줄에_토큰·부하_글이_없다', async () => {
    await mount([agent('a', { name: '알파', status: 'working' })])
    await emit('history', { agentId: 'a', item: toolItem('Read', { file_path: 'a.ts' }) })
    await wait(3000)
    expect(bar()).not.toHaveTextContent(/토큰|부하/)
    expect(bar()).not.toHaveTextContent(/\d+%/)
  })

  it('나가기_단추는_덮개의_나가기를_부른다', async () => {
    const onExit = vi.fn()
    await mount([agent('a', { name: '알파' })], { onExit })
    act(() => { within(bar()).getByRole('button', { name: '나가기' }).click() })
    expect(onExit).toHaveBeenCalledTimes(1)
  })

  it('덮개에서_터미널_벽의_나가기를_누르면_파워_모드가_꺼진다', async () => {
    vi.resetModules()
    api([agent('a', { name: '알파' })], { terminalPref: true })
    const { getStore } = await import('../../src/renderer/state/store')
    const { PowerLayer } = await import('../../src/renderer/power/PowerLayer')
    const store = getStore()
    await act(async () => { await store.init() })
    act(() => { store.selectRoom('r1') })
    await act(async () => { await store.setPower(true) })
    render(<PowerLayer />)
    expect(document.querySelector('[data-power-screen="terminal"]')).not.toBeNull()
    setPowerMode.mockClear()
    await act(async () => { within(bar()).getByRole('button', { name: '나가기' }).click() })
    expect(setPowerMode).toHaveBeenCalledWith(false)
    expect(document.querySelector('[data-power-screen="terminal"]')).toBeNull()
  })

  it('덮개가_넘긴_설정은_상태_줄의_설정_단추(나가기_앞)로_—_관제실과_같은_부품', async () => {
    vi.resetModules()
    api([agent('a', { name: '알파' })], { terminalPref: true })
    const { getStore } = await import('../../src/renderer/state/store')
    const { PowerLayer } = await import('../../src/renderer/power/PowerLayer')
    const store = getStore()
    await act(async () => { await store.init() })
    act(() => { store.selectRoom('r1') })
    await act(async () => { await store.setPower(true) })
    const onSettings = vi.fn()
    const view = render(<PowerLayer onSettings={onSettings} />)
    expect([...bar().querySelectorAll('.pw-ctls button')].map(b => b.textContent)).toEqual(['설정', '나가기Esc'])
    act(() => { within(bar()).getByRole('button', { name: '설정' }).click() })
    expect(onSettings).toHaveBeenCalledTimes(1)
    view.rerender(<PowerLayer />)
    expect(within(bar()).queryByRole('button', { name: '설정' })).toBeNull()
  })

  it('켠_뒤에_방에_들어온_에이전트가_넘겨도_날_id_가_창에_새지_않는다', async () => {
    const list: object[] = [agent('a', { name: '알파' })]
    const store = await mount(list)
    list.push(agent('zz-new', { name: '신입' }))
    await act(async () => { await store.refresh() })
    await emit('message', relay('m1', 'zz-new', 'a', '새로 왔어요'))
    await frame()
    expect(panes()).toHaveLength(1)
    expect(document.querySelector('.pw-t-grid')).not.toHaveTextContent(/zz-new|신입|새로 왔어요/)
  })

  it('상태_줄의_창_이름은_좁으면_말줄임으로_줄고_외_N명은_줄지_않는다(긴_이름이_뒤_창·외_N명을_밀어내지_않게)', () => {
    const css = fs.readFileSync(path.resolve('src/renderer/power/power.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
    const decls = (sel: string) => {
      const out: Record<string, string> = {}
      for (const m of css.matchAll(new RegExp(`(?:^|\\n|\\})\\s*${sel.replace(/\./g, '\\.')}\\s*\\{([^}]*)\\}`, 'g')))
        for (const d of m[1].split(';')) {
          const i = d.indexOf(':')
          if (i > 0) out[d.slice(0, i).trim()] = d.slice(i + 1).trim()
        }
      return out
    }
    expect(decls('.pw-t-win')).toMatchObject({ 'min-width': '0', overflow: 'hidden', 'text-overflow': 'ellipsis', 'white-space': 'nowrap' })
    expect(decls('.pw-t-win').display ?? 'block').not.toMatch(/flex/) // 말줄임은 블록 상자에서만 그려진다
    expect(decls('.pw-t-more')).toMatchObject({ flex: 'none' })
  })

  it('innerHTML_류를_쓰지_않는다(소스_확인)', async () => {
    await mount([agent('a', { name: '알파' })])
    await emit('history', { agentId: 'a', item: toolItem('Bash', { command: '<img src=x onerror=alert(1)>' }) })
    await frame()
    expect(document.querySelector('.pw-t-wall img')).toBeNull()
    expect(body('a')).toHaveTextContent('<img src=x onerror=alert(1)>')
    for (const f of ['TerminalWall.tsx', 'terminal/Pane.tsx', 'terminal/lines.ts']) {
      const src = fs.readFileSync(path.resolve('src/renderer/power', f), 'utf8')
      expect(src).not.toMatch(/dangerouslySetInnerHTML|innerHTML|outerHTML|insertAdjacentHTML|createContextualFragment/)
    }
  })

  it('안_보이는_동안_온_사건은_흐르지_않는다', async () => {
    await mount([agent('a', { name: '알파' })])
    visible('hidden')
    await emit('history', { agentId: 'a', item: toolItem('Read', { file_path: 'stale.ts' }) })
    await frame()
    expect(lines('a')).toEqual(['기다리는 중…'])
    visible('visible')
    await emit('history', { agentId: 'a', item: toolItem('Read', { file_path: 'fresh.ts' }) })
    await frame()
    expect(lines('a')).toEqual(['● Read(fresh.ts)'])
  })

  it('언마운트하면_타이머_0', async () => {
    await mount([agent('a', { name: '알파' })])
    await emit('history', { agentId: 'a', item: toolItem('Read', { file_path: 'queued.ts' }) }) // 그릴 프레임이 걸린 채로
    cleanup()
    expect(vi.getTimerCount()).toBe(0)
  })
})
