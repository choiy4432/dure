import type {
  Agent, AgentDescription, RemoteIssue, RemoteIssueKind, SshHostEntry, AgentId, ConversationSummary, EffortLevel, EngineEventMap, AgentStatus, Hold, NotifyPrefs, Decision, HistoryItem, PendingRequest, PlanUsage, RelayMessage, Room, RoomId, SleepBlock, ThemePref, UserPart,
} from '../engine/types'
import type { AppEventMap, AppInfo, AppPrefs, ClaudeUpdateState, SetupState, UpdateState } from './appTypes'
import type { PhonePairOffer, PhoneSettingsChange, PhoneState, TailscaleState } from './phoneTypes'

/** 창이 받는 사건 전부 — 엔진 사건 + 앱 사건(이름이 겹치면 아래 NO_CLASH 에서 타입 오류) */
export type DureEventMap = EngineEventMap & AppEventMap

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
  /** 계획 모드 중인가 */
  planMode: boolean
  /** 재워져(또는 막 켜서) 살아 있는 claude 가 없는가 — 'sleep' 사건이 바꾼다 */
  asleep: boolean
  /** 재운 에이전트를 깨우는 중인가 */
  waking: boolean
  /** 뒤에서 명령이 도는가(서브에이전트 말고) — 'background' 사건이 바꾼다. 쉬는 중이면 화면은 '뒤에서 명령 도는 중'. 없으면 안 돎 */
  background?: boolean
  /** 붙잡힌 입력 — 없으면 null */
  hold: Hold | null
  /** Claude 에게 마지막으로 읽은 지금 effort — 모르면 null */
  effortNow: EffortLevel | null
  /** 차례의 init 에서 읽은, 지금 실제로 쓰는 모델 id(예: claude-opus-5-5) — 모르면 null */
  modelNow: string | null
  /** 도는 서브에이전트 — 부모의 Agent tool_use id, 시작 순(이어서 'subagents' 사건) */
  subagentsRunning: string[]
  /** 지난 대화 수 — 지금 대화는 빼고 */
  pastCount: number
  /** 서버 방 에이전트의 지금 서버 문제 — 없으면 null('status' 사건이 바꾼다) */
  remoteIssue: RemoteIssue | null
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
  /** Windows 알림 설정 — claude 가 없으면 기본값 */
  notify: NotifyPrefs
  /** 화면 테마 — claude 가 없으면 Windows 따라감. 옛 main 이 보내지 않으면 없다(Windows 따라감으로 친다) */
  theme?: ThemePref
  /** 쉬는 에이전트를 재우기까지의 시간(분, 0 = 끔) — claude 가 없으면 기본값 */
  sleepAfterMin: number
  /** 플랜 사용량 — claude 가 없거나 아직 모르면 null */
  usage: PlanUsage | null
}

