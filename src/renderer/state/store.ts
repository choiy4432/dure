import { useRef, useSyncExternalStore } from 'react'
import type { AgentId, EngineEventMap, HistoryItem, RoomId } from '../../engine/types'
import type { DureApi, Snapshot } from '../../shared/ipcContract'

export type UiState = Snapshot & {
  roomId: RoomId | null
  selectedAgentId: AgentId | null
  history: Record<AgentId, HistoryItem[]>
  historyStatus: Record<AgentId, { state: 'loading' | 'ready' | 'error'; error?: string }>
  streaming: Record<AgentId, string>
  /** 에이전트마다 마지막 assistant 글과 그 시각 — 기록을 안 불러온 에이전트도(관계도 카드의 한 줄 요약) */
  lastText: Record<AgentId, { text: string; at: number }>
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

/** assistant 항목의 글(하는 일 블록은 뺀다) — 글이 없으면 '' */
function assistantText(item: HistoryItem): string {
  if (item.kind !== 'assistant') return ''
  return item.blocks.flatMap(b => (b.type === 'text' && b.text.trim() !== '' ? [b.text] : [])).join('\n\n')
}

export function createStore(api: DureApi): Store {
  let state: UiState = {
    claudeMissing: false, rooms: [], agents: [], messages: [], requests: [], autoChainLimit: 0,
    roomId: null, selectedAgentId: null, history: {}, historyStatus: {}, streaming: {}, lastText: {}, lastDelivered: {},
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
        // 흐르는 글·마지막 글은 기록을 불러왔든 아니든 — 안 비우면 다음 차례 글이 앞 차례 뒤에 붙는다
        const text = assistantText(item)
        state = {
          ...state,
          streaming: state.streaming[agentId] ? { ...state.streaming, [agentId]: '' } : state.streaming,
          lastText: text ? { ...state.lastText, [agentId]: { text, at: item.t } } : state.lastText,
        }
        const pending = loading.get(agentId)
        if (pending) { pending.push(item); break }
        const list = state.history[agentId]
        if (!list) break // 아직 안 불러온 에이전트 — 불러올 때 같이 온다
        state = { ...state, history: { ...state.history, [agentId]: [...list, item] } }
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

  const snapshotCycle = async () => {
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
      const extra = (loading.get(id) ?? []).filter(it => !loaded.some(l => sameItem(l, it)))
      loading.delete(id)
      const list = [...loaded, ...extra]
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
