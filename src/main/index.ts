import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { join } from 'node:path'
import { createEngine, locateClaude } from '../engine'
import type { Engine } from '../engine'
import { resolveClaudeCommand } from './claudeCommand'
import { registerIpc } from './ipc'

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

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: '#FFFFFF',
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
  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
  return win
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })

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
            const r = await dialog.showOpenDialog({ properties: ['openDirectory'] })
            return r.canceled || r.filePaths.length === 0 ? null : r.filePaths[0]
          },
          async openFolder(path) {
            const err = await shell.openPath(path)
            if (err) throw new Error(err)
          },
        },
      )
      engine?.start()
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
