import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readAppPrefs, writeAppPrefs } from '../src/main/appPrefs'
import {
  closeDecision,
  createTrayControl,
  startHidden,
  trayTipOnce,
  TRAY_MENU,
  TRAY_TIP,
  TRAY_TOOLTIP,
  TRAY_TOOLTIP_PHONE,
  type TraySpec,
} from '../src/main/tray'

type Shown = Pick<TraySpec, 'tooltip' | 'menu'>
/** 가짜 트레이 — 진짜 Tray 는 만들지 않는다. 만든 차례대로 spec·바뀐 메뉴(updates)·destroy 를 남긴다 */
function fakeTrays() {
  const made: { spec: TraySpec; updates: Shown[]; now: () => Shown; destroy: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> }[] = []
  const makeTray = vi.fn((spec: TraySpec) => {
    const updates: Shown[] = []
    const t = {
      spec,
      updates,
      now: () => updates.at(-1) ?? spec,
      destroy: vi.fn(),
      update: vi.fn((s: Shown) => void updates.push(s)),
    }
    made.push(t)
    return t
  })
  return { made, makeTray }
}

function setup(o: { makeTray?: (spec: TraySpec) => { update(s: Shown): void; destroy(): void } } = {}) {
  const trays = fakeTrays()
  const win = { visible: true }
  const deps = {
    makeTray: o.makeTray ?? trays.makeTray,
    showWindow: vi.fn(() => {
      win.visible = true
    }),
    phoneOff: vi.fn(),
    quit: vi.fn(),
    notifyOnce: vi.fn(),
    log: vi.fn(),
  }
  const tray = createTrayControl(deps)
  return { tray, deps, win, ...trays }
}

const closeEvent = () => ({ preventDefault: vi.fn() })
const labels = (s: Shown) => s.menu.map((m) => m.label)

describe('closeDecision · 창 닫기', () => {
  it('닫기 = 숨기기(트레이로) · 끄는 중이면 닫기', () => {
    expect(closeDecision({ quitting: false })).toBe('hide')
    expect(closeDecision({ quitting: true })).toBe('close')

    // 창 'close' 를 받는 쪽 — 숨길 때만 막고(preventDefault) 숨긴다
    const { tray, deps, made, win } = setup()
    const hide = vi.fn(() => {
      win.visible = false
    })

    // 끄는 중(두레 끄기·업데이트 설치·Windows 로그아웃)엔 그냥 닫힌다 — 막으면 끄기가 멈춘다
    const quitting = closeEvent()
    expect(tray.close(quitting, { quitting: true, hide })).toBe('close')
    expect(quitting.preventDefault).not.toHaveBeenCalled()
    expect(hide).not.toHaveBeenCalled()

    // 휴대폰 연결과 상관없이 숨긴다(2026-11-06 사용자 결정 — 전엔 휴대폰 연결이 켜져 있을 때만)
    const e = closeEvent()
    expect(tray.close(e, { quitting: false, hide })).toBe('hide')
    expect(e.preventDefault).toHaveBeenCalledTimes(1)
    expect(hide).toHaveBeenCalledTimes(1)
    expect(deps.notifyOnce).toHaveBeenCalledTimes(1)
    // 아직 트레이가 없었어도(sync 전) — 숨긴 창엔 늘 트레이가 있다
    expect(made).toHaveLength(1)
    expect(labels(made[0].spec)).toEqual([TRAY_MENU.open, TRAY_MENU.quit])
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
    expect(tray.close(e, { quitting: false, hide })).toBe('close')
    expect(e.preventDefault).not.toHaveBeenCalled()
    expect(hide).not.toHaveBeenCalled()
    expect(deps.notifyOnce).not.toHaveBeenCalled()
    expect(deps.log).toHaveBeenCalled()
  })
})

describe('startHidden · 숨겨 시작', () => {
  const base = { launchedHidden: true, trayActive: true, showRequested: false }

  it('--hidden · 트레이 있음 · 창을 보여 달란 적 없음 — 그때만 숨긴다(휴대폰 연결과 상관없이)', () => {
    expect(startHidden(base)).toBe(true)
  })

  it('하나라도 빠지면 창을 보인다 — 창도 트레이도 없는 두레가 되지 않게', () => {
    expect(startHidden({ ...base, launchedHidden: false })).toBe(false) // 그냥 켬
    // 트레이를 못 만들었으면(아이콘을 못 읽음 등 — 기록만 남는다) 숨기면 다시 켜는 수밖에 없다
    expect(startHidden({ ...base, trayActive: false })).toBe(false)
    // 창이 생기기 전(엔진 준비 중)에 두레를 또 켰으면 — 그 요청을 잃지 않고 보인다
    expect(startHidden({ ...base, showRequested: true })).toBe(false)
  })

  it('active — 트레이가 지금 있는지(숨겨 시작이 이걸 본다) · 휴대폰 연결이 꺼져도 있다', () => {
    const { tray, made } = setup()
    expect(tray.active()).toBe(false)
    tray.sync(false)
    expect(tray.active()).toBe(true)
    tray.sync(true)
    tray.sync(false)
    expect(made).toHaveLength(1)
    expect(made[0].destroy).not.toHaveBeenCalled()
    expect(tray.active()).toBe(true)
    tray.dispose()
    expect(tray.active()).toBe(false)

    // new Tray 가 던지면(아이콘을 못 읽음) 트레이는 없다
    const broken = setup({
      makeTray: () => {
        throw new Error('no icon')
      },
    })
    broken.tray.sync(true)
    expect(broken.tray.active()).toBe(false)
    expect(broken.deps.log).toHaveBeenCalled()
  })
})

