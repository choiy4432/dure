import { describe, it, expect, vi } from 'vitest'
import { createStore } from '../../src/renderer/state/store'
import type { EngineEventMap, HistoryItem, RelayMessage } from '../../src/engine/types'
import type { AgentView, DureApi, Snapshot } from '../../src/shared/ipcContract'

const agent = (id: string, roomId = 'r1', over: Partial<AgentView> = {}): AgentView => ({
  id, roomId, name: id, role: '', folder: '/x', sessionId: '', started: true, auto: false, model: null,
  alwaysAllow: [], pos: { x: 0, y: 0 }, color: null, status: 'idle', errorText: null, bypass: false, heldInput: 0, ...over,
})
const snap = (over: Partial<Snapshot> = {}): Snapshot => ({
  claudeMissing: false,
  rooms: [{ id: 'r1', name: '첫 방', createdAt: 2 }, { id: 'r2', name: '둘째', createdAt: 1 }],
  agents: [agent('a'), agent('b'), agent('c', 'r2')],
  messages: [], requests: [], autoChainLimit: 5, ...over,
})
const note = (text: string, t = 1): HistoryItem => ({ t, kind: 'notice', text })

function fake(opts: { snapshot?: () => Promise<Snapshot>; history?: (id: string) => Promise<HistoryItem[]> } = {}) {
  const handlers: Record<string, ((p: any) => void)[]> = {}
  const api = {
    snapshot: vi.fn(opts.snapshot ?? (async () => snap())),
    history: vi.fn(opts.history ?? (async () => [])),
    on: vi.fn((k: string, fn: (p: any) => void) => {
      ;(handlers[k] ??= []).push(fn)
      return () => {}
    }),
  } as unknown as DureApi & { snapshot: ReturnType<typeof vi.fn>; history: ReturnType<typeof vi.fn> }
  const emit = <K extends keyof EngineEventMap>(k: K, p: EngineEventMap[K]) => (handlers[k] ?? []).forEach(f => f(p))
  return { api, emit }
}

const relay = (id: string, state: RelayMessage['state'], over: Partial<RelayMessage> = {}): RelayMessage => ({
  id, roomId: 'r1', from: 'a', to: 'b', text: 'x', createdAt: 1, state, updatedAt: 1, ...over,
})

describe('store init', () => {
  it('snapshot 을 그대로 담고 첫 방을 고른다', async () => {
    const { api } = fake()
    const s = createStore(api)
    await s.init()
    expect(s.getState().roomId).toBe('r1')
    expect(s.getState().agents).toHaveLength(3)
    expect(s.getState().selectedAgentId).toBeNull()
  })

  it('다시 켠 뒤의 snapshot 은 지난 requests 없이 대기 메시지는 그대로', async () => {
    const { api } = fake({ snapshot: async () => snap({ requests: [], messages: [relay('m1', 'pending'), relay('m2', 'held')] }) })
    const s = createStore(api)
    await s.init()
    expect(s.getState().requests).toEqual([])
    expect(s.getState().messages.map(m => m.state)).toEqual(['pending', 'held'])
  })

  it('snapshot 을 기다리는 동안 온 이벤트는 snapshot 뒤에 적용된다', async () => {
    let release!: (s: Snapshot) => void
    const { api, emit } = fake({ snapshot: () => new Promise<Snapshot>(r => { release = r }) })
    const s = createStore(api)
    const p = s.init()
    emit('status', { agentId: 'a', status: 'working', errorText: null })
    emit('message', relay('m1', 'pending'))
    expect(s.getState().agents).toHaveLength(0)
    release(snap())
    await p
    expect(s.getState().agents.find(a => a.id === 'a')!.status).toBe('working')
    expect(s.getState().messages).toHaveLength(1)
  })

  it('snapshot 에 이미 들어 있는 메시지가 이벤트로 또 와도 중복되지 않는다', async () => {
    let release!: (s: Snapshot) => void
    const { api, emit } = fake({ snapshot: () => new Promise<Snapshot>(r => { release = r }) })
    const s = createStore(api)
    const p = s.init()
    emit('message', relay('m1', 'delivered', { updatedAt: 5 }))
    release(snap({ messages: [relay('m1', 'delivered', { updatedAt: 5 })] }))
    await p
    expect(s.getState().messages).toHaveLength(1)
  })
})

