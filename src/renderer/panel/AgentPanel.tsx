import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react'
import type { AgentId, HistoryItem, RelayMessage } from '../../engine/types'
import { getStore, useDure } from '../state/store'
import { latestDelivered } from '../state/selectors'
import { buildSubagentTree } from '../state/subagents'
import { errorMessage } from '../lib/words'
import { useNow } from '../lib/useNow'
import { PanelHeader } from './PanelHeader'
import type { Described } from './ModelPicker'
import { MessageCard, pinOpen, type ShownState } from './cards/MessageCard'
import { PermissionCard } from './cards/PermissionCard'
import { CreateAgentCard } from './cards/CreateAgentCard'
import { QuestionCard } from './cards/QuestionCard'
import { HeldChainCard } from './cards/HeldChainCard'
import { PresenceList } from '../lib/presence'
import { ChatList } from './ChatList'
import { Composer } from './Composer'
import { PanelTabs, ViewShown, panelId, tabId } from './PanelTabs'
import { SubagentMap } from './SubagentMap'
import { Inbox } from './Inbox'

const IDLE: Described = { state: 'idle' }

type Shown = RelayMessage & { state: ShownState }
const isWaiting = (m: RelayMessage): m is Shown => m.state === 'pending' || m.state === 'queued'
const byCreated = (a: { createdAt: number }, b: { createdAt: number }) => a.createdAt - b.createdAt

const px = (v: string) => parseFloat(v) || 0

/**
 * 카드들이 배치에서 차지하는 높이(안쪽 여백 포함)가 칸보다 큰가 — transform 은 세지 않는다(offset* 은 transform 을 모른다).
 * scrollHeight 는 들어오는 카드가 아래로 비켜 선 자리(translateY)까지 넘침으로 센다. 그 몇 px 은 .more 의 아래 여백이 덮어,
 * scrollHeight 로 재면 넘침 → .more → 안 넘침 → .more 없음 → 넘침 … 이 한 그리기 안에서 끝없이 돈다(React #185).
 */
function overflows(el: HTMLElement): boolean {
  const first = el.firstElementChild
  const last = el.lastElementChild
  if (!(first instanceof HTMLElement) || !(last instanceof HTMLElement)) return false // 카드가 없다(자리도 없다)
  const cs = getComputedStyle(el)
  // 첫 카드의 바깥 여백 위 ~ 마지막 카드의 바깥 여백 아래 — 두 카드의 offsetTop 기준이 같아 스크롤 자리와 상관없다
  const top = first.offsetTop - px(getComputedStyle(first).marginTop)
  const bottom = last.offsetTop + last.offsetHeight + px(getComputedStyle(last).marginBottom)
  return bottom - top + px(cs.paddingTop) + px(cs.paddingBottom) > el.clientHeight + 1
}

/** 고정 카드 자리가 넘쳐 스크롤되는지 — 그럴 때만 아래 경계선을 그어 잘린 카드가 대화와 섞이지 않게 */
function useOverflows(ref: RefObject<HTMLElement | null>): boolean {
  const [over, setOver] = useState(false)
  // 그릴 때마다 다시 잰다 — 카드가 바뀌거나(자세히 펼침 등) 창 크기가 바뀌어도
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const check = () => setOver(overflows(el))
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
 * 고정 카드 — 권한·질문·새 에이전트 만들기(먼저 온 것부터) → 받은 메시지(오래된 순) → 자동 상한(방에 한 장) → 최근 전달된 메시지 1장.
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

  const nameOf = (id: AgentId) => v.agents.find(a => a.id === id)?.name ?? '지워진 에이전트'
  const requests = v.requests.filter(r => r.agentId === agentId).sort(byCreated)
  const inbox = v.messages.filter(m => m.to === agentId && isWaiting(m)).sort(byCreated) as Shown[]
  const held = v.messages.some(m => m.roomId === agent.roomId && m.state === 'held')
  const delivered = latestDelivered(agentId, v.messages) as Shown | null

  const card = (m: Shown) => (
    <MessageCard
      key={m.id}
      message={m}
      fromName={nameOf(m.from)}
      toName={agent.name}
      now={now}
      open={pinOpen(m, open, now)}
      onOpenChange={o => onOpenChange(m.id, o)}
    />
  )

  return (
    <div ref={box} className={`pnl-pins${over ? ' more' : ''}`}>
      <PresenceList key={agentId}>
        {requests.map(r =>
          r.kind === 'question' ? (
            <QuestionCard key={r.id} request={r} now={now} />
          ) : r.kind === 'create-agent' ? (
            <CreateAgentCard key={r.id} request={r} agent={agent} now={now} />
          ) : (
            <PermissionCard key={r.id} request={r} agent={agent} now={now} />
          ),
        )}
        {inbox.map(card)}
        {held && <HeldChainCard key="held" roomId={agent.roomId} limit={v.limit} />}
        {delivered && card(delivered)}
      </PresenceList>
    </div>
  )
}

const NO_ITEMS: HistoryItem[] = []
const NO_IDS: string[] = []

