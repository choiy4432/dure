import { useSyncExternalStore } from 'react'
import type { AgentId, EngineEventMap, HistoryItem, RoomId } from '../../engine/types'
import type { DureApi, Snapshot } from '../../shared/ipcContract'

export type UiState = Snapshot & {
  roomId: RoomId | null
  selectedAgentId: AgentId | null
  history: Record<AgentId, HistoryItem[]>
  streaming: Record<AgentId, string>
  /** 키 `${from}>${to}` → 마지막으로 전달된 시각(message.updatedAt) */
  lastDelivered: Record<string, number>
}

export interface Store {
  getState(): UiState
  subscribe(fn: () => void): () => void
  init(): Promise<void>
  /** 방·에이전트를 바꾸는 호출(addRoom 등) 뒤에 스냅샷을 다시 받는다 */
  refresh(): Promise<void>
  selectAgent(id: AgentId | null): void
  selectRoom(id: RoomId): void
}

type Ev = { [K in keyof EngineEventMap]: { name: K; payload: EngineEventMap[K] } }[keyof EngineEventMap]

const EVENTS: (keyof EngineEventMap)[] = [
  'agent-event', 'status', 'message', 'request', 'request-resolved', 'flags', 'history', 'held-input',
]

const sameItem = (a: HistoryItem, b: HistoryItem) => JSON.stringify(a) === JSON.stringify(b)

export function createStore(api: DureApi): Store {
  let state: UiState = {
    claudeMissing: false, rooms: [], agents: [], messages: [], requests: [], autoChainLimit: 0,
    roomId: null, selectedAgentId: null, history: {}, streaming: {}, lastDelivered: {},
  }
  const listeners = new Set<() => void>()
  let buffer: Ev[] | null = null // 스냅샷을 기다리는 동안 온 이벤트
  const loading = new Map<AgentId, HistoryItem[]>() // 기록을 불러오는 동안 온 항목
  let subscribed = false

  const notify = () => listeners.forEach(fn => fn())
  const set = (next: UiState) => {
    state = next
    notify()
  }

  const applySnapshot = (snap: Snapshot) => {
    const roomId = snap.rooms.some(r => r.id === state.roomId) ? state.roomId : (snap.rooms[0]?.id ?? null)
    const selectedAgentId = snap.agents.some(a => a.id === state.selectedAgentId) ? state.selectedAgentId : null
    state = { ...state, ...snap, roomId, selectedAgentId }
  }

  const applyEvent = (ev: Ev) => {
    switch (ev.name) {
      case 'status': {
        const p = ev.payload
        state = { ...state, agents: state.agents.map(a => (a.id === p.agentId ? { ...a, status: p.status, errorText: p.errorText } : a)) }
        break
      }
      case 'flags': {
        const p = ev.payload
        state = { ...state, agents: state.agents.map(a => (a.id === p.agentId ? { ...a, bypass: p.bypass } : a)) }
        break
      }
      case 'held-input': {
        const p = ev.payload
        state = { ...state, agents: state.agents.map(a => (a.id === p.agentId ? { ...a, heldInput: p.count } : a)) }
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
      case 'history': {
        const { agentId, item } = ev.payload
        const pending = loading.get(agentId)
        if (pending) { pending.push(item); break }
        const list = state.history[agentId]
        if (!list) break // 아직 안 불러온 에이전트 — 불러올 때 같이 온다
        state = {
          ...state,
          history: { ...state.history, [agentId]: [...list, item] },
          streaming: { ...state.streaming, [agentId]: '' },
        }
        break
      }
      case 'agent-event': {
        const { agentId, event } = ev.payload
        if (event.kind === 'text-delta') {
          state = { ...state, streaming: { ...state.streaming, [agentId]: (state.streaming[agentId] ?? '') + event.text } }
        }
        break
      }
    }
  }

  const onEvent = (ev: Ev) => {
    if (buffer) { buffer.push(ev); return }
    applyEvent(ev)
    notify()
  }

  const subscribeEvents = () => {
    if (subscribed) return
    subscribed = true
    for (const name of EVENTS) {
      api.on(name, (payload: EngineEventMap[typeof name]) => onEvent({ name, payload } as Ev))
    }
  }

  const fetchSnapshot = async () => {
    buffer = []
    try {
      applySnapshot(await api.snapshot())
    } finally {
      const pending = buffer
      buffer = null
      for (const ev of pending ?? []) applyEvent(ev)
    }
    notify()
  }

  const loadHistory = async (id: AgentId) => {
    if (state.history[id] || loading.has(id)) return
    loading.set(id, [])
    try {
      const loaded = await api.history(id)
      const extra = (loading.get(id) ?? []).filter(it => !loaded.some(l => sameItem(l, it)))
      set({ ...state, history: { ...state.history, [id]: [...loaded, ...extra] } })
    } finally {
      loading.delete(id)
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
  }
}

let shared: Store | null = null
/** 앱 전체가 쓰는 스토어 — window.dure 로 처음 부를 때 만든다 */
export function getStore(): Store {
  return (shared ??= createStore(window.dure))
}

export function useDure<T>(sel: (s: UiState) => T): T {
  const store = getStore()
  return useSyncExternalStore(store.subscribe, () => sel(store.getState()))
}