describe('store events', () => {
  it('status·flags·held-input 은 에이전트에 반영', async () => {
    const { api, emit } = fake()
    const s = createStore(api)
    await s.init()
    emit('status', { agentId: 'a', status: 'error', errorText: '멈춤' })
    emit('flags', { agentId: 'a', bypass: true })
    emit('held-input', { agentId: 'a', count: 2 })
    expect(s.getState().agents[0]).toMatchObject({ status: 'error', errorText: '멈춤', bypass: true, heldInput: 2 })
  })

  it('message 는 id 로 갱신하고 delivered 면 lastDelivered 에 updatedAt 을 쓴다', async () => {
    const { api, emit } = fake()
    const s = createStore(api)
    await s.init()
    emit('message', relay('m1', 'pending', { updatedAt: 10 }))
    expect(s.getState().lastDelivered).toEqual({})
    emit('message', relay('m1', 'delivered', { updatedAt: 20 }))
    expect(s.getState().messages).toHaveLength(1)
    expect(s.getState().lastDelivered).toEqual({ 'a>b': 20 })
  })

  it('request 추가·request-resolved 제거', async () => {
    const { api, emit } = fake()
    const s = createStore(api)
    await s.init()
    emit('request', { id: 'q1', agentId: 'a', toolName: 'Bash', input: {}, kind: 'permission', createdAt: 1 })
    expect(s.getState().requests).toHaveLength(1)
    emit('request-resolved', { id: 'q1', agentId: 'a' })
    expect(s.getState().requests).toEqual([])
  })

  it('text-delta 는 streaming 에 쌓이고 history 가 붙으면 비워진다', async () => {
    const { api, emit } = fake({ history: async () => [note('옛')] })
    const s = createStore(api)
    await s.init()
    s.selectAgent('a')
    await vi.waitFor(() => expect(s.getState().history.a).toBeDefined())
    emit('agent-event', { agentId: 'a', event: { kind: 'text-delta', text: '안' } })
    emit('agent-event', { agentId: 'a', event: { kind: 'text-delta', text: '녕' } })
    expect(s.getState().streaming.a).toBe('안녕')
    emit('history', { agentId: 'a', item: note('새', 2) })
    expect(s.getState().history.a.map(i => (i as any).text)).toEqual(['옛', '새'])
    expect(s.getState().streaming.a).toBe('')
  })

  it('기록을 아직 안 불러온 에이전트의 history 이벤트는 무시', async () => {
    const { api, emit } = fake()
    const s = createStore(api)
    await s.init()
    emit('history', { agentId: 'b', item: note('x') })
    expect(s.getState().history.b).toBeUndefined()
  })

  it('기록을 안 불러온 에이전트도 흐르는 글은 차례마다 비워진다', async () => {
    const { api, emit } = fake()
    const s = createStore(api)
    await s.init()
    emit('agent-event', { agentId: 'b', event: { kind: 'text-delta', text: '첫 답' } })
    emit('history', { agentId: 'b', item: { t: 2, kind: 'assistant', blocks: [{ type: 'text', text: '첫 답' }] } })
    expect(s.getState().streaming.b).toBe('')
    emit('agent-event', { agentId: 'b', event: { kind: 'text-delta', text: '둘째' } })
    expect(s.getState().streaming.b).toBe('둘째')
  })

  it('lastText = 에이전트마다 마지막 assistant 글과 시각(기록을 불러왔든 아니든)', async () => {
    const { api, emit } = fake()
    const s = createStore(api)
    await s.init()
    const said = (text: string, t: number): HistoryItem => ({ t, kind: 'assistant', blocks: [{ type: 'text', text }] })
    emit('history', { agentId: 'b', item: said('배너 문구를 넘겼어요', 5) })
    emit('history', { agentId: 'b', item: { t: 6, kind: 'assistant', blocks: [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }] } })
    emit('history', { agentId: 'b', item: note('알림', 7) })
    expect(s.getState().lastText.b).toEqual({ text: '배너 문구를 넘겼어요', at: 5 })
  })

  it('기록을 불러오면 그 안의 마지막 assistant 글로 lastText 를 채운다', async () => {
    const said = (text: string, t: number): HistoryItem => ({ t, kind: 'assistant', blocks: [{ type: 'text', text }] })
    const { api } = fake({ history: async () => [said('옛 답', 1), said('새 답', 3), note('끝', 4)] })
    const s = createStore(api)
    await s.init()
    s.selectAgent('a')
    await vi.waitFor(() => expect(s.getState().history.a).toBeDefined())
    expect(s.getState().lastText.a).toEqual({ text: '새 답', at: 3 })
  })
})

