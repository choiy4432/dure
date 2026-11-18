import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { appPageMatcher, focusExisting, guardNavigation, HIDDEN_ARG, quitOnAllClosed, reopenWindow, showTodoBadge, withoutHiddenArg } from '../src/main/window'
import { createTrayControl, type TraySpec } from '../src/main/tray'

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

describe('창 수명 — 닫기 · 다시 열기(두레를 또 켬 · mac Dock 아이콘)', () => {
  /** 보이기만 흉내 내는 창 */
  const liveWindow = () => {
    const w = {
      visible: true,
      isDestroyed: () => false,
      isMinimized: () => false,
      isVisible: () => w.visible,
      restore: vi.fn(),
      show: vi.fn(() => {
        w.visible = true
      }),
      focus: vi.fn(),
      hide: vi.fn(() => {
        w.visible = false
      }),
    }
    return w
  }
  const trayDeps = (makeTray: (spec: TraySpec) => { update(): void; destroy(): void }) => ({
    makeTray,
    showWindow: vi.fn(),
    phoneOff: vi.fn(),
    quit: vi.fn(),
    notifyOnce: vi.fn(),
    log: vi.fn(),
  })

  it('darwin_에서_창을_닫으면_숨고_activate_에서_다시_보인다', () => {
    const win = liveWindow()
    const requestShow = vi.fn()
    // index.ts 처럼: 창 'close' → tray.close(…, dock: mac), app 'activate' → reopenWindow
    const tray = createTrayControl(trayDeps(() => ({ update: vi.fn(), destroy: vi.fn() })))
    const e = { preventDefault: vi.fn() }
    expect(tray.close(e, { quitting: false, hide: () => win.hide(), dock: true })).toBe('hide')
    expect(e.preventDefault).toHaveBeenCalledTimes(1)
    expect(win.visible).toBe(false)
    // Dock 아이콘 누름(activate) — 숨은 창이 다시 보이고 앞으로
    reopenWindow({ win, requestShow })
    expect(win.visible).toBe(true)
    expect(win.focus).toHaveBeenCalledTimes(1)
    expect(requestShow).not.toHaveBeenCalled()

    // mac 은 메뉴 막대 아이콘을 못 만들어도 숨긴다 — Dock 아이콘이 늘 창을 되찾아 준다
    const broken = createTrayControl(trayDeps(() => {
      throw new Error('no tray')
    }))
    const w2 = liveWindow()
    const e2 = { preventDefault: vi.fn() }
    expect(broken.close(e2, { quitting: false, hide: () => w2.hide(), dock: true })).toBe('hide')
    expect(w2.visible).toBe(false)
    reopenWindow({ win: w2, requestShow })
    expect(w2.visible).toBe(true)

    // Cmd+Q(before-quit 이 정리를 시작함) 뒤의 창 닫기는 막지 않는다 — 끄기가 멈추지 않게
    const quitting = { preventDefault: vi.fn() }
    expect(tray.close(quitting, { quitting: true, hide: () => win.hide(), dock: true })).toBe('close')
    expect(quitting.preventDefault).not.toHaveBeenCalled()
  })

  it('reopenWindow — 창이 아직 없으면(엔진 준비 중) 보여 달라고 적어 둔다 · 파괴된 창은 건드리지 않는다', () => {
    const requestShow = vi.fn()
    reopenWindow({ win: null, requestShow })
    expect(requestShow).toHaveBeenCalledTimes(1)
    const dead = { isDestroyed: () => true, isMinimized: vi.fn(), isVisible: vi.fn(), restore: vi.fn(), show: vi.fn(), focus: vi.fn() }
    reopenWindow({ win: dead, requestShow })
    expect(dead.show).not.toHaveBeenCalled()
    expect(requestShow).toHaveBeenCalledTimes(1)
  })

  it('darwin_window-all-closed_에_앱이_안_꺼진다 · win32 는 지금처럼 끈다', () => {
    expect(quitOnAllClosed('darwin')).toBe(false)
    expect(quitOnAllClosed('win32')).toBe(true)
  })
})

describe('showTodoBadge — 할 일 수 배지', () => {
  const targets = () => ({ overlay: vi.fn(), dock: vi.fn() })

  it('win32 — 작업 표시줄 겹침 아이콘(지금 그대로): 그림·설명, 0 이면 지운다 · Dock 은 안 부른다', () => {
    const t = targets()
    showTodoBadge('win32', 3, 'data:image/png;base64,AAA', t)
    expect(t.overlay).toHaveBeenLastCalledWith('data:image/png;base64,AAA', '할 일 3개')
    showTodoBadge('win32', 0, 'data:image/png;base64,AAA', t)
    expect(t.overlay).toHaveBeenLastCalledWith(null, '')
    showTodoBadge('win32', 2, null, t)
    expect(t.overlay).toHaveBeenLastCalledWith(null, '할 일 2개')
    expect(t.dock).not.toHaveBeenCalled()
  })

  it('darwin_은_app.dock.setBadge — 숫자 글, 0 이면 빈 글 · 겹침 아이콘(Windows 전용 API)은 안 부른다', () => {
    const t = targets()
    showTodoBadge('darwin', 3, 'data:image/png;base64,AAA', t)
    expect(t.dock).toHaveBeenLastCalledWith('3')
    showTodoBadge('darwin', 0, null, t)
    expect(t.dock).toHaveBeenLastCalledWith('')
    expect(t.overlay).not.toHaveBeenCalled()
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
