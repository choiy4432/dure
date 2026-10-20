import { useEffect, useRef, useState } from 'react'

/** 움직임 줄이기 설정 — 켜져 있으면 움직임 없이 바로 보여 준다 */
export function reducedMotion(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
}

/** 화면 이동 시간(ms) — 움직임 줄이기면 0 */
export const moveMs = (ms: number) => (reducedMotion() ? 0 : ms)

// ── 기능 움직임(anime.js) 값 — 바뀌는 것을 설명하는 움직임만. 시간·거리·크기·곡선은 여기에만 둔다(컴포넌트에 숫자를 흩뿌리지 않는다).
// 들어올 때는 outQuint(빨리 출발해 길게 멈춘다), 나갈 때는 outCubic(넘김 서명과 같은 곡선). 튕김은 없다.

/** anime.js 4 곡선 이름 — outQuint ≈ cubic-bezier(0.22, 1, 0.36, 1) · outCubic ≈ cubic-bezier(0.33, 1, 0.68, 1) */
export type MotionEase = 'outQuint' | 'outCubic' | 'linear'
/** enter 는 시작 값(→ opacity 1 · y 0 · scale 1 로), exit 는 끝 값 */
export interface MotionStep {
  ms: number
  ease: MotionEase
  opacity?: number
  y?: number
  scale?: number
}
export interface MotionSpec {
  enter: MotionStep
  exit: MotionStep | null
}

export const MOTION: Record<'pop' | 'popUp' | 'backdrop' | 'dialog' | 'line' | 'node', MotionSpec> = {
  /** 떠 있는 목록 .pop · 관계도 엣지 메시지 창 .pm — 아래로 펼침(기준점 = 여는 버튼·누른 자리 쪽 위 모서리) */
  pop: {
    enter: { ms: 220, ease: 'outQuint', opacity: 0, y: 8, scale: 0.96 },
    exit: { ms: 150, ease: 'outCubic', opacity: 0, y: -4, scale: 0.96 },
  },
  /** 위로 펼치는 목록(입력창 위 / 명령 목록) — pop 의 세로만 뒤집는다(기준점 = 아래 모서리) */
  popUp: {
    enter: { ms: 220, ease: 'outQuint', opacity: 0, y: -8, scale: 0.96 },
    exit: { ms: 150, ease: 'outCubic', opacity: 0, y: 4, scale: 0.96 },
  },
  /** 대화상자 뒤 막 */
  backdrop: {
    enter: { ms: 260, ease: 'linear', opacity: 0 },
    exit: { ms: 170, ease: 'linear', opacity: 0 },
  },
  /** 대화상자 */
  dialog: {
    enter: { ms: 260, ease: 'outQuint', opacity: 0, y: 14, scale: 0.97 },
    exit: { ms: 170, ease: 'outCubic', opacity: 0, y: -7, scale: 0.97 },
  },
  /** 새 대화 줄 · '작업 중…' 줄 · 위에 붙는 카드 */
  line: {
    enter: { ms: 260, ease: 'outQuint', opacity: 0, y: 12, scale: 0.98 },
    exit: { ms: 150, ease: 'outCubic', opacity: 0, y: -6, scale: 0.98 },
  },
  /** 관계도 카드 생김 — 지울 때는 확인 창이 닫히는 움직임으로 충분해 나가는 움직임이 없다 */
  node: {
    enter: { ms: 280, ease: 'outQuint', opacity: 0, y: 8, scale: 0.94 },
    exit: null,
  },
}

/** 높이·위치·채움 움직임 시간(ms) — 접기·펼치기 · effort 손잡이 · 칩 막대(색 · 칸 사이 차례 · 새로 켜지는 막대) · 사용량 막대 · context 링 */
export const MOTION_MS = { expand: 260, knob: 220, bar: 200, barStagger: 35, barGrow: 260, meter: 700, ring: 800 } as const
/** effort 칩에서 새로 켜지는 막대의 세로 시작 크기(아래 끝 기준 → 1) */
export const BAR_GROW_FROM = 0.45

/**
 * 넘김 서명 — 이 화면의 가장 큰 움직임(나머지는 위의 기능 움직임). 전달되는 순간 엣지를 따라 점이 보낸 쪽 → 받는 쪽으로 가고(PACKET_MS),
 * 닿으면 받는 자리에 고리가 퍼진다. 받는 노드의 배지는 메시지가 도착해 개수가 오르는 순간 한 번 튄다(POP_MS).
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

/** el 을 한 번 튀게 한다 — 움직임 줄이기면 하지 않는다. 멈추는 함수를 돌려준다 */
export function popOnce(el: HTMLElement | null): () => void {
  if (!el || reducedMotion() || typeof el.animate !== 'function') return () => {}
  const a = el.animate(POP_FRAMES, { duration: POP_MS, iterations: 1 })
  return () => a.cancel()
}

/** count 가 오를 때마다 1씩 오르는 수 — 처음 그릴 때의 개수·줄어듦·움직임 줄이기는 세지 않는다 */
export function useRise(count: number): number {
  const [rise, setRise] = useState(0)
  const prev = useRef<number | null>(null)
  useEffect(() => {
    const was = prev.current
    prev.current = count
    if (was === null || count <= was || reducedMotion()) return
    setRise(n => n + 1)
  }, [count])
  return rise
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
