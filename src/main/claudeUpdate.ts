import { spawn as nodeSpawn } from 'node:child_process'
import { killTree } from '../engine/killTree'
import type { ClaudeCommand } from './claudeCommand'

/** `claude update` 를 기다리는 상한 — 넘으면 끄고 그냥 켠다 (실측: 갱신 ~8초, 이미 최신 ~2.6초) */
export const CLAUDE_UPDATE_TIMEOUT_MS = 90_000

export type ClaudeUpdateResult = 'ok' | 'failed' | 'timeout'

export interface UpdateClaudeOptions {
  timeoutMs?: number
  spawn?: typeof nodeSpawn
  /** 프로세스 나무를 끄는 길(시간 초과·kill()) — 시험용으로 갈아끼운다 */
  kill?: (pid: number) => Promise<void>
}

export interface ClaudeUpdateRun {
  /** 끝난 결과 — 거절하지 않는다 */
  done: Promise<ClaudeUpdateResult>
  /** 도는 갱신을 나무째 끈다(두레를 끌 때) — 이미 끝났으면 바로 풀린다. 끄기가 던져도 삼킨다 */
  kill(): Promise<void>
}

/**
 * 켤 때 `claude update` 를 한 번 돌린다 — Windows 는 도는 claude.exe 를 바꿔 쓰지 못해서 어떤 claude 도 뜨기 전에.
 * 던지지 않는다: 실패·시간 초과도 값으로 돌려주고, 두레는 있는 claude 로 그냥 켠다.
 * Windows 에선 자식이 부모보다 오래 산다 — 두레를 끌 때 kill() 로 나무째 끈다(설치 흐름과 같은 꼴).
 */
export function updateClaude(c: ClaudeCommand, o: UpdateClaudeOptions = {}): ClaudeUpdateRun {
  const spawn = o.spawn ?? nodeSpawn
  const killPid = o.kill ?? killTree
  const timeoutMs = o.timeoutMs ?? CLAUDE_UPDATE_TIMEOUT_MS
  let child: ReturnType<typeof nodeSpawn>
  try {
    child = spawn(c.command, [...c.argsPrefix, 'update'], { windowsHide: true, stdio: 'ignore' })
  } catch {
    return { done: Promise.resolve('failed'), kill: () => Promise.resolve() }
  }
  let exited = false
  let killing: Promise<void> | null = null
  /** 한 번만 끈다 — 시간 초과와 kill() 이 겹쳐도 같은 끄기를 기다린다 */
  const stop = (): Promise<void> => {
    if (exited || !child.pid) return Promise.resolve()
    killing ??= killPid(child.pid).catch(() => {})
    return killing
  }
  const done = new Promise<ClaudeUpdateResult>((resolve) => {
    let settled = false
    const finish = (r: ClaudeUpdateResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(r)
    }
    // 끄는 게 끝나길 기다리지 않고 timeout 을 알린다
    const timer = setTimeout(() => {
      finish('timeout')
      void stop()
    }, timeoutMs)
    child.on('error', () => {
      exited = true
      finish('failed')
    })
    child.on('close', (code) => {
      exited = true
      finish(code === 0 ? 'ok' : 'failed')
    })
  })
  return { done, kill: stop }
}
