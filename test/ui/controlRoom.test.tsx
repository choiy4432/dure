import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { render, screen, act, cleanup, within } from '@testing-library/react'
import fs from 'node:fs'
import path from 'node:path'
import { clockText } from '../../src/renderer/power/control/LiveLog'
import { allowMotion } from './motion'

// 관제실 — 카드 · 기록 · 승인 기다림 · 숫자 띠. 진짜 사건만, 숫자는 0부터

const probe = vi.hoisted(() => ({ snapshots: 0 }))
vi.mock('../../src/renderer/power/stats', async orig => {
  const m = await orig<typeof import('../../src/renderer/power/stats')>()
  return {
    ...m,
    createStats: () => {
      const st = m.createStats()
      return { ...st, snapshot: () => (probe.snapshots++, st.snapshot()) }
    },
  }
})

const agent = (id: string, over: object = {}) => ({
  id, roomId: 'r1', name: id, role: `${id}역`, folder: '/x', sessionId: '', started: true, auto: false, model: null,
  alwaysAllow: [], pos: { x: 0, y: 0 }, color: null, effort: null, effortNow: null, modelNow: null, lastContext: null, bypassOn: false, status: 'idle', errorText: null, bypass: false, bypassBySettings: false, bypassPending: false, heldInput: 0, planMode: false, asleep: false, waking: false, hold: null, subagentsRunning: [], pastCount: 0, remoteIssue: null, ...over,
})
const toolItem = (name: string, input: unknown) => ({ t: 5, kind: 'assistant', blocks: [{ type: 'tool_use', id: 'u', name, input }] })

let handlers: Record<string, ((p: any) => void)[]>
const emit = (k: string, p: unknown) => act(() => { (handlers[k] ?? []).forEach(f => f(p)) })

async function mount(agents: object[], o: { onSettings?: () => void } = {}) {
  const rooms = agents.length ? [{ id: 'r1', name: '진짜 방', createdAt: 1 }] : []
  vi.resetModules()
  handlers = {}
  ;(window as any).dure = {
    snapshot: async () => ({ claudeMissing: false, rooms, agents, messages: [], requests: [], autoChainLimit: 5, allowBypass: false, notify: { asks: true, finished: false }, sleepAfterMin: 30, usage: null }),
    history: async () => [],
    setPowerMode: async () => {},
    setSelected: async () => {},
    on: (k: string, fn: (p: any) => void) => { (handlers[k] ??= []).push(fn); return () => {} },
  }
  const { getStore } = await import('../../src/renderer/state/store')
  const { ControlRoom } = await import('../../src/renderer/power/ControlRoom')
  const store = getStore()
  await act(async () => { await store.init() })
  if (rooms.length) act(() => { store.selectRoom('r1') })
  await act(async () => { await store.setPower(true) })
  render(<ControlRoom onExit={() => {}} onSettings={o.onSettings} />)
  return store
}
const wait = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms) })
const cards = () => document.querySelectorAll('.pw-card')
const rows = () => [...document.querySelectorAll('[data-row]')]
const card = (id: string) => document.querySelector(`[data-agent="${id}"]`) as HTMLElement
const tn = (id: string) => card(id).querySelector('.pw-tn')!.textContent
const tg = (id: string) => card(id).querySelector('.pw-tg')!.textContent
const setStatus = (agentId: string, status: string) => emit('status', { agentId, status, errorText: null })

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { cleanup(); vi.useRealTimers() })

