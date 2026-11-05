// 짝 맺기 화면이 고를 길 — 어떤 휴대폰·브라우저인가(아이폰 사파리 · 홈 화면 앱 · 앱 안 브라우저 · 삼성)
import { PHONE_NAME_DEFAULT } from '../../shared/phoneTypes'

export interface PairEnv {
  /** 아이폰·아이패드 — 알림은 홈 화면에 추가한 두레에서만 */
  ios: boolean
  /** 홈 화면 앱(설치한 웹 앱)으로 열었다 */
  standalone: boolean
  /** 앱 안 브라우저(카카오톡 등) — 알림을 못 받는다. name 은 화면에 보일 앱 이름(모르면 null) */
  inApp: { name: string | null } | null
  /** 삼성 휴대폰 — 짝 맺은 뒤 '삼성 팝업 설정' 안내를 보인다 */
  samsung: boolean
  /** 이 브라우저가 웹 푸시를 받을 수 있다(서비스 워커·PushManager·Notification) */
  push: boolean
  /** 휴대폰 이름 칸의 처음 값 — UA-CH 모델(삼성은 '갤럭시 SM-S931N'), 아이폰이면 '아이폰', 모르면 '휴대폰' */
  defaultName: string
}

/** 앱 안 브라우저 — UA 표시(앞에서부터 처음 맞는 것). 안드로이드 웹뷰(; wv)는 어느 앱인지 몰라도 앱 안이다 */
const IN_APP: readonly [RegExp, string | null][] = [
  [/KAKAOTALK/i, '카카오톡'],
  [/NAVER\(inapp/i, '네이버 앱'],
  [/Instagram/i, '인스타그램'],
  [/FBAN|FBAV|FB_IAB/, '페이스북'],
  [/\bLine\/\d/, '라인'],
  [/;\s*wv\)/, null],
]

/** inAppBrowser 가 UA 말고 더 보는 것 — 안 주면 UA 표시만 본다 */
export type InAppHints = { ios?: boolean; standalone?: boolean; pushManager?: boolean }

/**
 * 앱 안 브라우저면 그 이름(모르면 null), 보통 브라우저(크롬·삼성 인터넷·사파리·아이폰 크롬)면 null.
 * 이름표가 없는 것도 잡는다: 아이폰(홈 화면 앱 아님)인데 UA 에 Safari/ 가 없다(다음·밴드 같은 WKWebView — 사파리·아이폰 크롬·파이어폭스는 있다) ·
 * 안드로이드인데 PushManager 가 없다(; wv 를 지운 웹뷰 등 — 어차피 알림을 못 받는다)
 */
export function inAppBrowser(ua: string, h: InAppHints = {}): { name: string | null } | null {
  for (const [re, name] of IN_APP) if (re.test(ua)) return { name }
  if (h.ios && !h.standalone && !/\bSafari\//.test(ua)) return { name: null }
  if (/\bAndroid\b/.test(ua) && h.pushManager === false) return { name: null }
  return null
}

/** 아이폰·아이팟·아이패드 — 아이패드는 데스크톱 꼴 UA(Macintosh)에 터치가 있다 */
export function isIOS(ua: string, maxTouchPoints: number): boolean {
  return /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && maxTouchPoints > 1)
}

/** 삼성 휴대폰 — UA-CH 모델이 SM- 로 시작(크롬은 UA 의 모델을 가린다) · 삼성 인터넷 · 옛 UA 의 SM- 모델 */
export function isSamsung(model: string, ua: string): boolean {
  return /^SM-/i.test(model.trim()) || /SamsungBrowser/.test(ua) || /\bSM-[A-Z0-9]/.test(ua)
}

type UaData = { getHighEntropyValues?: (hints: string[]) => Promise<{ model?: string }> }

/** UA-CH 모델 — 크롬 계열만 준다. 늦으면(0.5초) 모르는 것으로 */
async function uaModel(nav: Navigator): Promise<string> {
  const data = (nav as Navigator & { userAgentData?: UaData }).userAgentData
  if (!data?.getHighEntropyValues) return ''
  try {
    const got = await Promise.race([
      data.getHighEntropyValues(['model']),
      new Promise<{ model?: string }>(resolve => setTimeout(() => resolve({}), 500)),
    ])
    return typeof got.model === 'string' ? got.model.trim() : ''
  } catch {
    return ''
  }
}

/** 지금 브라우저의 PairEnv */
export async function detectPairEnv(): Promise<PairEnv> {
  const nav = navigator
  const ua = nav.userAgent
  const ios = isIOS(ua, nav.maxTouchPoints ?? 0)
  const standalone = window.matchMedia?.('(display-mode: standalone)').matches === true
    || (nav as Navigator & { standalone?: boolean }).standalone === true
  const model = await uaModel(nav)
  const pushManager = 'PushManager' in window
  return {
    ios,
    standalone,
    inApp: inAppBrowser(ua, { ios, standalone, pushManager }),
    samsung: isSamsung(model, ua),
    push: 'serviceWorker' in nav && pushManager && 'Notification' in window,
    defaultName: defaultPhoneName(model, ios),
  }
}

/** 휴대폰 이름 칸의 처음 값 — 삼성 모델 번호(SM-…)만 보면 알아보기 어려워 '갤럭시' 를 붙인다 */
export function defaultPhoneName(model: string, ios: boolean): string {
  if (/^SM-/i.test(model)) return `갤럭시 ${model}`
  return model || (ios ? '아이폰' : PHONE_NAME_DEFAULT)
}
