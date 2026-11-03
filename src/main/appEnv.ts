/** 설치본에선 무시하는 시험용 환경 변수 — 사용자 PC 에 우연히 있어도 두레가 따르지 않는다. */
export const TEST_ENV_KEYS = [
  'DURE_USER_DATA',
  'DURE_E2E_FOLDERS',
  'DURE_E2E_SAVE_DIR',
  'DURE_SMOKE_EXIT_MS',
  'DURE_NO_DIALOG',
  'DURE_SLEEP_MINUTE_MS',
  'DURE_CLAUDE_COMMAND',
  'DURE_CLAUDE_ARGS',
  'DURE_SSH_COMMAND',
  'DURE_SSH_ARGS',
  'DURE_SETUP_INSTALL',
  'ELECTRON_RENDERER_URL',
] as const

export const APP_ID = 'io.github.choiy4432.dure'

/** packaged 면 시험용 키를 뺀 사본, 아니면 사본 그대로. */
export function appEnv(env: NodeJS.ProcessEnv, packaged: boolean): NodeJS.ProcessEnv {
  const copy = { ...env }
  if (packaged) for (const key of TEST_ENV_KEYS) delete copy[key]
  return copy
}

/** 설치본은 고정 id(바로가기·알림이 같은 앱으로 묶인다), 개발 실행은 execPath. */
export function appUserModelId(packaged: boolean, execPath: string): string {
  return packaged ? APP_ID : execPath
}
