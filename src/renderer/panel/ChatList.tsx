import { useCallback, useContext, useLayoutEffect, useMemo, useRef, useState } from 'react'
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
import { ViewShown } from './PanelTabs'
import { StickyPrompt } from './StickyPrompt'
import { STICKY_ZONE_PX, stickyPromptIndex, type PromptBox, type PromptLine } from './turnStart'

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
 * Claude 가 생각하는 동안은 그 줄이 '생각하는 중…'과 생각한 추정 토큰 수.
 * 서브에이전트 탭으로 가면 숨을 뿐 그대로다(펼친 줄·불러온 이전 대화) — 다시 보이면 읽던 자리로(ViewShown).
 * 위로 올려 읽는 동안엔 화면 맨 위에 걸친 차례를 연 말(내 말 · 전달된 메시지)이 위에 고정된다(StickyPrompt — 누르면 그 말로).
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
  // Claude 가 생각하는 중이면 작업 중 줄이 '생각하는 중…'(토큰 수가 오를 때만 다시 그린다 — 기록 줄은 그대로)
  const thinking = useDure(s => s.thinking[agentId] ?? null)
  // 생각 전 기다림 — 준비하는 중·Claude 답 받는 중·대화를 정리하는 중
  const phase = useDure(s => s.phase[agentId])
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
  // 탭을 바꾸면 이 목록은 그려 둔 채 숨는다(ViewShown). 숨은 스크롤 상자(display:none)는 Chromium 이 자리를 0 으로 되돌리므로
  // 보이는 동안 마지막으로 읽은 자리(top)를 들고 있다가 다시 보이면 되돌린다. 숨은 동안엔 스크롤을 읽지도 쓰지도 않는다
  const shown = useContext(ViewShown)
  const visible = useRef(shown)
  const top = useRef(0)

  // 위 고정 — 화면 맨 위에 걸친 차례를 연 줄 번호(앞에 숨긴 줄 포함). 스크롤·줄·크기가 바뀔 때 잰다(값이 같으면 다시 그리지 않는다)
  const [stuck, setStuck] = useState<number | null>(null)
  const measure = useCallback(() => {
    const el = box.current
    if (!el || !visible.current) return
    const boxes: PromptBox[] = []
    for (const n of el.querySelectorAll<HTMLElement>(':scope > .me, :scope > .ci-relay')) {
      const r = n.getBoundingClientRect()
      boxes.push({ index: Number(n.dataset.line), top: r.top, bottom: r.bottom })
    }
    setStuck(stickyPromptIndex(boxes, el.getBoundingClientRect().top, STICKY_ZONE_PX))
  }, [])

  const onScroll = () => {
    const el = box.current
    if (!el || !visible.current) return // 숨으며 0 으로 돌아간 자리는 읽던 자리가 아니다
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_PX
    top.current = el.scrollTop
    measure()
  }

  // 다시 보였다 — 맨 아래에 붙어 있었으면 맨 아래(숨은 동안 온 줄까지), 아니면 읽던 자리로.
  // 아래 효과들보다 먼저 둔다 — 같은 그리기에서 내가 보냄(pin)이 오면 그것이 이긴다
  useLayoutEffect(() => {
    if (visible.current === shown) return
    visible.current = shown
    const el = box.current
    if (!shown || !el) return
    el.scrollTop = stick.current ? el.scrollHeight : top.current
    measure()
  }, [shown, measure])

  useLayoutEffect(() => {
    const el = box.current
    if (!el || !visible.current) return
    if (keep.current !== null) {
      el.scrollTop = el.scrollHeight - keep.current
      keep.current = null
    } else if (stick.current) {
      el.scrollTop = el.scrollHeight
    }
    top.current = el.scrollTop // 옮긴 자리도 읽던 자리 — 스크롤 이벤트가 오기 전에 숨어도
    measure()
  }, [lines, v.streaming, v.status, work.on, measure])

  // 보는 동안 새로 온 줄만 아래에서 들어온다 — 처음 그린 것 · 더 보기 · 기록 다시 받기 · 흐르던 글이 줄이 된 것은 아니다
  const snap = useRef<LineSnap | null>(null)
  useLayoutEffect(() => {
    const cur: LineSnap = { agentId, ready: v.status === 'ready', total: hiddenBefore + lines.length, streaming: !!v.streaming }
    const enter = enteringLines(snap.current, cur)
    snap.current = cur
    const el = box.current
    // 숨은 동안 온 줄은 기억만 한다 — 다시 보일 때 한꺼번에 들어오지 않는다
    if (!enter || !el || !visible.current || reducedMotion()) return
    for (let n = enter.from; n < enter.to; n++) {
      const node = el.querySelector<HTMLElement>(`[data-line="${n}"]`)
      if (node) playEnter(node, MOTION.line.enter)
    }
    if (enter.live) {
      const node = el.querySelector<HTMLElement>('[data-line="live"]')
      if (node) playEnter(node, MOTION.line.enter)
    }
  })

  // 내가 보냈다 — 내 말이 보이게 맨 아래로, 뒤에 오는 줄(내 말·답)도 따라가게 다시 붙인다(숨어 있으면 다시 보일 때 맨 아래로)
  useLayoutEffect(() => {
    const el = box.current
    if (!pin || !el) return
    stick.current = true
    keep.current = null
    if (visible.current) el.scrollTop = el.scrollHeight
  }, [pin])

  // 칸이 줄어도(창 크기 · 위에 카드가 생김) 맨 아래에 붙어 있었으면 바닥을 지킨다 — 줄어드는 건 스크롤 이벤트가 안 온다.
  // 숨을 때(크기 0)는 건드리지 않는다
  useLayoutEffect(() => {
    const el = box.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => {
      if (visible.current && stick.current && keep.current === null) el.scrollTop = el.scrollHeight
      measure()
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [measure])

  // 위 고정 줄 — 그린 줄 가운데 차례를 연 줄일 때만(앞에 숨긴 줄은 그리지 않아 잴 수도 없다)
  const stuckLine = stuck === null ? null : lines[stuck - hiddenBefore]
  const prompt: PromptLine | null = stuckLine && (stuckLine.kind === 'me' || stuckLine.kind === 'relay') ? stuckLine : null
  // 그 말로 간다 — 말이 대화 칸 윗 여백 바로 아래에 오게. 초점도 그 말로(상자가 사라지며 초점이 몸통으로 떨어지지 않게)
  const jumpTo = () => {
    const el = box.current
    const node = stuck === null ? null : el?.querySelector<HTMLElement>(`:scope > [data-line="${stuck}"]`)
    if (!el || !node) return
    const pad = parseFloat(getComputedStyle(el).paddingTop) || 0
    const to = el.scrollTop + node.getBoundingClientRect().top - el.getBoundingClientRect().top - pad
    if (typeof el.scrollTo === 'function') el.scrollTo({ top: to, behavior: reducedMotion() ? 'auto' : 'smooth' })
    else el.scrollTop = to
    node.tabIndex = -1
    node.focus({ preventScroll: true })
  }

  const showMore = () => {
    const el = box.current
    if (el) keep.current = el.scrollHeight - el.scrollTop
    setLimit(l => l + PAGE)
  }

  return (
    // 바깥 칸 — 위 끝에 바탕색으로 사라지는 짧은 막(.conv-wrap::before). 고정 카드 바로 아래로 스크롤되는 글이 줄처럼 끊겨 보이지 않게
    <div className="conv-wrap">
      <Presence show={prompt !== null}>{prompt && <StickyPrompt line={prompt} onJump={jumpTo} />}</Presence>
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
          <WorkingRow since={work.since} subagents={running.length} thinking={thinking ?? undefined} phase={phase} />
        </Presence>
      </section>
    </div>
  )
}