export interface DureApi {
  snapshot(): Promise<Snapshot>
  /** remote 가 있으면 서버(SSH) 방 */
  addRoom(name: string, remote?: { host: string } | null): Promise<Room>
  /** 이 PC 에 ssh 가 있는가 */
  sshAvailable(): Promise<boolean>
  /** ~/.ssh/config 의 서버 목록(읽기만) */
  sshHosts(): Promise<SshHostEntry[]>
  /** 그 서버에 접속되고 claude 가 있는지 */
  checkRemote(host: string): Promise<{ ok: true; claudeVersion: string } | { ok: false; kind: RemoteIssueKind; detail: string | null }>
  /** 서버 방의 그 폴더가 서버에 있는지 */
  checkRemoteFolder(roomId: RoomId, folder: string): Promise<{ ok: true; folder: string; claudeVersion: string } | { ok: false; kind: RemoteIssueKind; detail: string | null }>
  renameRoom(id: RoomId, name: string): Promise<Room>
  removeRoom(id: RoomId): Promise<void>
  addAgent(i: { roomId: RoomId; name: string; role: string; folder: string }): Promise<Agent>
  updateAgent(
    id: AgentId,
    p: { name?: string; role?: string; auto?: boolean; pos?: { x: number; y: number }; bypassNoticeClosed?: boolean },
  ): Promise<Agent>
  removeAgent(id: AgentId): Promise<void>
  /** 화면에서 고른 에이전트(없으면 null) — 엔진이 claude 를 미리 띄운다 */
  setSelected(id: AgentId | null): Promise<void>
  sendUser(id: AgentId, parts: UserPart[], o?: { plan?: boolean }): Promise<void>
  setPlanMode(id: AgentId, on: boolean): Promise<void>
  /** 붙잡힌 입력을 이어서 보낸다 */
  resumeHold(id: AgentId): Promise<void>
  dropHoldItem(id: AgentId, itemId: string): Promise<void>
  dropHold(id: AgentId): Promise<void>
  /** 늘 허용에서 그 도구를 뺀다 */
  revokeAlwaysAllow(id: AgentId, toolName: string): Promise<Agent>
  interrupt(id: AgentId): Promise<void>
  newConversation(id: AgentId): Promise<void>
  setModel(id: AgentId, model: string | null): Promise<void>
  setEffort(id: AgentId, level: EffortLevel): Promise<void>
  refreshUsage(): Promise<void>
  describe(id: AgentId): Promise<AgentDescription>
  /** all: 지난 대화까지 · limit: 마지막 N 개(기본 500, Infinity = 전부 — 내보내기) */
  history(id: AgentId, o?: { all?: boolean; limit?: number }): Promise<HistoryItem[]>
  /** 지난 대화 목록(새것부터, 지금 대화 포함) */
  conversations(id: AgentId): Promise<ConversationSummary[]>
  /** 지난 대화 한 편 읽기 — limit: 마지막 N 개 */
  conversation(id: AgentId, key: string, o?: { limit?: number }): Promise<HistoryItem[]>
  /** 그 지난 대화로 돌아간다 */
  resumeConversation(id: AgentId, key: string): Promise<void>
  /** 그 지난 대화에서 새 에이전트를 갈라 만든다 */
  forkAgent(i: { from: AgentId; key: string; name: string; role: string }): Promise<Agent>
  /** 보낸 그림(기록의 image file) — data URL, 없으면 null */
  image(id: AgentId, file: string): Promise<string | null>
  /**
   * 보낸 첨부(기록의 file part 의 file — 사본 이름)를 기본 앱으로 연다. 그 에이전트의 첨부 폴더 안 사본만(서버 방도 이 PC 사본) —
   * 이름이 틀리거나 폴더 밖·없으면 '첨부 파일을 찾을 수 없어요', 열지 못하면 '첨부 파일을 열지 못했어요'. claude 를 띄우지 않는다
   */
  openAttachment(agentId: AgentId, file: string): Promise<void>
  approveMessage(id: string): Promise<void>
  dismissMessage(id: string): Promise<void>
  continueHeld(roomId: RoomId): Promise<void>
  answerRequest(id: string, d: Decision): Promise<void>
  setAutoChainLimit(n: number): Promise<void>
  setAllowBypass(on: boolean): Promise<void>
  setNotify(p: Partial<NotifyPrefs>): Promise<void>
  /** 화면 테마 저장 + 창에 바로 적용(설정 창이 누르는 즉시 부른다) */
  setTheme(t: ThemePref): Promise<void>
  setBypass(id: AgentId, on: boolean): Promise<void>
  /** 에이전트를 재운다 — 재웠으면 true(못 재우는 까닭은 sleepBlock) */
  sleep(id: AgentId): Promise<boolean>
  /** 그 방에서 재울 수 있는 에이전트를 모두 재운다 — 재운 수 */
  sleepRoom(roomId: RoomId): Promise<number>
  /** 지금 못 재우는 까닭 — 재울 수 있으면 null */
  sleepBlock(id: AgentId): Promise<SleepBlock | 'no-session' | null>
  /** 그 방에서 지금 재울 수 있는 에이전트 수 */
  sleepableIn(roomId: RoomId): Promise<number>
  /** 재우기까지의 시간(분, 0 = 끔) 저장 */
  setSleepAfter(min: number): Promise<void>
  pickFolder(): Promise<string | null>
  /** 그 에이전트의 폴더 열기 — 이 PC 방은 탐색기, 서버 방은 VS Code 원격 창 */
  openAgentFolder(id: AgentId): Promise<void>
  /** 대화 내보내기 — 저장 창(처음 이름 fileName, 문서 폴더)으로 글을 저장한다. 저장한 경로, 취소면 null */
  saveConversation(fileName: string, text: string): Promise<string | null>
  /** 작업표시줄 배지(할 일 개수 + 아이콘 PNG data URL; png 가 null 이거나 count 0 이면 지움) */
  setTaskbar(count: number, png: string | null): Promise<void>
  /** 초점이 없을 때 작업표시줄 단추 깜박임 */
  flashWindow(): Promise<void>
  /** 창을 앞으로 */
  focusWindow(): Promise<void>

