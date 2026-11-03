/** 끄는 중 before-quit 이 또 오면 어떻게 할지 — 정리(shutdown)가 끝난 뒤에만 그냥 나간다 */
export type QuitDecision = 'proceed' | 'start' | 'defer'

export function quitDecision(s: { shutdownStarted: boolean; shutdownDone: boolean }): QuitDecision {
  if (s.shutdownDone) return 'proceed'
  return s.shutdownStarted ? 'defer' : 'start'
}
