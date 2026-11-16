// 파워 모드가 그릴 방 — 켠 순간 굳힌 방의 진짜 에이전트(0명일 수 있다). 지어낸 방·에이전트는 없다.
import type { AgentId, HistoryItem } from '../../engine/types'
import type { UiState } from '../state/store'
import { displayStatus } from '../state/selectors'
import { oneLine, type AgentState, type PowerAgent } from './events'
import { TEXT_MAX } from './tap'

/** 에이전트 색 — 켤 때 굳힌 차례대로 돌려 쓴다(중간에 누가 지워져도 남은 에이전트의 색은 그대로) */
export const AGENT_COLORS: string[] = ['#60A5FA', '#34D399', '#FBBF24', '#C4B5FD', '#67E8F9']

export type PowerView = {
  roomName: string | null
  agents: PowerAgent[]
  state: Record<AgentId, AgentState>
  /** 지금 도는 진짜 서브에이전트 — 이름은 맡긴 일의 설명(모르면 '서브 N') */
  subagents: { agentId: AgentId; label: string }[]
}

const EMPTY: PowerView = { roomName: null, agents: [], state: {}, subagents: [] }

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

export function roomView(s: UiState): PowerView {
  const room = s.power.roomId ? s.rooms.find(r => r.id === s.power.roomId) : undefined
  if (!room) return EMPTY
  const agents: PowerAgent[] = []
  const state: PowerView['state'] = {}
  const subagents: PowerView['subagents'] = []
  s.power.agentIds.forEach((id, i) => {
    const a = s.agents.find(x => x.id === id && x.roomId === room.id)
    if (!a) return // 켠 뒤 지워졌다
    agents.push({ id: a.id, name: a.name, role: a.role, color: AGENT_COLORS[i % AGENT_COLORS.length] })
    state[a.id] = stateOf(displayStatus(a, s.requests))
    for (const t of a.subagentsRunning) {
      const label = subagentLabel(s.history[a.id], t)
      subagents.push({ agentId: a.id, label: label ? oneLine(label, TEXT_MAX) : `서브 ${subagents.length + 1}` })
    }
  })
  return { roomName: room.name, agents, state, subagents }
}
