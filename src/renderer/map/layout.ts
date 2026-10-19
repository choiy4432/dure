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

/** 변에서 나가는 조절점 — React Flow getBezierPath 와 같은 셈 */
function controlPoint(side: Side, p: Point, q: Point): Point {
  switch (side) {
    case 'left': return { x: p.x - controlOffset(p.x - q.x), y: p.y }
    case 'right': return { x: p.x + controlOffset(q.x - p.x), y: p.y }
    case 'top': return { x: p.x, y: p.y - controlOffset(p.y - q.y) }
    case 'bottom': return { x: p.x, y: p.y + controlOffset(q.y - p.y) }
  }
}

const STILL: Point = { x: 0, y: 0 }

/**
 * 엣지 곡선의 네 점 — 끝점 둘과 React Flow getBezierPath 와 같은 조절점 둘.
 * bow 만큼 두 조절점을 함께 민다(짝 엣지가 가운데에서 서로 멀어지게 휜다 — 곡선 한가운데는 bow 의 3/4 만큼 옮겨 간다).
 */
function controls(e: EdgeEnds, bow: Point): [Point, Point, Point, Point] {
  const p1 = controlPoint(e.sourcePosition, e.source, e.target)
  const p2 = controlPoint(e.targetPosition, e.target, e.source)
  return [e.source, { x: p1.x + bow.x, y: p1.y + bow.y }, { x: p2.x + bow.x, y: p2.y + bow.y }, e.target]
}

/** 엣지 선(SVG path) — 휘지 않으면(bow 0) React Flow getBezierPath 와 같은 곡선 */
export function edgePath(e: EdgeEnds, bow: Point = STILL): string {
  const [p0, p1, p2, p3] = controls(e, bow)
  return `M${p0.x},${p0.y} C${p1.x},${p1.y} ${p2.x},${p2.y} ${p3.x},${p3.y}`
}

/** 엣지 곡선 위 t(0 = 보낸 쪽, 1 = 화살촉) 자리 */
export function curvePoint(e: EdgeEnds, t: number, bow: Point = STILL): Point {
  const [p0, p1, p2, p3] = controls(e, bow)
  const u = 1 - t
  const a = u * u * u
  const b = 3 * u * u * t
  const c = 3 * u * t * t
  const d = t * t * t
  return { x: a * p0.x + b * p1.x + c * p2.x + d * p3.x, y: a * p0.y + b * p1.y + c * p2.y + d * p3.y }
}

/** 엣지 상태 알약 크기(재기 전 기본) — base.css .el 높이 24, 너비는 '전달됨 · 방금' 쯤 */
export const LABEL_SIZE: Size = { w: 88, h: 24 }
/** 짝 알약 사이에 남길 틈 */
const LABEL_GAP = 8

/**
 * 짝 엣지가 휘는 정도(조절점을 미는 벡터) — 같은 두 카드를 반대로 잇는 짝(shift ≠ 0, 예: '상한 대기' 둘)은
 * 끝점만 변을 따라 비켜서는 가운데의 두 알약이 겹친다(위아래로 잇는 짝은 늘). 그래서 두 선을 가운데에서 서로 바깥으로 휘게 해,
 * 각자 제 곡선 한가운데에 놓인 두 알약이 알약 크기 + 틈만큼 떨어지게 한다. 이미 떨어져 있으면 휘지 않는다.
 * 바깥 = 두 카드 가운데를 잇는 선에 수직, 짝 곡선의 한가운데에서 내 곡선 한가운데 쪽.
 * 짝의 곡선은 같은 카드에서 그대로 셈한다(edgeEnds(to, from, -shift)) — 두 엣지가 거울인 셈을 해 서로 반대로 휜다.
 * pill = 내 알약의 실제 크기(HandoffEdge 가 잰다) — 짝도 제 크기로 셈해 둘의 몫을 더하면 꼭 필요한 만큼이 된다.
 */
export function pairBow(e: EdgeEnds, shift: number, from: Rect, to: Rect, pill: Size = LABEL_SIZE): Point {
  if (shift === 0) return STILL
  const mine = curvePoint(e, 0.5)
  const theirs = curvePoint(edgeEnds(to, from, -shift), 0.5)
  const dx = to.x + to.w / 2 - (from.x + from.w / 2)
  const dy = to.y + to.h / 2 - (from.y + from.h / 2)
  const len = Math.hypot(dx, dy) || 1
  const gap = { x: mine.x - theirs.x, y: mine.y - theirs.y }
  let n = { x: -dy / len, y: dx / len }
  if (gap.x * n.x + gap.y * n.y < 0) n = { x: -n.x, y: -n.y }
  // 두 한가운데가 각자 n·-n 으로 p 만큼 옮기면 차이는 gap + 2p·n — 가로(알약 너비 + 틈)나 세로(높이 + 틈)로
  // 떨어지는 가장 작은 p. 이미 떨어져 있으면 0
  const along = (d: number, nd: number, size: number) => {
    const need = size + LABEL_GAP
    if (Math.abs(d) >= need) return 0
    if (Math.abs(nd) < 1e-9) return Infinity
    return (need - Math.sign(nd) * d) / (2 * Math.abs(nd))
  }
  const p = Math.min(along(gap.x, n.x, pill.w), along(gap.y, n.y, pill.h))
  if (p === 0 || !Number.isFinite(p)) return STILL
  const push = p / 0.75
  return { x: n.x * push, y: n.y * push }
}
