// 움직임 시험 도우미 — 화면 시험은 기본으로 '움직임 줄이기'(setup.ts 가 시험마다 채운다)라 지금 확인이 기다림 없이 맞는다.
// 움직임 경로를 시험할 때만 allowMotion() 으로 켜고, fastMotion() 으로 anime 시계를 앞당긴다.
// (anime 의 시계는 불러올 때 잡은 Date.now 라 vitest 가짜 시계로는 움직이지 않는다 — 실제 시간 + engine.speed 를 쓴다)
import { engine } from 'animejs'

const REDUCE = /prefers-reduced-motion:\s*reduce/

/** window.matchMedia 를 채운다 — reduce 면 '(prefers-reduced-motion: reduce)' 에 맞다고, 다른 질문은 늘 아니라고 답한다 */
export function stubMatchMedia(reduce: boolean): void {
  window.matchMedia = ((query: string) => ({
    matches: reduce && REDUCE.test(query),
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
}

/** 이 시험 동안 matchMedia 가 '줄이기 아님' — setup 의 beforeEach 가 다음 시험에서 기본값(줄이기)으로 되돌린다 */
export function allowMotion(): void {
  stubMatchMedia(false)
}

/** anime 엔진을 speed 배로 돌린다(기본 20) — 되돌리는 함수를 준다. setup 의 afterEach 도 1 로 되돌린다 */
export function fastMotion(speed = 20): () => void {
  const was = engine.speed
  engine.speed = speed
  return () => {
    engine.speed = was
  }
}
