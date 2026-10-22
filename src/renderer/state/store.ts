import { useRef, useSyncExternalStore } from 'react'
import type { AgentId, AgentStatus, EngineEventMap, HistoryItem, RoomId } from '../../engine/types'
import type { DureApi, Snapshot } from '../../shared/ipcContract'
import { displayStatus } from './selectors'

export type UiState = Snapshot & {
  roomId: RoomId | null
  selectedAgentId: AgentId | null
  history: Record<AgentId, HistoryItem[]>
  historyStatus: Record<AgentId, { state: 'loading' | 'ready' | 'error'; error?: string }>
  streaming: Record<AgentId, string>
  /**
   * Claude 가 생각하는 중인 에이전트 — tokens = 지금까지 생각한 추정 토큰 수(모르면 null). 없으면 생각 중이 아니다.
   * 생각 끝 신호 · 흐르는 글 · 그 에이전트의 답·끝·알림·새 대화 기록 · 작업 중(승인 기다림 포함)이 아니게 됨에서 지운다
   */
  thinking: Record<AgentId, { tokens: number | null }>
  /** 에이전트마다 마지막 assistant 글과 그 시각 — 기록을 안 불러온 에이전트도(관계도 카드의 한 줄 요약) */
  lastText: Record<AgentId, { text: string; at: number }>
  /** 키 `${from}>${to}` → 마지막으로 전달된 시각(message.updatedAt) */
  lastDelivered: Record<string, number>
  /**
   * 에이전트마다 지금 표시 상태가 시작된 시각 — status 이벤트로 표시 상태가 바뀐 걸 받은 순간(Date.now()).
   * 스냅샷으로만 아는 상태(켤 때 이미 작업 중 등)는 언제부터인지 모르므로 없다.
   */
  statusSince: Record<AgentId, number>
  /** 처음 상태를 한 번도 못 받았을 때 그 까닭(오류 문구) — 받으면 null. 받은 뒤의 실패는 여기 오지 않는다 */
  loadError: string | null
  /** 패널에서 고른 탭 — 에이전트마다, 앱을 끄면 잊는다. 없으면 대화 */
  panelTab: Record<AgentId, PanelTab>
  /** 대화의 서브에이전트 요약 줄을 눌렀다 — 지도가 key(노드 id)가 든 차례로 간다. n 은 누를 때마다 오른다 */
  subagentFocus: { agentId: AgentId; key: string; n: number } | null
  /**
   * 에이전트가 만든 새 에이전트 → 만든 에이전트(agent-added 사건). 관계도가 자리 없는 새 에이전트를 만든 쪽 가까이 놓는 데 쓴다.
   * 앱을 끄면 잊는다 — 사건을 놓친 새 에이전트(다시 켬)는 지금처럼 첫 빈 칸
   */
  placeNear: Record<AgentId, AgentId>
}

export type PanelTab = 'chat' | 'subagents'

export interface Store {
  getState(): UiState
  subscribe(fn: () => void): () => void
  init(): Promise<void>
  /** 방·에이전트를 바꾸는 호출(addRoom 등) 뒤에 스냅샷을 다시 받는다 */
  refresh(): Promise<void>
  selectAgent(id: AgentId | null): void
  selectRoom(id: RoomId): void
  setPanelTab(id: AgentId, tab: PanelTab): void
  /** 서브에이전트 탭으로 바꾸고 key(노드 id)가 든 차례를 보이게 한다 */
  showSubagents(id: AgentId, key: string): void
}

type Ev = { [K in keyof EngineEventMap]: { name: K; payload: EngineEventMap[K] } }[keyof EngineEventMap]

const EVENTS: (keyof EngineEventMap)[] = [
  'agent-event', 'status', 'message', 'request', 'request-resolved', 'flags', 'history', 'held-input',
  'usage', 'context', 'effort', 'model-now', 'subagents', 'agent-added',
]

