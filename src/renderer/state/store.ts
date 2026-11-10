import { useRef, useSyncExternalStore } from 'react'
import { SLEEP_DEFAULT_MIN, type AgentId, type AgentStatus, type EngineEventMap, type HistoryItem, type RoomId, type SearchHit } from '../../engine/types'
import type { DureApi, Snapshot } from '../../shared/ipcContract'
import type { AppEventMap, AppInfo, AppPrefs, ClaudeUpdateState, SetupState, UpdateState } from '../../shared/appTypes'
import type { PhoneState } from '../../shared/phoneTypes'
import { displayStatus, effectiveSetup, type EdgeMode, type Phase } from './selectors'
import { markFresh } from '../map/freshNodes'
import { onPhone } from '../lib/phone'
import { nextStep, tourAt, type TourState } from '../tour/tourSteps'

/** 엔진 없이 도는 앱 쪽 상태 — 준비 화면·업데이트 토스트·설정·투어가 읽는다 */
export interface AppState {
  info: AppInfo | null
  prefs: AppPrefs | null
  setup: SetupState
  /** 준비 상태를 못 받았다(setupState 가 거절됨) — 사건이나 다음 성공이 오면 false. 화면은 selectors 의 effectiveSetup 으로 푼다 */
  setupLoadFailed: boolean
  update: UpdateState
  claudeUpdate: ClaudeUpdateState
  /** 업데이트 토스트를 이번 실행 동안 닫았다 — 저장하지 않는다 */
  toastHidden: boolean
  /** 휴대폰으로 쓰기(PC 설정의 휴대폰 칸·위 띠 알약) — 처음 phoneState 와 'phone' 사건으로만 바뀐다. 못 받았으면(휴대폰 화면 등) null */
  phone: PhoneState | null
}

export type UiState = Snapshot & {
  app: AppState
  roomId: RoomId | null
  selectedAgentId: AgentId | null
  history: Record<AgentId, HistoryItem[]>
  historyStatus: Record<AgentId, { state: 'loading' | 'ready' | 'error'; error?: string }>
  /**
   * 불러온 기록의 첫 항목보다 앞 기록이 (있을 수) 있다 — 마지막으로 받은 덩이(처음 불러오기 · 앞쪽 불러오기)가 꽉 찼다(HISTORY_PAGE).
   * 대화 맨 위 [이전 대화 더 보기]가 이것을 본다. 덜 찬 덩이 · 새 대화(경계)면 false
   */
  hasOlder: Record<AgentId, boolean>
  /**
   * 그 에이전트의 입력창에 커서를 놓아 달라는 신호 — 카드 · 찾기 창 · 할 일의 [대화 보기]로 골랐다(selectAgent·focusAgent 의 focusInput)
   * · 새 글 알약(focusInput). 입력창이 받아 초점을 옮긴다 — 다른 칸에 쓰는 중이거나 창이 떠 있으면 그대로(focusHeldElsewhere).
   * 다른 길로 고르면 지운다(남은 신호로 나중에 커서가 가지 않게). n 은 부를 때마다 오른다
   */
  inputFocus: { agentId: AgentId; n: number } | null
  streaming: Record<AgentId, string>
  /**
   * Claude 가 생각하는 중인 에이전트 — tokens = 지금까지 생각한 추정 토큰 수(모르면 null). 없으면 생각 중이 아니다.
   * 생각 블록 시작에서만 생기고(토큰 수 신호는 수만 바꾼다), 생각 끝 신호 · 흐르는 글 · 그 에이전트의 답·끝·알림·새 대화 기록 ·
   * 작업 중(승인 기다림 포함)이 아니게 됨에서 지운다
   */
  thinking: Record<AgentId, { tokens: number | null }>
  /**
   * 차례의 단계 — 내용(생각·글·하는 일)이 오기 전 무엇을 기다리는지. 보낸 줄(user 기록)이 오면 준비, API 상태(api-status)가
   * 요청 보냄이면 답 기다림 · 요약 중이면 대화 정리. 내용이 오기 시작함(생각 신호·흐르는 글·부모의 답) · 차례 끝·알림·새 대화 ·
   * API 상태 null · 작업 중(승인 기다림 포함)이 아니게 됨에서 지운다. 없으면 단계를 모른다(작업 중…)
   */
  phase: Record<AgentId, Phase>
  /** 에이전트마다 마지막 assistant 글과 그 시각 — 기록을 안 불러온 에이전트도(관계도 카드의 한 줄 요약) */
  lastText: Record<AgentId, { text: string; at: number }>
  /** 키 `${from}>${to}` → 마지막으로 전달된 시각(message.updatedAt) */
  lastDelivered: Record<string, number>
  /**
   * 에이전트마다 지금 표시 상태가 시작된 시각 — status 이벤트로 표시 상태가 바뀐 걸 받은 순간(Date.now()).
   * 스냅샷으로만 아는 상태(켤 때 이미 작업 중 등)는 언제부터인지 모르므로 없다.
   */
  statusSince: Record<AgentId, number>
  /** 처음 상태를 한 번도 못 받았을 때 그 까닭(오류 문구) — 받으면 null. 받은 뒤의 실패는 여기 오지 않는다 */
  loadError: string | null
  /** 패널에서 고른 탭 — 에이전트마다, 앱을 끄면 잊는다. 없으면 대화 */
  panelTab: Record<AgentId, PanelTab>
  /** 대화의 서브에이전트 요약 줄을 눌렀다 — 지도가 key(노드 id)가 든 차례로 간다. n 은 누를 때마다 오른다 */
  subagentFocus: { agentId: AgentId; key: string; n: number } | null
  /** 메시지 탭의 '대화에서 보기'를 눌렀다 — 그 에이전트의 대화가 messageId 메시지 줄로 간다. 간 뒤엔 대화 목록이 지운다(다시 열려도 또 가지 않게) */
  messageFocus: { agentId: AgentId; messageId: string; n: number } | null
  /**
   * 찾기(Ctrl+K)에서 대화 줄을 골랐다(openHit) — 지금 대화(key null)면 대화 목록이, 지난 대화면 지난 대화 탭이 그 줄로 가서 잠깐 표시하고 지운다.
   * 지금 대화 줄이 불러온 범위보다 앞이면 openHit 이 그 줄까지 불러 둔 뒤에 생긴다. 다른 에이전트를 고르면 지운다. n 은 부를 때마다 오른다.
   * far — 지금 대화 줄인데 대화 목록으로는 너무 앞(그 줄부터 끝까지 HIT_MAX 항목을 넘는다): 지난 대화 탭이 지금 대화를 읽기로 열어 그 줄로 간다
   */
  hitFocus: { hit: SearchHit; n: number; far?: true } | null
  /**
   * 지난 대화 탭이 이 에이전트의 지금 대화를 읽기로 보이는 중(hitFocus.far) — 지난 대화가 하나도 없어도 그 탭에 있는 동안 탭을 보인다.
   * 다른 에이전트·방으로 가면 지운다
   */
  readCurrent: AgentId | null
  /** focusAgent 가 그 카드를 관계도에 보이게 해 달라고 했다 — 관계도가 카드가 밖에 있을 때만 옮긴다. n 은 부를 때마다 오른다 */
  mapFocus: { agentId: AgentId; n: number } | null
  /** 관계도 선 보기 — 이 PC 에 기억한다(EDGE_MODE_KEY), 처음엔 최근 */
  edgeMode: EdgeMode
  /**
   * 에이전트가 만든 새 에이전트 → 만든 에이전트(agent-added 사건). 관계도가 자리 없는 새 에이전트를 만든 쪽 가까이 놓는 데 쓴다.
   * 앱을 끄면 잊는다 — 사건을 놓친 새 에이전트(다시 켬)는 지금처럼 첫 빈 칸
   */
  placeNear: Record<AgentId, AgentId>
  /**
   * 끝났고 아직 안 본 에이전트 → 끝난 시각(result 기록의 t). 고르지 않은 에이전트(또는 창에 초점이 없을 때 고른 것)의 차례가 끝나면 생기고,
   * 그 에이전트를 고름 · 다시 작업 중(승인 기다림 포함) · 새 대화에서 지운다. 앱을 끄면 잊는다
   */
  fresh: Record<AgentId, number>
  /** 방 목록을 열어 달라는 요청 횟수 — 흘끗 보기 창 등 바깥에서 요청하면 오른다(0 부터). 값이 바뀔 때마다 방 목록을 연다 */
  roomMenuRequest: number
  /** 지난 대화에서 새 에이전트로 이어 가는 창의 초안 — 없으면 창이 닫혀 있다 */
  forkDraft: ForkDraft | null
  /** 안내 투어 — 없으면 null. 처음 켠 새 사용자에겐 저절로 '환영'(tourSteps · TourLayer 가 넘긴다) */
  tour: TourState
}