/**
 * 머리 아래 — [대화 | 서브에이전트 N] 탭(지금 대화에 서브에이전트가 하나라도 있었을 때만) → 고정 카드 → 대화 목록 또는 서브에이전트 지도 → 입력창.
 * pins·chat·composer 는 AgentPanel 이 만든 요소 그대로 받는다 — 기록이 늘어 이 칸이 다시 그려져도 셋은 다시 그리지 않는다(제 구독으로 그린다).
 * 입력창은 대화 탭에만 보인다 — 서브에이전트 탭에선 숨겨 두기만 해서(hidden) 쓰던 글·붙인 이미지가 그대로 남는다.
 * 대화 칸은 탭이 생기고 사라져도 같은 요소라 대화 목록이 다시 붙지 않는다. 탭이 있으면 두 칸을 함께 그려 두고 고르지 않은 칸은 숨긴다(hidden) —
 * 탭을 오가도 대화 목록의 스크롤 자리·펼친 줄·불러온 이전 대화, 지도의 펼친 노드가 그대로다.
 */
function PanelBody({ agentId, name, pins, chat, composer, seen }: {
  agentId: AgentId
  name: string
  pins: ReactNode
  chat: ReactNode
  composer: ReactNode
  /** 지도가 이미 간 focus 의 n — 패널이 들고 있어 지도가 다시 열려도 지난 focus 로 다시 가지 않는다 */
  seen: RefObject<number>
}) {
  const v = useDure(s => {
    const f = s.subagentFocus
    return {
      items: s.history[agentId] ?? NO_ITEMS,
      ready: s.historyStatus[agentId]?.state === 'ready',
      running: s.agents.find(a => a.id === agentId)?.subagentsRunning ?? NO_IDS,
      tab: s.panelTab[agentId] ?? 'chat',
      focus: f && f.agentId === agentId ? f : null,
    }
  })
  // 지금 대화(마지막 새 대화 경계 뒤)의 나무 — 탭 숫자(안쪽 포함)와 지도가 같은 것을 쓴다
  const tree = useMemo(() => buildSubagentTree(v.items, new Set(v.running)), [v.items, v.running])
  const tabs = tree.total > 0
  const tab = tabs ? v.tab : 'chat'
  const base = useId()

  // 새 대화로 서브에이전트가 0 이 되면 대화 탭으로 — 다음에 서브에이전트가 생겨도 대화를 보던 그대로
  useEffect(() => {
    if (!tabs && v.ready && v.tab === 'subagents') getStore().setPanelTab(agentId, 'chat')
  }, [tabs, v.ready, v.tab, agentId])

  return (
    <>
      {tabs && (
        <PanelTabs
          tab={tab}
          total={tree.total}
          running={tree.running > 0 || v.running.length > 0}
          base={base}
          onChange={t => getStore().setPanelTab(agentId, t)}
        />
      )}
      {pins}
      <div
        className="pnl-view"
        hidden={tab !== 'chat'}
        {...(tabs ? { role: 'tabpanel', id: panelId(base, 'chat'), 'aria-labelledby': tabId(base, 'chat') } : {})}
      >
        <ViewShown value={tab === 'chat'}>{chat}</ViewShown>
      </div>
      {tabs && (
        <div
          className="pnl-view"
          hidden={tab !== 'subagents'}
          role="tabpanel"
          id={panelId(base, 'subagents')}
          aria-labelledby={tabId(base, 'subagents')}
        >
          <SubagentMap key={agentId} name={name} turns={tree.turns} focus={v.focus} seen={seen} active={tab === 'subagents'} />
        </div>
      )}
      <div className="pnl-cmp" hidden={tab !== 'chat'}>
        {composer}
      </div>
    </>
  )
}

/**
 * 오른쪽 패널 — 고른 에이전트 하나.
 * 위에서부터: 머리(PanelHeader) → 탭(서브에이전트가 있을 때) → 고정 카드 자리(.pnl-pins) → 대화 목록(ChatList) 또는 서브에이전트 지도 → 입력창(Composer, 대화 탭에만).
 */
export function AgentPanel() {
  const sel = useDure(s => {
    const a = s.agents.find(x => x.id === s.selectedAgentId)
    return a ? { id: a.id, name: a.name } : null
  })
  const id = sel?.id ?? null

  // describe 는 claude 를 켠다 — 고르기만으론 부르지 않고, 모델 목록이나 / 명령 목록을 처음 열 때 에이전트마다 한 번.
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

  // 내가 보낼 때마다 오르는 수(보낸 에이전트와 함께) — 대화 목록이 맨 아래로 붙어 내 말이 보이게(입력창은 대화 탭에만 있다)
  const [sent, setSent] = useState<{ agentId: AgentId | null; n: number }>({ agentId: null, n: 0 })
  const onSent = useCallback((agentId: AgentId) => setSent(s => ({ agentId, n: s.n + 1 })), [])

  // 서브에이전트 지도가 이미 간 focus 의 n(store.showSubagents 가 올린다)
  const seenFocus = useRef(0)

  if (!sel) {
    return (
      <aside className="pnl" aria-label="에이전트">
        <Inbox />
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
      <PanelBody
        agentId={sel.id}
        name={sel.name}
        seen={seenFocus}
        pins={<Pins agentId={sel.id} open={cardOpen} onOpenChange={setOpen} />}
        chat={<ChatList key={`c-${sel.id}`} agentId={sel.id} pin={sent.agentId === sel.id ? sent.n : 0} cardOpen={cardOpen} />}
        composer={
          <Composer
            key={`i-${sel.id}`}
            agentId={sel.id}
            name={sel.name}
            description={described[sel.id] ?? IDLE}
            onLoadCommands={ensureDescribed}
            onRetryCommands={retryDescribe}
            onOpenModel={() => setModelOpenFor(sel.id)}
            onSent={onSent}
          />
        }
      />
    </aside>
  )
}
