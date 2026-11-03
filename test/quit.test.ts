import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createQuitControl, INSTALL_EXIT_FALLBACK_MS, quitDecision } from '../src/main/quit'

const idle = { settled: false, installing: false, exitScheduled: false }

describe('quitDecision', () => {
  it('보통 끄기 — 정리 전이면 막고, 정리 뒤 바로 끈다', () => {
    expect(quitDecision(idle)).toBe('exit')
  })
  it('설치 정리 중에 창을 닫으면 막고, 정리 뒤 잠시 기다렸다 끈다', () => {
    expect(quitDecision({ ...idle, installing: true })).toBe('fallback')
  })
  it('끄기가 이미 잡혀 있으면 막기만 한다', () => {
    expect(quitDecision({ ...idle, exitScheduled: true })).toBe('wait')
    expect(quitDecision({ ...idle, installing: true, exitScheduled: true })).toBe('wait')
  })
  it('정리가 끝나면(실패도) 그대로 나간다 — 설치의 app.quit 포함', () => {
    expect(quitDecision({ ...idle, settled: true })).toBe('proceed')
    expect(quitDecision({ settled: true, installing: true, exitScheduled: true })).toBe('proceed')
  })
})

function deferred() {
  let resolve!: () => void
  let reject!: (e: unknown) => void
  const promise = new Promise<void>((a, b) => {
    resolve = a
    reject = b
  })
  return { promise, resolve, reject }
}

/** 가짜 앱 — shutdown 은 손으로 끝내고, quit() 은 before-quit 한 번(막혔으면 true) */
function harness(shutdown?: () => Promise<void>) {
  const d = deferred()
  const shutdownFn = vi.fn(shutdown ?? (() => d.promise))
  const exit = vi.fn()
  const ctl = createQuitControl({ shutdown: shutdownFn, exit })
  const quit = (): boolean => {
    const preventDefault = vi.fn()
    ctl.beforeQuit({ preventDefault })
    return preventDefault.mock.calls.length > 0
  }
  return { d, shutdown: shutdownFn, exit, ctl, quit }
}

const flush = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(0)
}

describe('createQuitControl', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('보통 끄기 — 정리는 한 번, 끝나면 바로 끈다', async () => {
    const { d, shutdown, exit, ctl, quit } = harness()
    expect(ctl.started()).toBe(false)
    expect(quit()).toBe(true)
    expect(ctl.started()).toBe(true)
    expect(quit()).toBe(true)
    expect(shutdown).toHaveBeenCalledTimes(1)
    await flush()
    expect(exit).not.toHaveBeenCalled()
    d.resolve()
    await flush()
    expect(exit).toHaveBeenCalledTimes(1)
    // 정리가 끝난 뒤의 before-quit 은 막지 않는다
    expect(quit()).toBe(false)
    expect(shutdown).toHaveBeenCalledTimes(1)
  })

  it('보통 끄기 — 정리가 실패해도 끈다', async () => {
    const { d, exit, quit } = harness()
    expect(quit()).toBe(true)
    d.reject(new Error('mcp.close'))
    await flush()
    expect(exit).toHaveBeenCalledTimes(1)
  })

  it('설치 정리가 실패하면 — 설치는 던지고, 뒤의 끄기는 그대로 나간다', async () => {
    const { d, shutdown, exit, ctl, quit } = harness()
    const install = ctl.prepareInstall()
    d.reject(new Error('mcp.close'))
    await expect(install).rejects.toThrow('mcp.close')
    expect(quit()).toBe(false)
    expect(shutdown).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(exit).not.toHaveBeenCalled()
  })

  it('정리가 동기로 던져도 끝난 것으로 친다', async () => {
    const { ctl, quit } = harness(() => {
      throw new Error('sync')
    })
    await expect(ctl.prepareInstall()).rejects.toThrow('sync')
    expect(quit()).toBe(false)
  })

  it('설치 정리 중 창을 닫고 quitAndInstall 이 안 나가면 — 정리 뒤 5초에 끈다', async () => {
    const { d, shutdown, exit, ctl, quit } = harness()
    const install = ctl.prepareInstall()
    expect(quit()).toBe(true)
    expect(quit()).toBe(true)
    expect(shutdown).toHaveBeenCalledTimes(1)
    // 정리가 오래 걸려도 끝나기 전엔 끄지 않는다(설치가 사라지지 않게)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(exit).not.toHaveBeenCalled()
    d.resolve()
    await install // 여기서 quitAndInstall 이 아무 일 없이 돌아온다(설치 파일 없음 등)
    await vi.advanceTimersByTimeAsync(INSTALL_EXIT_FALLBACK_MS - 1)
    expect(exit).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(exit).toHaveBeenCalledTimes(1)
  })

  it('설치 정리 중 창을 닫고 정리마저 실패해도 — 정리 뒤 5초에 끈다', async () => {
    const { d, exit, ctl, quit } = harness()
    const install = ctl.prepareInstall()
    expect(quit()).toBe(true)
    d.reject(new Error('mcp.close'))
    await expect(install).rejects.toThrow('mcp.close')
    await vi.advanceTimersByTimeAsync(INSTALL_EXIT_FALLBACK_MS)
    expect(exit).toHaveBeenCalledTimes(1)
  })

  it('설치 성공(창을 닫은 채) — quitAndInstall 의 app.quit 이 먼저 그대로 나가고, 그 전엔 끄지 않는다', async () => {
    const { d, exit, ctl, quit } = harness()
    const install = ctl.prepareInstall()
    expect(quit()).toBe(true)
    d.resolve()
    await install
    // quitAndInstall → setImmediate → app.quit → before-quit
    expect(quit()).toBe(false)
    expect(exit).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(INSTALL_EXIT_FALLBACK_MS - 1)
    expect(exit).not.toHaveBeenCalled()
  })

  it('설치 성공(창 그대로) — 따로 끄기를 걸지 않는다', async () => {
    const { d, exit, ctl, quit } = harness()
    const install = ctl.prepareInstall()
    d.resolve()
    await install
    expect(quit()).toBe(false)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(exit).not.toHaveBeenCalled()
  })
})
