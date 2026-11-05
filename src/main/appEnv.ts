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
  'DURE_TAILSCALE_COMMAND',
  'DURE_TAILSCALE_ARGS',
  'DURE_PHONE_ALLOW_LOCAL',
  'ELECTRON_RENDERER_URL',
] as const

export const APP_ID = 'io.github.choiy4432.dure'

/** packaged 면 시험용 키를 뺀 사본, 아니면 사본 그대로. */
export function appEnv(env: NodeJS.ProcessEnv, packaged: boolean): NodeJS.ProcessEnv {
  const copy = { ...env }
  if (packaged) for (const key of TEST_ENV_KEYS) delete copy[key]
  return copy
}

/** 작업표시줄 아이콘 파일 — 설치본의 resources 는 app.asar 안이라 셸이 못 읽는다. exe 가 아이콘을 품고 있으니 그걸 가리킨다. */
export function appIconFor(packaged: boolean, execPath: string, devIcon: string): { appIconPath: string; appIconIndex: number } {
  return { appIconPath: packaged ? execPath : devIcon, appIconIndex: 0 }
}

/** 설치본은 고정 id(바로가기·알림이 같은 앱으로 묶인다), 개발 실행은 execPath. */
export function appUserModelId(packaged: boolean, execPath: string): string {
  return packaged ? APP_ID : execPath
}
