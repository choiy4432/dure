import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, nativeTheme, Notification, powerMonitor, powerSaveBlocker, shell, Tray } from 'electron'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import electronUpdater from 'electron-updater'
import { killTree } from '../engine/killTree'
import { authStatus, claudeEnv, claudeVersion, createEngine, locateClaude } from '../engine'
import { homedir } from 'node:os'
import { formatLogArgs, makeFatalReporter, openLog } from './log'
import { startFailureMessage } from './startFailure'
import type { Engine } from '../engine'
import type { AppEventMap, ClaudeUpdateState } from '../shared/appTypes'
import { appEnv, appIconFor, appUserModelId, loginItemNamer, loginItemSettings } from './appEnv'
import { initAppPrefsSafe, writeAppPrefs } from './appPrefs'
import { resolveClaudeCommand, resolveSshCommand, type ClaudeCommand } from './claudeCommand'
import { cmdArgs, startWaitLine } from './cmdLine'
import { updateClaude, type ClaudeUpdateRun } from './claudeUpdate'
import { createQuitControl } from './quit'
import { createUpdater, RELEASE_URL, type UpdaterLike } from './updater'
import { createSetupFlow, type SetupFlow } from './setupFlow'
import { runStartup } from './startup'
import { logEngineErrors, registerIpc, type AppHost, type IpcDeps } from './ipc'
import { createDispatcher } from './dispatch'
import { createPhoneController, phoneStaticDir, type PhoneController } from './phone/phoneController'
import { createTailscale, resolveTailscaleCommand } from './phone/tailscale'
import { createTrayControl, startHidden, trayTipOnce, TRAY_TIP, type TrayControl } from './tray'
import { UNINSTALL_CLEANUP_ARG, uninstallCleanup, uninstallHardCap } from './uninstallCleanup'
import { appPageMatcher, focusExisting, guardNavigation, HIDDEN_ARG, withoutHiddenArg } from './window'
import { TITLE_BAR_HEIGHT, veiledColor, windowColors } from './windowTheme'

let mainWindow: BrowserWindow | null = null
let engine: Engine | null = null
let exitCode = 0
let setup: SetupFlow | null = null
/** 휴대폰 연결 — 끌 때 길(tailscale serve)·서버·절전 막기를 거둔다 */
let phone: PhoneController | null = null
const phoneNow = (): PhoneController => {
  if (!phone) throw new Error('휴대폰 연결을 아직 준비하는 중이에요')
  return phone
}
/** 휴대폰 연결이 켜져 있나(설정 값 — 길이 아직 안 열렸어도 켜짐) — 못 읽으면 꺼짐으로(창 닫기가 지금처럼 두레를 끈다) */
const phoneOn = (): boolean => {
  try {
    return phone?.state().settings.enabled ?? false
  } catch {
    return false
  }
}
/** 트레이 — 늘 있다. 창을 닫으면 숨긴다(tray.ts) */
let tray: TrayControl | null = null
/** 처음 숨을 때 안내 알림 — 누름을 받으려면 붙들어 둔다(안 그러면 GC 가 거둔다) */
let trayTipNote: Notification | null = null
/** 숨겨 시작(로그인 항목의 --hidden) — 트레이가 정말 있을 때만 창을 띄우지 않는다(startHidden) */
const launchedHidden = process.argv.includes(HIDDEN_ARG)
/** 창이 생기기 전(엔진 준비 중)에 두레를 또 켰다 — 그러면 숨겨 시작이어도 창을 보인다 */
let showRequested = false
/** Windows 로그아웃·끄기 — 그때 오는 창 닫기는 숨기지 않는다 */
let sessionEnding = false
/** 'PC 쓰는 중' — Windows 의 마지막 입력 뒤 이만큼(초) 안이고 잠금 화면이 아님(powerMonitor) → 휴대폰은 안 울린다 */
const PHONE_IDLE_S = 120
/** 켤 때 도는 `claude update` — 끄면 나무째 끈다(Windows 는 자식이 부모보다 오래 산다) */
let claudeUpdateRun: ClaudeUpdateRun | null = null

/** 끄는 길의 기다림 상한 — 이만큼 지나면 기다리지 않고 끈다 */
const QUIT_KILL_WAIT_MS = 3000
const bounded = (p: Promise<void> | undefined): Promise<void> =>
  Promise.race([p, new Promise<void>((r) => setTimeout(r, QUIT_KILL_WAIT_MS))])

