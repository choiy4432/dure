import { useReactFlow } from '@xyflow/react'
import type { RoomId } from '../../engine/types'
import { getStore, useDure } from '../state/store'
import { nextAgent, summary, type ChipKind } from '../state/selectors'
import { moveMs } from '../lib/motion'
import { STATUS_WORD } from '../lib/words'

const CHIPS: { kind: ChipKind; label: string; dot: string }[] = [
  { kind: 'working', label: STATUS_WORD.working, dot: 'g' },
  { kind: 'awaiting', label: STATUS_WORD.awaiting, dot: 'a' },
  { kind: 'unread', label: '받은 메시지', dot: 'r' },
  { kind: 'fresh', label: '새 결과', dot: 'n' },
]

/** 관계도 왼쪽 위 — 작업 중 · 내 승인 필요 · 받은 메시지 · 새 결과 수. 누를 때마다 그 상태의 다음 에이전트로(돌아가며) */
export function SummaryChips({ roomId }: { roomId: RoomId }) {
  const sum = useDure(s => summary(s, roomId))
  const flow = useReactFlow()

  const go = (kind: ChipKind) => {
    const store = getStore()
    // 지금 고른 에이전트 다음부터 — 같은 칩을 거듭 누르면 그 상태의 에이전트를 한 바퀴 돈다(첫 번째에 갇히지 않게)
    const st = store.getState()
    const id = nextAgent(kind, st, roomId, st.selectedAgentId)
    if (!id) return
    store.selectAgent(id)
    void flow.fitView({ nodes: [{ id }], maxZoom: 1, padding: 0.4, duration: moveMs(300) })
  }

  return (
    <div className="sum" role="group" aria-label="요약">
      {CHIPS.map(c => (
        // 0 이면 누를 것도 없다 — 점·수를 흐리게 해 뒤로 물린다(0 이 아닌 칩만 눈에 띈다)
        <button
          key={c.kind}
          type="button"
          className={sum[c.kind] === 0 ? 'zero' : undefined}
          disabled={sum[c.kind] === 0}
          onClick={() => go(c.kind)}
        >
          <i className={`dot ${c.dot}`} aria-hidden="true" />
          {c.label} <b>{sum[c.kind]}</b>
        </button>
      ))}
    </div>
  )
}