describe('관제실', () => {
  it('방이_없으면_카드가_없고_관계도_자리에_안내_한_줄', async () => {
    await mount([])
    expect(cards()).toHaveLength(0)
    expect(screen.queryByText(/^외 \d+명$/)).toBeNull()
    expect(screen.getByText('파워 모드 · 가동 중')).toBeInTheDocument()
    expect(screen.getByText('0:00:00')).toBeInTheDocument()
    expect(document.querySelector('[data-power-map]')).toHaveTextContent('이 방엔 에이전트가 없어요')
    expect(document.querySelector('[data-power-map] .pw-mapbox')).toBeNull()
    expect(document.querySelector('.pw-room')).toHaveTextContent('방 — · 에이전트 0 · 서브에이전트 0')
  })

  it('에이전트_7명이면_카드_5장_더하기_외_2명', async () => {
    await mount(Array.from({ length: 7 }, (_, i) => agent(`x${i}`)))
    expect(cards()).toHaveLength(5)
    expect(screen.getByText('외 2명')).toBeInTheDocument()
    // 머리 줄 안에 있고, 카드 뒤에 따로 매달린 요소는 없다
    expect(document.querySelector('.pw-agents .pw-label')).toHaveTextContent('외 2명')
    expect(document.querySelector('.pw-agents')!.lastElementChild!.classList.contains('pw-card')).toBe(true)
    expect(document.querySelector('.pw-agents > .pw-more')).toBeNull()
    expect(document.querySelector('[data-power-map] .pw-mapbox')).not.toBeNull()
  })

  it('7명_중_6번째가_승인_기다림이고_7번째가_일하면_둘_다_다섯_장_안에_기다림_일함_나머지_순', async () => {
    await mount(Array.from({ length: 7 }, (_, i) => agent(`x${i}`, i === 5 ? { status: 'awaiting' } : i === 6 ? { status: 'working' } : {})))
    expect([...cards()].map(c => c.getAttribute('data-agent'))).toEqual(['x5', 'x6', 'x0', 'x1', 'x2'])
    expect(screen.getByText('외 2명')).toBeInTheDocument()
  })

  it('tool_사건이_오면_카드_도구_줄과_기록_맨_위가_바뀐다', async () => {
    await mount([agent('a', { name: '알파' })])
    await emit('history', { agentId: 'a', item: toolItem('Read', { file_path: 'src/one.ts' }) })
    await wait(250)
    expect(within(card('a')).getByText('Read')).toBeInTheDocument()
    expect(within(card('a')).getByText('src/one.ts')).toBeInTheDocument()
    expect(rows()[0]).toHaveTextContent('src/one.ts')
    await emit('history', { agentId: 'a', item: toolItem('Bash', { command: 'npm test' }) })
    await wait(250)
    expect(within(card('a')).getByText('npm test')).toBeInTheDocument()
    expect(rows()[0]).toHaveTextContent('npm test')
    expect(rows()[1]).toHaveTextContent('src/one.ts')
  })

  it('도구_대상이_긴_경로면_카드·기록은_끝_두_조각만_보이고_전체는_title(명령은_그대로)', async () => {
    await mount([agent('a', { name: '알파' })])
    await emit('history', { agentId: 'a', item: toolItem('Read', { file_path: 'C:\\work\\shop\\src\\order\\refund.ts' }) })
    await wait(250)
    expect(tg('a')).toBe('…\\order\\refund.ts')
    expect(card('a').querySelector('.pw-tool')).toHaveAttribute('title', 'C:\\work\\shop\\src\\order\\refund.ts')
    expect(rows()[0]).toHaveTextContent('…\\order\\refund.ts')
    await emit('history', { agentId: 'a', item: toolItem('Bash', { command: 'npm test -- src/a/b/c.ts' }) })
    await wait(250)
    expect(tg('a')).toBe('npm test -- src/a/b/c.ts')
  })

  it('켠_뒤에_방에_들어온_에이전트의_사건은_보이지_않는다(날_id_가_새지_않게)', async () => {
    const list: object[] = [agent('a', { name: '알파' })]
    await mount(list)
    list.push(agent('zz-new', { name: '신입' }))
    const { getStore } = await import('../../src/renderer/state/store')
    await act(async () => { await getStore().refresh() })
    expect(getStore().getState().agents.map(x => x.id)).toContain('zz-new')
    await emit('history', { agentId: 'zz-new', item: toolItem('Read', { file_path: 'from-new.ts' }) })
    await emit('message', { id: 'm1', roomId: 'r1', from: 'zz-new', to: 'a', text: '새로 왔어요', createdAt: 1, state: 'pending', updatedAt: 1 })
    await emit('message', { id: 'm2', roomId: 'r1', from: 'a', to: 'zz-new', text: '반가워요', createdAt: 1, state: 'pending', updatedAt: 1 })
    await emit('history', { agentId: 'a', item: toolItem('Read', { file_path: 'from-known.ts' }) })
    await wait(250)
    const text = rows().map(r => r.textContent).join('\n')
    expect(text).toContain('from-known.ts')
    expect(text).not.toMatch(/zz-new|from-new|새로 왔어요|반가워요/)
    expect(cards()).toHaveLength(1)
  })

  it('기록은_26줄까지', async () => {
    await mount([agent('a', { name: '알파' })])
    for (let i = 0; i < 30; i++) await emit('history', { agentId: 'a', item: toolItem('Read', { file_path: `f${i}.ts` }) })
    await wait(250)
    expect(rows()).toHaveLength(26)
    expect(rows()[0]).toHaveTextContent('f29.ts')
  })

  it('카드_상태는_진짜_그대로_작업_중·승인_기다림·쉬는_중', async () => {
    await mount([agent('a', { name: '알파', status: 'awaiting' }), agent('b', { name: '베타', status: 'working' }), agent('c', { name: '감마', status: 'idle', asleep: true })])
    expect(within(card('a')).getByText('승인 기다림')).toBeInTheDocument()
    expect(card('a')).toHaveAttribute('data-warn')
    expect(within(card('b')).getByText('작업 중')).toBeInTheDocument()
    expect(within(card('c')).getByText('쉬는 중')).toBeInTheDocument()
    expect(card('b')).not.toHaveAttribute('data-warn')
  })

  it('상태가_바뀌면_카드도_따라_바뀐다', async () => {
    await mount([agent('a', { name: '알파' })])
    expect(within(card('a')).getByText('쉬는 중')).toBeInTheDocument()
    await setStatus('a', 'working')
    expect(within(card('a')).getByText('작업 중')).toBeInTheDocument()
    await setStatus('a', 'awaiting')
    expect(within(card('a')).getByText('승인 기다림')).toBeInTheDocument()
    await setStatus('a', 'idle')
    expect(within(card('a')).getByText('쉬는 중')).toBeInTheDocument()
  })

  it('사건이_없으면_기록은_비고_카드_도구_줄은_—(지어내지_않는다)', async () => {
    await mount([agent('a', { name: '알파', status: 'working' }), agent('b', { name: '베타', status: 'awaiting' })])
    await wait(15000)
    expect(rows()).toHaveLength(0)
    expect(tn('a')).toBe('—')
    expect(tg('a')).toBe('')
    expect(tn('b')).toBe('—')
    expect([...document.querySelectorAll('[data-stat]')].map(e => e.textContent)).toEqual(['0', '0', '+0', '−0', '0'])
  })

  it('마지막이_진짜_사건이던_에이전트가_승인_기다림이_되면_그_줄이_남는다', async () => {
    await mount([agent('a', { name: '알파' })])
    await emit('history', { agentId: 'a', item: toolItem('Read', { file_path: 'real.ts' }) })
    await wait(250)
    await setStatus('a', 'awaiting')
    await wait(250)
    expect(within(card('a')).getByText('승인 기다림')).toBeInTheDocument()
    expect(tn('a')).toBe('Read')
    expect(tg('a')).toBe('real.ts')
  })

  it('숫자_띠_도구_호출이_0부터_올라가고_가동_시간이_0부터_센다', async () => {
    await mount([agent('a', { name: '알파' })])
    expect(document.querySelector('[data-stat="tools"]')).toHaveTextContent(/^0$/)
    expect(screen.getByText('0:00:00')).toBeInTheDocument()
    await emit('history', { agentId: 'a', item: toolItem('Read', { file_path: 'a.ts' }) })
    await wait(250)
    expect(document.querySelector('[data-stat="tools"]')).toHaveTextContent(/^1$/)
    expect(document.querySelector('[data-stat="files"]')).toHaveTextContent(/^1$/)
    await wait(2000)
    expect(screen.getByText('0:00:02')).toBeInTheDocument()
  })

  it('결과의_진짜_patch_만큼_바꾼_줄이_오른다', async () => {
    await mount([agent('a', { name: '알파' })])
    await emit('history', { agentId: 'a', item: toolItem('Edit', { file_path: 'a.ts' }) })
    await wait(250)
    expect(document.querySelector('[data-stat="added"]')).toHaveTextContent('+0')
    await emit('history', { agentId: 'a', item: { t: 6, kind: 'tool-result', toolUseId: 'u', isError: false, text: '고침', viaApproval: false, patch: [{ oldStart: 1, newStart: 1, lines: ['-a', '+b', '+c'] }] } })
    await wait(250)
    expect(document.querySelector('[data-stat="added"]')).toHaveTextContent('+2')
    expect(document.querySelector('[data-stat="removed"]')).toHaveTextContent('−1')
  })

  it('처리한_토큰_칸이_없다', async () => {
    await mount([agent('a', { name: '알파' })])
    expect(document.querySelector('[data-stat="tokens"]')).toBeNull()
    expect(document.querySelector('.pw-stats')).not.toHaveTextContent('토큰')
  })

  it('창이_안_보이는_동안은_그리지_않고_다시_보이면_시계와_가동_시간이_맞다', async () => {
    const vis = vi.spyOn(document, 'visibilityState', 'get')
    vis.mockReturnValue('visible')
    await mount([agent('a', { name: '알파' })])
    const nowText = () => document.querySelector('.pw-now')!.textContent
    const upText = () => document.querySelector('.pw-clock b')!.textContent
    await wait(1000)
    const before = { now: nowText(), up: upText() }
    vis.mockReturnValue('hidden')
    const before1 = probe.snapshots
    await wait(10000)
    expect(probe.snapshots).toBe(before1)
    expect({ now: nowText(), up: upText() }).toEqual(before)
    vis.mockReturnValue('visible')
    await wait(1000)
    expect(upText()).toBe('0:00:12') // 마운트 뒤 12초
    expect(nowText()).toBe(clockText(Date.now()))
    vis.mockRestore()
  })

  it('숨어_있던_10분_동안_온_진짜_사건_1000개는_다시_보여도_쏟아지지_않는다', async () => {
    const vis = vi.spyOn(document, 'visibilityState', 'get')
    vis.mockReturnValue('visible')
    await mount([agent('a', { name: '알파' })])
    await wait(1000)
    vis.mockReturnValue('hidden')
    for (let i = 0; i < 1000; i++) {
      await emit('history', { agentId: 'a', item: toolItem('Read', { file_path: `stale${i}.ts` }) })
      if (i % 100 === 99) await wait(60_000)
    }
    vis.mockReturnValue('visible')
    await emit('history', { agentId: 'a', item: toolItem('Bash', { command: 'fresh-one' }) })
    await wait(250)
    expect(rows().some(r => r.textContent!.includes('stale'))).toBe(false)
    expect(rows().some(r => r.textContent!.includes('fresh-one'))).toBe(true)
    expect(card('a')).not.toHaveTextContent('stale')
    expect(document.querySelector('[data-stat="tools"]')).toHaveTextContent(/^1$/)
    vis.mockRestore()
  })

  it('한_틱에_사건_20개가_와도_숫자_띠는_스냅샷을_한_번만_뜬다', async () => {
    await mount([agent('a', { name: '알파' })])
    for (let i = 0; i < 20; i++) await emit('history', { agentId: 'a', item: toolItem('Read', { file_path: `f${i}.ts` }) })
    const before = probe.snapshots
    await wait(250)
    expect(probe.snapshots - before).toBe(1)
    expect(document.querySelector('[data-stat="tools"]')).toHaveTextContent(/^20$/)
  })

  it('머리_줄의_작업_중_숫자는_진짜로_일하는_에이전트_수', async () => {
    await mount([agent('a', { name: '알파', status: 'working' }), agent('b', { name: '베타' }), agent('c', { name: '감마', status: 'awaiting' })])
    expect(document.querySelector('.pw-agents .pw-label')).toHaveTextContent('작업 중 1')
  })

  it('카드는_단추_누르면_그_에이전트를_고르고_고른_카드만_aria_pressed', async () => {
    await mount([agent('a', { name: '알파' }), agent('b', { name: '베타' })])
    const { getStore } = await import('../../src/renderer/state/store')
    const spy = vi.spyOn(getStore(), 'selectAgent')
    expect(card('a').tagName).toBe('BUTTON')
    expect(card('a')).toHaveAttribute('aria-pressed', 'false')
    act(() => { card('b').click() })
    // 고르기만 — 입력창 커서 요청은 없다(초점이 카드에 남아야 Esc 길게가 된다)
    expect(spy).toHaveBeenCalledWith('b')
    expect(getStore().getState().inputFocus).toBeNull()
    expect(getStore().getState().selectedAgentId).toBe('b')
    expect(card('b')).toHaveAttribute('aria-pressed', 'true')
    expect(card('a')).toHaveAttribute('aria-pressed', 'false')
    // 관계도 노드도 같은 고르기 — 고른 표시가 노드에도
    expect(document.querySelector('[data-node="b"]')).toHaveAttribute('aria-pressed', 'true')
    act(() => { (document.querySelector('[data-node="a"]') as HTMLElement).click() })
    expect(spy).toHaveBeenLastCalledWith('a')
    expect(card('a')).toHaveAttribute('aria-pressed', 'true')
  })

  it('기록을_보는_중에_같은_카드·노드를_다시_누르면_옆_칸이_대화로', async () => {
    await mount([agent('a', { name: '알파' }), agent('b', { name: '베타' })])
    const tab = (name: string) => screen.getByRole('tab', { name })
    act(() => { card('a').click() })
    expect(tab('대화')).toHaveAttribute('aria-selected', 'true')
    act(() => { tab('기록').click() })
    expect(tab('기록')).toHaveAttribute('aria-selected', 'true')
    act(() => { card('a').click() })
    expect(tab('대화')).toHaveAttribute('aria-selected', 'true')
    act(() => { tab('기록').click() })
    act(() => { (document.querySelector('[data-node="a"]') as HTMLElement).click() })
    expect(tab('대화')).toHaveAttribute('aria-selected', 'true')
  })

  it('상태가_바뀌면_카드_5장을_다시_고른다_기다림_일함_나머지_무리_안에선_방_순서', async () => {
    await mount(Array.from({ length: 7 }, (_, i) => agent(`x${i}`)))
    const shown = () => [...cards()].map(c => c.getAttribute('data-agent'))
    expect(shown()).toEqual(['x0', 'x1', 'x2', 'x3', 'x4'])
    await setStatus('x6', 'awaiting')
    expect(shown()).toEqual(['x6', 'x0', 'x1', 'x2', 'x3'])
    await setStatus('x5', 'working')
    expect(shown()).toEqual(['x6', 'x5', 'x0', 'x1', 'x2'])
    await setStatus('x6', 'idle')
    expect(shown()).toEqual(['x5', 'x0', 'x1', 'x2', 'x3'])
    expect(screen.getByText('외 2명')).toBeInTheDocument()
  })

  it('고른_에이전트는_늘_다섯_장_안에', async () => {
    await mount(Array.from({ length: 7 }, (_, i) => agent(`x${i}`)))
    const { getStore } = await import('../../src/renderer/state/store')
    act(() => { getStore().selectAgent('x6') })
    expect([...cards()].map(c => c.getAttribute('data-agent'))).toEqual(['x0', 'x1', 'x2', 'x3', 'x6'])
    expect(card('x6')).toHaveAttribute('aria-pressed', 'true')
  })

  it('진짜_맥락_사용량이_있으면_카드에_그_값_없으면_안_그린다', async () => {
    await mount([agent('a', { name: '알파', lastContext: { percent: 42, total: 84000, max: 200000, autoCompactAt: null, at: 1 } }), agent('b', { name: '베타' })])
    expect(card('a')).toHaveTextContent('42%')
    expect(card('b').querySelector('.pw-ring')).toBeNull()
    expect(card('b')).not.toHaveTextContent('%')
  })

  it('배치_A_왼쪽_카드_가운데_관계도_오른쪽_옆_칸(아무도_안_골랐으면_기록)_위_띠에_나가기와_시계', async () => {
    await mount([agent('a', { name: '알파' })])
    const main = document.querySelector('.pw-main')!
    expect([...main.children].map(c => c.className.split(' ')[0])).toEqual(['pw-agents', 'pw-map', 'pw-side'])
    expect(screen.getByRole('tab', { name: '기록' })).toHaveAttribute('aria-selected', 'true')
    const top = document.querySelector('.pw-top')!
    const exit = within(top as HTMLElement).getByRole('button', { name: '나가기' })
    expect(exit.compareDocumentPosition(top.querySelector('.pw-now')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(document.querySelector('[data-power-map] .pw-label')).toHaveTextContent('노드를 누르면 그 에이전트와 대화')
  })

  it('시계_한_틱·사건_한_묶음에_옆_칸의_대화_패널(AgentPanel)은_다시_그리지_않는다', async () => {
    let renders = 0
    vi.doMock('../../src/renderer/panel/AgentPanel', () => ({ AgentPanel: () => { renders++; return <div data-probe-panel /> } }))
    try {
      const store = await mount([agent('a', { name: '알파' })])
      act(() => { store.selectAgent('a') })
      expect(document.querySelector('[data-probe-panel]')).not.toBeNull()
      const before = renders
      await wait(1000) // 시계 한 틱 — 관제실은 다시 그린다(가동 0:00:01)
      expect(screen.getByText('0:00:01')).toBeInTheDocument()
      expect(renders).toBe(before)
      await emit('history', { agentId: 'a', item: toolItem('Read', { file_path: 'a.ts' }) })
      await wait(250) // 사건 한 묶음 — 기록·숫자 띠는 바뀐다
      expect(rows()).toHaveLength(1)
      expect(renders).toBe(before)
    } finally {
      vi.doUnmock('../../src/renderer/panel/AgentPanel')
    }
  })

  it('위_띠의_설정_단추는_나가기_앞_누르면_onSettings_—_없으면_단추도_없다', async () => {
    const onSettings = vi.fn()
    await mount([agent('a', { name: '알파' })], { onSettings })
    const top = document.querySelector('.pw-top') as HTMLElement
    expect([...top.querySelectorAll('.pw-ctls button')].map(b => b.textContent)).toEqual(['설정', '나가기Esc'])
    within(top).getByRole('button', { name: '설정' }).click()
    expect(onSettings).toHaveBeenCalledTimes(1)
    cleanup()
    await mount([agent('a', { name: '알파' })])
    expect(within(document.querySelector('.pw-top') as HTMLElement).queryByRole('button', { name: '설정' })).toBeNull()
  })

  it('긴_이름(40자까지)도_칸을_넘지_않는다_—_노드_이름은_말줄임·카드의_역할은_찌그러져_잘리지_않는다', () => {
    const css = fs.readFileSync(path.resolve('src/renderer/power/power.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
    const decls = (sel: string) => {
      const out: Record<string, string> = {}
      for (const m of css.matchAll(new RegExp(`(?:^|\\n|\\})\\s*${sel.replace(/[.[\]']/g, c => `\\${c}`)}\\s*\\{([^}]*)\\}`, 'g')))
        for (const d of m[1].split(';')) {
          const i = d.indexOf(':')
          if (i > 0) out[d.slice(0, i).trim()] = d.slice(i + 1).trim()
        }
      return out
    }
    // 노드 이름 — 도구 줄(132px)처럼 상한과 말줄임(카드가 서로 겹치거나 관계도 가장자리에서 잘리지 않게)
    expect(decls('.pw-mn-tx b')).toMatchObject({ overflow: 'hidden', 'text-overflow': 'ellipsis' })
    expect(decls('.pw-mn-tx b')['max-width']).toMatch(/^\d+px$/)
    // 카드 역할 — 줄지 않고(이름이 먼저 말줄임) 너무 길면 제 상한에서 말줄임 — 한두 글자로 찌그러진 낱말이 다른 말처럼 보이지 않게
    expect(decls('.pw-role')).toMatchObject({ flex: 'none', overflow: 'hidden', 'text-overflow': 'ellipsis' })
    expect(decls('.pw-role')['max-width']).toBeTruthy()
  })

  it('옮기면_카드·관계도·위_띠가_새_방_것으로_—_고른_에이전트는_앱_규칙대로_비고_옆_칸은_기록', async () => {
    const store = await mountTwo()
    act(() => { store.selectAgent('a') })
    expect(screen.getByRole('tab', { name: '대화' })).toHaveAttribute('aria-selected', 'true')
    act(() => { store.selectRoom('r2') })
    expect([...cards()].map(c => c.getAttribute('data-agent'))).toEqual(['c'])
    expect([...document.querySelectorAll('[data-node]')].map(n => n.getAttribute('data-node'))).toEqual(['c'])
    expect(document.querySelector('.pw-room')).toHaveTextContent('방 둘째 방 · 에이전트 1 · 서브에이전트 0')
    expect(store.getState().selectedAgentId).toBeNull()
    expect(screen.getByRole('tab', { name: '기록' })).toHaveAttribute('aria-selected', 'true')
    // 옛 방 에이전트의 사건은 이제 오지 않는다 — 새 방 것만
    await emit('history', { agentId: 'a', item: toolItem('Read', { file_path: 'old-room.ts' }) })
    await emit('history', { agentId: 'c', item: toolItem('Read', { file_path: 'new-room.ts' }) })
    await wait(250)
    expect(rows().map(r => r.textContent).join('\n')).not.toContain('old-room.ts')
    expect(rows()[0]).toHaveTextContent('new-room.ts')
  })

  it('숫자_띠와_위_띠가_같은_진짜_서브에이전트_수를_보인다', async () => {
    await mount([agent('a', { name: '알파' })])
    const tile = () => [...document.querySelectorAll('.pw-tile')].find(t => t.textContent!.includes('서브에이전트'))!.querySelector('.v')!.textContent
    expect(document.querySelector('.pw-room')).toHaveTextContent('서브에이전트 0')
    expect(tile()).toBe('0')
    cleanup()
    await mount([agent('a', { name: '알파', subagentsRunning: ['t1', 't2'] })])
    expect(document.querySelector('.pw-room')).toHaveTextContent('서브에이전트 2')
    expect(tile()).toBe('2')
  })
})

/** 방 둘 — r1(진짜 방): 알파·베타, r2(둘째 방): 감마. layer 면 덮개(PowerLayer)째로 — 방별 화면 상태가 덮개 수명 동안 남는다. empty 면 빈 방 r3 도 */
async function mountTwo(o: { layer?: boolean; empty?: boolean } = {}) {
  vi.resetModules()
  handlers = {}
  const rooms = [{ id: 'r1', name: '진짜 방', createdAt: 2 }, { id: 'r2', name: '둘째 방', createdAt: 1 }, ...(o.empty ? [{ id: 'r3', name: '빈 방', createdAt: 0 }] : [])]
  const agents = [agent('a', { name: '알파' }), agent('b', { name: '베타' }), agent('c', { name: '감마', roomId: 'r2' })]
  ;(window as any).dure = {
    snapshot: async () => ({ claudeMissing: false, rooms, agents, messages: [], requests: [], autoChainLimit: 5, allowBypass: false, notify: { asks: true, finished: false }, sleepAfterMin: 30, usage: null }),
    history: async () => [],
    setPowerMode: async () => {},
    setSelected: async () => {},
    on: (k: string, fn: (p: any) => void) => { (handlers[k] ??= []).push(fn); return () => {} },
  }
  const { getStore } = await import('../../src/renderer/state/store')
  const store = getStore()
  await act(async () => { await store.init() })
  act(() => { store.selectRoom('r1') })
  await act(async () => { await store.setPower(true) })
  if (o.layer) {
    const { PowerLayer } = await import('../../src/renderer/power/PowerLayer')
    render(<PowerLayer />)
  } else {
    const { ControlRoom } = await import('../../src/renderer/power/ControlRoom')
    render(<ControlRoom onExit={() => {}} />)
  }
  return store
}
const stat = (k: string) => document.querySelector(`[data-stat="${k}"]`)!.textContent

describe('관제실 — 방별 숫자·기록(덮개가 떠 있는 동안)', () => {
  it('A_에서_도구_사건_12개_→_B_로(숫자_0)_→_A_로(12)', async () => {
    const store = await mountTwo({ layer: true })
    for (let i = 0; i < 12; i++) await emit('history', { agentId: 'a', item: toolItem('Read', { file_path: `a${i}.ts` }) })
    await emit('message', { id: 'h1', roomId: 'r1', from: 'a', to: 'b', text: '넘겨요', createdAt: 1, state: 'pending', updatedAt: 1 })
    await wait(250)
    expect([stat('tools'), stat('files'), stat('handoffs')]).toEqual(['12', '12', '1'])
    act(() => { store.selectRoom('r2') })
    expect([stat('tools'), stat('files'), stat('handoffs')]).toEqual(['0', '0', '0'])
    // 보지 않는 방의 사건은 세지 않는다 — B 에 있는 동안 A 에 온 사건은 A 숫자에 들지 않는다
    await emit('history', { agentId: 'a', item: toolItem('Read', { file_path: 'unseen.ts' }) })
    await emit('history', { agentId: 'c', item: toolItem('Bash', { command: 'npm test' }) })
    await wait(250)
    expect(stat('tools')).toBe('1')
    act(() => { store.selectRoom('r1') })
    expect([stat('tools'), stat('files'), stat('handoffs')]).toEqual(['12', '12', '1'])
    act(() => { store.selectRoom('r2') })
    expect(stat('tools')).toBe('1')
  })

  it('기록_줄도_방별로_남는다', async () => {
    const store = await mountTwo({ layer: true })
    await emit('history', { agentId: 'a', item: toolItem('Read', { file_path: 'a-room.ts' }) })
    await wait(250)
    expect(rows().map(r => r.textContent)).toEqual([expect.stringContaining('a-room.ts')])
    act(() => { store.selectRoom('r2') })
    expect(rows()).toHaveLength(0)
    expect(screen.getByText('켠 뒤 들어온 일이 아직 없어요')).toBeInTheDocument()
    await emit('history', { agentId: 'c', item: toolItem('Read', { file_path: 'b-room.ts' }) })
    await wait(250)
    expect(rows().map(r => r.textContent)).toEqual([expect.stringContaining('b-room.ts')])
    act(() => { store.selectRoom('r1') })
    expect(rows().map(r => r.textContent)).toEqual([expect.stringContaining('a-room.ts')])
    await emit('history', { agentId: 'b', item: toolItem('Grep', { pattern: 'more' }) })
    await wait(250)
    expect(rows()).toHaveLength(2)
    expect(rows()[0]).toHaveTextContent('more')
    act(() => { store.selectRoom('r2') })
    expect(rows().map(r => r.textContent)).toEqual([expect.stringContaining('b-room.ts')])
  })

  it('옮기면_왼쪽_카드·옆_칸·숫자_띠는_바로_새_방_값_—_짧은_흐려짐(0.2s)만', async () => {
    const store = await mountTwo({ layer: true })
    for (let i = 0; i < 3; i++) await emit('history', { agentId: 'a', item: toolItem('Read', { file_path: `a${i}.ts` }) })
    await wait(250)
    const fading = () => ['.pw-agents', '.pw-side', '.pw-stats'].map(s => document.querySelector(s)!.classList.contains('pw-swap'))
    expect(fading()).toEqual([false, false, false])
    act(() => { store.selectRoom('r2') })
    // 기다림 없이 그 그리기에서 새 방 값 — 관계도 전환을 기다리지 않는다
    expect([...cards()].map(c => c.getAttribute('data-agent'))).toEqual(['c'])
    expect(stat('tools')).toBe('0')
    expect(rows()).toHaveLength(0)
    expect(screen.getByText('켠 뒤 들어온 일이 아직 없어요')).toBeInTheDocument()
    expect(fading()).toEqual([true, true, true])
    const css = fs.readFileSync(path.resolve('src/renderer/power/power.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
    expect(css).toMatch(/\.pw-swap\s*\{[^}]*animation:\s*pw-swap 0\.2s/)
    expect(css).toMatch(/@keyframes pw-swap\s*\{[^}]*opacity/)
  })

  it('빈_방으로_옮기면_관계도는_빨려_들고_도약한_뒤에_빈_방_글_—_빈_방에서_오면_관계도가_다시(핵에서_펼친다)', async () => {
    allowMotion()
    // 그릴 수 있는 캔버스(아무것도 안 하는 가짜) — 관계도가 전환을 rAF(가짜 시계)로 돈다
    HTMLCanvasElement.prototype.getContext = (() =>
      new Proxy({}, { get: (_t, k) => (k === 'measureText' ? () => ({ width: 10 }) : k === 'createRadialGradient' || k === 'createLinearGradient' ? () => ({ addColorStop() {} }) : () => {}), set: () => true })) as unknown as typeof HTMLCanvasElement.prototype.getContext
    try {
      const store = await mountTwo({ layer: true, empty: true })
      const map = () => document.querySelector('[data-power-map]')!
      const nodes = () => [...map().querySelectorAll('[data-node]')].map(n => n.getAttribute('data-node'))
      await wait(100)
      act(() => { store.selectRoom('r3') })
      // 왼쪽 카드는 바로 비고(새 방 값), 관계도는 옛 카드를 빨아들이는 중
      expect(cards()).toHaveLength(0)
      expect(nodes()).toEqual(['a', 'b'])
      await wait(700)
      expect(map().querySelector('.pw-mapbox')).not.toBeNull()
      expect(map()).not.toHaveTextContent('이 방엔 에이전트가 없어요')
      await wait(400)
      expect(map().querySelector('.pw-mapbox')).toBeNull()
      expect(map()).toHaveTextContent('이 방엔 에이전트가 없어요')
      act(() => { store.selectRoom('r2') })
      expect(map().querySelector('.pw-mapbox')).not.toBeNull()
      await wait(100)
      expect(nodes()).toEqual(['c'])
    } finally {
      HTMLCanvasElement.prototype.getContext = (() => null) as unknown as typeof HTMLCanvasElement.prototype.getContext
    }
  })

  it('파워_모드를_껐다_켜면_전부_0', async () => {
    const store = await mountTwo({ layer: true })
    for (let i = 0; i < 12; i++) await emit('history', { agentId: 'a', item: toolItem('Read', { file_path: `a${i}.ts` }) })
    await wait(250)
    act(() => { store.selectRoom('r2') })
    await emit('history', { agentId: 'c', item: toolItem('Read', { file_path: 'c.ts' }) })
    await wait(250)
    act(() => { store.selectRoom('r1') })
    expect(stat('tools')).toBe('12')
    await act(async () => { await store.setPower(false) })
    expect(document.querySelector('[data-power-screen]')).toBeNull()
    await act(async () => { await store.setPower(true) })
    expect(stat('tools')).toBe('0')
    expect(rows()).toHaveLength(0)
    act(() => { store.selectRoom('r2') })
    expect(stat('tools')).toBe('0')
    expect(rows()).toHaveLength(0)
  })
})
