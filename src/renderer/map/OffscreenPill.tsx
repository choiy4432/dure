import { useEffect, useMemo, useState, type RefObject } from 'react'
import { useReactFlow, useStore } from '@xyflow/react'
import type { RoomId } from '../../engine/types'
import { getStore, useDure } from '../state/store'
import { moveMs } from '../lib/motion'
import type { AgentFlowNode } from './AgentNode'
import { NODE_SIZE } from './layout'
import { offscreen, type OffTarget, type Side } from './offscreen'

const SIDE_WORD: Record<Side, string> = { left: '왼쪽', right: '오른쪽', top: '위', bottom: '아래' }

/** 화면 밖에 할 일 카드(승인·질문·받은 메시지)가 있으면 그 쪽 가장자리에 알약 하나 — 누르면 가장 가까운 카드로 */
export function OffscreenPill({ roomId, nodes, wrap }: {
  roomId: RoomId
  nodes: AgentFlowNode[]
  wrap: RefObject<HTMLDivElement | null>
}) {
  const flow = useReactFlow()
  const transform = useStore(s => s.transform)
  const agents = useDure(s => s.agents)
  const requests = useDure(s => s.requests)
  const messages = useDure(s => s.messages)

  // 관계도 칸 크기 — 창·경계선을 끌면 바뀐다. jsdom 처럼 크기가 0 이면 아래에서 알약을 그리지 않는다
  const [size, setSize] = useState({ width: 0, height: 0 })
  useEffect(() => {
    const el = wrap.current
    if (!el) return
    const read = () => setSize(p => (p.width === el.clientWidth && p.height === el.clientHeight
      ? p : { width: el.clientWidth, height: el.clientHeight }))
    read()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(read)
    ro.observe(el)
    return () => ro.disconnect()
  }, [wrap])

  const targets = useMemo(() => {
    const inRoom = new Set(agents.filter(a => a.roomId === roomId).map(a => a.id))
    const asks = new Set(requests.filter(r => inRoom.has(r.agentId)).map(r => r.agentId))
    // '새 결과' 만 있는 카드는 넣지 않는다 — 급하지 않은 것까지 알리면 알약이 늘 떠 있게 된다
    const mail = new Set(messages
      .filter(m => m.roomId === roomId && (m.state === 'pending' || m.state === 'held') && inRoom.has(m.to))
      .map(m => m.to))
    const out: OffTarget[] = []
    for (const n of nodes) {
      const ask = asks.has(n.id)
      if (!ask && !mail.has(n.id)) continue
      out.push({
        id: n.id, x: n.position.x, y: n.position.y,
        w: n.measured?.width ?? NODE_SIZE.w, h: n.measured?.height ?? NODE_SIZE.h, ask,
      })
    }
    return out
  }, [agents, requests, messages, nodes, roomId])

  if (size.width === 0 || size.height === 0) return null
  const hit = offscreen(targets, { x: transform[0], y: transform[1], zoom: transform[2], ...size })
  if (!hit) return null

  const go = () => {
    getStore().selectAgent(hit.first)
    void flow.fitView({ nodes: [{ id: hit.first }], maxZoom: 1, padding: 0.4, duration: moveMs(300) })
  }
  return (
    <button type="button" className={`op ${hit.side}`} onClick={go}>
      <i className={`dot ${hit.ask ? 'a' : 'r'}`} aria-hidden="true" />
      {SIDE_WORD[hit.side]}에 할 일 {hit.count}
    </button>
  )
}
