import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react'
import type { UsageWindow } from '../../engine/types'
import { useDure } from '../state/store'
import { useDismiss } from '../lib/popover'
import { MotionDiv, Presence } from '../lib/presence'
import { MOTION, MOTION_MS } from '../lib/motion'
import { useMeterWidth } from '../lib/meter'
import { useMedia } from '../lib/useMedia'
import { useNow } from '../lib/useNow'
import { ago, resetText, usageBarLabel, usageRowLabel } from '../lib/words'

const pct = (p: number) => Math.round(p)
const clamp = (p: number) => Math.max(0, Math.min(100, p))

/** 막대 채움 — 처음 값은 바로, 바뀌면 바뀐 값까지 이어서 찬다(width 는 useMeterWidth 가 쓴다) */
function Fill({ percent }: { percent: number }) {
  const ref = useRef<HTMLSpanElement>(null)
  useMeterWidth(ref, clamp(percent), MOTION_MS.meter)
  return <span ref={ref} />
}
/** 초기화 시각이 지난 창 — 새 값을 받을 때까지(엔진이 곧 다시 묻는다) 옛 % 로 경고하지 않는다 */
const passed = (w: UsageWindow, now: number) => w.resetsAt !== null && w.resetsAt <= now
const level = (w: UsageWindow, now: number) => (passed(w, now) ? '' : w.percent >= 100 ? ' danger' : w.percent >= 80 ? ' warn' : '')
/** 막대·펼침 줄의 값 — 100% 이상이면 '다 썼어요'(초기화가 지났으면 % 그대로) */
const valueText = (w: UsageWindow, now: number) => (!passed(w, now) && w.percent >= 100 ? '다 썼어요' : `${pct(w.percent)}%`)

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

  // 좁으면 가장 높은 칸 하나 — 초기화가 지난 칸은 낮게 친다
  const rank = (w: UsageWindow) => (passed(w, now) ? -1 : w.percent)
  const bars: UsageWindow[] = narrow ? [usage.windows.reduce((a, b) => (rank(b) > rank(a) ? b : a))] : usage.windows

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
          <span key={w.key} className={`usg${level(w, now)}`}>
            <span className="usg-l">{usageBarLabel(w)}</span>
            <span className="usg-bar" aria-hidden="true">
              <Fill percent={w.percent} />
            </span>
            <b>{valueText(w, now)}</b>
          </span>
        ))}
      </button>
      <Presence show={open}>
        <MotionDiv motion={MOTION.pop} origin="top right" className="pop end usg-pop" role="dialog" aria-label="사용량">
          <h5 className="usg-h">
            사용량 <span>· 내 계정</span>
          </h5>
          {usage.windows.map(w => (
            <div key={w.key} className={`usg-row${level(w, now)}`}>
              <span>{usageRowLabel(w)}</span>
              <b>{valueText(w, now)}</b>
              <span className="usg-bl">
                <Fill percent={w.percent} />
              </span>
              {w.resetsAt !== null && (
                <span className="usg-rs">{passed(w, now) ? '초기화됨 · 새로 확인 중' : resetText(w.resetsAt, now)}</span>
              )}
            </div>
          ))}
          <div className="usg-at">{ago(usage.at, now)} 기준</div>
        </MotionDiv>
      </Presence>
    </span>
  )
}