const sameItem = (a: HistoryItem, b: HistoryItem) => JSON.stringify(a) === JSON.stringify(b)

/** 생각 표시가 살아 있을 수 있는 상태 — 그 밖(쉼·멈춤·오류)이 되면 생각도 끝났다 */
const busy = (status: AgentStatus | undefined) => status === 'working' || status === 'awaiting'

/** 그 에이전트의 생각 표시를 지운다 — 없으면 같은 객체(구독자가 다시 그리지 않게) */
function withoutThinking(thinking: UiState['thinking'], id: AgentId): UiState['thinking'] {
  if (!thinking[id]) return thinking
  const next = { ...thinking }
  delete next[id]
  return next
}

/** 부모의 assistant 항목의 글(하는 일 블록은 뺀다) — 글이 없거나 서브에이전트의 줄이면 '' */
function assistantText(item: HistoryItem): string {
  if (item.kind !== 'assistant' || item.parent) return ''
  return item.blocks.flatMap(b => (b.type === 'text' && b.text.trim() !== '' ? [b.text] : [])).join('\n\n')
}

export function createStore(api: DureApi): Store {
  let state: UiState = {
    claudeMissing: false, rooms: [], agents: [], messages: [], requests: [], autoChainLimit: 0, allowBypass: false, usage: null,
    roomId: null, selectedAgentId: null, history: {}, historyStatus: {}, streaming: {}, thinking: {}, lastText: {}, lastDelivered: {},
    statusSince: {}, loadError: null, panelTab: {}, subagentFocus: null, placeNear: {},
  }
  const listeners = new Set<() => void>()
  let buffer: { ev: Ev; at: number }[] | null = null // 스냅샷을 기다리는 동안 온 이벤트(받은 시각과 함께)
  const loading = new Map<AgentId, HistoryItem[]>() // 기록을 불러오는 동안 온 항목
  let subscribed = false
  let loaded = false // 스냅샷을 한 번이라도 받았는가

  const notify = () => listeners.forEach(fn => fn())
  const set = (next: UiState) => {
    state = next
    notify()
  }

  const applySnapshot = (snap: Snapshot) => {
    const roomId = snap.rooms.some(r => r.id === state.roomId) ? state.roomId : (snap.rooms[0]?.id ?? null)
    const selectedAgentId = snap.agents.some(a => a.id === state.selectedAgentId) ? state.selectedAgentId : null
    // 이벤트 없이 스냅샷에서 표시 상태가 바뀐 에이전트는 언제 바뀌었는지 모른다 — 시작 시각을 지운다
    let statusSince = state.statusSince
    for (const a of snap.agents) {
      if (statusSince[a.id] === undefined) continue
      const old = state.agents.find(x => x.id === a.id)
      if (!old || displayStatus(old, state.requests) !== displayStatus(a, snap.requests)) {
        statusSince = { ...statusSince }
        delete statusSince[a.id]
      }
    }
    // 받았으니 불러오기 오류도 같은 갱신에서 지운다(낡은 오류와 새 상태가 함께 그려지지 않게)
    state = { ...state, ...snap, roomId, selectedAgentId, statusSince, loadError: null }
  }

  const applyEvent = (ev: Ev, at: number) => {
    switch (ev.name) {
      case 'status': {
        const p = ev.payload
        const old = state.agents.find(a => a.id === p.agentId)
        const agents = state.agents.map(a => (a.id === p.agentId ? { ...a, status: p.status, errorText: p.errorText } : a))
        const next = agents.find(a => a.id === p.agentId)
        const changed = !!old && !!next && displayStatus(old, state.requests) !== displayStatus(next, state.requests)
        state = {
          ...state,
          agents,
          statusSince: changed ? { ...state.statusSince, [p.agentId]: at } : state.statusSince,
          // 멈춤·차례 끝·세션이 죽음 — 생각 끝 신호 없이 끝나도 '생각하는 중'이 남지 않게
          thinking: busy(p.status) ? state.thinking : withoutThinking(state.thinking, p.agentId),
        }
        break
      }
      case 'flags': {
        const p = ev.payload
        state = {
          ...state,
          agents: state.agents.map(a =>
            a.id === p.agentId ? { ...a, bypass: p.bypass, bypassBySettings: p.bySettings, bypassPending: p.pending } : a,
          ),
        }
        break
      }
      case 'held-input': {
        const p = ev.payload
        state = { ...state, agents: state.agents.map(a => (a.id === p.agentId ? { ...a, heldInput: p.count } : a)) }
        break
      }
      case 'usage':
        state = { ...state, usage: ev.payload }
        break
      case 'context': {
        const p = ev.payload
        state = { ...state, agents: state.agents.map(a => (a.id === p.agentId ? { ...a, lastContext: p.value } : a)) }
        break
      }
      case 'effort': {
        const p = ev.payload
        state = {
          ...state,
          agents: state.agents.map(a => (a.id === p.agentId ? { ...a, effort: p.effort, effortNow: p.effortNow } : a)),
        }
        break
      }
      case 'model-now': {
        const p = ev.payload
        state = { ...state, agents: state.agents.map(a => (a.id === p.agentId ? { ...a, modelNow: p.modelNow } : a)) }
        break
      }
      case 'subagents': {
        const p = ev.payload
        state = { ...state, agents: state.agents.map(a => (a.id === p.agentId ? { ...a, subagentsRunning: p.running } : a)) }
        break
      }
      case 'message': {
        const m = ev.payload
        const cur = state.messages.find(x => x.id === m.id)
        if (cur && cur.updatedAt > m.updatedAt) break // 더 오래된 사본
        const messages = cur ? state.messages.map(x => (x.id === m.id ? m : x)) : [...state.messages, m]
        const key = `${m.from}>${m.to}`
        const lastDelivered = m.state === 'delivered'
          ? { ...state.lastDelivered, [key]: Math.max(m.updatedAt, state.lastDelivered[key] ?? 0) }
          : state.lastDelivered
        state = { ...state, messages, lastDelivered }
        break
      }
      case 'request': {
        const r = ev.payload
        const requests = state.requests.some(x => x.id === r.id)
          ? state.requests.map(x => (x.id === r.id ? r : x))
          : [...state.requests, r]
        state = { ...state, requests }
        break
      }
      case 'request-resolved':
        state = { ...state, requests: state.requests.filter(r => r.id !== ev.payload.id) }
        break
      case 'agent-added': {
        const { agent, by } = ev.payload
        state = { ...state, placeNear: { ...state.placeNear, [agent.id]: by } }
        // 화면이 쓰는 모양(상태·묻지 않음 등)은 스냅샷에 있다 — 이미 받은 스냅샷에 들었으면(기다리는 동안 온 사건) 다시 받지 않는다.
        // 받는 중이면 끝난 뒤 한 번 더 받는다. 못 받으면 다음 스냅샷(자리 저장 등) 때 들어온다
        if (!state.agents.some(a => a.id === agent.id)) fetchSnapshot().catch(() => {})
        break
      }
      case 'history': {
        const { agentId, item } = ev.payload
        // 새 대화(boundary) — 앞 대화는 버린다. 다시 켜면 엔진의 history() 도 경계 뒤만 주니 같은 화면이 된다(알림 줄 없음)
        const boundary = item.kind === 'boundary'
        // 서브에이전트의 줄·시작·끝 — 부모의 차례와 따로 온다(부모 차례 중에도 섞여 온다). 부모의 흐르는 글·마지막 글과 상관없다
        const sub = ('parent' in item && !!item.parent) || item.kind === 'subagent-start' || item.kind === 'subagent-end'
        // 흐르는 글·마지막 글은 기록을 불러왔든 아니든 — 안 비우면 다음 차례 글이 앞 차례 뒤에 붙는다
        const text = assistantText(item)
        let lastText = state.lastText
        if (text) lastText = { ...lastText, [agentId]: { text, at: item.t } }
        else if (boundary && lastText[agentId]) {
          lastText = { ...lastText }
          delete lastText[agentId]
        }
        // 부모의 답(글·하는 일 — 생각 블록만 든 빈 답도)·차례 끝·알림(멈춤·오류)·새 대화 — 생각은 끝났다
        const thoughtEnds = (item.kind === 'assistant' && !sub) || item.kind === 'result' || item.kind === 'notice' || boundary
        state = {
          ...state,
          streaming: state.streaming[agentId] && !sub ? { ...state.streaming, [agentId]: '' } : state.streaming,
          thinking: thoughtEnds ? withoutThinking(state.thinking, agentId) : state.thinking,
          lastText,
        }
        const pending = loading.get(agentId)
        if (pending) {
          // 불러오는 중 — 경계만 맨 앞에 남겨, 불러온 기록(경계 앞이거나 이미 그 뒤에 왔다)도 버리게 한다
          if (boundary) pending.splice(0, pending.length, item)
          else pending.push(item)
          break
        }
        const list = state.history[agentId]
        if (!list) break // 아직 안 불러온 에이전트 — 불러올 때 같이 온다
        state = { ...state, history: { ...state.history, [agentId]: boundary ? [] : [...list, item] } }
        break
      }
      case 'agent-event': {
        const { agentId, event } = ev.payload
        if (event.kind === 'text-delta') {
          state = {
            ...state,
            streaming: { ...state.streaming, [agentId]: (state.streaming[agentId] ?? '') + event.text },
            thinking: withoutThinking(state.thinking, agentId), // 글이 흐르면 생각은 끝났다
          }
        } else if (event.kind === 'thinking') {
          const cur = state.thinking[agentId]
          if (!event.active) {
            state = { ...state, thinking: withoutThinking(state.thinking, agentId) }
            break
          }
          // 쉬는 에이전트에게 늦게 온 신호는 버린다 — 다음 차례가 '생각하는 중'으로 시작하지 않게
          if (!busy(state.agents.find(a => a.id === agentId)?.status)) break
          // 토큰 수를 모르는 신호(새 생각 블록 시작)는 이미 아는 수를 지우지 않는다. 같은 수면 그대로(다시 그리지 않게)
          const tokens = event.tokens ?? cur?.tokens ?? null
          if (cur && cur.tokens === tokens) break
          state = { ...state, thinking: { ...state.thinking, [agentId]: { tokens } } }
        }
        break
      }
    }
  }

  const onEvent = (ev: Ev) => {
    const at = Date.now() // 받은 시각 — 스냅샷을 기다렸다 적용해도 이 시각을 쓴다
    if (buffer) { buffer.push({ ev, at }); return }
    applyEvent(ev, at)
    notify()
  }

  const subscribeEvents = () => {
    if (subscribed) return
    subscribed = true
    for (const name of EVENTS) {
      api.on(name, (payload: EngineEventMap[typeof name]) => onEvent({ name, payload } as Ev))
    }
  }

  const snapshotCycle = async () => {
    buffer = []
    try {
      applySnapshot(await api.snapshot())
      loaded = true
    } catch (e) {
      // 처음 상태를 못 받았으면 화면이 '첫 방을 만들어 보세요' 대신 이 까닭을 보이게
      if (!loaded) state = { ...state, loadError: e instanceof Error ? e.message : String(e) }
      throw e
    } finally {
      const pending = buffer
      buffer = null
      for (const { ev, at } of pending ?? []) applyEvent(ev, at)
      notify()
    }
  }

  // 스냅샷 요청은 한 번에 하나만 — 도중에 또 오면 끝난 뒤 한 번 더 받는다
  let inflight: Promise<void> | null = null
  let rerun = false
  const fetchSnapshot = (): Promise<void> => {
    if (inflight) {
      rerun = true
      return inflight
    }
    inflight = (async () => {
      try {
        do {
          rerun = false
          await snapshotCycle()
        } while (rerun)
      } finally {
        inflight = null
        rerun = false
      }
    })()
    return inflight
  }

  const loadHistory = async (id: AgentId) => {
    if (state.history[id] || loading.has(id)) return
    loading.set(id, [])
    set({ ...state, historyStatus: { ...state.historyStatus, [id]: { state: 'loading' } } })
    try {
      const loaded = await api.history(id)
      const pending = loading.get(id) ?? []
      loading.delete(id)
      // 불러오는 동안 새 대화가 시작됐으면(경계가 맨 앞에 남아 있다) 경계 뒤에 온 것만 — 경계 뒤에 읽었어도 그 항목들은 이벤트로 이미 왔다
      const list = pending[0]?.kind === 'boundary'
        ? pending.slice(1)
        : [...loaded, ...pending.filter(it => !loaded.some(l => sameItem(l, it)))]
      // 다시 켠 뒤엔 이벤트로 온 글이 없다 — 불러온 기록의 마지막 글로 채운다(더 새 글이 이미 있으면 그대로)
      let lastText = state.lastText
      for (let i = list.length - 1; i >= 0; i--) {
        const text = assistantText(list[i])
        if (!text) continue
        if ((lastText[id]?.at ?? -Infinity) < list[i].t) lastText = { ...lastText, [id]: { text, at: list[i].t } }
        break
      }
      set({
        ...state,
        history: { ...state.history, [id]: list },
        historyStatus: { ...state.historyStatus, [id]: { state: 'ready' } },
        lastText,
      })
    } catch (e) {
      loading.delete(id)
      const error = e instanceof Error ? e.message : String(e)
      set({ ...state, historyStatus: { ...state.historyStatus, [id]: { state: 'error', error } } })
    }
  }

  return {
    getState: () => state,
    subscribe(fn) {
      listeners.add(fn)
      return () => { listeners.delete(fn) }
    },
    async init() {
      subscribeEvents()
      await fetchSnapshot()
    },
    async refresh() {
      await fetchSnapshot()
    },
    selectAgent(id) {
      set({ ...state, selectedAgentId: id })
      if (id) void loadHistory(id)
    },
    selectRoom(id) {
      if (!state.rooms.some(r => r.id === id)) return
      set({ ...state, roomId: id, selectedAgentId: null })
    },
    setPanelTab(id, tab) {
      if (state.panelTab[id] === tab) return
      set({ ...state, panelTab: { ...state.panelTab, [id]: tab } })
    },
    showSubagents(id, key) {
      set({
        ...state,
        panelTab: { ...state.panelTab, [id]: 'subagents' },
        subagentFocus: { agentId: id, key, n: (state.subagentFocus?.n ?? 0) + 1 },
      })
    },
  }
}

let shared: Store | null = null
/** 앱 전체가 쓰는 스토어 — window.dure 로 처음 부를 때 만든다 */
export function getStore(): Store {
  return (shared ??= createStore(window.dure))
}

/** 원시값은 ===, 배열은 원소별 ===, 일반 객체는 한 단계 === */
export function shallowEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((v, i) => Object.is(v, b[i]))
  }
  const ka = Object.keys(a)
  const kb = Object.keys(b)
  if (ka.length !== kb.length) return false
  return ka.every(key => Object.prototype.hasOwnProperty.call(b, key) && Object.is((a as any)[key], (b as any)[key]))
}

export function useDure<T>(sel: (s: UiState) => T, isEqual: (a: T, b: T) => boolean = shallowEqual): T {
  const store = getStore()
  const last = useRef<{ v: T } | null>(null)
  const get = () => {
    const next = sel(store.getState())
    if (last.current && isEqual(last.current.v, next)) return last.current.v
    last.current = { v: next }
    return next
  }
  return useSyncExternalStore(store.subscribe, get)
}
