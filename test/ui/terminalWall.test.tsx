import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { render, act, cleanup } from '@testing-library/react'
import fs from 'node:fs'
import path from 'node:path'

// 터미널 벽 — 이번 판은 자리표: 첫 에이전트의 진짜 사건만 창 하나에. 지어낸 창·줄·숫자는 없다(창 여럿은 Task 3)

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
  return render(<TerminalWall />)
}
const panes = () => [...document.querySelectorAll('.pw-t-pane')]
const first = () => document.querySelector('.pw-t-pb') as HTMLElement
const visible = (v: 'visible' | 'hidden') => Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => v })

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { visible('visible'); cleanup(); vi.useRealTimers() })

describe('터미널 벽', () => {
  it.todo('창_6개와_상태_줄이_있다')
  it.todo('진짜_방은_경로를_안_쓰고_창_이름은_진짜_에이전트_앞_4명')

  it('창_하나와_상태_줄_—_제목은_진짜_이름과_역할_지어낸_토큰·부하는_없다', async () => {
    await mount([agent('a', { name: '알파', role: '구현' }), agent('b', { name: '베타' })])
    expect(panes()).toHaveLength(1)
    expect(panes()[0].querySelector('.pw-t-ptl')!.textContent).toBe('알파 — 구현')
    const bar = document.querySelector('.pw-t-bar')!
    expect(bar).toHaveTextContent('[두레]')
    expect(bar).toHaveTextContent('0:알파*1:베타')
    expect(bar).toHaveTextContent(/\d\d:\d\d$/)
    expect(bar).not.toHaveTextContent(/토큰|부하/)
    // 사건이 오기 전엔 비어 있다
    await wait(15000)
    expect(first().children).toHaveLength(0)
  })

  it('방이_없으면_빈_창_하나', async () => {
    await mount([])
    expect(panes()).toHaveLength(1)
    expect(panes()[0].querySelector('.pw-t-ptl')!.textContent).toBe('이 방엔 에이전트가 없어요')
    await wait(15000)
    expect(first().children).toHaveLength(0)
  })

  it('창마다_줄은_60줄을_넘지_않는다', async () => {
    await mount([agent('a', { name: '알파' })])
    for (let i = 0; i < 100; i++) await emit('history', { agentId: 'a', item: toolItem('Read', { file_path: `f${i}.ts` }) })
    expect(first().childElementCount).toBe(60)
    expect(first().lastElementChild).toHaveTextContent('Read(f99.ts)')
  })

  it('진짜_tool_사건이_첫_창에_보인다', async () => {
    await mount([agent('a', { name: '알파' })])
    await emit('history', { agentId: 'a', item: toolItem('Read', { file_path: 'src/real/one.ts' }) })
    expect(first().lastElementChild).toHaveTextContent('● Read(src/real/one.ts)')
    await emit('history', { agentId: 'a', item: { t: 6, kind: 'tool-result', toolUseId: 'u', isError: true, text: '파일이 없어요', viaApproval: false } })
    await emit('history', { agentId: 'a', item: { t: 7, kind: 'result', ok: true, subtype: 'success' } })
    const last = [...first().children].slice(-2)
    expect(last[0]).toHaveTextContent('⎿ 파일이 없어요')
    expect(last[1]).toHaveTextContent('✓ 끝남')
    // 진짜 사건 뒤에 지어낸 줄이 끼어들지 않는다
    await wait(5000)
    expect(first().children).toHaveLength(3)
  })

  it('승인을_기다리는_대표는_한_줄뿐이다', async () => {
    await mount([agent('a', { name: '알파', status: 'awaiting' }), agent('b', { name: '베타' })])
    await wait(15000)
    expect(first().children).toHaveLength(1)
    expect(first()).toHaveTextContent('승인을 기다리는 중…')
    expect(panes()[0].querySelector('.pw-t-ptl i')).toHaveAttribute('data-warn')
  })

  it('호박색_점은_진짜_승인_기다림일_때만', async () => {
    await mount([agent('a', { name: '알파' })])
    expect(document.querySelectorAll('.pw-t-ptl i[data-warn]')).toHaveLength(0)
    expect(panes()[0].querySelector('.pw-t-ptl i')).not.toBeNull()
    await emit('status', { agentId: 'a', status: 'awaiting', errorText: null })
    expect(document.querySelectorAll('.pw-t-ptl i[data-warn]')).toHaveLength(1)
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
    expect(document.querySelector('.pw-t-wall img')).toBeNull()
    expect(first()).toHaveTextContent('<img src=x onerror=alert(1)>')
    for (const f of ['TerminalWall.tsx', 'terminal/Pane.tsx', 'terminal/panes.ts']) {
      const src = fs.readFileSync(path.resolve('src/renderer/power', f), 'utf8')
      expect(src).not.toMatch(/dangerouslySetInnerHTML|innerHTML|insertAdjacentHTML/)
    }
  })

  it('안_보이는_동안_온_사건은_흐르지_않는다', async () => {
    await mount([agent('a', { name: '알파' })])
    visible('hidden')
    await emit('history', { agentId: 'a', item: toolItem('Read', { file_path: 'stale.ts' }) })
    expect(first().children).toHaveLength(0)
    visible('visible')
    await emit('history', { agentId: 'a', item: toolItem('Read', { file_path: 'fresh.ts' }) })
    expect(first()).toHaveTextContent('fresh.ts')
    expect(first()).not.toHaveTextContent('stale.ts')
  })

  it('치우면_타이머가_멈춘다', async () => {
    await mount([])
    cleanup()
    expect(vi.getTimerCount()).toBe(0)
  })
})
