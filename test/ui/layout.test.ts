import { describe, it, expect } from 'vitest'
import { CELL, GAP_X, GAP_Y, MARGIN, NODE_SIZE, edgeEnds, isUnplaced, placeMissing, placeNew, type Point } from '../../src/renderer/map/layout'

const W = NODE_SIZE.w
const H = NODE_SIZE.h
/** 격자 한 칸의 높이 = 가장 큰 카드(승인 칸 + 두 줄 제목) */
const CH = CELL.h
const overlaps = (a: Point, b: Point, w = W, h = H) => a.x < b.x + w && b.x < a.x + w && a.y < b.y + h && b.y < a.y + h

describe('격자 치수', () => {
  it('바깥 여백 64 · 가로 칸 사이 200(엣지 라벨 알약 양쪽으로 선과 화살촉이 보이게) · 세로 칸 사이 64', () => {
    expect(MARGIN).toBe(64)
    expect(GAP_X).toBe(200)
    expect(GAP_Y).toBe(64)
  })

  it('칸 = 카드 너비 × 가장 큰 카드 높이 — 승인 칸에 두 줄 제목인 카드 217px(base.css 로 잰 값)', () => {
    // 테두리 2 + .nh 64(14 + 38 + 12) + .ap 111(테두리 1 + 8 + 제목 2줄 36 + 2 + code 18 + 2 + 단추 줄 36 + 8) + .nf 40
    expect(CELL).toEqual({ w: 256, h: 217 })
    expect(CELL.h).toBeGreaterThan(NODE_SIZE.h)
  })

  it('승인 칸 카드(304px)와 오른쪽 이웃 사이에도 라벨 알약(약 100px)보다 넓은 틈이 남는다', () => {
    const a = placeNew([])
    const b = placeNew([a])
    expect(b.x - (a.x + 304)).toBeGreaterThanOrEqual(150)
  })
})

describe('placeNew', () => {
  it('빈 관계도의 첫 자리는 격자 첫 칸(원점이 아님 — {0,0} 은 "아직 자리 없음")', () => {
    expect(placeNew([])).toEqual({ x: 64, y: 64 })
    expect(isUnplaced(placeNew([]))).toBe(false)
  })

  it('3열 격자 — 가로 칸 사이 200px, 세로 줄 간격 = 가장 큰 카드 + 64px', () => {
    const a = placeNew([])
    const b = placeNew([a])
    const c = placeNew([a, b])
    const d = placeNew([a, b, c])
    expect(b).toEqual({ x: a.x + W + 200, y: a.y })
    expect(c).toEqual({ x: a.x + 2 * (W + 200), y: a.y })
    expect(d).toEqual({ x: a.x, y: a.y + 217 + 64 })
  })

  it('12개를 잇달아 놓으면 모두 다른 칸이고 서로 겹치지 않는다', () => {
    const placed: Point[] = []
    for (let i = 0; i < 12; i++) placed.push(placeNew(placed))
    expect(new Set(placed.map(p => `${p.x},${p.y}`)).size).toBe(12)
    for (let i = 0; i < placed.length; i++)
      for (let j = i + 1; j < placed.length; j++) expect(overlaps(placed[i], placed[j])).toBe(false)
    expect(new Set(placed.map(p => p.x)).size).toBe(3)
    expect(new Set(placed.map(p => p.y)).size).toBe(4)
  })

  it('끌어다 둔 카드가 칸에 조금만 걸쳐도 그 칸은 건너뛴다', () => {
    const first = placeNew([])
    const second = { x: first.x + W + GAP_X, y: first.y }
    const third = { x: first.x + 2 * (W + GAP_X), y: first.y }
    const dragged = { x: second.x + 230, y: second.y + 100 } // 둘째·셋째 칸에 걸침
    expect(placeNew([dragged])).toEqual(first)
    expect(placeNew([dragged, first])).toEqual({ x: first.x, y: first.y + CH + GAP_Y })
    expect(overlaps(placeNew([dragged, first]), dragged, W, CH)).toBe(false)
    expect(overlaps(second, dragged)).toBe(true)
    expect(overlaps(third, dragged)).toBe(true)
  })

  it('가장 큰 카드 높이까지 늘어도 아래 줄 카드와 겹치지 않는다', () => {
    const a = placeNew([])
    const below = placeNew([a, placeNew([a]), placeNew([a, placeNew([a])])])
    expect(below.x).toBe(a.x)
    expect(below.y - (a.y + 217)).toBe(64)
  })

  it('칸 크기를 주면 그 크기로 칸을 잡는다', () => {
    const size = { w: 100, h: 50 }
    const a = placeNew([], size)
    expect(placeNew([a], size)).toEqual({ x: a.x + 100 + 200, y: a.y })
  })
})

