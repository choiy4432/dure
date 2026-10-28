// PC 시계를 뒤로 돌려도 anime 움직임이 멈추지 않는다 — anime 4 는 시각을 벽시계(Date.now)로 잰다.
// anime 는 불러올 때 잡은 Date.now 원본을 쓰므로 시험이 그 시계를 돌릴 수 없다. 대신 엔진이 기억하는 시각을 3일 앞으로 옮긴다 —
// 시계를 3일 뒤로 돌린 것과 엔진이 보는 모습이 같다(마지막 장면·도는 움직임의 시작이 모두 '지금'보다 3일 뒤).
import { beforeAll, expect, it } from 'vitest'
import { animate, engine } from 'animejs'
import { followClockBack } from '../../src/renderer/lib/animeClock'
import { fastMotion } from './motion'

const DAY = 24 * 60 * 60 * 1000
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

type Clocked = { _startTime: number; _lastTickTime: number; _next: Clocked | null }

/** 엔진이 기억하는 시각을 ms 만큼 앞으로 — 그만큼 시계를 뒤로 돌린 것 */
function turnClockBack(ms: number) {
  engine._lastTickTime += ms
  engine._lastTime += ms
  for (let c = engine._head as unknown as Clocked | null; c; c = c._next) {
    c._startTime += ms
    c._lastTickTime += ms
  }
}

/** 끝까지 갔나 — 넉넉히 1초까지 기다린다(빠르기 20배라 260ms 움직임은 십여 ms) */
async function settles(el: HTMLElement): Promise<string> {
  for (let i = 0; i < 50 && el.style.opacity !== '1'; i++) await sleep(20)
  return el.style.opacity
}

const box = () => document.body.appendChild(document.createElement('div'))

beforeAll(() => followClockBack())

it('쉬는 동안 시계를 3일 뒤로 — 그 뒤에 시작한 움직임이 첫 장면(투명)에 멈추지 않는다', async () => {
  fastMotion()
  const a = box()
  animate(a, { opacity: { from: 0, to: 1 }, duration: 260, ease: 'linear' })
  expect(await settles(a)).toBe('1')
  turnClockBack(3 * DAY)
  const b = box()
  animate(b, { opacity: { from: 0, to: 1 }, duration: 260, ease: 'linear' })
  expect(await settles(b)).toBe('1')
})

it('도는 중에 시계를 3일 뒤로 — 지금 자리에서 이어 끝까지 간다', async () => {
  fastMotion()
  const el = box()
  animate(el, { opacity: { from: 0, to: 1 }, duration: 2000, ease: 'linear' }) // 빠르기 20배로 100ms
  await sleep(30)
  turnClockBack(3 * DAY)
  expect(await settles(el)).toBe('1')
})
