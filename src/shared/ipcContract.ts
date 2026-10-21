import type {
  Agent, AgentDescription, AgentId, EffortLevel, EngineEventMap, AgentStatus, Decision, HistoryItem, PendingRequest, PlanUsage, RelayMessage, Room, RoomId, UserPart,
} from '../engine/types'

export interface AgentView extends Agent {
  status: AgentStatus
  errorText: string | null
  /** 지금 묻지 않고 실행하는가(두레 스위치 또는 Claude 설정) */
  bypass: boolean
  /** 묻지 않음이 내 Claude 설정 때문인가 — 그러면 두레 스위치로 끌 수 없다 */
  bypassBySettings: boolean
  /** 켜려고 그 차례 뒤의 다시 띄우기를 기다리는 중(허용 전에 띄운 세션) — 실제 모드는 아직 그대로, 스위치는 바뀌는 중 */
  bypassPending: boolean
  heldInput: number
  /** Claude 에게 마지막으로 읽은 지금 effort — 모르면 null */
  effortNow: EffortLevel | null
  /** 차례의 init 에서 읽은, 지금 실제로 쓰는 모델 id(예: claude-opus-5-5) — 모르면 null */
  modelNow: string | null
  /** 도는 서브에이전트 — 부모의 Agent tool_use id, 시작 순(이어서 'subagents' 사건) */
  subagentsRunning: string[]
}

export interface Snapshot {
  claudeMissing: boolean
  rooms: Room[]
  agents: AgentView[]
  messages: RelayMessage[]
  requests: PendingRequest[]
  autoChainLimit: number
  /** 묻지 않고 실행 허용 — 꺼져 있으면 에이전트 스위치를 못 켠다 */
  allowBypass: boolean
  /** 플랜 사용량 — claude 가 없거나 아직 모르면 null */
  usage: PlanUsage | null
}

export interface DureApi {
  snapshot(): Promise<Snapshot>
  addRoom(name: string): Promise<Room>
  renameRoom(id: RoomId, name: string): Promise<Room>
  removeRoom(id: RoomId): Promise<void>
  addAgent(i: { roomId: RoomId; name: string; role: string; folder: string }): Promise<Agent>
  updateAgent(
    id: AgentId,
    p: { name?: string; role?: string; auto?: boolean; pos?: { x: number; y: number }; bypassNoticeClosed?: boolean },
  ): Promise<Agent>
  removeAgent(id: AgentId): Promise<void>
  sendUser(id: AgentId, parts: UserPart[]): Promise<void>
  interrupt(id: AgentId): Promise<void>
  newConversation(id: AgentId): Promise<void>
  setModel(id: AgentId, model: string | null): Promise<void>
  setEffort(id: AgentId, level: EffortLevel): Promise<void>
  refreshUsage(): Promise<void>
  describe(id: AgentId): Promise<AgentDescription>
  history(id: AgentId, o?: { all?: boolean }): Promise<HistoryItem[]>
  approveMessage(id: string): Promise<void>
  dismissMessage(id: string): Promise<void>
  continueHeld(roomId: RoomId): Promise<void>
  answerRequest(id: string, d: Decision): Promise<void>
  setAutoChainLimit(n: number): Promise<void>
  setAllowBypass(on: boolean): Promise<void>
  setBypass(id: AgentId, on: boolean): Promise<void>
  pickFolder(): Promise<string | null>
  openFolder(path: string): Promise<void>
  /** 해제 함수를 돌려준다 */
  on<K extends keyof EngineEventMap>(k: K, fn: (p: EngineEventMap[K]) => void): () => void
}

export const CHANNEL = { invoke: 'dure:invoke', event: 'dure:event' } as const

/** invoke 로 부를 수 있는 이름 — DureApi 의 메서드 중 on 만 빠진다(on 은 preload 안에서 처리) */
export const METHODS = [
  'snapshot', 'addRoom', 'renameRoom', 'removeRoom', 'addAgent', 'updateAgent', 'removeAgent',
  'sendUser', 'interrupt', 'newConversation', 'setModel', 'setEffort', 'refreshUsage', 'describe', 'history',
  'approveMessage', 'dismissMessage', 'continueHeld', 'answerRequest', 'setAutoChainLimit',
  'setAllowBypass', 'setBypass',
  'pickFolder', 'openFolder',
] as const satisfies readonly Exclude<keyof DureApi, 'on'>[]

/** 엔진 이벤트 전부 — 새 이벤트를 EngineEventMap 에 더하면 여기서 타입 오류가 난다 */
const EVENT_FLAGS: Record<keyof EngineEventMap, true> = {
  'agent-event': true, status: true, message: true, held: true, request: true,
  'request-resolved': true, flags: true, 'engine-error': true, history: true, 'held-input': true,
  usage: true, context: true, effort: true, 'model-now': true, subagents: true,
}
export const EVENT_NAMES = Object.keys(EVENT_FLAGS) as (keyof EngineEventMap)[]

export type InvokeRequest = { method: string; args: unknown[] }
export type InvokeResult = { ok: true; value: unknown } | { ok: false; error: string }
export type EventEnvelope = { name: keyof EngineEventMap; payload: unknown }

export const CLAUDE_MISSING_ERROR = 'claude 를 찾을 수 없어요'
