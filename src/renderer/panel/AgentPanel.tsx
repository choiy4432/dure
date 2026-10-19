import { useCallback, useRef, useState } from 'react'
import type { AgentId } from '../../engine/types'
import { useDure } from '../state/store'
import { errorMessage } from '../lib/words'
import { PanelHeader } from './PanelHeader'
import type { Described } from './ModelPicker'

const IDLE: Described = { state: 'idle' }

/**
 * 오른쪽 패널 — 고른 에이전트 하나.
 * 위에서부터: 머리(PanelHeader) → 고정 카드 자리(.pnl-pins) → 대화 자리(.pnl-chat) → 입력창.
 * 카드·대화·입력창은 이 틀 안에 자식으로 더한다.
 */
export function AgentPanel() {
  const sel = useDure(s => {
    const a = s.agents.find(x => x.id === s.selectedAgentId)
    return a ? { id: a.id, name: a.name } : null
  })
  const id = sel?.id ?? null

  // describe 는 claude 를 켠다 — 고르기만으론 부르지 않고, 모델 목록(나중엔 / 명령 목록)을 열 때 에이전트마다 한 번.
  // 받은 것은 에이전트별로 둔다(다른 에이전트로 갔다 와도 다시 안 받는다)
  const [described, setDescribed] = useState<Record<AgentId, Described>>({})
  const asked = useRef(new Set<AgentId>())
  const describe = useCallback((agentId: AgentId) => {
    asked.current.add(agentId)
    setDescribed(d => ({ ...d, [agentId]: { state: 'loading' } }))
    Promise.resolve()
      .then(() => window.dure.describe(agentId))
      .then(
        value => setDescribed(d => ({ ...d, [agentId]: { state: 'ready', value } })),
        e => setDescribed(d => ({ ...d, [agentId]: { state: 'error', error: errorMessage(e) } })),
      )
  }, [])
  const ensureDescribed = useCallback(() => {
    if (id && !asked.current.has(id)) describe(id)
  }, [id, describe])
  const retryDescribe = useCallback(() => {
    if (id) describe(id)
  }, [id, describe])

  // 모델 목록 — 머리의 칩이나 입력창의 /model 이 연다
  const [modelOpenFor, setModelOpenFor] = useState<AgentId | null>(null)

  if (!sel) {
    return (
      <aside className="pnl" aria-label="에이전트">
        <p className="pnl-hint">관계도에서 에이전트를 골라 보세요</p>
      </aside>
    )
  }

  return (
    <aside className="pnl" aria-label={sel.name}>
      <PanelHeader
        key={sel.id}
        agentId={sel.id}
        description={described[sel.id] ?? IDLE}
        onLoadDescription={ensureDescribed}
        onRetryDescribe={retryDescribe}
        modelOpen={modelOpenFor === sel.id}
        onModelOpenChange={open => setModelOpenFor(open ? sel.id : null)}
      />
      {/* 고정 카드 — 권한·질문 → 받은 메시지 → 자동 상한 → 최근 전달 */}
      <div className="pnl-pins" />
      {/* 대화 목록 */}
      <div className="pnl-chat" />
      {/* 입력창 */}
    </aside>
  )
}