  // ── 앱 쪽(APP_METHODS) — 엔진 없이도 된다 ──
  appInfo(): Promise<AppInfo>
  prefs(): Promise<AppPrefs>
  /** 아는 칸의 불리언만 저장 — 바뀐 뒤의 앱 설정 */
  setPrefs(p: Partial<AppPrefs>): Promise<AppPrefs>
  setupState(): Promise<SetupState>
  /** 공식 설치 스크립트로 claude 설치 — 진행은 'setup' 사건으로 */
  installClaude(): Promise<void>
  /** 브라우저 로그인 — 진행은 'setup' 사건으로 */
  loginClaude(): Promise<void>
  /** 직접 설치 안내 페이지 열기 */
  openSetupGuide(): Promise<void>
  claudeUpdateState(): Promise<ClaudeUpdateState>
  updateState(): Promise<UpdateState>
  checkUpdate(): Promise<UpdateState>
  /** 진행은 'update' 사건으로 */
  downloadUpdate(): Promise<void>
  /** 다시 켜서 새 버전으로 */
  installUpdate(): Promise<void>
  openReleasePage(): Promise<void>
  /** 투어 막이 떠 있는 동안 창 단추 띠를 막 색으로 물들인다(Windows 가 웹 화면 위에 그리는 단추는 막이 못 덮는다) */
  setTourVeil(on: boolean): Promise<void>

  // ── 휴대폰으로 쓰기(APP_METHODS — PC 창에서만, PHONE_ACCESS 'pc') · 바뀌면 앱 사건 'phone' ──
  /** 휴대폰 설정·기기·접속 수·Tailscale 상태·주소·지금 짝 맺기(숫자·만료) */
  phoneState(): Promise<PhoneState>
  /** 켜기·끄기·절전 막기·자동 켜기·휴대폰 알림 — 켜기는 Tailscale 이 준비됐을 때만 길을 연다(아니면 켜 둔 채 까닭을 state 에) */
  setPhone(p: PhoneSettingsChange): Promise<void>
  /** Tailscale 상태를 다시 본다 — 켜져 있는데 길이 안 열렸으면 다시 켜 본다(https 가 꺼졌으면 켜기 링크까지) */
  phoneCheck(): Promise<TailscaleState>
  /** 새 짝 코드(QR)·6자리 숫자 — 앞의 것은 무효. 길이 열려 있어야 한다 */
  phonePairStart(): Promise<PhonePairOffer>
  phonePairCancel(): Promise<void>
  /** 그 기기를 끊는다 — 토큰 무효 + 열린 연결 바로 닫기 */
  phoneUnpair(id: string): Promise<void>
  /** 설정의 휴대폰 탭이 '주소가 바뀌었어요' 알림(PhoneState.notice)을 받아 보였다 — main 이 지운다(창은 열린 동안 그대로 보인다) */
  phoneNoticeSeen(): Promise<void>

  /** 해제 함수를 돌려준다 */
  on<K extends keyof DureEventMap>(k: K, fn: (p: DureEventMap[K]) => void): () => void
  /**
   * 사용자가 고르거나 끌어다 놓은 File 의 이 PC 절대 경로(preload 안의 webUtils.getPathForFile — IPC 아님, 동기).
   * 디스크 파일이 아닌 File(코드로 만든 것 등)이면 빈 글. 화면은 이 경로를 sendUser 의 file part 로만 넘긴다(읽지 않는다)
   */
  pathForFile(file: File): string
}

export const CHANNEL = { invoke: 'dure:invoke', event: 'dure:event' } as const

/** preload 안에서 처리해 invoke 로 가지 않는 것 — 사건 받기(on)·File 경로(pathForFile) */
type PreloadOnly = 'on' | 'pathForFile'
/** invoke 로 부르는 메서드 이름 전부 — METHODS[number] | APP_METHODS[number] 와 같다(아래 ALL_COVERED 가 지킨다) */
export type ApiMethod = Exclude<keyof DureApi, PreloadOnly>

/** 앱 쪽 메서드 — 엔진이 없어도(claude 가 없어도)·엔진 시작 전에도 main 의 AppHost 로 간다 */
export const APP_METHODS = [
  'appInfo', 'prefs', 'setPrefs', 'setupState', 'installClaude', 'loginClaude', 'openSetupGuide',
  'claudeUpdateState', 'updateState', 'checkUpdate', 'downloadUpdate', 'installUpdate', 'openReleasePage', 'setTourVeil',
  'phoneState', 'setPhone', 'phoneCheck', 'phonePairStart', 'phonePairCancel', 'phoneUnpair', 'phoneNoticeSeen',
] as const satisfies readonly ApiMethod[]

