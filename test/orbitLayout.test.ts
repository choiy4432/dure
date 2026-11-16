import { describe, expect, it } from 'vitest'
import { CAM_D, CENTER_DROP, SHAKE_PX, TILT, ZOOM, project, type Cam } from '../src/renderer/power/orbit/camera'
import { CORE_Y, layoutOrbits, orbitRA, worldOf } from '../src/renderer/power/orbit/layout'

// 에이전트 수 → 궤도. 카드가 관계도 칸(시안 748×580) 밖으로 나가지 않는다

const ids = (n: number) => Array.from({ length: n }, (_, i) => `a${i}`)
const TAU = Math.PI * 2

describe('궤도 배치', () => {
  it('한_명이면_궤도_없음', () => {
    expect(layoutOrbits(['a'])).toEqual({ core: 'a', orbits: [] })
  })

  it('다섯이면_넷이_90도씩', () => {
    const { core, orbits } = layoutOrbits(ids(5))
    expect(core).toBe('a0')
    expect(orbits.map(o => o.id)).toEqual(['a1', 'a2', 'a3', 'a4'])
    for (let i = 1; i < 4; i++) expect(orbits[i].a - orbits[i - 1].a).toBeCloseTo(Math.PI / 2)
    // 시안 그대로 — 반지름 1 / 0.93 번갈아, 기울기 ±0.14~0.2 로 부호가 번갈아
    expect(orbits.map(o => o.r)).toEqual([1, 0.93, 1, 0.93])
    for (const [i, o] of orbits.entries()) {
      expect(Math.abs(o.inc)).toBeGreaterThanOrEqual(0.14)
      expect(Math.abs(o.inc)).toBeLessThanOrEqual(0.2)
      expect(Math.sign(o.inc)).toBe(i % 2 ? -1 : 1)
    }
  })

  it('여덟_명까지는_한_줄_고르게', () => {
    const { orbits } = layoutOrbits(ids(9))
    expect(orbits).toHaveLength(8)
    expect(new Set(orbits.map(o => o.r))).toEqual(new Set([1, 0.93]))
    for (let i = 1; i < 8; i++) expect(orbits[i].a - orbits[i - 1].a).toBeCloseTo(TAU / 8)
  })

  it('12명이면_두_줄', () => {
    const { orbits } = layoutOrbits(ids(12))
    expect(orbits).toHaveLength(11)
    expect(new Set(orbits.map(o => o.r))).toEqual(new Set([1, 0.72]))
    // 번갈아 — 옆 자리는 다른 줄이라 각도가 엇갈린다
    for (let i = 1; i < 11; i++) expect(orbits[i].r).not.toBe(orbits[i - 1].r)
  })

  it('worldOf_는_궤도_각도에서_시작해_turn_만큼_돈다', () => {
    const o = { id: 'x', a: 0, r: 1, inc: 0.2, node: 0 }
    const [x, y, z] = worldOf(o, 200, 0)
    expect(x).toBeCloseTo(200)
    expect(y).toBeCloseTo(0)
    expect(z).toBeCloseTo(0)
    const q = worldOf(o, 200, Math.PI / 2)
    expect(q[0]).toBeCloseTo(0)
    expect(q[2]).toBeCloseTo(200)
    expect(q[1]).toBeCloseTo(200 * Math.sin(0.2)) // 기울기만큼 뜬다
  })

  it('모든_인원에서_카드가_관계도_칸_안에_있다', () => {
    const W = 748
    const H = 580
    const RA = orbitRA(W, H)
    const HALF = { w: 95, h: 32 }
    const tilts = [TILT.base - TILT.swing - TILT.syncDip, TILT.base + TILT.swing]
    const zoom = 1 + ZOOM.swing + ZOOM.sync
    const bad: string[] = []
    const check = (label: string, c: Cam, x: number, y: number, z: number) => {
      const p = project(c, x, y, z)
      if (p.x - HALF.w < 0 || p.x + HALF.w > W || p.y - HALF.h < 0 || p.y + HALF.h > H) bad.push(`${label} → (${p.x.toFixed(1)}, ${p.y.toFixed(1)})`)
    }
    for (let n = 1; n <= 12; n++) {
      const { orbits } = layoutOrbits(ids(n))
      for (const e of tilts)
        for (const sx of [-SHAKE_PX, SHAKE_PX])
          for (const sy of [-SHAKE_PX, SHAKE_PX])
            for (let yi = 0; yi < 16; yi++) {
              const c: Cam = { yaw: (yi / 16) * TAU, e, D: CAM_D, zoom, cx: W / 2 + sx, cy: H / 2 + CENTER_DROP + sy }
              check(`n${n} 핵`, c, 0, CORE_Y, 0)
              for (const o of orbits)
                for (let s = 0; s < 64; s++) check(`n${n} ${o.id} e${e.toFixed(2)}`, c, ...worldOf(o, RA, (s / 64) * TAU))
            }
    }
    expect(bad.slice(0, 5)).toEqual([])
  })
})
