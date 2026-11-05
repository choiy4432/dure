import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readAppPrefs, writeAppPrefs } from '../src/main/appPrefs'
import {
  closeDecision,
  createTrayControl,
  trayTipOnce,
  TRAY_MENU,
  TRAY_TIP,
  type TraySpec,
} from '../src/main/tray'

/** 가짜 트레이 — 진짜 Tray 는 만들지 않는다. 만든 차례대로 spec·destroy 를 남긴다 */
function fakeTrays() {
  const made: { spec: TraySpec; destroy: ReturnType<typeof vi.fn> }[] = []
  const makeTray = vi.fn((spec: TraySpec) => {
    const t = { spec, destroy: vi.fn() }
    made.push(t)
    return t
  })
  return { made, makeTray }
}

function setup(o: { visible?: boolean; makeTray?: (spec: TraySpec) => { destroy(): void } } = {}) {
  const trays = fakeTrays()
  const win = { visible: o.visible ?? true }
  const deps = {
    makeTray: o.makeTray ?? trays.makeTray,
    showWindow: vi.fn(() => {
      win.visible = true
    }),
    isWindowVisible: vi.fn(() => win.visible),
    phoneOff: vi.fn(),
    quit: vi.fn(),
    notifyOnce: vi.fn(),
    log: vi.fn(),
  }
  const tray = createTrayControl(deps)
  return { tray, deps, win, ...trays }
}

const closeEvent = () => ({ preventDefault: vi.fn() })

describe('closeDecision · 창 닫기', () => {
  it('켜짐 + 닫기 = 숨기기, 꺼짐 = 닫기, quit 중 = 닫기', () => {
    expect(closeDecision({ phoneOn: true, quitting: false })).toBe('hide')
    expect(closeDecision({ phoneOn: false, quitting: false })).toBe('close')
    expect(closeDecision({ phoneOn: true, quitting: true })).toBe('close')
    expect(closeDecision({ phoneOn: false, quitting: true })).toBe('close')

    // 창 'close' 를 받는 쪽 — 숨길 때만 막고(preventDefault) 숨긴다
    const { tray, deps, made, win } = setup()
    const hide = vi.fn(() => {
      win.visible = false
    })

    const off = closeEvent()
    expect(tray.close(off, { phoneOn: false, quitting: false, hide })).toBe('close')
    expect(off.preventDefault).not.toHaveBeenCalled()
    expect(hide).not.toHaveBeenCalled()
    expect(made).toHaveLength(0)

    // 끄는 중(두레 끄기·업데이트 설치)엔 휴대폰 연결이 켜져 있어도 그냥 닫힌다 — 막으면 끄기가 멈춘다
    const quitting = closeEvent()
    expect(tray.close(quitting, { phoneOn: true, quitting: true, hide })).toBe('close')
    expect(quitting.preventDefault).not.toHaveBeenCalled()
    expect(hide).not.toHaveBeenCalled()

    const on = closeEvent()
    expect(tray.close(on, { phoneOn: true, quitting: false, hide })).toBe('hide')
    expect(on.preventDefault).toHaveBeenCalledTimes(1)
    expect(hide).toHaveBeenCalledTimes(1)
    expect(deps.notifyOnce).toHaveBeenCalledTimes(1)
    // 켜기가 아직 도는 중이라 'phone' 사건 전이어도 — 숨긴 창엔 늘 트레이가 있다
    expect(made).toHaveLength(1)
    expect(deps.quit).not.toHaveBeenCalled()
  })

  it('트레이를 못 만들면 숨기지 않고 닫는다 — 트레이 없이 안 보이는 두레가 되지 않게', () => {
    const { tray, deps } = setup({
      makeTray: () => {
        throw new Error('no tray')
      },
    })
    const hide = vi.fn()
    const e = closeEvent()
    expect(tray.close(e, { phoneOn: true, quitting: false, hide })).toBe('close')
    expect(e.preventDefault).not.toHaveBeenCalled()
    expect(hide).not.toHaveBeenCalled()
    expect(deps.notifyOnce).not.toHaveBeenCalled()
    expect(deps.log).toHaveBeenCalled()
  })
})

