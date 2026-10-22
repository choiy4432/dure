import { describe, it, expect } from 'vitest'
import { offscreen, type OffTarget, type View } from '../../src/renderer/map/offscreen'

// 줌 1·이동 0 인 800x600 화면 — 화면 좌표 = 카드 좌표
const view: View = { x: 0, y: 0, zoom: 1, width: 800, height: 600 }
const card = (id: string, x: number, y: number, ask = false): OffTarget => ({ id, x, y, w: 100, h: 50, ask })

describe('offscreen', () => {
  it('화면 안이면 null', () => {
    expect(offscreen([card('a', 10, 10), card('b', 700, 500)], view)).toBeNull()
    expect(offscreen([], view)).toBeNull()
  })

  it('오른쪽 밖 둘·위 밖 하나 → right, count 3, first 는 가까운 쪽', () => {
    const r = offscreen([card('far', 1500, 100), card('near', 900, 100), card('up', 300, -300)], view)
    expect(r).toEqual({ side: 'right', count: 3, first: 'near', ask: false })
  })

  it('ask 가 하나라도 있으면 ask', () => {
    const r = offscreen([card('a', 900, 100), card('b', 1000, 100, true)], view)
    expect(r?.ask).toBe(true)
  })

  it('같은 수면 right → bottom → left → top', () => {
    const r = card('r', 900, 100)
    const b = card('b', 300, 700)
    const l = card('l', -300, 100)
    const t = card('t', 300, -300)
    expect(offscreen([t, l, b, r], view)?.side).toBe('right')
    expect(offscreen([t, l, b], view)?.side).toBe('bottom')
    expect(offscreen([t, l], view)?.side).toBe('left')
    expect(offscreen([t], view)?.side).toBe('top')
  })

  it('조금이라도 걸쳐 보이면 밖이 아니다', () => {
    expect(offscreen([card('a', 799, 100)], view)).toBeNull()
    expect(offscreen([card('a', -99, 100)], view)).toBeNull()
    expect(offscreen([card('a', 100, 599)], view)).toBeNull()
    // 딱 닿기만 하면 보이는 면적이 없으니 밖
    expect(offscreen([card('a', 800, 100)], view)?.side).toBe('right')
  })

  it('이동·줌을 화면 좌표로 바꿔 판단한다', () => {
    // 줌 0.5, 이동 (-100, 0): 카드 x 1000 → 화면 400(안), x 2000 → 900(밖)
    const v: View = { x: -100, y: 0, zoom: 0.5, width: 800, height: 600 }
    expect(offscreen([card('in', 1000, 100)], v)).toBeNull()
    expect(offscreen([card('out', 2000, 100)], v)?.side).toBe('right')
  })

  it('가로로 더 멀면 left/right, 아니면 top/bottom', () => {
    // 가운데 (400,300) 에서 카드 가운데 (-150+50, 700+25) → dx 450·dy 425 → left
    expect(offscreen([card('a', -150, 700)], view)?.side).toBe('left')
    expect(offscreen([card('a', -50, 800)], view)?.side).toBe('bottom')
  })
})
