import { describe, it, expect, vi, afterEach } from 'vitest'
import { useEffect } from 'react'
import { render, act, cleanup } from '@testing-library/react'
import type { ScreenEvent } from '../../src/renderer/power/events'
import type { PowerView } from '../../src/renderer/power/usePowerFeed'

// 사건 먹이 — 스토어의 듣기를 그대로 넘기되, 창이 안 보이는 동안 온 사건은 버린다

const agent = (id: string, over: object = {}) => ({
  id, roomId: 'r1', name: id, role: `${id}역`, folder: '/x', sessionId: '', started: true, auto: false, model: null,
  alwaysAllow: [], pos: { x: 0, y: 0 }, color: null, effort: null, effortNow: null, modelNow: null, lastContext: null, bypassOn: false, status: 'idle', errorText: null, bypass: false, bypassBySettings: false, bypassPending: false, heldInput: 0, planMode: false, asleep: false, waking: false, hold: null, subagentsRunning: [], pastCount: 0, remoteIssue: null, ...over,
})
const toolItem = (name: string, input: unknown) => ({ t: 5, kind: 'assistant', blocks: [{ type: 'tool_use', id: 'u', name, input }] })

let handlers: Record<string, ((p: any) => void)[]>
const emit = (k: string, p: unknown) => act(() => { (handlers[k] ?? []).forEach(f => f(p)) })

async function mount(agents: object[]) {
  vi.resetModules()
  handlers = {}
  ;(window as any).dure = {
    snapshot: async () => ({ claudeMissing: false, rooms: [{ id: 'r1', name: '진짜 방', createdAt: 1 }], agents, messages: [], requests: [], autoChainLimit: 5, allowBypass: false, notify: { asks: true, finished: false }, sleepAfterMin: 30, usage: null }),
    history: async () => [],
    setPowerMode: async () => {},
    on: (k: string, fn: (p: any) => void) => { (handlers[k] ??= []).push(fn); return () => {} },
  }
  const { getStore } = await import('../../src/renderer/state/store')
  const { usePowerFeed } = await import('../../src/renderer/power/usePowerFeed')
  const store = getStore()
  await act(async () => { await store.init() })
  act(() => { store.selectRoom('r1') })
  await act(async () => { await store.setPower(true) })
  const got: ScreenEvent[] = []
  const views: PowerView[] = []
  function Probe() {
    const { view, subscribe } = usePowerFeed()
    views.push(view)
    useEffect(() => subscribe(e => got.push(e)), [subscribe])
    return null
  }
  render(<Probe />)
  return { got, view: () => views[views.length - 1], store }
}

afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('usePowerFeed', () => {
  it('숨은_동안_온_1000개는_버린다', async () => {
    const vis = vi.spyOn(document, 'visibilityState', 'get')
    vis.mockReturnValue('visible')
    const { got } = await mount([agent('a')])
    vis.mockReturnValue('hidden')
    for (let i = 0; i < 1000; i++) await emit('history', { agentId: 'a', item: toolItem('Read', { file_path: `stale${i}.ts` }) })
    expect(got).toEqual([])
    vis.mockReturnValue('visible')
    await emit('history', { agentId: 'a', item: toolItem('Read', { file_path: 'fresh.ts' }) })
    expect(got).toMatchObject([{ kind: 'tool', agentId: 'a', target: 'fresh.ts' }])
  })

  it('보이는_동안은_사건을_바로_넘긴다', async () => {
    const { got } = await mount([agent('a')])
    await emit('history', { agentId: 'a', item: toolItem('Bash', { command: 'npm test' }) })
    await emit('history', { agentId: 'a', item: { t: 6, kind: 'result', ok: true, subtype: 'success' } })
    expect(got.map(e => e.kind)).toEqual(['tool', 'done'])
  })

  it('view_는_켠_순간의_에이전트이고_상태는_스토어를_따른다', async () => {
    const list: object[] = [agent('a', { name: '알파' }), agent('b', { name: '베타' })]
    const { view, store } = await mount(list)
    expect(view().roomName).toBe('진짜 방')
    expect(view().agents.map(a => a.name)).toEqual(['알파', '베타'])
    expect(view().state).toEqual({ a: 'resting', b: 'resting' })
    await emit('status', { agentId: 'a', status: 'working', errorText: null })
    expect(view().state.a).toBe('working')
    list.push(agent('zz-new', { name: '신입' }))
    await act(async () => { await store.refresh() })
    expect(view().agents.map(a => a.id)).toEqual(['a', 'b'])
  })
})
