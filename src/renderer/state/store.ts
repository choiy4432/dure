import { useRef, useSyncExternalStore } from 'react'
import { SLEEP_DEFAULT_MIN, type AgentId, type AgentStatus, type EngineEventMap, type HistoryItem, type RoomId } from '../../engine/types'
import type { DureApi, Snapshot } from '../../shared/ipcContract'
import { displayStatus, type EdgeMode, type Phase } from './selectors'
import { markFresh } from '../map/freshNodes'

export type UiState = Snapshot & {
  roomId: RoomId | null
  selectedAgentId: AgentId | null
  history: Record<AgentId, HistoryItem[]>
  historyStatus: Record<AgentId, { state: 'loading' | 'ready' | 'error'; error?: string }>
  streaming: Record<AgentId, string>
  /**
   * Claude 가 생각하는 중인 에이전트 — tokens = 지금까지 생각한 추정 토큰 수(모르면 null). 없으면 생각 중이 아니다.
   * 생각 블록 시작에서만 생기고(토큰 수 신호는 수만 바꾼다), 생각 끝 신호 · 흐르는 글 · 그 에이전트의 답·끝·알림·새 대화 기록 ·
   * 작업 중(승인 기다림 포함)이 아니게 됨에서 지운다
   */
  thinking: Record<AgentId, { tokens: number | null }>
  /**
   * 차례의 단계 — 내용(생각·글·하는 일)이 오기 전 무엇을 기다리는지. 보낸 줄(user 기록)이 오면 준비, API 상태(api-status)가
   * 요청 보냄이면 답 기다림 · 요약 중이면 대화 정리. 내용이 오기 시작함(생각 신호·흐르는 글·부모의 답) · 차례 끝·알림·새 대화 ·
   * API 상태 null · 작업 중(승인 기다림 포함)이 아니게 됨에서 지운다. 없으면 단계를 모른다(작업 중…)
   */
  phase: Record<AgentId, Phase>
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
  /** 메시지 탭의 '대화에서 보기'를 눌렀다 — 그 에이전트의 대화가 messageId 메시지 줄로 간다. 간 뒤엔 대화 목록이 지운다(다시 열려도 또 가지 않게) */
  messageFocus: { agentId: AgentId; messageId: string; n: number } | null
  /** 관계도 선 보기 — 이 PC 에 기억한다(EDGE_MODE_KEY), 처음엔 최근 */
  edgeMode: EdgeMode
  /**
   * 에이전트가 만든 새 에이전트 → 만든 에이전트(agent-added 사건). 관계도가 자리 없는 새 에이전트를 만든 쪽 가까이 놓는 데 쓴다.
   * 앱을 끄면 잊는다 — 사건을 놓친 새 에이전트(다시 켬)는 지금처럼 첫 빈 칸
   */
  placeNear: Record<AgentId, AgentId>
  /**
   * 끝났고 아직 안 본 에이전트 → 끝난 시각(result 기록의 t). 고르지 않은 에이전트(또는 창에 초점이 없을 때 고른 것)의 차례가 끝나면 생기고,
   * 그 에이전트를 고름 · 다시 작업 중(승인 기다림 포함) · 새 대화에서 지운다. 앱을 끄면 잊는다
   */
  fresh: Record<AgentId, number>
  /** 방 목록을 열어 달라는 요청 횟수 — 흘끗 보기 창 등 바깥에서 요청하면 오른다(0 부터). 값이 바뀔 때마다 방 목록을 연다 */
  roomMenuRequest: number
}

export type PanelTab = 'chat' | 'subagents' | 'messages'

/** 관계도 선 보기를 기억하는 자리(이 PC) */
export const EDGE_MODE_KEY = 'dure.edges'
const EDGE_MODES: EdgeMode[] = ['recent', 'all', 'off']

function readEdgeMode(): EdgeMode {
  try {
    const v = localStorage.getItem(EDGE_MODE_KEY)
    return EDGE_MODES.includes(v as EdgeMode) ? (v as EdgeMode) : 'recent'
  } catch {
    return 'recent'
  }
}

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
  /** 그 에이전트를 고르고(다른 에이전트면 그 방으로 · 기록도 불러온다) 대화 탭에서 messageId 메시지 줄을 보이게 한다. 모르는 id 면 아무것도 안 한다 */
  showMessage(id: AgentId, messageId: string): void
  /** 대화 목록이 messageFocus(n)로 갔다 — 지운다. 그 사이 새로 누른 것(n 이 다르면)은 남긴다 */
  doneMessageFocus(n: number): void
  /** 관계도 선 보기를 바꾸고 이 PC 에 기억한다 */
  setEdgeMode(mode: EdgeMode): void
  /** 그 에이전트의 방으로 바꾸고(다르면) 고른다 — 기록도 불러온다. 모르는 id 면 아무것도 안 한다 */
  focusAgent(id: AgentId): void
  /** 방 목록을 열어 달라고 요청한다 — roomMenuRequest 가 하나 오른다 */
  requestRoomMenu(): void
}

