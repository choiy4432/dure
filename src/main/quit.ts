/**
 * before-quit 이 오면 할 일
 * - proceed: 정리가 끝났다(성공이든 실패든) — 막지 않고 그대로 나간다(설치의 quitAndInstall → app.quit 도)
 * - exit: 막고, 정리가 끝나면 바로 끈다(보통 끄기)
 * - fallback: 업데이트 설치가 정리를 기다리는 중 — 막고, 정리 뒤 설치 흐름이 스스로 나가길 기다리되 잠시 뒤에도 안 나가면 끈다
 * - wait: 끄기가 이미 잡혀 있다 — 막기만
 */
export type QuitAction = 'proceed' | 'exit' | 'fallback' | 'wait'

export interface QuitState {
  /** 정리가 끝났다 — 실패도 끝난 것으로 친다(안 그러면 다음 끄기가 영영 막힌다) */
  settled: boolean
  /** 업데이트 설치가 정리를 기다리는 중 — 여기서 바로 끄면 설치가 사라진다 */
  installing: boolean
  /** 끄기(바로 또는 잠시 뒤)를 이미 걸었다 */
  exitScheduled: boolean
}

export function quitDecision(s: QuitState): QuitAction {
  if (s.settled) return 'proceed'
  if (s.exitScheduled) return 'wait'
  return s.installing ? 'fallback' : 'exit'
}

/**
 * 설치 정리 중 창을 닫았을 때, 정리가 끝난 뒤 설치 흐름이 스스로 나가길 기다리는 상한.
 * 설치 파일(NSIS)은 quitAndInstall 안에서 동기로 따로(detached) 띄워지니 늦게 끄더라도 설치를 죽이지 않는다.
 */
export const INSTALL_EXIT_FALLBACK_MS = 5000

export interface QuitControl {
  /** 정리(엔진 끄기 등) 한 번 — 여러 번 불러도 같은 약속. 실패하면 거부하지만 '끝남'은 그대로 친다 */
  shutdownOnce(): Promise<void>
  /** 정리를 시작했나 */
  started(): boolean
  /** app 'before-quit' */
  beforeQuit(event: { preventDefault(): void }): void
  /** 업데이트 설치 전 정리 — 실패하면 설치 표시를 거두고 던진다(설치하지 않는다) */
  prepareInstall(): Promise<void>
}

/** 끄는 길 — before-quit 과 업데이트 설치가 같은 정리 하나를 쓴다 */
export function createQuitControl(o: { shutdown: () => Promise<void>; exit: () => void; fallbackMs?: number }): QuitControl {
  const fallbackMs = o.fallbackMs ?? INSTALL_EXIT_FALLBACK_MS
  const s: QuitState = { settled: false, installing: false, exitScheduled: false }
  let done: Promise<void> | null = null
  const shutdownOnce = (): Promise<void> => {
    if (!done) {
      // 동기로 던져도 약속으로 받는다
      done = new Promise<void>((r) => r(o.shutdown())).finally(() => {
        s.settled = true
      })
      // 기다리는 쪽이 없어도 처리 안 된 거부로 남지 않게 — 기다리는 쪽은 그대로 거부를 받는다
      done.catch(() => {})
    }
    return done
  }
  return {
    shutdownOnce,
    started: () => done !== null,
    beforeQuit(event) {
      const action = quitDecision(s)
      if (action === 'proceed') return
      event.preventDefault()
      if (action === 'wait') return
      s.exitScheduled = true
      const settled = shutdownOnce().then(
        () => {},
        () => {},
      )
      if (action === 'exit') void settled.then(() => o.exit())
      // 설치가 성공하면 quitAndInstall 의 app.quit 이 훨씬 먼저 나간다 — 이건 설치가 안 나갔을 때만 닿는다
      else void settled.then(() => setTimeout(() => o.exit(), fallbackMs))
    },
    async prepareInstall() {
      s.installing = true
      try {
        await shutdownOnce()
      } catch (e) {
        s.installing = false
        throw e
      }
    },
  }
}
