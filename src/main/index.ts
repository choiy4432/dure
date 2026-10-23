import { app, BrowserWindow, dialog, ipcMain, nativeImage, nativeTheme, shell } from 'electron'
import { join } from 'node:path'
import { createEngine, locateClaude } from '../engine'
import type { Engine } from '../engine'
import { resolveClaudeCommand } from './claudeCommand'
import { logEngineErrors, registerIpc } from './ipc'
import { appPageMatcher, focusExisting, guardNavigation } from './window'
import { TITLE_BAR_HEIGHT, windowColors } from './windowTheme'

let mainWindow: BrowserWindow | null = null
let engine: Engine | null = null
let exitCode = 0

// Test-only hook: DURE_USER_DATA isolates the data folder (and the single-instance lock, which lives there) — set before anything reads it.
if (process.env.DURE_USER_DATA) app.setPath('userData', process.env.DURE_USER_DATA)

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

// Windows 알림·작업표시줄 묶음이 앱을 알아보게 — 개발 실행용 임시 ID(설치 패키지의 고정 ID 는 계획 3)
if (process.platform === 'win32') app.setAppUserModelId(process.execPath)

const indexFile = join(__dirname, '../renderer/index.html')
/** 두레 화면 자신의 주소인가 — IPC 요청·창 안 이동을 이걸로 가린다 */
const isAppPage = appPageMatcher({ devUrl: process.env.ELECTRON_RENDERER_URL, indexFile })

/** 창 바탕·창 단추를 지금 테마로 — 테마를 바꾸거나 Windows 가 바꾸면(Windows 따라감) 다시 칠한다 */
function paintWindow(win: BrowserWindow): void {
  if (win.isDestroyed()) return
  const c = windowColors(nativeTheme.shouldUseDarkColors)
  win.setBackgroundColor(c.bg)
  win.setTitleBarOverlay({ color: c.bg, symbolColor: c.symbol, height: TITLE_BAR_HEIGHT })
}

function createWindow(): BrowserWindow {
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
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  win.once('ready-to-show', () => win.show())
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
  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void win.loadFile(indexFile)
  }
  return win
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => focusExisting(mainWindow))

  let quitting = false
  app.on('before-quit', (event) => {
    if (quitting) return
    quitting = true
    event.preventDefault()
    void (async () => {
      try {
        await engine?.shutdown()
      } finally {
        app.exit(exitCode)
      }
    })()
  })

  app.on('window-all-closed', () => app.quit())

  // Test-only hooks: DURE_SMOKE_EXIT_MS (self-quit after N ms), DURE_NO_DIALOG=1 (skip the error box, still exit 1),
  // DURE_USER_DATA and DURE_E2E_FOLDERS (above) — the E2E (e2e/app.spec.ts) sets them with DURE_CLAUDE_COMMAND/ARGS.
  void app
    .whenReady()
    .then(async () => {
      const nextE2eFolder = e2eFolders(process.env.DURE_E2E_FOLDERS)
      const claude = resolveClaudeCommand(process.env, () => locateClaude())
      if (claude) {
        engine = await createEngine({
          dataDir: app.getPath('userData'),
          claude,
          autoStart: false,
        })
        logEngineErrors(engine)
      }
      // 순서: 엔진 만들기 → registerIpc(리스너 붙이기) → engine.start() → 창. claude 가 없으면 engine 은 null 이고 snapshot 이 claudeMissing 을 알린다.
      registerIpc(
        ipcMain,
        engine,
        (ch, payload) => {
          if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(ch, payload)
        },
        {
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
        },
      )
      engine?.start()
      // 저장한 화면 테마를 Windows 에 알린다 — 화면의 prefers-color-scheme·제목 표시줄 단추·스크롤바가 따른다(claude 가 없으면 Windows 따라감)
      nativeTheme.themeSource = engine?.theme() ?? 'system'
      nativeTheme.on('updated', () => {
        if (mainWindow) paintWindow(mainWindow)
      })
      mainWindow = createWindow()

      const smokeMs = Number(process.env.DURE_SMOKE_EXIT_MS)
      if (smokeMs > 0) setTimeout(() => app.quit(), smokeMs)
    })
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err)
      if (process.env.DURE_NO_DIALOG !== '1') dialog.showErrorBox('두레를 시작하지 못했어요', message)
      // Go through the normal quit path (before-quit -> shutdown -> exit) so Chromium's helper processes are torn down.
      exitCode = 1
      // Brief grace: quitting before Chromium's network service finishes starting orphans that helper process.
      setTimeout(() => app.quit(), 500)
    })
}
