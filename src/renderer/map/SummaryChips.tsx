import { useReactFlow } from '@xyflow/react'
import type { AgentId, RoomId } from '../../engine/types'
import { getStore, useDure, type UiState } from '../state/store'
import { displayStatus, summary, unreadFor } from '../state/selectors'
import { moveMs } from '../lib/motion'

type Kind = 'working' | 'awaiting' | 'unread'

const CHIPS: { kind: Kind; label: string; dot: string }[] = [
  { kind: 'working', label: '작업 중', dot: 'g' },
  { kind: 'awaiting', label: '승인 기다림', dot: 'a' },
  { kind: 'unread', label: '받은 메시지', dot: 'r' },
]

/** 그 상태의 첫 에이전트(방 안 순서대로) */
function firstAgent(kind: Kind, s: UiState, roomId: RoomId): AgentId | null {
  const hit = s.agents.find(a => {
    if (a.roomId !== roomId) return false
    if (kind === 'unread') return unreadFor(a.id, s.messages) > 0
    return displayStatus(a, s.requests) === kind
  })
  return hit?.id ?? null
}

/** 관계도 왼쪽 위 — 작업 중 · 승인 기다림 · 받은 메시지 수. 누르면 그 상태의 첫 에이전트로 */
export function SummaryChips({ roomId }: { roomId: RoomId }) {
  const sum = useDure(s => summary(s, roomId))
  const flow = useReactFlow()

  const go = (kind: Kind) => {
    const store = getStore()
    const id = firstAgent(kind, store.getState(), roomId)
    if (!id) return
    store.selectAgent(id)
    void flow.fitView({ nodes: [{ id }], maxZoom: 1, padding: 0.4, duration: moveMs(300) })
  }

  return (
    <div className="sum" role="group" aria-label="요약">
      {CHIPS.map(c => (
        <button key={c.kind} type="button" disabled={sum[c.kind] === 0} onClick={() => go(c.kind)}>
          <i className={`dot ${c.dot}`} aria-hidden="true" />
          {c.label} <b>{sum[c.kind]}</b>
        </button>
      ))}
    </div>
  )
}
