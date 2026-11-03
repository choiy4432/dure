import { describe, it, expect, vi } from 'vitest'
import { createStore } from '../../src/renderer/state/store'
import type { EngineEventMap, HistoryItem, RelayMessage } from '../../src/engine/types'
import type { AgentView, DureApi, DureEventMap, Snapshot } from '../../src/shared/ipcContract'
import { DEFAULT_APP_PREFS, type AppInfo, type AppPrefs, type ClaudeUpdateState, type SetupState, type UpdateState } from '../../src/shared/appTypes'

const agent = (id: string, roomId = 'r1', over: Partial<AgentView> = {}): AgentView => ({
  id, roomId, name: id, role: '', folder: '/x', sessionId: '', started: true, auto: false, model: null,
  alwaysAllow: [], pos: { x: 0, y: 0 }, color: null, effort: null, effortNow: null, modelNow: null, lastContext: null, bypassOn: false, status: 'idle', errorText: null, bypass: false, bypassBySettings: false, bypassPending: false, heldInput: 0, planMode: false, asleep: false, waking: false, hold: null, subagentsRunning: [], pastCount: 0, remoteIssue: null, ...over,
})
const snap = (over: Partial<Snapshot> = {}): Snapshot => ({
  claudeMissing: false,
  rooms: [{ id: 'r1', name: '첫 방', createdAt: 2 }, { id: 'r2', name: '둘째', createdAt: 1 }],
  agents: [agent('a'), agent('b'), agent('c', 'r2')],
  messages: [], requests: [], autoChainLimit: 5, allowBypass: false, notify: { asks: true, finished: false }, sleepAfterMin: 30, usage: null, ...over,
})
const note = (text: string, t = 1): HistoryItem => ({ t, kind: 'notice', text })

