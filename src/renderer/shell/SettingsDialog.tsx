import { useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Bell, Info, Settings2, Smartphone, Users, type LucideIcon } from 'lucide-react'
import { useDure } from '../state/store'
import { useDialogFocus } from '../lib/dialog'
import { MOTION } from '../lib/motion'
import { useMotion } from '../lib/presence'
import { PHONE, dotOf } from './PhoneSettings'
import { GeneralPane } from './settings/GeneralPane'
import { AgentsPane } from './settings/AgentsPane'
import { NotifyPane } from './settings/NotifyPane'
import { AboutPane } from './settings/AboutPane'

export type SettingsTab = 'general' | 'agents' | 'notify' | 'phone' | 'about'

/** 왼쪽 탭 — 위에서부터 이 차례 */
export const SETTINGS_TABS: { key: SettingsTab; label: string }[] = [
  { key: 'general', label: '일반' },
  { key: 'agents', label: '에이전트' },
  { key: 'notify', label: '알림' },
  { key: 'phone', label: '휴대폰' },
  { key: 'about', label: '두레' },
]

const TAB_ICON: Record<SettingsTab, LucideIcon> = {
  general: Settings2,
  agents: Users,
  notify: Bell,
  phone: Smartphone,
  about: Info,
}

/**
 * 설정(위 띠 톱니) — 넓은 창 하나에 왼쪽 탭 다섯: 일반 · 에이전트 · 알림 · 휴대폰 · 두레.
 * 저장 단추가 없다 — 누르는 즉시 바뀐다(자동 전달 상한만 칸을 벗어나거나 Enter 일 때). 아래 단추는 [닫기] 하나.
 * 고른 판 하나만 그린다(숨긴 판을 DOM 에 두지 않는다). 탭을 바꾸면 판은 맨 위부터. 처음 초점은 창 자체(R5) — Tab 한 번이면 고른 탭, 스위치가 아니라서 Space 한 번에 무엇이 바뀌지 않는다.
 * phonePane 이 없으면 휴대폰 탭도 없다. 휴대폰으로 쓰기가 켜져 있으면 탭 이름 옆에 상태 점 + 접속 수(그림일 뿐 — 읽는 상태는 탭의 설명).
 * 설정 위에 겹쳐 뜬 창(묻지 않고 실행 확인 · 휴대폰의 짝 맺기·앱 받기·끊기 확인)이 있는 동안은 onCoveredChange(true).
 */
export function SettingsDialog({
  onClose,
  onReplayTour,
  initialTab = 'general',
  onCoveredChange,
  phonePane,
}: {
  onClose: () => void
  onReplayTour: () => void
  initialTab?: SettingsTab
  onCoveredChange?: (covered: boolean) => void
  phonePane?: (o: { onCoveredChange: (c: boolean) => void }) => ReactNode
}) {
  return createPortal(
    <Frame onClose={onClose} onReplayTour={onReplayTour} initialTab={initialTab} onCoveredChange={onCoveredChange} phonePane={phonePane} />,
    document.body,
  )
}

