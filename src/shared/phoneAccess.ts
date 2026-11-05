// 휴대폰이 부를 수 있는 메서드 — 허용 목록(기본 거절). main 의 phoneDispatcher 와 휴대폰 화면(WebSocket window.dure)이 같이 쓴다
import type { ApiMethod } from './ipcContract'

export type PhoneAccess = 'phone' | 'pc'

/** 휴대폰에서 PC 전용 메서드를 불렀다 — 모르는 이름·preload 전용(on·pathForFile)도 */
export const PHONE_DENIED = '휴대폰에서는 할 수 없는 일이에요'

/**
 * 메서드마다 휴대폰에서 되는가 — Record 라서 METHODS·APP_METHODS 에 새 이름을 더하면 여기 분류하기 전엔 타입 오류(기본 거절).
 * 'pc': 이 PC 의 창·대화상자·탐색기·작업 표시줄을 여는 일 · 새 서버 확인(ssh 설정 읽기) · 고른 에이전트(PC 화면 상태) · 앱 전체 설정 ·
 * 앱 쪽(준비·업데이트·투어) 전부. addRoom 은 'phone' 이지만 서버 방(remote)은 phoneDispatcher 가 거절한다
 */
export const PHONE_ACCESS: Readonly<Record<ApiMethod, PhoneAccess>> = Object.freeze({
  // 읽기 · 방 · 에이전트
  snapshot: 'phone',
  addRoom: 'phone',
  sshAvailable: 'phone',
  sshHosts: 'pc',
  checkRemote: 'pc',
  checkRemoteFolder: 'phone',
  renameRoom: 'phone',
  removeRoom: 'phone',
  addAgent: 'phone',
  updateAgent: 'phone',
  removeAgent: 'phone',
  setSelected: 'pc',
  // 대화
  sendUser: 'phone',
  setPlanMode: 'phone',
  resumeHold: 'phone',
  dropHoldItem: 'phone',
  dropHold: 'phone',
  revokeAlwaysAllow: 'phone',
  interrupt: 'phone',
  newConversation: 'phone',
  setModel: 'phone',
  setEffort: 'phone',
  refreshUsage: 'phone',
  describe: 'phone',
  history: 'phone',
  conversations: 'phone',
  conversation: 'phone',
  resumeConversation: 'phone',
  forkAgent: 'phone',
  image: 'phone',
  openAttachment: 'pc',
  // 승인 · 넘기기
  approveMessage: 'phone',
  dismissMessage: 'phone',
  continueHeld: 'phone',
  answerRequest: 'phone',
  setBypass: 'phone',
  // 재우기
  sleep: 'phone',
  sleepRoom: 'phone',
  sleepBlock: 'phone',
  sleepableIn: 'phone',
  // 앱 전체 설정 — PC 에서만
  setAutoChainLimit: 'pc',
  setAllowBypass: 'pc',
  setNotify: 'pc',
  setTheme: 'pc',
  setSleepAfter: 'pc',
  // 이 PC 의 창·대화상자·탐색기
  pickFolder: 'pc',
  openAgentFolder: 'pc',
  saveConversation: 'pc',
  setTaskbar: 'pc',
  flashWindow: 'pc',
  focusWindow: 'pc',
  // 앱 쪽(APP_METHODS) — 전부 PC 에서만
  appInfo: 'pc',
  prefs: 'pc',
  setPrefs: 'pc',
  setupState: 'pc',
  installClaude: 'pc',
  loginClaude: 'pc',
  openSetupGuide: 'pc',
  claudeUpdateState: 'pc',
  updateState: 'pc',
  checkUpdate: 'pc',
  downloadUpdate: 'pc',
  installUpdate: 'pc',
  openReleasePage: 'pc',
  setTourVeil: 'pc',
  // 휴대폰 연결·짝 맺기 — PC 설정에서만(휴대폰이 스스로 켜고 끄거나 짝을 맺고 끊지 못하게)
  phoneState: 'pc',
  setPhone: 'pc',
  phoneCheck: 'pc',
  phonePairStart: 'pc',
  phonePairCancel: 'pc',
  phoneUnpair: 'pc',
})

/** 휴대폰에서 부를 수 있는 이름인가 — 목록에 'phone' 으로 적힌 것만(프로토타입 이름·모르는 이름·글이 아닌 것은 false) */
export function phoneAllows(method: unknown): method is ApiMethod {
  return typeof method === 'string' && Object.hasOwn(PHONE_ACCESS, method) && PHONE_ACCESS[method as ApiMethod] === 'phone'
}
