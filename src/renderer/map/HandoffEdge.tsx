import { memo, useEffect, useLayoutEffect, useRef, useState, type MouseEvent } from 'react'
import {
  EdgeLabelRenderer, ViewportPortal, useInternalNode,
  type Edge, type EdgeProps, type InternalNode,
} from '@xyflow/react'
import type { AgentId, MessageState } from '../../engine/types'
import { useDure } from '../state/store'
import { label } from '../state/selectors'
import { useNow } from '../lib/useNow'
import { PACKET_MS, useShot } from '../lib/motion'
import { LABEL_SIZE, NODE_SIZE, curvePoint, edgeEnds, edgePath, pairBow, type Rect, type Size } from './layout'

export interface HandoffEdgeData extends Record<string, unknown> {
  state: MessageState
  /** 가장 최근 메시지가 바뀐 시각 */
  at: number
  count: number
  /** 반대 방향 엣지가 있으면 겹치지 않게 비키는 거리 */
  shift: number
  /** 선·라벨을 누르면 — 두 에이전트 사이 메시지 창을 연다 */
  onOpen: (from: AgentId, to: AgentId, e: MouseEvent) => void
}
export type HandoffFlowEdge = Edge<HandoffEdgeData, 'handoff'>

/** 이 시간 안에 전달된 엣지는 파란 알약·진한 선 */
export const FRESH_MS = 60_000
/** 받는 쪽 고리가 퍼지는 시간(점이 엣지를 따라가는 시간은 lib/motion PACKET_MS) */
const RING_MS = 450
/** 처음 그릴 때 이보다 오래된 전달은 움직이지 않는다 */
const REPLAY_WINDOW_MS = 2_000

/** 선 모양 — on 갓 전달 · old 전달된 지 오래 · wait 내 확인 필요 · held 자동 멈춤 · queue 끝나면 전달 */
type Tone = 'on' | 'old' | 'wait' | 'held' | 'queue'
export const MARKER_TONES = ['on', 'old', 'wait', 'held'] as const
export const markerId = (tone: (typeof MARKER_TONES)[number]) => `dure-mk-${tone}`

function toneOf(state: MessageState, fresh: boolean): Tone {
  switch (state) {
    case 'delivered': return fresh ? 'on' : 'old'
    case 'held': return 'held'
    case 'queued': return 'queue'
    default: return 'wait'
  }
}

function rectOf(n: InternalNode): Rect {
  return {
    x: n.internals.positionAbsolute.x,
    y: n.internals.positionAbsolute.y,
    w: n.measured.width ?? NODE_SIZE.w,
    h: n.measured.height ?? NODE_SIZE.h,
  }
}

const easeOut = (x: number) => 1 - Math.pow(1 - x, 3)

/** 점이 선을 따라 보낸 쪽 → 받는 쪽으로(ease-out), 끝나면 받는 자리에 고리가 한 번 퍼진다 */
function playPacket(path: SVGPathElement, dot: SVGCircleElement, ring: SVGCircleElement): () => void {
  const len = path.getTotalLength()
  const t0 = performance.now()
  let raf = 0
  const frame = (t: number) => {
    const p = (t - t0) / PACKET_MS
    if (p < 1) {
      const pt = path.getPointAtLength(easeOut(Math.max(0, p)) * len)
      dot.setAttribute('cx', String(pt.x))
      dot.setAttribute('cy', String(pt.y))
      dot.style.opacity = '1'
    } else {
      dot.style.opacity = '0'
      const q = (t - t0 - PACKET_MS) / RING_MS
      if (q >= 1) {
        ring.style.opacity = '0'
        return
      }
      ring.setAttribute('r', String(4 + 10 * easeOut(q)))
      ring.style.opacity = String(0.5 * (1 - q))
    }
    raf = requestAnimationFrame(frame)
  }
  raf = requestAnimationFrame(frame)
  return () => {
    cancelAnimationFrame(raf)
    dot.style.opacity = '0'
    ring.style.opacity = '0'
  }
}

