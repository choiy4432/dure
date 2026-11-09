// 휴대폰 웹 화면의 안드로이드 앱 알아보기(src/renderer/mobile/androidApp.ts) — 앱 안인지 · ?app= 읽고 지우기 · 앱으로 여는 링크 · 업데이트 · 웹앱 설치 권유 막기 · 앱 안 첫 구독
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import {
  APP_PUSH_KEY, APP_SESSION_KEY, blockInstallPrompt, inApp, isAndroidChrome, needsUpdate, openInAppHref, readAppParam, subscribePushHere, takeAppParam,
} from '../../src/renderer/mobile/androidApp'

const ANDROID_CHROME = 'Mozilla/5.0 (Linux; Android 15; SM-S921N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Mobile Safari/537.36'
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'
const IPHONE_CHROME = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/156.0.0.0 Mobile/15E148 Safari/604.1'
const PC_CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36'
const SAMSUNG = 'Mozilla/5.0 (Linux; Android 15; SM-S921N) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/27.0 Chrome/125.0.0.0 Mobile Safari/537.36'
const ANDROID_FIREFOX = 'Mozilla/5.0 (Android 15; Mobile; rv:140.0) Gecko/140.0 Firefox/140.0'
const ANDROID_EDGE = 'Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Mobile Safari/537.36 EdgA/156.0.0.0'
const WEBVIEW = 'Mozilla/5.0 (Linux; Android 15; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/156.0.0.0 Mobile Safari/537.36'

beforeEach(() => {
  sessionStorage.clear()
  localStorage.clear()
})
afterEach(() => {
  history.replaceState(null, '', '/')
  vi.restoreAllMocks()
})

describe('inApp — 두레 앱(TWA)이 연 화면인가', () => {
  it('referrer 가 android-app://<진짜 패키지> 또는 <시험 패키지> 면 앱 안', () => {
    expect(inApp('android-app://io.github.choiy4432.dure/', null)).toBe(true)
    expect(inApp('android-app://io.github.choiy4432.dure', null)).toBe(true)
    expect(inApp('android-app://io.github.choiy4432.dure.test/', null)).toBe(true)
  })

  it('다른 앱 · 웹 페이지 · 빈 referrer 는 앱 밖 — 이름이 비슷하기만 한 패키지도', () => {
    for (const r of ['', 'https://pc.tail0000.ts.net/', 'android-app://com.android.chrome/', 'android-app://io.github.choiy4432.durex/', 'android-app://io.github.choiy4432.dure.testx/', 'https://android-app://io.github.choiy4432.dure/']) {
      expect(inApp(r, null), r).toBe(false)
    }
  })

  it('이 세션에 ?app= 를 받았으면 referrer 가 없어도 앱 안', () => {
    expect(inApp('', 3)).toBe(true)
  })
})

describe('readAppParam — 쿼리의 app 만 빼고 해시·나머지 그대로', () => {
  it('?app=3#agent=a1 → 3 · 해시 그대로', () => {
    expect(readAppParam('https://h.ts.net/mobile.html?app=3#agent=a1')).toEqual({ versionCode: 3, cleanHref: 'https://h.ts.net/mobile.html#agent=a1' })
  })

  it('?x=1&app=3#pair=… → ?x=1#pair=… (다른 쿼리는 글자 그대로)', () => {
    expect(readAppParam('https://h.ts.net/mobile.html?x=1&app=3#pair=c0de-S_1')).toEqual({ versionCode: 3, cleanHref: 'https://h.ts.net/mobile.html?x=1#pair=c0de-S_1' })
    expect(readAppParam('https://h.ts.net:8443/?app=12&q=a%20b+c')).toEqual({ versionCode: 12, cleanHref: 'https://h.ts.net:8443/?q=a%20b+c' })
  })

  it('없으면 그대로(null) · 해시 안의 app= 는 쿼리가 아니다', () => {
    for (const href of ['https://h.ts.net/mobile.html', 'https://h.ts.net/mobile.html?x=1#agent=a1', 'https://h.ts.net/mobile.html#app=3', 'https://h.ts.net/mobile.html?apps=3']) {
      expect(readAppParam(href), href).toEqual({ versionCode: null, cleanHref: href })
    }
  })

  it('판 번호가 틀린 꼴이면 null — 그래도 주소에선 지운다', () => {
    for (const v of ['', 'abc', '0', '-1', '1.5', '99999999999']) {
      expect(readAppParam(`https://h.ts.net/mobile.html?app=${v}#agent=a1`), v).toEqual({ versionCode: null, cleanHref: 'https://h.ts.net/mobile.html#agent=a1' })
    }
  })
})

