import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { AgentId, HistoryItem } from '../../engine/types'
import { getStore, useDure } from '../state/store'
import { buildTranscript } from '../state/transcript'
import { displayStatus, latestDelivered } from '../state/selectors'
import { useNow } from '../lib/useNow'
import { ChatItem } from './ChatItem'
import { pinOpen } from './cards/MessageCard'
import { WorkingRow } from './WorkingRow'
import { enteringLines, type LineSnap } from './newLines'
import { Presence, playEnter } from '../lib/presence'
import { MOTION, reducedMotion } from '../lib/motion'

/** 처음에 그리는 줄 수 · '더 보기' 한 번에 늘리는 수 */
const PAGE = 300
/** 바닥에서 이만큼 안이면 '맨 아래에 붙어 있다' */
const STICK_PX = 24
const NONE: HistoryItem[] = []
const NO_IDS: string[] = []
const NO_CHOICE: Record<string, boolean> = {}

/**
 * 대화 목록(시안 .conv) — 고른 에이전트의 기록을 buildTranscript 로 줄로 바꿔 그린다.
 * 최근 300줄만 그리고 위에 '이전 대화 N개 더 보기'. 새 줄이 오면 맨 아래에 붙어 있을 때만 따라 내려간다.
 * pin 이 오르면(내가 보냄) 위로 올려 읽던 중이어도 맨 아래에 다시 붙는다.
 * 위 고정 카드에 펼쳐 보이는 '최근 전달된 메시지'와 같은 줄은 한 줄로 접는다(cardOpen = 패널이 들고 있는 카드 펼침).
 * 에이전트가 일하는 동안(표시 상태 '작업 중' — 승인 기다림은 승인 카드가 알린다) 맨 끝에 '작업 중…' 줄.
 * 서브에이전트가 돌면 부모 차례가 끝나도 작업 중이다(엔진) — 그 줄에 도는 수를 함께 적는다.
 */
export function ChatList({ agentId, pin = 0, cardOpen = NO_CHOICE }: {
  agentId: AgentId
  pin?: number
  cardOpen?: Record<string, boolean>
}) {
  const v = useDure(s => ({
    items: s.history[agentId] ?? NONE,
    status: s.historyStatus[agentId]?.state ?? 'loading',
    streaming: s.streaming[agentId] ?? '',
  }))
  const work = useDure(s => {
    const a = s.agents.find(x => x.id === agentId)
    return { on: !!a && displayStatus(a, s.requests) === 'working', since: s.statusSince[agentId] }
  })
  // 도는 서브에이전트(부모의 Agent tool_use id) — 내용이 같으면 같은 배열(useDure 의 얕은 비교)이라 아래 Set·줄을 다시 만들지 않는다
  const running = useDure(s => s.agents.find(x => x.id === agentId)?.subagentsRunning ?? NO_IDS)
  const runningSet = useMemo(() => new Set(running), [running])
  const [limit, setLimit] = useState(PAGE)
  const latest = useDure(s => {
    const m = latestDelivered(agentId, s.messages)
    return m ? { id: m.id, updatedAt: m.updatedAt } : null
  })
  const now = useNow()
  const pinned = latest && pinOpen({ ...latest, state: 'delivered' }, cardOpen, now) ? latest.id : null

  // 흐르는 글은 따로 — 글자가 올 때마다 기록 전체를 다시 줄로 바꾸지 않는다(줄 객체가 그대로라 다시 그리지도 않는다).
  // 도는 목록을 넘겨야 요약 줄의 '도는 중'이 맞다(끝 기록이 없는데 돌지도 않으면 끊김)
  const { lines, hiddenBefore } = useMemo(() => buildTranscript(v.items, undefined, limit, runningSet), [v.items, limit, runningSet])

  const box = useRef<HTMLElement>(null)
  const stick = useRef(true)
  const keep = useRef<number | null>(null) // '더 보기' 직전의 바닥까지 거리 — 위에 줄이 늘어도 보던 자리 그대로

  const onScroll = () => {
    const el = box.current
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_PX
  }

  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    if (keep.current !== null) {
      el.scrollTop = el.scrollHeight - keep.current
      keep.current = null
    } else if (stick.current) {
      el.scrollTop = el.scrollHeight
    }
  }, [lines, v.streaming, v.status, work.on])

  // 보는 동안 새로 온 줄만 아래에서 들어온다 — 처음 그린 것 · 더 보기 · 기록 다시 받기 · 흐르던 글이 줄이 된 것은 아니다
  const snap = useRef<LineSnap | null>(null)
  useLayoutEffect(() => {
    const cur: LineSnap = { agentId, ready: v.status === 'ready', total: hiddenBefore + lines.length, streaming: !!v.streaming }
    const enter = enteringLines(snap.current, cur)
    snap.current = cur
    const el = box.current
    if (!enter || !el || reducedMotion()) return
    for (let n = enter.from; n < enter.to; n++) {
      const node = el.querySelector<HTMLElement>(`[data-line="${n}"]`)
      if (node) playEnter(node, MOTION.line.enter)
    }
    if (enter.live) {
      const node = el.querySelector<HTMLElement>('[data-line="live"]')
      if (node) playEnter(node, MOTION.line.enter)
    }
  })

  // 내가 보냈다 — 내 말이 보이게 맨 아래로, 뒤에 오는 줄(내 말·답)도 따라가게 다시 붙인다
  useLayoutEffect(() => {
    const el = box.current
    if (!pin || !el) return
    stick.current = true
    keep.current = null
    el.scrollTop = el.scrollHeight
  }, [pin])

  // 칸이 줄어도(창 크기 · 위에 카드가 생김) 맨 아래에 붙어 있었으면 바닥을 지킨다 — 줄어드는 건 스크롤 이벤트가 안 온다
  useLayoutEffect(() => {
    const el = box.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => {
      if (stick.current && keep.current === null) el.scrollTop = el.scrollHeight
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const showMore = () => {
    const el = box.current
    if (el) keep.current = el.scrollHeight - el.scrollTop
    setLimit(l => l + PAGE)
  }

  return (
    // 바깥 칸 — 위 끝에 바탕색으로 사라지는 짧은 막(.conv-wrap::before). 고정 카드 바로 아래로 스크롤되는 글이 줄처럼 끊겨 보이지 않게
    <div className="conv-wrap">
      <section ref={box} className="conv" aria-label="대화" onScroll={onScroll}>
        {v.status === 'loading' && v.items.length === 0 && <p className="conv-st">대화를 불러오는 중…</p>}
        {v.status === 'error' && (
          <p className="conv-st">
            대화를 불러오지 못했어요
            <button type="button" className="lk" onClick={() => getStore().selectAgent(agentId)}>
              다시 시도
            </button>
          </p>
        )}
        {hiddenBefore > 0 && (
          <button type="button" className="conv-more" onClick={showMore}>
            이전 대화 {hiddenBefore}개 더 보기
          </button>
        )}
        {lines.map((line, i) => (
          // 줄 번호(앞에 숨긴 줄 포함)는 새 줄이 붙어도 그대로 — 펼친 하는 일이 닫히지 않는다
          <ChatItem
            key={hiddenBefore + i}
            index={hiddenBefore + i}
            line={line}
            agentId={agentId}
            folded={line.kind === 'relay' && !!line.messageId && line.messageId === pinned}
          />
        ))}
        {v.streaming && <ChatItem line={{ kind: 'streaming', text: v.streaming }} />}
        <Presence show={work.on}>
          <WorkingRow since={work.since} subagents={running.length} />
        </Presence>
      </section>
    </div>
  )
}
