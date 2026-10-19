import { useEffect, useRef, useState } from 'react'

/** 움직임 줄이기 설정 — 켜져 있으면 움직임 없이 바로 보여 준다 */
export function reducedMotion(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
}

/** 화면 이동 시간(ms) — 움직임 줄이기면 0 */
export const moveMs = (ms: number) => (reducedMotion() ? 0 : ms)

/**
 * 넘김 서명(이 화면의 하나뿐인 움직임) — 전달되는 순간 엣지를 따라 점이 보낸 쪽 → 받는 쪽으로 가고(PACKET_MS),
 * 닿으면 받는 자리에 고리가 퍼지고 받는 노드의 배지가 한 번 튄다(POP_MS).
 */
export const PACKET_MS = 400
export const POP_MS = 260
/** 빠르게 나가 부드럽게 멈추는 3차 ease-out — 넘김 점(HandoffEdge easeOut)과 같은 곡선 */
export const EASE_OUT = 'cubic-bezier(0.33, 1, 0.68, 1)'

/** 한 번 튀기 — 1.25배로 커졌다가 제자리로 */
const POP_FRAMES: Keyframe[] = [
  { transform: 'scale(1)', easing: EASE_OUT },
  { transform: 'scale(1.25)', offset: 0.4, easing: EASE_OUT },
  { transform: 'scale(1)' },
]

/** el 을 한 번 튀게 한다 — 넘김 점이 닿는 때(PACKET_MS 뒤)에. 움직임 줄이기면 하지 않는다. 멈추는 함수를 돌려준다 */
export function popOnce(el: HTMLElement | null): () => void {
  if (!el || reducedMotion() || typeof el.animate !== 'function') return () => {}
  const a = el.animate(POP_FRAMES, { duration: POP_MS, delay: PACKET_MS, iterations: 1 })
  return () => a.cancel()
}

/**
 * 전달 시각(at)이 바뀔 때마다 1씩 오르는 수 — 움직임을 한 번 틀 때 쓴다. 움직임 줄이기면 세지 않는다.
 * 처음 그릴 때 이미 있던 전달은 세지 않는다. 다만 replayMs 안에 일어난 것이면 센다(전달과 함께 새로 생긴 엣지).
 */
export function useShot(at: number | undefined, replayMs = 0): number {
  const [shot, setShot] = useState(0)
  const seen = useRef<{ at: number | undefined } | null>(null)
  useEffect(() => {
    const first = seen.current === null
    const was = seen.current?.at
    seen.current = { at }
    if (at === undefined || at === was) return
    if (first && (replayMs <= 0 || Date.now() - at > replayMs)) return
    if (reducedMotion()) return
    setShot(n => n + 1)
  }, [at, replayMs])
  return shot
}