type Ev = { [K in keyof EngineEventMap]: { name: K; payload: EngineEventMap[K] } }[keyof EngineEventMap]

const EVENTS: (keyof EngineEventMap)[] = [
  'agent-event', 'status', 'message', 'request', 'request-resolved', 'flags', 'history', 'held-input',
  'usage', 'context', 'effort', 'model-now', 'subagents', 'agent-added', 'plan-mode', 'hold', 'always-allow', 'sleep',
]

const sameItem = (a: HistoryItem, b: HistoryItem) => JSON.stringify(a) === JSON.stringify(b)

/** 생각 표시가 살아 있을 수 있는 상태 — 그 밖(쉼·멈춤·오류)이 되면 생각도 끝났다 */
const busy = (status: AgentStatus | undefined) => status === 'working' || status === 'awaiting'

/** 그 에이전트의 표시(생각·단계)를 지운다 — 없으면 같은 객체(구독자가 다시 그리지 않게) */
function without<T>(rec: Record<AgentId, T>, id: AgentId): Record<AgentId, T> {
  if (rec[id] === undefined) return rec
  const next = { ...rec }
  delete next[id]
  return next
}
const withoutThinking = without<UiState['thinking'][AgentId]>

/** 그 에이전트의 단계를 바꾼다 — 같으면 같은 객체 */
function withPhase(phase: UiState['phase'], id: AgentId, to: Phase): UiState['phase'] {
  return phase[id] === to ? phase : { ...phase, [id]: to }
}

/** 부모의 assistant 항목의 글(하는 일 블록은 뺀다) — 글이 없거나 서브에이전트의 줄이면 '' */
function assistantText(item: HistoryItem): string {
  if (item.kind !== 'assistant' || item.parent) return ''
  return item.blocks.flatMap(b => (b.type === 'text' && b.text.trim() !== '' ? [b.text] : [])).join('\n\n')
}

