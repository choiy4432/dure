import type { AgentId, MessageState, PendingRequest, RelayMessage, RoomId } from '../../engine/types'
import type { AgentView } from '../../shared/ipcContract'
import { MESSAGE_WORD } from '../lib/words'

export type DisplayStatus = 'working' | 'awaiting' | 'idle' | 'error' | 'stopped'
/** 차례의 단계 — 생각·글이 오기 전 무엇을 기다리는지(store.phase) */
export type Phase = 'preparing' | 'requesting' | 'compacting'

export interface EdgeView {
  id: string
  from: AgentId
  to: AgentId
  state: MessageState
  at: number
  count: number
}

interface SummaryInput {
  agents: AgentView[]
  messages: RelayMessage[]
  requests: PendingRequest[]
}

const isUnread = (m: RelayMessage) => m.state === 'pending' || m.state === 'held'

export function displayStatus(agent: AgentView, requests: PendingRequest[]): DisplayStatus {
  if (agent.status === 'awaiting' || requests.some(r => r.agentId === agent.id)) return 'awaiting'
  return agent.status
}

export function unreadFor(agentId: AgentId, messages: RelayMessage[]): number {
  return messages.filter(m => m.to === agentId && isUnread(m)).length
}

/** 이 에이전트가 받은 메시지 중 가장 최근에 전달된 것 — 패널 고정 카드 자리의 '최근 전달' 한 장 */
export function latestDelivered(agentId: AgentId, messages: RelayMessage[]): RelayMessage | null {
  let hit: RelayMessage | null = null
  for (const m of messages) {
    if (m.to !== agentId || m.state !== 'delivered') continue
    if (!hit || m.updatedAt > hit.updatedAt) hit = m
  }
  return hit
}

type FreshInput = SummaryInput & { fresh?: Record<AgentId, number> }

/** 새 결과 = 확인 안 한 결과가 있고, 지금은 작업 중도 승인 기다림도 아닌 것 */
const hasFresh = (a: AgentView, s: FreshInput) =>
  s.fresh?.[a.id] !== undefined && !['working', 'awaiting'].includes(displayStatus(a, s.requests))

export function summary(state: FreshInput, roomId: RoomId): { working: number; awaiting: number; unread: number; fresh: number } {
  let working = 0
  let awaiting = 0
  let fresh = 0
  for (const a of state.agents) {
    if (a.roomId !== roomId) continue
    const s = displayStatus(a, state.requests)
    if (s === 'working') working++
    else if (s === 'awaiting') awaiting++
    if (hasFresh(a, state)) fresh++
  }
  const unread = state.messages.filter(m => m.roomId === roomId && isUnread(m)).length
  return { working, awaiting, unread, fresh }
}

export type ChipKind = 'working' | 'awaiting' | 'unread' | 'fresh'

/** 요약 칩을 누를 때 갈 에이전트 — 방 안 순서에서 after 다음, 끝이면 처음으로. after 가 그 종류가 아니면 첫 번째 */
export function nextAgent(kind: ChipKind, s: FreshInput, roomId: RoomId, after: AgentId | null): AgentId | null {
  const match = (a: AgentView) => {
    if (kind === 'fresh') return hasFresh(a, s)
    if (kind === 'unread') return unreadFor(a.id, s.messages) > 0
    return displayStatus(a, s.requests) === kind
  }
  const list = s.agents.filter(a => a.roomId === roomId && match(a)).map(a => a.id)
  if (list.length === 0) return null
  const i = after === null ? -1 : list.indexOf(after)
  return list[(i + 1) % list.length]
}

export function edges(roomId: RoomId, agents: AgentView[], messages: RelayMessage[]): EdgeView[] {
  const alive = new Set(agents.filter(a => a.roomId === roomId).map(a => a.id))
  const byPair = new Map<string, { latest: RelayMessage; count: number }>()
  for (const m of messages) {
    if (m.roomId !== roomId || m.state === 'dismissed') continue
    if (!alive.has(m.from) || !alive.has(m.to)) continue
    const id = `${m.from}>${m.to}`
    const cur = byPair.get(id)
    if (!cur) byPair.set(id, { latest: m, count: 1 })
    else {
      cur.count++
      if (m.createdAt > cur.latest.createdAt || (m.createdAt === cur.latest.createdAt && m.updatedAt >= cur.latest.updatedAt)) cur.latest = m
    }
  }
  return [...byPair].map(([id, { latest, count }]) => ({
    id, from: latest.from, to: latest.to, state: latest.state, at: latest.updatedAt, count,
  }))
}

/** 두 에이전트 사이에 오간 메시지 — 양방향, 최신 먼저(같은 시각이면 나중에 바뀐 것 먼저), 버린 것도 넣는다 */
export function pairMessages(a: AgentId, b: AgentId, messages: RelayMessage[]): RelayMessage[] {
  return messages
    .filter(m => (m.from === a && m.to === b) || (m.from === b && m.to === a))
    .sort((x, y) => y.createdAt - x.createdAt || y.updatedAt - x.updatedAt)
}

export function label(edge: EdgeView, now: number): string {
  switch (edge.state) {
    case 'delivered': {
      const sec = (now - edge.at) / 1000
      return sec < 60 ? '전달됨 · 방금' : `전달됨 · ${Math.floor(sec / 60)}분 전`
    }
    case 'pending':
    case 'held':
    case 'queued': return MESSAGE_WORD[edge.state]
    default: return ''
  }
}