function Frame({
  onClose,
  onReplayTour,
  initialTab,
  onCoveredChange,
  phonePane,
}: {
  onClose: () => void
  onReplayTour: () => void
  initialTab: SettingsTab
  onCoveredChange?: (covered: boolean) => void
  phonePane?: (o: { onCoveredChange: (c: boolean) => void }) => ReactNode
}) {
  const ref = useRef<HTMLDivElement>(null)
  const backdrop = useRef<HTMLDivElement>(null)
  const pane = useRef<HTMLDivElement>(null)
  const tabRefs = useRef<Partial<Record<SettingsTab, HTMLButtonElement | null>>>({})
  const id = useId()
  const phone = useDure(s => s.app.phone)
  const tabs = SETTINGS_TABS.filter(t => t.key !== 'phone' || phonePane)
  const [tab, setTab] = useState<SettingsTab>(tabs.some(t => t.key === initialTab) ? initialTab : 'general')
  useMotion(backdrop, MOTION.backdrop)
  useMotion(ref, MOTION.dialog)
  // 처음 초점은 창 자체(R5) — Tab 한 번이면 고른 탭. 위 띠 알약에서 열었는데 그사이 휴대폰 연결을 껐으면 알약이 없다 — 닫을 때 초점은 그 옆 설정 톱니로
  useDialogFocus(
    ref,
    onClose,
    () => null,
    () => document.querySelector<HTMLElement>('[data-tour="settings-gear"]'),
  )

  // 판은 하나(오른쪽 스크롤 칸) — 탭을 바꾸면 맨 위부터(긴 휴대폰 판을 내려 둔 채 옮겨도)
  useLayoutEffect(() => {
    if (pane.current) pane.current.scrollTop = 0
  }, [tab])

  // 판 안이 바꾸는 '겹친 창이 있다' — 이 함수는 늘 같은 것(판의 effect 가 의존한다)
  const notifyCovered = useRef(onCoveredChange)
  notifyCovered.current = onCoveredChange
  const [covered] = useState(() => (c: boolean) => notifyCovered.current?.(c))

  const move = (e: KeyboardEvent<HTMLDivElement>) => {
    const at = tabs.findIndex(t => t.key === tab)
    let to = -1
    if (e.key === 'ArrowDown') to = (at + 1) % tabs.length
    else if (e.key === 'ArrowUp') to = (at - 1 + tabs.length) % tabs.length
    else if (e.key === 'Home') to = 0
    else if (e.key === 'End') to = tabs.length - 1
    if (to < 0) return
    e.preventDefault()
    setTab(tabs[to].key)
    tabRefs.current[tabs[to].key]?.focus()
  }

  // 바깥(막)을 누르면 닫는다 — 대화상자 안에서 시작한 누름은 아니다
  const onBackdrop = (e: PointerEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) onClose()
  }

  const titleId = `${id}-title`
  const phoneStatusId = `${id}-phone-status`
  /** 휴대폰 탭에 상태를 붙이는가 — 탭이 있고 상태를 받았을 때 */
  const phoneStatus = phone !== null && tabs.some(t => t.key === 'phone')
  return (
    <div ref={backdrop} className="dlg-bd" onPointerDown={onBackdrop}>
      <div
        ref={ref}
        className="dlg st-dlg"
        data-tour="settings-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <nav className="st-nav">
          <h2 id={titleId} className="dlg-t st-title">
            설정
          </h2>
          <div className="st-tabs" role="tablist" aria-orientation="vertical" onKeyDown={move}>
            {tabs.map(t => {
              const Icon = TAB_ICON[t.key]
              const on = t.key === tab
              return (
                <button
                  key={t.key}
                  ref={el => {
                    tabRefs.current[t.key] = el
                  }}
                  id={`${id}-tab-${t.key}`}
                  type="button"
                  role="tab"
                  className="st-tab"
                  aria-selected={on}
                  aria-controls={`${id}-pane`}
                  aria-describedby={t.key === 'phone' && phoneStatus ? phoneStatusId : undefined}
                  tabIndex={on ? 0 : -1}
                  onClick={() => setTab(t.key)}
                >
                  <Icon className="i" size={15} aria-hidden="true" />
                  {t.label}
                  {t.key === 'phone' && phone?.settings.enabled && (
                    <span className={`st-badge ${dotOf(phone)}`} aria-hidden="true">
                      <span className={`dot ${dotOf(phone)}`} />
                      {phone.connected > 0 && phone.connected}
                    </span>
                  )}
                </button>
              )
            })}
          </div>
          {phoneStatus && (
            <span id={phoneStatusId} hidden>
              {PHONE.status(phone)}
            </span>
          )}
        </nav>
        <div className="st-main">
          <div ref={pane} id={`${id}-pane`} className="st-pane" role="tabpanel" aria-labelledby={`${id}-tab-${tab}`}>
            {tab === 'general' && <GeneralPane />}
            {tab === 'agents' && <AgentsPane onCoveredChange={covered} />}
            {tab === 'notify' && <NotifyPane />}
            {tab === 'phone' && phonePane?.({ onCoveredChange: covered })}
            {tab === 'about' && <AboutPane onReplayTour={onReplayTour} />}
          </div>
          <div className="dlg-ab st-ab">
            <button type="button" className="btn sec" onClick={onClose}>
              닫기
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
