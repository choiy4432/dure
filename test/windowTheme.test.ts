import { describe, it, expect } from 'vitest'
import { veiledColor, windowColors } from '../src/main/windowTheme'

describe('veiledColor — 창 바탕 위에 투어 막', () => {
  it('라이트: #FFFFFF 에 rgba(15,23,42,.2)', () => {
    expect(veiledColor(false)).toBe('#CFD1D4')
  })
  it('다크: #111827 에 rgba(2,6,23,.4)', () => {
    expect(veiledColor(true)).toBe('#0B1121')
  })
  it('바탕과 다른 단색 #RRGGBB', () => {
    for (const d of [false, true]) {
      expect(veiledColor(d)).toMatch(/^#[0-9A-F]{6}$/)
      expect(veiledColor(d)).not.toBe(windowColors(d).bg)
    }
  })
})
