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
/**
 * 격자 한 칸 — 너비는 카드, 높이는 가장 큰 카드 상태: 승인 칸(.ap)에 제목이 두 줄인 카드 217px.
 * base.css 로 잰 값 = 테두리 2 + .nh 64 + .ap 111(테두리 1 + 위아래 8 + 제목 2줄 36 + 2 + code 18 + 2 + 단추 줄 36) + .nf 40.
 * 승인 칸 카드는 304px 로 넓어지지만 오른쪽으로만 — 가로 칸 사이(GAP_X)가 그만큼을 받아 준다.
 */
export const CELL: Size = { w: NODE_SIZE.w, h: 217 }
/** 가로 칸 사이 — 이웃 카드 사이 엣지의 라벨 알약(약 90~110px) 양쪽으로 선과 화살촉이 보이게(넓은 승인 카드 옆도 152px 남는다) */
export const GAP_X = 200
/** 세로 칸 사이 — 가장 큰 카드 아래로도 이만큼 */
export const GAP_Y = 64
/** 격자 바깥 여백 */
export const MARGIN = 64
const COLS = 3

const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h

/** 엔진이 처음 준 자리 {0,0} = 아직 자리를 안 정함(격자 첫 칸은 MARGIN 에서 시작해 겹치지 않는다) */
export const isUnplaced = (p: Point) => p.x === 0 && p.y === 0

/**
 * 새 에이전트 자리 — 3열 격자(가로 칸 사이 200px · 세로 64px)에서 놓인 카드와 겹치지 않는 첫 칸.
 * 이미 저장된 자리는 건드리지 않는다 — 새로 놓을 때만 이 격자를 쓴다.
 */
export function placeNew(existing: Point[], cell: Size = CELL): Point {
  const taken = existing.map(p => ({ ...p, ...cell }))
  for (let i = 0; ; i++) {
    const at = {
      x: MARGIN + (i % COLS) * (cell.w + GAP_X),
      y: MARGIN + Math.floor(i / COLS) * (cell.h + GAP_Y),
    }
    if (!taken.some(t => overlaps(t, { ...at, ...cell }))) return at
  }
}

