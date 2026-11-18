import { describe, it, expect, vi } from 'vitest'
import { paintWindow, TITLE_BAR_HEIGHT, veiledColor, windowColors } from '../src/main/windowTheme'

describe('paintWindow — 테마가 바뀌면 창 바탕·창 단추를 다시 칠한다', () => {
  const fakeWin = () => ({ setBackgroundColor: vi.fn(), setTitleBarOverlay: vi.fn() })

  it('win32 — 바탕 + 창 단추 겹침(지금과 같은 값) · 투어 막이면 막 색', () => {
    for (const dark of [false, true]) {
      const w = fakeWin()
      paintWindow(w, { dark, veiled: false, platform: 'win32' })
      expect(w.setBackgroundColor).toHaveBeenCalledWith(windowColors(dark).bg)
      expect(w.setTitleBarOverlay).toHaveBeenCalledWith({ color: windowColors(dark).bg, symbolColor: windowColors(dark).symbol, height: TITLE_BAR_HEIGHT })
      const v = fakeWin()
      paintWindow(v, { dark, veiled: true, platform: 'win32' })
      expect(v.setTitleBarOverlay).toHaveBeenCalledWith({ color: veiledColor(dark), symbolColor: windowColors(dark).symbol, height: TITLE_BAR_HEIGHT })
    }
  })

  it('darwin_에선_setTitleBarOverlay_를_안_부른다 — mac 창엔 겹침이 없다(Windows·Linux 전용 API) · 바탕은 칠한다', () => {
    for (const veiled of [false, true]) {
      const w = fakeWin()
      paintWindow(w, { dark: true, veiled, platform: 'darwin' })
      expect(w.setBackgroundColor).toHaveBeenCalledWith(windowColors(true).bg)
      expect(w.setTitleBarOverlay).not.toHaveBeenCalled()
    }
    // mac 창에 그 함수가 아예 없어도 던지지 않는다(nativeTheme 'updated' 안 — 던지면 오류 상자)
    expect(() => paintWindow({ setBackgroundColor: vi.fn() }, { dark: false, veiled: false, platform: 'darwin' })).not.toThrow()
  })
})

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
