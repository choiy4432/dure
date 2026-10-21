// 화면 테스트 준비 — jsdom 에 없는 브라우저 기능을 빈 것으로 채운다(React Flow 가 처음 그릴 때 쓴다)
import { afterEach, beforeEach } from 'vitest'
import { engine } from 'animejs'
import { stubMatchMedia } from './motion'

if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
}

// jsdom 엔 배치가 없어 getClientRects 가 늘 빈 목록이다 — 문서에 붙은 요소는 그려진 것으로 친다(Clamp 는 그려지지 않은 상자를 재지 않는다).
// 숨은 상자 시험은 스스로 빈 목록으로 갈아 끼운다(clamp.test)
Element.prototype.getClientRects = function (this: Element) {
  const rect = { x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 }
  return (this.isConnected ? [rect] : []) as unknown as DOMRectList
}

// 시험마다 matchMedia 기본값 — '움직임 줄이기'에만 맞다고 답한다(jsdom 엔 matchMedia 가 없다).
// 그래서 화면 시험은 기본으로 움직이지 않고, 스스로 matchMedia 를 지우거나 갈아 끼운 시험 뒤에도 다음 시험은 이 값으로 시작한다.
// 움직임 시험은 motion.ts 의 allowMotion() 으로 켠다.
beforeEach(() => {
  stubMatchMedia(true)
})

// fastMotion() 을 되돌리지 않고 끝난 시험이 있어도 다음 시험의 anime 는 제 빠르기로 돈다
afterEach(() => {
  engine.speed = 1
})
