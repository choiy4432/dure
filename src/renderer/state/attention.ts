import type { PendingRequest, RelayMessage, RoomId } from '../../engine/types'
import type { AgentView } from '../../shared/ipcContract'

// 순수 모듈 — 화면·스토어를 import 하지 않는다(여러 화면이 같은 수를 쓰도록)

export interface RoomTodo { asks: number; messages: number; held: number }
export interface TodoCounts { total: number; asksTotal: number; rooms: Record<RoomId, RoomTodo> }

/** 한 방의 할 일 합 — 방에 아무것도 없으면 칸 자체가 없으니 undefined 도 0 */
export const roomTotal = (t: RoomTodo | undefined): number => (t ? t.asks + t.messages + t.held : 0)

/**
 * 내가 처리해야 할 일의 수. '새 결과'는 확인하면 사라지는 알림이라 세지 않는다.
 * 에이전트가 이미 없는 요청·메시지는 누를 곳이 없어 세지 않는다(숫자만 남는 유령 방지).
 * held 는 개수가 아니라 방당 1 — 한 번에 풀어 주는 묶음이다.
 */
export function todoCounts(s: { agents: AgentView[]; requests: PendingRequest[]; messages: RelayMessage[] }): TodoCounts {
  const roomOf = new Map(s.agents.map(a => [a.id, a.roomId]))
  const rooms: Record<RoomId, RoomTodo> = {}
  const slot = (r: RoomId) => (rooms[r] ??= { asks: 0, messages: 0, held: 0 })
  for (const q of s.requests) {
    const r = roomOf.get(q.agentId)
    if (r !== undefined) slot(r).asks++
  }
  for (const m of s.messages) {
    if (!roomOf.has(m.to)) continue
    if (m.state === 'pending') slot(m.roomId).messages++
    else if (m.state === 'held') slot(m.roomId).held = 1
  }
  let total = 0
  let asksTotal = 0
  for (const t of Object.values(rooms)) {
    total += roomTotal(t)
    asksTotal += t.asks
  }
  return { total, asksTotal, rooms }
}
