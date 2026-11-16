import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { render, screen, act, cleanup, within } from '@testing-library/react'
import { clockText } from '../../src/renderer/power/control/LiveLog'

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

async function mount(agents: object[]) {
  const rooms = agents.length ? [{ id: 'r1', name: '진짜 방', createdAt: 1 }] : []
  vi.resetModules()
  handlers = {}
  ;(window as any).dure = {
    snapshot: async () => ({ claudeMissing: false, rooms, agents, messages: [], requests: [], autoChainLimit: 5, allowBypass: false, notify: { asks: true, finished: false }, sleepAfterMin: 30, usage: null }),
    history: async () => [],
    setPowerMode: async () => {},
    on: (k: string, fn: (p: any) => void) => { (handlers[k] ??= []).push(fn); return () => {} },
  }
  const { getStore } = await import('../../src/renderer/state/store')
  const { ControlRoom } = await import('../../src/renderer/power/ControlRoom')
  const store = getStore()
  await act(async () => { await store.init() })
  if (rooms.length) act(() => { store.selectRoom('r1') })
  await act(async () => { await store.setPower(true) })
  render(<ControlRoom />)
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
