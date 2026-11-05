import { useEffect, useMemo, useState, type RefObject } from 'react'
import { useReactFlow, useStore } from '@xyflow/react'
import type { RoomId } from '../../engine/types'
import { getStore, useDure } from '../state/store'
import { moveMs } from '../lib/motion'
import type { AgentFlowNode } from './AgentNode'
import { offscreen, todoTargets, type Side } from './offscreen'

const SIDE_WORD: Record<Side, string> = { left: '왼쪽', right: '오른쪽', top: '위', bottom: '아래' }

/**
 * 화면 밖에 할 일 카드(승인·질문·받은 메시지)가 있으면 그 쪽 가장자리에 알약 하나 — 누르면 가장 가까운 카드로.
 * select — 그 카드를 고르기도 한다(PC: 오른쪽 패널에 열림). 휴대폰은 고르면 대화가 판을 덮어서 옮겨 가기만(false)
 */
export function OffscreenPill({ roomId, nodes, wrap, select = true }: {
  roomId: RoomId
  nodes: AgentFlowNode[]
  wrap: RefObject<HTMLDivElement | null>
  select?: boolean
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

  const targets = useMemo(
    () => todoTargets(agents, requests, messages, nodes, roomId),
    [agents, requests, messages, nodes, roomId],
  )

  if (size.width === 0 || size.height === 0) return null
  const hit = offscreen(targets, { x: transform[0], y: transform[1], zoom: transform[2], ...size })
  if (!hit) return null

  const go = () => {
    if (select) getStore().selectAgent(hit.first)
    void flow.fitView({ nodes: [{ id: hit.first }], maxZoom: 1, padding: 0.4, duration: moveMs(300) })
  }
  // 휴대폰(고르지 않음) — 판을 끌어 찾기 전에 누구인지 알게 가장 가까운 에이전트 이름을 붙인다
  const who = select ? null : (agents.find(a => a.id === hit.first)?.name ?? null)
  return (
    <button type="button" className={`op ${hit.side}`} onClick={go}>
      <i className={`dot ${hit.ask ? 'a' : 'r'}`} aria-hidden="true" />
      {who ? `${SIDE_WORD[hit.side]}에 할 일 · ${who}${hit.count > 1 ? ` 외 ${hit.count - 1}` : ''}` : `${SIDE_WORD[hit.side]}에 할 일 ${hit.count}`}
    </button>
  )
}