/** 공식 설치 안내 */
const SETUP_GUIDE_URL = 'https://code.claude.com/docs/en/setup'
/** 공식 설치 스크립트 — 이 길만 쓴다 */
const INSTALL_COMMAND = {
  command: 'powershell.exe',
  args: [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
    '[Console]::OutputEncoding=[Text.Encoding]::UTF8; irm https://claude.ai/install.ps1 | iex',
  ],
}

/** Test-only: DURE_SETUP_INSTALL (JSON argv 배열) — 설치 명령을 가짜로 바꾼다. env 는 설치본에선 걸러진 사본 */
function installCommand(raw: string | undefined): { command: string; args: string[] } {
  if (!raw) return INSTALL_COMMAND
  const bad = new Error('DURE_SETUP_INSTALL 은 JSON 배열이어야 해요')
  let list: unknown
  try {
    list = JSON.parse(raw)
  } catch {
    throw bad
  }
  if (!Array.isArray(list) || list.length === 0 || !list.every((x) => typeof x === 'string')) throw bad
  return { command: list[0] as string, args: (list as string[]).slice(1) }
}

/** 설치 스크립트를 돌리고 출력(stdout·stderr)을 줄로 쪼개 넘긴다 */
function spawnInstall(onLine: (l: string) => void): { done: Promise<{ code: number | null }>; kill(): Promise<void> } {
  const cmd = installCommand(env.DURE_SETUP_INSTALL)
  const child = spawn(cmd.command, cmd.args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: claudeEnv(process.env) })
  const feed = (stream: NodeJS.ReadableStream | null): void => {
    let rest = ''
    stream?.setEncoding('utf8')
    stream?.on('data', (chunk: string) => {
      rest += chunk
      const parts = rest.split(/\r\n|\n|\r/)
      rest = parts.pop() ?? ''
      for (const l of parts) onLine(l)
    })
    stream?.on('end', () => {
      if (rest) onLine(rest)
    })
  }
  feed(child.stdout)
  feed(child.stderr)
  const done = new Promise<{ code: number | null }>((resolve, reject) => {
    child.on('error', reject)
    child.on('close', (code) => resolve({ code }))
  })
  // PowerShell 이 받아 돌리는 claude.exe install 은 자식이라 child.kill() 로는 안 꺼진다 — 나무째 끈다
  return { done, kill: () => (child.pid ? killTree(child.pid) : Promise.resolve()) }
}

/**
 * 로그인 — 새 콘솔 창에서 `claude auth login --claudeai` (브라우저가 열린다). 창 없이 되는지(D1)는 아직 실측 전이라 이 선택을 여기 한 곳에 둔다.
 * `start /wait` 라 cmd 가 claude 를 기다리며 살아 있고 claude 는 cmd 의 자식 — kill() 은 cmd 를 나무째 꺼 콘솔 창까지 닫고, 끝날 때까지 기다린다.
 * 줄은 cmdLine 이 직접 만든다(경로에 & ^ % 가 있어도 cmd 가 나누거나 펼치지 않게).
 */
function spawnLogin(c: ClaudeCommand): { kill(): Promise<void> } {
  const line = startWaitLine(c.command, [...c.argsPrefix, 'auth', 'login', '--claudeai'])
  const child = spawn('cmd.exe', cmdArgs(line), {
    windowsHide: true,
    windowsVerbatimArguments: true,
    detached: true,
    stdio: 'ignore',
    env: claudeEnv(process.env),
  })
  let alive = true
  const gone = (): void => {
    alive = false
  }
  child.on('exit', gone)
  child.on('error', gone)
  child.unref()
  // 이미 끝난 cmd 는 끄지 않는다 — 그 pid 를 다른 프로세스가 물려받았을 수 있다
  return { kill: () => (alive && child.pid ? killTree(child.pid) : Promise.resolve()) }
}

/** 앱 사건을 받는 곳 — registerIpc 가 onAppEvent 로 창 쪽을 단다 */
const appEventSinks: ((name: keyof AppEventMap, payload: unknown) => void)[] = []
/** 앱 사건 내기(준비 흐름·claude 최신으로·두레 업데이트가 이걸로) — 엔진이 없어도 창에 간다 */
function emitApp<K extends keyof AppEventMap>(name: K, payload: AppEventMap[K]): void {
  for (const fn of appEventSinks) fn(name, payload)
}

