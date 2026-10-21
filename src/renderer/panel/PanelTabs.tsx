import { createContext, useRef, type KeyboardEvent, type ReactNode } from 'react'
import type { PanelTab } from '../state/store'

const ORDER: PanelTab[] = ['chat', 'subagents']

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
 * 패널 탭 [대화 | 서브에이전트 N](시안 2안) — 지금 대화에 서브에이전트가 하나라도 있었을 때만 그린다(AgentPanel).
 * 탭마다 제 칸(panelId)을 가리키고 고른 탭의 칸만 보인다. 고른 탭만 Tab 키로 닿고(roving tabindex), ←/→·Home·End 로 옮기면 바로 고르고 초점도 옮긴다.
 * N 은 안쪽 서브에이전트까지 센 수, 도는 것이 있으면 초록 점(작업 중 점).
 */
export function PanelTabs({ tab, total, running, base, onChange }: {
  tab: PanelTab
  total: number
  running: boolean
  base: string
  onChange: (tab: PanelTab) => void
}) {
  const refs = useRef<Partial<Record<PanelTab, HTMLButtonElement | null>>>({})

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, from: PanelTab) => {
    const i = ORDER.indexOf(from)
    const to =
      e.key === 'ArrowRight' ? ORDER[(i + 1) % ORDER.length]
        : e.key === 'ArrowLeft' ? ORDER[(i - 1 + ORDER.length) % ORDER.length]
          : e.key === 'Home' ? ORDER[0]
            : e.key === 'End' ? ORDER[ORDER.length - 1]
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
    <div className="ptabs" role="tablist" aria-label="패널 보기">
      {button('chat', '대화')}
      {button(
        'subagents',
        <>
          서브에이전트{' '}
          <b className="ptab-n">{total}</b>
          {running && (
            <>
              {' '}
              <span className="wk-dot" role="img" aria-label="도는 중" />
            </>
          )}
        </>,
      )}
    </div>
  )
}
