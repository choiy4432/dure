import { describe, it, expect } from 'vitest'
import { Position, getBezierPath } from '@xyflow/react'
import {
  CELL, GAP_X, GAP_Y, MARGIN, NODE_SIZE, curvePoint, edgeEnds, edgePath, isUnplaced, pairBow, placeMissing, placeNearest, placeNew,
  type Point, type Rect, type Side,
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

  it('만든 쪽(by)이 있으면 그 카드 가까이(placeNearest), 없으면 지금처럼 첫 빈 칸', () => {
    const p = { x: MARGIN, y: MARGIN }
    const q = { x: MARGIN + W + GAP_X, y: MARGIN }
    const out = placeMissing([
      { id: 'p', pos: p },
      { id: 'q', pos: q },
      { id: 'n', pos: { x: 0, y: 0 }, by: 'q' },
      { id: 'm', pos: { x: 0, y: 0 } },
    ])
    expect(out.get('n')).toEqual({ x: q.x, y: q.y + CH + GAP_Y }) // q 바로 아래 — 첫 빈 칸(p 아래)이 아니라
    expect(out.get('m')).toEqual(placeNew([p, q])) // 첫 줄 셋째 칸
    expect(overlaps(out.get('n')!, out.get('m')!, W, CH)).toBe(false)
  })

  it('만든 쪽도 자리가 없으면 그쪽이 먼저 첫 빈 칸을 받고, 새 에이전트는 그 가까이 — 목록 차례와 상관없이', () => {
    const out = placeMissing([
      { id: 'n', pos: { x: 0, y: 0 }, by: 'a' },
      { id: 'a', pos: { x: 0, y: 0 } },
    ])
    expect(out.get('a')).toEqual({ x: MARGIN, y: MARGIN })
    expect(out.get('n')).toEqual({ x: MARGIN, y: MARGIN + CH + GAP_Y })
  })

  it('만든 쪽이 목록에 없으면(지워짐·다른 방) 첫 빈 칸', () => {
    const p = { x: MARGIN, y: MARGIN }
    expect(placeMissing([{ id: 'p', pos: p }, { id: 'n', pos: { x: 0, y: 0 }, by: 'gone' }]).get('n')).toEqual(placeNew([p]))
  })
})

