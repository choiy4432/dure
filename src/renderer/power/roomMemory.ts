// 방별 화면 상태 — 숫자 띠의 셈 · 실시간 기록 줄 · 터미널 창 줄. 방마다 하나, 파워 모드 덮개(PowerLayer)가 떠 있는 동안 메모리에만 둔다
// (저장하지 않는다). 덮개가 내려가면(파워 모드를 끄면) 전부 버린다. 보지 않는 방의 사건은 듣지 않으므로(스토어가 지금 방 것만 넘긴다)
// 그 방으로 돌아오면 떠날 때 값에서 이어진다. 화면(관제실·터미널 벽)은 지금 방의 것을 읽고 고친다.
import { createContext, useContext, useRef } from 'react'
import type { AgentId, RoomId } from '../../engine/types'
import { createStats, type Stats } from './stats'
import type { Line } from './terminal/lines'

/** 실시간 기록 한 줄 — 새 것이 맨 앞 */
export type LogRow = { id: number; time: string; name: string; color: string; tp: string; tg: string }

export type RoomMemory = {
  stats: Stats
  /** 실시간 기록 줄(새 것이 맨 앞) — 기록이 새 배열로 갈아 끼운다 */
  log: LogRow[]
  /** 터미널 창 줄 — 에이전트마다 마지막 줄들(창 줄 상자가 그대로 쥐고 고친다) */
  term: Map<AgentId, Line[]>
}

/** 방마다 하나씩, 처음 부를 때 만든다 — 방이 없을 때(null)도 제 몫이 있다 */
export function createRoomMemories() {
  const rooms = new Map<RoomId | null, RoomMemory>()
  return {
    get(roomId: RoomId | null): RoomMemory {
      let m = rooms.get(roomId)
      if (!m) {
        m = { stats: createStats(), log: [], term: new Map() }
        rooms.set(roomId, m)
      }
      return m
    },
  }
}
export type RoomMemories = ReturnType<typeof createRoomMemories>

/** 덮개가 주는 방별 화면 상태 — 덮개 밖(화면만 따로 그린 시험)이면 없다: 그때는 화면이 제 수명 동안 따로 쥔다 */
export const RoomMemoryContext = createContext<RoomMemories | null>(null)

/** 그 방의 화면 상태 — 같은 방이면 늘 같은 객체 */
export function useRoomMemory(roomId: RoomId | null): RoomMemory {
  const shared = useContext(RoomMemoryContext)
  const own = useRef<RoomMemories | null>(null)
  if (!shared) own.current ??= createRoomMemories()
  return (shared ?? own.current!).get(roomId)
}
