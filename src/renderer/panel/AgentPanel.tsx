import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import type { AgentId, RelayMessage } from '../../engine/types'
import { useDure } from '../state/store'
import { errorMessage } from '../lib/words'
import { useNow } from '../lib/useNow'
import { PanelHeader } from './PanelHeader'
import type { Described } from './ModelPicker'
import { MessageCard, type ShownState } from './cards/MessageCard'
import { PermissionCard } from './cards/PermissionCard'
import { QuestionCard } from './cards/QuestionCard'
import { HeldChainCard } from './cards/HeldChainCard'

const IDLE: Described = { state: 'idle' }
/** 최근 전달된 메시지 카드는 5분이 지나면 접힌 채로 보인다 */
const FOLD_AFTER = 5 * 60_000

type Shown = RelayMessage & { state: ShownState }
const isWaiting = (m: RelayMessage): m is Shown => m.state === 'pending' || m.state === 'queued'
const byCreated = (a: { createdAt: number }, b: { createdAt: number }) => a.createdAt - b.createdAt

/** 고정 카드 자리가 넘쳐 스크롤되는지 — 그럴 때만 아래 경계선을 그어 잘린 카드가 대화와 섞이지 않게 */
function useOverflows(ref: RefObject<HTMLElement | null>): boolean {
  const [over, setOver] = useState(false)
  // 그릴 때마다 다시 잰다 — 카드가 바뀌거나(자세히 펼침 등) 창 크기가 바뀌어도
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const check = () => setOver(el.scrollHeight > el.clientHeight + 1)
    check()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(check)
    ro.observe(el)
    for (const child of Array.from(el.children)) ro.observe(child)
    return () => ro.disconnect()
  })
  return over
}

/**
 * 고정 카드 — 권한·질문(먼저 온 것부터) → 받은 메시지(오래된 순) → 자동 상한(방에 한 장) → 최근 전달된 메시지 1장.
 * 카드가 없으면 자리도 없다(.pnl-pins:empty).
 */
function Pins({ agentId, open, onOpenChange }: {
  agentId: AgentId
  open: Record<string, boolean>
  onOpenChange: (messageId: string, open: boolean) => void
}) {
  // 바뀌지 않으면 같은 배열 — 흐르는 글(text-delta)마다 다시 그리지 않는다
  const v = useDure(s => ({ agents: s.agents, messages: s.messages, requests: s.requests, limit: s.autoChainLimit }))
  const now = useNow()
  const box = useRef<HTMLDivElement>(null)
  const over = useOverflows(box)
  const agent = v.agents.find(a => a.id === agentId)
  if (!agent) return <div className="pnl-pins" />

  const nameOf = (id: AgentId) => v.agents.find(a => a.id === id)?.name ?? '지운 에이전트'
  const requests = v.requests.filter(r => r.agentId === agentId).sort(byCreated)
  const inbox = v.messages.filter(m => m.to === agentId && isWaiting(m)).sort(byCreated) as Shown[]
  const held = v.messages.some(m => m.roomId === agent.roomId && m.state === 'held')
  let delivered: Shown | null = null
  for (const m of v.messages) {
    if (m.to !== agentId || m.state !== 'delivered') continue
    if (!delivered || m.updatedAt > delivered.updatedAt) delivered = m as Shown
  }

  // 접힘은 사람이 정한 게 먼저('나중에'·머리 누르기) — 아니면 기다리는 건 펼침, 전달된 건 5분 동안만 펼침
  const isOpen = (m: Shown) => open[m.id] ?? (m.state !== 'delivered' || now - m.updatedAt < FOLD_AFTER)
  const card = (m: Shown) => (
    <MessageCard
      key={m.id}
      message={m}
      fromName={nameOf(m.from)}
      toName={agent.name}
      now={now}
      open={isOpen(m)}
      onOpenChange={o => onOpenChange(m.id, o)}
    />
  )

  return (
    <div ref={box} className={`pnl-pins${over ? ' more' : ''}`}>
      {requests.map(r =>
        r.kind === 'question' ? (
          <QuestionCard key={r.id} request={r} now={now} />
        ) : (
          <PermissionCard key={r.id} request={r} agent={agent} now={now} />
        ),
      )}
      {inbox.map(card)}
      {held && <HeldChainCard roomId={agent.roomId} limit={v.limit} />}
      {delivered && card(delivered)}
    </div>
  )
}

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

  // 메시지 카드를 펼치고 접은 것('나중에' 포함) — 메시지 id 로, 이번 실행 동안만(다른 에이전트로 갔다 와도 그대로)
  const [cardOpen, setCardOpen] = useState<Record<string, boolean>>({})
  const setOpen = useCallback((messageId: string, open: boolean) => {
    setCardOpen(c => ({ ...c, [messageId]: open }))
  }, [])

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
      <Pins agentId={sel.id} open={cardOpen} onOpenChange={setOpen} />
      {/* 대화 목록 */}
      <div className="pnl-chat" />
      {/* 입력창 */}
    </aside>
  )
}
