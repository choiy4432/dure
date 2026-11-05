import { HIDDEN_ARG } from './window'

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

/**
 * 'Windows 를 켜면 두레도 켜기'(app.setLoginItemSettings) 의 값 — 숨겨 시작(HIDDEN_ARG).
 * 🔴 name 을 늘 준다: 안 주면 Windows Run 값 이름이 앱 id(APP_ID — 모든 설치본이 같다)라 시험 빌드(dure-…)가 진짜 두레의 값을 덮거나 지운다.
 * name 은 loginItemName(빌드의 package.json name). 끌 때도 같은 이름이어야 그 빌드의 값만 지운다
 */
export function loginItemSettings(open: boolean, name: string, exe: string): { openAtLogin: boolean; name: string; path: string; args: string[] } {
  return { openAtLogin: open, name, path: exe, args: [HIDDEN_ARG] }
}

/**
 * 로그인 항목 이름 — 빌드에 실린 package.json 의 name(진짜 두레 'dure' · 시험 빌드는 CLAUDE.md 대로 -c.extraMetadata.name=dure-… 라 늘 다르다).
 * app.getName() 을 바로 쓰지 않는다: productName 을 먼저 보는데, package.json 의 productName('Dure')은 -c.productName 으로는 안 바뀐다(2026-11-05 시험 빌드 실측).
 * 못 읽었거나 꼴이 틀리면 fallback(app.getName())
 */
export function loginItemName(pkg: unknown, fallback: string): string {
  const name = pkg && typeof pkg === 'object' && !Array.isArray(pkg) ? (pkg as { name?: unknown }).name : undefined
  return typeof name === 'string' && name.trim() !== '' ? name.trim() : fallback
}
