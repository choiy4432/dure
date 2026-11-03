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
const INSTALL_FAILED = '업데이트를 설치하지 못했어요'

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
  /** 다 받은 버전 — 설치가 실패해 error 가 된 뒤에도 이 버전이면 [다시 켜기]로 설치한다 */
  let downloaded: string | null = null
  /**
   * 설치 전 정리(beforeInstall = 엔진 끄기)가 한 번 끝났나 — 성공이든 실패든. 정리는 한 번뿐(quit.ts shutdownOnce)이라
   * 다시 불러도 같은 결과만 돌아온다: 성공했으면 할 일이 없고, 실패했으면 다시 해도 또 실패해 설치를 영영 못 한다.
   * 그래서 다시 켜기에선 건너뛰고 바로 설치한다 — 정리가 끝난(실패한) 뒤 보통 끄기도 그대로 나가고(quitDecision 'proceed')
   * 그때도 autoInstallOnAppQuit 로 설치되니, 사용자가 한 번 더 누른 것을 그 길과 같게 본다.
   */
  let prepared = false
  const set = (s: UpdateState): UpdateState => {
    state = s
    o.emit(s)
    return s
  }
  const versionOf = (): string | null => ('version' in state ? state.version : null)
  const ready = (version: string): void => {
    downloaded = version
    set({ kind: 'ready', version })
  }

  u.on('download-progress', (p) => {
    if (downloading && state.kind === 'downloading') set({ kind: 'downloading', version: state.version, percent: Math.round(p.percent) })
  })
  u.on('update-downloaded', () => {
    if (downloading && state.kind === 'downloading') ready(state.version)
  })
  // 실패는 check/download 의 reject 로 처리한다 — 여기선 처리 안 된 'error' 사건으로 죽지 않게 받기만
  u.on('error', () => {})

  return {
    state: () => state,
    async check() {
      // 다 받아 둔 뒤(ready)엔 그대로 — 다시 확인하면 '있어요'로 내려가 받은 것을 또 받게 된다
      if (downloading || state.kind === 'checking' || state.kind === 'ready') return state
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
        if ((state as UpdateState).kind !== 'ready') ready(version)
      } catch (e) {
        set({ kind: 'error', message: msg(e), version })
      } finally {
        downloading = false
      }
    },
    async install() {
      // 준비됨, 또는 설치가 실패한 뒤의 error 라도 다 받은 그 버전이면(받기 실패의 error 는 받은 게 없어 아니다)
      const version =
        state.kind === 'ready' ? state.version
        : state.kind === 'error' && state.version !== null && state.version === downloaded ? state.version
        : null
      if (!version || installing) return
      installing = true
      try {
        if (!prepared) {
          try {
            await o.beforeInstall()
          } finally {
            prepared = true
          }
        }
        u.quitAndInstall(true, true)
      } catch {
        // 정리(엔진 끄기)나 설치 띄우기가 실패하면 이번엔 설치하지 않는다 — 창엔 짧은 말로(스택 말고).
        // 다시 켜기를 또 누르면 받아 둔 이 버전으로 다시 해 본다(정리는 건너뜀 — 위 prepared)
        set({ kind: 'error', message: INSTALL_FAILED, version })
      } finally {
        installing = false
      }
    },
  }
}