describe('takeAppParam — 시작 때 한 번: ?app= 를 세션에 두고 주소창에서 지운다(replaceState 만 · 다시 읽지 않음)', () => {
  it('판을 세션에 · 주소는 #agent= 그대로 · history.state 그대로 · 기록 칸이 늘지 않는다', () => {
    history.replaceState({ keep: 1 }, '', '/mobile.html?app=3#agent=a1')
    const before = history.length
    const replace = vi.spyOn(history, 'replaceState')
    const push = vi.spyOn(history, 'pushState')
    expect(takeAppParam()).toBe(3)
    expect(replace).toHaveBeenCalledTimes(1)
    expect(push).not.toHaveBeenCalled()
    expect(location.search).toBe('')
    expect(location.hash).toBe('#agent=a1')
    expect(location.pathname).toBe('/mobile.html')
    expect(history.state).toEqual({ keep: 1 })
    expect(history.length).toBe(before)
    expect(sessionStorage.getItem(APP_SESSION_KEY)).toBe('3')
  })

  it('#pair= 도 그대로(짝 코드는 진입점이 따로 읽는다) · 다른 쿼리 그대로', () => {
    history.replaceState(null, '', '/mobile.html?x=1&app=7#pair=c0de')
    expect(takeAppParam()).toBe(7)
    expect(location.search).toBe('?x=1')
    expect(location.hash).toBe('#pair=c0de')
  })

  it('?app= 가 없으면 주소를 건드리지 않고, 세션에 둔 판은 그대로', () => {
    sessionStorage.setItem(APP_SESSION_KEY, '5')
    history.replaceState(null, '', '/mobile.html#agent=a1')
    const replace = vi.spyOn(history, 'replaceState')
    expect(takeAppParam()).toBeNull()
    expect(replace).not.toHaveBeenCalled()
    expect(sessionStorage.getItem(APP_SESSION_KEY)).toBe('5')
  })
})

describe('isAndroidChrome — 안드로이드 크롬만', () => {
  it('안드로이드 크롬 → true', () => {
    expect(isAndroidChrome(ANDROID_CHROME)).toBe(true)
  })
  it('아이폰(사파리·크롬) · PC 크롬 · 삼성 인터넷 · 파이어폭스 · 엣지 · 앱 속 웹뷰 → false', () => {
    for (const ua of [IPHONE, IPHONE_CHROME, PC_CHROME, SAMSUNG, ANDROID_FIREFOX, ANDROID_EDGE, WEBVIEW, '']) expect(isAndroidChrome(ua), ua).toBe(false)
  })
})

describe('openInAppHref — 크롬에서 두레 앱으로 여는 intent 링크', () => {
  it('호스트·포트·경로·해시 그대로 · 패키지 · 앱이 없으면 /dure.apk (인코딩)', () => {
    expect(openInAppHref('https://pc.tail0000.ts.net:8443', '/mobile.html#agent=a1', 'io.github.choiy4432.dure')).toBe(
      'intent://pc.tail0000.ts.net:8443/mobile.html#agent=a1#Intent;scheme=https;package=io.github.choiy4432.dure;' +
        `S.browser_fallback_url=${encodeURIComponent('https://pc.tail0000.ts.net:8443/dure.apk')};end`,
    )
  })

  it('443 은 포트를 쓰지 않는다 · 시험 패키지 · 패키지를 안 주면 진짜 패키지', () => {
    expect(openInAppHref('https://pc.tail0000.ts.net', '/', 'io.github.choiy4432.dure.test')).toBe(
      'intent://pc.tail0000.ts.net/#Intent;scheme=https;package=io.github.choiy4432.dure.test;S.browser_fallback_url=https%3A%2F%2Fpc.tail0000.ts.net%2Fdure.apk;end',
    )
    expect(openInAppHref('https://pc.tail0000.ts.net', '/mobile.html')).toContain(';package=io.github.choiy4432.dure;')
  })
})

