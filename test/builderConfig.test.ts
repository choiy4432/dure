import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { UNINSTALL_CLEANUP_ARG } from '../src/main/uninstallCleanup'

// electron-builder 가 설정을 읽는 그 파서(js-yaml — app-builder-lib 의 의존성)로 읽는다
const { load } = createRequire(import.meta.url)('js-yaml') as { load(text: string): unknown }

type BuilderConfig = {
  appId?: unknown
  productName?: unknown
  nsis?: { oneClick?: unknown; perMachine?: unknown; deleteAppDataOnUninstall?: unknown; include?: unknown; artifactName?: unknown; shortcutName?: unknown }
  win?: unknown
  mac?: Record<string, unknown>
  dmg?: Record<string, unknown>
  publish?: unknown
  asarUnpack?: unknown
  files?: unknown
  extraResources?: unknown
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

/**
 * Windows 설치 파일은 그대로 — mac 칸을 더해도 win·nsis·files·publish 는 한 글자도 바뀌지 않는다(설치 파일 이름 · 아이콘 · 싣는 파일)
 */
describe('electron-builder.yml — Windows 판은 그대로', () => {
  it('이름 · win · nsis 이름 · files · publish 가 지금 그대로', () => {
    expect(config.appId).toBe('io.github.choiy4432.dure')
    expect(config.productName).toBe('Dure')
    expect(config.win).toEqual({ target: 'nsis', icon: 'resources/icon.ico' })
    expect(config.nsis?.artifactName).toBe('Dure-Setup-${version}.${ext}')
    expect(config.nsis?.shortcutName).toBe('두레')
    // 트레이 템플릿 PNG 는 mac.files 에만 — Windows 설치 파일엔 안 실린다
    expect(config.files).toEqual(['out/**', 'resources/icon.ico', 'package.json'])
    expect(config.publish).toEqual({ provider: 'github', owner: 'choiy4432', repo: 'dure', releaseType: 'release' })
  })

  it('package.json — dist 는 그대로(--win), mac 은 dist:mac 따로', () => {
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')) as { scripts: Record<string, string>; name: string; productName: string }
    expect(pkg.scripts.dist).toBe('npm run build && electron-builder --win --publish never')
    expect(pkg.scripts['dist:mac']).toBe('npm run build && electron-builder --mac --publish never')
    expect([pkg.name, pkg.productName]).toEqual(['dure', 'Dure'])
  })
})

/**
 * mac 시험 빌드 — ad-hoc 서명(Apple Silicon 은 서명 없는 실행 파일을 안 띄운다 · 인증서가 없으면 electron-builder 는 ad-hoc 으로 물러서지 않는다),
 * hardened runtime 끔(ad-hoc + hardened 면 Electron 프레임워크를 라이브러리 검사가 거절), 공증 없음, dmg · zip × arm64 · x64
 */
describe('electron-builder.yml — mac', () => {
  const mac = config.mac ?? {}

  it('dmg · zip 을 arm64 · x64 로 — 이름에 arch', () => {
    expect(mac.target).toEqual([
      { target: 'dmg', arch: ['arm64', 'x64'] },
      { target: 'zip', arch: ['arm64', 'x64'] },
    ])
    expect(mac.artifactName).toBe('Dure-${version}-${arch}.${ext}')
    expect(config.dmg?.artifactName).toBe('Dure-${version}-${arch}.${ext}')
  })

  it('ad-hoc 서명(identity "-") · hardenedRuntime 끔 · 공증 없음 · 개발 도구 분류', () => {
    expect(mac.identity).toBe('-')
    expect(mac.hardenedRuntime).toBe(false)
    expect(mac.notarize).toBe(false)
    expect(mac.category).toBe('public.app-category.developer-tools')
  })

  it('아이콘은 1024 PNG · 메뉴 막대 템플릿 둘을 싣는다 — 세 파일이 실제로 있다', () => {
    expect(mac.icon).toBe('resources/icon-1024.png')
    expect(mac.files).toEqual(['resources/trayTemplate.png', 'resources/trayTemplate@2x.png'])
    for (const f of ['resources/icon-1024.png', 'resources/trayTemplate.png', 'resources/trayTemplate@2x.png']) expect(existsSync(join(__dirname, '..', f)), f).toBe(true)
  })

  it('이름은 Dure 그대로 — 제품 이름에 Claude Code 를 쓰지 않는다', () => {
    const text = readFileSync(join(__dirname, '..', 'electron-builder.yml'), 'utf8')
    expect(text).not.toMatch(/claude\s*code/i)
  })
})

/**
 * mac CI — 손으로만(workflow_dispatch) · 읽기 권한만 · 비밀 값 없음 · 릴리스에 올리지 않음(--publish never) · 산출물은 dmg · zip 만 14일
 */
describe('.github/workflows/mac-build.yml', () => {
  const text = readFileSync(join(__dirname, '..', '.github', 'workflows', 'mac-build.yml'), 'utf8')
  type Step = { uses?: string; run?: string; with?: Record<string, unknown> }
  const wf = load(text) as {
    on?: unknown
    permissions?: unknown
    jobs?: Record<string, { 'runs-on'?: unknown; env?: Record<string, unknown>; steps?: Step[]; permissions?: unknown }>
  }
  const job = wf.jobs?.build
  const steps = job?.steps ?? []
  const runs = steps.flatMap((s) => (s.run ? [s.run] : []))

  it('올바른 YAML — 트리거는 workflow_dispatch 하나뿐(푸시·PR 에 돌지 않는다)', () => {
    expect(wf.on).toEqual({ workflow_dispatch: null })
    expect(Object.keys(wf.jobs ?? {})).toEqual(['build'])
  })

  it('권한은 읽기만 · 비밀 값·토큰을 쓰지 않는다', () => {
    expect(wf.permissions).toEqual({ contents: 'read' })
    expect(job?.permissions).toBeUndefined()
    expect(text).not.toMatch(/secrets\./)
    expect(text).not.toMatch(/GH_TOKEN|GITHUB_TOKEN|CSC_LINK|APPLE_/)
    expect(steps.find((s) => s.uses?.startsWith('actions/checkout@'))?.with?.['persist-credentials']).toBe(false)
  })

  it('macOS 러너 · Node 는 package.json engines 안 · 인증서 자동 찾기 끔', () => {
    expect(job?.['runs-on']).toBe('macos-latest')
    const node = steps.find((s) => s.uses?.startsWith('actions/setup-node@'))?.with?.['node-version']
    expect(node).toBe(22)
    const engines = (JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')) as { engines: { node: string } }).engines.node
    expect(engines).toBe('>=20')
    expect(Number(node)).toBeGreaterThanOrEqual(20)
    expect(job?.env?.CSC_IDENTITY_AUTO_DISCOVERY).toBe('false')
  })

  it('차례 — npm ci → typecheck → 시험 → build → electron-builder(mac, arm64 · x64, 올리지 않음)', () => {
    expect(runs).toEqual([
      'npm ci',
      'npm run typecheck',
      'npm test',
      'npm run build',
      'mkdir -p resources/android',
      'npx electron-builder --mac --arm64 --x64 --publish never',
    ])
  })

  it('액션은 주 버전 꼬리표로 고정 · 산출물은 dmg · zip 만, 없으면 실패, 14일', () => {
    const uses = steps.flatMap((s) => (s.uses ? [s.uses] : []))
    expect(uses).toHaveLength(3)
    for (const u of uses) expect(u).toMatch(/^actions\/[a-z-]+@v\d+$/)
    const upload = steps.find((s) => s.uses?.startsWith('actions/upload-artifact@'))?.with ?? {}
    expect(String(upload.path).trim().split('\n')).toEqual(['dist/*.dmg', 'dist/*.zip'])
    expect(upload['if-no-files-found']).toBe('error')
    expect(upload['retention-days']).toBe(14)
  })
})

describe('electron-builder.yml — 휴대폰 묶음', () => {
  it('렌더러 출력(out/renderer)은 app.asar 밖으로 푼다 — 휴대폰 서버가 진짜 파일로 읽는다(phoneStaticDir 가 app.asar.unpacked 를 가리킴)', () => {
    expect(config.asarUnpack).toEqual(['out/renderer/**'])
    expect(config.files).toContain('out/**')
  })

  it('안드로이드 앱(dure.apk · dure.apk.json)을 resources/android 로 싣는다 — asar 밖(extraResources)', () => {
    expect(config.extraResources).toContainEqual({ from: 'resources/android', to: 'android', filter: ['dure.apk', 'dure.apk.json'] })
    expect(config.files).not.toContain('resources/android/**')
  })

  it('LICENSE · THIRD_PARTY_NOTICES.md(글꼴 OFL 고지)를 설치 파일에 함께 싣는다 — extraResources, 두 파일이 실제로 있다', () => {
    expect(config.extraResources).toContainEqual({ from: 'LICENSE', to: 'LICENSE' })
    expect(config.extraResources).toContainEqual({ from: 'THIRD_PARTY_NOTICES.md', to: 'THIRD_PARTY_NOTICES.md' })
    for (const f of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) expect(existsSync(join(__dirname, '..', f))).toBe(true)
  })
})
