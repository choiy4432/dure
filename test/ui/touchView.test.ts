import { describe, it, expect, beforeEach } from 'vitest'
import { firstView, forgetViews, rememberView, rememberedView, revealCard } from '../../src/renderer/map/touchView'

// 휴대폰 판의 자리 기억 — 방마다 마지막 화면(움직임이 끝날 때 적는다), 다시 그릴 때 그 화면으로. 없으면 맞춤.
// 대화에서 돌아왔으면 그 카드가 화면 안에 들게(안 보이는 쪽만 가운데로)
const area = { width: 390, height: 700 }
const pad = { x: 16, top: 20, bottom: 80 }
const card = (x: number, y: number) => ({ x, y, width: 168, height: 90 })

beforeEach(() => forgetViews())

describe('touchView — 방마다 기억', () => {
  it('적은 화면을 방마다 돌려준다 · 없으면 null', () => {
    expect(rememberedView('r1')).toBeNull()
    rememberView('r1', { x: -120, y: 30, zoom: 0.8 })
    rememberView('r2', { x: 5, y: 6, zoom: 1 })
    rememberView('r1', { x: -200, y: 40, zoom: 1.2 })
    expect(rememberedView('r1')).toEqual({ x: -200, y: 40, zoom: 1.2 })
    expect(rememberedView('r2')).toEqual({ x: 5, y: 6, zoom: 1 })
    // 숫자가 아닌 값은 적지 않는다(재기 전의 화면 등)
    rememberView('r2', { x: Number.NaN, y: 0, zoom: 1 })
    expect(rememberedView('r2')).toEqual({ x: 5, y: 6, zoom: 1 })
  })
})

describe('touchView — 처음 화면', () => {
  const fit = { x: 0, y: 20, zoom: 1 }

  it('기억한 화면이 있으면 그것(맞춤이 아니라) · 없으면 맞춤', () => {
    expect(firstView({ saved: { x: -300, y: -50, zoom: 1 }, fit, card: null, area, pad })).toEqual({ x: -300, y: -50, zoom: 1 })
    expect(firstView({ saved: null, fit, card: null, area, pad })).toEqual(fit)
    expect(firstView({ saved: null, fit: null, card: null, area, pad })).toBeNull()
  })

  it('돌아온 카드가 이미 보이면 그대로', () => {
    expect(firstView({ saved: null, fit, card: card(32, 32), area, pad })).toEqual(fit)
    const saved = { x: -300, y: -50, zoom: 1 }
    expect(firstView({ saved, fit, card: card(400, 200), area, pad })).toEqual(saved)
  })

  it('돌아온 카드가 화면 밖이면 그 카드가 가운데 오게 — 밖인 쪽(가로·세로)만 옮긴다', () => {
    // 셋째 열(가로 밖) — 가로만 가운데로, 세로는 그대로
    const r = firstView({ saved: null, fit, card: card(572, 32), area, pad })!
    expect(r.zoom).toBe(1)
    expect(r.y).toBe(fit.y)
    expect(572 + r.x + 168 / 2).toBeCloseTo(area.width / 2)
    // 아래 줄(세로 밖) — 세로만, 보이는 칸(위 여백 · 아래 맞춤 단추 자리 뺀 곳)의 가운데로
    const d = firstView({ saved: null, fit, card: card(32, 1400), area, pad })!
    expect(d.x).toBe(fit.x)
    expect(1400 + d.y + 90 / 2).toBeCloseTo(pad.top + (area.height - pad.top - pad.bottom) / 2)
    // 배율이 있으면 배율대로
    const z = revealCard({ x: 0, y: 0, zoom: 0.5 }, card(1200, 0), area, pad)
    expect(1200 * 0.5 + z.x + (168 * 0.5) / 2).toBeCloseTo(area.width / 2)
  })
})
