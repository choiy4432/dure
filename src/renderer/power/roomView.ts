// 파워 모드가 그릴 방 — 굳힌 방의 진짜 에이전트, 없으면 가짜 다섯.
import type { UiState } from '../state/store'
import { displayStatus } from '../state/selectors'
import type { PowerAgent } from './events'
import { AGENT_COLORS, FAKE_ROOM, fakeAgents } from './fakeWorld'

/** awaiting: 진짜 승인·질문 기다림 · working: 진짜로 일하는 중(기다림 빼고) — 가짜 방은 둘 다 비었다 */
export function roomView(s: UiState): { roomName: string; agents: PowerAgent[]; awaiting: Set<string>; working: Set<string>; subagents: number } {
  const room = s.power.roomId ? s.rooms.find(r => r.id === s.power.roomId) : undefined
  const real = room ? s.agents.filter(a => a.roomId === room.id) : []
  if (!room || real.length === 0) return { roomName: FAKE_ROOM, agents: fakeAgents(), awaiting: new Set(), working: new Set(), subagents: 0 }
  const shown = real.map(a => [a.id, displayStatus(a, s.requests)] as const)
  return {
    roomName: room.name,
    agents: real.map((a, i) => ({ id: a.id, name: a.name, role: a.role, color: AGENT_COLORS[i % AGENT_COLORS.length], real: true })),
    awaiting: new Set(shown.filter(([, st]) => st === 'awaiting').map(([id]) => id)),
    working: new Set(shown.filter(([, st]) => st === 'working').map(([id]) => id)),
    subagents: real.reduce((n, a) => n + a.subagentsRunning.length, 0),
  }
}
