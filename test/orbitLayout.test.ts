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

  // 8명부터는 궤도 카드가 작은 판(data-crowd)이 된다 — 작은 카드 반쪽 46×16, 핵 카드 95×25.
  // 한 프레임의 카드 쌍 겹친 넓이 합을 카드 한 장(190×64) 단위로 재서, 프레임 평균이 0.1 장보다 작아야 한다.
  // 기울기는 보통 때 카메라가 오가는 범위(base ± swing)를 고르게 훑는다 — 동기화의 2초 기울기 내림은 잠깐이라 평균에 넣지 않는다.
  it('8~12명이면_작은_카드의_겹침이_프레임_평균_0.1장_아래', () => {
    const W = 748
    const H = 580
    const RA = orbitRA(W, H)
    const ORBIT = { w: 46, h: 16 }
    const CORE = { w: 95, h: 25 }
    const CARD = 190 * 64
    const tilts = Array.from({ length: 5 }, (_, i) => TILT.base - TILT.swing + (TILT.swing * 2 * i) / 4)
    const overlap = (ax: number, ay: number, a: { w: number; h: number }, bx: number, by: number, b: { w: number; h: number }) => {
      const ox = Math.min(ax + a.w, bx + b.w) - Math.max(ax - a.w, bx - b.w)
      const oy = Math.min(ay + a.h, by + b.h) - Math.max(ay - a.h, by - b.h)
      return ox > 0 && oy > 0 ? ox * oy : 0
    }
    const means: Record<number, number> = {}
    for (let n = 8; n <= 12; n++) {
      const { orbits } = layoutOrbits(ids(n))
      let sum = 0
      let frames = 0
      for (const e of tilts)
        for (let yi = 0; yi < 16; yi++)
          for (let s = 0; s < 64; s++) {
            const c: Cam = { yaw: (yi / 16) * TAU, e, D: CAM_D, zoom: 1, cx: W / 2, cy: H / 2 + CENTER_DROP }
            const core = project(c, 0, CORE_Y, 0)
            const pts = orbits.map(o => project(c, ...worldOf(o, RA, (s / 64) * TAU)))
            let f = 0
            for (const [i, p] of pts.entries()) {
              f += overlap(core.x, core.y, CORE, p.x, p.y, ORBIT)
              for (const q of pts.slice(i + 1)) f += overlap(p.x, p.y, ORBIT, q.x, q.y, ORBIT)
            }
            sum += f / CARD
            frames++
          }
      means[n] = sum / frames
    }
    for (let n = 8; n <= 12; n++) expect(means[n], `${n}명`).toBeLessThan(0.1)
  })
})
