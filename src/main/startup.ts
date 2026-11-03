import type { ClaudeUpdateState } from '../shared/appTypes'

export interface StartupDeps {
  /** 준비 확인(claude auth status·--version) — 갱신과 claude 가 둘 겹치지 않게 먼저 끝낸다 */
  check(): Promise<void>
  /** 켤 때 claude 최신으로를 할까 — 설정이 켜져 있고 엔진(claude)이 있을 때 */
  autoUpdate: boolean
  /** `claude update` — 던지지 않는 게 보통이지만 던져도 넘어간다 */
  update(): Promise<unknown>
  /** 엔진 시작 — 정확히 한 번 */
  start(): void
  /** 'claude-update' 앱 사건(지금 상태도 함께 바꾼다) */
  emit(s: ClaudeUpdateState): void
  /** engineReady 풀기 — 기다리던 엔진 메서드가 이 뒤에 엔진에 닿는다 */
  ready(): void
  log?(...args: unknown[]): void
}

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/**
 * 창을 띄운 뒤의 시작 — 확인 → (켜져 있으면) claude 최신으로 → 엔진 시작 → engineReady.
 * 차례대로: Windows 는 도는 claude.exe 를 바꿔 쓰지 못해서 갱신은 다른 claude 가 없을 때, 엔진(세션 claude)은 갱신 뒤에.
 * 무엇이 던져도 엔진은 한 번 시작하고 engineReady 를 푼다. 거절하지 않는다.
 */
export async function runStartup(d: StartupDeps): Promise<void> {
  const log = d.log ?? console.error
  try {
    try {
      await d.check()
    } catch (e) {
      log('[두레] 준비 확인 실패:', messageOf(e)) // 확인이 안 돼도 갱신·시작은 한다
    }
    if (d.autoUpdate) {
      d.emit('running')
      try {
        await d.update()
      } catch (e) {
        log('[두레] claude 최신으로 실패:', messageOf(e))
      } finally {
        d.emit('done')
      }
    }
  } catch (e) {
    log('[두레] 시작 준비 실패:', messageOf(e))
  } finally {
    try {
      d.start()
    } catch (e) {
      log('[두레] 엔진 시작 실패:', messageOf(e))
    } finally {
      d.ready()
    }
  }
}
