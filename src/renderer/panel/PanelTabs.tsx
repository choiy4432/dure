import { createContext, useLayoutEffect, useRef, type KeyboardEvent, type ReactNode, type WheelEvent } from 'react'
import type { PanelTab } from '../state/store'
import { PAST } from '../lib/words'

/**
 * 탭 아래 칸이 지금 보이는가 — 탭을 바꾸면 고르지 않은 칸은 그려 둔 채 숨긴다(AgentPanel).
 * 숨은 대화 목록은 스크롤을 건드리지 않고, 다시 보이면 읽던 자리로 돌아간다(ChatList). 탭이 없으면 늘 보인다
 */
export const ViewShown = createContext(true)

/** 탭 버튼의 id — 그 탭의 칸(tabpanel)의 aria-labelledby 가 가리킨다 */
export const tabId = (base: string, tab: PanelTab) => `${base}-${tab}`
/** 탭마다 제 칸(tabpanel)의 id — 탭의 aria-controls 가 가리킨다. 두 칸을 함께 그려 두고 고르지 않은 칸은 숨긴다(AgentPanel) */
export const panelId = (base: string, tab: PanelTab) => `${base}-${tab}-panel`

/**
 * 패널 탭 [대화 | 서브에이전트 N | 메시지 N | 지난 대화 N](시안 2안 · 메시지 탭 시안 A · 지난 대화 시안 B) — 대화 말고 탭이 하나라도 있을 때만 그린다(AgentPanel).
 * 서브에이전트 탭은 지금 대화에 서브에이전트가 있었을 때, 메시지 탭은 이 에이전트가 주고받은 메시지가 있을 때,
 * 지난 대화 탭은 지난 대화가 있을 때(tabs).
 * 탭마다 제 칸(panelId)을 가리키고 고른 탭의 칸만 보인다. 고른 탭만 Tab 키로 닿고(roving tabindex), ←/→·Home·End 로 옮기면 바로 고르고 초점도 옮긴다.
 * 서브에이전트 N 은 안쪽 서브에이전트까지 센 수, 도는 것이 있으면 초록 점(작업 중 점).
 * 메시지 N 은 받은 것 + 보낸 것, 이 에이전트가 받은 것 가운데 내 확인이 필요한 게 있으면 주황 점(관계도 카드의 받은 메시지와 같은 셈).
 * 지난 대화 N 은 지금 대화를 뺀 수.
 * 좁은 패널에서 탭이 다 안 들어가면 탭 줄이 옆으로 밀린다(스크롤 막대 없이) — 세로 휠도 옆으로, 고른 탭은 늘 보이게 끌어온다.
 */
export function PanelTabs({ tab, tabs, subagents, messages, past, base, onChange }: {
  tab: PanelTab
  /** 보이는 탭 — 늘 'chat' 이 먼저 */
  tabs: PanelTab[]
  subagents: { total: number; running: boolean }
  messages: { total: number; attention: boolean }
  /** 지난 대화 수(지금 대화 빼고) */
  past: number
  base: string
  onChange: (tab: PanelTab) => void
}) {
  const order = tabs
  const refs = useRef<Partial<Record<PanelTab, HTMLButtonElement | null>>>({})

  // 고른 탭이 밀려 가려져 있으면 보이게 — 다른 곳에서 탭을 바꿔도(대화에서 보기 등). 넘치지 않으면 할 일이 없다
  useLayoutEffect(() => {
    const el = refs.current[tab]
    const row = el?.parentElement
    if (!el || !row || row.scrollWidth <= row.clientWidth) return
    if (el.offsetLeft < row.scrollLeft) row.scrollLeft = el.offsetLeft
    else if (el.offsetLeft + el.offsetWidth > row.scrollLeft + row.clientWidth) row.scrollLeft = el.offsetLeft + el.offsetWidth - row.clientWidth
  }, [tab, tabs])

  // 세로 휠을 옆으로 — 넘칠 때만(탭 줄은 세로로 움직일 게 없다)
  const onWheel = (e: WheelEvent<HTMLDivElement>) => {
    const row = e.currentTarget
    if (row.scrollWidth <= row.clientWidth || Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return
    row.scrollLeft += e.deltaY
  }

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, from: PanelTab) => {
    const i = order.indexOf(from)
    const to =
      e.key === 'ArrowRight' ? order[(i + 1) % order.length]
        : e.key === 'ArrowLeft' ? order[(i - 1 + order.length) % order.length]
          : e.key === 'Home' ? order[0]
            : e.key === 'End' ? order[order.length - 1]
              : null
    if (!to) return
    e.preventDefault()
    onChange(to)
    refs.current[to]?.focus()
  }

  const button = (t: PanelTab, label: ReactNode) => (
    <button
      ref={el => { refs.current[t] = el }}
      type="button"
      role="tab"
      id={tabId(base, t)}
      className="ptab"
      aria-selected={tab === t}
      aria-controls={panelId(base, t)}
      tabIndex={tab === t ? 0 : -1}
      onClick={() => onChange(t)}
      onKeyDown={e => onKeyDown(e, t)}
    >
      {label}
    </button>
  )

  return (
    <div className="ptabs" role="tablist" aria-label="패널 보기" onWheel={onWheel}>
      {button('chat', '대화')}
      {tabs.includes('subagents') &&
        button(
          'subagents',
          <>
            서브에이전트{' '}
            <b className="ptab-n">{subagents.total}</b>
            {subagents.running && (
              <>
                {' '}
                <span className="wk-dot" role="img" aria-label="도는 중" />
              </>
            )}
          </>,
        )}
      {tabs.includes('messages') &&
        button(
          'messages',
          <>
            메시지{' '}
            <b className="ptab-n">{messages.total}</b>
            {messages.attention && (
              <>
                {' '}
                <span className="ptab-dot" role="img" aria-label="내 확인 필요" />
              </>
            )}
          </>,
        )}
      {tabs.includes('past') &&
        button(
          'past',
          <>
            {PAST.tab}{' '}
            <b className="ptab-n">{past}</b>
          </>,
        )}
    </div>
  )
}