describe('needsUpdate — PC 판이 앱 판보다 클 때만', () => {
  it('PC > 앱 → true · 같거나 작으면 false · 둘 중 하나 없으면 false', () => {
    expect(needsUpdate(4, 3)).toBe(true)
    expect(needsUpdate(3, 3)).toBe(false)
    expect(needsUpdate(2, 3)).toBe(false)
    expect(needsUpdate(null, 3)).toBe(false)
    expect(needsUpdate(4, null)).toBe(false)
    expect(needsUpdate(null, null)).toBe(false)
  })
})

describe('blockInstallPrompt — 안드로이드 크롬(앱 밖)만 웹앱 설치 권유를 막는다', () => {
  const fire = (t: EventTarget) => {
    const e = new Event('beforeinstallprompt', { cancelable: true })
    t.dispatchEvent(e)
    return e
  }

  it('안드로이드 크롬 앱 밖 → beforeinstallprompt 의 preventDefault', () => {
    const t = new EventTarget()
    expect(blockInstallPrompt(t, { inApp: false, androidChrome: true })).toBe(true)
    expect(fire(t).defaultPrevented).toBe(true)
  })

  it('아이폰 · PC · 앱 안 → 손대지 않는다', () => {
    for (const ctx of [{ inApp: false, androidChrome: false }, { inApp: true, androidChrome: true }]) {
      const t = new EventTarget()
      expect(blockInstallPrompt(t, ctx)).toBe(false)
      expect(fire(t).defaultPrevented).toBe(false)
    }
  })
})

describe('subscribePushHere — 앱 안 처음엔 옛 구독을 지우고 새로(성공하면 기억 — 한 번만)', () => {
  it('앱 안 처음 → fresh 로 한 번 · 성공하면 기억 → 다음부턴 보통 구독', async () => {
    const subscribe = vi.fn(async (_o: { fresh: boolean }) => 'on' as const)
    expect(await subscribePushHere({ inApp: true, subscribe })).toBe('on')
    expect(subscribe).toHaveBeenCalledTimes(1)
    expect(subscribe).toHaveBeenLastCalledWith({ fresh: true })
    expect(localStorage.getItem(APP_PUSH_KEY)).not.toBeNull()
    await subscribePushHere({ inApp: true, subscribe })
    expect(subscribe).toHaveBeenLastCalledWith({ fresh: false })
  })

  it('실패하면 기억하지 않는다 — 다음에 다시 fresh', async () => {
    const subscribe = vi.fn(async (_o: { fresh: boolean }) => 'failed' as const)
    await subscribePushHere({ inApp: true, subscribe })
    expect(localStorage.getItem(APP_PUSH_KEY)).toBeNull()
    await subscribePushHere({ inApp: true, subscribe })
    expect(subscribe.mock.calls.map(c => c[0])).toEqual([{ fresh: true }, { fresh: true }])
  })

  it('앱 밖(크롬 탭·웹앱·아이폰)은 늘 보통 구독 · 기억하지 않는다', async () => {
    const subscribe = vi.fn(async (_o: { fresh: boolean }) => 'on' as const)
    await subscribePushHere({ inApp: false, subscribe })
    expect(subscribe).toHaveBeenCalledWith({ fresh: false })
    expect(localStorage.getItem(APP_PUSH_KEY)).toBeNull()
  })
})