/** 자리 없는({0,0}) 에이전트마다 차례로 자리를 정한다 — 이미 놓인 카드·앞에서 정한 자리와 겹치지 않게 */
export function placeMissing(agents: { id: string; pos: Point }[], cell: Size = CELL): Map<string, Point> {
  const taken = agents.filter(a => !isUnplaced(a.pos)).map(a => a.pos)
  const out = new Map<string, Point>()
  for (const a of agents) {
    if (!isUnplaced(a.pos)) continue
    const p = placeNew(taken, cell)
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

/** React Flow getBezierPath 기본 곡률 */
const CURVATURE = 0.25

function controlOffset(distance: number): number {
  return distance >= 0 ? 0.5 * distance : CURVATURE * 25 * Math.sqrt(-distance)
}

/** 변에서 나가는 조절점 — React Flow getBezierPath 와 같은 셈(HandoffEdge 가 그 함수로 선을 그린다) */
function controlPoint(side: Side, p: Point, q: Point): Point {
  switch (side) {
    case 'left': return { x: p.x - controlOffset(p.x - q.x), y: p.y }
    case 'right': return { x: p.x + controlOffset(q.x - p.x), y: p.y }
    case 'top': return { x: p.x, y: p.y - controlOffset(p.y - q.y) }
    case 'bottom': return { x: p.x, y: p.y + controlOffset(q.y - p.y) }
  }
}

/** 엣지 곡선 위 t(0 = 보낸 쪽, 1 = 화살촉) 자리 — HandoffEdge 가 그리는 그 3차 곡선 */
export function curvePoint(e: EdgeEnds, t: number): Point {
  const p0 = e.source
  const p3 = e.target
  const p1 = controlPoint(e.sourcePosition, p0, p3)
  const p2 = controlPoint(e.targetPosition, p3, p0)
  const u = 1 - t
  const a = u * u * u
  const b = 3 * u * u * t
  const c = 3 * u * t * t
  const d = t * t * t
  return { x: a * p0.x + b * p1.x + c * p2.x + d * p3.x, y: a * p0.y + b * p1.y + c * p2.y + d * p3.y }
}

/** 엣지 상태 알약 크기 — base.css .el 높이 24 · 너비는 가장 긴 문구('전달됨 · 59분 전')에 여유를 둔 값 */
export const LABEL_SIZE: Size = { w: 104, h: 24 }
/** 짝 알약 사이에 남길 틈 */
const LABEL_GAP = 8
/** 짝 알약이 곡선을 따라 미끄러지는 한 걸음 · 가장 멀리(곡선 양 끝 15% 안으로는 가지 않는다) */
const SLIDE_STEP = 0.01
const SLIDE_MAX = 0.35

const AXIS: Record<Side, Point> = { left: { x: 0, y: 1 }, right: { x: 0, y: 1 }, top: { x: 1, y: 0 }, bottom: { x: 1, y: 0 } }

/**
 * 짝 엣지의 알약 한 개 자리 — 곡선 위 t 에서, 제 선이 비킨 쪽(엣지에 수직)으로 shift 의 반만큼 더.
 * 비킨 쪽 = 끝점이 변을 따라 shift 만큼 옮겨 간 쪽. 더 비켜도 곡선은 알약(높이 24) 안에 남는다.
 */
function pairPlace(e: EdgeEnds, shift: number, from: Rect, to: Rect, t: number): Point {
  const dx = to.x + to.w / 2 - (from.x + from.w / 2)
  const dy = to.y + to.h / 2 - (from.y + from.h / 2)
  const len = Math.hypot(dx, dy) || 1
  const ax = AXIS[e.sourcePosition].x + AXIS[e.targetPosition].x
  const ay = AXIS[e.sourcePosition].y + AXIS[e.targetPosition].y
  const side = Math.sign(shift) * (-dy * ax + dx * ay) < 0 ? -1 : 1
  const k = (side * Math.abs(shift)) / 2 / len
  const p = curvePoint(e, t)
  return { x: p.x - dy * k, y: p.y + dx * k }
}

/**
 * 엣지 상태 알약 자리 — 보통은 곡선 한가운데(React Flow 의 라벨 자리와 같다).
 * 같은 두 카드를 반대로 잇는 짝(shift ≠ 0, 예: '상한 대기' 둘)이면 두 알약이 겹치지 않게, 각자 제 곡선 위에서:
 * ① 제 선이 비킨 쪽(엣지에 수직)으로 shift 의 반만큼 더 비킨다(pairPlace).
 * ② 그래도 겹치면(위아래로 잇는 짝은 알약 너비 때문에 늘 겹친다) 곡선을 따라 둘 다 제 보낸 쪽으로 — 서로 반대 끝으로 —
 *    겹치지 않는 가장 짧은 거리만큼 미끄러진다. 보낸 쪽으로 안 되면 받는 쪽으로.
 * 짝의 곡선은 같은 카드에서 그대로 셈한다(edgeEnds(to, from, -shift)) — 두 엣지가 정확히 거울인 셈을 해 같은 답을 낸다.
 */
export function labelPoint(e: EdgeEnds, shift: number, from: Rect, to: Rect): Point {
  if (shift === 0) return curvePoint(e, 0.5)
  const other = edgeEnds(to, from, -shift)
  const at = (t: number) => {
    const me = pairPlace(e, shift, from, to, t)
    const it = pairPlace(other, -shift, to, from, t)
    const clear = Math.abs(it.x - me.x) >= LABEL_SIZE.w + LABEL_GAP || Math.abs(it.y - me.y) >= LABEL_SIZE.h + LABEL_GAP
    return { me, clear }
  }
  for (let i = 0; i * SLIDE_STEP <= SLIDE_MAX + 1e-9; i++) {
    for (const t of i === 0 ? [0.5] : [0.5 - i * SLIDE_STEP, 0.5 + i * SLIDE_STEP]) {
      const r = at(t)
      if (r.clear) return r.me
    }
  }
  return at(0.5 - SLIDE_MAX).me
}