/** 넘김 엣지 — 카드 테두리끼리 부드러운 곡선 + 화살촉, 가운데 상태 알약, 전달되는 순간 점·고리 */
export const HandoffEdge = memo(function HandoffEdge({ id, source, target, data }: EdgeProps<HandoffFlowEdge>) {
  const s = useInternalNode(source)
  const t = useInternalNode(target)
  const selected = useDure(st => st.selectedAgentId)
  const deliveredAt = useDure(st => st.lastDelivered[id])
  const now = useNow()
  const pathRef = useRef<SVGPathElement>(null)
  const dotRef = useRef<SVGCircleElement>(null)
  const ringRef = useRef<SVGCircleElement>(null)
  // 알약 크기 — 그린 뒤 재서(문구마다 너비가 다르다) 반대 방향 짝이 필요한 만큼만 휘게
  const pillRef = useRef<HTMLButtonElement>(null)
  const [pill, setPill] = useState<Size>(LABEL_SIZE)
  useLayoutEffect(() => {
    const el = pillRef.current
    if (!el || !el.offsetWidth) return
    if (el.offsetWidth !== pill.w || el.offsetHeight !== pill.h) setPill({ w: el.offsetWidth, h: el.offsetHeight })
  })
  // lastDelivered 가 바뀔 때마다 한 번 — 처음 그릴 때는 전달과 함께 새로 생긴 엣지(REPLAY_WINDOW_MS 안)만
  const shot = useShot(deliveredAt, REPLAY_WINDOW_MS)

  useEffect(() => {
    const path = pathRef.current
    const dot = dotRef.current
    const ring = ringRef.current
    if (!shot || !path || !dot || !ring || typeof path.getTotalLength !== 'function') return
    return playPacket(path, dot, ring)
  }, [shot])

  if (!s || !t || !data) return null
  const from = rectOf(s)
  const to = rectOf(t)
  const ends = edgeEnds(from, to, data.shift)
  // 반대 방향 짝이면 두 선이 가운데에서 서로 바깥으로 휜다 — 알약은 늘 제 곡선 한가운데라 둘이 떨어져 각자 제 선 위에
  const bow = pairBow(ends, data.shift, from, to, pill)
  const d = edgePath(ends, bow)
  const at = curvePoint(ends, 0.5, bow)
  const view = { id, from: source, to: target, state: data.state, at: data.at, count: data.count }
  const fresh = data.state === 'delivered' && now - data.at < FRESH_MS
  const tone = toneOf(data.state, fresh)
  const marker = tone === 'queue' ? 'wait' : tone

  return (
    <>
      <path ref={pathRef} d={d} className={`he ${tone}`} markerEnd={`url(#${markerId(marker)})`} />
      {/* 누르기 쉬운 넓은 투명 선 — 누름은 RelationMap 의 onEdgeClick 이 받는다 */}
      <path d={d} className="he-hit" />
      <EdgeLabelRenderer>
        <button
          ref={pillRef}
          type="button"
          className={`el nodrag nopan${fresh ? ' on' : ''}`}
          style={{ transform: `translate(-50%, -50%) translate(${at.x}px, ${at.y}px)` }}
          aria-haspopup="dialog"
          onClick={e => data.onOpen(source, target, e)}
        >
          {label(view, now)}
        </button>
      </EdgeLabelRenderer>
      {/* 연결점·넘김 점은 카드 위에 그린다(선은 카드 아래) — 시안처럼 고리가 카드에 가리지 않게 */}
      <ViewportPortal>
        <svg className="he-top" aria-hidden="true">
          <circle className={`pt${selected === source ? ' on' : ''}`} cx={ends.source.x} cy={ends.source.y} r={3.5} />
          <circle className={`pt${selected === target ? ' on' : ''}`} cx={ends.targetPort.x} cy={ends.targetPort.y} r={3.5} />
          <g className="pkt">
            <circle ref={dotRef} className="pkt-dot" r={4.5} cx={ends.source.x} cy={ends.source.y} />
            <circle ref={ringRef} className="pkt-ring" r={4} cx={ends.targetPort.x} cy={ends.targetPort.y} />
          </g>
        </svg>
      </ViewportPortal>
    </>
  )
})
