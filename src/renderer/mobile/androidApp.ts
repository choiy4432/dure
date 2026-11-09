// 휴대폰 웹 화면의 안드로이드 앱(TWA) 알아보기 — 설계 §5.6 · findings 2026-11-09-twa-spike.
// 앱 안이면: 앱이 연 화면은 referrer 가 android-app://<패키지>/ 이고, 처음 주소에 ?app=<판> 이 붙어 온다(앱 껍데기가 붙인다 — 읽고 지운다).
// 안드로이드 크롬(앱 밖)이면: 방 목록 위에 '두레 앱으로 열기' 띠 · 웹앱 설치 권유를 막는다(웹앱과 앱이 같이 깔리면 알림이 샌다 — findings §4.6).
// 아이폰·PC 브라우저는 아무것도 바뀌지 않는다
import { ANDROID_PACKAGE, ANDROID_TEST_PACKAGE } from '../../shared/androidApp'
import { subscribePush, type PushOutcome } from './phoneHttp'

/** 이 세션에 앱이 알린 판(?app=) — sessionStorage(탭 하나 동안 · 다시 읽어도 남는다). offline.js 도 이 이름을 본다 */
export const APP_SESSION_KEY = 'dure:app'
/** 앱 안에서 알림을 새로 구독했다 — localStorage(한 번만) */
export const APP_PUSH_KEY = 'dure:appPush'
/** 크롬 띠의 [나중에] — 이번 세션 동안 접는다 */
export const STEER_LATER_KEY = 'dure:appLater'

const APP_PACKAGES: readonly string[] = [ANDROID_PACKAGE, ANDROID_TEST_PACKAGE]

