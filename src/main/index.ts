import { app, BrowserWindow, shell } from 'electron'
import { join } from 'node:path'
import { createEngine, locateClaude } from '../engine'
import type { Engine } from '../engine'
import { resolveClaudeCommand } from './claudeCommand'

let mainWindow: BrowserWindow | null = null
let engine: Engine | null = null
let claudeMissing = false

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
  win.webContents.on('did-finish-load', () => {
    if (claudeMissing) win.webContents.send('dure:claude-missing', true)
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
        app.exit()
      }
    })()
  })

  app.on('window-all-closed', () => app.quit())

  void app.whenReady().then(async () => {
    const claude = resolveClaudeCommand(process.env, () => locateClaude())
    if (claude) {
      engine = await createEngine({
        dataDir: app.getPath('userData'),
        claude,
        autoStart: false,
      })
      // Task 4: registerIpc(engine, ...) goes here, BEFORE engine.start().
      engine.start()
    } else {
      claudeMissing = true
    }
    mainWindow = createWindow()

    const smokeMs = Number(process.env.DURE_SMOKE_EXIT_MS)
    if (smokeMs > 0) setTimeout(() => app.quit(), smokeMs)
  })
}
