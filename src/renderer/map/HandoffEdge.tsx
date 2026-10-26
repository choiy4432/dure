import { memo, useEffect, useRef, type MouseEvent } from 'react'
import {
  EdgeLabelRenderer, ViewportPortal, useInternalNode,
  type Edge, type EdgeProps, type InternalNode,
} from '@xyflow/react'
import type { AgentId, MessageState } from '../../engine/types'
import { useDure } from '../state/store'
import { label, type EdgeAge } from '../state/selectors'
import { useNow } from '../lib/useNow'
import { PACKET_MS, useShot } from '../lib/motion'
import { NODE_SIZE, curvePoint, edgeEnds, edgePath, type Rect } from './layout'

/** 쌍마다 한 줄(source = 정렬한 앞 a, target = 뒤 b) — 화살촉은 오간 방향(ab · ba)에만 */
export interface HandoffEdgeData extends Record<string, unknown> {
  /** 대표 메시지(할 일 → 최근 전달)의 상태·방향·바뀐 시각 — 알약과 선 모양 */
  state: MessageState
  from: AgentId
  to: AgentId
  at: number
  count: number
  ab: boolean
  ba: boolean
  age: EdgeAge
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

/** 점이 선을 따라 보낸 쪽 → 받는 쪽으로(ease-out — back 이면 선의 끝에서 처음으로), 끝나면 받는 자리에 고리가 한 번 퍼진다 */
function playPacket(path: SVGPathElement, dot: SVGCircleElement, ring: SVGCircleElement, back: boolean): () => void {
  const len = path.getTotalLength()
  const t0 = performance.now()
  let raf = 0
  const frame = (t: number) => {
    const p = (t - t0) / PACKET_MS
    if (p < 1) {
      const d = easeOut(Math.max(0, p)) * len
      const pt = path.getPointAtLength(back ? len - d : d)
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

/**
 * 넘김 엣지 — 쌍마다 카드 테두리끼리 부드러운 곡선 한 줄 + 오간 방향에 화살촉, 가운데 상태 알약, 전달되는 순간 점·고리(보낸 쪽 → 받는 쪽).
 * 나이(age): 30분이 지난 전달은 알약 없이 옅게(faint). 다른 에이전트를 골랐으면 그 에이전트에 닿지 않은 선은 흐리게(dim) —
 * 알약은 할 일이 있을 때만 남는다(놓치면 안 되는 것).
 */
export const HandoffEdge = memo(function HandoffEdge({ source, target, data }: EdgeProps<HandoffFlowEdge>) {
  const s = useInternalNode(source)
  const t = useInternalNode(target)
  const selected = useDure(st => st.selectedAgentId)
  // 전달은 방향마다 기록된다 — 더 늦은 쪽이 이번 점의 방향
  const abAt = useDure(st => st.lastDelivered[`${source}>${target}`])
  const baAt = useDure(st => st.lastDelivered[`${target}>${source}`])
  const back = (baAt ?? 0) > (abAt ?? 0)
  const deliveredAt = back ? baAt : abAt
  const now = useNow()
  const pathRef = useRef<SVGPathElement>(null)
  const dotRef = useRef<SVGCircleElement>(null)
  const ringRef = useRef<SVGCircleElement>(null)
  // 전달될 때마다 한 번 — 처음 그릴 때는 전달과 함께 새로 생긴 엣지(REPLAY_WINDOW_MS 안)만
  const shot = useShot(deliveredAt, REPLAY_WINDOW_MS)
  const backRef = useRef(back)
  backRef.current = back

  useEffect(() => {
    const path = pathRef.current
    const dot = dotRef.current
    const ring = ringRef.current
    if (!shot || !path || !dot || !ring || typeof path.getTotalLength !== 'function') return
    return playPacket(path, dot, ring, backRef.current)
  }, [shot])

  if (!s || !t || !data) return null
  const from = rectOf(s)
  const to = rectOf(t)
  const ends = edgeEnds(from, to, 0, data.ba)
  const d = edgePath(ends)
  const at = curvePoint(ends, 0.5)
  const view = { state: data.state, at: data.at }
  const fresh = data.state === 'delivered' && now - data.at < FRESH_MS
  const tone = toneOf(data.state, fresh)
  const marker = markerId(tone === 'queue' ? 'wait' : tone)
  const faint = data.age === 'old'
  const dim = selected !== null && selected !== source && selected !== target
  const pill = !faint && (!dim || data.age === 'live')

  return (
    <>
      <path
        ref={pathRef}
        d={d}
        className={`he ${tone}${faint ? ' faint' : ''}${dim ? ' dim' : ''}`}
        markerEnd={data.ab ? `url(#${marker})` : undefined}
        markerStart={data.ba ? `url(#${marker})` : undefined}
      />
      {/* 누르기 쉬운 넓은 투명 선 — 누름은 RelationMap 의 onEdgeClick 이 받는다 */}
      <path d={d} className="he-hit" />
      {pill && (
        <EdgeLabelRenderer>
          <button
            type="button"
            className={`el nodrag nopan${fresh ? ' on' : ''}`}
            style={{ transform: `translate(-50%, -50%) translate(${at.x}px, ${at.y}px)` }}
            aria-haspopup="dialog"
            onClick={e => data.onOpen(data.from, data.to, e)}
          >
            {label(view, now)}
          </button>
        </EdgeLabelRenderer>
      )}
      {/* 연결점·넘김 점은 카드 위에 그린다(선은 카드 아래) — 시안처럼 고리가 카드에 가리지 않게 */}
      <ViewportPortal>
        <svg className={`he-top${dim ? ' dim' : ''}${faint ? ' faint' : ''}`} aria-hidden="true">
          <circle className={`pt${selected === source ? ' on' : ''}`} cx={ends.sourcePort.x} cy={ends.sourcePort.y} r={3.5} />
          <circle className={`pt${selected === target ? ' on' : ''}`} cx={ends.targetPort.x} cy={ends.targetPort.y} r={3.5} />
          <g className="pkt">
            <circle ref={dotRef} className="pkt-dot" r={4.5} cx={(back ? ends.targetPort : ends.sourcePort).x} cy={(back ? ends.targetPort : ends.sourcePort).y} />
            <circle ref={ringRef} className="pkt-ring" r={4} cx={(back ? ends.sourcePort : ends.targetPort).x} cy={(back ? ends.sourcePort : ends.targetPort).y} />
          </g>
        </svg>
      </ViewportPortal>
    </>
  )
})