export interface ForkDraft {
  from: AgentId
  key: string
  roomId: RoomId
  name: string
  role: string
  folder: string
}

export type PanelTab = 'chat' | 'subagents' | 'messages' | 'past'

/** 관계도 선 보기를 기억하는 자리(이 PC) */
export const EDGE_MODE_KEY = 'dure.edges'
const EDGE_MODES: EdgeMode[] = ['recent', 'all', 'off']

function readEdgeMode(): EdgeMode {
  try {
    const v = localStorage.getItem(EDGE_MODE_KEY)
    return EDGE_MODES.includes(v as EdgeMode) ? (v as EdgeMode) : 'recent'
  } catch {
    return 'recent'
  }
}

export interface Store {
  getState(): UiState
  subscribe(fn: () => void): () => void
  init(): Promise<void>
  /** 방·에이전트를 바꾸는 호출(addRoom 등) 뒤에 스냅샷을 다시 받는다 */
  refresh(): Promise<void>
  /**
   * 사건 흐름이 끊겼다 다시 이어졌다(휴대폰 WebSocket) — 그사이 놓친 사건을 메운다: 스냅샷을 다시 받고, 고른 에이전트의 기록은
   * 다시 받아 자리에서 갈음한다(불러오는 중 표시 없이). 다른 에이전트의 불러 둔 기록·흐르는 글은 잊는다(열 때 다시 받는다)
   */
  resync(): Promise<void>
  /** 그 에이전트를 고른다(기록도 불러온다) — focusInput 이면 그 입력창에 커서(inputFocus) */
  selectAgent(id: AgentId | null, o?: { focusInput?: boolean }): void
  /** 고른 에이전트의 입력창에 커서를 놓아 달라고 한다(inputFocus) — 고른 에이전트가 아니면 아무것도 안 한다 */
  focusInput(id: AgentId): void
  /**
   * [이전 대화 더 보기] — 대화 목록 첫 기록보다 앞 HISTORY_PAGE 항목을 history({ before, limit }) 한 번으로 불러 앞에 붙인다.
   * 이미 불러오는 중이면 그 약속. 앞 기록이 없다고 알면(hasOlder) · 기록이 없으면 아무것도 안 한다. 부르는 사이 목록이 갈렸으면(새 대화 · 다시 받기) 붙이지 않는다.
   * 못 받으면 거절한다(목록은 그대로)
   */
  loadOlder(id: AgentId): Promise<void>
  selectRoom(id: RoomId): void
  setPanelTab(id: AgentId, tab: PanelTab): void
  /** 서브에이전트 탭으로 바꾸고 key(노드 id)가 든 차례를 보이게 한다 */
  showSubagents(id: AgentId, key: string): void
  /** 그 에이전트를 고르고(다른 에이전트면 그 방으로 · 기록도 불러온다) 대화 탭에서 messageId 메시지 줄을 보이게 한다. 모르는 id 면 아무것도 안 한다 */
  showMessage(id: AgentId, messageId: string): void
  /** 대화 목록이 messageFocus(n)로 갔다 — 지운다. 그 사이 새로 누른 것(n 이 다르면)은 남긴다 */
  doneMessageFocus(n: number): void
  /**
   * 찾기에서 고른 대화 줄로 — 그 에이전트를 고르고(다른 방이면 방도 · 관계도에 카드), 지금 대화면 대화 탭 · 지난 대화면 지난 대화 탭으로.
   * 지금 대화 줄이 불러온 범위보다 앞이면 history({ before, limit }) 한 번(많아야 HIT_MAX 항목)으로 그 줄 조금 앞까지 불러 앞에 붙인 뒤 hitFocus 를 남긴다.
   * 그래도 닿지 않으면(너무 앞) 대화 목록을 늘리지 않고 지난 대화 탭에서 지금 대화를 읽기로 연다(hitFocus.far · readCurrent).
   * 모르는 에이전트(그새 지움)면 아무것도 안 한다. 그사이 다른 줄을 골랐거나 다른 에이전트로 갔으면 hitFocus 를 남기지 않는다
   */
  openHit(hit: SearchHit): Promise<void>
  /** 그 줄로 갔다(또는 갈 수 없다) — hitFocus(n)를 지운다. 그 사이 새로 고른 것은 남긴다 */
  doneHitFocus(n: number): void
  /** 최근 고른 에이전트 — 새로 고른 것부터(지금 고른 것 포함, 지운 에이전트는 뺀다). 찾기 창의 빈 입력이 쓴다 */
  recentAgents(): AgentId[]
  /** 관계도 선 보기를 바꾸고 이 PC 에 기억한다 */
  setEdgeMode(mode: EdgeMode): void
  /**
   * 그 에이전트의 방으로 바꾸고(다르면) 고르고, 관계도에 그 카드를 보이게 해 달라고 한다(mapFocus) — 기록도 불러온다. 모르는 id 면 아무것도 안 한다.
   * focusInput 이면 그 입력창에 커서(inputFocus — 찾기 창에서 고름)
   */
  focusAgent(id: AgentId, o?: { focusInput?: boolean }): void
  /** 방 목록을 열어 달라고 요청한다 — roomMenuRequest 가 하나 오른다 */
  requestRoomMenu(): void
  /** 갈래 창을 연다 */
  openFork(d: ForkDraft): void
  closeFork(): void
  /** 앱 설정을 바꾸고, 저장된 결과로 app.prefs 를 갈음한다 */
  setPrefs(p: Partial<AppPrefs>): Promise<void>
  /** 업데이트 토스트를 이번 실행 동안 닫는다 */
  hideUpdateToast(): void
  /** 투어를 '환영'부터 — 설정의 '안내 다시 보기'는 replay(방이 없으면 다시 보기가 아니다). 끝낼 때까지 아무것도 저장하지 않는다 */
  startTour(replay: boolean): void
  /** TourLayer 가 tourAdvance 결과를 넣는다 — 같은 값이면 알리지 않는다 */
  setTour(t: TourState): void
  /**
   * ok·환영 단계의 단추 — 다음 단계(고른 에이전트가 없으면 카드 단계를 건너뜀). 끝 다음이면 endTour.
   * 설정 안 단계에선 아무것도 안 한다 — 그 단계는 사용자가 설정 창을 닫아야 끝난다(tourAdvance)
   */
  tourNext(): void
  /** 투어를 닫고 끝낸 것으로 저장한다 — 저장이 실패해도 던지지 않고, 이번 실행엔 다시 저절로 뜨지 않는다 */
  endTour(): Promise<void>
  /** PC 시계를 바꿨으면 시작 시각(statusSince)을 맞춘다 — 이벤트를 받을 때도 보지만, 이벤트가 없는 동안(긴 명령)을 위해 앱이 1초마다 부른다 */
  followClock(): void
}

type Ev = { [K in keyof EngineEventMap]: { name: K; payload: EngineEventMap[K] } }[keyof EngineEventMap]

