import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { appPageMatcher, focusExisting, guardNavigation } from '../src/main/window'

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
  const fakeWindow = (o: { destroyed?: boolean; minimized?: boolean }) => ({
    isDestroyed: vi.fn(() => o.destroyed ?? false),
    isMinimized: vi.fn(() => {
      if (o.destroyed) throw new Error('Object has been destroyed')
      return o.minimized ?? false
    }),
    restore: vi.fn(),
    focus: vi.fn(),
  })

  it('창이 없거나 닫힌(파괴된) 창이면 아무것도 부르지 않는다', () => {
    expect(() => focusExisting(null)).not.toThrow()
    const w = fakeWindow({ destroyed: true })
    expect(() => focusExisting(w)).not.toThrow()
    expect(w.isMinimized).not.toHaveBeenCalled()
    expect(w.restore).not.toHaveBeenCalled()
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
    expect(w.restore).not.toHaveBeenCalled()
    expect(w.focus).toHaveBeenCalledTimes(1)
  })
})