describe('placeMissing', () => {
  it('{0,0} 인 에이전트만 자리를 받고, 이미 놓인 카드·서로와 겹치지 않는다', () => {
    const agents = [
      { id: 'a', pos: { x: 0, y: 0 } },
      { id: 'b', pos: { x: MARGIN, y: MARGIN } }, // 첫 칸에 이미 있음
      ...Array.from({ length: 11 }, (_, i) => ({ id: `n${i}`, pos: { x: 0, y: 0 } })),
    ]
    const out = placeMissing(agents)
    expect(out.has('b')).toBe(false)
    expect(out.size).toBe(12)
    const all = [agents[1].pos, ...out.values()]
    for (let i = 0; i < all.length; i++)
      for (let j = i + 1; j < all.length; j++) expect(overlaps(all[i], all[j], W, CH)).toBe(false)
  })

  it('놓을 게 없으면 빈 결과', () => {
    expect(placeMissing([{ id: 'a', pos: { x: 10, y: 20 } }]).size).toBe(0)
  })
})

describe('edgeEnds', () => {
  const rect = (x: number, y: number) => ({ x, y, w: W, h: H })

  it('옆에 있으면 보낸 쪽 오른쪽 → 받는 쪽 왼쪽, 화살촉 자리만큼 띄운다', () => {
    const e = edgeEnds(rect(0, 0), rect(600, 40))
    expect(e.source).toEqual({ x: W, y: H / 2 })
    expect(e.sourcePosition).toBe('right')
    expect(e.targetPort).toEqual({ x: 600, y: 40 + H / 2 })
    expect(e.target).toEqual({ x: 600 - 5, y: 40 + H / 2 })
    expect(e.targetPosition).toBe('left')
  })

  it('위아래로 멀면 아래 → 위', () => {
    const e = edgeEnds(rect(0, 0), rect(40, 500))
    expect(e.sourcePosition).toBe('bottom')
    expect(e.targetPosition).toBe('top')
    expect(e.source).toEqual({ x: W / 2, y: H })
    expect(e.target).toEqual({ x: 40 + W / 2, y: 500 - 5 })
  })

  it('양쪽이 각자 상대를 보는 변을 고른다 — 시안의 디자인(아래 왼쪽) → 웹 화면은 오른쪽 → 아래', () => {
    const design = { x: 64, y: 464, w: 304, h: 208 }
    const web = { x: 448, y: 272, w: W, h: H }
    const e = edgeEnds(design, web)
    expect(e.sourcePosition).toBe('right')
    expect(e.targetPosition).toBe('bottom')
    expect(e.targetPort).toEqual({ x: 448 + W / 2, y: 272 + H })
    expect(e.target).toEqual({ x: 448 + W / 2, y: 272 + H + 5 })
  })

  it('반대 방향 엣지는 옆으로 비켜 겹치지 않는다', () => {
    const ab = edgeEnds(rect(0, 0), rect(600, 0), -12)
    const ba = edgeEnds(rect(600, 0), rect(0, 0), 12)
    expect(ab.source.y).toBe(H / 2 - 12)
    expect(ba.source.y).toBe(H / 2 + 12)
  })
})
