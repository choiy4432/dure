import { useReactFlow, useStore } from '@xyflow/react'
import { LayoutGrid, Maximize, Minus, Plus } from 'lucide-react'
import { moveMs } from '../lib/motion'
import { FIT_PAD_X } from './layout'

/**
 * 처음 그릴 때와 '모두 보기' 에 쓰는 맞춤 — 카드가 적어도 100% 보다 크게 키우지 않는다.
 * 위·아래 여백은 요약 칩(위)·확대 조절(아래)에 카드가 가리지 않을 만큼.
 */
export const FIT_OPTIONS = { maxZoom: 1, padding: { top: '72px', bottom: '64px', x: `${FIT_PAD_X}px` } } as const

const EPS = 0.001

/**
 * 관계도 왼쪽 아래 — 축소 · 배율 · 확대 · 모두 보기 · 자리 정리
 * +/- 는 d3 전환이라 이벤트가 null 이어서 RelationMap 의 onMoveStart/End 가 사용자 조작으로 못 잡는다 —
 * 그래서 onUserZoom 으로 직접 알려, 이후 창 크기가 바뀌어도 85% 맞춤으로 되돌아가지 않게 한다.
 */
export function ZoomControls({ onArrange, onFitAll, onUserZoom }: { onArrange: () => void; onFitAll: () => void; onUserZoom: () => void }) {
  const zoom = useStore(s => s.transform[2])
  const min = useStore(s => s.minZoom)
  const max = useStore(s => s.maxZoom)
  const flow = useReactFlow()
  const duration = () => moveMs(200)

  return (
    <div className="zc" role="group" aria-label="확대 조절">
      <button type="button" className="ib" aria-label="축소" title="축소" disabled={zoom <= min + EPS} onClick={() => { void flow.zoomOut({ duration: duration() }); onUserZoom() }}>
        <Minus className="i" />
      </button>
      <span className="zc-v">{Math.round(zoom * 100)}%</span>
      <button type="button" className="ib" aria-label="확대" title="확대" disabled={zoom >= max - EPS} onClick={() => { void flow.zoomIn({ duration: duration() }); onUserZoom() }}>
        <Plus className="i" />
      </button>
      <span className="vr" aria-hidden="true" />
      <button type="button" className="ib" aria-label="모두 보기" title="모두 보기" onClick={() => { void flow.fitView({ ...FIT_OPTIONS, duration: duration() }); onFitAll() }}>
        <Maximize className="i" />
      </button>
      <button type="button" className="ib" aria-label="자리 정리" title="자리 정리" onClick={onArrange}>
        <LayoutGrid className="i" />
      </button>
    </div>
  )
}
