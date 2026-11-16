import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
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
const SWALLOW = ['keydown', 'keyup', 'pointerdown', 'pointerup', 'pointermove', 'mousedown', 'mouseup', 'click', 'dblclick', 'contextmenu', 'wheel'] as const

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

function Overlay({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  const [hint, setHint] = useState(false)
  const [idle, setIdle] = useState(false)
  const { progress } = useHoldEscape({ ms: HOLD_MS, onDone: () => void getStore().setPower(false).catch(() => {}) })

  useLayoutEffect(() => {
    ref.current?.focus()
  }, [])

  // 입력 삼키기 — window 캡처 단계라 앱의 window·document 리스너(Ctrl+K 등)보다 먼저 본다. Esc 는 길게 누르기(useHoldEscape)가 같은 단계에서 따로 본다
  useEffect(() => {
    let hintTimer: ReturnType<typeof setTimeout> | undefined
    let idleTimer: ReturnType<typeof setTimeout> | undefined
    const rest = () => {
      setIdle(false)
      clearTimeout(idleTimer)
      idleTimer = setTimeout(() => setIdle(true), IDLE_MS)
    }
    rest()
    const swallow = (e: Event) => {
      e.stopPropagation()
      if (e.type === 'pointermove') rest()
      const ask =
        (e.type === 'keydown' && (e as KeyboardEvent).key !== 'Escape') || e.type === 'pointerdown' || e.type === 'click'
      if (!ask) return
      setHint(true)
      clearTimeout(hintTimer)
      hintTimer = setTimeout(() => setHint(false), HINT_MS)
    }
    for (const t of SWALLOW) window.addEventListener(t, swallow, true)
    return () => {
      for (const t of SWALLOW) window.removeEventListener(t, swallow, true)
      clearTimeout(hintTimer)
      clearTimeout(idleTimer)
    }
  }, [])

  const R = 9
  const C = 2 * Math.PI * R
  return (
    <div ref={ref} className="pw" role="application" aria-label="파워 모드" tabIndex={-1} data-idle={idle || undefined}>
      {children}
      {progress > 0 && (
        <div className="pw-exit" role="status">
          <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
            <circle className="trk" cx="12" cy="12" r={R} fill="none" strokeWidth="3" />
            <circle className="fil" cx="12" cy="12" r={R} fill="none" strokeWidth="3" strokeDasharray={C} strokeDashoffset={C * (1 - progress)} />
          </svg>
          나가는 중…
        </div>
      )}
      {hint && (
        <div className="pw-hint" role="status">
          Esc 를 길게 누르면 나가요
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