describe('createTrayControl · 트레이', () => {
  it('트레이 — 켜지면 생기고 꺼지면 없어짐, 메뉴 세 개', () => {
    const { tray, deps, made, makeTray } = setup()
    tray.sync(false)
    expect(makeTray).not.toHaveBeenCalled()

    tray.sync(true)
    tray.sync(true) // 같은 상태면 또 만들지 않는다
    expect(makeTray).toHaveBeenCalledTimes(1)
    const { spec } = made[0]
    expect(spec.tooltip).toContain('두레')
    expect(spec.menu.map((m) => m.label)).toEqual(['두레 열기', '휴대폰 연결 끄기', '두레 끄기'])
    expect(spec.menu.map((m) => m.label)).toEqual([TRAY_MENU.open, TRAY_MENU.phoneOff, TRAY_MENU.quit])

    // 누르면 창 열기 · 메뉴 셋은 각자 제 일만
    spec.onClick()
    expect(deps.showWindow).toHaveBeenCalledTimes(1)
    spec.menu[0].click()
    expect(deps.showWindow).toHaveBeenCalledTimes(2)
    expect(deps.phoneOff).not.toHaveBeenCalled()
    spec.menu[1].click()
    expect(deps.phoneOff).toHaveBeenCalledTimes(1)
    expect(deps.quit).not.toHaveBeenCalled()
    spec.menu[2].click()
    expect(deps.quit).toHaveBeenCalledTimes(1) // 두레 끄기 = app.quit() — 지금 끄는 길 그대로
    expect(deps.showWindow).toHaveBeenCalledTimes(2)
    expect(made[0].destroy).not.toHaveBeenCalled() // 끄기는 quit 흐름이 트레이를 거둔다(dispose)

    // 꺼지면 없어진다 — 창이 보이고 있으면 창은 그대로
    tray.sync(false)
    tray.sync(false)
    expect(made[0].destroy).toHaveBeenCalledTimes(1)
    expect(deps.showWindow).toHaveBeenCalledTimes(2)

    // 다시 켜면 새로
    tray.sync(true)
    expect(made).toHaveLength(2)

    // 두레를 끄면(dispose) 거두고, 그 뒤엔 사건이 와도 다시 만들지 않는다
    tray.dispose()
    tray.dispose()
    expect(made[1].destroy).toHaveBeenCalledTimes(1)
    tray.sync(true)
    expect(made).toHaveLength(2)
    const e = closeEvent()
    expect(tray.close(e, { phoneOn: true, quitting: false, hide: vi.fn() })).toBe('close')
    expect(e.preventDefault).not.toHaveBeenCalled()
  })

  it('휴대폰 연결이 꺼져 트레이가 없어질 때 창이 숨어 있으면 보인다', () => {
    const { tray, deps, made, win } = setup()
    tray.sync(true)
    tray.close(closeEvent(), { phoneOn: true, quitting: false, hide: () => (win.visible = false) })
    expect(win.visible).toBe(false)
    expect(deps.showWindow).not.toHaveBeenCalled()

    tray.sync(false) // 트레이의 '휴대폰 연결 끄기' 뒤 'phone' 사건
    expect(made[0].destroy).toHaveBeenCalledTimes(1)
    expect(deps.showWindow).toHaveBeenCalledTimes(1)
    expect(win.visible).toBe(true)

    // 처음부터 트레이가 없었으면(꺼진 채 시작) 창을 건드리지 않는다 — 화면이 뜨기 전에 보이지 않게
    const fresh = setup({ visible: false })
    fresh.tray.sync(false)
    expect(fresh.deps.showWindow).not.toHaveBeenCalled()
    expect(fresh.deps.isWindowVisible).not.toHaveBeenCalled()
  })

  it('메뉴·누름에서 던져도 트레이가 깨지지 않는다 — 기록만', () => {
    const { tray, deps, made } = setup()
    deps.phoneOff.mockImplementation(() => {
      throw new Error('x')
    })
    deps.showWindow.mockImplementation(() => {
      throw new Error('y')
    })
    tray.sync(true)
    expect(() => made[0].spec.menu[1].click()).not.toThrow()
    expect(() => made[0].spec.onClick()).not.toThrow()
    expect(deps.log).toHaveBeenCalledTimes(2)
  })
})

describe('trayTipOnce · 첫 숨김 안내', () => {
  let dir: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dure-tray-'))
  })
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  /** index.ts 와 같은 꼴 — 본 적 있나는 appPrefs.trayTipSeen, 보면 써 둔다 */
  const tipFor = (notify: () => void, log = vi.fn()) =>
    trayTipOnce({
      seen: () => readAppPrefs(dir).trayTipSeen,
      markSeen: () => {
        writeAppPrefs(dir, { trayTipSeen: true })
      },
      notify,
      log,
    })

  it('첫 숨김 안내 한 번만', () => {
    expect(TRAY_TIP).toBe('두레는 트레이에서 계속 돌아요')
    expect(readAppPrefs(dir).trayTipSeen).toBe(false)

    const notify = vi.fn()
    const { deps, win } = setup()
    const tray = createTrayControl({ ...deps, notifyOnce: tipFor(notify) })
    const hide = () => (win.visible = false)
    // 닫기(숨기기)를 여러 번 — 안내는 처음 한 번
    for (let i = 0; i < 3; i++) {
      tray.sync(true)
      expect(tray.close(closeEvent(), { phoneOn: true, quitting: false, hide })).toBe('hide')
      win.visible = true
    }
    expect(notify).toHaveBeenCalledTimes(1)
    expect(readAppPrefs(dir).trayTipSeen).toBe(true)
    // 꺼진 채 닫으면(숨기지 않음) 안내도 없다
    expect(tray.close(closeEvent(), { phoneOn: false, quitting: false, hide })).toBe('close')
    expect(notify).toHaveBeenCalledTimes(1)
    tray.dispose()

    // 두레를 다시 켜도(새 trayTipOnce) 다시 안 뜬다 — settings.json 의 trayTipSeen
    const again = vi.fn()
    const next = tipFor(again)
    next()
    next()
    expect(again).not.toHaveBeenCalled()
  })

  it('알림이 실패하면 본 것으로 쓰지 않는다(다음에 다시) — 그래도 이번엔 한 번만 해 본다', () => {
    const log = vi.fn()
    const notify = vi.fn(() => {
      throw new Error('no toast')
    })
    const tip = tipFor(notify, log)
    expect(() => tip()).not.toThrow()
    tip()
    expect(notify).toHaveBeenCalledTimes(1)
    expect(log).toHaveBeenCalledTimes(1)
    expect(readAppPrefs(dir).trayTipSeen).toBe(false)
  })

  it('써 두기가 실패해도 던지지 않는다 — 이번엔 한 번만', () => {
    const log = vi.fn()
    const notify = vi.fn()
    const tip = trayTipOnce({
      seen: () => false,
      markSeen: () => {
        throw new Error('locked')
      },
      notify,
      log,
    })
    expect(() => tip()).not.toThrow()
    tip()
    expect(notify).toHaveBeenCalledTimes(1)
    expect(log).toHaveBeenCalledTimes(1)
  })
})
