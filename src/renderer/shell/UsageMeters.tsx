import { useCallback, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react'
import type { UsageWindow } from '../../engine/types'
import { useDure } from '../state/store'
import { useDismiss } from '../lib/popover'
import { useMedia } from '../lib/useMedia'
import { useNow } from '../lib/useNow'
import { ago, resetText, usageBarLabel, usageRowLabel } from '../lib/words'

const level = (p: number) => (p >= 100 ? ' danger' : p >= 80 ? ' warn' : '')
const pct = (p: number) => Math.round(p)
const fill = (p: number): CSSProperties => ({ width: `${Math.max(0, Math.min(100, p))}%` })

/** 위 띠의 사용량 — 5시간 · 1주 · 모델 전용 막대 한 단추, 누르면 줄마다 초기화 시각 */
export function UsageMeters() {
  const usage = useDure(s => s.usage, Object.is)
  const narrow = useMedia('(max-width: 1099px)')
  const now = useNow()
  const [open, setOpen] = useState(false)
  const wrap = useRef<HTMLSpanElement>(null)
  const button = useRef<HTMLButtonElement>(null)

  const close = useCallback(() => setOpen(false), [])
  useDismiss(open, wrap, close)
  useEffect(() => {
    if (open) void window.dure.refreshUsage()
  }, [open])

  if (!usage || usage.windows.length === 0) return null

  const bars: UsageWindow[] = narrow
    ? [usage.windows.reduce((a, b) => (b.percent > a.percent ? b : a))]
    : usage.windows

  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return
    e.preventDefault()
    setOpen(false)
    button.current?.focus()
  }

  return (
    <span className="mp usg-wrap" ref={wrap} onKeyDown={onKey}>
      <button
        ref={button}
        type="button"
        className="usg-btn"
        aria-haspopup="dialog"
        aria-expanded={open}
        title="사용량"
        onClick={() => setOpen(o => !o)}
      >
        {bars.map(w => (
          <span key={w.key} className={`usg${level(w.percent)}`}>
            <span className="usg-l">{usageBarLabel(w)}</span>
            <span className="usg-bar" aria-hidden="true">
              <span style={fill(w.percent)} />
            </span>
            <b>{w.percent >= 100 ? '다 썼어요' : `${pct(w.percent)}%`}</b>
          </span>
        ))}
      </button>
      {open && (
        <div className="pop end usg-pop" role="dialog" aria-label="사용량">
          <h5 className="usg-h">
            사용량 <span>· 내 계정</span>
          </h5>
          {usage.windows.map(w => (
            <div key={w.key} className={`usg-row${level(w.percent)}`}>
              <span>{usageRowLabel(w)}</span>
              <b>{pct(w.percent)}%</b>
              <span className="usg-bl">
                <span style={fill(w.percent)} />
              </span>
              {w.resetsAt !== null && <span className="usg-rs">{resetText(w.resetsAt, now)}</span>}
            </div>
          ))}
          <div className="usg-at">{ago(usage.at, now)} 기준</div>
        </div>
      )}
    </span>
  )
}
