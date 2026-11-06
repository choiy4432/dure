import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { UNINSTALL_CLEANUP_ARG } from '../src/main/uninstallCleanup'

// electron-builder 가 설정을 읽는 그 파서(js-yaml — app-builder-lib 의 의존성)로 읽는다
const { load } = createRequire(import.meta.url)('js-yaml') as { load(text: string): unknown }

type BuilderConfig = {
  nsis?: { oneClick?: unknown; perMachine?: unknown; deleteAppDataOnUninstall?: unknown; include?: unknown }
  asarUnpack?: unknown
  files?: unknown
}
const config = load(readFileSync(join(__dirname, '..', 'electron-builder.yml'), 'utf8')) as BuilderConfig

/**
 * 지우기(제거)가 사용자 데이터를 지우지 않게 — 2026-11-03 사고의 되풀이 막기.
 * electron-builder 제거 프로그램은 앱 데이터를 지울 때 `RMDir /r "$APPDATA\${APP_PACKAGE_NAME}"` 도 하는데,
 * 패키지 이름이 dure 라 윈도우(대소문자 무시)에선 %APPDATA%\Dure — 방·대화가 든 진짜 데이터 폴더다.
 */
describe('electron-builder.yml — 제거가 %APPDATA%\\Dure 를 지우지 않는다', () => {
  it('nsis.deleteAppDataOnUninstall 은 false', () => {
    expect(config.nsis?.deleteAppDataOnUninstall).toBe(false)
  })

  it('내보낸 그대로 — 한 번에 설치(oneClick) · 사용자별(perMachine: false)', () => {
    expect(config.nsis?.oneClick).toBe(true)
    expect(config.nsis?.perMachine).toBe(false)
  })
})

/**
 * 제거 때 휴대폰 연결 정리 — NSIS customUnInstall 이 `Dure.exe --uninstall-cleanup` 을 기다렸다 간다(두레가 연 serve 길·이 빌드의 로그인 항목).
 * 작고 안전하게: 끝 코드는 보지 않는다(정리가 실패해도 제거는 계속) · 업데이트(새 판이 옛 판을 지움)엔 부르지 않는다 · 아무것도 지우지 않는다.
 * 정리한 두레가 나간 뒤 1초 쉬고 electron-builder 의 '앱이 켜져 있나' 확인(un.checkAppRunning — 원클릭 제거는 이미 조용한 모드)을 한 번 더 —
 * 늦게 끝나는 Electron 도우미 프로세스가 파일을 쥔 채 RMDir /r $INSTDIR 가 돌지 않게
 */
describe('build/installer.nsh — 제거 때 휴대폰 연결 정리', () => {
  const script = readFileSync(join(__dirname, '..', 'build', 'installer.nsh'), 'utf8')
  // 주석(; …)을 뺀 명령 줄만
  const code = script
    .split(/\r?\n/)
    .map((l) => l.replace(/;.*$/, '').trim())
    .filter(Boolean)

  it('electron-builder.yml 의 nsis.include 가 이 파일', () => {
    expect(config.nsis?.include).toBe('build/installer.nsh')
  })

  it('customUnInstall 하나 — 업데이트가 아니면 설치 폴더의 그 exe 를 --uninstall-cleanup 으로 기다리고(끝 코드는 버림), 1초 쉬고 앱 확인을 한 번 더', () => {
    expect(code).toEqual([
      '!macro customUnInstall',
      '${ifNot} ${isUpdated}',
      `ExecWait '"$INSTDIR\\\${APP_EXECUTABLE_FILENAME}" ${UNINSTALL_CLEANUP_ARG}' $0`,
      'ClearErrors',
      'Sleep 1000',
      'Call un.checkAppRunning',
      '${endIf}',
      '!macroend',
    ])
  })

  it('다시 부르는 앱 확인은 electron-builder 제거 프로그램에 있는 그 함수 — 이름이 바뀌면 여기서 안다', () => {
    const uninstaller = readFileSync(
      join(createRequire(import.meta.url).resolve('app-builder-lib/package.json'), '..', 'templates', 'nsis', 'uninstaller.nsh'),
      'utf8',
    )
    expect(uninstaller).toMatch(/^Function un\.checkAppRunning\r?\n\s*!insertmacro CHECK_APP_RUNNING\r?\nFunctionEnd/m)
    // 원클릭 제거는 확인 뒤 조용한 모드 — 다시 부른 확인은 묻지 않고(/SD) 남은 두레 프로세스를 끈다
    expect(uninstaller).toMatch(/call un\.checkAppRunning\s+SetSilent silent/)
  })

  it('지우는 명령이 없다 — 앱 데이터(%APPDATA%\\Dure)·파일·레지스트리를 건드리지 않는다', () => {
    const text = code.join('\n')
    for (const bad of [/RMDir/i, /Delete/i, /DeleteReg/i, /APPDATA/i, /delete-app-data/i, /nsExec/i, /\bExec\b/]) expect(text).not.toMatch(bad)
  })
})

describe('electron-builder.yml — 휴대폰 묶음', () => {
  it('렌더러 출력(out/renderer)은 app.asar 밖으로 푼다 — 휴대폰 서버가 진짜 파일로 읽는다(phoneStaticDir 가 app.asar.unpacked 를 가리킴)', () => {
    expect(config.asarUnpack).toEqual(['out/renderer/**'])
    expect(config.files).toContain('out/**')
  })
})