/** 두레 앱이 연 화면인가 — referrer 의 패키지가 두레(시험 빌드면 .test)거나, 이 세션에 ?app= 를 받았으면 */
export function inApp(referrer: string, stored: number | null): boolean {
  if (stored !== null) return true
  const m = /^android-app:\/\/([^/?#]+)/.exec(referrer)
  return m !== null && APP_PACKAGES.includes(m[1])
}

/** 쿼리 조각 하나(`a=b`)의 이름 — URLSearchParams 와 같게 읽는다 */
const keyOf = (part: string) => [...new URLSearchParams(part).keys()][0] ?? ''

/**
 * 주소의 ?app=<판> — 판 번호와 그 칸만 뺀 주소. 해시(#agent= · #pair=)와 다른 쿼리는 글자 그대로.
 * 칸이 없으면 주소 그대로(null) · 판이 틀린 꼴(양의 정수가 아님)이면 null 이지만 칸은 뺀다
 */
export function readAppParam(href: string): { versionCode: number | null; cleanHref: string } {
  const hashAt = href.indexOf('#')
  const head = hashAt < 0 ? href : href.slice(0, hashAt)
  const hash = hashAt < 0 ? '' : href.slice(hashAt)
  const q = head.indexOf('?')
  if (q < 0) return { versionCode: null, cleanHref: href }
  const parts = head.slice(q + 1).split('&').filter(Boolean)
  const app = parts.filter(p => keyOf(p) === 'app')
  if (app.length === 0) return { versionCode: null, cleanHref: href }
  const raw = new URLSearchParams(app[app.length - 1]).get('app') ?? ''
  const versionCode = /^[1-9]\d{0,8}$/.test(raw) ? Number(raw) : null
  const rest = parts.filter(p => keyOf(p) !== 'app')
  return { versionCode, cleanHref: `${head.slice(0, q)}${rest.length ? `?${rest.join('&')}` : ''}${hash}` }
}

const session = {
  get(k: string): string | null {
    try {
      return sessionStorage.getItem(k)
    } catch {
      return null
    }
  },
  set(k: string, v: string): void {
    try {
      sessionStorage.setItem(k, v)
    } catch {
      // 못 적으면 이번 화면에서만 — referrer 로도 앱 안을 안다
    }
  },
}

/** 이 세션에 앱이 알린 판 */
function storedAppVersion(): number | null {
  const v = session.get(APP_SESSION_KEY)
  return v !== null && /^[1-9]\d{0,8}$/.test(v) ? Number(v) : null
}

/**
 * 시작 때 한 번(진입점) — ?app= 를 세션에 두고 주소창에서 그 칸만 지운다. history.replaceState 만(다시 읽지 않음 · 기록 칸이 늘지 않음 ·
 * history.state 그대로). 칸이 없으면 주소를 건드리지 않는다. 받은 판(없으면 null)
 */
export function takeAppParam(): number | null {
  const { versionCode, cleanHref } = readAppParam(location.href)
  if (cleanHref !== location.href) history.replaceState(history.state, '', cleanHref)
  if (versionCode !== null) session.set(APP_SESSION_KEY, String(versionCode))
  return versionCode
}

/** 안드로이드의 크롬인가 — 삼성 인터넷·엣지·파이어폭스·앱 속 웹뷰 같은 다른 브라우저는 아니다(intent 링크·TWA 는 크롬 몫) */
export function isAndroidChrome(ua: string): boolean {
  if (!/\bAndroid\b/.test(ua) || !/\bChrome\/\d/.test(ua)) return false
  return !/SamsungBrowser|EdgA|OPR\/|OPT\/|YaBrowser|UCBrowser|MiuiBrowser|HuaweiBrowser|HeyTapBrowser|Whale|DuckDuckGo|; wv\)|Version\/\d/.test(ua)
}

/**
 * 크롬 화면에서 두레 앱으로 여는 링크 — 앱이 이 주소(호스트·포트·경로·해시 그대로)를 받아 기억하고 연다(설계 §5.4).
 * 앱이 없으면 크롬이 S.browser_fallback_url(= 이 PC 의 /dure.apk)로 가서 앱 파일을 받는다
 */
export function openInAppHref(origin: string, path: string, packageName: string = ANDROID_PACKAGE): string {
  const { host } = new URL(origin)
  return `intent://${host}${path}#Intent;scheme=https;package=${packageName};S.browser_fallback_url=${encodeURIComponent(`${origin}/dure.apk`)};end`
}

/** 앱 업데이트 띠 — PC 가 내어 줄 앱 판이 앱이 알린 판보다 클 때만(둘 중 하나라도 모르면 띄우지 않는다) */
export function needsUpdate(pc: number | null, app: number | null): boolean {
  return pc !== null && app !== null && pc > app
}

/** 지금 이 화면 — 앱 안인지 · 앱이 알린 판 · 안드로이드 크롬인지 */
export type AppContext = { inApp: boolean; appVersion: number | null; androidChrome: boolean }
export function appContext(): AppContext {
  const appVersion = storedAppVersion()
  return {
    inApp: inApp(typeof document === 'undefined' ? '' : document.referrer, appVersion),
    appVersion,
    androidChrome: typeof navigator !== 'undefined' && isAndroidChrome(navigator.userAgent),
  }
}

/**
 * 안드로이드 크롬(앱 밖)에서 웹앱 설치 권유를 막는다 — 설치 권유 대신 '두레 앱으로 쓰기' 띠(설계 §5.6). 권유는 붙잡아 두지 않는다.
 * 아이폰·PC 브라우저·앱 안은 손대지 않는다(false). 시작 때 바로 건다 — 권유는 일찍 온다
 */
export function blockInstallPrompt(target: Pick<EventTarget, 'addEventListener'> = window, ctx: Pick<AppContext, 'inApp' | 'androidChrome'> = appContext()): boolean {
  if (!ctx.androidChrome || ctx.inApp) return false
  target.addEventListener('beforeinstallprompt', e => e.preventDefault())
  return true
}

/** 크롬 띠의 [나중에] — 이번 세션 동안 */
export const steerLater = (): boolean => session.get(STEER_LATER_KEY) !== null
export const setSteerLater = (): void => session.set(STEER_LATER_KEY, '1')

const remembered = (k: string): boolean => {
  try {
    return localStorage.getItem(k) !== null
  } catch {
    return false
  }
}
const remember = (k: string): void => {
  try {
    localStorage.setItem(k, '1')
  } catch {
    // 못 적으면 다음에 또 새로 구독한다 — 해롭지 않다
  }
}

/**
 * 알림 구독(조용히 다시 · 알림 켜기 · 짝 맺은 뒤 켜기가 모두 이것으로) — 앱 안에서 처음이면 옛 구독(크롬 탭·웹앱이 만든 것 — 같은 크롬이라 같은 구독)을
 * 지우고 새로 해서 알림이 앱으로 오게 한다(설계 §5.6). 성공하면 기억해 다음부턴 보통 구독 — 못 하면 다음에 다시 새로
 */
export async function subscribePushHere(o: { inApp?: boolean; subscribe?: (p: { fresh: boolean }) => Promise<PushOutcome> } = {}): Promise<PushOutcome> {
  const here = o.inApp ?? appContext().inApp
  const fresh = here && !remembered(APP_PUSH_KEY)
  const r = await (o.subscribe ?? (p => subscribePush(p)))({ fresh })
  if (fresh && r === 'on') remember(APP_PUSH_KEY)
  return r
}