// Test-only hook: DURE_USER_DATA isolates the data folder (and the single-instance lock, which lives there) — set before anything reads it.
// 설치본(app.isPackaged)에선 시험용 환경 변수를 모두 무시한다 — 아래 env 만 읽는다.
const env = appEnv(process.env, app.isPackaged)
if (env.DURE_USER_DATA) app.setPath('userData', env.DURE_USER_DATA)

const home = homedir()

/** 설치본엔 콘솔이 없다 — 오류는 <userData>/logs/dure.log 에도 남긴다. 오류 글만(대화 글·토큰·쿠키는 쓰지 않는다) */
const fileLog = openLog(join(app.getPath('userData'), 'logs'), { home })
function logError(...args: unknown[]): void {
  console.error(...args)
  fileLog.write(formatLogArgs(args)) // 홈 경로는 openLog 가 ~ 로 가린다
}
const reportFatal = makeFatalReporter({ log: logError, showBox: (t, b) => dialog.showErrorBox(t, b), noDialog: process.env.DURE_NO_DIALOG === '1', home })
process.on('uncaughtException', reportFatal)
process.on('unhandledRejection', (reason) => logError('[두레] unhandledRejection:', reason))

/** Test-only hook: DURE_E2E_FOLDERS (JSON array) — pickFolder hands these out in order instead of opening the dialog, then null. */
function e2eFolders(raw: string | undefined): (() => string | null) | null {
  if (!raw) return null
  const bad = new Error('DURE_E2E_FOLDERS 는 JSON 배열이어야 해요')
  let list: unknown
  try {
    list = JSON.parse(raw)
  } catch {
    throw bad
  }
  if (!Array.isArray(list) || !list.every((x) => typeof x === 'string')) throw bad
  let next = 0
  return () => (next < list.length ? list[next++] : null)
}

// Windows 알림·작업표시줄 묶음이 앱을 알아보게 — 설치본은 고정 ID, 개발 실행은 execPath
if (process.platform === 'win32') app.setAppUserModelId(appUserModelId(app.isPackaged, process.execPath))

/** 로그인 항목 이름 — 빌드에 실린 package.json 의 name(시험 빌드는 dure-…). 처음 한 번 읽고, 못 읽으면 null(로그 한 번) */
const loginName = loginItemNamer(() => readFileSync(join(app.getAppPath(), 'package.json'), 'utf8'), console.error)

/**
 * 이 빌드의 'Windows 를 켜면 두레도 켜기' 켜기·끄기 — 🔴 설치본만(개발 실행·시험은 건드리지 않는다).
 * 이름은 빌드마다(loginName) — 시험 빌드가 진짜 두레의 값을 덮거나 지우지 않게(loginItemSettings). 이름을 못 읽으면 건드리지 않는다
 */
function setLoginItem(open: boolean): void {
  if (!app.isPackaged) return
  const name = loginName()
  if (name !== null) app.setLoginItemSettings(loginItemSettings(open, name, process.execPath))
}

const indexFile = join(__dirname, '../renderer/index.html')
/** 앱 아이콘(D 넘김) — 창·작업표시줄. 굽는 법은 scripts/icon/build.mjs */
const appIcon = join(__dirname, '../../resources/icon.ico')
/** 두레 화면 자신의 주소인가 — IPC 요청·창 안 이동을 이걸로 가린다 */
const isAppPage = appPageMatcher({ devUrl: env.ELECTRON_RENDERER_URL, indexFile })

/** 창 바탕·창 단추를 지금 테마로 — 테마를 바꾸거나 Windows 가 바꾸면(Windows 따라감) 다시 칠한다 */
let tourVeil = false
function paintWindow(win: BrowserWindow): void {
  if (win.isDestroyed()) return
  const dark = nativeTheme.shouldUseDarkColors
  const c = windowColors(dark)
  win.setBackgroundColor(c.bg)
  // 투어 막이 떠 있으면 창 단추 띠도 막 색으로(Windows 가 웹 화면 위에 그려 막이 못 덮는다)
  win.setTitleBarOverlay({ color: tourVeil ? veiledColor(dark) : c.bg, symbolColor: c.symbol, height: TITLE_BAR_HEIGHT })
}

