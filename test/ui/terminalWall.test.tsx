import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { render, act, cleanup } from '@testing-library/react'
import fs from 'node:fs'
import path from 'node:path'

// 터미널 벽 — 창 여섯 · 상태 줄 · 줄 수 한도 · 진짜 사건 · 승인 기다림

const agent = (id: string, over: object = {}) => ({
  id, roomId: 'r1', name: id, role: `${id}역`, folder: '/x', sessionId: '', started: true, auto: false, model: null,
  alwaysAllow: [], pos: { x: 0, y: 0 }, color: null, effort: null, effortNow: null, modelNow: null, lastContext: null, bypassOn: false, status: 'idle', errorText: null, bypass: false, bypassBySettings: false, bypassPending: false, heldInput: 0, planMode: false, asleep: false, waking: false, hold: null, subagentsRunning: [], pastCount: 0, remoteIssue: null, ...over,
})
const toolItem = (name: string, input: unknown) => ({ t: 5, kind: 'assistant', blocks: [{ type: 'tool_use', id: 'u', name, input }] })

let handlers: Record<string, ((p: any) => void)[]>
const emit = (k: string, p: unknown) => act(() => { (handlers[k] ?? []).forEach(f => f(p)) })
const wait = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms) })

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
  const { TerminalWall } = await import('../../src/renderer/power/TerminalWall')
  const store = getStore()
  await act(async () => { await store.init() })
  if (rooms.length) act(() => { store.selectRoom('r1') })
  await act(async () => { await store.setPower(true) })
  return render(<TerminalWall seed={7} />)
}
const panes = () => [...document.querySelectorAll('.pw-t-pane')]
const bodies = () => [...document.querySelectorAll('.pw-t-pb')] as HTMLElement[]
const first = () => bodies()[0]
const visible = (v: 'visible' | 'hidden') => Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => v })

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { visible('visible'); cleanup(); vi.useRealTimers() })