const EVENTS: (keyof EngineEventMap)[] = [
  'agent-event', 'status', 'message', 'request', 'request-resolved', 'flags', 'history', 'held-input',
  'usage', 'context', 'effort', 'model-now', 'subagents', 'agent-added', 'plan-mode', 'hold', 'always-allow', 'sleep', 'background',
]

const APP_EVENTS = ['setup', 'update', 'claude-update', 'phone'] as const

const sameItem = (a: HistoryItem, b: HistoryItem) => JSON.stringify(a) === JSON.stringify(b)

/** 생각 표시가 살아 있을 수 있는 상태 — 그 밖(쉼·멈춤·오류)이 되면 생각도 끝났다 */
const busy = (status: AgentStatus | undefined) => status === 'working' || status === 'awaiting'

/** 그 에이전트의 표시(생각·단계)를 지운다 — 없으면 같은 객체(구독자가 다시 그리지 않게) */
function without<T>(rec: Record<AgentId, T>, id: AgentId): Record<AgentId, T> {
  if (rec[id] === undefined) return rec
  const next = { ...rec }
  delete next[id]
  return next
}
const withoutThinking = without<UiState['thinking'][AgentId]>

/** 그 에이전트의 단계를 바꾼다 — 같으면 같은 객체 */
function withPhase(phase: UiState['phase'], id: AgentId, to: Phase): UiState['phase'] {
  return phase[id] === to ? phase : { ...phase, [id]: to }
}

/** 벽시계가 흐른 시간보다 이만큼 넘게 어긋나면 PC 시계를 바꾼 것 — 시간 동기화의 작은 보정은 그대로 둔다 */
const CLOCK_JUMP_MS = 2000

/** 최근 고른 에이전트를 몇 개까지 기억하나 */
const RECENT_MAX = 8
/** 찾은 줄로 가려고 앞쪽을 불러올 때 그 줄 앞에 더 남기는 기록 수(서브에이전트 줄은 세지 않는다) — 그 줄이 대화 맨 위에 붙지 않게 */
const HIT_LEAD = 20
/**
 * 찾은 지금 대화 줄로 대화 목록에서 갈 수 있는 거리 — 그 줄부터 끝까지 이 항목 수 안. 앞쪽을 불러오는 history 도 (이 수 − 가진 수)까지만 부른다.
 * 넘겨받는 양과 대화 목록이 그리는 줄 수를 묶는다(목록은 그 줄부터 끝까지 그린다) — 넘으면 지난 대화 탭의 읽기로
 */
export const HIT_MAX = 3000

/**
 * 기록 한 덩이(부모 기록 수) — 엔진 history 의 기본 limit 과 같다(처음 불러오기). [이전 대화 더 보기]도 한 번에 이만큼.
 * 받은 덩이가 이만큼 꽉 차면 그 앞이 더 있을 수 있다(hasOlder) — 앞 기록이 꼭 이만큼이면 한 번 더 눌러 빈 덩이를 받고서야 단추가 사라진다
 */
export const HISTORY_PAGE = 500

/** 서브에이전트 줄 — 부모의 Agent 하는 일 아래에서 온 assistant·tool-result(엔진 history 의 자르기와 같은 셈) */
const fromSubagent = (x: HistoryItem): boolean => (x.kind === 'assistant' || x.kind === 'tool-result') && typeof x.parent === 'string'

/** 부모 기록 수 — 엔진의 limit 이 세는 것(서브에이전트 줄은 세지 않는다) */
function parentCount(items: HistoryItem[]): number {
  let n = 0
  for (const x of items) if (!fromSubagent(x)) n++
  return n
}

/**
 * 앞쪽 덩이(history({ before: 첫 시각 + 1 }))에서 이미 가진 기록을 덜어 낸 끝 — 같은 시각(같은 ms)의 앞 기록이 빠지지 않게 첫 시각까지 받으니,
 * 목록 맨 앞의 같은 시각 기록만큼을 받은 덩이 끝에서 뺀다(파일 차례는 그대로). 찾은 줄로 가기(loadUpTo)와 [이전 대화 더 보기](loadOlder)가 같이 쓴다
 */
function freshEnd(older: HistoryItem[], list: HistoryItem[]): number {
  const t = list[0].t
  let held = 0
  while (held < list.length && list[held].t === t) held++
  let end = older.length
  while (held > 0 && end > 0 && older[end - 1].t === t) {
    end--
    held--
  }
  return end
}

/** i 번째 기록 앞으로 부모 기록 n 개만큼 물러선 자리(서브에이전트 줄은 세지 않고 함께 남긴다) */
function leadFrom(items: HistoryItem[], i: number, n: number): number {
  let left = n
  let at = i
  while (at > 0 && left > 0) {
    at--
    if (!fromSubagent(items[at])) left--
  }
  return at
}

/** 부모의 assistant 항목의 글(하는 일 블록은 뺀다) — 글이 없거나 서브에이전트의 줄이면 '' */
function assistantText(item: HistoryItem): string {
  if (item.kind !== 'assistant' || item.parent) return ''
  return item.blocks.flatMap(b => (b.type === 'text' && b.text.trim() !== '' ? [b.text] : [])).join('\n\n')
}

