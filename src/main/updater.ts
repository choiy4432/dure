import type { UpdateState } from '../shared/appTypes'
import { releaseHighlights, type ReleaseNotes } from './releaseNotes'

export const RELEASE_URL = (v: string): string => `https://github.com/choiy4432/dure/releases/tag/v${v}`

/** electron-updater `autoUpdater` 에서 쓰는 것만 */
export interface UpdaterLike {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  checkForUpdates(): Promise<{ isUpdateAvailable?: boolean; updateInfo: { version: string; releaseNotes?: ReleaseNotes } } | null | undefined>
  downloadUpdate(): Promise<unknown>
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void
  on(event: 'download-progress', fn: (p: { percent: number }) => void): unknown
  on(event: 'update-downloaded', fn: (info: unknown) => void): unknown
  on(event: 'error', fn: (e: Error) => void): unknown
}

export interface Updater {
  state(): UpdateState
  check(): Promise<UpdateState>
  download(): Promise<void>
  install(): Promise<void>
}

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

export function createUpdater(o: {
  updater: UpdaterLike | null
  current: string
  beforeInstall: () => Promise<void>
  emit: (s: UpdateState) => void
}): Updater {
  const u = o.updater
  if (!u) {
    const dev: UpdateState = { kind: 'dev' }
    return { state: () => dev, check: async () => dev, download: async () => {}, install: async () => {} }
  }
  u.autoDownload = false
  u.autoInstallOnAppQuit = true

  let state: UpdateState = { kind: 'idle' }
  let downloading = false
  let installing = false
  const set = (s: UpdateState): UpdateState => {
    state = s
    o.emit(s)
    return s
  }
  const versionOf = (): string | null => ('version' in state ? state.version : null)

  u.on('download-progress', (p) => {
    if (downloading && state.kind === 'downloading') set({ kind: 'downloading', version: state.version, percent: Math.round(p.percent) })
  })
  u.on('update-downloaded', () => {
    if (downloading && state.kind === 'downloading') set({ kind: 'ready', version: state.version })
  })
  // 실패는 check/download 의 reject 로 처리한다 — 여기선 처리 안 된 'error' 사건으로 죽지 않게 받기만
  u.on('error', () => {})

  return {
    state: () => state,
    async check() {
      if (downloading || state.kind === 'checking') return state
      set({ kind: 'checking' })
      try {
        const r = await u.checkForUpdates()
        const v = r?.updateInfo.version
        const available = !!r && (r.isUpdateAvailable ?? v !== o.current)
        if (!r || !v || !available) return set({ kind: 'none' })
        return set({
          kind: 'available', version: v, current: o.current,
          highlights: releaseHighlights(r.updateInfo.releaseNotes), url: RELEASE_URL(v),
        })
      } catch (e) {
        return set({ kind: 'error', message: msg(e), version: null })
      }
    },
    async download() {
      // 받을 수 있는 건 새 버전이 있다고 알린 뒤(또는 받다 실패해 다시 시도할 때)
      const version = versionOf()
      if (downloading || !version || !(state.kind === 'available' || state.kind === 'error')) return
      downloading = true
      set({ kind: 'downloading', version, percent: 0 })
      try {
        await u.downloadUpdate()
        if ((state as UpdateState).kind !== 'ready') set({ kind: 'ready', version })
      } catch (e) {
        set({ kind: 'error', message: msg(e), version })
      } finally {
        downloading = false
      }
    },
    async install() {
      if (state.kind !== 'ready' || installing) return
      installing = true
      try {
        await o.beforeInstall()
        u.quitAndInstall(true, true)
      } finally {
        installing = false
      }
    },
  }
}