describe('placeNearest', () => {
  const near = { x: MARGIN + W + GAP_X, y: MARGIN }
  const SX = W + GAP_X
  const SY = CH + GAP_Y
  const at = (i: number, j: number) => ({ x: near.x + i * SX, y: near.y + j * SY })

  it('만든 카드 바로 아래 칸이 비었으면 거기 — 세로 칸 사이(281)가 가로(456)보다 가깝다', () => {
    expect(placeNearest([near], near)).toEqual(at(0, 1))
  })

  it('가까운 차례 — 아래 → 위 → 오른쪽 → 왼쪽 → 대각선(같은 거리면 오른쪽·아래가 먼저)', () => {
    const taken = [near]
    const order: Point[] = []
    for (let k = 0; k < 8; k++) {
      const p = placeNearest(taken, near)
      order.push(p)
      taken.push(p)
    }
    expect(order).toEqual([at(0, 1), at(0, -1), at(1, 0), at(-1, 0), at(1, 1), at(-1, 1), at(-1, -1), at(1, -1)])
  })

  it('놓인 카드에 조금만 걸쳐도 그 칸은 건너뛰고, 고른 칸은 어느 카드와도 겹치지 않는다', () => {
    const dragged = { x: near.x + 200, y: near.y + 300 } // 아래 칸에 걸침
    const p = placeNearest([near, dragged], near)
    expect(p).toEqual(at(0, -1))
    for (const t of [near, dragged]) expect(overlaps(p, t, W, CH)).toBe(false)
  })

  it('{0,0}(자리 없음 뜻)은 고르지 않는다', () => {
    const c = { x: SX, y: SY } // 왼쪽 위 대각선 칸이 꼭 {0,0}
    const taken = [c, { x: c.x, y: c.y + SY }, { x: c.x, y: c.y - SY }, { x: c.x + SX, y: c.y }, { x: c.x - SX, y: c.y }, { x: c.x + SX, y: c.y + SY }, { x: c.x - SX, y: c.y + SY }]
    const p = placeNearest(taken, c)
    expect(isUnplaced(p)).toBe(false)
    expect(p).toEqual({ x: c.x + SX, y: c.y - SY })
  })

  it('잇달아 20개를 놓아도 서로·만든 카드와 겹치지 않는다', () => {
    const taken: Point[] = [near]
    for (let k = 0; k < 20; k++) taken.push(placeNearest(taken, near))
    for (let i = 0; i < taken.length; i++)
      for (let j = i + 1; j < taken.length; j++) expect(overlaps(taken[i], taken[j], W, CH)).toBe(false)
  })

  it('칸 크기를 주면 그 크기로 잰다', () => {
    const size = { w: 100, h: 50 }
    expect(placeNearest([{ x: 500, y: 500 }], { x: 500, y: 500 }, size)).toEqual({ x: 500, y: 500 + 50 + GAP_Y })
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

describe('엣지 선과 상태 알약 자리 — edgePath · pairBow · 알약은 곡선 한가운데(curvePoint 0.5)', () => {
  const rect = (x: number, y: number, w = W, h = H) => ({ x, y, w, h })
  const SIDE: Record<Side, Position> = { left: Position.Left, right: Position.Right, top: Position.Top, bottom: Position.Bottom }
  const nums = (d: string) => d.match(/-?\d+(?:\.\d+)?(?:e-?\d+)?/g)!.map(Number)
  /** 경로 문자열 'M x,y C x,y x,y x,y' 의 3차 곡선 위 점 */
  const onPath = (d: string, t: number) => {
    const n = nums(d)
    const u = 1 - t
    const k = [u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t]
    return { x: k[0] * n[0] + k[1] * n[2] + k[2] * n[4] + k[3] * n[6], y: k[0] * n[1] + k[1] * n[3] + k[2] * n[5] + k[3] * n[7] }
  }
  const samples = (d: string) => Array.from({ length: 401 }, (_, i) => onPath(d, i / 400))
  /** 점에서 그 선까지 가장 가까운 거리(선을 잘게 나눠 잰다) */
  const distToPath = (p: Point, d: string) => Math.min(...samples(d).map(q => Math.hypot(q.x - p.x, q.y - p.y)))
  /** 두 알약 사이 최소 틈 */
  const GAP = 4

  it('짝이 없는 엣지는 휘지 않고 React Flow getBezierPath 와 같은 선 · 알약은 그 한가운데(React Flow 의 라벨 자리)', () => {
    for (const [s, t] of [[rect(0, 0), rect(600, 40)], [rect(0, 0), rect(40, 500)], [{ x: 64, y: 464, w: 304, h: 208 }, rect(448, 272)]] as const) {
      const e = edgeEnds(s, t)
      const [d, lx, ly] = getBezierPath({
        sourceX: e.source.x, sourceY: e.source.y, sourcePosition: SIDE[e.sourcePosition],
        targetX: e.target.x, targetY: e.target.y, targetPosition: SIDE[e.targetPosition],
      })
      expect(pairBow(e, 0, s, t)).toEqual({ x: 0, y: 0 })
      nums(edgePath(e)).forEach((v, i) => expect(v).toBeCloseTo(nums(d)[i], 6))
      const p = curvePoint(e, 0.5, pairBow(e, 0, s, t))
      expect(p.x).toBeCloseTo(lx, 6)
      expect(p.y).toBeCloseTo(ly, 6)
    }
  })

  // 같은 두 카드를 반대로 잇는 두 엣지(예: '상한 대기' 둘)
  const pairs: [string, Rect, Rect][] = [
    ['위아래(검수 캡처의 웹 화면 ↔ 서버)', rect(448, 272), rect(576, 592)],
    ['같은 열 위아래', rect(64, 64), rect(64, 64 + CELL.h + GAP_Y)],
    ['위아래로 가까움(넓은 승인 카드 아래 64px)', { x: 64, y: 64, w: 304, h: 217 }, rect(64, 64 + 217 + 64)],
    ['옆(가로 칸 사이 200)', rect(64, 64), rect(64 + W + 200, 64)],
    ['옆으로 가까움(넓은 승인 카드 옆 152)', { x: 64, y: 64, w: 304, h: 217 }, rect(64 + W + 200, 64)],
    ['비스듬히(시안의 디자인 → 웹 화면)', { x: 64, y: 464, w: 304, h: 208 }, rect(448, 272)],
    ['멀리 대각선', rect(64, 64), rect(1000, 700)],
  ]
  // 알약 너비 — '상한 대기' 67 · '전달됨 · 방금' 87 · '전달됨 · 12분 전' 100
  const widths = [67, 87, 100]
  const cases = pairs.flatMap(([name, a, b]) => widths.map(w => [`${name} · 알약 ${w}px`, a, b, w] as const))

  it.each(cases)('%s — 두 알약이 떨어져 둘 다 읽히고, 각자 제 곡선 위에', (_name, a, b, w) => {
    const pill = { w, h: 24 }
    const ab = edgeEnds(a, b, -12)
    const ba = edgeEnds(b, a, 12)
    const bowA = pairBow(ab, -12, a, b, pill)
    const bowB = pairBow(ba, 12, b, a, pill)
    // HandoffEdge 처럼 — 알약은 휜 곡선의 한가운데
    const pa = curvePoint(ab, 0.5, bowA)
    const pb = curvePoint(ba, 0.5, bowB)
    // 떨어져 있다 — 가로로든 세로로든 알약 크기 + 틈
    expect(Math.abs(pa.x - pb.x) >= w + GAP || Math.abs(pa.y - pb.y) >= 24 + GAP).toBe(true)
    // 제 곡선(그리는 그 선) 한가운데
    expect(distToPath(pa, edgePath(ab, bowA))).toBeLessThan(0.5)
    expect(distToPath(pb, edgePath(ba, bowB))).toBeLessThan(0.5)
    // 서로 반대쪽으로 휜다(휘었다면)
    expect(bowA.x * bowB.x + bowA.y * bowB.y).toBeLessThanOrEqual(0)
  })

  it('나란히 옆으로 잇는 짝은 이미 거의 떨어져 있어 조금만 휜다(선 모양이 거의 그대로)', () => {
    const a = rect(64, 64)
    const b = rect(64 + W + 200, 64)
    const bow = pairBow(edgeEnds(a, b, -12), -12, a, b, { w: 87, h: 24 })
    expect(Math.hypot(bow.x, bow.y)).toBeLessThan(8)
    expect(bow.y).toBeLessThan(0) // 위로 비킨 선은 위로
  })

  it('알약이 넓을수록 위아래 짝은 더 휜다 — 필요한 만큼만', () => {
    const a = rect(448, 272)
    const b = rect(576, 592)
    const e = edgeEnds(a, b, -12)
    const len = (w: number) => Math.hypot(pairBow(e, -12, a, b, { w, h: 24 }).x, pairBow(e, -12, a, b, { w, h: 24 }).y)
    expect(len(67)).toBeGreaterThan(0)
    expect(len(100)).toBeGreaterThan(len(67))
  })
})

