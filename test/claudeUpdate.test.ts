import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { CLAUDE_UPDATE_TIMEOUT_MS, updateClaude } from '../src/main/claudeUpdate'

/** 가짜 spawn — 부른 인자를 적고, 돌려준 자식에 사건을 직접 낸다 */
function fakeSpawn() {
  const child = Object.assign(new EventEmitter(), { pid: 4242, stdout: null, stderr: null, kill: vi.fn() })
  const spawn = vi.fn(() => child) as any
  return { spawn, child }
}
const C = { command: 'claude', argsPrefix: ['--x'] }

describe('updateClaude', () => {
  it('상한은 90초', () => expect(CLAUDE_UPDATE_TIMEOUT_MS).toBe(90_000))

  it('코드 0 → ok (명령은 [...argsPrefix, update], 창 없이)', async () => {
    const { spawn, child } = fakeSpawn()
    const run = updateClaude(C, { spawn })
    child.emit('close', 0)
    expect(await run.done).toBe('ok')
    expect(spawn).toHaveBeenCalledWith('claude', ['--x', 'update'], expect.objectContaining({ windowsHide: true }))
  })

  it('코드 1 → failed', async () => {
    const { spawn, child } = fakeSpawn()
    const run = updateClaude(C, { spawn })
    child.emit('close', 1)
    expect(await run.done).toBe('failed')
  })

  it('시간 초과 — 끄고 timeout', async () => {
    const { spawn, child } = fakeSpawn()
    const kill = vi.fn(async () => { child.emit('close', null) })
    expect(await updateClaude(C, { spawn, timeoutMs: 20, kill }).done).toBe('timeout')
    expect(kill).toHaveBeenCalledWith(4242)
  })

  it('spawn 오류 → failed', async () => {
    const { spawn, child } = fakeSpawn()
    const run = updateClaude(C, { spawn })
    child.emit('error', new Error('ENOENT'))
    expect(await run.done).toBe('failed')
  })

  it('spawn 이 던져도 던지지 않고 failed · kill() 은 바로 풀린다', async () => {
    const spawn = (() => { throw new Error('boom') }) as any
    const kill = vi.fn(async () => {})
    const run = updateClaude(C, { spawn, kill })
    expect(await run.done).toBe('failed')
    await run.kill()
    expect(kill).not.toHaveBeenCalled()
  })

  it('kill() — 도는 갱신을 나무째 끄고 끝날 때까지 기다린다 · done 은 failed', async () => {
    const { spawn, child } = fakeSpawn()
    let killed = false
    const kill = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 10))
      killed = true
      child.emit('close', null)
    })
    const run = updateClaude(C, { spawn, kill })
    await run.kill()
    expect(killed).toBe(true)
    expect(kill).toHaveBeenCalledWith(4242)
    expect(await run.done).toBe('failed')
  })

  it('kill() 을 두 번·시간 초과와 겹쳐 불러도 나무 끄기는 한 번', async () => {
    const { spawn, child } = fakeSpawn()
    const kill = vi.fn(() => new Promise<void>((r) => setTimeout(() => { child.emit('close', null); r() }, 30)))
    const run = updateClaude(C, { spawn, kill, timeoutMs: 5 })
    expect(await run.done).toBe('timeout')
    await Promise.all([run.kill(), run.kill()])
    expect(kill).toHaveBeenCalledTimes(1)
  })

  it('이미 끝났으면 kill() 은 끄지 않고 바로 풀린다', async () => {
    const { spawn, child } = fakeSpawn()
    const kill = vi.fn(async () => {})
    const run = updateClaude(C, { spawn, kill })
    child.emit('close', 0)
    expect(await run.done).toBe('ok')
    await run.kill()
    expect(kill).not.toHaveBeenCalled()
  })

  it('끄기가 던져도 kill() 은 거절하지 않는다', async () => {
    const { spawn, child } = fakeSpawn()
    const kill = vi.fn(async () => { throw new Error('taskkill 실패') })
    const run = updateClaude(C, { spawn, kill })
    await expect(run.kill()).resolves.toBeUndefined()
    child.emit('close', null)
    expect(await run.done).toBe('failed')
  })
})