describe('store selection', () => {
  it('에이전트를 고르면 기록을 한 번만 불러온다', async () => {
    const { api } = fake({ history: async () => [note('하나')] })
    const s = createStore(api)
    await s.init()
    s.selectAgent('a')
    s.selectAgent('a')
    await vi.waitFor(() => expect(s.getState().history.a).toHaveLength(1))
    s.selectAgent(null)
    s.selectAgent('a')
    expect(api.history).toHaveBeenCalledTimes(1)
  })

  it('기록을 불러오는 동안 온 history 이벤트가 빠지지 않는다', async () => {
    let release!: (h: HistoryItem[]) => void
    const { api, emit } = fake({ history: () => new Promise<HistoryItem[]>(r => { release = r }) })
    const s = createStore(api)
    await s.init()
    s.selectAgent('a')
    emit('history', { agentId: 'a', item: note('늦게', 3) })
    emit('history', { agentId: 'a', item: note('겹침', 2) })
    release([note('옛', 1), note('겹침', 2)])
    await vi.waitFor(() => expect(s.getState().history.a).toBeDefined())
    expect(s.getState().history.a.map(i => (i as any).text)).toEqual(['옛', '겹침', '늦게'])
  })

  it('방을 바꾸면 선택한 에이전트를 비우고, 모르는 방은 무시', async () => {
    const { api } = fake()
    const s = createStore(api)
    await s.init()
    s.selectAgent('a')
    s.selectRoom('r2')
    expect(s.getState()).toMatchObject({ roomId: 'r2', selectedAgentId: null })
    s.selectRoom('nope')
    expect(s.getState().roomId).toBe('r2')
  })

  it('선택한 방이 사라지면 남은 첫 방으로, 없으면 null', async () => {
    const { api } = fake()
    const s = createStore(api)
    await s.init()
    s.selectRoom('r2')
    api.snapshot.mockResolvedValueOnce(snap({ rooms: [{ id: 'r1', name: '첫 방', createdAt: 2 }] }))
    await s.refresh()
    expect(s.getState().roomId).toBe('r1')
    api.snapshot.mockResolvedValueOnce(snap({ rooms: [], agents: [] }))
    await s.refresh()
    expect(s.getState().roomId).toBeNull()
  })

  it('subscribe 는 변경을 알리고 해제할 수 있다', async () => {
    const { api, emit } = fake()
    const s = createStore(api)
    await s.init()
    const fn = vi.fn()
    const off = s.subscribe(fn)
    emit('flags', { agentId: 'a', bypass: true })
    expect(fn).toHaveBeenCalledTimes(1)
    off()
    emit('flags', { agentId: 'a', bypass: false })
    expect(fn).toHaveBeenCalledTimes(1)
  })
})

describe('store 스냅샷 겹침 합치기', () => {
  it('겹친 refresh 두 번은 요청을 하나로 합치고, 사이에 온 이벤트는 한 번만 적용된다', async () => {
    const { api, emit } = fake()
    const s = createStore(api)
    await s.init()
    const resolvers: ((v: Snapshot) => void)[] = []
    api.snapshot.mockImplementation(() => new Promise<Snapshot>(r => { resolvers.push(r) }))
    const p1 = s.refresh()
    emit('message', relay('m1', 'pending', { updatedAt: 5 }))
    const p2 = s.refresh()
    expect(resolvers).toHaveLength(1) // 두 번째는 아직 시작 안 함
    resolvers[0](snap({ autoChainLimit: 1 }))
    await vi.waitFor(() => expect(resolvers).toHaveLength(2))
    emit('message', relay('m2', 'pending', { updatedAt: 6, createdAt: 6 }))
    resolvers[1](snap({ autoChainLimit: 2, messages: [relay('m1', 'pending', { updatedAt: 5 })] }))
    await Promise.all([p1, p2])
    expect(s.getState().autoChainLimit).toBe(2)
    expect(s.getState().messages.map(m => m.id)).toEqual(['m1', 'm2'])
    expect(api.snapshot).toHaveBeenCalledTimes(3) // init + 합쳐진 2번
  })

  it('init 도중 refresh 도 이벤트를 잃지 않는다', async () => {
    const { api, emit } = fake()
    const resolvers: ((v: Snapshot) => void)[] = []
    api.snapshot.mockImplementation(() => new Promise<Snapshot>(r => { resolvers.push(r) }))
    const s = createStore(api)
    const p1 = s.init()
    const p2 = s.refresh()
    resolvers[0](snap())
    await vi.waitFor(() => expect(resolvers).toHaveLength(2))
    emit('status', { agentId: 'a', status: 'working', errorText: null })
    resolvers[1](snap())
    await Promise.all([p1, p2])
    expect(s.getState().agents[0].status).toBe('working')
  })
})

describe('store 기록 불러오기 상태', () => {
  it('loading → ready', async () => {
    let release!: (h: HistoryItem[]) => void
    const { api } = fake({ history: () => new Promise<HistoryItem[]>(r => { release = r }) })
    const s = createStore(api)
    await s.init()
    s.selectAgent('a')
    expect(s.getState().historyStatus.a).toEqual({ state: 'loading' })
    release([note('x')])
    await vi.waitFor(() => expect(s.getState().historyStatus.a).toEqual({ state: 'ready' }))
  })

  it('실패하면 error 와 메시지를 남기고(미처리 거부 없음), 다시 고르면 재시도한다', async () => {
    const h = vi.fn().mockRejectedValueOnce(new Error('기록을 못 읽었어요')).mockResolvedValue([note('다시')])
    const { api } = fake({ history: h })
    const s = createStore(api)
    await s.init()
    s.selectAgent('a')
    await vi.waitFor(() => expect(s.getState().historyStatus.a?.state).toBe('error'))
    expect(s.getState().historyStatus.a.error).toBe('기록을 못 읽었어요')
    expect(s.getState().history.a).toBeUndefined()
    s.selectAgent('a')
    await vi.waitFor(() => expect(s.getState().historyStatus.a).toEqual({ state: 'ready' }))
    expect(s.getState().history.a).toHaveLength(1)
  })
})
