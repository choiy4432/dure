import type { SetupState } from '../../shared/appTypes'
import type { AgentId, MessageState, PendingRequest, RelayMessage, RemoteIssue, Room, RoomId } from '../../engine/types'
import type { AgentView } from '../../shared/ipcContract'
import { remoteIssueText } from '../../shared/remoteTexts'
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

/** 다시 켜면 멈출 에이전트 수 — 모든 방에서 작업 중·승인 기다림(업데이트 토스트·설정의 노란 줄) */
export function workingCount(agents: Pick<AgentView, 'status'>[]): number {
  return agents.filter(a => a.status === 'working' || a.status === 'awaiting').length
}

/**
 * 패널 밖(관계도 카드·방 목록·창 주의)에서 '오류'처럼 보일 서버 문제(끊김·로그인 만료 …) — 엔진 상태는 쉬는 중 그대로라 화면이 정한다.
 * 일하는 중·승인 기다림이면 그 모습이 먼저(로그인 만료는 다음 정상 답까지 남는다)
 */
export function shownIssue(agent: AgentView, requests: PendingRequest[]): RemoteIssue | null {
  if (!agent.remoteIssue) return null
  const s = displayStatus(agent, requests)
  return s === 'working' || s === 'awaiting' ? null : agent.remoteIssue
}

/** 그 문제의 한 줄(패널 안내 띠·엔진 알림 줄과 같은 글) — 보일 문제가 없거나 서버 방이 아니면 null */
export function issueLine(agent: AgentView, requests: PendingRequest[], rooms: Room[]): string | null {
  const issue = shownIssue(agent, requests)
  const host = issue && rooms.find(r => r.id === agent.roomId)?.remote?.host
  return issue && host ? remoteIssueText(host, issue) : null
}

/** 잠듦 모습 — 엔진 상태는 쉬는 중 그대로라 화면이 정한다. 깨우는 중은 작업 중일 때만, 잠듦은 쉬는·멈춤일 때만 */
export function sleepLook(agent: AgentView, status: DisplayStatus): 'asleep' | 'waking' | null {
  if (agent.waking && status === 'working') return 'waking'
  if (agent.asleep && (status === 'idle' || status === 'stopped')) return 'asleep'
  return null
}

/**
 * 쉬는 상태 위에 덧씌우는 모습 — 잠듦·깨우는 중(sleepLook), 아니면 뒤에서 명령이 돎(쉬는·멈춤일 때만 — 차례는 끝났지만 명령은 돈다).
 * '쉬는 중'만 보이면 뒤에서 일하는 에이전트가 손을 놓은 것처럼 헷갈렸다(2026-11-06 사용자)
 */
export function restLook(agent: AgentView, status: DisplayStatus): 'asleep' | 'waking' | 'background' | null {
  const sleep = sleepLook(agent, status)
  if (sleep) return sleep
  if (agent.background && (status === 'idle' || status === 'stopped')) return 'background'
  return null
}

export function unreadFor(agentId: AgentId, messages: RelayMessage[]): number {
  return messages.filter(m => m.to === agentId && isUnread(m)).length
}

/** 이 에이전트가 주고받은 메시지(받은 것 + 보낸 것) — 패널 메시지 탭. 새것부터(보낸 때) */
export function messagesOf(agentId: AgentId, messages: RelayMessage[]): RelayMessage[] {
  return messages.filter(m => m.from === agentId || m.to === agentId).sort((a, b) => b.createdAt - a.createdAt)
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

const NEED_INSTALL: SetupState = { phase: 'needs', install: { state: 'todo' }, login: { state: 'locked' } }

/**
 * 화면이 따르는 준비 상태 — 상태를 못 받았으면(loadFailed) claude 가 없을 때만 준비 화면, 아니면 준비됨.
 * 준비됐다는데 스냅샷은 claude 가 없다고 하면(설치·다시 켠 직후) 준비 화면 — 없는 claude 로 지도를 열지 않는다.
 */
export function effectiveSetup(setup: SetupState, claudeMissing: boolean, loadFailed: boolean): SetupState {
  if (loadFailed && setup.phase === 'checking') return claudeMissing ? NEED_INSTALL : { phase: 'ready' }
  if (setup.phase === 'ready' && claudeMissing) return NEED_INSTALL
  return setup
}
