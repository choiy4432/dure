import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { AgentId, HistoryItem } from '../../engine/types'
import { getStore, useDure } from '../state/store'
import { buildTranscript } from '../state/transcript'
import { ChatItem } from './ChatItem'

/** 처음에 그리는 줄 수 · '더 보기' 한 번에 늘리는 수 */
const PAGE = 300
/** 바닥에서 이만큼 안이면 '맨 아래에 붙어 있다' */
const STICK_PX = 24
const NONE: HistoryItem[] = []

/**
 * 대화 목록(시안 .conv) — 고른 에이전트의 기록을 buildTranscript 로 줄로 바꿔 그린다.
 * 최근 300줄만 그리고 위에 '이전 대화 N개 더 보기'. 새 줄이 오면 맨 아래에 붙어 있을 때만 따라 내려간다.
 * pin 이 오르면(내가 보냄) 위로 올려 읽던 중이어도 맨 아래에 다시 붙는다.
 */
export function ChatList({ agentId, pin = 0 }: { agentId: AgentId; pin?: number }) {
  const v = useDure(s => ({
    items: s.history[agentId] ?? NONE,
    status: s.historyStatus[agentId]?.state ?? 'loading',
    streaming: s.streaming[agentId] ?? '',
  }))
  const [limit, setLimit] = useState(PAGE)

  // 흐르는 글은 따로 — 글자가 올 때마다 기록 전체를 다시 줄로 바꾸지 않는다(줄 객체가 그대로라 다시 그리지도 않는다)
  const { lines, hiddenBefore } = useMemo(() => buildTranscript(v.items, undefined, limit), [v.items, limit])

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
  }, [lines, v.streaming, v.status])

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
        <ChatItem key={hiddenBefore + i} line={line} />
      ))}
      {v.streaming && <ChatItem line={{ kind: 'streaming', text: v.streaming }} />}
    </section>
  )
}
