/** 움직임 줄이기 설정 — 켜져 있으면 움직임 없이 바로 보여 준다 */
export function reducedMotion(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
}

/** 화면 이동 시간(ms) — 움직임 줄이기면 0 */
export const moveMs = (ms: number) => (reducedMotion() ? 0 : ms)
