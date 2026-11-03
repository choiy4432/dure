import { spawn as nodeSpawn } from 'node:child_process'
import { killTree } from '../engine/killTree'
import type { ClaudeCommand } from './claudeCommand'

/** `claude update` 를 기다리는 상한 — 넘으면 끄고 그냥 켠다 (실측: 갱신 ~8초, 이미 최신 ~2.6초) */
export const CLAUDE_UPDATE_TIMEOUT_MS = 90_000

export interface UpdateClaudeOptions {
  timeoutMs?: number
  spawn?: typeof nodeSpawn
  /** 시간 초과 때 프로세스 나무를 끄는 길 — 시험용으로 갈아끼운다 */
  kill?: (pid: number) => Promise<void>
}

/**
 * 켤 때 `claude update` 를 한 번 돌린다 — Windows 는 도는 claude.exe 를 바꿔 쓰지 못해서 어떤 claude 도 뜨기 전에.
 * 던지지 않는다: 실패·시간 초과도 값으로 돌려주고, 두레는 있는 claude 로 그냥 켠다.
 */
export function updateClaude(c: ClaudeCommand, o: UpdateClaudeOptions = {}): Promise<'ok' | 'failed' | 'timeout'> {
  const spawn = o.spawn ?? nodeSpawn
  const kill = o.kill ?? killTree
  const timeoutMs = o.timeoutMs ?? CLAUDE_UPDATE_TIMEOUT_MS
  return new Promise((resolve) => {
    let child: ReturnType<typeof nodeSpawn>
    try {
      child = spawn(c.command, [...c.argsPrefix, 'update'], { windowsHide: true, stdio: 'ignore' })
    } catch {
      resolve('failed')
      return
    }
    let settled = false
    const finish = (r: 'ok' | 'failed' | 'timeout'): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(r)
    }
    const timer = setTimeout(() => {
      // 끄는 게 끝나길 기다리지 않고 timeout 을 알린다 — 끄기가 던져도 삼킨다
      finish('timeout')
      if (child.pid) void kill(child.pid).catch(() => {})
    }, timeoutMs)
    child.on('error', () => finish('failed'))
    child.on('close', (code) => finish(code === 0 ? 'ok' : 'failed'))
  })
}
