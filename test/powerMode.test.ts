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

  it('release_는_켜져있을때만_풀고_꺼진걸로', () => {
    const { blocker, pm } = setup()
    pm.release()
    expect(blocker.stop).not.toHaveBeenCalled()
    pm.set(true)
    pm.release()
    expect(pm.isOn()).toBe(false)
    expect(blocker.stop).toHaveBeenCalledTimes(1)
    pm.release()
    expect(blocker.stop).toHaveBeenCalledTimes(1)
  })

  it('창이_없어도_던지지않는다', () => {
    const blocker = { start: vi.fn(() => 1), stop: vi.fn() }
    const pm = createPowerMode({ win: () => null, blocker })
    expect(() => pm.set(true)).not.toThrow()
    expect(() => pm.set(false)).not.toThrow()
    expect(blocker.stop).toHaveBeenCalledWith(1)
  })
})