export function createStore(api: DureApi, opts: { hasFocus?: () => boolean } = {}): Store {
  // 창에 초점이 있는가 — 초점이 없으면 고른 에이전트의 결과도 못 본 것이다. document.hasFocus 가 없는 환경에선 본 것으로 친다
  const hasFocus = opts.hasFocus ?? (() => (typeof document !== 'undefined' && typeof document.hasFocus === 'function' ? document.hasFocus() : true))
  let state: UiState = {
    claudeMissing: false, rooms: [], agents: [], messages: [], requests: [], autoChainLimit: 0, allowBypass: false, notify: { asks: true, finished: false }, sleepAfterMin: SLEEP_DEFAULT_MIN, usage: null,
    roomId: null, selectedAgentId: null, history: {}, historyStatus: {}, streaming: {}, thinking: {}, phase: {}, lastText: {}, lastDelivered: {},
    statusSince: {}, loadError: null, panelTab: {}, subagentFocus: null, messageFocus: null, edgeMode: readEdgeMode(), placeNear: {}, fresh: {}, roomMenuRequest: 0,
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
          // 다시 일을 시작했다 — 앞 결과는 지나간 일이니 '끝남' 표시도 내린다
          fresh: busy(p.status) ? without(state.fresh, p.agentId) : state.fresh,
          // 쉬다가 일하기 시작했는데 기다리는 입력이 있다 — 아직 Claude 에게 안 간 입력(띄울 때의 /effort 뒤에서 기다림)이니 준비.
          // 승인 기다림에서 돌아온 것은 이어지는 차례라 그대로
          phase: !busy(p.status) ? without(state.phase, p.agentId)
            : p.status === 'working' && !busy(old?.status) && (next?.heldInput ?? 0) > 0 ? withPhase(state.phase, p.agentId, 'preparing')
            : state.phase,
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
      case 'plan-mode': {
        const p = ev.payload
        state = { ...state, agents: state.agents.map(a => (a.id === p.agentId ? { ...a, planMode: p.on } : a)) }
        break
      }
      case 'sleep': {
        const p = ev.payload
        state = { ...state, agents: state.agents.map(a => (a.id === p.agentId ? { ...a, asleep: p.asleep, waking: p.waking } : a)) }
        break
      }
      case 'hold': {
        const p = ev.payload
        state = { ...state, agents: state.agents.map(a => (a.id === p.agentId ? { ...a, hold: p.hold } : a)) }
        break
      }
      case 'always-allow': {
        const p = ev.payload
        state = { ...state, agents: state.agents.map(a => (a.id === p.agentId ? { ...a, alwaysAllow: p.alwaysAllow } : a)) }
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
        // 사람이 더한 카드처럼 관계도 카드가 나타난다(AddAgentDialog 와 같은 표 — 움직임 줄이기면 그대로)
        markFresh(agent.id)
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
          // 보낸 줄은 Claude 에게 쓴 순간 기록된다(working 알림과 어느 쪽이 먼저 와도 된다) — 요청이 나갈 때까지 준비. 같은 때에 생각도 끝난다
          phase: item.kind === 'user' ? withPhase(state.phase, agentId, 'preparing') : thoughtEnds ? without(state.phase, agentId) : state.phase,
          lastText,
          // 못 본 결과 — 고르지 않았거나 창에 초점이 없다. 새 대화는 앞 결과를 지운다
          fresh: item.kind === 'result' && (state.selectedAgentId !== agentId || !hasFocus()) ? { ...state.fresh, [agentId]: item.t }
            : boundary ? without(state.fresh, agentId)
            : state.fresh,
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
            phase: without(state.phase, agentId), // 기다리던 답이 왔다
          }
        } else if (event.kind === 'api-status') {
          // 쉬는 에이전트에게 늦게 온 상태는 버린다 — 다음 차례가 그 단계로 시작하지 않게
          if (!busy(state.agents.find(a => a.id === agentId)?.status)) break
          // null = 요청·요약이 끝났다 — 그 단계만 지운다(준비는 CLI 상태가 아니니 늦게 온 끝이 다음 줄의 준비를 지우지 않게)
          const phase = event.status !== null ? withPhase(state.phase, agentId, event.status === 'requesting' ? 'requesting' : 'compacting')
            : state.phase[agentId] === 'preparing' ? state.phase
            : without(state.phase, agentId)
          if (phase !== state.phase) state = { ...state, phase }
        } else if (event.kind === 'thinking') {
          // 블록이 시작됐다(생각이든 글·하는 일이든) — 기다리던 답이 왔다
          const phase = without(state.phase, agentId)
          if (phase !== state.phase) state = { ...state, phase }
          const cur = state.thinking[agentId]
          if (!event.active) {
            state = { ...state, thinking: withoutThinking(state.thinking, agentId) }
            break
          }
          // 쉬는 에이전트에게 늦게 온 신호는 버린다 — 다음 차례가 '생각하는 중'으로 시작하지 않게
          if (!busy(state.agents.find(a => a.id === agentId)?.status)) break
          // 생각을 여는 건 블록 시작(수 없음)뿐 — 수만 든 신호(thinking_tokens)는 생각 중일 때 수만 바꾼다.
          // 생각이 끝난 뒤(글 블록 시작) 늦게 온 수가 '생각하는 중'을 잠깐 다시 열지 않게
          if (!cur && event.tokens !== null) break
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

  /** 고른 에이전트를 엔진에 알린다 — 엔진이 claude 를 미리 띄운다. 알리기가 실패해도(끊김·없는 길) 고르기는 그대로 */
  const tellSelected = (id: AgentId | null) => {
    try {
      api.setSelected(id).catch(() => {})
    } catch {
      /* 알릴 길이 없다 — 보낼 때 띄운다 */
    }
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

  // 창이 다시 초점을 받으면 — 고른 에이전트의 대화가 지금 보이니 '끝남 · 새 결과' 를 지운다(초점이 없을 땐 못 본 것이라 남겼다).
  // 초점 없는 사이 고른 것도 같은 길로 풀린다. DOM 이 없는 환경(엔진 시험 등)에선 건너뛴다
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('focus', () => {
      const id = state.selectedAgentId
      if (id && id in state.fresh) set({ ...state, fresh: without(state.fresh, id) })
    })
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
      set({ ...state, selectedAgentId: id, fresh: id ? without(state.fresh, id) : state.fresh })
      tellSelected(id)
      if (id) void loadHistory(id)
    },
    selectRoom(id) {
      if (!state.rooms.some(r => r.id === id)) return
      set({ ...state, roomId: id, selectedAgentId: null })
      tellSelected(null)
    },
    focusAgent(id) {
      const a = state.agents.find(x => x.id === id)
      if (!a) return
      // 방을 바꾸면서 고르기 — selectRoom 은 고르기를 비우니 쓰지 않고 한 번에 바꾼다
      const roomId = state.rooms.some(r => r.id === a.roomId) ? a.roomId : state.roomId
      set({ ...state, roomId, selectedAgentId: id, fresh: without(state.fresh, id) })
      tellSelected(id)
      void loadHistory(id)
    },
    requestRoomMenu() {
      set({ ...state, roomMenuRequest: state.roomMenuRequest + 1 })
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
    showMessage(id, messageId) {
      const a = state.agents.find(x => x.id === id)
      if (!a) return
      const other = state.selectedAgentId !== id
      const roomId = state.rooms.some(r => r.id === a.roomId) ? a.roomId : state.roomId
      set({
        ...state,
        roomId,
        selectedAgentId: id,
        fresh: without(state.fresh, id),
        panelTab: { ...state.panelTab, [id]: 'chat' },
        messageFocus: { agentId: id, messageId, n: (state.messageFocus?.n ?? 0) + 1 },
      })
      if (other) {
        tellSelected(id)
        void loadHistory(id)
      }
    },
    doneMessageFocus(n) {
      if (state.messageFocus?.n !== n) return
      set({ ...state, messageFocus: null })
    },
    setEdgeMode(mode) {
      if (state.edgeMode === mode) return
      set({ ...state, edgeMode: mode })
      try {
        localStorage.setItem(EDGE_MODE_KEY, mode)
      } catch {
        // 저장을 못 해도 이번 실행에선 그대로 쓴다
      }
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
