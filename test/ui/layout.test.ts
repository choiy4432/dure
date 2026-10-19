import { describe, it, expect } from 'vitest'
import { Position, getBezierPath } from '@xyflow/react'
import {
  CELL, GAP_X, GAP_Y, MARGIN, NODE_SIZE, edgeEnds, isUnplaced, labelPoint, placeMissing, placeNew,
  type EdgeEnds, type Point, type Rect, type Side,
} from '../../src/renderer/map/layout'

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

describe('labelPoint — 엣지 가운데 상태 알약 자리', () => {
  const rect = (x: number, y: number, w = W, h = H) => ({ x, y, w, h })
  const SIDE: Record<Side, Position> = { left: Position.Left, right: Position.Right, top: Position.Top, bottom: Position.Bottom }
  /** HandoffEdge 가 그리는 그 곡선(React Flow getBezierPath) */
  const bezier = (e: EdgeEnds) =>
    getBezierPath({
      sourceX: e.source.x, sourceY: e.source.y, sourcePosition: SIDE[e.sourcePosition],
      targetX: e.target.x, targetY: e.target.y, targetPosition: SIDE[e.targetPosition],
    })
  /** 그 곡선 위 점 — 경로 문자열 'M x,y C x,y x,y x,y' 의 3차 곡선 */
  const onPath = (e: EdgeEnds, t: number) => {
    const n = bezier(e)[0].match(/-?\d+(?:\.\d+)?(?:e-?\d+)?/g)!.map(Number)
    const u = 1 - t
    const k = [u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t]
    return { x: k[0] * n[0] + k[1] * n[2] + k[2] * n[4] + k[3] * n[6], y: k[0] * n[1] + k[1] * n[3] + k[2] * n[5] + k[3] * n[7] }
  }
  /** 점에서 곡선까지 가장 가까운 거리(곡선을 잘게 나눠 잰다) */
  const distToCurve = (p: Point, e: EdgeEnds) => {
    let best = Infinity
    for (let i = 0; i <= 400; i++) {
      const q = onPath(e, i / 400)
      best = Math.min(best, Math.hypot(q.x - p.x, q.y - p.y))
    }
    return best
  }
  /** 가장 긴 알약('전달됨 · 59분 전')에 여유를 둔 크기 · 두 알약 사이 최소 틈 */
  const PILL = { w: 104, h: 24 }
  const GAP = 4
  const apart = (p: Point, q: Point) => Math.abs(p.x - q.x) >= PILL.w + GAP || Math.abs(p.y - q.y) >= PILL.h + GAP

  it('짝이 없는 엣지는 곡선 한가운데 — React Flow 의 라벨 자리와 같다', () => {
    for (const [s, t] of [[rect(0, 0), rect(600, 40)], [rect(0, 0), rect(40, 500)], [{ x: 64, y: 464, w: 304, h: 208 }, rect(448, 272)]] as const) {
      const e = edgeEnds(s, t)
      const [, lx, ly] = bezier(e)
      const p = labelPoint(e, 0, s, t)
      expect(p.x).toBeCloseTo(lx, 6)
      expect(p.y).toBeCloseTo(ly, 6)
    }
  })

  // 같은 두 카드를 반대로 잇는 두 엣지(예: '상한 대기' 둘) — 두 알약이 떨어져 둘 다 읽히고, 각자 제 곡선 위에
  const pairs: [string, Rect, Rect][] = [
    ['위아래(검수 캡처의 웹 화면 ↔ 서버)', rect(448, 272), rect(576, 592)],
    ['위아래로 가까움(넓은 승인 카드 아래 64px)', { x: 64, y: 64, w: 304, h: 217 }, rect(64, 64 + 217 + 64)],
    ['옆(가로 칸 사이 200)', rect(64, 64), rect(64 + W + 200, 64)],
    ['옆으로 가까움(넓은 승인 카드 옆 152)', { x: 64, y: 64, w: 304, h: 217 }, rect(64 + W + 200, 64)],
    ['비스듬히(시안의 디자인 → 웹 화면)', { x: 64, y: 464, w: 304, h: 208 }, rect(448, 272)],
    ['멀리 대각선', rect(64, 64), rect(1000, 700)],
  ]

  it.each(pairs)('%s — 두 알약이 겹치지 않는다', (_name, a, b) => {
    const ab = edgeEnds(a, b, -12)
    const ba = edgeEnds(b, a, 12)
    const pa = labelPoint(ab, -12, a, b)
    const pb = labelPoint(ba, 12, b, a)
    expect(apart(pa, pb)).toBe(true)
  })

  it.each(pairs)('%s — 알약은 제 곡선 위에(곡선이 알약 안을 지난다)', (_name, a, b) => {
    const ab = edgeEnds(a, b, -12)
    const ba = edgeEnds(b, a, 12)
    expect(distToCurve(labelPoint(ab, -12, a, b), ab)).toBeLessThanOrEqual(PILL.h / 2 - 4)
    expect(distToCurve(labelPoint(ba, 12, b, a), ba)).toBeLessThanOrEqual(PILL.h / 2 - 4)
  })

  it('짝인 알약은 곡선 바깥쪽(제 선이 비킨 쪽)으로 조금 더 비킨다 — 가운데 선에서 서로 멀어진다', () => {
    const a = rect(64, 64)
    const b = rect(64 + W + 200, 64)
    const ab = edgeEnds(a, b, -12) // 위로 비킨 선
    const ba = edgeEnds(b, a, 12) // 아래로 비킨 선
    const mid = a.y + H / 2
    expect(labelPoint(ab, -12, a, b).y).toBeLessThan(mid - 12)
    expect(labelPoint(ba, 12, b, a).y).toBeGreaterThan(mid + 12)
  })
})
