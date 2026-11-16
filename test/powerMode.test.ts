import { describe, expect, it, vi } from 'vitest'
import { createPowerMode } from '../src/main/powerMode'

function setup(o: { full?: boolean; max?: boolean } = {}) {
  const win = {
    isFullScreen: vi.fn(() => o.full ?? false),
    isMaximized: vi.fn(() => o.max ?? false),
    setFullScreen: vi.fn(),
    maximize: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
  }
  const blocker = { start: vi.fn(() => 7), stop: vi.fn() }
  const pm = createPowerMode({ win: () => win, blocker })
  return { win, blocker, pm }
}

describe('createPowerMode', () => {
  it('켜면_전체화면_화면꺼짐막기', () => {
    const { win, blocker, pm } = setup()
    pm.set(true)
    expect(win.setFullScreen).toHaveBeenCalledTimes(1)
    expect(win.setFullScreen).toHaveBeenCalledWith(true)
    expect(blocker.start).toHaveBeenCalledTimes(1)
    expect(pm.isOn()).toBe(true)
  })

  it('두번_켜도_한번만', () => {
    const { blocker, pm } = setup()
    pm.set(true)
    pm.set(true)
    expect(blocker.start).toHaveBeenCalledTimes(1)
  })

  it('끄면_원래대로 — 최대화였으면 전체 화면을 풀고 다시 최대화', () => {
    const { win, blocker, pm } = setup({ max: true })
    pm.set(true)
    pm.set(false)
    expect(win.setFullScreen).toHaveBeenLastCalledWith(false)
    expect(win.maximize).toHaveBeenCalledTimes(1)
    const off = win.setFullScreen.mock.invocationCallOrder[1]
    expect(off).toBeLessThan(win.maximize.mock.invocationCallOrder[0])
    expect(blocker.stop).toHaveBeenCalledTimes(1)
    expect(blocker.stop).toHaveBeenCalledWith(7)
    expect(pm.isOn()).toBe(false)
  })

  it('끄면_원래대로 — 켜기 전 전체 화면이었으면 풀지 않는다', () => {
    const { win, blocker, pm } = setup({ full: true })
    pm.set(true)
    pm.set(false)
    expect(win.setFullScreen).not.toHaveBeenCalledWith(false)
    expect(win.maximize).not.toHaveBeenCalled()
    expect(blocker.stop).toHaveBeenCalledWith(7)
  })

  it('release_는_켜져있을때만_풀고_꺼진걸로 — 창도 끌 때처럼 되돌린다', () => {
    const { win, blocker, pm } = setup({ max: true })
    pm.release()
    expect(blocker.stop).not.toHaveBeenCalled()
    expect(win.setFullScreen).not.toHaveBeenCalled()
    pm.set(true)
    pm.release()
    expect(pm.isOn()).toBe(false)
    expect(blocker.stop).toHaveBeenCalledTimes(1)
    expect(win.setFullScreen).toHaveBeenLastCalledWith(false)
    expect(win.maximize).toHaveBeenCalledTimes(1)
    pm.release()
    expect(blocker.stop).toHaveBeenCalledTimes(1)
    expect(win.maximize).toHaveBeenCalledTimes(1)
  })

  it('release_는_켜기전_전체화면이면_풀지않는다', () => {
    const { win, pm } = setup({ full: true })
    pm.set(true)
    pm.release()
    expect(win.setFullScreen).not.toHaveBeenCalled()
  })

  it('켤_때_창이_없고_끌_때_창이_있으면_maximize_를_부르지_않는다', () => {
    const win = {
      isFullScreen: vi.fn(() => false),
      isMaximized: vi.fn(() => true),
      setFullScreen: vi.fn(),
      maximize: vi.fn(),
      show: vi.fn(),
      focus: vi.fn(),
    }
    let cur: typeof win | null = null
    const blocker = { start: vi.fn(() => 3), stop: vi.fn() }
    const pm = createPowerMode({ win: () => cur, blocker })
    pm.set(true)
    cur = win
    pm.set(false)
    expect(win.maximize).not.toHaveBeenCalled()
  })

  it('막기_시작이_던지면_켜진_것으로_치지_않는다', () => {
    const blocker = { start: vi.fn(() => { throw new Error('x') }), stop: vi.fn() }
    const pm = createPowerMode({ win: () => null, blocker })
    expect(() => pm.set(true)).toThrow()
    expect(pm.isOn()).toBe(false)
  })

  it('창이_없어도_던지지않는다', () => {
    const blocker = { start: vi.fn(() => 1), stop: vi.fn() }
    const pm = createPowerMode({ win: () => null, blocker })
    expect(() => pm.set(true)).not.toThrow()
    expect(() => pm.set(false)).not.toThrow()
    expect(blocker.stop).toHaveBeenCalledWith(1)
  })
})
