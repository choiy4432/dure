/** 엔진 없이 도는 앱 쪽 일(앱 설정·준비·업데이트)의 모양 — main·preload·renderer 가 함께 쓴다 */
import type { PhoneState } from './phoneTypes'

/**
 * 앱 설정 — settings.json 에 엔진 설정과 나란히(main 의 appPrefs.ts)
 * trayTipSeen: 창을 닫아 트레이로 숨었을 때의 첫 안내('두레는 트레이에서 계속 돌아요')를 봤다(main 이 써 둔다)
 */
export type AppPrefs = { tourDone: boolean; approvalTipSeen: boolean; claudeAutoUpdate: boolean; trayTipSeen: boolean }

/** 칸이 없거나 불리언이 아니면 이 값 */
export const DEFAULT_APP_PREFS: AppPrefs = { tourDone: false, approvalTipSeen: false, claudeAutoUpdate: true, trayTipSeen: false }

export type AppInfo = { version: string; packaged: boolean }

/** 준비 화면 1 — claude 설치. running·failed 의 lines 는 설치 출력의 마지막 줄들 */
export type InstallStep =
  | { state: 'todo' }
  | { state: 'running'; lines: string[] }
  | { state: 'failed'; message: string; lines: string[] }
  | { state: 'done'; version: string | null }

/** 준비 화면 2 — 로그인. 설치 전엔 locked */
export type LoginStep =
  | { state: 'locked' }
  | { state: 'todo' }
  | { state: 'waiting' }
  | { state: 'failed'; message: string }

export type SetupState =
  | { phase: 'checking' }
  | { phase: 'ready' }
  | { phase: 'relaunching' }
  | { phase: 'needs'; install: InstallStep; login: LoginStep }

/** 두레 자기 업데이트 — dev 는 개발 실행(확인하지 않음) */
export type UpdateState =
  | { kind: 'dev' }
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'none' }
  | { kind: 'available'; version: string; current: string; highlights: string[]; url: string }
  | { kind: 'downloading'; version: string; percent: number }
  | { kind: 'ready'; version: string }
  | { kind: 'error'; message: string; version: string | null }

/** 켤 때 claude 최신으로 */
export type ClaudeUpdateState = 'idle' | 'running' | 'done'

/** 앱 사건 — 엔진 사건과 같은 봉투로 같은 채널에(PC 창에만 — 휴대폰엔 엔진 사건만 간다) */
export type AppEventMap = { setup: SetupState; update: UpdateState; 'claude-update': ClaudeUpdateState; phone: PhoneState }
