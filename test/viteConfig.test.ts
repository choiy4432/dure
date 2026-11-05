import { describe, it, expect } from 'vitest'
import config from '../electron.vite.config'

// 화면 묶음 — 휴대폰은 Tailscale 망으로 받는다. 줄이지 않으면 공유 묶음이 2MB 를 넘는다
describe('electron.vite.config — 화면(renderer) 빌드', () => {
  it('줄인다(minify) — PC 창 · 휴대폰 묶음 모두', () => {
    const c = config as { renderer?: { build?: { minify?: unknown } } }
    expect(c.renderer?.build?.minify).toBe(true)
  })
})
