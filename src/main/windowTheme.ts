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

export function windowColors(dark: boolean): { bg: string; symbol: string } {
  return dark ? WINDOW_COLORS.dark : WINDOW_COLORS.light
}
