import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { getStore, useDure } from '../state/store'
import { reducedMotion } from '../lib/motion'
import { ControlRoom } from './ControlRoom'
import { useHoldEscape } from './useHoldEscape'
import './power.css'

const BOARD = { w: 1600, h: 900 }
const HOLD_MS = 1500
const HINT_MS = 2000
const IDLE_MS = 3000
/** 덮개가 삼키는 입력 — 뒤의 앱·찾기 창 같은 리스너에 닿지 않게 */
const SWALLOW = ['keydown', 'keypress', 'keyup', 'pointerdown', 'pointerup', 'pointermove', 'mousedown', 'mouseup', 'click', 'dblclick', 'contextmenu', 'wheel'] as const
/** 기본 동작(글자 입력·Tab 이동·스크롤·우클릭 메뉴)까지 막는 것 — 움직임은 그대로 둔다 */
const PREVENT = new Set<string>(SWALLOW.filter(t => t !== 'pointermove'))
const HINT_TEXT = 'Esc 를 길게 누르면 나가요'
const EXIT_FAIL = '나가지 못했어요 — 다시 Esc 를 길게 눌러 주세요'

/** 파워 모드가 켜져 있을 때만 전체 화면 덮개를 body 에 그린다 */
export function PowerLayer() {
  const on = useDure(s => s.power.on)
  const terminal = useDure(s => s.app.prefs?.powerTerminal ?? false)
  if (!on) return null
  return createPortal(
    <Overlay>
      <PowerStage>{terminal ? <div data-power-screen="terminal" /> : <ControlRoom />}</PowerStage>
    </Overlay>,
    document.body,
  )
}

/** 덮개 밖 body 자식을 모두 inert 로 — 이미 inert 였던 것은 건드리지 않고, 덮개가 떠 있는 동안 새로 생긴 것도 막는다 */
function useInertOutside(ref: React.RefObject<HTMLElement | null>) {
  useEffect(() => {
    const mine = new Set<Element>()
    const apply = () => {
      for (const el of Array.from(document.body.children)) {
        if (el === ref.current || mine.has(el) || el.hasAttribute('inert')) continue
        if (el.contains(ref.current)) continue
        el.setAttribute('inert', '')
        mine.add(el)
      }
    }
    apply()
    const mo = new MutationObserver(apply)
    mo.observe(document.body, { childList: true })
    return () => {
      mo.disconnect()
      for (const el of mine) el.removeAttribute('inert')
    }
  }, [ref])
}

/** Esc 를 누르고 있는 동안 차오르는 고리 — 진행률은 여기서만 다시 그려 아래 화면은 건드리지 않는다 */
function ExitRing({ onDone }: { onDone: () => void }) {
  const { progress } = useHoldEscape({ ms: HOLD_MS, onDone })
  if (progress <= 0) return null
  const R = 9
  const C = 2 * Math.PI * R
  return (
    <div className="pw-exit" role="status">
      <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
        <circle className="trk" cx="12" cy="12" r={R} fill="none" strokeWidth="3" />
        <circle className="fil" cx="12" cy="12" r={R} fill="none" strokeWidth="3" strokeDasharray={C} strokeDashoffset={C * (1 - progress)} />
      </svg>
      나가는 중…
    </div>
  )
}

function Overlay({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  const [hint, setHint] = useState<string | null>(null)
  const [idle, setIdle] = useState(false)
  const hintTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const flash = useCallback((text: string) => {
    setHint(text)
    clearTimeout(hintTimer.current)
    hintTimer.current = setTimeout(() => setHint(null), HINT_MS)
  }, [])
  const exit = useCallback(() => {
    void getStore().setPower(false).catch(() => flash(EXIT_FAIL))
  }, [flash])

  useLayoutEffect(() => {
    ref.current?.focus()
  }, [])
  useInertOutside(ref)

  // 초점이 덮개 밖에 떨어지면(설정이 닫히며 연 단추로 돌려주는 때 등) 바로 되돌린다
  useEffect(() => {
    const pull = (e: FocusEvent) => {
      const el = ref.current
      if (el && e.target instanceof Node && !el.contains(e.target)) el.focus()
    }
    document.addEventListener('focusin', pull, true)
    if (ref.current && !ref.current.contains(document.activeElement)) ref.current.focus()
    return () => document.removeEventListener('focusin', pull, true)
  }, [])

  // 입력 삼키기 — window 캡처 단계라 앱의 window·document 리스너(Ctrl+K 등)보다 먼저 본다. Esc 는 길게 누르기(useHoldEscape)가 같은 단계에서 따로 본다
  useEffect(() => {
    let idleTimer: ReturnType<typeof setTimeout> | undefined
    const rest = () => {
      setIdle(false)
      clearTimeout(idleTimer)
      idleTimer = setTimeout(() => setIdle(true), IDLE_MS)
    }
    rest()
    const swallow = (e: Event) => {
      e.stopPropagation()
      if (PREVENT.has(e.type)) e.preventDefault()
      if (e.type === 'pointermove') rest()
      const ask =
        (e.type === 'keydown' && (e as KeyboardEvent).key !== 'Escape') || e.type === 'pointerdown' || e.type === 'click'
      if (ask) flash(HINT_TEXT)
    }
    for (const t of SWALLOW) window.addEventListener(t, swallow, { capture: true, passive: false })
    return () => {
      for (const t of SWALLOW) window.removeEventListener(t, swallow, true)
      clearTimeout(hintTimer.current)
      clearTimeout(idleTimer)
    }
  }, [flash])

  return (
    <div ref={ref} className="pw" role="application" aria-label="파워 모드" tabIndex={-1} data-idle={idle || undefined}>
      {children}
      <ExitRing onDone={exit} />
      {hint && (
        <div className="pw-hint" role="status">
          {hint}
        </div>
      )}
    </div>
  )
}

/** 1600×900 고정 판을 화면에 맞춰 줄여 가운데에 둔다 */
function PowerStage({ children }: { children: ReactNode }) {
  const [scale, setScale] = useState(fit)
  useEffect(() => {
    const on = () => setScale(fit())
    window.addEventListener('resize', on)
    return () => window.removeEventListener('resize', on)
  }, [])
  return (
    <div
      className="pw-stage"
      data-calm={reducedMotion() || undefined}
      style={{ transform: `translate(-50%, -50%) scale(${scale})` }}
    >
      {children}
    </div>
  )
}

function fit(): number {
  return Math.min(window.innerWidth / BOARD.w, window.innerHeight / BOARD.h)
}
