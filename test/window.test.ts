import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { appPageMatcher, focusExisting, guardNavigation, HIDDEN_ARG, withoutHiddenArg } from '../src/main/window'

const INDEX = path.resolve('out/renderer/index.html')
const APP_URL = pathToFileURL(INDEX).href

describe('appPageMatcher', () => {
  it('빌드된 앱 — 그 index.html 파일 주소만(#·? 는 상관없다)', () => {
    const isApp = appPageMatcher({ indexFile: INDEX })
    expect(isApp(APP_URL)).toBe(true)
    expect(isApp(`${APP_URL}#/a`)).toBe(true)
    expect(isApp(`${APP_URL}?x=1`)).toBe(true)
    expect(isApp(pathToFileURL(path.resolve('out/renderer/evil.html')).href)).toBe(false)
    expect(isApp(pathToFileURL(path.resolve('index.html')).href)).toBe(false)
    expect(isApp('https://example.com/out/renderer/index.html')).toBe(false)
    expect(isApp('http://localhost:5173/')).toBe(false)
    expect(isApp('')).toBe(false)
    expect(isApp(undefined)).toBe(false)
    expect(isApp('not a url')).toBe(false)
  })

  it('개발 중(ELECTRON_RENDERER_URL) — 그 출처(origin)만', () => {
    const isApp = appPageMatcher({ devUrl: 'http://localhost:5173', indexFile: INDEX })
    expect(isApp('http://localhost:5173/')).toBe(true)
    expect(isApp('http://localhost:5173/index.html#x')).toBe(true)
    expect(isApp('http://localhost:5174/')).toBe(false)
    expect(isApp('https://localhost:5173/')).toBe(false)
    expect(isApp('http://evil.example/')).toBe(false)
    expect(isApp(APP_URL)).toBe(false)
    expect(isApp(undefined)).toBe(false)
  })
})

describe('guardNavigation', () => {
  const navEvent = () => ({ preventDefault: vi.fn() })

  it('창 안에서 다른 곳으로 가는 이동(will-navigate · will-redirect)은 막는다 — 앱 화면 자신은 그대로', () => {
    const contents = new EventEmitter()
    guardNavigation(contents, appPageMatcher({ indexFile: INDEX }))
    for (const name of ['will-navigate', 'will-redirect']) {
      for (const url of ['https://example.com/', 'http://example.com/', 'file:///C:/Windows/win.ini', 'javascript:alert(1)']) {
        const e = navEvent()
        contents.emit(name, e, url)
        expect(e.preventDefault, `${name} ${url}`).toHaveBeenCalled()
      }
      const own = navEvent()
      contents.emit(name, own, APP_URL)
      expect(own.preventDefault).not.toHaveBeenCalled()
    }
  })
})

describe('focusExisting', () => {
  const fakeWindow = (o: { destroyed?: boolean; minimized?: boolean; visible?: boolean }) => {
    /** 파괴된 창의 메서드는 던진다(진짜처럼) */
    const alive = <T,>(v: () => T) => () => {
      if (o.destroyed) throw new Error('Object has been destroyed')
      return v()
    }
    return {
      isDestroyed: vi.fn(() => o.destroyed ?? false),
      isMinimized: vi.fn(alive(() => o.minimized ?? false)),
      isVisible: vi.fn(alive(() => o.visible ?? true)),
      restore: vi.fn(),
      show: vi.fn(),
      focus: vi.fn(),
    }
  }

  it('창이 없거나 닫힌(파괴된) 창이면 아무것도 부르지 않는다', () => {
    expect(() => focusExisting(null)).not.toThrow()
    const w = fakeWindow({ destroyed: true })
    expect(() => focusExisting(w)).not.toThrow()
    expect(w.isMinimized).not.toHaveBeenCalled()
    expect(w.isVisible).not.toHaveBeenCalled()
    expect(w.restore).not.toHaveBeenCalled()
    expect(w.show).not.toHaveBeenCalled()
    expect(w.focus).not.toHaveBeenCalled()
  })

  it('최소화된 창이면 되살려 앞으로', () => {
    const w = fakeWindow({ minimized: true })
    focusExisting(w)
    expect(w.restore).toHaveBeenCalledTimes(1)
    expect(w.focus).toHaveBeenCalledTimes(1)
  })

  it('떠 있는 창이면 앞으로만', () => {
    const w = fakeWindow({})
    focusExisting(w)
    expect(w.show).not.toHaveBeenCalled()
    expect(w.restore).not.toHaveBeenCalled()
    expect(w.focus).toHaveBeenCalledTimes(1)
  })

  it('숨은 창도 focusExisting 이 보인다', () => {
    // 휴대폰 연결 중 닫기(트레이로 숨김)·숨겨 시작(--hidden) — 두레를 또 켜거나 트레이를 누르면 다시 보인다
    const w = fakeWindow({ visible: false })
    focusExisting(w)
    expect(w.show).toHaveBeenCalledTimes(1)
    expect(w.focus).toHaveBeenCalledTimes(1)
    expect(w.show.mock.invocationCallOrder[0]).toBeLessThan(w.focus.mock.invocationCallOrder[0])
    expect(w.restore).not.toHaveBeenCalled()

    // 최소화된 채 숨었으면 — 보이고, 되살리고, 앞으로
    const m = fakeWindow({ visible: false, minimized: true })
    focusExisting(m)
    expect(m.show).toHaveBeenCalledTimes(1)
    expect(m.restore).toHaveBeenCalledTimes(1)
    expect(m.focus).toHaveBeenCalledTimes(1)
  })
})

describe('withoutHiddenArg', () => {
  it('다시 켜는 줄에선 --hidden 만 뺀다 — 자동으로 켜진 두레를 다시 켜도 창이 뜨게', () => {
    expect(HIDDEN_ARG).toBe('--hidden')
    expect(withoutHiddenArg(['C:/Dure/Dure.exe', '--hidden'])).toEqual(['C:/Dure/Dure.exe'])
    expect(withoutHiddenArg(['electron.exe', '.', '--hidden', '--x'])).toEqual(['electron.exe', '.', '--x'])
    expect(withoutHiddenArg(['Dure.exe', '--hiddenx', 'hidden'])).toEqual(['Dure.exe', '--hiddenx', 'hidden'])
    const argv = ['Dure.exe', '--hidden']
    withoutHiddenArg(argv)
    expect(argv).toEqual(['Dure.exe', '--hidden']) // 받은 배열은 그대로
  })
})
