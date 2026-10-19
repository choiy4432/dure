// 관계도 자리 — 새 에이전트를 놓을 칸과 엣지 끝점 (순수)

export interface Point {
  x: number
  y: number
}
export interface Size {
  w: number
  h: number
}
export interface Rect extends Point, Size {}

/** 카드 크기(base.css .nd 너비·최소 높이와 같은 수) */
export const NODE_SIZE: Size = { w: 256, h: 136 }
/** 격자 칸 사이 · 격자 바깥 여백 */
export const GRID_GAP = 64
const COLS = 3

const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h

/** 엔진이 처음 준 자리 {0,0} = 아직 자리를 안 정함(격자 첫 칸은 GRID_GAP 에서 시작해 겹치지 않는다) */
export const isUnplaced = (p: Point) => p.x === 0 && p.y === 0

/** 새 에이전트 자리 — 3열 격자(칸 사이 64px)에서 놓인 카드와 겹치지 않는 첫 칸 */
export function placeNew(existing: Point[], size: Size = NODE_SIZE): Point {
  const taken = existing.map(p => ({ ...p, ...size }))
  for (let i = 0; ; i++) {
    const cell = {
      x: GRID_GAP + (i % COLS) * (size.w + GRID_GAP),
      y: GRID_GAP + Math.floor(i / COLS) * (size.h + GRID_GAP),
    }
    if (!taken.some(t => overlaps(t, { ...cell, ...size }))) return cell
  }
}

/** 자리 없는({0,0}) 에이전트마다 차례로 자리를 정한다 — 이미 놓인 카드·앞에서 정한 자리와 겹치지 않게 */
export function placeMissing(agents: { id: string; pos: Point }[], size: Size = NODE_SIZE): Map<string, Point> {
  const taken = agents.filter(a => !isUnplaced(a.pos)).map(a => a.pos)
  const out = new Map<string, Point>()
  for (const a of agents) {
    if (!isUnplaced(a.pos)) continue
    const p = placeNew(taken, size)
    taken.push(p)
    out.set(a.id, p)
  }
  return out
}

export type Side = 'left' | 'right' | 'top' | 'bottom'
export interface EdgeEnds {
  /** 선이 시작하는 점(보낸 카드 테두리) */
  source: Point
  sourcePosition: Side
  /** 선이 끝나는 점 — 화살촉 길이만큼 받는 카드 밖 */
  target: Point
  targetPosition: Side
  /** 받는 카드 테두리 위의 점(작은 고리·도착 고리 자리) */
  targetPort: Point
}

/** 화살촉 자리 — 선 끝이 카드 테두리에서 이만큼 떨어진다 */
export const ARROW_GAP = 5

function sidePoint(r: Rect, side: Side, shift: number): Point {
  switch (side) {
    case 'left': return { x: r.x, y: r.y + r.h / 2 + shift }
    case 'right': return { x: r.x + r.w, y: r.y + r.h / 2 + shift }
    case 'top': return { x: r.x + r.w / 2 + shift, y: r.y }
    case 'bottom': return { x: r.x + r.w / 2 + shift, y: r.y + r.h }
  }
}

const OUT: Record<Side, Point> = { left: { x: -1, y: 0 }, right: { x: 1, y: 0 }, top: { x: 0, y: -1 }, bottom: { x: 0, y: 1 } }

/** from 카드에서 to 카드 쪽을 보는 변 — 가로·세로 거리를 from 카드의 반폭·반높이로 나눠 견준다(넓적한 카드) */
function facing(from: Rect, to: Rect): Side {
  const dx = to.x + to.w / 2 - (from.x + from.w / 2)
  const dy = to.y + to.h / 2 - (from.y + from.h / 2)
  if (Math.abs(dx) / Math.max(1, from.w / 2) >= Math.abs(dy) / Math.max(1, from.h / 2)) return dx >= 0 ? 'right' : 'left'
  return dy >= 0 ? 'bottom' : 'top'
}

/**
 * 두 카드를 잇는 선의 끝점 — 양쪽 카드가 각자 상대를 보는 변의 가운데(시안처럼 오른쪽 → 아래 같은 꺾임도 된다).
 * shift 는 같은 두 카드를 반대로 잇는 선이 겹치지 않게 변을 따라 비키는 거리.
 */
export function edgeEnds(s: Rect, t: Rect, shift = 0): EdgeEnds {
  const sourcePosition = facing(s, t)
  const targetPosition = facing(t, s)
  const source = sidePoint(s, sourcePosition, shift)
  const targetPort = sidePoint(t, targetPosition, shift)
  const out = OUT[targetPosition]
  return {
    source,
    sourcePosition,
    target: { x: targetPort.x + out.x * ARROW_GAP, y: targetPort.y + out.y * ARROW_GAP },
    targetPosition,
    targetPort,
  }
}
