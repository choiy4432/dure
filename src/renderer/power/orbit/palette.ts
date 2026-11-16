// 관계도 캔버스 색 — 캔버스는 CSS 변수를 바로 못 써서 이 한 곳에 모은다(시안 orbit3 값).
// 에이전트 색은 PowerAgent.color 에서 온다. 'r,g,b' 꼴은 알파를 붙여 쓰는 색.

export const RGB = {
  /** 잔상 지우기(destination-out — 알파만 쓴다) */
  erase: '0,0,0',
  star: '203,213,225',
  floor: '59,130,246',
  pulse: '96,165,250',
  disc: '191,219,254',
  tick: '147,197,253',
  tickRing: '96,165,250',
  glow: '96,165,250',
  glowEdge: '59,130,246',
  flare: '191,219,254',
  pillar: '96,165,250',
  helixA: '191,219,254',
  helixB: '103,232,249',
  gyro: '147,197,253',
  label: '203,213,225',
  wave: '96,165,250',
  scan: '96,165,250',
} as const

/** 은하 네 빛깔 — 안쪽부터 */
export const GALAXY_RGB = ['219,234,254', '147,197,253', '196,181,253', '103,232,249'] as const

export const WHITE = '#FFFFFF'
/** 에이전트 색을 모를 때 */
export const FALLBACK_AGENT = '#60A5FA'
export const SHARD_CORE = 'rgba(255,255,255,0.8)'
export const BUBBLE_BG = 'rgba(24,34,53,0.96)'
export const BUBBLE_TEXT = '#E5E9F0'
export const HUD_FRAME = 'rgba(147,197,253,0.45)'
export const HUD_KEY = '#8392A8'
export const HUD_VALUE = '#E5E9F0'
export const TOAST_BG = 'rgba(37,99,235,0.28)'
export const TOAST_LINE = 'rgba(96,165,250,0.85)'
export const TOAST_TEXT = '#DBEAFE'

/** 글꼴 — 덮개의 --mono · --font 를 읽지 못할 때 */
export const FALLBACK_FONTS = {
  mono: "'JetBrains Mono', 'Cascadia Mono', Consolas, monospace",
  ui: "'Noto Sans KR', 'Malgun Gothic', sans-serif",
}

const rgbCache = new Map<string, string>()
/** '#RRGGBB' → 'r,g,b' (한 번 구하면 기억) */
export function rgbOf(hex: string): string {
  let v = rgbCache.get(hex)
  if (v === undefined) {
    const n = parseInt(hex.replace('#', '').slice(0, 6), 16) || 0
    v = `${n >> 16},${(n >> 8) & 255},${n & 255}`
    rgbCache.set(hex, v)
  }
  return v
}

const STEPS = 100
const shadeCache = new Map<string, string[]>()
/** 'r,g,b' + 알파 → 'rgba(...)'. 알파를 0.01 단위로 묶어 문자열을 다시 만들지 않는다(점 수천 개 고리용) */
export function shade(rgb: string, a: number): string {
  let row = shadeCache.get(rgb)
  if (row === undefined) {
    row = Array.from({ length: STEPS + 1 }, (_, i) => `rgba(${rgb},${i / STEPS})`)
    shadeCache.set(rgb, row)
  }
  return row[a <= 0 ? 0 : a >= 1 ? STEPS : Math.round(a * STEPS)]
}

/** '#RRGGBB' + 알파 */
export const hexA = (hex: string, a: number): string => shade(rgbOf(hex), a)