/** hidden: 숨겨 시작 — ready-to-show 에서 보이지 않는다(트레이만). 두레를 또 켜거나 트레이를 누르면 focusExisting 이 보인다 */
function createWindow(o: { hidden: boolean }): BrowserWindow {
  const c = windowColors(nativeTheme.shouldUseDarkColors)
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    // 처음 칠도 테마로 — 화면이 뜨기 전 흰 창이 번쩍이지 않게
    backgroundColor: c.bg,
    // Windows 제목 표시줄 대신 두레 위 띠 — 최소화·최대화·닫기는 Windows 단추를 위 띠 오른쪽에 겹친다(창 배치 메뉴 그대로)
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: c.bg, symbolColor: c.symbol, height: TITLE_BAR_HEIGHT },
    autoHideMenuBar: true,
    icon: appIcon,
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  // 작업표시줄 단추의 아이콘·이름 — 고정(pin)할 때도 이 아이콘으로(개발 실행은 electron.exe 라 이게 없으면 Electron 아이콘)
  if (process.platform === 'win32') {
    win.setAppDetails({
      appId: appUserModelId(app.isPackaged, process.execPath),
      ...appIconFor(app.isPackaged, process.execPath, appIcon),
      // 숨겨 켜진 두레를 고정해도, 고정 단추로 켜면 창이 뜨게 — --hidden 은 뺀다
      relaunchCommand: withoutHiddenArg(process.argv).map(a => `"${a}"`).join(' '),
      relaunchDisplayName: '두레',
    })
  }
  win.once('ready-to-show', () => {
    if (!o.hidden) win.show()
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  guardNavigation(win.webContents, isAppPage)
  // 사용자가 창을 보면 깜박임을 그친다 — 안 끄면 단추가 계속 주황색으로 남는다
  win.on('focus', () => win.flashFrame(false))
  // 닫힌 창을 붙들지 않는다 — 끄는 동안(최대 5초) 또 켜면 second-instance 가 파괴된 창을 건드려 오류 상자가 떴다
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null
  })
  // Windows 로그아웃·끄기 — 휴대폰 연결 중이어도 창 닫기를 막지 않는다
  win.on('session-end', () => {
    sessionEnding = true
  })
  if (env.ELECTRON_RENDERER_URL) {
    void win.loadURL(env.ELECTRON_RENDERER_URL)
  } else {
    void win.loadFile(indexFile)
  }
  return win
}