export function createStore(api: DureApi, opts: { hasFocus?: () => boolean } = {}): Store {
  // 창에 초점이 있는가 — 초점이 없으면 고른 에이전트의 결과도 못 본 것이다. document.hasFocus 가 없는 환경에선 본 것으로 친다
  const hasFocus = opts.hasFocus ?? (() => (typeof document !== 'undefined' && typeof document.hasFocus === 'function' ? document.hasFocus() : true))
  // 휴대폰 화면(wsApi) — PC 전용 메서드(고른 에이전트 알리기 · 앱 쪽 상태)는 부르지 않는다. 휴대폰의 고르기는 휴대폰 화면 상태로만(PC 의 고른 에이전트는 그대로)
  const phone = onPhone(api)
  let state: UiState = {
    app: { info: null, prefs: null, setup: { phase: 'checking' }, setupLoadFailed: false, update: { kind: 'idle' }, claudeUpdate: 'idle', toastHidden: false, phone: null },
    claudeMissing: false, rooms: [], agents: [], messages: [], requests: [], autoChainLimit: 0, allowBypass: false, notify: { asks: true, finished: false }, sleepAfterMin: SLEEP_DEFAULT_MIN, usage: null,
    roomId: null, selectedAgentId: null, history: {}, historyStatus: {}, hasOlder: {}, inputFocus: null, streaming: {}, thinking: {}, phase: {}, lastText: {}, lastDelivered: {},
    statusSince: {}, loadError: null, panelTab: {}, subagentFocus: null, messageFocus: null, hitFocus: null, readCurrent: null, mapFocus: null, edgeMode: readEdgeMode(), placeNear: {}, fresh: {}, roomMenuRequest: 0, forkDraft: null,
    tour: null,
  }
  const listeners = new Set<() => void>()
  let buffer: { ev: Ev; at: number }[] | null = null // 스냅샷을 기다리는 동안 온 이벤트(받은 시각과 함께)
  const loading = new Map<AgentId, HistoryItem[]>() // 기록을 불러오는 동안 온 항목
  let subscribed = false
  let loaded = false // 스냅샷을 한 번이라도 받았는가
  let clockOffset = Date.now() - performance.now() // 벽시계 − 흐른 시간 — 이것이 뛰면 PC 시계를 바꾼 것

  // 이번 실행에 투어가 한 번이라도 떴다 — 끝낸 뒤 조건이 그대로여도(저장 실패 등) 다시 저절로 띄우지 않는다
  let tourShown = false
  /**
   * 저절로 시작 — 앱 설정을 받았고 · 투어를 끝낸 적 없고 · 준비됐고(준비 화면이 아니고) · 방이 하나도 없으면 '환영'.
   * 방 수는 처음 스냅샷을 받은 뒤에만 안다(그 전의 빈 목록은 모르는 것)
   */
  const autoTour = () => {
    if (state.tour !== null) { tourShown = true; return }
    if (tourShown || !loaded) return
    const { prefs, setup, setupLoadFailed } = state.app
    if (!prefs || prefs.tourDone || state.rooms.length > 0) return
    if (effectiveSetup(setup, state.claudeMissing, setupLoadFailed).phase !== 'ready') return
    tourShown = true
    state = { ...state, tour: tourAt('welcome', false, state) }
  }
  // 최근 고른 에이전트 — 새로 고른 것이 맨 앞(카드 · 찾기 · 할 일 등 어디서 골랐든). 앱을 끄면 잊는다
  const recent: AgentId[] = []
  let lastSelected: AgentId | null = null
  const noteSelected = () => {
    const id = state.selectedAgentId
    if (id === lastSelected) return
    lastSelected = id
    if (id === null) return
    const at = recent.indexOf(id)
    if (at >= 0) recent.splice(at, 1)
    recent.unshift(id)
    if (recent.length > RECENT_MAX) recent.length = RECENT_MAX
  }
  const notify = () => {
    autoTour()
    noteSelected()
    listeners.forEach(fn => fn())
  }
  const set = (next: UiState) => {
    state = next
    notify()
  }

  const applySnapshot = (snap: Snapshot) => {
    const roomId = snap.rooms.some(r => r.id === state.roomId) ? state.roomId : (snap.rooms[0]?.id ?? null)
    const selectedAgentId = snap.agents.some(a => a.id === state.selectedAgentId) ? state.selectedAgentId : null
    // 이벤트 없이 스냅샷에서 표시 상태가 바뀐 에이전트는 언제 바뀌었는지 모른다 — 시작 시각을 지운다
    let statusSince = state.statusSince
    for (const a of snap.agents) {
      if (statusSince[a.id] === undefined) continue
      const old = state.agents.find(x => x.id === a.id)
      if (!old || displayStatus(old, state.requests) !== displayStatus(a, snap.requests)) {
        statusSince = { ...statusSince }
        delete statusSince[a.id]
      }
    }
    // 받았으니 불러오기 오류도 같은 갱신에서 지운다(낡은 오류와 새 상태가 함께 그려지지 않게)
    state = { ...state, ...snap, roomId, selectedAgentId, statusSince, loadError: null }
  }

  const applyEvent = (ev: Ev, at: number) => {
    switch (ev.name) {
      case 'status': {
        const p = ev.payload
        const old = state.agents.find(a => a.id === p.agentId)
        const agents = state.agents.map(a => (a.id === p.agentId ? { ...a, status: p.status, errorText: p.errorText, ...(p.remoteIssue !== undefined ? { remoteIssue: p.remoteIssue } : {}) } : a))
        const next = agents.find(a => a.id === p.agentId)
        const changed = !!old && !!next && displayStatus(old, state.requests) !== displayStatus(next, state.requests)
        state = {
          ...state,
          agents,
          statusSince: changed ? { ...state.statusSince, [p.agentId]: at } : state.statusSince,
          // 멈춤·차례 끝·세션이 죽음 — 생각 끝 신호 없이 끝나도 '생각하는 중'이 남지 않게
          thinking: busy(p.status) ? state.thinking : withoutThinking(state.thinking, p.agentId),
          // 다시 일을 시작했다 — 앞 결과는 지나간 일이니 '끝남' 표시도 내린다
          fresh: busy(p.status) ? without(state.fresh, p.agentId) : state.fresh,
          // 쉬다가 일하기 시작했는데 기다리는 입력이 있다 — 아직 Claude 에게 안 간 입력(띄울 때의 /effort 뒤에서 기다림)이니 준비.
          // 승인 기다림에서 돌아온 것은 이어지는 차례라 그대로
          phase: !busy(p.status) ? without(state.phase, p.agentId)
            : p.status === 'working' && !busy(old?.status) && (next?.heldInput ?? 0) > 0 ? withPhase(state.phase, p.agentId, 'preparing')
            : state.phase,
        }
        break
      }
      case 'flags': {
        const p = ev.payload
        state = {
          ...state,
          agents: state.agents.map(a =>
            a.id === p.agentId ? { ...a, bypass: p.bypass, bypassBySettings: p.bySettings, bypassPending: p.pending } : a,
          ),
        }
        break
      }
      case 'held-input': {
        const p = ev.payload
        state = { ...state, agents: state.agents.map(a => (a.id === p.agentId ? { ...a, heldInput: p.count } : a)) }
        break
      }
      case 'plan-mode': {
        const p = ev.payload
        state = { ...state, agents: state.agents.map(a => (a.id === p.agentId ? { ...a, planMode: p.on } : a)) }
        break
      }
      case 'sleep': {
        const p = ev.payload
        state = { ...state, agents: state.agents.map(a => (a.id === p.agentId ? { ...a, asleep: p.asleep, waking: p.waking } : a)) }
        break
      }
      case 'background': {
        const p = ev.payload
        state = { ...state, agents: state.agents.map(a => (a.id === p.agentId ? { ...a, background: p.running } : a)) }
        break
      }
      case 'hold': {
        const p = ev.payload
        state = { ...state, agents: state.agents.map(a => (a.id === p.agentId ? { ...a, hold: p.hold } : a)) }
        break
      }
      case 'always-allow': {
        const p = ev.payload
        state = { ...state, agents: state.agents.map(a => (a.id === p.agentId ? { ...a, alwaysAllow: p.alwaysAllow } : a)) }
        break
      }
      case 'usage':
        state = { ...state, usage: ev.payload }
        break
      case 'context': {
        const p = ev.payload
        state = { ...state, agents: state.agents.map(a => (a.id === p.agentId ? { ...a, lastContext: p.value } : a)) }
        break
      }
      case 'effort': {
        const p = ev.payload
        state = {
          ...state,
          agents: state.agents.map(a => (a.id === p.agentId ? { ...a, effort: p.effort, effortNow: p.effortNow } : a)),
        }
        break
      }
      case 'model-now': {
        const p = ev.payload
        state = { ...state, agents: state.agents.map(a => (a.id === p.agentId ? { ...a, modelNow: p.modelNow } : a)) }
        break
      }
      case 'subagents': {
        const p = ev.payload
        state = { ...state, agents: state.agents.map(a => (a.id === p.agentId ? { ...a, subagentsRunning: p.running } : a)) }
        break
      }
      case 'message': {
        const m = ev.payload
        const cur = state.messages.find(x => x.id === m.id)
        if (cur && cur.updatedAt > m.updatedAt) break // 더 오래된 사본
        const messages = cur ? state.messages.map(x => (x.id === m.id ? m : x)) : [...state.messages, m]
        const key = `${m.from}>${m.to}`
        const lastDelivered = m.state === 'delivered'
          ? { ...state.lastDelivered, [key]: Math.max(m.updatedAt, state.lastDelivered[key] ?? 0) }
          : state.lastDelivered
        state = { ...state, messages, lastDelivered }
        break
      }
      case 'request': {
        const r = ev.payload
        const requests = state.requests.some(x => x.id === r.id)
          ? state.requests.map(x => (x.id === r.id ? r : x))
          : [...state.requests, r]
        state = { ...state, requests }
        break
      }
      case 'request-resolved':
        state = { ...state, requests: state.requests.filter(r => r.id !== ev.payload.id) }
        break
      case 'agent-added': {
        const { agent, by } = ev.payload
        // 사람이 더한 카드처럼 관계도 카드가 나타난다(AddAgentDialog 와 같은 표 — 움직임 줄이기면 그대로)
        markFresh(agent.id)
        state = { ...state, placeNear: { ...state.placeNear, [agent.id]: by } }
        // 화면이 쓰는 모양(상태·묻지 않음 등)은 스냅샷에 있다 — 이미 받은 스냅샷에 들었으면(기다리는 동안 온 사건) 다시 받지 않는다.
        // 받는 중이면 끝난 뒤 한 번 더 받는다. 못 받으면 다음 스냅샷(자리 저장 등) 때 들어온다
        if (!state.agents.some(a => a.id === agent.id)) fetchSnapshot().catch(() => {})
        break
      }
      case 'history': {
        const { agentId, item } = ev.payload
        // 새 대화(boundary) — 앞 대화는 버린다. 다시 켜면 엔진의 history() 도 경계 뒤만 주니 같은 화면이 된다(알림 줄 없음)
        const boundary = item.kind === 'boundary'
        // 서브에이전트의 줄·시작·끝 — 부모의 차례와 따로 온다(부모 차례 중에도 섞여 온다). 부모의 흐르는 글·마지막 글과 상관없다
        const sub = ('parent' in item && !!item.parent) || item.kind === 'subagent-start' || item.kind === 'subagent-end'
        // 흐르는 글·마지막 글은 기록을 불러왔든 아니든 — 안 비우면 다음 차례 글이 앞 차례 뒤에 붙는다
        const text = assistantText(item)
        let lastText = state.lastText
        if (text) lastText = { ...lastText, [agentId]: { text, at: item.t } }
        else if (boundary && lastText[agentId]) {
          lastText = { ...lastText }
          delete lastText[agentId]
        }
        // 부모의 답(글·하는 일 — 생각 블록만 든 빈 답도)·차례 끝·알림(멈춤·오류)·새 대화 — 생각은 끝났다
        const thoughtEnds = (item.kind === 'assistant' && !sub) || item.kind === 'result' || item.kind === 'notice' || boundary
        state = {
          ...state,
          streaming: state.streaming[agentId] && !sub ? { ...state.streaming, [agentId]: '' } : state.streaming,
          thinking: thoughtEnds ? withoutThinking(state.thinking, agentId) : state.thinking,
          // 보낸 줄은 Claude 에게 쓴 순간 기록된다(working 알림과 어느 쪽이 먼저 와도 된다) — 요청이 나갈 때까지 준비. 같은 때에 생각도 끝난다
          phase: item.kind === 'user' ? withPhase(state.phase, agentId, 'preparing') : thoughtEnds ? without(state.phase, agentId) : state.phase,
          lastText,
          // 못 본 결과 — 고르지 않았거나 창에 초점이 없다. 새 대화는 앞 결과를 지운다
          fresh: item.kind === 'result' && (state.selectedAgentId !== agentId || !hasFocus()) ? { ...state.fresh, [agentId]: item.t }
            : boundary ? without(state.fresh, agentId)
            : state.fresh,
        }
        // 경계 — 지난 대화 수(pastCount)만 따로 받아 합친다(스냅샷 주기는 사건을 붙잡아 둔다)
        if (boundary) refreshPastCount()
        const pending = loading.get(agentId)
        if (pending) {
          // 불러오는 중 — 경계만 맨 앞에 남겨, 불러온 기록(경계 앞이거나 이미 그 뒤에 왔다)도 버리게 한다
          if (boundary) {
            pending.splice(0, pending.length, item)
            // 돌아간 대화면 앞 구간은 이 경계만으로 모른다 — 불러오기가 끝나면 다시 불러온다
            if (item.resumed) reloadAfter.add(agentId)
          }
          else pending.push(item)
          break
        }
        const list = state.history[agentId]
        if (!list) break // 아직 안 불러온 에이전트 — 불러올 때 같이 온다
        if (boundary && item.resumed) {
          // 돌아간 대화 — 같은 세션의 앞 구간이 이어 보여야 한다: 목록을 지우고 엔진에서 다시 받는다
          const { [agentId]: _h, ...history } = state.history
          const { [agentId]: _s, ...historyStatus } = state.historyStatus
          state = { ...state, history, historyStatus }
          void loadHistory(agentId)
          break
        }
        state = {
          ...state,
          history: { ...state.history, [agentId]: boundary ? [] : [...list, item] },
          // 새 대화 — 그 앞은 이 대화가 아니다
          hasOlder: boundary && state.hasOlder[agentId] ? { ...state.hasOlder, [agentId]: false } : state.hasOlder,
        }
        break
      }
      case 'agent-event': {
        const { agentId, event } = ev.payload
        if (event.kind === 'text-delta') {
          state = {
            ...state,
            streaming: { ...state.streaming, [agentId]: (state.streaming[agentId] ?? '') + event.text },
            thinking: withoutThinking(state.thinking, agentId), // 글이 흐르면 생각은 끝났다
            phase: without(state.phase, agentId), // 기다리던 답이 왔다
          }
        } else if (event.kind === 'api-status') {
          // 쉬는 에이전트에게 늦게 온 상태는 버린다 — 다음 차례가 그 단계로 시작하지 않게
          if (!busy(state.agents.find(a => a.id === agentId)?.status)) break
          // null = 요청·요약이 끝났다 — 그 단계만 지운다(준비는 CLI 상태가 아니니 늦게 온 끝이 다음 줄의 준비를 지우지 않게)
          const phase = event.status !== null ? withPhase(state.phase, agentId, event.status === 'requesting' ? 'requesting' : 'compacting')
            : state.phase[agentId] === 'preparing' ? state.phase
            : without(state.phase, agentId)
          if (phase !== state.phase) state = { ...state, phase }
        } else if (event.kind === 'thinking') {
          // 블록이 시작됐다(생각이든 글·하는 일이든) — 기다리던 답이 왔다
          const phase = without(state.phase, agentId)
          if (phase !== state.phase) state = { ...state, phase }
          const cur = state.thinking[agentId]
          if (!event.active) {
            state = { ...state, thinking: withoutThinking(state.thinking, agentId) }
            break
          }
          // 쉬는 에이전트에게 늦게 온 신호는 버린다 — 다음 차례가 '생각하는 중'으로 시작하지 않게
          if (!busy(state.agents.find(a => a.id === agentId)?.status)) break
          // 생각을 여는 건 블록 시작(수 없음)뿐 — 수만 든 신호(thinking_tokens)는 생각 중일 때 수만 바꾼다.
          // 생각이 끝난 뒤(글 블록 시작) 늦게 온 수가 '생각하는 중'을 잠깐 다시 열지 않게
          if (!cur && event.tokens !== null) break
          // 토큰 수를 모르는 신호(새 생각 블록 시작)는 이미 아는 수를 지우지 않는다. 같은 수면 그대로(다시 그리지 않게)
          const tokens = event.tokens ?? cur?.tokens ?? null
          if (cur && cur.tokens === tokens) break
          state = { ...state, thinking: { ...state.thinking, [agentId]: { tokens } } }
        }
        break
      }
    }
  }

  /**
   * PC 시계를 바꿨으면(벽시계만 뛴다) 이미 적은 시작 시각(statusSince)을 같은 만큼 옮긴다 — 안 옮기면 뒤로 돌린 만큼(3일이면 3일)
   * '작업 중… 0초'·'방금 시작'에 멈추고, 앞으로 돌린 만큼 지난 시간이 늘어난다. 이벤트를 받을 때마다 받은 시각을 적기 전에 본다
   * — 그래서 뛴 뒤에 적은 시각은 옮기지 않는다. 옮겼으면 true
   */
  const matchClock = (): boolean => {
    const offset = Date.now() - performance.now()
    const jump = offset - clockOffset
    if (Math.abs(jump) < CLOCK_JUMP_MS) return false
    clockOffset = offset
    const statusSince: UiState['statusSince'] = {}
    for (const [id, t] of Object.entries(state.statusSince)) statusSince[id] = t + jump
    state = { ...state, statusSince }
    return true
  }

  const onEvent = (ev: Ev) => {
    matchClock()
    const at = Date.now() // 받은 시각 — 스냅샷을 기다렸다 적용해도 이 시각을 쓴다
    if (buffer) { buffer.push({ ev, at }); return }
    applyEvent(ev, at)
    notify()
  }

  const subscribeEvents = () => {
    if (subscribed) return
    subscribed = true
    for (const name of EVENTS) {
      api.on(name, (payload: EngineEventMap[typeof name]) => onEvent({ name, payload } as Ev))
    }
  }

  // 앱 사건을 이미 받은 칸 — 늦게 온 첫 응답이 사건 값을 덮지 않게
  const appSeen = new Set<keyof AppEventMap>()
  const setApp = (patch: Partial<AppState>) => set({ ...state, app: { ...state.app, ...patch } })

  let appSubscribed = false
  const subscribeAppEvents = () => {
    if (appSubscribed) return
    appSubscribed = true
    for (const name of APP_EVENTS) {
      api.on(name, (payload: AppEventMap[typeof name]) => {
        appSeen.add(name)
        setApp(
          name === 'claude-update' ? { claudeUpdate: payload as ClaudeUpdateState }
            : name === 'setup' ? { setup: payload as SetupState, setupLoadFailed: false }
            : name === 'phone' ? { phone: payload as PhoneState }
            : { update: payload as UpdateState },
        )
      })
    }
  }

  /** 앱 쪽 첫 상태를 받는다 — 한 칸이 실패하면(옛 api 등) 그 칸은 처음 값 그대로. 절대 거절하지 않는다 */
  const loadApp = async () => {
    const take = async <T,>(call: () => Promise<T>, apply: (v: T) => Partial<AppState>, event?: keyof AppEventMap, onFail?: () => void) => {
      let v: T
      try { v = await call() } catch { if (!(event && appSeen.has(event))) onFail?.(); return }
      if (event && appSeen.has(event)) return
      setApp(apply(v))
    }
    await Promise.all([
      take(() => api.appInfo(), info => ({ info })),
      take(() => api.prefs(), prefs => ({ prefs })),
      take(() => api.setupState(), setup => ({ setup, setupLoadFailed: false }), 'setup', () => setApp({ setupLoadFailed: true })),
      take(() => api.updateState(), update => ({ update }), 'update'),
      take(() => api.claudeUpdateState(), claudeUpdate => ({ claudeUpdate }), 'claude-update'),
      // 휴대폰 화면(wsApi)은 PC 메서드라 거절한다 — null 그대로
      take(() => api.phoneState(), phone => ({ phone }), 'phone'),
    ])
  }

  const snapshotCycle = async () => {
    buffer = []
    try {
      applySnapshot(await api.snapshot())
      loaded = true
    } catch (e) {
      // 처음 상태를 못 받았으면 화면이 '첫 방을 만들어 보세요' 대신 이 까닭을 보이게
      if (!loaded) state = { ...state, loadError: e instanceof Error ? e.message : String(e) }
      throw e
    } finally {
      const pending = buffer
      buffer = null
      for (const { ev, at } of pending ?? []) applyEvent(ev, at)
      notify()
    }
  }

  /** 경계 뒤 지난 대화 수만 새로 받아 합친다 — 다른 칸·사건 흐름은 건드리지 않는다. 실패는 다음 스냅샷이 메운다 */
  const refreshPastCount = () => {
    api.snapshot().then((snap) => {
      const counts = new Map(snap.agents.map(a => [a.id, a.pastCount]))
      if (!state.agents.some(a => counts.has(a.id) && counts.get(a.id) !== a.pastCount)) return
      set({ ...state, agents: state.agents.map(a => (counts.has(a.id) ? { ...a, pastCount: counts.get(a.id)! } : a)) })
    }).catch(() => {})
  }
  /** 불러오는 중 돌아간 대화 경계가 온 에이전트 — 불러오기가 끝나면 다시 불러온다 */
  const reloadAfter = new Set<AgentId>()

  // 스냅샷 요청은 한 번에 하나만 — 도중에 또 오면 끝난 뒤 한 번 더 받는다
  let inflight: Promise<void> | null = null
  let rerun = false
  const fetchSnapshot = (): Promise<void> => {
    if (inflight) {
      rerun = true
      return inflight
    }
    inflight = (async () => {
      try {
        do {
          rerun = false
          await snapshotCycle()
        } while (rerun)
      } finally {
        inflight = null
        rerun = false
      }
    })()
    return inflight
  }

  /** 고른 에이전트를 엔진에 알린다 — 엔진이 claude 를 미리 띄운다. 알리기가 실패해도(끊김·없는 길) 고르기는 그대로 */
  const tellSelected = (id: AgentId | null) => {
    if (phone) return
    try {
      api.setSelected(id).catch(() => {})
    } catch {
      /* 알릴 길이 없다 — 보낼 때 띄운다 */
    }
  }

  /**
   * again — 이미 불러온 기록도 다시 받는다(resync): 받는 동안 지금 목록을 그대로 두고(불러오는 중 표시 없음) 받으면 갈음, 실패하면 그대로.
   * 이미 불러오는 중이면 그 불러오기를 돌려준다(openHit 이 끝까지 기다린다). 절대 거절하지 않는다
   */
  const loads = new Map<AgentId, Promise<void>>()
  const loadHistory = (id: AgentId, again = false): Promise<void> => {
    if (loading.has(id)) return loads.get(id) ?? Promise.resolve()
    if (!again && state.history[id]) return Promise.resolve()
    const p = fetchHistory(id, again)
    loads.set(id, p)
    void p.then(() => { if (loads.get(id) === p) loads.delete(id) })
    return p
  }
  const fetchHistory = async (id: AgentId, again: boolean) => {
    const keep = again && !!state.history[id]
    loading.set(id, [])
    if (!keep) set({ ...state, historyStatus: { ...state.historyStatus, [id]: { state: 'loading' } } })
    try {
      const loaded = await api.history(id)
      const pending = loading.get(id) ?? []
      loading.delete(id)
      // 불러오는 동안 새 대화가 시작됐으면(경계가 맨 앞에 남아 있다) 경계 뒤에 온 것만 — 경계 뒤에 읽었어도 그 항목들은 이벤트로 이미 왔다
      const renewed = pending[0]?.kind === 'boundary'
      const list = renewed
        ? pending.slice(1)
        : [...loaded, ...pending.filter(it => !loaded.some(l => sameItem(l, it)))]
      // 받은 덩이가 꽉 찼으면(엔진 기본 HISTORY_PAGE) 그 앞이 더 있을 수 있다
      const older = !renewed && parentCount(loaded) >= HISTORY_PAGE
      // 다시 켠 뒤엔 이벤트로 온 글이 없다 — 불러온 기록의 마지막 글로 채운다(더 새 글이 이미 있으면 그대로)
      let lastText = state.lastText
      for (let i = list.length - 1; i >= 0; i--) {
        const text = assistantText(list[i])
        if (!text) continue
        if ((lastText[id]?.at ?? -Infinity) < list[i].t) lastText = { ...lastText, [id]: { text, at: list[i].t } }
        break
      }
      set({
        ...state,
        history: { ...state.history, [id]: list },
        historyStatus: { ...state.historyStatus, [id]: { state: 'ready' } },
        hasOlder: { ...state.hasOlder, [id]: older },
        lastText,
      })
      if (reloadAfter.delete(id)) {
        const { [id]: _h, ...history } = state.history
        const { [id]: _s, ...historyStatus } = state.historyStatus
        set({ ...state, history, historyStatus })
        void loadHistory(id)
      }
    } catch (e) {
      loading.delete(id)
      if (keep && state.history[id]) return // 다시 받기 실패 — 지금 목록 그대로(다음 resync 가 메운다)
      const error = e instanceof Error ? e.message : String(e)
      set({ ...state, historyStatus: { ...state.historyStatus, [id]: { state: 'error', error } } })
    }
  }

  // 창이 다시 초점을 받으면 — 고른 에이전트의 대화가 지금 보이니 '끝남 · 새 결과' 를 지운다(초점이 없을 땐 못 본 것이라 남겼다).
  // 초점 없는 사이 고른 것도 같은 길로 풀린다. DOM 이 없는 환경(엔진 시험 등)에선 건너뛴다
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('focus', () => {
      const id = state.selectedAgentId
      if (id && id in state.fresh) set({ ...state, fresh: without(state.fresh, id) })
    })
  }

  /**
   * 지금 대화의 t 시각 줄을 대화 목록에 둔다 — 그 줄부터 끝까지가 HIT_MAX 항목 안이면 true(불러온 범위보다 앞이면 불러와 앞에 붙였다),
   * 넘으면 false(너무 앞 — 대화 목록을 늘리지 않는다: openHit 이 지난 대화 탭의 읽기로 보낸다).
   * 앞쪽은 history 를 한 번만, 많아야 HIT_MAX − 가진 수만큼 부른다(엔진은 부를 때마다 파일을 다시 읽는다 · 넘겨받는 양과 그리는 줄 수가 묶인다).
   * before = 첫 줄 시각 + 1: 첫 줄과 같은 시각(같은 ms)의 앞 줄도 빠지지 않는다. 이미 가진 같은 시각 줄은 받은 덩이 끝에서 덜어 낸다(파일 차례는 그대로).
   * 받은 덩이가 꽉 찼는데 그 줄이 덩이 맨 앞보다도 앞이면 너무 앞. 닿으면 그 줄보다 HIT_LEAD 개 앞에서 잘라 붙인다.
   * 부르는 사이 목록이 갈렸으면(새 대화 · 다시 받기) 붙이지 않는다. 실패는 조용히 — 그 줄로 못 가도 대화는 그대로(true)
   */
  const loadUpTo = async (id: AgentId, t: number): Promise<boolean> => {
    const list = state.history[id]
    const first = list?.[0]
    if (!first) return true
    if (t >= first.t) {
      const at = list.findIndex(x => x.t >= t)
      return at < 0 || list.length - at <= HIT_MAX
    }
    const room = HIT_MAX - list.length
    if (room <= 0) return false
    let older: HistoryItem[]
    try {
      older = await api.history(id, { before: first.t + 1, limit: room })
    } catch {
      return true
    }
    if (older.length >= room && t < older[0].t) return false
    const now = state.history[id]
    if (!now || now[0] !== first) return true
    const end = freshEnd(older, now)
    const at = older.findIndex(x => x.t >= t)
    const from = leadFrom(older, at < 0 || at > end ? end : at, HIT_LEAD)
    if (from < end) {
      set({
        ...state,
        history: { ...state.history, [id]: [...older.slice(from, end), ...now] },
        // 앞에 덜어 낸 기록이 있거나 받은 덩이가 꽉 찼으면 그 앞이 더 있다 — 덜 찼으면 대화 맨 앞까지 받았다
        hasOlder: { ...state.hasOlder, [id]: from > 0 || parentCount(older) >= room },
      })
    }
    return true
  }

  // [이전 대화 더 보기] — 에이전트마다 한 번에 하나
  const olderLoads = new Map<AgentId, Promise<void>>()
  const loadOlder = (id: AgentId): Promise<void> => {
    const busy = olderLoads.get(id)
    if (busy) return busy
    const first = state.history[id]?.[0]
    if (!first || !state.hasOlder[id]) return Promise.resolve()
    const p = (async () => {
      // 엔진은 부를 때마다 기록 파일을 다시 읽는다 — 한 번에 한 덩이
      const older = await api.history(id, { before: first.t + 1, limit: HISTORY_PAGE })
      const now = state.history[id]
      if (!now || now[0] !== first) return
      const end = freshEnd(older, now)
      set({
        ...state,
        history: end > 0 ? { ...state.history, [id]: [...older.slice(0, end), ...now] } : state.history,
        hasOlder: { ...state.hasOlder, [id]: parentCount(older) >= HISTORY_PAGE },
      })
    })()
    olderLoads.set(id, p)
    const done = () => { if (olderLoads.get(id) === p) olderLoads.delete(id) }
    p.then(done, done)
    return p
  }

  // 찾기에서 마지막으로 고른 줄 — 늦게 끝난 앞 고르기가 hitFocus 를 남기지 않게. hitN 은 hitFocus 의 n
  let hitAsk = 0
  let hitN = 0
  /**
   * 다른 에이전트로 가면 남은 hitFocus 는 버린다 — 나중에 그 에이전트를 다시 열 때 옛 줄로 뛰지 않게.
   * 지금 대화 읽기(readCurrent)도 — 다시 열면 지난 대화가 없는 에이전트엔 그 탭이 없다
   */
  const hitFor = (id: AgentId | null): Pick<UiState, 'hitFocus' | 'readCurrent'> => ({
    hitFocus: state.hitFocus && state.hitFocus.hit.agentId === id ? state.hitFocus : null,
    readCurrent: state.readCurrent === id ? id : null,
  })
  // 입력창 커서 신호 — 고를 때마다 새로 정한다: focusInput 이면 새 신호, 아니면 지운다(남은 신호가 나중에 커서를 옮기지 않게)
  let inputN = 0
  const inputFor = (id: AgentId | null, on: boolean | undefined): UiState['inputFocus'] => (on && id ? { agentId: id, n: ++inputN } : null)

  const endTour = async () => {
    tourShown = true
    if (state.tour !== null) set({ ...state, tour: null })
    try {
      const prefs = await api.setPrefs({ tourDone: true })
      setApp({ prefs })
    } catch {
      // 저장하지 못했다 — 이번 실행엔 다시 뜨지 않고, 다음에 켜면 다시 뜬다
    }
  }

  return {
    getState: () => state,
    followClock() {
      if (matchClock()) notify()
    },
    subscribe(fn) {
      listeners.add(fn)
      return () => { listeners.delete(fn) }
    },
    async init() {
      subscribeEvents()
      subscribeAppEvents()
      // 앱 상태는 기다리지 않는다 — 응답이 오는 대로 칸이 채워지고, 안 와도 처음 상태는 스냅샷만으로 끝난다
      if (!phone) void loadApp().catch(() => {})
      await fetchSnapshot()
    },
    async setPrefs(p) {
      const prefs = await api.setPrefs(p)
      setApp({ prefs })
    },
    hideUpdateToast() {
      if (!state.app.toastHidden) setApp({ toastHidden: true })
    },
    startTour(replay) {
      set({ ...state, tour: tourAt('welcome', replay && state.rooms.length > 0, state) })
    },
    setTour(t) {
      if (sameTour(state.tour, t)) return
      set({ ...state, tour: t })
    },
    tourNext() {
      const t = state.tour
      if (!t || t.step === 'settings') return
      const hasAgent = state.agents.some(a => a.id === state.selectedAgentId && a.roomId === state.roomId)
      const next = nextStep(t.step, { hasAgent })
      if (next === null) {
        void endTour()
        return
      }
      set({ ...state, tour: tourAt(next, t.replay, state) })
    },
    endTour,
    async refresh() {
      await fetchSnapshot()
    },
    async resync() {
      const before = new Map(state.agents.map(a => [a.id, a]))
      await fetchSnapshot()
      const keep = state.selectedAgentId
      const only = <T,>(rec: Record<AgentId, T>): Record<AgentId, T> => {
        const out: Record<AgentId, T> = {}
        for (const id of Object.keys(rec)) if (id === keep || loading.has(id)) out[id] = rec[id]
        return out
      }
      // 끊긴 사이 끝난 차례 — 생각 중·단계 표시는 쉬는 에이전트에서 내린다. 흐르던 글은 앞부분을 놓쳤을 수 있어 비운다
      let { thinking, phase } = state
      for (const id of [...Object.keys(thinking), ...Object.keys(phase)]) {
        if (busy(state.agents.find(a => a.id === id)?.status)) continue
        thinking = without(thinking, id)
        phase = without(phase, id)
      }
      // 고르지 않은 에이전트의 끝남 표시·마지막 글 — 놓친 사건이 했을 일을 스냅샷으로 아는 만큼(스냅샷엔 마지막 글이 없어 새 글은 다음 사건·열 때 채운다):
      // 없어졌으면 잊고, 다시 일하는 중이면 끝남을 내리고, 새 대화로 갔으면(지난 대화 수가 바뀜) 앞 대화의 끝남·마지막 글을 내린다
      let { lastText, fresh } = state
      const now = new Map(state.agents.map(a => [a.id, a]))
      for (const id of new Set([...Object.keys(lastText), ...Object.keys(fresh)])) {
        if (id === keep) continue
        const a = now.get(id)
        const renewed = !!a && before.has(id) && before.get(id)!.pastCount !== a.pastCount
        if (!a || renewed) lastText = without(lastText, id)
        if (!a || renewed || busy(a.status)) fresh = without(fresh, id)
      }
      set({ ...state, history: only(state.history), historyStatus: only(state.historyStatus), streaming: {}, thinking, phase, lastText, fresh })
      if (keep) await loadHistory(keep, true)
    },
    selectAgent(id, o) {
      set({ ...state, selectedAgentId: id, fresh: id ? without(state.fresh, id) : state.fresh, ...hitFor(id), inputFocus: inputFor(id, o?.focusInput) })
      tellSelected(id)
      if (id) void loadHistory(id)
    },
    focusInput(id) {
      if (state.selectedAgentId !== id) return
      set({ ...state, inputFocus: inputFor(id, true) })
    },
    loadOlder,
    selectRoom(id) {
      if (!state.rooms.some(r => r.id === id)) return
      set({ ...state, roomId: id, selectedAgentId: null, hitFocus: null, readCurrent: null, inputFocus: null })
      tellSelected(null)
    },
    focusAgent(id, o) {
      const a = state.agents.find(x => x.id === id)
      if (!a) return
      // 방을 바꾸면서 고르기 — selectRoom 은 고르기를 비우니 쓰지 않고 한 번에 바꾼다
      const roomId = state.rooms.some(r => r.id === a.roomId) ? a.roomId : state.roomId
      const mapFocus = { agentId: id, n: (state.mapFocus?.n ?? 0) + 1 }
      set({ ...state, roomId, selectedAgentId: id, fresh: without(state.fresh, id), mapFocus, ...hitFor(id), inputFocus: inputFor(id, o?.focusInput) })
      tellSelected(id)
      void loadHistory(id)
    },
    openFork(d) {
      set({ ...state, forkDraft: d })
    },
    closeFork() {
      if (!state.forkDraft) return
      set({ ...state, forkDraft: null })
    },
    requestRoomMenu() {
      set({ ...state, roomMenuRequest: state.roomMenuRequest + 1 })
    },
    setPanelTab(id, tab) {
      if (state.panelTab[id] === tab) return
      set({ ...state, panelTab: { ...state.panelTab, [id]: tab } })
    },
    showSubagents(id, key) {
      set({
        ...state,
        panelTab: { ...state.panelTab, [id]: 'subagents' },
        subagentFocus: { agentId: id, key, n: (state.subagentFocus?.n ?? 0) + 1 },
      })
    },
    showMessage(id, messageId) {
      const a = state.agents.find(x => x.id === id)
      if (!a) return
      const other = state.selectedAgentId !== id
      const roomId = state.rooms.some(r => r.id === a.roomId) ? a.roomId : state.roomId
      set({
        ...state,
        roomId,
        selectedAgentId: id,
        fresh: without(state.fresh, id),
        panelTab: { ...state.panelTab, [id]: 'chat' },
        messageFocus: { agentId: id, messageId, n: (state.messageFocus?.n ?? 0) + 1 },
        ...hitFor(id),
        inputFocus: null, // 초점은 그 메시지 줄로
      })
      if (other) {
        tellSelected(id)
        void loadHistory(id)
      }
    },
    doneMessageFocus(n) {
      if (state.messageFocus?.n !== n) return
      set({ ...state, messageFocus: null })
    },
    async openHit(hit) {
      const a = state.agents.find(x => x.id === hit.agentId)
      if (!a) return
      const ask = ++hitAsk
      const id = a.id
      const current = hit.conversation.key === null
      const other = state.selectedAgentId !== id
      const roomId = state.rooms.some(r => r.id === a.roomId) ? a.roomId : state.roomId
      set({
        ...state,
        roomId,
        selectedAgentId: id,
        fresh: without(state.fresh, id),
        panelTab: { ...state.panelTab, [id]: current ? 'chat' : 'past' },
        mapFocus: { agentId: id, n: (state.mapFocus?.n ?? 0) + 1 },
        hitFocus: null,
        readCurrent: state.readCurrent === id ? id : null,
        inputFocus: null, // 초점은 찾은 줄로(대화 목록 · 지난 대화 읽기)
      })
      if (other) tellSelected(id)
      // 지금 대화 — 기록을 다 받은 뒤(불러오는 중이면 그것까지) 그 줄이 앞이면 그 줄까지. 지난 대화도 대화 탭은 기록이 있어야 한다
      let far = false
      if (current) {
        await loadHistory(id)
        while (loading.has(id)) await loadHistory(id) // 불러오는 동안 돌아간 대화 경계가 와서 다시 불러오는 중
        if (ask !== hitAsk || state.selectedAgentId !== id) return
        far = !(await loadUpTo(id, hit.t))
      } else {
        void loadHistory(id)
      }
      if (ask !== hitAsk || state.selectedAgentId !== id) return
      // 너무 앞 — 대화 목록은 그대로 두고 지난 대화 탭이 지금 대화를 읽기로 연다(지난 대화가 없어도 탭이 보인다)
      if (far) set({ ...state, panelTab: { ...state.panelTab, [id]: 'past' }, readCurrent: id, hitFocus: { hit, n: ++hitN, far: true } })
      else set({ ...state, hitFocus: { hit, n: ++hitN } })
    },
    doneHitFocus(n) {
      if (state.hitFocus?.n !== n) return
      set({ ...state, hitFocus: null })
    },
    recentAgents() {
      return recent.filter(id => state.agents.some(a => a.id === id))
    },
    setEdgeMode(mode) {
      if (state.edgeMode === mode) return
      set({ ...state, edgeMode: mode })
      try {
        localStorage.setItem(EDGE_MODE_KEY, mode)
      } catch {
        // 저장을 못 해도 이번 실행에선 그대로 쓴다
      }
    },
  }
}

