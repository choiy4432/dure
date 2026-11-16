import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { getStore, useDure } from '../state/store'
import { reducedMotion } from '../lib/motion'
import { openDialogCount } from '../lib/dialog'
import { ControlRoom } from './ControlRoom'
import { TerminalWall } from './TerminalWall'
import { useHoldEscape } from './useHoldEscape'
import './power.css'

const HOLD_MS = 1500
const HINT_MS = 2000
const EXIT_FAIL = '나가지 못했어요 — 다시 눌러 주세요'
/** 떠 있는 창 — 대화상자·메뉴·목록(나가는 중인 inert 는 빼고) */
const FLOATING = '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], [aria-modal="true"]'
/** 글을 받지 않는 input 꼴 */
const NOT_TEXT = new Set(['button', 'checkbox', 'radio', 'range', 'submit', 'reset', 'file', 'color', 'image'])

const editing = (el: Element | null): boolean =>
  el instanceof HTMLTextAreaElement ||
  el instanceof HTMLSelectElement ||
  (el instanceof HTMLInputElement && !NOT_TEXT.has(el.type)) ||
  (el instanceof HTMLElement && el.isContentEditable)

/**
 * Esc 길게 누르기를 들어도 될 때 — 글을 쓰는 칸(입력창 포함)에 초점이 없고 떠 있는 창이 하나도 없을 때만.
 * 입력창·대화상자·메뉴가 제 Esc 를 받게 둔다(설계: Esc 가 그것들 대신 파워 모드를 끄면 실패)
 */
function holdEscapeAllowed(): boolean {
  if (editing(document.activeElement)) return false
  if (openDialogCount() > 0) return false
  for (const el of document.querySelectorAll(FLOATING)) if (!el.closest('[inert]')) return false
  return true
}

/** 파워 모드가 켜져 있을 때만 전체 화면 덮개를 body 에 그린다 — 일하는 화면이라 입력은 막지 않는다 */
export function PowerLayer() {
  const on = useDure(s => s.power.on)
  const terminal = useDure(s => s.app.prefs?.powerTerminal ?? false)
  if (!on) return null
  return createPortal(<Overlay terminal={terminal} />, document.body)
}

/** Esc 를 누르고 있는 동안 차오르는 고리 — 진행률은 여기서만 다시 그려 아래 화면은 건드리지 않는다 */
function ExitRing({ onDone }: { onDone: () => void }) {
  const { progress } = useHoldEscape({ ms: HOLD_MS, onDone, enabled: holdEscapeAllowed })
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

/**
 * 덮개 — 앱 틀 위, 떠 있는 것(대화상자·찾기·메뉴·토스트·투어) 아래 층(power.css).
 * 입력을 삼키지 않고 초점을 붙잡지 않는다: 켤 때 한 번만 덮개로 초점을 옮겨(Esc 길게가 바로 되게) 그 뒤로는 건드리지 않는다.
 * 판은 창 크기 그대로 흐른다(늘리고 줄이지 않는다) — 안의 대화 패널이 제 크기 글자·화면 좌표(떠 있는 메뉴·스크롤)를 그대로 쓴다.
 */
function Overlay({ terminal }: { terminal: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  const [hint, setHint] = useState<string | null>(null)
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
  useEffect(() => () => clearTimeout(hintTimer.current), [])

  // 안내가 뜨고 져도 아래 화면은 다시 그리지 않는다(같은 요소)
  const screen = useMemo(() => (terminal ? <TerminalWall onExit={exit} /> : <ControlRoom onExit={exit} />), [terminal, exit])
  return (
    <div ref={ref} className="pw" role="region" aria-label="파워 모드" tabIndex={-1}>
      <div className="pw-stage" data-calm={reducedMotion() || undefined}>
        {screen}
      </div>
      <ExitRing onDone={exit} />
      {hint && (
        <div className="pw-hint" role="status">
          {hint}
        </div>
      )}
    </div>
  )
}
