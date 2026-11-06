// 창 둘레의 작은 규칙 — electron 없이 시험할 수 있게 따로 둔다(index.ts 가 쓴다)
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** 주소가 두레 화면(renderer) 자신인가 */
export type AppPageMatcher = (url: string | undefined) => boolean

/**
 * 두레 화면의 주소를 알아보는 함수.
 * 빌드된 앱은 out/renderer/index.html 파일 그 하나(뒤의 ?·# 는 상관없다), 개발 중(devUrl = ELECTRON_RENDERER_URL)은 그 출처(origin).
 */
export function appPageMatcher(o: { devUrl?: string; indexFile: string }): AppPageMatcher {
  if (o.devUrl) {
    const origin = new URL(o.devUrl).origin
    return (url) => {
      if (!url) return false
      try {
        return new URL(url).origin === origin
      } catch {
        return false
      }
    }
  }
  const fold = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p)
  const want = fold(path.resolve(o.indexFile))
  return (url) => {
    if (!url) return false
    try {
      const u = new URL(url)
      return u.protocol === 'file:' && fold(path.resolve(fileURLToPath(u))) === want
    } catch {
      return false
    }
  }
}

interface NavEvent {
  preventDefault(): void
}
interface ContentsLike {
  on(event: 'will-navigate' | 'will-redirect', fn: (e: NavEvent, url: string) => void): unknown
}

/**
 * 창 안에서 다른 곳으로 옮겨 가지 않게 — 링크는 새 창 요청(setWindowOpenHandler)으로만 기본 브라우저에서 열린다.
 * 두레 화면 자신으로 가는 이동(개발 중 다시 불러오기)만 그대로 둔다.
 */
export function guardNavigation(contents: ContentsLike, isAppPage: AppPageMatcher): void {
  const block = (e: NavEvent, url: string) => {
    if (!isAppPage(url)) e.preventDefault()
  }
  contents.on('will-navigate', block)
  contents.on('will-redirect', block)
}

export interface WindowLike {
  isDestroyed(): boolean
  isMinimized(): boolean
  isVisible(): boolean
  restore(): void
  show(): void
  focus(): void
}

/** 숨겨 시작 — 'Windows 를 켜면 두레도 켜기'(로그인 항목)가 붙인다. 창을 띄우지 않고 트레이로 시작 */
export const HIDDEN_ARG = '--hidden'

/**
 * 다시 켜는 줄(app.relaunch · 작업 표시줄 고정의 relaunchCommand)에선 HIDDEN_ARG 를 뺀다 —
 * 자동으로 켜진 두레를 사용자가 다시 켜거나 고정해 켰는데 창이 안 뜨면 안 된다
 */
export function withoutHiddenArg(argv: readonly string[]): string[] {
  return argv.filter((a) => a !== HIDDEN_ARG)
}

/**
 * 두레를 또 켰을 때·트레이를 눌렀을 때 — 창을 앞으로. 숨은 창(닫기 · 숨겨 시작)은 보이고, 최소화된 창은 되살린다.
 * 닫히는 중(이미 파괴된 창)이면 아무것도 하지 않는다
 */
export function focusExisting(win: WindowLike | null): void {
  if (!win || win.isDestroyed()) return
  if (!win.isVisible()) win.show()
  if (win.isMinimized()) win.restore()
  win.focus()
}