type AppOpts = {
  appInfo?: () => Promise<AppInfo>; prefs?: () => Promise<AppPrefs>; setPrefs?: (p: Partial<AppPrefs>) => Promise<AppPrefs>
  setupState?: () => Promise<SetupState>; updateState?: () => Promise<UpdateState>; claudeUpdateState?: () => Promise<ClaudeUpdateState>
}
function fake(opts: { snapshot?: () => Promise<Snapshot>; history?: (id: string) => Promise<HistoryItem[]> } & AppOpts = {}) {
  const handlers: Record<string, ((p: any) => void)[]> = {}
  const api = {
    snapshot: vi.fn(opts.snapshot ?? (async () => snap())),
    history: vi.fn(opts.history ?? (async () => [])),
    appInfo: vi.fn(opts.appInfo ?? (async () => ({ version: '1.0.0', packaged: true }))),
    prefs: vi.fn(opts.prefs ?? (async () => ({ ...DEFAULT_APP_PREFS }))),
    setPrefs: vi.fn(opts.setPrefs ?? (async (p: Partial<AppPrefs>) => ({ ...DEFAULT_APP_PREFS, ...p }))),
    setupState: vi.fn(opts.setupState ?? (async () => ({ phase: 'ready' }) as SetupState)),
    updateState: vi.fn(opts.updateState ?? (async () => ({ kind: 'idle' }) as UpdateState)),
    claudeUpdateState: vi.fn(opts.claudeUpdateState ?? (async () => 'idle' as ClaudeUpdateState)),
    on: vi.fn((k: string, fn: (p: any) => void) => {
      ;(handlers[k] ??= []).push(fn)
      return () => {}
    }),
  } as unknown as DureApi & { snapshot: ReturnType<typeof vi.fn>; history: ReturnType<typeof vi.fn> }
  const emit = <K extends keyof DureEventMap>(k: K, p: DureEventMap[K]) => (handlers[k] ?? []).forEach(f => f(p))
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

  it('status 사건의 remoteIssue 가 에이전트에 들어가고 null 로 지워진다 · 칸이 없으면 그대로', async () => {
    const { api, emit } = fake()
    const s = createStore(api)
    await s.init()
    const get = () => s.getState().agents.find(a => a.id === 'a')!
    emit('status', { agentId: 'a', status: 'error', errorText: null, remoteIssue: { kind: 'unreachable', detail: 'x' } })
    expect(get().remoteIssue).toEqual({ kind: 'unreachable', detail: 'x' })
    emit('status', { agentId: 'a', status: 'idle', errorText: null }) // 이 PC 방 꼴 — 칸 없음
    expect(get().remoteIssue).toEqual({ kind: 'unreachable', detail: 'x' })
    emit('status', { agentId: 'a', status: 'idle', errorText: null, remoteIssue: null })
    expect(get().remoteIssue).toBeNull()
  })

  it('snapshot 의 rooms[].remote 가 그대로 들어온다', async () => {
    const { api } = fake({ snapshot: async () => snap({ rooms: [{ id: 'r1', name: '서버', createdAt: 1, remote: { host: 'dev' } }] }) })
    const s = createStore(api)
    await s.init()
    expect(s.getState().rooms[0].remote).toEqual({ host: 'dev' })
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
    emit('flags', { agentId: 'a', bypass: true, bySettings: false, pending: false })
    emit('held-input', { agentId: 'a', count: 2 })
    expect(s.getState().agents[0]).toMatchObject({ status: 'error', errorText: '멈춤', bypass: true, heldInput: 2 })
  })

  it('sleep 사건은 그 에이전트의 잠듦·깨우는 중만 바꾸고, 스냅샷의 재우기 시간이 상태에 들어온다', async () => {
    const { api, emit } = fake({ snapshot: async () => snap({ sleepAfterMin: 60 }) })
    const s = createStore(api)
    await s.init()
    expect(s.getState().sleepAfterMin).toBe(60)
    emit('sleep', { agentId: 'a', asleep: true, waking: false })
    expect(s.getState().agents.map(a => [a.asleep, a.waking])).toEqual([[true, false], [false, false], [false, false]])
    emit('sleep', { agentId: 'a', asleep: true, waking: true })
    expect(s.getState().agents[0]).toMatchObject({ asleep: true, waking: true })
  })

  it('plan-mode·hold 사건이 에이전트 보기를 바꾼다', async () => {
    const { api, emit } = fake()
    const s = createStore(api)
    await s.init()
    const hold = { since: 1, items: [] }
    emit('plan-mode', { agentId: 'a', on: true })
    emit('hold', { agentId: 'a', hold })
    expect(s.getState().agents[0]).toMatchObject({ planMode: true, hold })
    emit('hold', { agentId: 'a', hold: null })
    expect(s.getState().agents[0].hold).toBeNull()
  })

  it('always-allow 사건이 그 에이전트의 늘 허용 목록을 바꾼다 — 스냅샷을 다시 받지 않는다', async () => {
    const { api, emit } = fake()
    const s = createStore(api)
    await s.init()
    emit('always-allow', { agentId: 'b', alwaysAllow: ['Bash', 'Edit'] })
    expect(s.getState().agents.find(a => a.id === 'b')!.alwaysAllow).toEqual(['Bash', 'Edit'])
    expect(s.getState().agents.find(a => a.id === 'a')!.alwaysAllow).toEqual([])
    emit('always-allow', { agentId: 'b', alwaysAllow: ['Edit'] })
    expect(s.getState().agents.find(a => a.id === 'b')!.alwaysAllow).toEqual(['Edit'])
    expect(api.snapshot).toHaveBeenCalledTimes(1)
  })

  it('statusSince — 표시 상태가 바뀐 status 이벤트를 받은 시각, 같은 상태 반복엔 그대로', async () => {
    const { api, emit } = fake({ snapshot: async () => snap({ agents: [agent('a', 'r1', { status: 'working' }), agent('b')] }) })
    const s = createStore(api)
    await s.init()
    // 스냅샷으로만 아는 상태는 언제부터인지 모른다
    expect(s.getState().statusSince).toEqual({})
    // 벽시계와 흐른 시간이 함께 간다(시계를 돌린 게 아니다)
    const now = vi.spyOn(Date, 'now')
    const mono = vi.spyOn(performance, 'now')
    try {
      now.mockReturnValue(1_000)
      mono.mockReturnValue(100)
      emit('status', { agentId: 'b', status: 'working', errorText: null })
      expect(s.getState().statusSince.b).toBe(1_000)
      now.mockReturnValue(5_000)
      mono.mockReturnValue(4_100)
      emit('status', { agentId: 'b', status: 'working', errorText: null }) // 같은 상태 — 그대로
      expect(s.getState().statusSince.b).toBe(1_000)
      emit('status', { agentId: 'a', status: 'working', errorText: null }) // 이미 작업 중이던 a — 바뀐 게 아님
      expect(s.getState().statusSince.a).toBeUndefined()
      emit('status', { agentId: 'b', status: 'idle', errorText: null })
      expect(s.getState().statusSince.b).toBe(5_000)
    } finally {
      now.mockRestore()
      mono.mockRestore()
    }
  })

  it('statusSince — PC 시계를 돌리면(벽시계만 뛴다) 이미 적은 시작 시각도 같은 만큼 옮긴다 · 지난 시간은 그대로', async () => {
    const DAY = 24 * 60 * 60 * 1000
    const { api, emit } = fake({ snapshot: async () => snap({ agents: [agent('a'), agent('b')] }) })
    const s = createStore(api)
    await s.init()
    let wall = 1_800_000_000_000
    let mono = 50_000
    const now = vi.spyOn(Date, 'now').mockImplementation(() => wall)
    const perf = vi.spyOn(performance, 'now').mockImplementation(() => mono)
    const since = () => s.getState().statusSince
    try {
      emit('status', { agentId: 'b', status: 'working', errorText: null })
      expect(since().b).toBe(wall)
      wall += 3_000
      mono += 3_000
      wall -= 3 * DAY // 3초 뒤 시계를 3일 뒤로
      emit('status', { agentId: 'a', status: 'working', errorText: null })
      expect(since().a).toBe(wall) // 뛴 뒤에 받은 것은 지금 시계로
      expect(wall - since().b).toBe(3_000) // '0초'에 멈추지 않는다
      wall += 1_000
      mono += 1_000
      wall += 2 * DAY // 1초 뒤 앞으로 2일 — 어떤 이벤트든 받으면 맞춘다
      emit('held-input', { agentId: 'a', count: 0 })
      expect(wall - since().b).toBe(4_000)
      expect(wall - since().a).toBe(1_000)
      wall += 1_500 // 시간 동기화 정도의 작은 어긋남은 그대로 둔다
      mono += 1_000
      emit('held-input', { agentId: 'a', count: 0 })
      expect(wall - since().a).toBe(2_500)
    } finally {
      now.mockRestore()
      perf.mockRestore()
    }
  })

  it('followClock — 이벤트가 없어도(긴 명령이 도는 동안) 시계를 돌렸으면 맞추고 알린다 · 안 돌렸으면 알리지 않는다', async () => {
    const DAY = 24 * 60 * 60 * 1000
    const { api, emit } = fake({ snapshot: async () => snap({ agents: [agent('a')] }) })
    const s = createStore(api)
    await s.init()
    let wall = 1_800_000_000_000
    let mono = 50_000
    const now = vi.spyOn(Date, 'now').mockImplementation(() => wall)
    const perf = vi.spyOn(performance, 'now').mockImplementation(() => mono)
    try {
      emit('status', { agentId: 'a', status: 'working', errorText: null })
      const told = vi.fn()
      s.subscribe(told)
      wall += 5_000
      mono += 5_000
      s.followClock()
      expect(told).not.toHaveBeenCalled()
      wall -= 3 * DAY
      s.followClock()
      expect(told).toHaveBeenCalledTimes(1)
      expect(wall - s.getState().statusSince.a).toBe(5_000)
    } finally {
      now.mockRestore()
      perf.mockRestore()
    }
  })

  it('스냅샷에서 상태가 바뀐 에이전트는 statusSince 를 지운다(언제 바뀌었는지 모름)', async () => {
    let a: AgentView['status'] = 'idle'
    let b: AgentView['status'] = 'idle'
    const { api, emit } = fake({ snapshot: async () => snap({ agents: [agent('a', 'r1', { status: a }), agent('b', 'r1', { status: b })] }) })
    const s = createStore(api)
    await s.init()
    emit('status', { agentId: 'a', status: 'working', errorText: null })
    emit('status', { agentId: 'b', status: 'working', errorText: null })
    const bSince = s.getState().statusSince.b
    a = 'idle' // 엔진에선 a 가 이미 끝났다 — 이벤트 없이 스냅샷으로만 안다
    b = 'working' // b 는 이벤트대로
    await s.refresh()
    expect(s.getState().statusSince.a).toBeUndefined()
    expect(s.getState().statusSince.b).toBe(bSince)
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

  it('agent-added — 스냅샷을 다시 받아 새 에이전트를 담고, placeNear[새 id] = 만든 에이전트', async () => {
    let agents = [agent('a'), agent('b')]
    const { api, emit } = fake({ snapshot: async () => snap({ agents }) })
    const s = createStore(api)
    await s.init()
    expect(s.getState().placeNear).toEqual({})
    expect(api.snapshot).toHaveBeenCalledTimes(1)
    const n = agent('n')
    agents = [...agents, n]
    emit('agent-added', { agent: n, by: 'a' })
    expect(s.getState().placeNear).toEqual({ n: 'a' })
    await vi.waitFor(() => expect(s.getState().agents.map(x => x.id)).toEqual(['a', 'b', 'n']))
    expect(api.snapshot).toHaveBeenCalledTimes(2)
    // 다음 스냅샷이 와도 만든 쪽은 그대로 — 관계도가 자리를 정할 때까지
    await s.refresh()
    expect(s.getState().placeNear).toEqual({ n: 'a' })
  })

  it('agent-added 가 스냅샷을 기다리는 동안 왔는데 그 스냅샷에 이미 들어 있으면 다시 받지 않는다', async () => {
    let release!: (s: Snapshot) => void
    const { api, emit } = fake({ snapshot: () => new Promise<Snapshot>(r => { release = r }) })
    const s = createStore(api)
    const p = s.init()
    const n = agent('n')
    emit('agent-added', { agent: n, by: 'a' })
    release(snap({ agents: [agent('a'), n] }))
    await p
    expect(s.getState().placeNear).toEqual({ n: 'a' })
    expect(s.getState().agents.map(x => x.id)).toEqual(['a', 'n'])
    expect(api.snapshot).toHaveBeenCalledTimes(1)
  })

  it('agent-added 가 스냅샷을 기다리는 동안 왔는데 그 스냅샷에 아직 없으면 한 번 더 받는다', async () => {
    let calls = 0
    const n = agent('n')
    let release!: (s: Snapshot) => void
    const { api, emit } = fake({
      snapshot: () => (++calls === 1 ? new Promise<Snapshot>(r => { release = r }) : Promise.resolve(snap({ agents: [agent('a'), n] }))),
    })
    const s = createStore(api)
    const p = s.init()
    emit('agent-added', { agent: n, by: 'a' })
    release(snap({ agents: [agent('a')] }))
    await p
    await vi.waitFor(() => expect(s.getState().agents.map(x => x.id)).toEqual(['a', 'n']))
    expect(api.snapshot).toHaveBeenCalledTimes(2)
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

  it('고르기를 엔진에 알린다(미리 띄우기) — 에이전트·비움·방 바꾸기(null). 알리기가 실패해도 고르기는 그대로', async () => {
    const { api } = fake()
    const setSelected = vi.fn(async () => {})
    ;(api as any).setSelected = setSelected
    const s = createStore(api)
    await s.init()
    s.selectAgent('a')
    s.selectAgent(null)
    s.selectAgent('b')
    s.selectRoom('r2')
    expect(setSelected.mock.calls).toEqual([['a'], [null], ['b'], [null]])
    setSelected.mockRejectedValueOnce(new Error('끊김'))
    s.selectAgent('c')
    expect(s.getState().selectedAgentId).toBe('c')
    delete (api as any).setSelected // 알릴 길이 없어도(옛 preload) 고르기는 된다
    s.selectAgent('a')
    expect(s.getState().selectedAgentId).toBe('a')
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

  it('flags 사건이 그 에이전트의 bypass·bypassBySettings 를 바꾼다', async () => {
    const { api, emit } = fake()
    const s = createStore(api)
    await s.init()
    emit('flags', { agentId: 'a', bypass: true, bySettings: true, pending: false })
    expect(s.getState().agents.find(a => a.id === 'a')).toMatchObject({ bypass: true, bypassBySettings: true })
    expect(s.getState().agents.find(a => a.id === 'b')).toMatchObject({ bypass: false, bypassBySettings: false })
  })

  it('flags 사건의 pending 이 그 에이전트의 bypassPending — 다시 띄우기를 기다리는 동안 바뀌는 중', async () => {
    const { api, emit } = fake()
    const s = createStore(api)
    await s.init()
    emit('flags', { agentId: 'a', bypass: false, bySettings: false, pending: true })
    expect(s.getState().agents.find(a => a.id === 'a')).toMatchObject({ bypass: false, bypassPending: true })
    emit('flags', { agentId: 'a', bypass: true, bySettings: false, pending: false })
    expect(s.getState().agents.find(a => a.id === 'a')).toMatchObject({ bypass: true, bypassPending: false })
  })

  it('subscribe 는 변경을 알리고 해제할 수 있다', async () => {
    const { api, emit } = fake()
    const s = createStore(api)
    await s.init()
    const fn = vi.fn()
    const off = s.subscribe(fn)
    emit('flags', { agentId: 'a', bypass: true, bySettings: false, pending: false })
    expect(fn).toHaveBeenCalledTimes(1)
    off()
    emit('flags', { agentId: 'a', bypass: false, bySettings: false, pending: false })
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

describe('store 새 대화(boundary)', () => {
  const said = (text: string, t: number): HistoryItem => ({ t, kind: 'assistant', blocks: [{ type: 'text', text }] })
  const boundary = (t: number): HistoryItem => ({ t, kind: 'boundary' })
  const texts = (items: HistoryItem[] | undefined) => (items ?? []).map(i => (i.kind === 'notice' ? i.text : i.kind))

  it('boundary 가 오면 그 에이전트의 앞 기록을 버린다(다시 켠 뒤와 같은 화면) — 다른 에이전트는 그대로', async () => {
    const { api, emit } = fake({ history: async () => [note('옛', 1), said('옛 답', 2)] })
    const s = createStore(api)
    await s.init()
    s.selectAgent('b')
    await vi.waitFor(() => expect(s.getState().history.b).toHaveLength(2))
    s.selectAgent('a')
    await vi.waitFor(() => expect(s.getState().history.a).toHaveLength(2))
    expect(s.getState().lastText.a).toEqual({ text: '옛 답', at: 2 })

    emit('history', { agentId: 'a', item: boundary(3) })
    expect(s.getState().history.a).toEqual([])
    expect(s.getState().lastText.a).toBeUndefined()
    expect(s.getState().history.b).toHaveLength(2)

    emit('history', { agentId: 'a', item: note('새', 4) })
    expect(texts(s.getState().history.a)).toEqual(['새'])
  })

  it('기록을 불러오는 동안 boundary 가 오면 불러온 옛 기록도 버리고 그 뒤에 온 것만(앞에서 읽었든 뒤에서 읽었든)', async () => {
    for (const read of [[note('옛', 1), note('경계 앞', 2)], [note('경계 뒤', 4)]]) {
      let release!: (h: HistoryItem[]) => void
      const { api, emit } = fake({ history: () => new Promise<HistoryItem[]>(r => { release = r }) })
      const s = createStore(api)
      await s.init()
      s.selectAgent('a')
      emit('history', { agentId: 'a', item: note('경계 앞', 2) })
      emit('history', { agentId: 'a', item: boundary(3) })
      emit('history', { agentId: 'a', item: note('경계 뒤', 4) })
      release(read)
      await vi.waitFor(() => expect(s.getState().historyStatus.a).toEqual({ state: 'ready' }))
      expect(texts(s.getState().history.a)).toEqual(['경계 뒤'])
    }
  })

  it('스냅샷을 기다리는 동안 온 boundary 도 — 스냅샷 뒤에 적용되어 앞 기록을 버린다', async () => {
    const { api, emit } = fake({ history: async () => [note('옛', 1)] })
    const s = createStore(api)
    await s.init()
    s.selectAgent('a')
    await vi.waitFor(() => expect(s.getState().history.a).toHaveLength(1))
    let release!: (v: Snapshot) => void
    api.snapshot.mockImplementationOnce(() => new Promise<Snapshot>(r => { release = r }))
    const p = s.refresh()
    emit('history', { agentId: 'a', item: boundary(2) })
    emit('history', { agentId: 'a', item: note('새', 3) })
    expect(texts(s.getState().history.a)).toEqual(['옛']) // 아직 기다리는 중
    release(snap())
    await p
    expect(texts(s.getState().history.a)).toEqual(['새'])
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

describe('store 처음 불러오기 실패', () => {
  it('처음 스냅샷을 못 받으면 loadError 에 문구 — 다시 받으면 지우고, 받은 뒤의 실패는 loadError 가 아니다', async () => {
    const { api } = fake()
    api.snapshot.mockRejectedValueOnce(new Error('연결이 끊겼어요'))
    const s = createStore(api)
    const fn = vi.fn()
    s.subscribe(fn)
    await expect(s.init()).rejects.toThrow('연결이 끊겼어요')
    expect(s.getState().loadError).toBe('연결이 끊겼어요')
    expect(fn).toHaveBeenCalled() // 화면이 오류를 그리게 알린다

    api.snapshot.mockRejectedValueOnce(new Error('또 끊겼어요'))
    await expect(s.refresh()).rejects.toThrow('또 끊겼어요')
    expect(s.getState().loadError).toBe('또 끊겼어요')

    await s.refresh()
    expect(s.getState().loadError).toBeNull()
    expect(s.getState().rooms).toHaveLength(2)
    expect(s.getState().roomId).toBe('r1')

    api.snapshot.mockRejectedValueOnce(new Error('잠깐 끊김'))
    await expect(s.refresh()).rejects.toThrow('잠깐 끊김')
    expect(s.getState().loadError).toBeNull() // 이미 받은 화면은 그대로 둔다
    expect(s.getState().rooms).toHaveLength(2)
  })

  it('다시 받기에 성공하면 스냅샷과 같은 한 번의 갱신에서 loadError 를 지운다(낡은 오류와 새 상태가 함께 보이는 순간이 없다)', async () => {
    const { api } = fake()
    api.snapshot.mockRejectedValueOnce(new Error('No handler registered'))
    const s = createStore(api)
    await expect(s.init()).rejects.toThrow()
    const seen: { loadError: string | null; rooms: number }[] = []
    s.subscribe(() => seen.push({ loadError: s.getState().loadError, rooms: s.getState().rooms.length }))
    await s.refresh()
    expect(seen).toEqual([{ loadError: null, rooms: 2 }])
  })

  it('처음엔 loadError 가 없다', async () => {
    const { api } = fake()
    const s = createStore(api)
    expect(s.getState().loadError).toBeNull()
    await s.init()
    expect(s.getState().loadError).toBeNull()
  })
})

describe('usage · context · effort events', () => {
  const usage = { windows: [{ key: 'session' as const, label: '5시간', percent: 40, resetsAt: null }], at: 1 }
  const ctx = { total: 10, max: 100, percent: 10, autoCompactAt: null, at: 2 }

  it('snapshot 의 usage 가 상태에 들어간다', async () => {
    const { api } = fake({ snapshot: async () => snap({ usage }) })
    const store = createStore(api)
    await store.init()
    expect(store.getState().usage).toEqual(usage)
  })

  it('usage 사건이 바꾸고 null 도 받는다', async () => {
    const { api, emit } = fake()
    const store = createStore(api)
    await store.init()
    emit('usage', usage)
    expect(store.getState().usage).toEqual(usage)
    emit('usage', null)
    expect(store.getState().usage).toBeNull()
  })

  it('context 사건은 그 에이전트 lastContext 만 바꾼다', async () => {
    const { api, emit } = fake()
    const store = createStore(api)
    await store.init()
    emit('context', { agentId: 'a', value: ctx })
    const s = store.getState()
    expect(s.agents.find(a => a.id === 'a')!.lastContext).toEqual(ctx)
    expect(s.agents.find(a => a.id === 'b')!.lastContext).toBeNull()
    emit('context', { agentId: 'nobody', value: ctx })
    expect(store.getState().agents.map(a => a.lastContext)).toEqual([ctx, null, null])
  })

  it('effort 사건은 effort · effortNow 를 바꾼다', async () => {
    const { api, emit } = fake()
    const store = createStore(api)
    await store.init()
    emit('effort', { agentId: 'a', effort: 'max', effortNow: 'high' })
    const a = store.getState().agents.find(x => x.id === 'a')!
    expect([a.effort, a.effortNow]).toEqual(['max', 'high'])
    expect(store.getState().agents.find(x => x.id === 'b')!.effort).toBeNull()
    emit('effort', { agentId: 'nobody', effort: 'low', effortNow: null })
    expect(store.getState().agents).toHaveLength(3)
  })

  it('model-now 사건은 그 에이전트의 modelNow 만 바꾼다', async () => {
    const { api, emit } = fake()
    const store = createStore(api)
    await store.init()
    emit('model-now', { agentId: 'a', modelNow: 'claude-opus-5-5' })
    expect(store.getState().agents.find(x => x.id === 'a')!.modelNow).toBe('claude-opus-5-5')
    expect(store.getState().agents.find(x => x.id === 'b')!.modelNow).toBeNull()
    emit('model-now', { agentId: 'a', modelNow: null })
    expect(store.getState().agents.find(x => x.id === 'a')!.modelNow).toBeNull()
    emit('model-now', { agentId: 'nobody', modelNow: 'x' })
    expect(store.getState().agents).toHaveLength(3)
  })

  it('스냅샷을 기다리는 동안 온 셋도 버퍼를 거쳐 적용된다', async () => {
    let release!: (s: Snapshot) => void
    const { api, emit } = fake({ snapshot: () => new Promise<Snapshot>(r => { release = r }) })
    const store = createStore(api)
    const p = store.init()
    emit('usage', usage)
    emit('context', { agentId: 'a', value: ctx })
    emit('effort', { agentId: 'a', effort: 'low', effortNow: 'low' })
    release(snap())
    await p
    const s = store.getState()
    const a = s.agents.find(x => x.id === 'a')!
    expect(s.usage).toEqual(usage)
    expect(a.lastContext).toEqual(ctx)
    expect([a.effort, a.effortNow]).toEqual(['low', 'low'])
  })
})

describe('store 생각하는 중', () => {
  const think = (agentId: string, active: boolean, tokens: number | null = null) =>
    ({ agentId, event: { kind: 'thinking', active, tokens } }) as EngineEventMap['agent-event']
  const working = (agentId: string) => ({ agentId, status: 'working', errorText: null }) as EngineEventMap['status']
  async function thinkingStore() {
    const { api, emit } = fake()
    const s = createStore(api)
    await s.init()
    emit('status', working('a'))
    emit('agent-event', think('a', true))
    return { s, emit }
  }

  it('생각 시작이면 thinking[id] — 토큰 수가 오면 갱신, 생각 끝이면 지운다', async () => {
    const { s, emit } = await thinkingStore()
    expect(s.getState().thinking).toEqual({ a: { tokens: null } })
    emit('agent-event', think('a', true, 278))
    expect(s.getState().thinking.a).toEqual({ tokens: 278 })
    emit('agent-event', think('a', true, 452))
    expect(s.getState().thinking.a).toEqual({ tokens: 452 })
    emit('agent-event', think('a', false))
    expect(s.getState().thinking).toEqual({})
  })

  it('토큰 수 신호(thinking_tokens)는 생각 중일 때 수만 바꾼다 — 생각이 끝난 뒤 늦게 온 수가 "생각하는 중"을 다시 열지 않는다', async () => {
    const { s, emit } = await thinkingStore()
    emit('agent-event', think('a', false)) // 글 블록 시작 — 생각 끝
    emit('agent-event', think('a', true, 600)) // 늦게 온 수
    expect(s.getState().thinking.a).toBeUndefined()
    // 생각 블록 시작만 연다 — 그 뒤의 수는 그대로 갱신
    emit('agent-event', think('a', true))
    emit('agent-event', think('a', true, 700))
    expect(s.getState().thinking.a).toEqual({ tokens: 700 })
  })

  it('작업 중이어도 생각 블록 시작 없이 온 토큰 수는 생각을 만들지 않는다', async () => {
    const { s, emit } = await thinkingStore()
    emit('status', working('b'))
    emit('agent-event', think('b', true, 278))
    expect(s.getState().thinking.b).toBeUndefined()
  })

  it('이미 아는 토큰 수는 새 블록 시작(토큰 모름)으로 지우지 않는다', async () => {
    const { s, emit } = await thinkingStore()
    emit('agent-event', think('a', true, 278))
    emit('agent-event', think('a', true))
    expect(s.getState().thinking.a).toEqual({ tokens: 278 })
  })

  it('흐르는 글이 오면 생각 끝', async () => {
    const { s, emit } = await thinkingStore()
    emit('agent-event', { agentId: 'a', event: { kind: 'text-delta', text: '답' } })
    expect(s.getState().thinking.a).toBeUndefined()
    expect(s.getState().streaming.a).toBe('답')
  })

  it.each<[string, HistoryItem]>([
    ['assistant(글)', { t: 2, kind: 'assistant', blocks: [{ type: 'text', text: '답' }] }],
    ['assistant(하는 일)', { t: 2, kind: 'assistant', blocks: [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }] }],
    ['result', { t: 2, kind: 'result', ok: false, subtype: 'error_during_execution' }],
    ['notice(멈춤·오류)', note('멈췄어요', 2)],
    ['boundary(새 대화)', { t: 2, kind: 'boundary' }],
  ])('그 에이전트의 %s 기록이 오면 생각 끝 — 기록을 안 불러왔어도', async (_name, item) => {
    const { s, emit } = await thinkingStore()
    emit('history', { agentId: 'a', item })
    expect(s.getState().thinking.a).toBeUndefined()
  })

  it('서브에이전트의 줄(parent)·다른 에이전트의 기록은 생각을 지우지 않는다', async () => {
    const { s, emit } = await thinkingStore()
    emit('history', { agentId: 'a', item: { t: 2, kind: 'assistant', blocks: [{ type: 'text', text: '서브' }], parent: 'toolu_A' } })
    emit('history', { agentId: 'b', item: { t: 3, kind: 'result', ok: true, subtype: 'success' } })
    expect(s.getState().thinking.a).toEqual({ tokens: null })
  })

  it.each(['idle', 'stopped', 'error'] as const)('상태가 %s 가 되면(멈춤·끝·죽음) 생각 끝 — 승인 기다림은 그대로', async status => {
    const { s, emit } = await thinkingStore()
    emit('status', { agentId: 'a', status: 'awaiting', errorText: null })
    expect(s.getState().thinking.a).toEqual({ tokens: null })
    emit('status', { agentId: 'a', status, errorText: status === 'error' ? '죽음' : null })
    expect(s.getState().thinking.a).toBeUndefined()
  })

  it('일하지 않는 에이전트에게 늦게 온 생각 신호는 무시한다 — 다음 차례가 "생각하는 중"으로 시작하지 않게', async () => {
    const { s, emit } = await thinkingStore()
    emit('status', { agentId: 'a', status: 'idle', errorText: null })
    emit('agent-event', think('a', true, 600))
    expect(s.getState().thinking.a).toBeUndefined()
    emit('agent-event', think('b', true))
    expect(s.getState().thinking.b).toBeUndefined()
  })

  it('바뀌는 게 없으면 thinking 객체를 그대로 둔다(같은 토큰 수 · 생각 중 아닌 에이전트의 끝)', async () => {
    const { s, emit } = await thinkingStore()
    emit('agent-event', think('a', true, 278))
    const before = s.getState().thinking
    emit('agent-event', think('a', true, 278))
    emit('agent-event', think('b', false))
    emit('agent-event', { agentId: 'b', event: { kind: 'text-delta', text: '다른 답' } })
    emit('status', { agentId: 'b', status: 'idle', errorText: null })
    expect(s.getState().thinking).toBe(before)
  })
})

describe('store 단계(준비·답 기다림·대화 정리)', () => {
  const apiStatus = (agentId: string, status: 'requesting' | 'compacting' | null) =>
    ({ agentId, event: { kind: 'api-status', status } }) as EngineEventMap['agent-event']
  const working = (agentId: string) => ({ agentId, status: 'working', errorText: null }) as EngineEventMap['status']
  const sent: HistoryItem = { t: 1, kind: 'user', source: 'human', parts: [{ type: 'text', text: '해 줘' }] }
  async function phaseStore() {
    const { api, emit } = fake()
    const s = createStore(api)
    await s.init()
    return { s, emit }
  }

  it('보낸 줄(user 기록)이 오면 준비 — 상태 알림과 어느 쪽이 먼저 와도', async () => {
    const { s, emit } = await phaseStore()
    emit('history', { agentId: 'a', item: sent })
    expect(s.getState().phase).toEqual({ a: 'preparing' })
    emit('status', working('a'))
    expect(s.getState().phase.a).toBe('preparing')
  })

  it('받은 메시지를 보낸 줄(relay)도 준비', async () => {
    const { s, emit } = await phaseStore()
    emit('history', { agentId: 'a', item: { ...sent, source: 'relay', messageId: 'm1' } })
    expect(s.getState().phase.a).toBe('preparing')
  })

  it('요청 보냄 → 답 기다림 · 요약 중 → 대화 정리 · null → 단계 없음', async () => {
    const { s, emit } = await phaseStore()
    emit('history', { agentId: 'a', item: sent })
    emit('status', working('a'))
    emit('agent-event', apiStatus('a', 'requesting'))
    expect(s.getState().phase.a).toBe('requesting')
    emit('agent-event', apiStatus('a', 'compacting'))
    expect(s.getState().phase.a).toBe('compacting')
    emit('agent-event', apiStatus('a', null))
    expect(s.getState().phase.a).toBeUndefined()
  })

  it('init 은 준비를 끝내지 않는다 — 요청이 나가기 전까지는 준비(긴 준비가 init 뒤에 오기도 한다)', async () => {
    const { s, emit } = await phaseStore()
    emit('history', { agentId: 'a', item: sent })
    emit('status', working('a'))
    emit('agent-event', { agentId: 'a', event: { kind: 'init', sessionId: 'S', model: 'm', permissionMode: 'default', slashCommands: [] } })
    expect(s.getState().phase.a).toBe('preparing')
  })

  it.each<[string, EngineEventMap['agent-event']['event']]>([
    ['생각 블록 시작', { kind: 'thinking', active: true, tokens: null }],
    ['다른 블록 시작', { kind: 'thinking', active: false, tokens: null }],
    ['흐르는 글', { kind: 'text-delta', text: '답' }],
  ])('%s 이 오면 단계 끝(내용이 오기 시작했다)', async (_name, event) => {
    const { s, emit } = await phaseStore()
    emit('status', working('a'))
    emit('agent-event', apiStatus('a', 'requesting'))
    emit('agent-event', { agentId: 'a', event })
    expect(s.getState().phase.a).toBeUndefined()
  })

  it.each<[string, HistoryItem]>([
    ['assistant(하는 일)', { t: 2, kind: 'assistant', blocks: [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }] }],
    ['result', { t: 2, kind: 'result', ok: true, subtype: 'success' }],
    ['notice(멈춤·오류)', note('멈췄어요', 2)],
    ['boundary(새 대화)', { t: 2, kind: 'boundary' }],
  ])('그 에이전트의 %s 기록이 오면 단계 끝', async (_name, item) => {
    const { s, emit } = await phaseStore()
    emit('history', { agentId: 'a', item: sent })
    emit('history', { agentId: 'a', item })
    expect(s.getState().phase.a).toBeUndefined()
  })

  it('서브에이전트의 줄(parent)은 단계를 바꾸지 않는다', async () => {
    const { s, emit } = await phaseStore()
    emit('status', working('a'))
    emit('agent-event', apiStatus('a', 'requesting'))
    emit('history', { agentId: 'a', item: { t: 2, kind: 'assistant', blocks: [{ type: 'text', text: '서브' }], parent: 'toolu_A' } })
    expect(s.getState().phase.a).toBe('requesting')
  })

  it.each(['idle', 'stopped', 'error'] as const)('상태가 %s 가 되면 단계 끝 — 승인 기다림은 그대로', async status => {
    const { s, emit } = await phaseStore()
    emit('history', { agentId: 'a', item: sent })
    emit('status', { agentId: 'a', status: 'awaiting', errorText: null })
    expect(s.getState().phase.a).toBe('preparing')
    emit('status', { agentId: 'a', status, errorText: status === 'error' ? '죽음' : null })
    expect(s.getState().phase.a).toBeUndefined()
  })

  it('API 상태 null 은 준비를 지우지 않는다 — 요청·요약이 끝났다는 뜻일 뿐(다음 줄의 준비가 늦은 끝에 지워지지 않게)', async () => {
    const { s, emit } = await phaseStore()
    emit('history', { agentId: 'a', item: sent })
    emit('status', working('a'))
    emit('agent-event', apiStatus('a', null))
    expect(s.getState().phase.a).toBe('preparing')
  })

  it('쉬다가 일하기 시작했는데 기다리는 입력이 있으면 준비 — 띄울 때의 /effort 뒤에서 기다리는 첫 입력', async () => {
    const { s, emit } = await phaseStore()
    emit('held-input', { agentId: 'a', count: 1 })
    emit('status', working('a'))
    expect(s.getState().phase.a).toBe('preparing')
  })

  it('승인 기다림에서 일로 돌아올 땐 기다리는 입력이 있어도 준비가 아니다 — 차례가 이어지는 중', async () => {
    const { s, emit } = await phaseStore()
    emit('status', { agentId: 'a', status: 'awaiting', errorText: null })
    emit('held-input', { agentId: 'a', count: 1 })
    emit('status', working('a'))
    expect(s.getState().phase.a).toBeUndefined()
  })

  it('일하지 않는 에이전트에게 온 API 상태는 무시한다', async () => {
    const { s, emit } = await phaseStore()
    emit('agent-event', apiStatus('a', 'requesting'))
    expect(s.getState().phase.a).toBeUndefined()
  })

  it('바뀌는 게 없으면 phase 객체를 그대로 둔다', async () => {
    const { s, emit } = await phaseStore()
    emit('status', working('a'))
    emit('agent-event', apiStatus('a', 'requesting'))
    const before = s.getState().phase
    emit('agent-event', apiStatus('a', 'requesting'))
    emit('agent-event', { agentId: 'b', event: { kind: 'text-delta', text: '다른 답' } })
    emit('status', { agentId: 'b', status: 'idle', errorText: null })
    expect(s.getState().phase).toBe(before)
  })
})

describe('store 서브에이전트', () => {
  const said = (text: string, t: number, parent?: string): HistoryItem => ({
    t, kind: 'assistant', blocks: [{ type: 'text', text }], ...(parent ? { parent } : {}),
  })

  it('subagents 사건은 그 에이전트의 subagentsRunning 만 바꾼다', async () => {
    const { api, emit } = fake()
    const s = createStore(api)
    await s.init()
    emit('subagents', { agentId: 'a', running: ['toolu_A', 'toolu_B'] })
    expect(s.getState().agents.find(x => x.id === 'a')!.subagentsRunning).toEqual(['toolu_A', 'toolu_B'])
    expect(s.getState().agents.find(x => x.id === 'b')!.subagentsRunning).toEqual([])
    emit('subagents', { agentId: 'a', running: [] })
    expect(s.getState().agents.find(x => x.id === 'a')!.subagentsRunning).toEqual([])
  })

  it('스냅샷을 기다리는 동안 온 subagents 사건도 스냅샷 뒤에 적용된다', async () => {
    let release!: (s: Snapshot) => void
    const { api, emit } = fake({ snapshot: () => new Promise<Snapshot>(r => { release = r }) })
    const s = createStore(api)
    const p = s.init()
    emit('subagents', { agentId: 'a', running: ['toolu_A'] })
    release(snap())
    await p
    expect(s.getState().agents.find(x => x.id === 'a')!.subagentsRunning).toEqual(['toolu_A'])
  })

  it('부모 차례가 끝난 뒤 온 서브에이전트의 글(parent)은 lastText 를 바꾸지 않는다', async () => {
    const { api, emit } = fake()
    const s = createStore(api)
    await s.init()
    emit('history', { agentId: 'b', item: said('셋에게 나눠 맡겼어요', 5) })
    emit('history', { agentId: 'b', item: { t: 6, kind: 'result', ok: true, subtype: 'success' } })
    emit('history', { agentId: 'b', item: said('b.html 을 읽어 볼게요', 7, 'toolu_A') })
    expect(s.getState().lastText.b).toEqual({ text: '셋에게 나눠 맡겼어요', at: 5 })
  })

  it('기록을 불러올 때도 서브에이전트의 글은 lastText 로 채우지 않는다', async () => {
    const { api } = fake({ history: async () => [said('부모 답', 1), said('서브에이전트 글', 3, 'toolu_A')] })
    const s = createStore(api)
    await s.init()
    s.selectAgent('a')
    await vi.waitFor(() => expect(s.getState().history.a).toBeDefined())
    expect(s.getState().lastText.a).toEqual({ text: '부모 답', at: 1 })
  })

  it('서브에이전트 기록(줄·시작·끝)은 부모의 흐르는 글을 비우지 않는다 — 부모 답이 기록되면 비운다', async () => {
    const { api, emit } = fake()
    const s = createStore(api)
    await s.init()
    emit('agent-event', { agentId: 'b', event: { kind: 'text-delta', text: '정리하는 ' } })
    emit('history', { agentId: 'b', item: said('중간 글', 2, 'toolu_A') })
    emit('history', { agentId: 'b', item: { t: 3, kind: 'tool-result', toolUseId: 'r1', isError: false, text: 'x', viaApproval: false, parent: 'toolu_A' } })
    emit('history', { agentId: 'b', item: { t: 4, kind: 'subagent-end', toolUseId: 'toolu_A', taskId: 't1', status: 'completed', summary: '보고', toolUses: 1, durationMs: 10 } })
    emit('agent-event', { agentId: 'b', event: { kind: 'text-delta', text: '중이에요' } })
    expect(s.getState().streaming.b).toBe('정리하는 중이에요')
    emit('history', { agentId: 'b', item: said('정리하는 중이에요', 5) })
    expect(s.getState().streaming.b).toBe('')
  })

  it('패널 탭은 에이전트마다 — 처음엔 없고(대화), setPanelTab 으로 바꾼다', async () => {
    const { api } = fake()
    const s = createStore(api)
    await s.init()
    expect(s.getState().panelTab).toEqual({})
    s.setPanelTab('a', 'subagents')
    expect(s.getState().panelTab).toEqual({ a: 'subagents' })
    s.setPanelTab('b', 'chat')
    expect(s.getState().panelTab).toEqual({ a: 'subagents', b: 'chat' })
  })

  it('showSubagents 는 그 에이전트를 서브에이전트 탭으로 바꾸고 focus 의 n 을 올린다', async () => {
    const { api } = fake()
    const s = createStore(api)
    await s.init()
    expect(s.getState().subagentFocus).toBeNull()
    s.showSubagents('a', 'toolu_A')
    expect(s.getState().panelTab.a).toBe('subagents')
    expect(s.getState().subagentFocus).toEqual({ agentId: 'a', key: 'toolu_A', n: 1 })
    s.setPanelTab('a', 'chat')
    s.showSubagents('a', 'toolu_A')
    expect(s.getState().panelTab.a).toBe('subagents')
    expect(s.getState().subagentFocus).toEqual({ agentId: 'a', key: 'toolu_A', n: 2 })
    s.showSubagents('b', 'toolu_X')
    expect(s.getState().subagentFocus).toEqual({ agentId: 'b', key: 'toolu_X', n: 3 })
  })

  it('관계도 선 보기 — 처음엔 최근, 바꾸면 이 PC 에 기억해 다음 스토어도 그 값으로 시작한다(모르는 값이면 최근)', async () => {
    localStorage.removeItem('dure.edges')
    const s = createStore(fake().api)
    expect(s.getState().edgeMode).toBe('recent')
    s.setEdgeMode('off')
    expect(s.getState().edgeMode).toBe('off')
    expect(createStore(fake().api).getState().edgeMode).toBe('off')
    localStorage.setItem('dure.edges', '이상한 값')
    expect(createStore(fake().api).getState().edgeMode).toBe('recent')
    localStorage.removeItem('dure.edges')
  })

  it('showMessage 는 그 에이전트를 골라 대화 탭으로 바꾸고 messageFocus 를 둔다 — 대화 목록이 간 뒤 doneMessageFocus 로 지운다', async () => {
    const { api } = fake()
    const s = createStore(api)
    await s.init()
    s.selectAgent('a')
    s.setPanelTab('a', 'messages')
    s.showMessage('a', 'm1')
    expect(s.getState().selectedAgentId).toBe('a')
    expect(s.getState().panelTab.a).toBe('chat')
    expect(s.getState().messageFocus).toEqual({ agentId: 'a', messageId: 'm1', n: 1 })
    s.showMessage('b', 'm2') // 보낸 메시지 — 받은 에이전트의 대화로
    expect(s.getState().selectedAgentId).toBe('b')
    expect(s.getState().messageFocus).toEqual({ agentId: 'b', messageId: 'm2', n: 2 })
    s.doneMessageFocus(1) // 지난 것 — 그 사이 새로 누른 것은 남긴다
    expect(s.getState().messageFocus?.n).toBe(2)
    s.doneMessageFocus(2)
    expect(s.getState().messageFocus).toBeNull()
    s.showMessage('없는 에이전트', 'm3')
    expect(s.getState().selectedAgentId).toBe('b')
  })
})

describe('store 끝남 · 새 결과', () => {
  const result = (t: number): HistoryItem => ({ t, kind: 'result', ok: true, subtype: 'success', text: '끝', denials: [] } as HistoryItem)
  const send = (emit: ReturnType<typeof fake>['emit'], agentId: string, item: HistoryItem) => emit('history', { agentId, item })

  it('고르지 않은 에이전트의 result → fresh[id] = t', async () => {
    const { api, emit } = fake()
    const s = createStore(api, { hasFocus: () => true })
    await s.init()
    send(emit, 'a', result(42))
    expect(s.getState().fresh).toEqual({ a: 42 })
  })

  it('고른 에이전트라도 창에 초점이 없으면 fresh', async () => {
    const { api, emit } = fake()
    const s = createStore(api, { hasFocus: () => false })
    await s.init()
    s.selectAgent('a')
    send(emit, 'a', result(7))
    expect(s.getState().fresh).toEqual({ a: 7 })
  })

  it('초점 없을 때 쌓인 고른 에이전트의 fresh 는 창이 초점을 되찾으면 지워진다(다른 에이전트 것은 그대로)', async () => {
    const { api, emit } = fake()
    const s = createStore(api, { hasFocus: () => false })
    await s.init()
    s.selectAgent('a')
    send(emit, 'a', result(7))
    send(emit, 'b', result(8))
    expect(s.getState().fresh).toEqual({ a: 7, b: 8 })
    window.dispatchEvent(new Event('focus'))
    expect(s.getState().fresh).toEqual({ b: 8 })
  })

  it('고른 에이전트 + 초점 있음 → fresh 없음', async () => {
    const { api, emit } = fake()
    const s = createStore(api, { hasFocus: () => true })
    await s.init()
    s.selectAgent('a')
    send(emit, 'a', result(7))
    expect(s.getState().fresh).toEqual({})
  })

  it('selectAgent(id)·working 상태·boundary 에서 지운다 — awaiting 도', async () => {
    const { api, emit } = fake()
    const s = createStore(api, { hasFocus: () => true })
    await s.init()
    for (const id of ['a', 'b', 'c']) send(emit, id, result(1))
    expect(Object.keys(s.getState().fresh).sort()).toEqual(['a', 'b', 'c'])
    s.selectAgent('a')
    expect(s.getState().fresh.a).toBeUndefined()
    emit('status', { agentId: 'b', status: 'working', errorText: null })
    expect(s.getState().fresh.b).toBeUndefined()
    send(emit, 'b', result(2))
    emit('status', { agentId: 'b', status: 'awaiting', errorText: null })
    expect(s.getState().fresh.b).toBeUndefined()
    send(emit, 'c', { t: 3, kind: 'boundary' })
    expect(s.getState().fresh).toEqual({})
  })

  it('selectAgent(null) 은 지우지 않는다', async () => {
    const { api, emit } = fake()
    const s = createStore(api, { hasFocus: () => true })
    await s.init()
    send(emit, 'a', result(1))
    s.selectAgent(null)
    expect(s.getState().fresh).toEqual({ a: 1 })
  })

  it('바뀌는 게 없으면 fresh 객체 그대로', async () => {
    const { api, emit } = fake()
    const s = createStore(api, { hasFocus: () => true })
    await s.init()
    const before = s.getState().fresh
    emit('status', { agentId: 'a', status: 'working', errorText: null })
    send(emit, 'a', { t: 1, kind: 'boundary' })
    s.selectAgent('a')
    send(emit, 'a', result(1)) // 고른 + 초점 있음
    expect(s.getState().fresh).toBe(before)
  })

  describe('focusAgent', () => {
    it('다른 방의 에이전트면 roomId 를 바꾸고 고른다 — history 를 부른다', async () => {
      const { api } = fake()
      const s = createStore(api)
      await s.init()
      s.focusAgent('c')
      expect(s.getState().roomId).toBe('r2')
      expect(s.getState().selectedAgentId).toBe('c')
      expect(api.history).toHaveBeenCalledWith('c')
    })

    it('같은 방이면 방은 그대로 고르기만', async () => {
      const { api } = fake()
      const s = createStore(api)
      await s.init()
      s.focusAgent('b')
      expect(s.getState().roomId).toBe('r1')
      expect(s.getState().selectedAgentId).toBe('b')
    })

    it('모르는 id 면 그대로', async () => {
      const { api } = fake()
      const s = createStore(api)
      await s.init()
      const before = s.getState()
      s.focusAgent('nope')
      expect(s.getState()).toBe(before)
    })

    it('관계도에 그 카드를 보이게 해 달라고 한다 — 누를 때마다 n 이 오른다', async () => {
      const { api } = fake()
      const s = createStore(api)
      await s.init()
      expect(s.getState().mapFocus).toBeNull()
      s.focusAgent('b')
      expect(s.getState().mapFocus).toEqual({ agentId: 'b', n: 1 })
      s.focusAgent('b')
      expect(s.getState().mapFocus).toEqual({ agentId: 'b', n: 2 })
    })
  })

  it('requestRoomMenu 가 roomMenuRequest 를 하나씩 올린다', async () => {
    const { api } = fake()
    const s = createStore(api)
    await s.init()
    expect(s.getState().roomMenuRequest).toBe(0)
    s.requestRoomMenu()
    s.requestRoomMenu()
    expect(s.getState().roomMenuRequest).toBe(2)
  })
})

describe('store 지난 대화 — resumed 경계·갈래 초안', () => {
  const said = (text: string, t: number): HistoryItem => ({ t, kind: 'assistant', blocks: [{ type: 'text', text }] })

  it('resumed 경계 — 비우지 않고 다시 불러온다', async () => {
    let calls = 0
    const { api, emit } = fake({ history: async () => (++calls === 1 ? [note('옛', 1)] : [said('앞 구간', 1), note('이 대화로 돌아왔어요', 5)]) })
    const s = createStore(api)
    await s.init()
    s.selectAgent('a')
    await vi.waitFor(() => expect(s.getState().history.a).toHaveLength(1))
    const snaps = api.snapshot.mock.calls.length

    emit('history', { agentId: 'a', item: { t: 5, kind: 'boundary', ended: 'S2', resumed: 'S1' } })
    await vi.waitFor(() => expect(s.getState().history.a).toHaveLength(2))
    expect(api.history).toHaveBeenCalledTimes(2)
    expect(s.getState().history.a![0].kind).toBe('assistant')
    await vi.waitFor(() => expect(api.snapshot.mock.calls.length).toBeGreaterThan(snaps))
  })

  it('resumed 없는 경계는 지금처럼 빈 목록 — 스냅샷은 다시 받는다', async () => {
    const { api, emit } = fake({ history: async () => [note('옛', 1)] })
    const s = createStore(api)
    await s.init()
    s.selectAgent('a')
    await vi.waitFor(() => expect(s.getState().history.a).toHaveLength(1))
    const snaps = api.snapshot.mock.calls.length
    emit('history', { agentId: 'a', item: { t: 5, kind: 'boundary', ended: 'S2' } })
    expect(s.getState().history.a).toEqual([])
    expect(api.history).toHaveBeenCalledTimes(1)
    await vi.waitFor(() => expect(api.snapshot.mock.calls.length).toBeGreaterThan(snaps))
  })

  it('openFork·closeFork', async () => {
    const { api } = fake()
    const s = createStore(api)
    await s.init()
    expect(s.getState().forkDraft).toBeNull()
    const d = { from: 'a', key: 'k', roomId: 'r1', name: '복사', role: '역할', folder: '/x' }
    s.openFork(d)
    expect(s.getState().forkDraft).toEqual(d)
    s.closeFork()
    expect(s.getState().forkDraft).toBeNull()
    s.setPanelTab('a', 'past')
    expect(s.getState().panelTab.a).toBe('past')
  })

  const pc = (n: number) => snap({ agents: [agent('a', 'r1', { pastCount: n }), agent('b'), agent('c', 'r2')] })

  it('경계는 pastCount 만 합치고 사건을 붙잡지 않는다 — 다시 불러온 목록에 든 줄은 한 번만', async () => {
    let calls = 0
    const dup = note('돌아왔어요', 5)
    const { api, emit } = fake({
      snapshot: async () => pc(3),
      history: async () => (++calls === 1 ? [note('옛', 1)] : [said('앞', 1), dup]),
    })
    const s = createStore(api)
    await s.init()
    s.selectAgent('a')
    await vi.waitFor(() => expect(s.getState().history.a).toHaveLength(1))
    emit('history', { agentId: 'a', item: { t: 5, kind: 'boundary', ended: 'S2', resumed: 'S1' } })
    emit('history', { agentId: 'a', item: dup })
    await vi.waitFor(() => expect(s.getState().history.a).toHaveLength(2))
    await new Promise(r => setTimeout(r, 20))
    expect(s.getState().history.a!.filter(i => i.kind === 'notice')).toHaveLength(1)
    expect(s.getState().agents.find(x => x.id === 'a')!.pastCount).toBe(3)
  })

  it('불러오는 중 경계가 와도 pastCount 를 갱신한다', async () => {
    let release!: (v: HistoryItem[]) => void
    const { api, emit } = fake({ snapshot: async () => pc(2), history: () => new Promise<HistoryItem[]>(r => { release = r }) })
    const s = createStore(api)
    await s.init()
    s.selectAgent('a')
    emit('history', { agentId: 'a', item: { t: 5, kind: 'boundary', ended: 'S2' } })
    await vi.waitFor(() => expect(s.getState().agents.find(x => x.id === 'a')!.pastCount).toBe(2))
    release([])
  })

  it('불러오는 중 resumed 경계가 오면 끝난 뒤 다시 불러온다', async () => {
    const rel: ((v: HistoryItem[]) => void)[] = []
    const { api, emit } = fake({ history: () => new Promise<HistoryItem[]>(r => { rel.push(r) }) })
    const s = createStore(api)
    await s.init()
    s.selectAgent('a')
    emit('history', { agentId: 'a', item: { t: 5, kind: 'boundary', ended: 'S2', resumed: 'S1' } })
    rel[0]([note('옛', 1)])
    await vi.waitFor(() => expect(api.history).toHaveBeenCalledTimes(2))
    rel[1]([said('앞 구간', 1), note('돌아왔어요', 5)])
    await vi.waitFor(() => expect(s.getState().history.a).toHaveLength(2))
    expect(s.getState().history.a![0].kind).toBe('assistant')
  })
})


describe('store 앱 상태', () => {
  it('처음 값은 확인 중·대기 · init 뒤 api 값', async () => {
    const { api } = fake({ setupState: async () => ({ phase: 'needs', install: { state: 'todo' }, login: { state: 'locked' } }) })
    const s = createStore(api)
    expect(s.getState().app).toEqual({ info: null, prefs: null, setup: { phase: 'checking' }, setupLoadFailed: false, update: { kind: 'idle' }, claudeUpdate: 'idle', toastHidden: false })
    await s.init()
    expect(s.getState().app.setup.phase).toBe('needs')
    expect(s.getState().app.info).toEqual({ version: '1.0.0', packaged: true })
    expect(s.getState().app.prefs).toEqual(DEFAULT_APP_PREFS)
  })

  it("'setup' 사건이 갈음한다", async () => {
    const { api, emit } = fake()
    const s = createStore(api)
    await s.init()
    emit('setup', { phase: 'relaunching' })
    expect(s.getState().app.setup).toEqual({ phase: 'relaunching' })
    emit('claude-update', 'running')
    expect(s.getState().app.claudeUpdate).toBe('running')
  })

  it('init 응답보다 먼저 온 update 사건이 이긴다', async () => {
    let resolve!: (u: UpdateState) => void
    const { api, emit } = fake({ updateState: () => new Promise<UpdateState>(r => { resolve = r }) })
    const s = createStore(api)
    const p = s.init()
    await Promise.resolve()
    emit('update', { kind: 'ready', version: '2.0.0' })
    resolve({ kind: 'checking' })
    await p
    expect(s.getState().app.update).toEqual({ kind: 'ready', version: '2.0.0' })
  })

  it('앱 호출이 거절돼도 init 은 성공하고 기본값이 남는다', async () => {
    const { api } = fake({ appInfo: async () => { throw new Error('x') }, setupState: async () => { throw new Error('y') } })
    const s = createStore(api)
    await s.init()
    expect(s.getState().app.info).toBeNull()
    expect(s.getState().app.setup).toEqual({ phase: 'checking' })
    expect(s.getState().agents).toHaveLength(3)
  })

  it('setupState 가 끝내 안 와도 init 은 스냅샷만으로 끝난다', async () => {
    const { api } = fake({ setupState: () => new Promise<SetupState>(() => {}) })
    const s = createStore(api)
    await s.init()
    expect(s.getState().app.setup).toEqual({ phase: 'checking' })
    expect(s.getState().agents).toHaveLength(3)
  })

  it('init 뒤에 온 setupState 응답도 칸을 채운다 · 사건이 먼저면 사건이 이긴다', async () => {
    let resolve!: (v: SetupState) => void
    const a = fake({ setupState: () => new Promise<SetupState>(r => { resolve = r }) })
    const s = createStore(a.api)
    await s.init()
    resolve({ phase: 'ready' })
    await Promise.resolve(); await Promise.resolve()
    expect(s.getState().app.setup).toEqual({ phase: 'ready' })

    let resolve2!: (v: SetupState) => void
    const b = fake({ setupState: () => new Promise<SetupState>(r => { resolve2 = r }) })
    const s2 = createStore(b.api)
    await s2.init()
    b.emit('setup', { phase: 'relaunching' })
    resolve2({ phase: 'ready' })
    await Promise.resolve(); await Promise.resolve()
    expect(s2.getState().app.setup).toEqual({ phase: 'relaunching' })
  })

  it('setPrefs 는 api 가 돌려준 값으로 prefs 를 갈음한다', async () => {
    const { api } = fake()
    const s = createStore(api)
    await s.init()
    await s.setPrefs({ tourDone: true })
    expect(s.getState().app.prefs?.tourDone).toBe(true)
    expect(s.getState().app.prefs?.claudeAutoUpdate).toBe(true)
  })

  it('hideUpdateToast 는 toastHidden 만 켠다', async () => {
    const { api } = fake()
    const s = createStore(api)
    await s.init()
    s.hideUpdateToast()
    expect(s.getState().app.toastHidden).toBe(true)
  })

  it('setupState 가 거절되면 setupLoadFailed, 사건이 오면 풀린다', async () => {
    const { api, emit } = fake({ setupState: async () => { throw new Error('x') } })
    const s = createStore(api)
    await s.init()
    expect(s.getState().app.setupLoadFailed).toBe(true)
    expect(s.getState().app.setup).toEqual({ phase: 'checking' })
    emit('setup', { phase: 'ready' })
    expect(s.getState().app.setupLoadFailed).toBe(false)
    expect(s.getState().app.setup).toEqual({ phase: 'ready' })
  })
})

describe('store 투어', () => {
  /** 앱 상태 응답(기다리지 않는 loadApp)까지 다 받는다 */
  const settle = () => new Promise(r => setTimeout(r, 0))
  const noRooms = () => snap({ rooms: [], agents: [] })
  const WELCOME = { step: 'welcome', replay: false, base: { rooms: 0, agents: 0, sent: 0 } }

  it('처음엔 투어가 없다', () => {
    const { api } = fake()
    expect(createStore(api).getState().tour).toBeNull()
  })

  it('조건이 맞으면 저절로 welcome — 설정을 받았고 · 투어를 안 끝냈고 · 준비됐고 · 방이 0', async () => {
    const { api } = fake({ snapshot: async () => noRooms() })
    const s = createStore(api)
    await s.init()
    await settle()
    expect(s.getState().tour).toEqual(WELCOME)
  })

  it('조건이 늦게 맞아도(준비가 끝남) 그때 welcome', async () => {
    const { api, emit } = fake({ snapshot: async () => noRooms(), setupState: async () => ({ phase: 'needs', install: { state: 'done', version: '2' }, login: { state: 'todo' } }) })
    const s = createStore(api)
    await s.init()
    await settle()
    expect(s.getState().tour).toBeNull()
    emit('setup', { phase: 'ready' })
    expect(s.getState().tour).toEqual(WELCOME)
  })

  it('tourDone 이면 안 시작', async () => {
    const { api } = fake({ snapshot: async () => noRooms(), prefs: async () => ({ ...DEFAULT_APP_PREFS, tourDone: true }) })
    const s = createStore(api)
    await s.init()
    await settle()
    expect(s.getState().tour).toBeNull()
  })

  it('방이 있거나 · 설정을 못 받았거나 · 준비가 안 됐거나 · claude 가 없으면 안 시작', async () => {
    const cases = [
      fake(), // 방 둘
      fake({ snapshot: async () => noRooms(), prefs: async () => { throw new Error('x') } }),
      fake({ snapshot: async () => noRooms(), setupState: async () => ({ phase: 'needs', install: { state: 'todo' }, login: { state: 'locked' } }) }),
      fake({ snapshot: async () => noRooms(), setupState: () => new Promise<SetupState>(() => {}) }), // 확인 중
      fake({ snapshot: async () => ({ ...noRooms(), claudeMissing: true }) }), // 준비됐다는데 claude 가 없다 → 준비 화면
    ]
    for (const { api } of cases) {
      const s = createStore(api)
      await s.init()
      await settle()
      expect(s.getState().tour).toBeNull()
    }
  })

  it('처음 스냅샷을 받기 전엔 방 수를 모른다 — 안 시작', async () => {
    let resolve!: (v: Snapshot) => void
    const { api } = fake({ snapshot: () => new Promise<Snapshot>(r => { resolve = r }) })
    const s = createStore(api)
    const p = s.init()
    await settle() // 설정·준비는 받았다
    expect(s.getState().app.prefs).not.toBeNull()
    expect(s.getState().tour).toBeNull()
    resolve(snap()) // 방이 있었다
    await p
    expect(s.getState().tour).toBeNull()
  })

  it('endTour 가 tourDone 저장 — 투어를 닫고, 조건이 그대로여도 이번 실행엔 다시 안 뜬다', async () => {
    const { api, emit } = fake({ snapshot: async () => noRooms() })
    const s = createStore(api)
    await s.init()
    await settle()
    expect(s.getState().tour).not.toBeNull()
    await s.endTour()
    expect(s.getState().tour).toBeNull()
    expect(api.setPrefs).toHaveBeenCalledWith({ tourDone: true })
    expect(s.getState().app.prefs?.tourDone).toBe(true)
    emit('setup', { phase: 'ready' })
    expect(s.getState().tour).toBeNull()
  })

  it('endTour — 저장이 실패해도 던지지 않고, 이번 실행엔 다시 안 뜬다', async () => {
    const { api, emit } = fake({ snapshot: async () => noRooms(), setPrefs: async () => { throw new Error('잠김') } })
    const s = createStore(api)
    await s.init()
    await settle()
    await expect(s.endTour()).resolves.toBeUndefined()
    expect(s.getState().tour).toBeNull()
    expect(s.getState().app.prefs?.tourDone).toBe(false)
    emit('setup', { phase: 'ready' })
    expect(s.getState().tour).toBeNull()
  })

  it('startTour(replay) — 환영부터, 방이 없으면 다시 보기가 아니다', async () => {
    const a = fake()
    const s = createStore(a.api)
    await s.init()
    s.startTour(true)
    expect(s.getState().tour).toEqual({ step: 'welcome', replay: true, base: { rooms: 2, agents: 2, sent: 0 } })
    expect(a.api.setPrefs).not.toHaveBeenCalled()

    const b = fake({ snapshot: async () => noRooms(), prefs: async () => ({ ...DEFAULT_APP_PREFS, tourDone: true }) })
    const s2 = createStore(b.api)
    await s2.init()
    s2.startTour(true)
    expect(s2.getState().tour).toEqual(WELCOME)
  })

  it('tourNext — 다음 단계로 base 를 새로 잰다 · 고른 에이전트가 없으면 카드 단계를 건너뛴다 · 끝 다음은 endTour', async () => {
    const { api } = fake()
    const s = createStore(api)
    await s.init()
    s.tourNext() // 투어가 없으면 아무것도 안 한다
    expect(s.getState().tour).toBeNull()
    s.startTour(true)
    s.tourNext()
    expect(s.getState().tour).toEqual({ step: 'room', replay: true, base: { rooms: 2, agents: 2, sent: 0 } })
    s.tourNext()
    expect(s.getState().tour?.step).toBe('agent')
    s.tourNext() // 고른 에이전트 없음
    expect(s.getState().tour?.step).toBe('todo')
    s.setTour({ step: 'agent', replay: true, base: { rooms: 2, agents: 2, sent: 0 } })
    s.selectAgent('a')
    s.tourNext()
    expect(s.getState().tour?.step).toBe('card')
    s.setTour({ step: 'done', replay: true, base: { rooms: 2, agents: 2, sent: 0 } })
    s.tourNext()
    expect(s.getState().tour).toBeNull()
    await settle()
    expect(api.setPrefs).toHaveBeenCalledWith({ tourDone: true })
  })

  it('tourNext — 설정 안 단계에선 아무것도 안 한다(설정 창을 닫아야 끝으로)', async () => {
    const { api } = fake()
    const s = createStore(api)
    await s.init()
    const settings = { step: 'settings', replay: false, base: { rooms: 2, agents: 2, sent: 0 } } as const
    s.setTour(settings)
    const before = s.getState()
    s.tourNext()
    expect(s.getState()).toBe(before)
    expect(s.getState().tour).toEqual(settings)
  })

  it('setTour — 같은 값이면 알리지 않는다', async () => {
    const { api } = fake()
    const s = createStore(api)
    await s.init()
    const fn = vi.fn()
    s.subscribe(fn)
    s.setTour({ step: 'todo', replay: false, base: { rooms: 2, agents: 2, sent: 0 } })
    expect(fn).toHaveBeenCalledTimes(1)
    s.setTour({ step: 'todo', replay: false, base: { rooms: 2, agents: 2, sent: 0 } })
    expect(fn).toHaveBeenCalledTimes(1)
    s.setTour({ step: 'todo', replay: false, base: { rooms: 2, agents: 2, sent: 1 } })
    expect(fn).toHaveBeenCalledTimes(2)
    s.setTour(null)
    s.setTour(null)
    expect(fn).toHaveBeenCalledTimes(3)
    expect(s.getState().tour).toBeNull()
  })
})
