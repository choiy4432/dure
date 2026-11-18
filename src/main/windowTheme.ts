import type { Platform } from '../engine/platform'

/**
 * 창 바탕·창 단추(최소화·최대화·닫기) 색 — tokens.css 의 --bg·--text-3 거울(test/themeTokens 가 같은지 본다).
 * 렌더러가 뜨기 전 첫 칠과 제목 표시줄 겹침(titleBarOverlay)에 쓴다 — 화면 안은 토큰이 칠한다.
 */
export const WINDOW_COLORS = {
  light: { bg: '#FFFFFF', symbol: '#475569' },
  dark: { bg: '#111827', symbol: '#A3B1C6' },
} as const

/** 창 단추 높이 — 위 띠 48px 에서 아래 선 1px 을 뺀 값(단추 자리가 위 띠 아래 선을 가리지 않게) */
export const TITLE_BAR_HEIGHT = 47

/** 투어 막(--tour-veil, tokens.css 거울) — 창 단추는 Windows 가 웹 화면 위에 그려 막이 못 덮으니 같은 색으로 물들인다 */
export const TOUR_VEIL = {
  light: { rgb: [15, 23, 42], a: 0.2 },
  dark: { rgb: [2, 6, 23], a: 0.4 },
} as const

function hex(h: string): number[] {
  return [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16))
}

/** 창 바탕 위에 투어 막을 얹은 단색(#RRGGBB) — 창 단추 띠의 색 */
export function veiledColor(dark: boolean): string {
  const v = dark ? TOUR_VEIL.dark : TOUR_VEIL.light
  const bg = hex(windowColors(dark).bg)
  return '#' + bg.map((b, i) => Math.round(b * (1 - v.a) + v.rgb[i] * v.a).toString(16).padStart(2, '0')).join('').toUpperCase()
}

export function windowColors(dark: boolean): { bg: string; symbol: string } {
  return dark ? WINDOW_COLORS.dark : WINDOW_COLORS.light
}

/** 칠할 창 — BrowserWindow 에서 쓰는 것만. mac 창엔 setTitleBarOverlay 가 없을 수 있다 */
export interface PaintTarget {
  setBackgroundColor(color: string): void
  setTitleBarOverlay?(o: { color: string; symbolColor: string; height: number }): void
}

/**
 * 창 바탕·창 단추를 지금 테마로 — 테마를 바꾸거나 OS 가 바꾸면 다시 칠한다(nativeTheme 'updated' · 투어 막).
 * 창 단추 겹침은 그 창에 겹침이 있을 때만(darwin 이 아닐 때 — windowOptions). mac 의 신호등은 색을 못 바꾸고, setTitleBarOverlay 는
 * Windows·Linux 전용이라 mac 에서 부르면 'updated' 처리기 안에서 던져 오류 상자가 뜰 수 있다
 */
export function paintWindow(win: PaintTarget, o: { dark: boolean; veiled: boolean; platform: Platform }): void {
  const c = windowColors(o.dark)
  win.setBackgroundColor(c.bg)
  if (o.platform === 'darwin') return
  // 투어 막이 떠 있으면 창 단추 띠도 막 색으로(Windows 가 웹 화면 위에 그려 막이 못 덮는다)
  win.setTitleBarOverlay?.({ color: o.veiled ? veiledColor(o.dark) : c.bg, symbolColor: c.symbol, height: TITLE_BAR_HEIGHT })
}