/** 같은 투어인가 — 단계·다시 보기·base 가 모두 같으면 */
function sameTour(a: TourState, b: TourState): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return a.step === b.step && a.replay === b.replay
    && a.base.rooms === b.base.rooms && a.base.agents === b.base.agents && a.base.sent === b.base.sent
}

let shared: Store | null = null
/** 앱 전체가 쓰는 스토어 — window.dure 로 처음 부를 때 만든다 */
export function getStore(): Store {
  return (shared ??= createStore(window.dure))
}

/** 원시값은 ===, 배열은 원소별 ===, 일반 객체는 한 단계 === */
export function shallowEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((v, i) => Object.is(v, b[i]))
  }
  const ka = Object.keys(a)
  const kb = Object.keys(b)
  if (ka.length !== kb.length) return false
  return ka.every(key => Object.prototype.hasOwnProperty.call(b, key) && Object.is((a as any)[key], (b as any)[key]))
}

export function useDure<T>(sel: (s: UiState) => T, isEqual: (a: T, b: T) => boolean = shallowEqual): T {
  const store = getStore()
  const last = useRef<{ v: T } | null>(null)
  const get = () => {
    const next = sel(store.getState())
    if (last.current && isEqual(last.current.v, next)) return last.current.v
    last.current = { v: next }
    return next
  }
  return useSyncExternalStore(store.subscribe, get)
}
