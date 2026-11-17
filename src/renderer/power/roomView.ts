// 파워 모드가 그릴 방 — 앱의 지금 방을 따르는 파워 모드의 방(스토어가 방을 옮긴 순간 굳힌 진짜 에이전트, 0명일 수 있다). 지어낸 방·에이전트는 없다.
import type { AgentId, HistoryItem, RoomId } from '../../engine/types'
import type { UiState } from '../state/store'
import { displayStatus } from '../state/selectors'
import { oneLine, type AgentState, type PowerAgent } from './events'
import { TEXT_MAX } from './tap'

/** 에이전트 색 — 그 방으로 굳힌 차례대로 돌려 쓴다(중간에 누가 지워져도 남은 에이전트의 색은 그대로) */
export const AGENT_COLORS: string[] = ['#60A5FA', '#34D399', '#FBBF24', '#C4B5FD', '#67E8F9']

export type PowerView = {
  /** 파워 모드의 방(= 앱의 방) — 없으면(방이 하나도 없다 · 꺼짐) null */
  roomId: RoomId | null
  roomName: string | null
  agents: PowerAgent[]
  state: Record<AgentId, AgentState>
  /** 지금 도는 진짜 서브에이전트 — 이름은 맡긴 일의 설명(모르면 '서브에이전트') */
  subagents: { agentId: AgentId; label: string }[]
}

/** 설명을 모르는 서브에이전트의 이름 */
const SUB_FALLBACK = '서브에이전트'

const EMPTY: PowerView = { roomId: null, roomName: null, agents: [], state: {}, subagents: [] }

/** 서브에이전트의 설명 — 불러온 기록의 시작 기록, 없으면 맡긴 Agent 도구 입력의 description(서브에이전트 나무와 같은 셈) */
function subagentLabel(items: HistoryItem[] | undefined, toolUseId: string): string | null {
  if (!items) return null
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i]
    if (it.kind === 'subagent-start' && it.toolUseId === toolUseId && it.description) return it.description
    if (it.kind === 'assistant')
      for (const b of it.blocks) {
        if (b.type !== 'tool_use' || b.id !== toolUseId) continue
        const d = b.input && typeof b.input === 'object' ? (b.input as Record<string, unknown>).description : null
        return typeof d === 'string' && d ? d : null
      }
  }
  return null
}

const stateOf = (s: ReturnType<typeof displayStatus>): AgentState => (s === 'awaiting' ? 'awaiting' : s === 'working' ? 'working' : 'resting')

/**
 * 파워 모드가 그리는 에이전트인가 — 그 방으로 굳힌 목록에 있고 지금도 굳힌 방에 있으면 그 에이전트(굳힌 뒤 들어왔거나 옮겼거나 지워졌으면 없다).
 * 듣기(스토어의 사건 거르기)와 그릴 방(roomView)이 같이 쓴다
 */
export function pinnedAgent<A extends { id: string; roomId: string }>(power: { roomId: string | null; agentIds: readonly string[] }, agents: readonly A[], id: string): A | undefined {
  if (!power.roomId || !power.agentIds.includes(id)) return undefined
  return agents.find(a => a.id === id && a.roomId === power.roomId)
}

export function roomView(s: UiState): PowerView {
  const room = s.power.roomId ? s.rooms.find(r => r.id === s.power.roomId) : undefined
  if (!room) return EMPTY
  const agents: PowerAgent[] = []
  const state: PowerView['state'] = {}
  const subagents: PowerView['subagents'] = []
  s.power.agentIds.forEach((id, i) => {
    const a = pinnedAgent(s.power, s.agents, id)
    if (!a) return // 굳힌 뒤 지워졌거나 옮겼다
    agents.push({ id: a.id, name: a.name, role: a.role, color: AGENT_COLORS[i % AGENT_COLORS.length] })
    state[a.id] = stateOf(displayStatus(a, s.requests))
    for (const t of a.subagentsRunning) {
      const label = subagentLabel(s.history[a.id], t)
      // 설명을 모르면 그냥 '서브에이전트' — 차례 번호를 붙이면 앞의 것이 끝날 때 남은 위성 이름이 밀린다
      subagents.push({ agentId: a.id, label: label ? oneLine(label, TEXT_MAX) : SUB_FALLBACK })
    }
  })
  return { roomId: room.id, roomName: room.name, agents, state, subagents }
}
