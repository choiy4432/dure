import type { AgentId, MessageState, PendingRequest, RelayMessage, RoomId } from '../../engine/types'
import type { AgentView } from '../../shared/ipcContract'

export type DisplayStatus = 'working' | 'awaiting' | 'idle' | 'error' | 'stopped'

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

/** 이 에이전트가 마지막으로 받은 전달 시각 — lastDelivered 의 '보낸>받는' 칸 중 받는 쪽이 그 에이전트인 것 */
export function deliveredTo(agentId: AgentId, lastDelivered: Record<string, number>): number | undefined {
  let at: number | undefined
  for (const [key, t] of Object.entries(lastDelivered)) {
    if (key.slice(key.indexOf('>') + 1) === agentId && (at === undefined || t > at)) at = t
  }
  return at
}

export function summary(state: SummaryInput, roomId: RoomId): { working: number; awaiting: number; unread: number } {
  let working = 0
  let awaiting = 0
  for (const a of state.agents) {
    if (a.roomId !== roomId) continue
    const s = displayStatus(a, state.requests)
    if (s === 'working') working++
    else if (s === 'awaiting') awaiting++
  }
  const unread = state.messages.filter(m => m.roomId === roomId && isUnread(m)).length
  return { working, awaiting, unread }
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
    case 'pending': return '확인 대기'
    case 'held': return '상한 대기'
    case 'queued': return '작업 끝 대기'
    default: return ''
  }
}
