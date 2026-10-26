import type { AgentId, MessageState, PendingRequest, RelayMessage, RoomId } from '../../engine/types'
import type { AgentView } from '../../shared/ipcContract'
import { MESSAGE_WORD } from '../lib/words'

export type DisplayStatus = 'working' | 'awaiting' | 'idle' | 'error' | 'stopped'
/** 차례의 단계 — 생각·글이 오기 전 무엇을 기다리는지(store.phase) */
export type Phase = 'preparing' | 'requesting' | 'compacting'

/** 관계도 선 보기 — recent = 할 일 있는 선 + 24시간 안에 전달된 선(기본) · all = 오래된 것도 옅게 · off = 그리지 않음 */
export type EdgeMode = 'recent' | 'all' | 'off'
/** 선 나이 — live = 할 일 있음(늘 진하게 + 알약) · recent = 30분 안에 전달 · old = 그보다 오래(알약 없이 옅게) */
export type EdgeAge = 'live' | 'recent' | 'old'
/** 전달된 선이 알약을 단 채 남는 시간 */
export const EDGE_RECENT_MS = 30 * 60_000
/** '최근' 보기에서 전달된 선이 남는 시간 — 지나면 그리지 않는다(내역은 메시지 탭·쌍 메시지 창) */
export const EDGE_KEEP_MS = 24 * 3_600_000

/**
 * 관계도 선 한 줄 — 보낸 쪽 → 받는 쪽 방향마다 하나(반대 방향은 따로 그리고 서로 비킨다).
 * 알약·선 모양은 그 방향의 대표 메시지(할 일이 있으면 그것, 없으면 가장 최근 전달)의 상태·바뀐 시각.
 */
export interface EdgeView {
  /** '보낸>받는' — 스토어의 lastDelivered 열쇠와 같다 */
  id: string
  from: AgentId
  to: AgentId
  state: MessageState
  at: number
  count: number
  age: EdgeAge
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

/** 이 에이전트가 주고받은 메시지(받은 것 + 보낸 것) — 패널 메시지 탭. 새것부터(보낸 때) */
export function messagesOf(agentId: AgentId, messages: RelayMessage[]): RelayMessage[] {
  return messages.filter(m => m.from === agentId || m.to === agentId).sort((a, b) => b.createdAt - a.createdAt)
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

/** 할 일 있는 상태의 급한 차례 — 낮을수록 먼저 알약에 */
const ACTION_RANK: Partial<Record<MessageState, number>> = { pending: 0, held: 1, queued: 2 }

/**
 * 방의 관계도 선 — 방향마다 하나. 버린 메시지와 지워진 에이전트가 낀 메시지는 빼고, '최근' 보기에선 24시간이 지난 전달도 뺀다(수에도 안 센다).
 * 대표 = 할 일(내 확인 필요 → 자동 멈춤 → 끝나면 전달, 같으면 나중에 보낸 것), 없으면 가장 최근 전달.
 */
export function edges(roomId: RoomId, agents: AgentView[], messages: RelayMessage[], o: { now: number; mode: EdgeMode }): EdgeView[] {
  if (o.mode === 'off') return []
  const alive = new Set(agents.filter(a => a.roomId === roomId).map(a => a.id))
  const newer = (x: RelayMessage, y: RelayMessage) => x.createdAt > y.createdAt || (x.createdAt === y.createdAt && x.updatedAt >= y.updatedAt)
  const better = (x: RelayMessage, y: RelayMessage) => {
    const rx = ACTION_RANK[x.state] ?? 9
    const ry = ACTION_RANK[y.state] ?? 9
    return rx !== ry ? rx < ry : newer(x, y)
  }
  const byPair = new Map<string, { rep: RelayMessage; count: number }>()
  for (const m of messages) {
    if (m.roomId !== roomId || m.state === 'dismissed') continue
    if (!alive.has(m.from) || !alive.has(m.to)) continue
    if (o.mode === 'recent' && m.state === 'delivered' && o.now - m.updatedAt >= EDGE_KEEP_MS) continue
    const id = `${m.from}>${m.to}`
    const cur = byPair.get(id)
    if (!cur) byPair.set(id, { rep: m, count: 1 })
    else {
      cur.count++
      if (better(m, cur.rep)) cur.rep = m
    }
  }
  return [...byPair].map(([id, { rep, count }]) => ({
    id, from: rep.from, to: rep.to, state: rep.state, at: rep.updatedAt, count,
    age: rep.state !== 'delivered' ? 'live' : o.now - rep.updatedAt < EDGE_RECENT_MS ? 'recent' : 'old',
  }))
}

/** 두 에이전트 사이에 오간 메시지 — 양방향, 최신 먼저(같은 시각이면 나중에 바뀐 것 먼저), 버린 것도 넣는다 */
export function pairMessages(a: AgentId, b: AgentId, messages: RelayMessage[]): RelayMessage[] {
  return messages
    .filter(m => (m.from === a && m.to === b) || (m.from === b && m.to === a))
    .sort((x, y) => y.createdAt - x.createdAt || y.updatedAt - x.updatedAt)
}

export function label(edge: Pick<EdgeView, 'state' | 'at'>, now: number): string {
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
