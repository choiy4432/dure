import { describe, expect, it } from 'vitest'
import { CAM_D, near, project, type Cam } from '../src/renderer/power/orbit/camera'

// 관계도 카메라 — 3D 점을 화면으로(시안 orbit3.proj)

const cam = (over: Partial<Cam> = {}): Cam => ({ yaw: 0, e: 0.56, D: CAM_D, zoom: 1, cx: 374, cy: 304, ...over })

describe('관계도 카메라', () => {
  it('원점은_화면_가운데', () => {
    const p = project(cam(), 0, 0, 0)
    expect(p.x).toBeCloseTo(374)
    expect(p.y).toBeCloseTo(304)
    expect(p.f).toBeCloseTo(1)
  })

  it('먼_점이_더_작다', () => {
    const far = project(cam(), 0, 0, 300)
    const close = project(cam(), 0, 0, -300)
    expect(far.d).toBeGreaterThan(close.d)
    expect(far.f).toBeLessThan(close.f)
    expect(near(far, 300)).toBeLessThan(near(close, 300))
  })

  it('yaw_를_π_돌리면_x_가_뒤집힌다', () => {
    const a = project(cam({ yaw: 0 }), 120, 0, 0)
    const b = project(cam({ yaw: Math.PI }), 120, 0, 0)
    expect(a.x - 374).toBeCloseTo(-(b.x - 374))
    expect(a.x).toBeGreaterThan(374)
  })

  it('zoom_은_가운데에서_멀어지는_만큼을_늘린다', () => {
    const a = project(cam({ zoom: 1 }), 100, 0, 0)
    const b = project(cam({ zoom: 1.5 }), 100, 0, 0)
    expect(b.x - 374).toBeCloseTo((a.x - 374) * 1.5)
  })
})