describe('터미널 벽', () => {
  it('창_6개와_상태_줄이_있다', async () => {
    await mount([])
    expect(panes()).toHaveLength(6)
    const titles = panes().map(p => p.querySelector('.pw-t-ptl')!.textContent)
    expect(titles[0]).toBe('총괄 — claude · ~/work/order-service')
    expect(titles[1]).toBe('테스트 — npx vitest --watch')
    expect(titles[2]).toBe('검토 — git diff main...HEAD')
    expect(titles[3]).toMatch(/^구현 — src\//)
    expect(titles[4]).toBe('서브에이전트 ×4')
    expect(titles[5]).toBe('시스템')
    const bar = document.querySelector('.pw-t-bar')!
    expect(bar).toHaveTextContent('[두레]')
    expect(bar).toHaveTextContent('0:총괄*1:구현2:테스트3:검토4:서브5:시스템')
    expect(bar).toHaveTextContent(/토큰 1\.\d\dM · 부하 \d\.\d\d \d\.\d\d \d\.\d\d · \d\d:\d\d/)
    expect(document.querySelectorAll('.pw-t-pane[data-focus]')).toHaveLength(1)
  })

  it('진짜_방은_경로를_안_쓰고_창_이름은_진짜_에이전트_앞_4명', async () => {
    await mount(Array.from({ length: 6 }, (_, i) => agent(`x${i}`, { name: `이름${i}` })))
    expect(panes()[0].querySelector('.pw-t-ptl')!.textContent).toBe('이름0 — claude')
    expect(document.querySelector('.pw-t-wins')).toHaveTextContent('0:이름0*1:이름12:이름23:이름34:서브5:시스템')
    expect(document.querySelector('.pw-t-bar')).not.toHaveTextContent('이름4')
  })

  it('초점이_4.2초마다_넘어간다', async () => {
    await mount([])
    const at = () => panes().findIndex(p => p.hasAttribute('data-focus'))
    expect(at()).toBe(0)
    await wait(4300)
    expect(at()).toBe(1)
    await wait(4200)
    expect(at()).toBe(2)
    expect(document.querySelector('.pw-t-win[data-on]')).toHaveTextContent('2:테스트*')
  })

  it('서브에이전트_수는_진짜가_있으면_그대로', async () => {
    await mount([agent('a', { name: '알파', subagentsRunning: [{ id: 's1' }, { id: 's2' }] })])
    expect(panes()[4].querySelector('.pw-t-ptl')!.textContent).toBe('서브에이전트 ×2')
  })

  it('창마다_줄은_60줄을_넘지_않는다', async () => {
    await mount([])
    await wait(30000)
    for (const b of bodies()) expect(b.querySelectorAll('.pw-t-ln').length).toBeLessThanOrEqual(60)
    // 흐르는 창은 가득 찼다
    expect(bodies()[1].childElementCount).toBe(60)
    expect(document.querySelector('.pw-t-sub')!.childElementCount).toBeLessThanOrEqual(60)
  })

  it('진짜_tool_사건이_첫_창에_보인다', async () => {
    await mount([agent('a', { name: '알파' })])
    await emit('history', { agentId: 'a', item: toolItem('Read', { file_path: 'src/real/one.ts' }) })
    await wait(300)
    const last = [...first().children].slice(-2)
    expect(last[0]).toHaveTextContent('Read(src/real/one.ts)')
    expect(last[1]).toHaveTextContent('⎿')
    // 진짜 사건 뒤 몇 초는 채움이 끼어들지 않는다
    await wait(2000)
    expect([...first().children].slice(-2)[0]).toHaveTextContent('Read(src/real/one.ts)')
  })

  it('승인을_기다리는_대표는_한_줄뿐이다', async () => {
    await mount([agent('a', { name: '알파', status: 'awaiting' }), agent('b', { name: '베타' })])
    await wait(15000)
    expect(first().children).toHaveLength(1)
    expect(first()).toHaveTextContent('승인을 기다리는 중…')
    expect(panes()[0].querySelector('.pw-t-ptl i')).toHaveAttribute('data-warn')
  })

  it('호박색_점은_진짜_승인_기다림_창만_시스템_창은_보통_점', async () => {
    await mount([agent('a', { name: '알파' })])
    expect(document.querySelectorAll('.pw-t-ptl i[data-warn]')).toHaveLength(0)
    expect(panes()[5].querySelector('.pw-t-ptl i')).not.toBeNull()
    cleanup()
    await mount([agent('a', { name: '알파', status: 'awaiting' })])
    const warned = [...document.querySelectorAll('.pw-t-ptl i[data-warn]')].map(i => panes().indexOf(i.closest('.pw-t-pane')!))
    expect(warned).toEqual([0])
  })

  it('켠_뒤에_방에_들어온_에이전트가_대표에게_넘겨도_날_id_가_첫_창에_새지_않는다', async () => {
    const list: object[] = [agent('a', { name: '알파' })]
    await mount(list)
    list.push(agent('zz-new', { name: '신입' }))
    const { getStore } = await import('../../src/renderer/state/store')
    await act(async () => { await getStore().refresh() })
    await emit('message', { id: 'm1', roomId: 'r1', from: 'zz-new', to: 'a', text: '새로 왔어요', createdAt: 1, state: 'pending', updatedAt: 1 })
    await wait(300)
    expect(first()).not.toHaveTextContent(/zz-new|새로 왔어요/)
  })

  it('줄은_텍스트_노드로만_넣는다', async () => {
    await mount([agent('a', { name: '알파' })])
    await emit('history', { agentId: 'a', item: toolItem('Bash', { command: '<img src=x onerror=alert(1)>' }) })
    await wait(300)
    expect(document.querySelector('.pw-t-wall img')).toBeNull()
    expect(first()).toHaveTextContent('<img src=x onerror=alert(1)>')
    for (const f of ['TerminalWall.tsx', 'terminal/Pane.tsx', 'terminal/panes.ts']) {
      const src = fs.readFileSync(path.resolve('src/renderer/power', f), 'utf8')
      expect(src).not.toMatch(/dangerouslySetInnerHTML|innerHTML|insertAdjacentHTML/)
    }
  })

  it('안_보이는_동안은_흐르지_않는다', async () => {
    await mount([])
    const before = bodies()[1].innerHTML
    visible('hidden')
    await wait(10000)
    expect(bodies()[1].innerHTML).toBe(before)
    visible('visible')
    await wait(3000)
    expect(bodies()[1].innerHTML).not.toBe(before)
  })

  it('치우면_타이머가_멈춘다', async () => {
    await mount([])
    cleanup()
    expect(vi.getTimerCount()).toBe(0)
  })
})
