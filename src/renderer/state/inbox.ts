import type { AgentId, PendingRequest, RelayMessage, RoomId } from '../../engine/types'
import type { AgentView } from '../../shared/ipcContract'
import { roomTotal, todoCounts } from './attention'
import { displayStatus } from './selectors'

// 순수 모듈 — '내가 할 일' 목록의 재료. 화면·스토어를 import 하지 않는다

export interface InboxView {
  asks: PendingRequest[]
  messages: RelayMessage[]
  held: boolean
  fresh: { agentId: AgentId; at: number }[]
  running: AgentId[]
  otherRooms: number
}

export function inboxView(
  s: { agents: AgentView[]; requests: PendingRequest[]; messages: RelayMessage[]; fresh: Record<AgentId, number> },
  roomId: RoomId,
): InboxView {
  const here = s.agents.filter(a => a.roomId === roomId)
  const ids = new Set(here.map(a => a.id))
  const asks = s.requests.filter(q => ids.has(q.agentId)).sort((x, y) => x.createdAt - y.createdAt)
  const messages = s.messages.filter(m => m.roomId === roomId && m.state === 'pending' && ids.has(m.to)).sort((x, y) => x.createdAt - y.createdAt)
  const held = s.messages.some(m => m.roomId === roomId && m.state === 'held' && ids.has(m.to))
  // 작업 중이거나 승인을 기다리는 에이전트의 결과는 아직 끝난 게 아니라 '새 결과'로 보여 주지 않는다
  const fresh = here
    .filter(a => s.fresh[a.id] !== undefined && !['working', 'awaiting'].includes(displayStatus(a, s.requests)))
    .map(a => ({ agentId: a.id, at: s.fresh[a.id] }))
    .sort((x, y) => x.at - y.at)
  const running = here.filter(a => displayStatus(a, s.requests) === 'working').map(a => a.id)
  const t = todoCounts(s)
  return { asks, messages, held, fresh, running, otherRooms: t.total - roomTotal(t.rooms[roomId]) }
}