describe('createTrayControl · 트레이', () => {
  it('트레이는 늘 있다 — 휴대폰 연결이 켜지면 메뉴에 \'휴대폰 연결 끄기\'가 더 생기고 꺼지면 빠진다(아이콘은 그대로)', () => {
    const { tray, deps, made, makeTray } = setup()
    tray.sync(false)
    tray.sync(false) // 같은 상태면 또 만들거나 바꾸지 않는다
    expect(makeTray).toHaveBeenCalledTimes(1)
    expect(made[0].update).not.toHaveBeenCalled()
    expect(made[0].spec.tooltip).toBe(TRAY_TOOLTIP)
    expect(labels(made[0].spec)).toEqual(['두레 열기', '두레 끄기'])

    tray.sync(true)
    tray.sync(true)
    expect(made[0].update).toHaveBeenCalledTimes(1)
    expect(made[0].now().tooltip).toBe(TRAY_TOOLTIP_PHONE)
    expect(labels(made[0].now())).toEqual(['두레 열기', '휴대폰 연결 끄기', '두레 끄기'])
    expect(labels(made[0].now())).toEqual([TRAY_MENU.open, TRAY_MENU.phoneOff, TRAY_MENU.quit])

    // 누르면 창 열기 · 메뉴 셋은 각자 제 일만
    const menu = made[0].now().menu
    made[0].spec.onClick()
    expect(deps.showWindow).toHaveBeenCalledTimes(1)
    menu[0].click()
    expect(deps.showWindow).toHaveBeenCalledTimes(2)
    expect(deps.phoneOff).not.toHaveBeenCalled()
    menu[1].click()
    expect(deps.phoneOff).toHaveBeenCalledTimes(1)
    expect(deps.quit).not.toHaveBeenCalled()
    menu[2].click()
    expect(deps.quit).toHaveBeenCalledTimes(1) // 두레 끄기 = app.quit() — 지금 끄는 길 그대로
    expect(deps.showWindow).toHaveBeenCalledTimes(2)
    expect(made[0].destroy).not.toHaveBeenCalled() // 끄기는 quit 흐름이 트레이를 거둔다(dispose)

    // 꺼지면 메뉴만 — 트레이는 그대로, 숨은 창도 그대로(트레이에서 열면 된다)
    tray.sync(false)
    expect(made).toHaveLength(1)
    expect(made[0].destroy).not.toHaveBeenCalled()
    expect(labels(made[0].now())).toEqual([TRAY_MENU.open, TRAY_MENU.quit])
    expect(made[0].now().tooltip).toBe(TRAY_TOOLTIP)
    expect(deps.showWindow).toHaveBeenCalledTimes(2)

    // 두레를 끄면(dispose) 거두고, 그 뒤엔 사건이 와도 다시 만들지 않는다
    tray.dispose()
    tray.dispose()
    expect(made[0].destroy).toHaveBeenCalledTimes(1)
    tray.sync(true)
    expect(made).toHaveLength(1)
    const e = closeEvent()
    expect(tray.close(e, { quitting: false, hide: vi.fn() })).toBe('close')
    expect(e.preventDefault).not.toHaveBeenCalled()
  })

  it('휴대폰 연결이 켜진 채 처음 만들면 처음부터 그 메뉴', () => {
    const { tray, made } = setup()
    tray.sync(true)
    expect(labels(made[0].spec)).toEqual([TRAY_MENU.open, TRAY_MENU.phoneOff, TRAY_MENU.quit])
    expect(made[0].spec.tooltip).toBe(TRAY_TOOLTIP_PHONE)
    expect(made[0].update).not.toHaveBeenCalled()
  })

  it('메뉴·누름·메뉴 바꾸기에서 던져도 트레이가 깨지지 않는다 — 기록만', () => {
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
    made[0].update.mockImplementation(() => {
      throw new Error('z')
    })
    expect(() => tray.sync(false)).not.toThrow()
    expect(deps.log).toHaveBeenCalledTimes(3)
    expect(tray.active()).toBe(true)
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
    // 닫기(숨기기)를 여러 번 — 휴대폰 연결이 켜져 있든 꺼져 있든 안내는 처음 한 번
    for (const on of [false, true, false]) {
      tray.sync(on)
      expect(tray.close(closeEvent(), { quitting: false, hide })).toBe('hide')
      win.visible = true
    }
    expect(notify).toHaveBeenCalledTimes(1)
    expect(readAppPrefs(dir).trayTipSeen).toBe(true)
    // 끄는 중에 닫히면(숨기지 않음) 안내도 없다
    expect(tray.close(closeEvent(), { quitting: true, hide })).toBe('close')
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
