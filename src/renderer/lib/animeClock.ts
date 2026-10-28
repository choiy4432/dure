import { engine } from 'animejs'

/** 마지막 장면보다 이만큼 넘게 뒤로 가면 시계를 돌린 것 — 시간 동기화의 작은 보정은 그대로 둔다 */
const BACK_JUMP_MS = 1000

type Child = { resetTime(): unknown; _lastTickTime: number; _next: Child | null }
let installed = false

/**
 * anime.js 4 는 시각을 벽시계(Date.now)로 잰다. PC 시계를 뒤로 돌리면 엔진이 '다음 장면까지 아직'으로 보고 돌린 만큼(3일이면 3일)
 * 모든 움직임이 첫 장면에 멈춘다 — 들어오는 대화 줄·떠 있는 목록이 투명한 채 자리만 차지한다.
 * 그래서 시각이 마지막 장면보다 크게 뒤로 가면 엔진을 지금 시각에 다시 맞추고, 도는 움직임도 지금 자리에서 이어 가게 한다
 * (문서가 다시 보일 때 anime 가 하는 resetTime 과 같다). 앞으로 뛰는 것은 그대로 — 도는 움직임이 바로 끝날 뿐 멈추지 않는다.
 * 앱이 뜰 때 한 번 건다(두 번 불러도 한 번).
 */
export function followClockBack(): void {
  if (installed) return
  installed = true
  const requestTick = engine.requestTick
  engine.requestTick = function (time) {
    if (time < this._lastTickTime - BACK_JUMP_MS) {
      this._lastTickTime = time - this._frameDuration // 이번 장면을 거르지 않게
      this._lastTime = time
      for (let c = this._head as unknown as Child | null; c; c = c._next) {
        c.resetTime()
        c._lastTickTime = time
      }
    }
    return requestTick.call(this, time)
  }
}
