// 창 껍데기의 운영체제 갈래 — electron 없이 시험할 수 있게 따로 둔다(index.ts 가 쓴다. electron 은 타입만)
import type { BrowserWindowConstructorOptions } from 'electron'
import type { Platform } from '../engine/platform'

/** mac 신호등(닫기·최소화·확대) 자리 — 위 띠 48px 가운데쯤. 화면은 왼쪽을 80px 비운다(base.css [data-platform='darwin'] .top) */
export const TRAFFIC_LIGHTS = { x: 16, y: 16 } as const

/**
 * 창 만들기 옵션 — win32 는 받은 그대로(제목 표시줄 대신 두레 위 띠 + Windows 창 단추 겹침).
 * darwin 은 제목 표시줄을 숨기고 신호등을 위 띠 안으로(hiddenInset) — mac 엔 창 단추 겹침(titleBarOverlay)이 없어 그 칸은 뺀다
 */
export function windowOptions(p: Platform, base: BrowserWindowConstructorOptions): BrowserWindowConstructorOptions {
  if (p !== 'darwin') return base
  const { titleBarOverlay: _overlay, ...rest } = base
  return { ...rest, titleBarStyle: 'hiddenInset', trafficLightPosition: { ...TRAFFIC_LIGHTS } }
}
