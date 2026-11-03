import { describe, it, expect, vi } from 'vitest'
import { runStartup, type StartupDeps } from '../src/main/startup'
import type { ClaudeUpdateState } from '../src/shared/appTypes'

/** 가짜 — 부른 차례를 한 줄에 적는다 */
function fakes(over: Partial<StartupDeps> = {}) {
  const order: string[] = []
  const log = vi.fn()
  const d: StartupDeps = {
    check: vi.fn(async () => { order.push('check') }),
    autoUpdate: true,
    update: vi.fn(async () => { order.push('update'); return 'ok' }),
    start: vi.fn(() => { order.push('start') }),
    emit: vi.fn((s: ClaudeUpdateState) => { order.push(`emit:${s}`) }),
    ready: vi.fn(() => { order.push('ready') }),
    log,
    ...over,
  }
  return { d, order, log }
}

describe('runStartup', () => {
  it('차례: check → running → update → done → start → ready', async () => {
    const { d, order } = fakes()
    await runStartup(d)
    expect(order).toEqual(['check', 'emit:running', 'update', 'emit:done', 'start', 'ready'])
  })

  it('check 가 끝나기 전엔 update 를 띄우지 않는다(claude 가 둘 겹치지 않게)', async () => {
    let endCheck!: () => void
    const { d, order } = fakes({ check: vi.fn(() => new Promise<void>((r) => (endCheck = r))) })
    const p = runStartup(d)
    await new Promise((r) => setTimeout(r, 5))
    expect(d.update).not.toHaveBeenCalled()
    expect(d.start).not.toHaveBeenCalled()
    endCheck()
    await p
    expect(order).toEqual(['emit:running', 'update', 'emit:done', 'start', 'ready'])
  })

  it('update 가 끝나기 전엔 start·ready 가 없다', async () => {
    let endUpdate!: () => void
    const { d } = fakes({ update: vi.fn(() => new Promise((r) => (endUpdate = () => r('ok')))) })
    const p = runStartup(d)
    await new Promise((r) => setTimeout(r, 5))
    expect(d.emit).toHaveBeenCalledWith('running')
    expect(d.emit).not.toHaveBeenCalledWith('done')
    expect(d.start).not.toHaveBeenCalled()
    expect(d.ready).not.toHaveBeenCalled()
    endUpdate()
    await p
    expect(d.start).toHaveBeenCalledTimes(1)
    expect(d.ready).toHaveBeenCalledTimes(1)
  })

  it('autoUpdate 끔 — update·emit 없이 check → start → ready', async () => {
    const { d, order } = fakes({ autoUpdate: false })
    await runStartup(d)
    expect(order).toEqual(['check', 'start', 'ready'])
    expect(d.update).not.toHaveBeenCalled()
    expect(d.emit).not.toHaveBeenCalled()
  })

  it('update 가 거절해도 done 을 내고 start 한 번 · ready', async () => {
    const { d, order, log } = fakes({ update: vi.fn(async () => { throw new Error('갱신 실패') }) })
    await expect(runStartup(d)).resolves.toBeUndefined()
    expect(order).toEqual(['check', 'emit:running', 'emit:done', 'start', 'ready'])
    expect(d.start).toHaveBeenCalledTimes(1)
    expect(log).toHaveBeenCalled()
  })

  it('update 가 timeout 으로 끝나도 그대로 start · ready', async () => {
    const { d, order } = fakes({ update: vi.fn(async () => 'timeout') })
    await runStartup(d)
    expect(order).toEqual(['check', 'emit:running', 'emit:done', 'start', 'ready'])
  })

  it('check 가 던져도 update → start → ready', async () => {
    const { d, order, log } = fakes({ check: vi.fn(async () => { throw new Error('auth status 실패') }) })
    await expect(runStartup(d)).resolves.toBeUndefined()
    expect(order).toEqual(['emit:running', 'update', 'emit:done', 'start', 'ready'])
    expect(log).toHaveBeenCalled()
  })

  it('emit 이 던져도 start 한 번 · ready', async () => {
    const { d } = fakes({ emit: vi.fn(() => { throw new Error('창 없음') }) })
    await expect(runStartup(d)).resolves.toBeUndefined()
    expect(d.start).toHaveBeenCalledTimes(1)
    expect(d.ready).toHaveBeenCalledTimes(1)
  })

  it('start 가 던져도 ready 는 풀고 거절하지 않는다', async () => {
    const { d } = fakes({ start: vi.fn(() => { throw new Error('시작 실패') }) })
    await expect(runStartup(d)).resolves.toBeUndefined()
    expect(d.start).toHaveBeenCalledTimes(1)
    expect(d.ready).toHaveBeenCalledTimes(1)
  })
})