/** invoke 로 부를 수 있는 엔진 쪽 이름 — DureApi 의 메서드 중 on·pathForFile(preload 안에서 처리)과 APP_METHODS 가 빠진다 */
export const METHODS = [
  'snapshot', 'addRoom', 'sshAvailable', 'sshHosts', 'checkRemote', 'checkRemoteFolder', 'renameRoom', 'removeRoom', 'addAgent', 'updateAgent', 'removeAgent',
  'setSelected', 'sendUser', 'interrupt', 'newConversation', 'setModel', 'setEffort', 'refreshUsage', 'describe', 'history', 'conversations', 'conversation', 'resumeConversation', 'forkAgent', 'image', 'openAttachment',
  'approveMessage', 'dismissMessage', 'continueHeld', 'answerRequest', 'setAutoChainLimit',
  'setAllowBypass', 'setNotify', 'setTheme', 'setBypass',
  'sleep', 'sleepRoom', 'sleepBlock', 'sleepableIn', 'setSleepAfter',
  'setPlanMode', 'resumeHold', 'dropHoldItem', 'dropHold', 'revokeAlwaysAllow',
  'pickFolder', 'openAgentFolder', 'saveConversation', 'setTaskbar', 'flashWindow', 'focusWindow',
] as const satisfies readonly Exclude<ApiMethod, (typeof APP_METHODS)[number]>[]

/** METHODS·APP_METHODS 가 함께 DureApi 의 메서드(on 빼고)를 빠짐없이 덮는다 — 빠지면 여기서 타입 오류(오류에 빠진 이름이 보인다) */
type Uncovered = Exclude<ApiMethod, (typeof METHODS)[number] | (typeof APP_METHODS)[number]>
const ALL_COVERED: [Uncovered] extends [never] ? true : Uncovered = true

/**
 * 엔진 시작(engine.start — 켤 때 claude 최신으로 뒤) 전에도 바로 답하는 엔진 메서드 — 읽기와 창 쪽 일.
 * 그 밖의 엔진 메서드는 main 의 engineReady 가 풀릴 때까지 기다린다(claude 를 띄우는 일이 업데이트와 겹치지 않게)
 */
export const BEFORE_START = [
  'snapshot', 'history', 'conversations', 'conversation', 'image', 'openAttachment', 'sshAvailable', 'sshHosts', 'sleepBlock', 'sleepableIn',
  'pickFolder', 'saveConversation', 'setTaskbar', 'flashWindow', 'focusWindow',
] as const satisfies readonly (typeof METHODS)[number][]

/** 엔진 이벤트 전부 — 새 이벤트를 EngineEventMap 에 더하면 여기서 타입 오류가 난다 */
const EVENT_FLAGS: Record<keyof EngineEventMap, true> = {
  'agent-event': true, status: true, message: true, held: true, request: true,
  'request-resolved': true, flags: true, 'engine-error': true, history: true, 'held-input': true,
  usage: true, context: true, effort: true, 'model-now': true, subagents: true, 'agent-added': true, 'plan-mode': true, hold: true,
  'always-allow': true, sleep: true, background: true,
}
export const EVENT_NAMES = Object.keys(EVENT_FLAGS) as (keyof EngineEventMap)[]

/** 앱 사건 전부 — 새 사건을 AppEventMap 에 더하면 여기서 타입 오류가 난다 */
const APP_EVENT_FLAGS: Record<keyof AppEventMap, true> = { setup: true, update: true, 'claude-update': true, phone: true }
export const APP_EVENT_NAMES = Object.keys(APP_EVENT_FLAGS) as (keyof AppEventMap)[]

/** 엔진 사건과 앱 사건의 이름이 겹치지 않는다 — 겹치면 여기서 타입 오류(한 봉투 이름으로 둘을 가를 수 없다) */
type Clash = Extract<keyof EngineEventMap, keyof AppEventMap>
const NO_CLASH: [Clash] extends [never] ? true : Clash = true

export type InvokeRequest = { method: string; args: unknown[] }
export type InvokeResult = { ok: true; value: unknown } | { ok: false; error: string }
export type EventEnvelope = { name: keyof DureEventMap; payload: unknown }

export const CLAUDE_MISSING_ERROR = 'claude 를 찾을 수 없어요'