if (process.argv.includes(UNINSTALL_CLEANUP_ARG)) {
  // 제거 프로그램이 부른 정리(build/installer.nsh) — 창·트레이·엔진 없이 두레가 연 serve 길과 이 빌드의 로그인 항목만 끄고 늘 0 으로 나간다.
  // 한 인스턴스 잠금은 잡지 않는다(켜진 두레가 second-instance 로 창을 띄우지 않게). 🔴 로그인 항목은 설치본만(개발 실행·시험은 건드리지 않는다)
  // 맨 먼저 전체 상한(15초) — 어디서 멈춰도 제거 프로그램(ExecWait)을 붙잡지 않는다
  uninstallHardCap((code) => app.exit(code))
  void app
    .whenReady()
    .then(() =>
      uninstallCleanup({
        dataDir: app.getPath('userData'),
        tailscale: createTailscale(resolveTailscaleCommand(env)),
        removeLoginItem: () => setLoginItem(false),
      }),
    )
    .catch(() => {})
    .finally(() => app.exit(0))
} else if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  // 창이 아직 없으면(숨겨 시작이 엔진을 기다리는 중) 잃지 않게 적어 둔다 — 창을 만들 때 숨기지 않는다
  app.on('second-instance', () => {
    if (mainWindow) focusExisting(mainWindow)
    else showRequested = true
  })

  // 끄는 길 — before-quit 과 업데이트 설치(beforeInstall)가 같은 정리 하나를 쓴다(두 번 끄지 않는다). 판단은 quit.ts
  const quitControl = createQuitControl({
    // 설치 나무·claude update 나무 끄기는 길어야 3초만 기다린다 — 엔진 끄기와 같이. 실패해도 끝난 것으로 친다
    // 휴대폰 연결(serve 끄기 포함)도 길어야 3초 — 못 끈 길은 phone.json 에 적혀 있어 다음 시작 때 그 짝만 정리한다
    shutdown: async () => {
      // 트레이는 바로 거둔다 — 끄는 동안(최대 3초) 메뉴를 또 누르지 않게, 끈 뒤 알림 영역에 빈 아이콘이 남지 않게
      tray?.dispose()
      await Promise.all([bounded(setup?.dispose()), bounded(claudeUpdateRun?.kill()), bounded(phone?.dispose()), engine?.shutdown()])
    },
    exit: () => app.exit(exitCode),
  })
  // 정리가 끝난 뒤에만 그냥 나간다(설치의 quitAndInstall → app.quit 도 여기로) — 끄는 중이면 막고 끝나길 기다린다.
  // 설치 정리 중이면 정리 뒤 설치 흐름이 스스로 나가게 두고, 잠시 뒤에도 안 나가면 끈다
  app.on('before-quit', (event) => quitControl.beforeQuit(event))

  app.on('window-all-closed', () => app.quit())

  // Test-only hooks: DURE_SMOKE_EXIT_MS (self-quit after N ms), DURE_NO_DIALOG=1 (skip the error box, still exit 1),
  // DURE_USER_DATA and DURE_E2E_FOLDERS (above) — the E2E (e2e/app.spec.ts) sets them with DURE_CLAUDE_COMMAND/ARGS.
  // DURE_E2E_SAVE_DIR — saveText writes there without the save dialog.
  void app
    .whenReady()
    .then(async () => {
      const nextE2eFolder = e2eFolders(env.DURE_E2E_FOLDERS)
      const claude = resolveClaudeCommand(env, () => locateClaude())
      // Test-only: DURE_SLEEP_MINUTE_MS shortens the sleep timer ('1 minute' and the sweep interval) so the E2E sees an agent fall asleep in seconds.
      const sleepMs = Number(env.DURE_SLEEP_MINUTE_MS)
      const sleepKnob = Number.isFinite(sleepMs) && sleepMs > 0 ? { sleepMinuteMs: sleepMs, sleepSweepMs: sleepMs } : {}
      const userData = app.getPath('userData')
      if (claude) {
        engine = await createEngine({
          dataDir: userData,
          claude,
          // 서버(SSH) 방 — 기본은 윈도우 OpenSSH, 시험·개발은 DURE_SSH_COMMAND/ARGS
          ssh: resolveSshCommand(env),
          autoStart: false,
          // 켤 때 claude 최신으로 — 서버 방도. 설정을 나중에 바꿔도 따라가게 그때그때 현재 prefs 를 본다
          claudeAutoUpdate: () => prefs.claudeAutoUpdate,
          ...sleepKnob,
        })
        logEngineErrors(engine, logError)
      }
      // 준비 흐름 — claude 찾기·설치·로그인. 엔진이 못 만들어졌으면(claude 없음) 로그인 뒤 두레를 다시 켠다
      const setupFlow = createSetupFlow({
        claude: () => resolveClaudeCommand(env, () => locateClaude()),
        loggedIn: async (c) => (await authStatus(c)).loggedIn,
        version: (c) => claudeVersion(c),
        spawnInstall,
        spawnLogin,
        relaunch: () => {
          // 창에서 로그인한 뒤라 — 숨겨 켜졌었어도(--hidden) 다시 켤 땐 창이 뜨게
          app.relaunch({ args: withoutHiddenArg(process.argv.slice(1)) })
          app.quit() // before-quit 의 끄기를 지난다
        },
        hasEngine: engine !== null,
        emit: (s) => emitApp('setup', s),
      })
      setup = setupFlow
      // 앱 설정 — 엔진과 같은 settings.json. tourDone 칸이 없으면 방이 있을 때 업데이트로 받은 사람(투어·승인 안내를 본 것으로),
      // 없을 때 새 사용자(tourDone:false)로 써 둔다. 엔진이 없으면 방 수를 모르니 쓰지 않는다. 쓰기가 실패해도 시작은 계속한다(읽은 값으로)
      let prefs = initAppPrefsSafe(userData, engine ? engine.rooms().length > 0 : null)
      // 켤 때 claude 최신으로 — 지금 상태(창이 늦게 떠도 처음 상태를 이걸로 받는다)
      let claudeUpdateState: ClaudeUpdateState = 'idle'
      // 엔진 시작(갱신 뒤)이 끝나면 풀린다 — 그 전엔 claude 를 띄우는 엔진 메서드가 기다린다
      let markEngineReady!: () => void
      const engineReady = new Promise<void>((r) => (markEngineReady = r))
      // 두레 업데이트 — 설치본만 electron-updater(ESM 이라 기본 내보내기에서 꺼낸다). 개발 실행은 늘 'dev'
      const updater = createUpdater({
        updater: app.isPackaged ? (electronUpdater.autoUpdater as unknown as UpdaterLike) : null,
        current: app.getVersion(),
        // quitAndInstall 은 before-quit 을 거치지 않을 수 있다 — 엔진을 먼저 끄고, 끄는 길이 겹쳐 또 끄지 않게 한다.
        // 정리가 실패하면 던진다 → 설치하지 않고 error 상태(다시 켜기를 또 누르면 정리 없이 설치 — updater.ts prepared)
        beforeInstall: () => quitControl.prepareInstall(),
        emit: (s) => emitApp('update', s),
      })
      // 엔진 없이 도는 앱 쪽 일 — appInfo·prefs·setPrefs·준비 흐름·claude 최신으로·두레 업데이트
      const appHost: AppHost = {
        async appInfo() {
          return { version: app.getVersion(), packaged: app.isPackaged }
        },
        async prefs() {
          return prefs
        },
        async setPrefs(p) {
          prefs = writeAppPrefs(userData, p)
          return prefs
        },
        async setupState() {
          return setupFlow.state()
        },
        async installClaude() {
          await setupFlow.install()
        },
        async loginClaude() {
          await setupFlow.login()
        },
        async openSetupGuide() {
          await shell.openExternal(SETUP_GUIDE_URL)
        },
        async claudeUpdateState() {
          return claudeUpdateState
        },
        async updateState() {
          return updater.state()
        },
        async checkUpdate() {
          return updater.check()
        },
        async downloadUpdate() {
          await updater.download()
        },
        async installUpdate() {
          await updater.install()
        },
        async setTourVeil(on) {
          tourVeil = on
          if (mainWindow) paintWindow(mainWindow)
        },
        async openReleasePage() {
          const s = updater.state()
          if ('version' in s && s.version) await shell.openExternal(RELEASE_URL(s.version))
        },
        // 휴대폰 연결 — 아래에서 만든다(만들기 전에 불릴 일은 없지만 그러면 한국어로 거절)
        async phoneState() {
          return phoneNow().state()
        },
        async setPhone(p) {
          await phoneNow().set(p)
        },
        async phoneCheck() {
          return phoneNow().check()
        },
        async phonePairStart() {
          return phoneNow().pairStart()
        },
        async phonePairCancel() {
          phoneNow().pairCancel()
        },
        async phoneUnpair(id) {
          phoneNow().unpair(id)
        },
        async phoneNoticeSeen() {
          phoneNow().noticeSeen()
        },
      }
      // 저장한 화면 테마를 Windows 에 알린다 — 화면의 prefers-color-scheme·제목 표시줄 단추·스크롤바가 따른다(claude 가 없으면 Windows 따라감)
      nativeTheme.themeSource = engine?.theme() ?? 'system'
      nativeTheme.on('updated', () => {
        if (mainWindow) paintWindow(mainWindow)
      })
      // 순서: 엔진 만들기 → 앱 설정 → 테마 → 휴대폰 연결 → registerIpc(리스너 붙이기) → 창 → 준비 확인 → claude 최신으로 → engine.start() → engineReady.
      // claude 가 없으면 engine 은 null 이고 snapshot 이 claudeMissing 을 알린다.
      const ipcDeps: IpcDeps = {
        async pickFolder() {
          if (nextE2eFolder) return nextE2eFolder()
          // 창을 부모로 — 앱 뒤에 숨지 않는 모달 대화상자
          const options: Electron.OpenDialogOptions = { properties: ['openDirectory'] }
          const r = mainWindow && !mainWindow.isDestroyed()
            ? await dialog.showOpenDialog(mainWindow, options)
            : await dialog.showOpenDialog(options)
          return r.canceled || r.filePaths.length === 0 ? null : r.filePaths[0]
        },
        async openFolder(path) {
          const err = await shell.openPath(path)
          if (err) throw new Error(err)
        },
        async openPath(path) {
          // 첨부 사본 — ipc 가 엔진이 첨부 폴더 안으로 푼 경로만 넘긴다. 못 열면(연결된 프로그램 없음 등) 빈 글이 아닌 까닭이 온다
          const err = await shell.openPath(path)
          if (err) throw new Error(err)
        },
        showInFolder(path) {
          shell.showItemInFolder(path)
        },
        async openExternal(url) {
          await shell.openExternal(url)
        },
        async saveText(fileName, text) {
          const testDir = env.DURE_E2E_SAVE_DIR
          if (testDir) {
            const file = join(testDir, fileName)
            await writeFile(file, text, 'utf8')
            return file
          }
          // 처음 자리는 문서 폴더 — 저장 창은 창을 부모로(앱 뒤에 숨지 않게)
          const options: Electron.SaveDialogOptions = {
            defaultPath: join(app.getPath('documents'), fileName),
            filters: [{ name: '마크다운', extensions: ['md'] }],
          }
          const r = mainWindow && !mainWindow.isDestroyed()
            ? await dialog.showSaveDialog(mainWindow, options)
            : await dialog.showSaveDialog(options)
          if (r.canceled || !r.filePath) return null
          await writeFile(r.filePath, text, 'utf8')
          return r.filePath
        },
        async setTaskbar(count, png) {
          if (!mainWindow || mainWindow.isDestroyed()) return
          mainWindow.setOverlayIcon(
            png && count > 0 ? nativeImage.createFromDataURL(png) : null,
            count > 0 ? `할 일 ${count}개` : '',
          )
        },
        async flashWindow() {
          // 이미 보고 있는 창은 깜박일 이유가 없다
          if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isFocused()) return
          mainWindow.flashFrame(true)
        },
        async focusWindow() {
          focusExisting(mainWindow)
        },
        applyTheme(t) {
          nativeTheme.themeSource = t // 'updated' 사건이 창을 다시 칠한다
        },
        isAppPage,
        app: appHost,
        // 켤 때 claude 최신으로가 끝나고 엔진이 시작하면 풀린다(runStartup)
        engineReady,
        onAppEvent(fn) {
          appEventSinks.push(fn)
        },
      }
      // 트레이 — 늘 있다. 메뉴·툴팁은 휴대폰 연결 켜짐을 따른다('phone' 사건·아래 sync). 아이콘은 창과 같은 앱 아이콘. [두레 끄기]는 app.quit() → before-quit 의 끄는 길 그대로
      tray = createTrayControl({
        makeTray(spec) {
          const t = new Tray(appIcon)
          const apply = (s: Pick<typeof spec, 'tooltip' | 'menu'>) => {
            t.setToolTip(s.tooltip)
            t.setContextMenu(Menu.buildFromTemplate(s.menu.map((m) => ({ label: m.label, click: () => m.click() }))))
          }
          apply(spec)
          t.on('click', () => spec.onClick())
          return { update: apply, destroy: () => t.destroy() }
        },
        showWindow: () => focusExisting(mainWindow),
        phoneOff() {
          // 끄기가 끝나면 'phone' 사건이 메뉴를 맞춘다 — 사건이 안 와도 지금 값으로 한 번 더 맞춘다
          void phoneNow()
            .set({ enabled: false })
            .catch(() => console.error('[두레] 휴대폰 연결을 끄지 못했어요'))
            .finally(() => tray?.sync(phoneOn()))
        },
        quit: () => app.quit(),
        // 처음 숨을 때 한 번 — 본 것은 settings.json 의 trayTipSeen(창의 setPrefs 와 같은 파일·같은 prefs)
        notifyOnce: trayTipOnce({
          seen: () => prefs.trayTipSeen,
          markSeen: () => {
            prefs = writeAppPrefs(userData, { trayTipSeen: true })
          },
          notify: () => {
            if (!Notification.isSupported()) throw new Error('알림을 쓸 수 없어요')
            const n = new Notification({ title: '두레', body: TRAY_TIP, icon: appIcon })
            n.on('click', () => focusExisting(mainWindow))
            n.on('close', () => {
              if (trayTipNote === n) trayTipNote = null
            })
            trayTipNote = n
            n.show()
          },
        }),
      })
      // 휴대폰 연결 — 엔진 다음. 휴대폰은 창과 같은 디스패처를 허용 목록(phoneDispatcher)으로 감싸 탄다. 꺼져 있으면 tailscale 을 부르지 않는다.
      // 🔴 개발 실행·시험은 로그인 항목을 건드리지 않는다(설치본만). DURE_TAILSCALE_*·DURE_PHONE_ALLOW_LOCAL 은 설치본에선 걸러진다(appEnv)
      phone = createPhoneController({
        dataDir: userData,
        engine,
        dispatch: createDispatcher(engine, ipcDeps),
        staticDir: phoneStaticDir(__dirname, app.isPackaged),
        androidDir: app.isPackaged ? join(process.resourcesPath, 'android') : join(app.getAppPath(), 'resources', 'android'),
        // 개발 실행·시험 빌드(dure-…)만 시험 패키지 앱도 — 진짜 빌드는 진짜 패키지만. 빌드 이름을 못 읽으면 진짜로 본다
        androidTest: !app.isPackaged || (loginName() !== null && loginName() !== 'dure'),
        tailscale: createTailscale(resolveTailscaleCommand(env)),
        power: {
          start: () => powerSaveBlocker.start('prevent-app-suspension'),
          stop: (id) => powerSaveBlocker.stop(id),
        },
        idle: () => powerMonitor.getSystemIdleState(PHONE_IDLE_S),
        // PC 를 잠그면 — PC 앞이라 미룬 휴대폰 알림을 그 자리에서(잠그지 않고 떠나면 2분 뒤 다시 보기가)
        pcAway: (fn) => {
          powerMonitor.on('lock-screen', fn)
          return () => powerMonitor.off('lock-screen', fn)
        },
        // 잠에서 깨면 — 길(Tailscale 업데이트·PC 이름 바뀜)을 한 번 다시 확인
        pcResume: (fn) => {
          powerMonitor.on('resume', fn)
          return () => powerMonitor.off('resume', fn)
        },
        loginItem: { set: (open) => setLoginItem(open) },
        emit: (s) => {
          emitApp('phone', s)
          tray?.sync(s.settings.enabled)
        },
        allowLocal: env.DURE_PHONE_ALLOW_LOCAL === '1',
      })
      // 트레이를 지금 만든다(휴대폰 연결이 켜진 채 시작하면 길이 열리기 전에도 메뉴가 맞게)
      tray.sync(phoneOn())
      registerIpc(
        ipcMain,
        engine,
        (ch, payload) => {
          if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(ch, payload)
        },
        ipcDeps,
      )
      // 트레이를 못 만들었거나(기록만 남는다) 그사이 두레를 또 켰으면 숨기지 않는다 — 창도 트레이도 없는 두레가 되지 않게
      const win = createWindow({
        hidden: startHidden({ launchedHidden, trayActive: tray.active(), showRequested }),
      })
      mainWindow = win
      // 창 닫기(×) — 막고 숨긴다(트레이로). 끄는 중(before-quit 이 정리를 시작함 · 업데이트 설치 · Windows 로그아웃)이면 닫힌다
      win.on('close', (e) => {
        tray?.close(e, { quitting: quitControl.started() || sessionEnding, hide: () => win.hide() })
      })

      const smokeMs = Number(env.DURE_SMOKE_EXIT_MS)
      if (smokeMs > 0) setTimeout(() => app.quit(), smokeMs)

      // 두레 업데이트 확인 — 설치본만, 창이 뜬 10초 뒤 한 번. 실패는 error 상태만(토스트는 available 부터)
      if (app.isPackaged) setTimeout(() => void updater.check(), 10_000)

      // 창을 막지 않는다 — 결과는 'setup'·'claude-update' 사건으로. 차례대로(claude 가 둘 겹치지 않게): 준비 확인 → claude 최신으로 → 엔진 시작
      const updateWith = engine && prefs.claudeAutoUpdate ? claude : null
      void runStartup({
        check: () => setupFlow.check(),
        autoUpdate: updateWith !== null,
        update: async () => {
          // 확인하는 사이 끄기 시작했으면 띄우지 않는다 — 띄운 뒤라면 before-quit 이 나무째 끈다
          if (!updateWith || quitControl.started()) return
          claudeUpdateRun = updateClaude(updateWith)
          return claudeUpdateRun.done
        },
        start: () => engine?.start(),
        emit: (s) => {
          claudeUpdateState = s
          emitApp('claude-update', s)
        },
        ready: () => markEngineReady(),
        log: logError,
      })
    })
    .catch((err: unknown) => {
      const message = startFailureMessage(err, home)
      logError('[두레] 시작 실패:', message)
      if (env.DURE_NO_DIALOG !== '1') dialog.showErrorBox('두레를 시작하지 못했어요', message)
      // Go through the normal quit path (before-quit -> shutdown -> exit) so Chromium's helper processes are torn down.
      exitCode = 1
      // Brief grace: quitting before Chromium's network service finishes starting orphans that helper process.
      setTimeout(() => app.quit(), 500)
    })
}
