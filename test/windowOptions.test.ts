import { describe, it, expect } from 'vitest'
import type { BrowserWindowConstructorOptions } from 'electron'
import { TRAFFIC_LIGHTS, windowOptions } from '../src/main/windowOptions'

/** index.ts 가 넘기는 꼴 그대로 — 제목 표시줄 대신 두레 위 띠, Windows 창 단추는 그 위에 겹친다 */
const base = (): BrowserWindowConstructorOptions => ({
  width: 1440,
  height: 900,
  minWidth: 1100,
  minHeight: 700,
  backgroundColor: '#FFFFFF',
  titleBarStyle: 'hidden',
  titleBarOverlay: { color: '#FFFFFF', symbolColor: '#475569', height: 47 },
  autoHideMenuBar: true,
  icon: 'resources/icon.ico',
  show: false,
  webPreferences: { preload: 'preload/index.cjs', contextIsolation: true, nodeIntegration: false, sandbox: true },
})

describe('windowOptions — 창 껍데기', () => {
  it('win32_는_base_그대로', () => {
    const b = base()
    const o = windowOptions('win32', b)
    expect(o).toBe(b) // 같은 객체 — 한 칸도 바꾸지 않는다
    expect(o).toEqual(base())
  })

  it('darwin_은_hiddenInset_과_신호등_자리', () => {
    const b = base()
    const o = windowOptions('darwin', b)
    expect(o.titleBarStyle).toBe('hiddenInset')
    expect(o.trafficLightPosition).toEqual({ x: 16, y: 16 })
    expect(TRAFFIC_LIGHTS).toEqual({ x: 16, y: 16 })
    // mac 엔 창 단추 겹침이 없다(신호등은 색·높이를 못 바꾼다) — 칸 자체를 뺀다
    expect('titleBarOverlay' in o).toBe(false)
    // 나머지는 그대로
    const { titleBarOverlay: _o, titleBarStyle: _s, ...rest } = base()
    const { trafficLightPosition: _t, titleBarStyle: _s2, ...got } = o
    expect(got).toEqual(rest)
    // 받은 것은 건드리지 않는다
    expect(b).toEqual(base())
  })
})
