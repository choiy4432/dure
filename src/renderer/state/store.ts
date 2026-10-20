import { useRef, useSyncExternalStore } from 'react'
import type { AgentId, EngineEventMap, HistoryItem, RoomId } from '../../engine/types'
import type { DureApi, Snapshot } from '../../shared/ipcContract'
import { displayStatus } from './selectors'

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
  /**
   * 에이전트마다 지금 표시 상태가 시작된 시각 — status 이벤트로 표시 상태가 바뀐 걸 받은 순간(Date.now()).
   * 스냅샷으로만 아는 상태(켤 때 이미 작업 중 등)는 언제부터인지 모르므로 없다.
   */
  statusSince: Record<AgentId, number>
  /** 처음 상태를 한 번도 못 받았을 때 그 까닭(오류 문구) — 받으면 null. 받은 뒤의 실패는 여기 오지 않는다 */
  loadError: string | null
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
  'usage', 'context', 'effort',
]

const sameItem = (a: HistoryItem, b: HistoryItem) => JSON.stringify(a) === JSON.stringify(b)

/** assistant 항목의 글(하는 일 블록은 뺀다) — 글이 없으면 '' */
function assistantText(item: HistoryItem): string {
  if (item.kind !== 'assistant') return ''
  return item.blocks.flatMap(b => (b.type === 'text' && b.text.trim() !== '' ? [b.text] : [])).join('\n\n')
}

export function createStore(api: DureApi): Store {
  let state: UiState = {
    claudeMissing: false, rooms: [], agents: [], messages: [], requests: [], autoChainLimit: 0, usage: null,
    roomId: null, selectedAgentId: null, history: {}, historyStatus: {}, streaming: {}, lastText: {}, lastDelivered: {},
    statusSince: {}, loadError: null,
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
        state = { ...state, agents, statusSince: changed ? { ...state.statusSince, [p.agentId]: at } : state.statusSince }
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
        // 새 대화(boundary) — 앞 대화는 버린다. 다시 켜면 엔진의 history() 도 경계 뒤만 주니 같은 화면이 된다(알림 줄 없음)
        const boundary = item.kind === 'boundary'
        // 흐르는 글·마지막 글은 기록을 불러왔든 아니든 — 안 비우면 다음 차례 글이 앞 차례 뒤에 붙는다
        const text = assistantText(item)
        let lastText = state.lastText
        if (text) lastText = { ...lastText, [agentId]: { text, at: item.t } }
        else if (boundary && lastText[agentId]) {
          lastText = { ...lastText }
          delete lastText[agentId]
        }
        state = {
          ...state,
          streaming: state.streaming[agentId] ? { ...state.streaming, [agentId]: '' } : state.streaming,
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
          state = { ...state, streaming: { ...state.streaming, [agentId]: (state.streaming[agentId] ?? '') + event.text } }
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
