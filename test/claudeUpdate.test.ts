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
    const p = updateClaude(C, { spawn })
    child.emit('close', 0)
    expect(await p).toBe('ok')
    expect(spawn).toHaveBeenCalledWith('claude', ['--x', 'update'], expect.objectContaining({ windowsHide: true }))
  })

  it('코드 1 → failed', async () => {
    const { spawn, child } = fakeSpawn()
    const p = updateClaude(C, { spawn })
    child.emit('close', 1)
    expect(await p).toBe('failed')
  })

  it('시간 초과 — 끄고 timeout', async () => {
    const { spawn, child } = fakeSpawn()
    const kill = vi.fn(async () => { child.emit('close', null) })
    expect(await updateClaude(C, { spawn, timeoutMs: 20, kill })).toBe('timeout')
    expect(kill).toHaveBeenCalledWith(4242)
  })

  it('spawn 오류 → failed', async () => {
    const { spawn, child } = fakeSpawn()
    const p = updateClaude(C, { spawn })
    child.emit('error', new Error('ENOENT'))
    expect(await p).toBe('failed')
  })

  it('spawn 이 던져도 던지지 않고 failed', async () => {
    const spawn = (() => { throw new Error('boom') }) as any
    expect(await updateClaude(C, { spawn })).toBe('failed')
  })
})
